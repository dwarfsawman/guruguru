import { test } from "node:test";
import assert from "node:assert/strict";
import JSON5 from "json5";
import {
  clampPanelCrop,
  defaultCoverCrop,
  normalizeGuruguruLayout,
  normalizePanelCrop,
  normalizePanelShape,
  normalizeRotation,
  panelBounds,
  panelBoundsSize,
  scaleCropAboutCenter
} from "./pageLayout.ts";

/**
 * 添付の B5 6コマ テンプレート(dwarfsawman/guruguru-layout-template 準拠, 傾いたガター)。
 * 「2枚目画像のように開ける」= この json5 を正規化して6コマが正しく取れること、を pin する。
 */
const SIX_PANEL_JSON5 = `
{
  schemaVersion: '0.2.0',
  metadata: { title: 'B5 Manga Six Panel Template - No Balloons' },
  coordinateSystem: { preset: 'width-relative-top-left' },
  defaults: {
    panel: {
      frame: { visible: true, style: 'solid', strokeWidth: 0.006, strokeColor: '#000000' },
    },
  },
  document: { mode: 'single-page', readingDirection: 'rtl', pageProgression: 'rtl' },
  pages: [
    { id: 'page_1', role: 'single', aspectRatio: [182, 257], width: 1, height: 1.4120879, bounds: [0, 0, 1, 1.4120879] },
  ],
  panels: [
    { id: 'p1_top_right', pageId: 'page_1', order: 1, shape: { type: 'polygon', points: [[0.715, 0.040], [0.960, 0.040], [0.960, 0.455], [0.626, 0.455]] } },
    { id: 'p2_top_left', pageId: 'page_1', order: 2, shape: { type: 'polygon', points: [[0.040, 0.040], [0.700, 0.040], [0.613, 0.455], [0.040, 0.455]] } },
    { id: 'p3_middle_right', pageId: 'page_1', order: 3, shape: { type: 'polygon', points: [[0.458, 0.485], [0.960, 0.485], [0.960, 0.945], [0.450, 0.945]] } },
    { id: 'p4_middle_left', pageId: 'page_1', order: 4, shape: { type: 'polygon', points: [[0.040, 0.485], [0.445, 0.485], [0.438, 0.945], [0.040, 0.945]] } },
    { id: 'p5_bottom_right', pageId: 'page_1', order: 5, shape: { type: 'polygon', points: [[0.688, 0.975], [0.960, 0.975], [0.960, 1.372], [0.688, 1.372]] } },
    { id: 'p6_bottom_left', pageId: 'page_1', order: 6, shape: { type: 'polygon', points: [[0.040, 0.975], [0.675, 0.975], [0.675, 1.372], [0.040, 1.372]] } },
  ],
  balloons: [],
  texts: [],
}
`;

test("normalizeGuruguruLayout: 添付6コマ json5 を正しく正規化する", () => {
  const parsed = JSON5.parse(SIX_PANEL_JSON5);
  const layout = normalizeGuruguruLayout(parsed);

  assert.equal(layout.version, 1);
  assert.equal(layout.panels.length, 6);
  assert.deepEqual(layout.page.aspectRatio, [182, 257]);
  assert.ok(Math.abs(layout.page.height - 1.4120879) < 1e-6);
  assert.equal(layout.readingDirection, "rtl");
  assert.equal(layout.source?.format, "guruguru-layout");
  assert.equal(layout.source?.schemaVersion, "0.2.0");
  assert.equal(layout.source?.title, "B5 Manga Six Panel Template - No Balloons");
});

test("normalizeGuruguruLayout: パネルは order 昇順で points と frame を保持する", () => {
  const layout = normalizeGuruguruLayout(JSON5.parse(SIX_PANEL_JSON5));

  assert.deepEqual(
    layout.panels.map((panel) => panel.id),
    ["p1_top_right", "p2_top_left", "p3_middle_right", "p4_middle_left", "p5_bottom_right", "p6_bottom_left"]
  );
  assert.deepEqual(
    layout.panels.map((panel) => panel.order),
    [1, 2, 3, 4, 5, 6]
  );

  const first = layout.panels[0]!;
  assert.equal(first.shape.type, "polygon");
  assert.deepEqual(
    first.shape.type === "polygon" ? first.shape.points : null,
    [
      [0.715, 0.04],
      [0.96, 0.04],
      [0.96, 0.455],
      [0.626, 0.455]
    ]
  );
  // defaults.panel.frame が各パネルへ継承される。
  assert.equal(first.frame?.strokeWidth, 0.006);
  assert.equal(first.frame?.style, "solid");
});

test("normalizeGuruguruLayout: パネル 0 件はエラー", () => {
  assert.throws(() => normalizeGuruguruLayout({ pages: [{ id: "p", aspectRatio: [2, 3] }], panels: [] }));
});

test("normalizeGuruguruLayout: height 欠損時は aspectRatio から算出する", () => {
  const layout = normalizeGuruguruLayout({
    pages: [{ id: "p", aspectRatio: [2, 3] }],
    panels: [{ id: "a", order: 1, pageId: "p", shape: { type: "rect", bounds: [0, 0, 1, 1] } }]
  });
  assert.ok(Math.abs(layout.page.height - 1.5) < 1e-9);
});

