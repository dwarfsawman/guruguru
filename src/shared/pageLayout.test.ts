import { test } from "node:test";
import assert from "node:assert/strict";
import JSON5 from "json5";
import { normalizeGuruguruLayout, normalizePanelShape } from "./pageLayout.ts";

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
