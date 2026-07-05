import { test } from "node:test";
import assert from "node:assert/strict";
import { iterationEdgePath } from "./iterationTreeEdges.ts";

test("iterationEdgePath: cubic bezier starts at `from` and ends at `to`", () => {
  const d = iterationEdgePath({ x: 10, y: 50 }, { x: 90, y: 50 });
  assert.match(d, /^M 10 50 C /);
  assert.match(d, /90 50$/);
});

test("iterationEdgePath: control points keep horizontal tangents at both ends", () => {
  // 水平距離 80 → ハンドル長 40。制御点は始点/終点と同じ y を持つ。
  const d = iterationEdgePath({ x: 10, y: 50 }, { x: 90, y: 120 });
  assert.equal(d, "M 10 50 C 50 50, 50 120, 90 120");
});

test("iterationEdgePath: enforces a minimum handle length for near-vertical edges", () => {
  // 水平距離 4 → 0.5倍だと 2px しかないので下限 14px を使う。
  const d = iterationEdgePath({ x: 100, y: 0 }, { x: 104, y: 60 });
  assert.equal(d, "M 100 0 C 114 0, 90 60, 104 60");
});

test("iterationEdgePath: rounds every coordinate to at most one decimal place", () => {
  const d = iterationEdgePath({ x: 0.333, y: 1.666 }, { x: 40.777, y: 9.123 });
  for (const token of d.match(/-?\d+(\.\d+)?/g) ?? []) {
    assert.ok(!/\.\d{2,}/.test(token), `coordinate not rounded: ${token}`);
  }
});
