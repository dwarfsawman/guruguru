/**
 * Tests only the DOM-free geometry helpers exported from maskCanvas.ts
 * (distanceToSegmentSq, normalizePromptBox, sampleBrushPromptPoints).
 * The rest of maskCanvas.ts draws into a real HTMLCanvasElement/CanvasRenderingContext2D
 * and is intentionally out of scope for this test file (no DOM in Node's test runner).
 *
 * sampleBrushPromptPoints only calls canvas.getContext("2d") and then reads
 * .width/.height and the ImageData returned by getImageData(...) — it never touches
 * any other DOM API, so a minimal duck-typed fake canvas (cast to HTMLCanvasElement
 * for the type signature) exercises the exact same runtime code path as a real canvas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampDirtyRectToCanvas,
  dirtyRectForSegments,
  distanceToSegmentSq,
  mergeDirtyRects,
  normalizePromptBox,
  sampleBrushPromptPoints,
  segmentDirtyRect
} from "./maskCanvas.ts";

test("distanceToSegmentSq: distance to a degenerate segment (from === to) is distance to that point", () => {
  const point = { x: 3, y: 4 };
  const from = { x: 0, y: 0 };
  const to = { x: 0, y: 0 };
  assert.equal(distanceToSegmentSq(point, from, to), 25);
});

test("distanceToSegmentSq: perpendicular distance to a point on the segment's interior", () => {
  const point = { x: 5, y: 3 };
  const from = { x: 0, y: 0 };
  const to = { x: 10, y: 0 };
  assert.equal(distanceToSegmentSq(point, from, to), 9);
});

test("distanceToSegmentSq: clamps projection to segment endpoints when point projects outside", () => {
  const point = { x: -5, y: 0 };
  const from = { x: 0, y: 0 };
  const to = { x: 10, y: 0 };
  // Closest point is `from` (0,0); distance is 5^2 = 25.
  assert.equal(distanceToSegmentSq(point, from, to), 25);

  const beyondEnd = { x: 15, y: 0 };
  assert.equal(distanceToSegmentSq(beyondEnd, from, to), 25);
});

test("distanceToSegmentSq: zero for a point exactly on the segment", () => {
  const point = { x: 5, y: 5 };
  const from = { x: 0, y: 0 };
  const to = { x: 10, y: 10 };
  assert.equal(distanceToSegmentSq(point, from, to), 0);
});

test("normalizePromptBox: returns null for a null box", () => {
  assert.equal(normalizePromptBox(null), null);
});

test("normalizePromptBox: normalizes reversed coordinates so x1<=x2 and y1<=y2", () => {
  const result = normalizePromptBox({ x1: 10, y1: 20, x2: 0, y2: 5 });
  assert.deepEqual(result, { x1: 0, y1: 5, x2: 10, y2: 20 });
});

test("normalizePromptBox: returns null when the box is too thin (< 2px) in width or height", () => {
  assert.equal(normalizePromptBox({ x1: 0, y1: 0, x2: 1, y2: 10 }), null);
  assert.equal(normalizePromptBox({ x1: 0, y1: 0, x2: 10, y2: 1 }), null);
  assert.equal(normalizePromptBox({ x1: 5, y1: 5, x2: 5, y2: 5 }), null);
});

test("normalizePromptBox: keeps a box that is exactly at the 2px threshold or larger", () => {
  const result = normalizePromptBox({ x1: 0, y1: 0, x2: 2, y2: 2 });
  assert.deepEqual(result, { x1: 0, y1: 0, x2: 2, y2: 2 });
});

/** Minimal duck-typed canvas whose 2d context serves a caller-provided alpha-channel grid. */
function fakeCanvasWithAlpha(width: number, height: number, alphaAt: (x: number, y: number) => number): HTMLCanvasElement {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[(y * width + x) * 4 + 3] = alphaAt(x, y);
    }
  }
  const context = {
    getImageData: () => ({ data, width, height }) as unknown as ImageData
  };
  return {
    width,
    height,
    getContext: () => context as unknown as CanvasRenderingContext2D
  } as unknown as HTMLCanvasElement;
}

test("sampleBrushPromptPoints: returns an empty array when the canvas has no painted (alpha>0) pixels", () => {
  const canvas = fakeCanvasWithAlpha(20, 20, () => 0);
  assert.deepEqual(sampleBrushPromptPoints(canvas, 10, 48), []);
});

test("sampleBrushPromptPoints: returns an empty array when width or height is <= 0", () => {
  const canvas = fakeCanvasWithAlpha(0, 20, () => 255);
  assert.deepEqual(sampleBrushPromptPoints(canvas, 10, 48), []);
});

