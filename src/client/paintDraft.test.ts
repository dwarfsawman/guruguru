import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPaintDraft, normalizePaintDraft, pushRecentColor } from "./paintDraft.ts";
import type { PaintDraft } from "./paintTypes.ts";
import { PAINT_MAX_RECENT_COLORS } from "./paintTypes.ts";

test("defaultPaintDraft: sets documented defaults", () => {
  const draft = defaultPaintDraft("asset-1");
  assert.equal(draft.assetId, "asset-1");
  assert.equal(draft.color, "#ffffff");
  assert.equal(draft.brushSize, 24);
  assert.equal(draft.tool, "brush");
  assert.equal(draft.previousTool, null);
  assert.deepEqual(draft.recentColors, []);
  assert.equal(draft.zoomScale, 1);
  assert.deepEqual(draft.panOffset, { x: 0, y: 0 });
});

test("normalizePaintDraft: fills in defaults for missing fields via spread", () => {
  const partial = { assetId: "asset-2" } as PaintDraft;
  const normalized = normalizePaintDraft(partial);
  assert.equal(normalized.brushSize, 24);
  assert.equal(normalized.tool, "brush");
  assert.deepEqual(normalized.panOffset, { x: 0, y: 0 });
  assert.deepEqual(normalized.recentColors, []);
});

test("normalizePaintDraft: preserves panOffset/recentColors when provided", () => {
  const draft = defaultPaintDraft("asset-3");
  draft.panOffset = { x: 5, y: 10 };
  draft.recentColors = ["#ff0000"];
  const normalized = normalizePaintDraft(draft);
  assert.deepEqual(normalized.panOffset, { x: 5, y: 10 });
  assert.deepEqual(normalized.recentColors, ["#ff0000"]);
});

test("pushRecentColor: adds a new color to the front", () => {
  const result = pushRecentColor(["#000000"], "#ff0000");
  assert.deepEqual(result, ["#ff0000", "#000000"]);
});

test("pushRecentColor: de-duplicates case-insensitively and moves the color to the front", () => {
  const result = pushRecentColor(["#FF0000", "#00ff00"], "#ff0000");
  assert.deepEqual(result, ["#ff0000", "#00ff00"]);
});

test("defaultPaintDraft: paste fields default to empty/unselected", () => {
  const draft = defaultPaintDraft("asset-p");
  assert.deepEqual(draft.pasteObjects, []);
  assert.equal(draft.selectedPasteObjectId, null);
});

test("normalizePaintDraft: sanitizes pasteObjects and clears a stale selection", () => {
  const draft = defaultPaintDraft("asset-p");
  draft.pasteObjects = [
    {
      id: "obj-1",
      sourceId: "src-1",
      sourceWidth: 10,
      sourceHeight: 10,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }
    },
    // 不正エントリ(scaleX <= 0)は黙って除外される
    {
      id: "obj-2",
      sourceId: "src-2",
      sourceWidth: 10,
      sourceHeight: 10,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 0, scaleY: 1 }
    }
  ];
  draft.selectedPasteObjectId = "obj-2";
  const normalized = normalizePaintDraft(draft);
  assert.deepEqual(normalized.pasteObjects.map((object) => object.id), ["obj-1"]);
  assert.equal(normalized.selectedPasteObjectId, null);
});

test("normalizePaintDraft: keeps a valid selection", () => {
  const draft = defaultPaintDraft("asset-p");
  draft.pasteObjects = [
    {
      id: "obj-1",
      sourceId: "src-1",
      sourceWidth: 10,
      sourceHeight: 10,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }
    }
  ];
  draft.selectedPasteObjectId = "obj-1";
  assert.equal(normalizePaintDraft(draft).selectedPasteObjectId, "obj-1");
});

test("pushRecentColor: truncates to PAINT_MAX_RECENT_COLORS", () => {
  const existing = Array.from({ length: PAINT_MAX_RECENT_COLORS }, (_, index) => `#${index}${index}${index}`);
  const result = pushRecentColor(existing, "#abcdef");
  assert.equal(result.length, PAINT_MAX_RECENT_COLORS);
  assert.equal(result[0], "#abcdef");
});
