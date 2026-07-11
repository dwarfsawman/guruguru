import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteRoundTree, normalizeInpaintOptions, roundAttachmentPathFromRequest } from "./rounds.ts";
import type { GenerationRequest } from "../shared/types.ts";
import { createProject } from "./projects.ts";
import { createId, getRow, initializeDb, runSql } from "./db.ts";
import { HttpError } from "./http.ts";
import { removeRoundTrashSnapshot } from "./roundTrash.ts";

// Characterization tests: pin the behavior of normalizeInpaintOptions, including the
// featherRadius field added by the mask feather feature. See Docs/Feature-MaskFeather.md.

test("normalizeInpaintOptions: defaults maskedContent to 'original', onlyMaskedPadding to 32, featherRadius to 0", () => {
  const options = normalizeInpaintOptions({});
  assert.deepEqual(options, {
    maskedContent: "original",
    inpaintArea: "only_masked",
    onlyMaskedPadding: 32,
    featherRadius: 0,
    maskDataUrl: null
  });
});

test("normalizeInpaintOptions: accepts all four maskedContent values", () => {
  for (const value of ["fill", "original", "latent_noise", "latent_nothing"]) {
    const options = normalizeInpaintOptions({ maskedContent: value });
    assert.equal(options.maskedContent, value);
  }
});

test("normalizeInpaintOptions: throws on unsupported maskedContent value", () => {
  assert.throws(() => normalizeInpaintOptions({ maskedContent: "bogus" }), /Unsupported maskedContent value/);
});

test("normalizeInpaintOptions: throws when inpaintArea is not only_masked", () => {
  assert.throws(
    () => normalizeInpaintOptions({ inpaintArea: "whole_image" }),
    /Only inpaintArea='only_masked' is supported/
  );
});

test("normalizeInpaintOptions: onlyMaskedPadding clamps into [0, 512] as an integer", () => {
  assert.equal(normalizeInpaintOptions({ onlyMaskedPadding: -5 }).onlyMaskedPadding, 0);
  assert.equal(normalizeInpaintOptions({ onlyMaskedPadding: 1000 }).onlyMaskedPadding, 512);
  assert.equal(normalizeInpaintOptions({ onlyMaskedPadding: 12.9 }).onlyMaskedPadding, 12);
  assert.equal(normalizeInpaintOptions({ onlyMaskedPadding: "64" }).onlyMaskedPadding, 64);
});

test("normalizeInpaintOptions: accepts snake_case aliases for maskedContent/inpaintArea/onlyMaskedPadding", () => {
  const options = normalizeInpaintOptions({
    masked_content: "fill",
    inpaint_area: "only_masked",
    only_masked_padding: 8
  });
  assert.equal(options.maskedContent, "fill");
  assert.equal(options.inpaintArea, "only_masked");
  assert.equal(options.onlyMaskedPadding, 8);
});

test("normalizeInpaintOptions: featherRadius clamps into [0, 30] as an integer, default 0", () => {
  assert.equal(normalizeInpaintOptions({}).featherRadius, 0);
  assert.equal(normalizeInpaintOptions({ featherRadius: -5 }).featherRadius, 0);
  assert.equal(normalizeInpaintOptions({ featherRadius: 100 }).featherRadius, 30);
  assert.equal(normalizeInpaintOptions({ featherRadius: 12.9 }).featherRadius, 12);
  assert.equal(normalizeInpaintOptions({ featherRadius: "15" }).featherRadius, 15);
});

test("normalizeInpaintOptions: accepts snake_case alias for featherRadius", () => {
  assert.equal(normalizeInpaintOptions({ feather_radius: 9 }).featherRadius, 9);
});

test("normalizeInpaintOptions: maskDataUrl is always null regardless of input", () => {
  const options = normalizeInpaintOptions({ maskDataUrl: "data:image/png;base64,abc" });
  assert.equal(options.maskDataUrl, null);
});

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    templateId: "template-1",
    prompt: "",
    negativePrompt: "",
    seed: null,
    seedMode: "fixed",
    batchSize: 1,
    steps: 20,
    cfg: 7,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1,
    width: 512,
    height: 512,
    generationMode: "img2img",
    ...overrides
  };
}

test("roundAttachmentPathFromRequest: reads stored mask and pose paths", () => {
  const input = request({
    inpaint: {
      maskDataUrl: null,
      maskPath: "C:/data/project/masks/round_mask.png",
      maskedContent: "original",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 32
    },
    controlnet: {
      poseImageDataUrl: null,
      poseImagePath: "C:/data/project/control/round_pose.png",
      strength: 1,
      startPercent: 0,
      endPercent: 1
    }
  });
  assert.equal(roundAttachmentPathFromRequest(input, "mask"), "C:/data/project/masks/round_mask.png");
  assert.equal(roundAttachmentPathFromRequest(input, "pose"), "C:/data/project/control/round_pose.png");
});

test("roundAttachmentPathFromRequest: empty when attachment is absent", () => {
  assert.equal(roundAttachmentPathFromRequest(request(), "mask"), null);
  assert.equal(roundAttachmentPathFromRequest(request(), "pose"), null);
});

function createRoundDeleteFixture(): { projectId: string; templateId: string } {
  initializeDb();
  const project = createProject({ name: "Round deletion guard" });
  assert.ok(project);
  const templateId = createId("template");
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Round deletion guard', '', 'txt2img', 1, '{}', '{}', 'hash')`,
    [templateId]
  );
  return { projectId: project!.id as string, templateId };
}

function insertRound(input: {
  projectId: string;
  templateId: string;
  parentRoundId?: string | null;
  scriptMangaTaskId?: string | null;
  roundIndex: number;
}): string {
  const roundId = createId("round");
  runSql(
    `INSERT INTO generation_rounds
       (id, project_id, template_id, parent_round_id, round_index, status, generation_mode,
        request_json, provider_id, script_manga_task_id)
     VALUES (?, ?, ?, ?, ?, 'completed', 'txt2img', '{}', 'manual', ?)`,
    [roundId, input.projectId, input.templateId, input.parentRoundId ?? null, input.roundIndex, input.scriptMangaTaskId ?? null]
  );
  return roundId;
}

test("deleteRoundTree: rejects a tree containing script manga task history", () => {
  const fixture = createRoundDeleteFixture();
  const rootId = insertRound({ ...fixture, roundIndex: 0 });
  const childId = insertRound({
    ...fixture,
    parentRoundId: rootId,
    scriptMangaTaskId: createId("manga_task"),
    roundIndex: 1
  });

  assert.throws(
    () => deleteRoundTree(rootId),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409
  );
  assert.ok(getRow("SELECT id FROM generation_rounds WHERE id = ?", [rootId]));
  assert.ok(getRow("SELECT id FROM generation_rounds WHERE id = ?", [childId]));
});

test("deleteRoundTree: still deletes an unlinked round", () => {
  const fixture = createRoundDeleteFixture();
  const roundId = insertRound({ ...fixture, roundIndex: 0 });

  const result = deleteRoundTree(roundId);
  assert.deepEqual(result, { deleted: true, roundIds: [roundId], deletedCount: 1 });
  assert.equal(getRow("SELECT id FROM generation_rounds WHERE id = ?", [roundId]), null);
  removeRoundTrashSnapshot(roundId);
});
