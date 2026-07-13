import assert from "node:assert/strict";
import test from "node:test";
import { createCharacter } from "./characters.ts";
import { initializeDb } from "./db.ts";
import { createProject } from "./projects.ts";
import { approveReferenceSet, createReferenceSet, uploadReferenceSetImage } from "./referenceSets.ts";
import { resolvePanelReferences } from "./referenceResolver.ts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
const bbox = { x: 0.1, y: 0.1, width: 0.4, height: 0.8 };

async function approvedAnima(characterId: string, variantId = "default") {
  const set = createReferenceSet(characterId, {
    modelFamily: "anima", variantId, appearanceJa: "銀髪", appearancePromptEn: "short silver hair", mustNotChange: ["silver hair"]
  });
  await uploadReferenceSetImage(set.id, "face", { imageDataUrl: PNG });
  await uploadReferenceSetImage(set.id, "full_body", { imageDataUrl: PNG });
  return approveReferenceSet(set.id, {});
}

test("resolver keeps all cast manifests but wires only the focal character Reference Set", async () => {
  initializeDb();
  const project = createProject({ name: "resolver reference sets", mode: "book" });
  assert.ok(project);
  const focal = createCharacter(project.id, { name: "Focal" });
  const support = createCharacter(project.id, { name: "Support" });
  const focalSet = await approvedAnima(focal.id);
  await approvedAnima(support.id);
  const result = resolvePanelReferences({
    projectId: project.id,
    providerId: "comfy",
    modelFamily: "anima",
    focalSubjectId: focal.id,
    globalLoras: [],
    cast: [
      { characterId: support.id, variantId: "default", bbox, expression: "calm", action: "stands", speakingLineIds: [] },
      { characterId: focal.id, variantId: "default", bbox, expression: "calm", action: "runs", speakingLineIds: [] }
    ]
  });
  assert.equal(result.manifest.length, 4, "face + full_body are preserved for both cast members");
  assert.deepEqual(result.primaryReferenceSet, { setId: focalSet.id, version: focalSet.version });
  assert.equal(result.primaryCharacterBinding, null);
  assert.deepEqual(result.missingReferenceIds, []);
});