test("normalizePanelShape: 対応形状を厳密に受け、未対応/不正は null", () => {
  assert.deepEqual(normalizePanelShape({ type: "polygon", points: [[0, 0], [1, 0], [1, 1]] }), {
    type: "polygon",
    points: [
      [0, 0],
      [1, 0],
      [1, 1]
    ]
  });
  assert.deepEqual(normalizePanelShape({ type: "rect", bounds: [0, 0, 1, 2], cornerRadius: 0.01 }), {
    type: "rect",
    bounds: [0, 0, 1, 2],
    cornerRadius: 0.01
  });
  assert.deepEqual(normalizePanelShape({ type: "ellipse", center: [0.5, 0.5], radius: [0.2, 0.3] }), {
    type: "ellipse",
    center: [0.5, 0.5],
    radius: [0.2, 0.3]
  });
  assert.deepEqual(normalizePanelShape({ type: "path", d: "M0 0 L1 1 Z" }), { type: "path", d: "M0 0 L1 1 Z" });
  assert.equal(normalizePanelShape({ type: "polygon", points: [[0, "x"]] }), null);
  assert.equal(normalizePanelShape({ type: "star" }), null);
  assert.equal(normalizePanelShape(null), null);
});

// --- コマ内生成(Docs/Feature-PanelGeneration.md)のジオメトリ ---

test("panelBounds: polygon/rect/ellipse の外接矩形", () => {
  assert.deepEqual(
    panelBounds({ type: "polygon", points: [[0.1, 0.2], [0.5, 0.1], [0.4, 0.6]] }),
    [0.1, 0.1, 0.5, 0.6]
  );
  // rect は bounds の順序を問わない(左上/右下どちらの向きでも min/max に正規化)。
  assert.deepEqual(panelBounds({ type: "rect", bounds: [0.8, 0.5, 0.2, 0.1] }), [0.2, 0.1, 0.8, 0.5]);
  assert.deepEqual(
    panelBounds({ type: "ellipse", center: [0.5, 0.5], radius: [0.2, 0.1] }),
    [0.3, 0.4, 0.7, 0.6]
  );
});

test("panelBounds: path は d 中の数値を (x,y) ペアとして拾うベストエフォート", () => {
  assert.deepEqual(panelBounds({ type: "path", d: "M0.1 0.2 L0.9 0.8 Z" }), [0.1, 0.2, 0.9, 0.8]);
  // 数値を1つも拾えない場合は [0,0,1,1] にフォールバックする。
  assert.deepEqual(panelBounds({ type: "path", d: "M Z" }), [0, 0, 1, 1]);
});

test("panelBoundsSize: 幅高さを返し、0除算にならないよう最小値を敷く", () => {
  const [width1, height1] = panelBoundsSize([0.1, 0.2, 0.5, 0.6]);
  assert.ok(Math.abs(width1 - 0.4) < 1e-9);
  assert.ok(Math.abs(height1 - 0.4) < 1e-9);
  const [width, height] = panelBoundsSize([0.3, 0.3, 0.3, 0.3]);
  assert.ok(width > 0 && height > 0);
});

test("defaultCoverCrop: アスペクト比が一致すれば全体表示", () => {
  assert.deepEqual(defaultCoverCrop(1000, 1000, 1, 1), { x: 0, y: 0, width: 1, height: 1, rotation: 0 });
});

test("defaultCoverCrop: 横長画像を正方形コマへ cover フィット(左右がクロップされ中央寄せ)", () => {
  const crop = defaultCoverCrop(2000, 1000, 1, 1);
  assert.ok(Math.abs(crop.width - 0.5) < 1e-9);
  assert.equal(crop.height, 1);
  assert.ok(Math.abs(crop.x - 0.25) < 1e-9);
  assert.equal(crop.y, 0);
});

test("defaultCoverCrop: 縦長画像を正方形コマへ cover フィット(上下がクロップされ中央寄せ)", () => {
  const crop = defaultCoverCrop(1000, 2000, 1, 1);
  assert.equal(crop.width, 1);
  assert.ok(Math.abs(crop.height - 0.5) < 1e-9);
  assert.equal(crop.x, 0);
  assert.ok(Math.abs(crop.y - 0.25) < 1e-9);
});

test("defaultCoverCrop: 不正な入力(0以下)は全体表示にフォールバック", () => {
  assert.deepEqual(defaultCoverCrop(0, 1000, 1, 1), { x: 0, y: 0, width: 1, height: 1, rotation: 0 });
  assert.deepEqual(defaultCoverCrop(1000, 1000, 0, 1), { x: 0, y: 0, width: 1, height: 1, rotation: 0 });
});

test("clampPanelCrop: 範囲内の値はそのまま(rotation は 0 付与)", () => {
  assert.deepEqual(clampPanelCrop({ x: 0.1, y: 0.2, width: 0.5, height: 0.4 }), {
    x: 0.1,
    y: 0.2,
    width: 0.5,
    height: 0.4,
    rotation: 0
  });
});

