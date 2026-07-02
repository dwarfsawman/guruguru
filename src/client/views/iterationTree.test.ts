import { test } from "node:test";
import assert from "node:assert/strict";
import { childHue, rootHue } from "./iterationTree.ts";
import type { Round } from "../../shared/apiTypes.ts";

function round(overrides: Partial<Round> = {}): Round {
  return {
    id: "round-1",
    projectId: "project-1",
    templateId: "template-1",
    parentRoundId: null,
    roundIndex: 0,
    promptId: null,
    status: "completed",
    generationMode: "txt2img",
    branchColorIndex: 0,
    branchReason: null,
    branchKey: null,
    request: {
      templateId: "template-1",
      prompt: "",
      negativePrompt: "",
      seed: null,
      seedMode: "fixed",
      batchSize: 1,
      steps: 20,
      cfg: 7,
      sampler: "",
      scheduler: "",
      denoise: 1,
      width: 512,
      height: 512,
      generationMode: "txt2img"
    },
    createdAt: "2026-07-02T00:00:00.000Z",
    ...overrides
  };
}

test("rootHue: branchColorIndex 0 is hue 0", () => {
  assert.equal(rootHue(round({ branchColorIndex: 0 })), 0);
});

test("rootHue: increments by ROOT_HUE_STEP (57) per branchColorIndex", () => {
  assert.equal(rootHue(round({ branchColorIndex: 1 })), 57);
  assert.equal(rootHue(round({ branchColorIndex: 2 })), 114);
});

test("rootHue: wraps at 360 for large branchColorIndex", () => {
  // 7 * 57 = 399 -> 399 % 360 = 39
  assert.equal(rootHue(round({ branchColorIndex: 7 })), 39);
});

test("rootHue: missing branchColorIndex defaults to 0", () => {
  assert.equal(rootHue(round({ branchColorIndex: undefined as unknown as number })), 0);
});

test("childHue: denoise 0 keeps the parent hue unchanged", () => {
  assert.equal(childHue(100, 0), 100);
});

test("childHue: denoise 0.35 adds 14 degrees (CHILD_HUE_STEP_MAX * 0.35)", () => {
  assert.equal(childHue(100, 0.35), 114);
});

test("childHue: denoise 1.0 adds the full CHILD_HUE_STEP_MAX (40 degrees)", () => {
  assert.equal(childHue(100, 1.0), 140);
});

test("childHue: denoise above 1 is clamped to 1", () => {
  assert.equal(childHue(100, 1.5), 140);
  assert.equal(childHue(100, 100), 140);
});

test("childHue: denoise below 0 is clamped to 0", () => {
  assert.equal(childHue(100, -0.5), 100);
  assert.equal(childHue(100, -100), 100);
});

test("childHue: wraps around 360", () => {
  assert.equal(childHue(350, 1.0), 30); // 350 + 40 = 390 -> 30
});

test("childHue: normalizes a negative parent hue into 0..360", () => {
  assert.equal(childHue(-10, 0), 350);
});

test("childHue: a deep chain of low-denoise generations does not wrap a full 360 degrees", () => {
  let hue = rootHue(round({ branchColorIndex: 0 }));
  for (let generation = 0; generation < 10; generation++) {
    hue = childHue(hue, 0.35);
  }
  // 14 degrees per generation * 10 generations = 140 degrees, well under 360.
  assert.equal(hue, 140);
  assert.ok(hue < 360);
});
