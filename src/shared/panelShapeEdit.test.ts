import { test } from "node:test";
import assert from "node:assert/strict";
import {
  insertPolygonVertex,
  movePolygonVertex,
  panelShapeToPolygon,
  polygonArea,
  removePolygonVertex,
  splitPanelByLine
} from "./panelShapeEdit.ts";
import type { PanelShape } from "./pageLayout.ts";

test("panelShapeToPolygon: rect は4頂点(角丸は破棄)になる", () => {
  const shape: PanelShape = { type: "rect", bounds: [0.2, 0.1, 0.8, 0.5], cornerRadius: 0.05 };
  const points = panelShapeToPolygon(shape);
  assert.deepEqual(points, [
    [0.2, 0.1],
    [0.8, 0.1],
    [0.8, 0.5],
    [0.2, 0.5]
  ]);
});

test("panelShapeToPolygon: rect の bounds が逆順([x2,y2,x1,y1] 相当)でも min/max に正規化される", () => {
  const shape: PanelShape = { type: "rect", bounds: [0.8, 0.5, 0.2, 0.1] };
  const points = panelShapeToPolygon(shape);
  assert.deepEqual(points, [
    [0.2, 0.1],
    [0.8, 0.1],
    [0.8, 0.5],
    [0.2, 0.5]
  ]);
});

test("panelShapeToPolygon: ellipse は16頂点の近似多角形になり、面積は解析解に近い", () => {
  const shape: PanelShape = { type: "ellipse", center: [0.5, 0.5], radius: [0.3, 0.2] };
  const points = panelShapeToPolygon(shape);
  assert.ok(points);
  assert.equal(points!.length, 16);
  const area = polygonArea(points!);
  const analytic = Math.PI * 0.3 * 0.2;
  assert.ok(Math.abs(area - analytic) / analytic < 0.03, `area=${area} analytic=${analytic}`);
});

test("panelShapeToPolygon: polygon はコピーを返す(参照が別)", () => {
  const original: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1]
  ];
  const shape: PanelShape = { type: "polygon", points: original };
  const points = panelShapeToPolygon(shape);
  assert.deepEqual(points, original);
  assert.notEqual(points, original);
  points![0]![0] = 999;
  assert.equal(original[0]![0], 0, "元の points 配列を変更していないこと");
});

test("panelShapeToPolygon: path は編集不可(null)", () => {
  const shape: PanelShape = { type: "path", d: "M0,0 L1,0 L1,1 Z" };
  assert.equal(panelShapeToPolygon(shape), null);
});

test("movePolygonVertex: 指定頂点を移動し、他は不変", () => {
  const points: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ];
  const next = movePolygonVertex(points, 1, [0.6, 0.2]);
  assert.deepEqual(next, [
    [0, 0],
    [0.6, 0.2],
    [1, 1],
    [0, 1]
  ]);
  // 元配列は変更していない。
  assert.deepEqual(points[1], [1, 0]);
});

test("movePolygonVertex: 範囲外/NaN は clamp する", () => {
  const points: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1]
  ];
  const next = movePolygonVertex(points, 0, [-5, 999], { maxX: 1, maxY: 1.4 });
  assert.deepEqual(next[0], [0, 1.4]);

  const withNaN = movePolygonVertex(points, 0, [Number.NaN, 0.3], { maxX: 1, maxY: 1.4 });
  assert.deepEqual(withNaN[0], [0, 0.3], "NaN の軸は元の値を維持する");
});

test("movePolygonVertex: index が範囲外なら無変更のコピーを返す", () => {
  const points: [number, number][] = [
    [0, 0],
    [1, 0]
  ];
  const next = movePolygonVertex(points, 5, [0.5, 0.5]);
  assert.deepEqual(next, points);
});

test("insertPolygonVertex: 辺の中点に頂点を挿入する", () => {
  const points: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ];
  const next = insertPolygonVertex(points, 0);
  assert.deepEqual(next, [
    [0, 0],
    [0.5, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ]);
});

test("insertPolygonVertex: 最終辺(末尾→先頭)にも挿入できる", () => {
  const points: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1]
  ];
  const next = insertPolygonVertex(points, 2);
  assert.deepEqual(next, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0.5, 0.5]
  ]);
});

test("removePolygonVertex: 4頂点から1点削除できる", () => {
  const points: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ];
  const next = removePolygonVertex(points, 1);
  assert.deepEqual(next, [
    [0, 0],
    [1, 1],
    [0, 1]
  ]);
});