test("clampPanelCrop: はみ出す offset は width/height を保ったまま境界へ丸める", () => {
  assert.deepEqual(clampPanelCrop({ x: -0.5, y: 2, width: 0.3, height: 0.4 }), {
    x: 0,
    y: 0.6,
    width: 0.3,
    height: 0.4,
    rotation: 0
  });
});

test("clampPanelCrop: width/height は (0,1] へ丸め、不正値(NaN等)は 1 にフォールバック", () => {
  assert.deepEqual(clampPanelCrop({ x: 0, y: 0, width: 1.5, height: 0 }), {
    x: 0,
    y: 0,
    width: 1,
    height: 0.01,
    rotation: 0
  });
  assert.deepEqual(clampPanelCrop({ x: 0, y: 0, width: Number.NaN, height: 0.5 }), {
    x: 0,
    y: 0,
    width: 1,
    height: 0.5,
    rotation: 0
  });
});

test("clampPanelCrop: rotation を保持し (-π, π] へ正規化する", () => {
  const crop = clampPanelCrop({ x: 0, y: 0, width: 1, height: 1, rotation: Math.PI / 4 });
  assert.ok(Math.abs(crop.rotation! - Math.PI / 4) < 1e-9);
  // 2π + π/4 は π/4 へ折り返す。
  const wrapped = clampPanelCrop({ x: 0, y: 0, width: 1, height: 1, rotation: Math.PI * 2 + Math.PI / 4 });
  assert.ok(Math.abs(wrapped.rotation! - Math.PI / 4) < 1e-9);
});

test("normalizeRotation: 角度を (-π, π] へ折り返し、非数は 0", () => {
  assert.equal(normalizeRotation(0), 0);
  assert.ok(Math.abs(normalizeRotation(Math.PI * 2) - 0) < 1e-9);
  assert.ok(Math.abs(normalizeRotation(-Math.PI * 1.5) - Math.PI / 2) < 1e-9);
  assert.equal(normalizeRotation(Number.NaN), 0);
  assert.equal(normalizeRotation("x"), 0);
});

test("scaleCropAboutCenter: 中心固定でズームし、回転を保持、最小サイズでクランプ", () => {
  const zoomed = scaleCropAboutCenter({ x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 0.3 }, 0.5);
  // 中心 (0.5, 0.5) は不変。
  assert.ok(Math.abs(zoomed.x + zoomed.width / 2 - 0.5) < 1e-9);
  assert.ok(Math.abs(zoomed.y + zoomed.height / 2 - 0.5) < 1e-9);
  assert.ok(Math.abs(zoomed.width - 0.25) < 1e-9);
  assert.ok(Math.abs(zoomed.rotation! - 0.3) < 1e-9);
  // これ以上ズームインしても最小サイズ 0.05 で頭打ち。
  const capped = scaleCropAboutCenter({ x: 0.45, y: 0.45, width: 0.1, height: 0.1, rotation: 0 }, 0.01);
  assert.ok(Math.abs(capped.width - 0.05) < 1e-9);
  assert.ok(Math.abs(capped.height - 0.05) < 1e-9);
});

test("scaleCropAboutCenter: 縦横比を必ず保つ(片辺だけ境界に当たって歪まない)", () => {
  // cover(width 0.686, height 1)。height は既に 1 なのでズームアウト不可 → 実効 factor=1 でアスペクト不変。
  const cover = { x: 0.157, y: 0, width: 0.686, height: 1, rotation: 0 };
  const zoomOut = scaleCropAboutCenter(cover, 1.5);
  assert.ok(Math.abs(zoomOut.width / zoomOut.height - 0.686) < 1e-9);
  assert.ok(Math.abs(zoomOut.width - 0.686) < 1e-9);
  assert.ok(Math.abs(zoomOut.height - 1) < 1e-9);
  // ズームイン(factor<1)は両辺同率で縮む → アスペクト不変。
  const zoomIn = scaleCropAboutCenter(cover, 0.5);
  assert.ok(Math.abs(zoomIn.width / zoomIn.height - 0.686) < 1e-9);
  assert.ok(Math.abs(zoomIn.height - 0.5) < 1e-9);
  assert.ok(Math.abs(zoomIn.width - 0.343) < 1e-9);
});

test("normalizePanelCrop: 妥当な値のみ受け付け、それ以外は null", () => {
  assert.deepEqual(normalizePanelCrop({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }), {
    x: 0.1,
    y: 0.1,
    width: 0.5,
    height: 0.5,
    rotation: 0
  });
  // rotation も読み取り、(-π, π] へ正規化する。
  const rotated = normalizePanelCrop({ x: 0.1, y: 0.1, width: 0.5, height: 0.5, rotation: Math.PI / 2 });
  assert.ok(rotated && Math.abs(rotated.rotation! - Math.PI / 2) < 1e-9);
  assert.equal(normalizePanelCrop({ x: 0.1, y: 0.1, width: "x", height: 0.5 }), null);
  assert.equal(normalizePanelCrop({ x: 0.1 }), null);
  assert.equal(normalizePanelCrop(null), null);
  assert.equal(normalizePanelCrop("not an object"), null);
});
