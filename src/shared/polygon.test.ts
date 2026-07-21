import { test } from "node:test";
import assert from "node:assert/strict";
import { polygonArea, polygonSignedArea } from "./polygon.ts";

const CW_SQUARE: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1]
];

test("polygonSignedArea: y-down 座標系で時計回りは正、反時計回りは負", () => {
  assert.equal(polygonSignedArea(CW_SQUARE), 1);
  assert.equal(polygonSignedArea([...CW_SQUARE].reverse()), -1);
});

test("polygonSignedArea: 3頂点未満は 0", () => {
  assert.equal(polygonSignedArea([]), 0);
  assert.equal(polygonSignedArea([[0.3, 0.7]]), 0);
  assert.equal(polygonSignedArea([[0, 0], [1, 0.5]]), 0);
});

test("polygonArea: 符号なし面積(向きに依らず同値)", () => {
  assert.equal(polygonArea(CW_SQUARE), 1);
  assert.equal(polygonArea([...CW_SQUARE].reverse()), 1);
  // 三角形 (0,0)-(1,0)-(0,1) = 0.5
  assert.equal(polygonArea([[0, 0], [1, 0], [0, 1]]), 0.5);
});
