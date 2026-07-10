import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOSAIC_MIN_BLOCK_PX,
  createPolygonMosaicRegion,
  createRectMosaicRegion,
  mosaicBlockSizePx,
  normalizeMosaicRegions,
  regionBoundsPage,
  resizeMosaicRectBounds,
  type MosaicRegion
} from "./mosaicRegion.ts";

// --- mosaicBlockSizePx: 粒度規定の下限 ---

test("mosaicBlockSizePx: 既定(granularity 省略)は max(4, ceil(長辺/100))", () => {
  assert.equal(mosaicBlockSizePx(2048), 21); // ceil(2048/100) = 21
  assert.equal(mosaicBlockSizePx(100), 4); // ceil(100/100)=1 -> 4px 下限が勝つ
  assert.equal(mosaicBlockSizePx(0), MOSAIC_MIN_BLOCK_PX);
});

test("mosaicBlockSizePx: granularity が規定より大きい値なら採用される", () => {
  // 長辺2048 の 10% = 204.8 -> round 205。規定下限(21)より大きいので採用。
  assert.equal(mosaicBlockSizePx(2048, 0.1), 205);
});

test("mosaicBlockSizePx: granularity に極小値(規定を下回る)を渡しても規定の下限で頭打ちになる", () => {
  // 長辺2048 の 0.001 = 2.048 -> round 2。規定下限は21なので21が勝つ(下回れない)。
  assert.equal(mosaicBlockSizePx(2048, 0.001), 21);
  // 長辺100000 でも granularity=0.0001 (10) は規定下限 max(4, 1000)=1000 に負ける。
  assert.equal(mosaicBlockSizePx(100000, 0.0001), 1000);
});

test("mosaicBlockSizePx: 非数/負値の longSidePx は 0 扱いで下限のみ", () => {
  assert.equal(mosaicBlockSizePx(Number.NaN), MOSAIC_MIN_BLOCK_PX);
  assert.equal(mosaicBlockSizePx(-100), MOSAIC_MIN_BLOCK_PX);
});

// --- regionBoundsPage ---

test("regionBoundsPage: rect は [x, y, x+w, y+h]", () => {
  const region = createRectMosaicRegion("r1", 0.2, 0.3, 0.4, 0.1);
  const [minX, minY, maxX, maxY] = regionBoundsPage(region);
  assert.equal(minX, 0.2);
  assert.equal(minY, 0.3);
  assert.ok(Math.abs(maxX - 0.6) < 1e-9);
  assert.equal(maxY, 0.4);
});

test("regionBoundsPage: polygon は頂点群の外接矩形", () => {
  const region = createPolygonMosaicRegion("p1", [
    [0.1, 0.2],
    [0.5, 0.05],
    [0.4, 0.6]
  ]);
  const [minX, minY, maxX, maxY] = regionBoundsPage(region);
  assert.equal(minX, 0.1);
  assert.equal(minY, 0.05);
  assert.equal(maxX, 0.5);
  assert.equal(maxY, 0.6);
});

// --- normalizeMosaicRegions ---

test("normalizeMosaicRegions: 配列以外は空配列", () => {
  assert.deepEqual(normalizeMosaicRegions(null), []);
  assert.deepEqual(normalizeMosaicRegions("not an array"), []);
  assert.deepEqual(normalizeMosaicRegions(undefined), []);
});

test("normalizeMosaicRegions: 正常な rect/polygon はそのまま通る", () => {
  const raw = [
    { id: "a", shape: { type: "rect", bounds: [0.1, 0.1, 0.2, 0.3] } },
    { id: "b", shape: { type: "polygon", points: [[0, 0], [0.3, 0], [0.15, 0.3]] } }
  ];
  const result = normalizeMosaicRegions(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.shape.type, "rect");
  assert.equal(result[1]!.shape.type, "polygon");
});

test("normalizeMosaicRegions: 型崩れ要素(未知 type、頂点3未満の polygon、非正サイズの rect)は黙って捨てる", () => {
  const raw = [
    { id: "good", shape: { type: "rect", bounds: [0, 0, 0.2, 0.2] } },
    { id: "bad-type", shape: { type: "ellipse", center: [0.5, 0.5] } },
    { id: "bad-polygon", shape: { type: "polygon", points: [[0, 0], [0.1, 0.1]] } },
    { id: "bad-rect", shape: { type: "rect", bounds: [0, 0, -1, 0.2] } },
    "not an object",
    { id: "no-shape" }
  ];
  const result = normalizeMosaicRegions(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "good");
});

