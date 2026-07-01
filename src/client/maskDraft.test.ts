import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultInpaintDraft,
  hasActiveMaskData,
  hasMaskData,
  isMaskedContent,
  maskedContentOptions,
  normalizeInpaintDraft
} from "./maskDraft.ts";
import type { InpaintDraft } from "./maskTypes.ts";

test("maskedContentOptions: includes all four MaskedContent values", () => {
  const values = maskedContentOptions.map((option) => option.value);
  assert.deepEqual(values, ["original", "fill", "latent_noise", "latent_nothing"]);
});

test("defaultInpaintDraft: sets documented defaults", () => {
  const draft = defaultInpaintDraft("asset-1");
  assert.equal(draft.parentAssetId, "asset-1");
  assert.equal(draft.maskedContent, "original");
  assert.equal(draft.brushSize, 48);
  assert.equal(draft.maskOpacity, 0.58);
  assert.equal(draft.enabled, false);
  assert.equal(draft.maskDataUrl, "");
  assert.equal(draft.inpaintArea, "only_masked");
  assert.equal(draft.selectedSmartMaskProvider, "manual");
});

test("normalizeInpaintDraft: fills in defaults for missing fields via spread", () => {
  const partial = { parentAssetId: "asset-2" } as InpaintDraft;
  const normalized = normalizeInpaintDraft(partial);
  assert.equal(normalized.brushSize, 48);
  assert.equal(normalized.maskedContent, "original");
  assert.deepEqual(normalized.panOffset, { x: 0, y: 0 });
  assert.deepEqual(normalized.foregroundPoints, []);
  assert.deepEqual(normalized.samCandidates, []);
});

test("normalizeInpaintDraft: preserves panOffset/foregroundPoints/samCandidates when provided", () => {
  const draft = defaultInpaintDraft("asset-3");
  draft.panOffset = { x: 5, y: 10 };
  draft.foregroundPoints = [{ x: 1, y: 2, label: 1 }];
  draft.samCandidates = [{ index: 0, score: 0.9, dataUrl: "data:x" }];
  const normalized = normalizeInpaintDraft(draft);
  assert.deepEqual(normalized.panOffset, { x: 5, y: 10 });
  assert.equal(normalized.foregroundPoints.length, 1);
  assert.equal(normalized.samCandidates.length, 1);
});

test("normalizeInpaintDraft: migrates legacy maskDataUrl into manualIncludeMaskDataUrl when no other mask source exists", () => {
  const draft = defaultInpaintDraft("asset-4");
  draft.maskDataUrl = "data:image/png;base64,legacy";
  const normalized = normalizeInpaintDraft(draft);
  assert.equal(normalized.manualIncludeMaskDataUrl, "data:image/png;base64,legacy");
});

test("normalizeInpaintDraft: does not overwrite manualIncludeMaskDataUrl when another mask source already exists", () => {
  const draft = defaultInpaintDraft("asset-5");
  draft.maskDataUrl = "data:image/png;base64,legacy";
  draft.samMaskDataUrl = "data:image/png;base64,sam";
  const normalized = normalizeInpaintDraft(draft);
  assert.equal(normalized.manualIncludeMaskDataUrl, "");
});

test("hasMaskData: true only for a data:image/png;base64, maskDataUrl", () => {
  assert.equal(hasMaskData({ maskDataUrl: "data:image/png;base64,abc" } as InpaintDraft), true);
  assert.equal(hasMaskData({ maskDataUrl: "data:image/jpeg;base64,abc" } as InpaintDraft), false);
  assert.equal(hasMaskData({ maskDataUrl: "" } as InpaintDraft), false);
  assert.equal(hasMaskData(null), false);
  assert.equal(hasMaskData(undefined), false);
});

test("hasActiveMaskData: true only when enabled is true and maskData is present", () => {
  const draft = { enabled: true, maskDataUrl: "data:image/png;base64,abc" } as InpaintDraft;
  assert.equal(hasActiveMaskData(draft), true);

  const disabled = { enabled: false, maskDataUrl: "data:image/png;base64,abc" } as InpaintDraft;
  assert.equal(hasActiveMaskData(disabled), false);

  const noMask = { enabled: true, maskDataUrl: "" } as InpaintDraft;
  assert.equal(hasActiveMaskData(noMask), false);

  assert.equal(hasActiveMaskData(null), false);
});

test("isMaskedContent: true for known values, false otherwise", () => {
  assert.equal(isMaskedContent("original"), true);
  assert.equal(isMaskedContent("fill"), true);
  assert.equal(isMaskedContent("latent_noise"), true);
  assert.equal(isMaskedContent("latent_nothing"), true);
  assert.equal(isMaskedContent("unknown"), false);
  assert.equal(isMaskedContent(""), false);
});
