import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPoseSkeletonDrawOps, poseSkeletonLineWidth } from "./poseSkeleton.ts";
import type { PosePoint } from "./poseTypes.ts";
import { OPENPOSE_BONE_COLORS, OPENPOSE_BONES, OPENPOSE_JOINT_COLORS, OPENPOSE_JOINT_COUNT } from "./poseTypes.ts";

function makePoints(overrides: Record<number, Partial<PosePoint>> = {}): PosePoint[] {
  return Array.from({ length: OPENPOSE_JOINT_COUNT }, (_, index) => ({
    x: index * 10,
    y: index * 5,
    visible: true,
    ...overrides[index]
  }));
}

test("poseSkeletonLineWidth: matches max(4, round(min(w,h)/128))", () => {
  assert.equal(poseSkeletonLineWidth(1000, 1000), Math.max(4, Math.round(1000 / 128)));
  assert.equal(poseSkeletonLineWidth(1280, 1280), Math.round(1280 / 128));
  assert.equal(poseSkeletonLineWidth(100, 100), 4); // round(100/128)=1 -> clamped to 4
  assert.equal(poseSkeletonLineWidth(64, 2000), 4); // shortSide=64 -> round=1 -> clamped to 4
});

test("poseSkeletonLineWidth: non-finite or non-positive dimensions fall back to 4", () => {
  assert.equal(poseSkeletonLineWidth(0, 0), 4);
  assert.equal(poseSkeletonLineWidth(NaN, 100), 4);
  assert.equal(poseSkeletonLineWidth(-10, 100), 4);
});

test("buildPoseSkeletonDrawOps: null/undefined/empty points returns empty array", () => {
  assert.deepEqual(buildPoseSkeletonDrawOps(null, 100, 100), []);
  assert.deepEqual(buildPoseSkeletonDrawOps(undefined, 100, 100), []);
  assert.deepEqual(buildPoseSkeletonDrawOps([], 100, 100), []);
});

test("buildPoseSkeletonDrawOps: full visible points produce one line per bone and one circle per joint", () => {
  const points = makePoints();
  const ops = buildPoseSkeletonDrawOps([points], 1280, 1280);
  const lines = ops.filter((op) => op.kind === "line");
  const circles = ops.filter((op) => op.kind === "circle");
  assert.equal(lines.length, OPENPOSE_BONES.length);
  assert.equal(circles.length, OPENPOSE_JOINT_COUNT);
  // bones are drawn before joints (matches renderPoseOverlay stacking order)
  assert.equal(ops[0]!.kind, "line");
  assert.equal(ops[ops.length - 1]!.kind, "circle");
});

test("buildPoseSkeletonDrawOps: line coordinates and color follow OPENPOSE_BONES / OPENPOSE_BONE_COLORS", () => {
  const points = makePoints();
  const ops = buildPoseSkeletonDrawOps([points], 1280, 1280);
  const lines = ops.filter((op): op is Extract<typeof op, { kind: "line" }> => op.kind === "line");
  const firstBone = OPENPOSE_BONES[0]!;
  const firstColor = OPENPOSE_BONE_COLORS[0]!;
  const first = lines[0]!;
  assert.equal(first.x1, points[firstBone[0]]!.x);
  assert.equal(first.y1, points[firstBone[0]]!.y);
  assert.equal(first.x2, points[firstBone[1]]!.x);
  assert.equal(first.y2, points[firstBone[1]]!.y);
  assert.deepEqual(first.color, firstColor);
  assert.equal(first.lineWidth, poseSkeletonLineWidth(1280, 1280));
});

test("buildPoseSkeletonDrawOps: circle coordinates, radius, and color follow OPENPOSE_JOINT_COLORS", () => {
  const points = makePoints();
  const ops = buildPoseSkeletonDrawOps([points], 1280, 1280);
  const circles = ops.filter((op): op is Extract<typeof op, { kind: "circle" }> => op.kind === "circle");
  const first = circles[0]!;
  assert.equal(first.x, points[0]!.x);
  assert.equal(first.y, points[0]!.y);
  assert.equal(first.radius, poseSkeletonLineWidth(1280, 1280));
  assert.deepEqual(first.color, OPENPOSE_JOINT_COLORS[0]);
});

test("buildPoseSkeletonDrawOps: skips a bone if either endpoint is invisible", () => {
  const points = makePoints({ 0: { visible: false } });
  const ops = buildPoseSkeletonDrawOps([points], 1280, 1280);
  const lines = ops.filter((op) => op.kind === "line");
  // bones touching joint 0 (index 12 "1->0" and 13 "0->14" and 15 "0->15") should be skipped
  const bonesTouchingZero = OPENPOSE_BONES.filter((bone) => bone[0] === 0 || bone[1] === 0).length;
  assert.equal(lines.length, OPENPOSE_BONES.length - bonesTouchingZero);
});

test("buildPoseSkeletonDrawOps: skips a bone if either endpoint is missing (sparse array)", () => {
  const points = makePoints();
  // simulate a missing point entry entirely (defensive; normal flow always has 18 entries)
  delete (points as unknown as (PosePoint | undefined)[])[2];
  const ops = buildPoseSkeletonDrawOps([points], 1280, 1280);
  const lines = ops.filter((op) => op.kind === "line");
  const bonesTouchingTwo = OPENPOSE_BONES.filter((bone) => bone[0] === 2 || bone[1] === 2).length;
  assert.equal(lines.length, OPENPOSE_BONES.length - bonesTouchingTwo);
});

test("buildPoseSkeletonDrawOps: skips invisible joints entirely (no circle emitted)", () => {
  const points = makePoints({ 5: { visible: false }, 6: { visible: false } });
  const ops = buildPoseSkeletonDrawOps([points], 1280, 1280);
  const circles = ops.filter((op) => op.kind === "circle");
  assert.equal(circles.length, OPENPOSE_JOINT_COUNT - 2);
});

test("buildPoseSkeletonDrawOps: all points invisible produces no ops", () => {
  const points = makePoints().map((point) => ({ ...point, visible: false }));
  const ops = buildPoseSkeletonDrawOps([points], 1280, 1280);
  assert.deepEqual(ops, []);
});

test("buildPoseSkeletonDrawOps: two poses produce ops for both people, per-person bones-then-joints", () => {
  const a = makePoints();
  const b = makePoints().map((point) => ({ ...point, x: point.x + 500 }));
  const ops = buildPoseSkeletonDrawOps([a, b], 1280, 1280);
  assert.equal(ops.filter((op) => op.kind === "line").length, OPENPOSE_BONES.length * 2);
  assert.equal(ops.filter((op) => op.kind === "circle").length, OPENPOSE_JOINT_COUNT * 2);
  // 2人目の ops は1人目の後ろに連続する（人単位のグルーピング）
  const firstPersonOps = ops.slice(0, OPENPOSE_BONES.length + OPENPOSE_JOINT_COUNT);
  assert.ok(firstPersonOps.every((op) => (op.kind === "line" ? op.x1 < 500 : op.x < 500)));
});
