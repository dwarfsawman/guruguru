import { test } from "node:test";
import assert from "node:assert/strict";
import type { PastedObject, PasteTransform } from "../shared/pasteAttachments.ts";
import {
  applyMoveGesture,
  applyRotateGesture,
  applyScaleGesture,
  clampPasteTransform,
  fitInitialPasteTransform,
  hitTestPastedObjects,
  localToWorld,
  nudgeTransform,
  pastedObjectBounds,
  pastedObjectCorners,
  pointInPastedObject,
  snapRotation,
  unionPasteBounds,
  worldToLocal
} from "./pasteTransform.ts";

function transform(overrides: Partial<PasteTransform> = {}): PasteTransform {
  return { x: 100, y: 50, rotation: 0, scaleX: 1, scaleY: 1, ...overrides };
}

function object(overrides: Partial<PastedObject> = {}): PastedObject {
  return {
    id: "obj-1",
    sourceId: "src-1",
    sourceWidth: 40,
    sourceHeight: 20,
    transform: transform(),
    ...overrides
  };
}

function assertPointClose(actual: { x: number; y: number }, expected: { x: number; y: number }, epsilon = 1e-9) {
  assert.ok(Math.abs(actual.x - expected.x) < epsilon, `x: ${actual.x} !~ ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < epsilon, `y: ${actual.y} !~ ${expected.y}`);
}

test("localToWorld/worldToLocal: identity transform maps by translation only", () => {
  const t = transform();
  assertPointClose(localToWorld(t, { x: 10, y: -5 }), { x: 110, y: 45 });
  assertPointClose(worldToLocal(t, { x: 110, y: 45 }), { x: 10, y: -5 });
});

test("localToWorld/worldToLocal: are inverse under rotation + non-uniform scale", () => {
  const t = transform({ rotation: Math.PI / 3, scaleX: 2, scaleY: 0.5 });
  const local = { x: 7, y: -3 };
  const roundTrip = worldToLocal(t, localToWorld(t, local));
  assertPointClose(roundTrip, local);
});

test("pastedObjectCorners: 90° rotation swaps width/height directions", () => {
  const obj = object({ transform: transform({ rotation: Math.PI / 2 }) });
  const corners = pastedObjectCorners(obj);
  // ローカル左上(-20,-10) → 回転後 (10,-20) + 中心(100,50)
  assertPointClose(corners[0]!, { x: 110, y: 30 });
});

test("pastedObjectBounds: axis-aligned box with margin", () => {
  const bounds = pastedObjectBounds(object(), 2);
  assert.deepEqual(bounds, { x: 78, y: 38, width: 44, height: 24 });
});

test("unionPasteBounds: merges rects and returns null for empty input", () => {
  assert.equal(unionPasteBounds([]), null);
  const union = unionPasteBounds([
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 5, y: -5, width: 10, height: 10 }
  ]);
  assert.deepEqual(union, { x: 0, y: -5, width: 15, height: 15 });
});

test("pointInPastedObject: respects rotation", () => {
  const rotated = object({ transform: transform({ rotation: Math.PI / 2 }) });
  // 回転後は縦長(幅20×高40相当)になる。回転前の横長判定なら true になる点が false になる。
  assert.equal(pointInPastedObject(rotated, { x: 118, y: 50 }), false);
  assert.equal(pointInPastedObject(rotated, { x: 100, y: 68 }), true);
});

test("hitTestPastedObjects: returns the topmost (last) hit", () => {
  const back = object({ id: "back" });
  const front = object({ id: "front" });
  const hit = hitTestPastedObjects([back, front], { x: 100, y: 50 });
  assert.equal(hit?.id, "front");
  assert.equal(hitTestPastedObjects([back, front], { x: 500, y: 500 }), null);
});

test("applyMoveGesture: translates by pointer delta; axis lock keeps the dominant axis", () => {
  const start = transform();
  const moved = applyMoveGesture(start, { x: 0, y: 0 }, { x: 10, y: 4 });
  assert.equal(moved.x, 110);
  assert.equal(moved.y, 54);
  const locked = applyMoveGesture(start, { x: 0, y: 0 }, { x: 10, y: 4 }, true);
  assert.equal(locked.x, 110);
  assert.equal(locked.y, 50);
  const lockedVertical = applyMoveGesture(start, { x: 0, y: 0 }, { x: 3, y: -9 }, true);
  assert.equal(lockedVertical.x, 100);
  assert.equal(lockedVertical.y, 41);
});

test("applyScaleGesture: uniform scale from center distance ratio, rotation-independent", () => {
  const start = transform({ rotation: Math.PI / 5 });
  const scaled = applyScaleGesture(start, { x: 110, y: 50 }, { x: 120, y: 50 });
  assert.ok(Math.abs(scaled.scaleX - 2) < 1e-9);
  assert.ok(Math.abs(scaled.scaleY - 2) < 1e-9);
});

test("applyScaleGesture: independent axes scale per local axis", () => {
  const start = transform();
  // 開始点(中心から +10x, +5y) → x 方向だけ2倍
  const scaled = applyScaleGesture(start, { x: 110, y: 55 }, { x: 120, y: 55 }, true);
  assert.ok(Math.abs(scaled.scaleX - 2) < 1e-9);
  assert.ok(Math.abs(scaled.scaleY - 1) < 1e-9);
});

test("applyScaleGesture: degenerate start point (at center) is a no-op", () => {
  const start = transform();
  const scaled = applyScaleGesture(start, { x: 100, y: 50 }, { x: 200, y: 50 });
  assert.equal(scaled.scaleX, 1);
  assert.equal(scaled.scaleY, 1);
});

test("applyRotateGesture: rotates by atan2 delta; snap rounds to 15°", () => {
  const start = transform();
  const rotated = applyRotateGesture(start, { x: 110, y: 50 }, { x: 100, y: 60 });
  assert.ok(Math.abs(rotated.rotation - Math.PI / 2) < 1e-9);
  const snapped = applyRotateGesture(start, { x: 110, y: 50 }, { x: 110, y: 51 }, true);
  assert.equal(snapped.rotation, 0);
});

test("snapRotation: rounds to the nearest step", () => {
  const step15 = (15 * Math.PI) / 180;
  assert.ok(Math.abs(snapRotation(step15 * 1.4, 15) - step15) < 1e-9);
  assert.ok(Math.abs(snapRotation(step15 * 1.6, 15) - step15 * 2) < 1e-9);
});

test("nudgeTransform: shifts x/y", () => {
  const nudged = nudgeTransform(transform(), 1, -10);
  assert.equal(nudged.x, 101);
  assert.equal(nudged.y, 40);
});

test("clampPasteTransform: clamps scale to result-size bounds and center into the canvas", () => {
  // src 40x20, canvas 400x300 → minScale = 8/40 = 0.2, maxScale = 4*400/20 = 80
  const clamped = clampPasteTransform(transform({ scaleX: 0.01, scaleY: 200, x: -50, y: 999 }), 40, 20, 400, 300);
  assert.equal(clamped.scaleX, 0.2);
  assert.equal(clamped.scaleY, 80);
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 300);
});

test("clampPasteTransform: non-finite values fall back to safe defaults", () => {
  const clamped = clampPasteTransform(
    { x: Number.NaN, y: Infinity, rotation: Number.NaN, scaleX: Number.NaN, scaleY: -1 },
    40,
    20,
    400,
    300
  );
  assert.equal(clamped.x, 200);
  assert.equal(clamped.y, 150);
  assert.equal(clamped.rotation, 0);
  assert.equal(clamped.scaleX, 1);
  assert.equal(clamped.scaleY, 1);
});

test("fitInitialPasteTransform: fits into 60% of the canvas without upscaling", () => {
  // src 1000x500, canvas 400x300 → scale = min(1, 240/1000, 180/500) = 0.24
  const fitted = fitInitialPasteTransform(1000, 500, 400, 300);
  assert.ok(Math.abs(fitted.scaleX - 0.24) < 1e-9);
  assert.equal(fitted.scaleX, fitted.scaleY);
  assert.equal(fitted.x, 200);
  assert.equal(fitted.y, 150);
  // 小さい画像は等倍のまま
  const small = fitInitialPasteTransform(50, 50, 400, 300);
  assert.equal(small.scaleX, 1);
});

test("fitInitialPasteTransform: uses the drop point and clamps it into the canvas", () => {
  const fitted = fitInitialPasteTransform(50, 50, 400, 300, { x: 10, y: 500 });
  assert.equal(fitted.x, 10);
  assert.equal(fitted.y, 300);
});
