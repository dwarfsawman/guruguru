import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaintHistoryEntry } from "./paintHistory.ts";
import {
  PAINT_UNDO_LAYER_LIMIT,
  PAINT_UNDO_TOTAL_LIMIT,
  objectsHistoryEntry,
  pushPaintHistoryEntry
} from "./paintHistory.ts";
import type { PastedObject } from "../shared/pasteAttachments.ts";

function layerEntry(label: string): PaintHistoryEntry<string> {
  return { kind: "layer", snapshot: label };
}

function objectsEntry(ids: string[]): PaintHistoryEntry<string> {
  const objects: PastedObject[] = ids.map((id) => ({
    id,
    sourceId: `src-${id}`,
    sourceWidth: 10,
    sourceHeight: 10,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }
  }));
  return { kind: "objects", objects, selectedId: null };
}

test("pushPaintHistoryEntry: layer-only stacks behave like the legacy snapshot ring (limit 5)", () => {
  const stack: Array<PaintHistoryEntry<string>> = [];
  for (let index = 0; index < 8; index += 1) {
    pushPaintHistoryEntry(stack, layerEntry(`snap-${index}`));
  }
  assert.equal(stack.length, PAINT_UNDO_LAYER_LIMIT);
  assert.deepEqual(
    stack.map((entry) => (entry.kind === "layer" ? entry.snapshot : "?")),
    ["snap-3", "snap-4", "snap-5", "snap-6", "snap-7"]
  );
});

test("pushPaintHistoryEntry: objects entries do not evict layer snapshots until the total limit", () => {
  const stack: Array<PaintHistoryEntry<string>> = [];
  pushPaintHistoryEntry(stack, layerEntry("snap-0"));
  for (let index = 0; index < 10; index += 1) {
    pushPaintHistoryEntry(stack, objectsEntry([`obj-${index}`]));
  }
  assert.equal(stack.length, 11);
  assert.equal(stack[0]!.kind, "layer");
});

test("pushPaintHistoryEntry: exceeding the layer limit shifts bottom entries, dropping older objects entries with them", () => {
  const stack: Array<PaintHistoryEntry<string>> = [];
  pushPaintHistoryEntry(stack, objectsEntry(["bottom"]));
  for (let index = 0; index < PAINT_UNDO_LAYER_LIMIT; index += 1) {
    pushPaintHistoryEntry(stack, layerEntry(`snap-${index}`));
  }
  assert.equal(stack.length, PAINT_UNDO_LAYER_LIMIT + 1);
  // 6 枚目の layer で底(objects)→さらに古い layer の順に消える
  pushPaintHistoryEntry(stack, layerEntry("snap-5"));
  assert.equal(stack.length, PAINT_UNDO_LAYER_LIMIT);
  assert.ok(stack.every((entry) => entry.kind === "layer"));
  assert.equal((stack[0] as { snapshot: string }).snapshot, "snap-1");
});

test("pushPaintHistoryEntry: total limit trims from the bottom", () => {
  const stack: Array<PaintHistoryEntry<string>> = [];
  for (let index = 0; index < PAINT_UNDO_TOTAL_LIMIT + 5; index += 1) {
    pushPaintHistoryEntry(stack, objectsEntry([`obj-${index}`]));
  }
  assert.equal(stack.length, PAINT_UNDO_TOTAL_LIMIT);
  const first = stack[0]!;
  assert.equal(first.kind, "objects");
  assert.equal((first as { objects: PastedObject[] }).objects[0]!.id, "obj-5");
});

test("objectsHistoryEntry: deep-copies object metadata", () => {
  const source: PastedObject = {
    id: "obj-1",
    sourceId: "src-1",
    sourceWidth: 10,
    sourceHeight: 10,
    transform: { x: 1, y: 2, rotation: 0, scaleX: 1, scaleY: 1 }
  };
  const entry = objectsHistoryEntry<string>([source], "obj-1");
  source.transform.x = 999;
  assert.equal(entry.kind, "objects");
  if (entry.kind === "objects") {
    assert.equal(entry.objects[0]!.transform.x, 1);
    assert.equal(entry.selectedId, "obj-1");
  }
});
