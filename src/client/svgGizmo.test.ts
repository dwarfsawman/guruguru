import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gizmoBoxCorners,
  gizmoRotateHandlePoint,
  gizmoScreenPxToUnits,
  gizmoTopMid,
  gizmoUpVector,
  moveGizmoBox,
  normalizeGizmoAngle,
  rotateGizmoBox,
  rotatePointAround,
  scaleGizmoBoxAboutCenter,
  type GizmoBox,
  type GizmoVec
} from "./svgGizmo.ts";

function assertVecClose(actual: GizmoVec, expected: GizmoVec, epsilon = 1e-9) {
  assert.ok(Math.abs(actual.x - expected.x) < epsilon, `x: ${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < epsilon, `y: ${actual.y} != ${expected.y}`);
}

test("rotatePointAround: 90度回転で座標が入れ替わる", () => {
  const result = rotatePointAround({ x: 1, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);
  assert.ok(Math.abs(result.x - 0) < 1e-9);
  assert.ok(Math.abs(result.y - 1) < 1e-9);
});

test("gizmoBoxCorners: 無回転なら軸平行の4頂点", () => {
  const box: GizmoBox = { center: { x: 0.5, y: 0.5 }, size: { x: 0.2, y: 0.1 }, rotation: 0 };
  const corners = gizmoBoxCorners(box);
  const expected: GizmoVec[] = [
    { x: 0.4, y: 0.45 },
    { x: 0.6, y: 0.45 },
    { x: 0.6, y: 0.55 },
    { x: 0.4, y: 0.55 }
  ];
  corners.forEach((corner, index) => assertVecClose(corner, expected[index]!));
});

test("gizmoTopMid/gizmoUpVector: 無回転なら上辺中央かつ上向き", () => {
  const box: GizmoBox = { center: { x: 0.5, y: 0.5 }, size: { x: 0.2, y: 0.2 }, rotation: 0 };
  const topMid = gizmoTopMid(box);
  assert.ok(Math.abs(topMid.x - 0.5) < 1e-9);
  assert.ok(Math.abs(topMid.y - 0.4) < 1e-9);
  const up = gizmoUpVector(0);
  assert.ok(Math.abs(up.x - 0) < 1e-9);
  assert.ok(Math.abs(up.y - -1) < 1e-9);
});

test("moveGizmoBox: center を dx/dy だけ動かす(size/rotation は不変)", () => {
  const box: GizmoBox = { center: { x: 0.2, y: 0.3 }, size: { x: 0.1, y: 0.1 }, rotation: 0.4 };
  const moved = moveGizmoBox(box, 0.05, -0.02);
  assertVecClose(moved.center, { x: 0.25, y: 0.28 });
  assert.equal(moved.rotation, 0.4);
  assert.deepEqual(moved.size, box.size);
});

test("scaleGizmoBoxAboutCenter: factor 通りに拡縮し、範囲内なら丸めない", () => {
  const box: GizmoBox = { center: { x: 0.5, y: 0.5 }, size: { x: 0.1, y: 0.2 }, rotation: 0 };
  const scaled = scaleGizmoBoxAboutCenter(box, 2, 0.01, 5);
  assert.ok(Math.abs(scaled.size.x - 0.2) < 1e-9);
  assert.ok(Math.abs(scaled.size.y - 0.4) < 1e-9);
  assert.deepEqual(scaled.center, box.center);
});

test("scaleGizmoBoxAboutCenter: 縦横比を保ちながら min/max へクランプする", () => {
  const box: GizmoBox = { center: { x: 0.5, y: 0.5 }, size: { x: 0.1, y: 0.05 }, rotation: 0 };
  // factor が非常に大きい→ min(maxSize/0.1, maxSize/0.05) でクランプされる。
  const scaled = scaleGizmoBoxAboutCenter(box, 1000, 0.01, 1);
  assert.ok(scaled.size.x <= 1 + 1e-9);
  assert.ok(scaled.size.y <= 1 + 1e-9);
  // アスペクト比(size.x/size.y = 2)を保つ。
  assert.ok(Math.abs(scaled.size.x / scaled.size.y - 2) < 1e-6);

  const shrunk = scaleGizmoBoxAboutCenter(box, 0.0001, 0.02, 5);
  assert.ok(shrunk.size.x >= 0.02 - 1e-9 || shrunk.size.y >= 0.02 - 1e-9);
  assert.ok(Math.abs(shrunk.size.x / shrunk.size.y - 2) < 1e-6);
});

test("scaleGizmoBoxAboutCenter: 非有限/0以下の factor は 1 扱い", () => {
  const box: GizmoBox = { center: { x: 0.5, y: 0.5 }, size: { x: 0.1, y: 0.1 }, rotation: 0 };
  const a = scaleGizmoBoxAboutCenter(box, NaN, 0.01, 5);
  const b = scaleGizmoBoxAboutCenter(box, -1, 0.01, 5);
  assert.deepEqual(a.size, box.size);
  assert.deepEqual(b.size, box.size);
});

test("normalizeGizmoAngle: 角度を (-π, π] へ折り返し、非数は 0", () => {
  assert.ok(Math.abs(normalizeGizmoAngle(Math.PI * 3) - Math.PI) < 1e-9);
  assert.equal(normalizeGizmoAngle(Number.NaN), 0);
  assert.ok(Math.abs(normalizeGizmoAngle(-Math.PI * 3) - -Math.PI) < 1e-9 || Math.abs(normalizeGizmoAngle(-Math.PI * 3) - Math.PI) < 1e-9);
});

test("rotateGizmoBox: 差分角を加算し、snap 時は15度刻みへ丸める", () => {
  const box: GizmoBox = { center: { x: 0, y: 0 }, size: { x: 0.1, y: 0.1 }, rotation: 0 };
  const rotated = rotateGizmoBox(box, 0, Math.PI / 4, false);
  assert.ok(Math.abs(rotated.rotation - Math.PI / 4) < 1e-9);

  const snapped = rotateGizmoBox(box, 0, (7 * Math.PI) / 180, true);
  // 7度は15度刻みで0度へ丸まる。
  assert.ok(Math.abs(snapped.rotation - 0) < 1e-9);

  const snappedUp = rotateGizmoBox(box, 0, (20 * Math.PI) / 180, true);
  assert.ok(Math.abs(snappedUp.rotation - Math.PI / 12) < 1e-9);
});

test("gizmoRotateHandlePoint: 範囲内なら外向き、範囲外なら内向きへ反転する", () => {
  const topMid = { x: 0.5, y: 0.1 };
  const up = { x: 0, y: -1 };
  const bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1.4 };
  const reachable = gizmoRotateHandlePoint(topMid, up, 0.05, bounds);
  assertVecClose(reachable, { x: 0.5, y: 0.05 });

  const unreachable = gizmoRotateHandlePoint(topMid, up, 0.2, bounds);
  // 0.1 - 0.2 = -0.1 は範囲外(minY=0) → 反転して内向き。
  assertVecClose(unreachable, { x: 0.5, y: 0.3 });
});

test("gizmoScreenPxToUnits: pxPerUnit で割る(0以下は px をそのまま返す)", () => {
  assert.ok(Math.abs(gizmoScreenPxToUnits(100, 7) - 0.07) < 1e-9);
  assert.equal(gizmoScreenPxToUnits(0, 7), 7);
});
