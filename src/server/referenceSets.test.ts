import assert from "node:assert/strict";
import test from "node:test";
import { createCharacter } from "./characters.ts";
import { db, initializeDb } from "./db.ts";
import { createProject } from "./projects.ts";
import {
  approveReferenceSet,
  approvedReferenceSetFiles,
  createReferenceSet,
  listProjectReferenceSets,
  uploadReferenceSetImage
} from "./referenceSets.ts";

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

function fixture() {
  initializeDb();
  const project = createProject({ name: "Reference Set API", mode: "book" });
  assert.ok(project);
  const character = createCharacter(project.id, { name: "アリス", notes: "口調と関係性だけ" });
  return { projectId: project.id, character };
}

test("migration creates versioned Reference Set tables and keeps image paths outside API views", async () => {
  const { projectId, character } = fixture();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  assert.ok(tables.some((table) => table.name === "character_reference_sets"));
  assert.ok(tables.some((table) => table.name === "character_reference_images"));

  const created = createReferenceSet(character.id, {
    modelFamily: "anima",
    variantId: "adult-combat",
    appearanceJa: "成人。短い銀髪、青い目、紺色の戦闘服",
    appearancePromptEn: "adult woman, short silver bob hair, vivid blue eyes, navy combat suit",
    mustNotChange: ["silver bob hair", "star-shaped left earring"]
  });
  assert.equal(created.version, 1);
  assert.equal(created.status, "draft");
  assert.equal(character.notes, "口調と関係性だけ", "appearance is not stored in Character notes");

  await uploadReferenceSetImage(created.id, "face", { imageDataUrl: TINY_PNG_DATA_URL });
  await uploadReferenceSetImage(created.id, "full_body", { imageDataUrl: TINY_PNG_DATA_URL });
  const approved = await approveReferenceSet(created.id, {});
  assert.equal(approved.status, "approved");
  assert.equal(approved.images.length, 2);
  assert.ok(approved.images.every((image) => image.checksum.length === 64));
  assert.ok(!JSON.stringify(approved).includes("character_reference_sets\\"));

  const listed = listProjectReferenceSets(projectId);
  assert.equal(listed[0]?.appearancePromptEn, "adult woman, short silver bob hair, vivid blue eyes, navy combat suit");
  assert.equal(listed[0]?.images.find((image) => image.role === "face")?.imageUrl?.startsWith("/api/reference-images/"), true);
});

test("new appearance version marks the prior approval stale while its frozen version remains resolvable", async () => {
  const { projectId, character } = fixture();
  const first = createReferenceSet(character.id, {
    modelFamily: "chroma", variantId: "young-casual", appearanceJa: "若年、黒髪、制服",
    appearancePromptEn: "young woman, straight black hair, school uniform", mustNotChange: ["black hair"]
  });
  await uploadReferenceSetImage(first.id, "face", { imageDataUrl: TINY_PNG_DATA_URL });
  await approveReferenceSet(first.id, {});
  const frozen = approvedReferenceSetFiles(first.id, 1, projectId);

  const second = createReferenceSet(character.id, {
    modelFamily: "chroma", variantId: "young-casual", appearanceJa: "若年、黒髪、冬制服",
    appearancePromptEn: "young woman, straight black hair, winter school uniform", mustNotChange: ["black hair"]
  });
  assert.equal(second.version, 2);
  const old = listProjectReferenceSets(projectId).find((set) => set.id === first.id);
  assert.equal(old?.status, "stale");
  assert.equal(approvedReferenceSetFiles(first.id, 1, projectId).snapshot.images[0]?.checksum, frozen.snapshot.images[0]?.checksum);
});

test("an approved version cannot be mutated in place", async () => {
  const { character } = fixture();
  const set = createReferenceSet(character.id, {
    variantId: "default", modelFamily: "chroma", appearanceJa: "銀髪", appearancePromptEn: "silver hair", mustNotChange: []
  });
  await uploadReferenceSetImage(set.id, "face", { imageDataUrl: TINY_PNG_DATA_URL });
  await approveReferenceSet(set.id, {});
  await assert.rejects(
    () => uploadReferenceSetImage(set.id, "face", { imageDataUrl: TINY_PNG_DATA_URL }),
    (error: unknown) => Boolean(error && typeof error === "object" && "statusCode" in error && error.statusCode === 409)
  );
});

test("Anima approval requires both face and full_body", async () => {
  const { character } = fixture();
  const created = createReferenceSet(character.id, {
    modelFamily: "anima", variantId: "default", appearanceJa: "赤髪", appearancePromptEn: "long red hair", mustNotChange: []
  });
  await uploadReferenceSetImage(created.id, "face", { imageDataUrl: TINY_PNG_DATA_URL });
  await assert.rejects(() => approveReferenceSet(created.id, {}), /face and full_body/);
});