test("removePolygonVertex: 3頂点未満になる削除は拒否(null)", () => {
  const points: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1]
  ];
  assert.equal(removePolygonVertex(points, 0), null);
});

test("removePolygonVertex: index が範囲外なら null", () => {
  const points: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ];
  assert.equal(removePolygonVertex(points, 10), null);
});

test("polygonArea: 単位正方形の面積は1", () => {
  const points: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ];
  assert.equal(polygonArea(points), 1);
});

test("polygonArea: 3頂点未満は0", () => {
  assert.equal(polygonArea([[0, 0], [1, 0]]), 0);
});

test("splitPanelByLine: 正方形を垂直線でちょうど2分割し、ガター幅ぶん両側へオフセットする", () => {
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ];
  const result = splitPanelByLine(square, [0.5, -1], [0.5, 2], 0.02);
  assert.ok(result, "分割できること");
  const { a, b } = result!;
  // a: 右半分(x が 0.5+0.01 側)、b: 左半分。
  const aXs = a.map(([x]) => x);
  const bXs = b.map(([x]) => x);
  assert.ok(Math.min(...aXs) > 0.5, `a の最小xが0.5より大きい: ${JSON.stringify(a)}`);
  assert.ok(Math.max(...bXs) < 0.5, `b の最大xが0.5より小さい: ${JSON.stringify(b)}`);
  // ガター幅 0.02 の半分(0.01)ずつ、切断辺が中心(0.5)からオフセットしていること
  // (a の元コーナーは x=1、b の元コーナーは x=0 なので、それ以外の x が切断頂点)。
  const aCutXs = a.filter(([x]) => Math.abs(x - 1) > 1e-6).map(([x]) => x);
  const bCutXs = b.filter(([x]) => Math.abs(x - 0) > 1e-6).map(([x]) => x);
  assert.equal(aCutXs.length, 2);
  assert.equal(bCutXs.length, 2);
  for (const x of aCutXs) {
    assert.ok(Math.abs(x - 0.51) < 1e-6, `a cut x=${x}`);
  }
  for (const x of bCutXs) {
    assert.ok(Math.abs(x - 0.49) < 1e-6, `b cut x=${x}`);
  }
  // 面積は概ね等しい(ガターぶん合計が単位面積よりわずかに小さい)。
  assert.ok(Math.abs(polygonArea(a) - polygonArea(b)) < 0.01);
  assert.ok(polygonArea(a) + polygonArea(b) < 1);
});

test("splitPanelByLine: 直線が2交点を作らない(コマの外側を通る)場合は null", () => {
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ];
  // x=2 の垂直線はコマの外側を通り、どの頂点とも交差しない。
  const result = splitPanelByLine(square, [2, -1], [2, 2], 0.02);
  assert.equal(result, null);
});

test("splitPanelByLine: 退化した直線(始点=終点)は null", () => {
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ];
  const result = splitPanelByLine(square, [0.5, 0.5], [0.5, 0.5], 0.02);
  assert.equal(result, null);
});

test("splitPanelByLine: ガター0なら切断頂点は元の直線上のまま", () => {
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ];
  const result = splitPanelByLine(square, [0.5, -1], [0.5, 2], 0);
  assert.ok(result);
  const { a, b } = result!;
  const aCutXs = a.filter(([x]) => Math.abs(x - 1) > 1e-6).map(([x]) => x);
  const bCutXs = b.filter(([x]) => Math.abs(x - 0) > 1e-6).map(([x]) => x);
  assert.equal(aCutXs.length, 2);
  assert.equal(bCutXs.length, 2);
  for (const x of [...aCutXs, ...bCutXs]) {
    assert.ok(Math.abs(x - 0.5) < 1e-6, `x=${x}`);
  }
});

test("splitPanelByLine: 頂点をちょうど通る直線(頂点上の交点)でも分割できる", () => {
  // 台形: (0,0)-(1,0)-(1,1)-(0.5,1)-(0,1) の5角形で、対角線状に (1,0) と (0.5,1) を通す直線。
  const shape: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0.5, 1],
    [0, 1]
  ];
  const result = splitPanelByLine(shape, [1, 0], [0.5, 1], 0);
  assert.ok(result, "頂点上の交点でも分割できること");
  const { a, b } = result!;
  assert.ok(polygonArea(a) > 0);
  assert.ok(polygonArea(b) > 0);
});