test("sampleBrushPromptPoints: samples brush-labeled points on a spacing grid where alpha > 0", () => {
  // Fully painted 20x20 canvas, spacing 10 -> sample grid at (5,5) and (15,5), (5,15), (15,15).
  const canvas = fakeCanvasWithAlpha(20, 20, () => 255);
  const points = sampleBrushPromptPoints(canvas, 10, 48);
  assert.equal(points.length, 4);
  for (const point of points) {
    assert.equal(point.label, 1);
    assert.equal(point.source, "brush");
  }
  const coords = points.map((point) => `${point.x},${point.y}`).sort();
  assert.deepEqual(coords, ["15,15", "15,5", "5,15", "5,5"]);
});

test("sampleBrushPromptPoints: stops once maxPoints is reached", () => {
  const canvas = fakeCanvasWithAlpha(40, 40, () => 255);
  const points = sampleBrushPromptPoints(canvas, 10, 3);
  assert.equal(points.length, 3);
});

test("sampleBrushPromptPoints: only samples pixels at painted grid cells, skipping unpainted ones", () => {
  // Paint only the right half of the canvas.
  const canvas = fakeCanvasWithAlpha(20, 10, (x) => (x >= 10 ? 255 : 0));
  const points = sampleBrushPromptPoints(canvas, 10, 48);
  assert.equal(points.length, 1);
  assert.equal(points[0]!.x, 15);
  assert.equal(points[0]!.y, 5);
});

test("segmentDirtyRect: bbox of a point stroke (from === to) is centered arc of radius brushSize/2", () => {
  const rect = segmentDirtyRect({ x: 10, y: 10 }, { x: 10, y: 10 }, 8, 0);
  assert.deepEqual(rect, { x: 6, y: 6, width: 8, height: 8 });
});

test("segmentDirtyRect: bbox of a diagonal segment expands by brush radius and margin on all sides", () => {
  const rect = segmentDirtyRect({ x: 0, y: 0 }, { x: 10, y: 20 }, 4, 1);
  // radius = brushSize/2 + margin = 2 + 1 = 3
  assert.deepEqual(rect, { x: -3, y: -3, width: 16, height: 26 });
});

test("segmentDirtyRect: handles reversed from/to (to before from) the same as forward order", () => {
  const forward = segmentDirtyRect({ x: 0, y: 0 }, { x: 10, y: 10 }, 2, 0);
  const reversed = segmentDirtyRect({ x: 10, y: 10 }, { x: 0, y: 0 }, 2, 0);
  assert.deepEqual(forward, reversed);
});

test("mergeDirtyRects: union of two disjoint rects covers both", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  const b = { x: 20, y: 5, width: 5, height: 5 };
  assert.deepEqual(mergeDirtyRects(a, b), { x: 0, y: 0, width: 25, height: 10 });
});

test("mergeDirtyRects: a rect fully inside another is absorbed without changing the bbox", () => {
  const outer = { x: 0, y: 0, width: 100, height: 100 };
  const inner = { x: 40, y: 40, width: 5, height: 5 };
  assert.deepEqual(mergeDirtyRects(outer, inner), outer);
});

test("dirtyRectForSegments: returns null for an empty segment queue", () => {
  assert.equal(dirtyRectForSegments([], 10), null);
});

test("dirtyRectForSegments: single segment matches segmentDirtyRect", () => {
  const segments = [{ from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }];
  assert.deepEqual(dirtyRectForSegments(segments, 4, 0), segmentDirtyRect({ x: 0, y: 0 }, { x: 10, y: 0 }, 4, 0));
});

test("dirtyRectForSegments: multiple segments produce the union bbox across the whole queue", () => {
  const segments = [
    { from: { x: 0, y: 0 }, to: { x: 5, y: 0 } },
    { from: { x: 50, y: 50 }, to: { x: 60, y: 55 } }
  ];
  const rect = dirtyRectForSegments(segments, 2, 0);
  // radius = 1; combined bbox of [-1,-1]..[6,1] and [49,49]..[61,56]
  assert.deepEqual(rect, { x: -1, y: -1, width: 62, height: 57 });
});

test("clampDirtyRectToCanvas: rect fully inside canvas rounds outward to integer pixels", () => {
  const rect = clampDirtyRectToCanvas({ x: 1.5, y: 2.4, width: 10.2, height: 5.1 }, 100, 100);
  assert.deepEqual(rect, { x: 1, y: 2, width: 11, height: 6 });
});

test("clampDirtyRectToCanvas: clamps negative origin and overflow to the canvas bounds", () => {
  const rect = clampDirtyRectToCanvas({ x: -5, y: -5, width: 20, height: 20 }, 10, 10);
  assert.deepEqual(rect, { x: 0, y: 0, width: 10, height: 10 });
});

test("clampDirtyRectToCanvas: a rect entirely outside the canvas clamps to zero size", () => {
  const rect = clampDirtyRectToCanvas({ x: 200, y: 200, width: 10, height: 10 }, 100, 100);
  assert.equal(rect.width, 0);
  assert.equal(rect.height, 0);
});