test("normalizeMosaicRegions: id 重複は _dup サフィックスで一意化する", () => {
  const raw = [
    { id: "dup", shape: { type: "rect", bounds: [0, 0, 0.1, 0.1] } },
    { id: "dup", shape: { type: "rect", bounds: [0.2, 0.2, 0.1, 0.1] } }
  ];
  const result = normalizeMosaicRegions(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.id, "dup");
  assert.equal(result[1]!.id, "dup_dup");
});

test("normalizeMosaicRegions: id 未指定/空文字はフォールバック採番される", () => {
  const raw = [{ shape: { type: "rect", bounds: [0, 0, 0.1, 0.1] } }, { id: "  ", shape: { type: "rect", bounds: [0, 0, 0.1, 0.1] } }];
  const result = normalizeMosaicRegions(raw);
  assert.equal(result[0]!.id, "mosaic_1");
  assert.equal(result[1]!.id, "mosaic_2");
});

test("normalizeMosaicRegions: 上限件数(MOSAIC_REGIONS_MAX_COUNT)を超える分は切り捨てる", () => {
  const raw = Array.from({ length: 150 }, (_, i) => ({
    id: `r${i}`,
    shape: { type: "rect", bounds: [0, 0, 0.01, 0.01] }
  }));
  const result = normalizeMosaicRegions(raw);
  assert.equal(result.length, 100);
});

test("normalizeMosaicRegions: granularity は範囲外なら clamp され、非正/非数なら省略される", () => {
  const raw = [
    { id: "a", shape: { type: "rect", bounds: [0, 0, 0.1, 0.1] }, granularity: 999 },
    { id: "b", shape: { type: "rect", bounds: [0, 0, 0.1, 0.1] }, granularity: -1 },
    { id: "c", shape: { type: "rect", bounds: [0, 0, 0.1, 0.1] }, granularity: "oops" }
  ];
  const result = normalizeMosaicRegions(raw);
  assert.ok(result[0]!.granularity! <= 0.5);
  assert.equal(result[1]!.granularity, undefined);
  assert.equal(result[2]!.granularity, undefined);
});

// --- resizeMosaicRectBounds ---

test("resizeMosaicRectBounds: コーナードラッグは対角を固定して自由リサイズする", () => {
  const bounds: [number, number, number, number] = [0.2, 0.2, 0.3, 0.3]; // x,y,w,h -> right=0.5,bottom=0.5
  // 左上コーナー(0)を (0.1, 0.05) へ動かす -> 右下(0.5,0.5)固定。
  const next = resizeMosaicRectBounds(bounds, { kind: "corner", index: 0 }, [0.1, 0.05]);
  assert.deepEqual(next, [0.1, 0.05, 0.4, 0.45]);
});

test("resizeMosaicRectBounds: 辺ドラッグは対辺を固定して1軸だけ変える", () => {
  const bounds: [number, number, number, number] = [0.2, 0.2, 0.3, 0.3];
  // 上辺(0)を y=0.05 へ -> top のみ変化、left/right/bottom は固定。
  const next = resizeMosaicRectBounds(bounds, { kind: "edge", index: 0 }, [0.35, 0.05]);
  assert.equal(next[0], 0.2); // x 不変
  assert.equal(next[1], 0.05); // y が更新
  assert.equal(next[2], 0.3); // w 不変
  assert.ok(Math.abs(next[3] - 0.45) < 1e-9); // bottom(0.5) - top(0.05)
});

test("resizeMosaicRectBounds: 最小サイズを下回らない", () => {
  const bounds: [number, number, number, number] = [0.2, 0.2, 0.3, 0.3];
  // 左上を右下近くまでドラッグしても幅高さは minSize を下回らない。
  const next = resizeMosaicRectBounds(bounds, { kind: "corner", index: 0 }, [0.49, 0.49], 0.01);
  assert.ok(next[2] >= 0.01 - 1e-9);
  assert.ok(next[3] >= 0.01 - 1e-9);
});

test("createRectMosaicRegion/createPolygonMosaicRegion: 生成ヘルパ", () => {
  const rect: MosaicRegion = createRectMosaicRegion("r", 0, 0, 0.2, 0.3);
  assert.equal(rect.shape.type, "rect");
  const polygon: MosaicRegion = createPolygonMosaicRegion("p", [[0, 0], [1, 0], [0.5, 1]]);
  assert.equal(polygon.shape.type, "polygon");
  if (polygon.shape.type === "polygon") {
    assert.equal(polygon.shape.points.length, 3);
  }
});
