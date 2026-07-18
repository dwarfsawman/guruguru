import assert from "node:assert/strict";
import test from "node:test";
import type { PageLayout } from "./pageLayout.ts";
import {
  detectJunctions,
  detectSharedBoundaries,
  edgeInMarginBand,
  moveBoundaryAlongNormal,
  moveJunction,
  outerEdgeInfo,
  setBoundaryGutter,
  snapEdgeToBleed,
  snapEdgeToMargin,
  toEditableNameLayout,
  translateEdgeAlongNormal,
  validateEditedNameLayout
} from "./nameLayoutEdit.ts";

const HEIGHT = 1.4;
const MARGIN = 0.04;

/** 田の字(2x2)の rect レイアウト。読み順は rtl(右上→左上→右下→左下)。 */
function fourGrid(): PageLayout {
  const midX = 0.5;
  const midY = 0.7;
  const g = 0.01; // ガター半幅(=ガター0.02)
  const rect = (id: string, order: number, x0: number, y0: number, x1: number, y1: number) => ({
    id,
    order,
    shape: { type: "rect" as const, bounds: [x0, y0, x1, y1] as [number, number, number, number] }
  });
  return {
    version: 1,
    page: { aspectRatio: [1, HEIGHT], height: HEIGHT },
    readingDirection: "rtl",
    panels: [
      rect("tr", 1, midX + g, MARGIN, 1 - MARGIN, midY - g),
      rect("tl", 2, MARGIN, MARGIN, midX - g, midY - g),
      rect("br", 3, midX + g, midY + g, 1 - MARGIN, HEIGHT - MARGIN),
      rect("bl", 4, MARGIN, midY + g, midX - g, HEIGHT - MARGIN)
    ]
  };
}

function panelPoints(layout: PageLayout, id: string): [number, number][] {
  const panel = layout.panels.find((entry) => entry.id === id);
  assert.ok(panel && panel.shape.type === "polygon");
  return panel.shape.points;
}

function boundsOf(layout: PageLayout, id: string): [number, number, number, number] {
  const points = panelPoints(layout, id);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

test("toEditableNameLayout polygonizes rect panels and keeps ids/order", () => {
  const editable = toEditableNameLayout(fourGrid());
  assert.equal(editable.panels.length, 4);
  for (const panel of editable.panels) {
    assert.equal(panel.shape.type, "polygon");
    assert.equal((panel.shape as { points: unknown[] }).points.length, 4);
  }
  assert.deepEqual(editable.panels.map((panel) => panel.id), ["tr", "tl", "br", "bl"]);
});

test("detectSharedBoundaries finds four gutter segments in a 2x2 grid", () => {
  const editable = toEditableNameLayout(fourGrid());
  const boundaries = detectSharedBoundaries(editable);
  assert.equal(boundaries.length, 4);
  for (const boundary of boundaries) {
    assert.equal(boundary.edges.length, 2);
    assert.ok(Math.abs(boundary.gutterWidth - 0.02) < 1e-6, `gutter ${boundary.gutterWidth}`);
    const panels = new Set(boundary.edges.map((entry) => entry.ref.panelIndex));
    assert.equal(panels.size, 2);
  }
});

test("moveBoundaryAlongNormal moves both adjacent panels' edges together", () => {
  const editable = toEditableNameLayout(fourGrid());
  const boundaries = detectSharedBoundaries(editable);
  // 上段の縦ガター(tr/tl 間): 法線が x 軸方向のもので、tr と tl の辺を含むもの。
  const vertical = boundaries.find(
    (boundary) =>
      Math.abs(boundary.normal[0]) > 0.9 &&
      boundary.edges.every((entry) => ["tr", "tl"].includes(editable.panels[entry.ref.panelIndex]!.id))
  );
  assert.ok(vertical, "vertical boundary between tr and tl exists");
  const offset = 0.05 * Math.sign(vertical.normal[0]); // +x へ 0.05
  const moved = moveBoundaryAlongNormal(editable, vertical, offset);
  const tl = boundsOf(moved, "tl");
  const tr = boundsOf(moved, "tr");
  assert.ok(Math.abs(tl[2] - 0.54) < 1e-9, `tl right ${tl[2]}`);
  assert.ok(Math.abs(tr[0] - 0.56) < 1e-9, `tr left ${tr[0]}`);
  // 下段は動かない。
  const br = boundsOf(moved, "br");
  assert.ok(Math.abs(br[0] - 0.51) < 1e-9);
  // ガター幅は保たれる。
  const after = detectSharedBoundaries(moved).find((boundary) =>
    boundary.edges.every((entry) => ["tr", "tl"].includes(moved.panels[entry.ref.panelIndex]!.id))
  );
  assert.ok(after && Math.abs(after.gutterWidth - 0.02) < 1e-6);
});

test("setBoundaryGutter closes the gap symmetrically with a fixed centerline", () => {
  const editable = toEditableNameLayout(fourGrid());
  const boundaries = detectSharedBoundaries(editable);
  const vertical = boundaries.find(
    (boundary) =>
      Math.abs(boundary.normal[0]) > 0.9 &&
      boundary.edges.every((entry) => ["tr", "tl"].includes(editable.panels[entry.ref.panelIndex]!.id))
  );
  assert.ok(vertical);
  const closed = setBoundaryGutter(editable, vertical, 0);
  assert.ok(Math.abs(boundsOf(closed, "tl")[2] - 0.5) < 1e-9);
  assert.ok(Math.abs(boundsOf(closed, "tr")[0] - 0.5) < 1e-9);
  const widened = setBoundaryGutter(editable, vertical, 0.06);
  assert.ok(Math.abs(boundsOf(widened, "tl")[2] - 0.47) < 1e-9);
  assert.ok(Math.abs(boundsOf(widened, "tr")[0] - 0.53) < 1e-9);
  // 負値は 0 へ丸める(コマ同士は重ならない)。
  const clamped = setBoundaryGutter(editable, vertical, -0.5);
  assert.ok(boundsOf(clamped, "tr")[0] - boundsOf(clamped, "tl")[2] >= -1e-9);
});

test("detectJunctions finds the 4-corner crossing and moveJunction drags all corners", () => {
  const editable = toEditableNameLayout(fourGrid());
  const junctions = detectJunctions(editable);
  const center = junctions.find((junction) => junction.vertices.length === 4);
  assert.ok(center, `center junction exists (${junctions.map((j) => j.vertices.length).join(",")})`);
  assert.ok(Math.abs(center.position[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(center.position[1] - 0.7) < 1e-6);
  assert.equal(new Set(center.vertices.map((v) => v.panelIndex)).size, 4);

  const moved = moveJunction(editable, center, [0.08, -0.05]);
  const hasVertex = (id: string, x: number, y: number) =>
    panelPoints(moved, id).some(([px, py]) => Math.abs(px - x) < 1e-9 && Math.abs(py - y) < 1e-9);
  assert.ok(hasVertex("tl", 0.57, 0.64), "tl corner follows");
  assert.ok(hasVertex("tr", 0.59, 0.64), "tr corner follows");
  assert.ok(hasVertex("bl", 0.57, 0.66), "bl corner follows");
  assert.ok(hasVertex("br", 0.59, 0.66), "br corner follows");
  // 外周の角は動かない。
  assert.ok(Math.abs(boundsOf(moved, "tl")[0] - MARGIN) < 1e-9);
  assert.ok(Math.abs(boundsOf(moved, "tr")[2] - (1 - MARGIN)) < 1e-9);
});

test("translateEdgeAlongNormal moves a single edge without touching neighbours", () => {
  const editable = toEditableNameLayout(fourGrid());
  // tr(パネル0)の下辺を探す: 2頂点とも y=0.69。
  const points = panelPoints(editable, "tr");
  const edgeIndex = points.findIndex((point, index) => {
    const next = points[(index + 1) % points.length]!;
    return Math.abs(point[1] - 0.69) < 1e-9 && Math.abs(next[1] - 0.69) < 1e-9;
  });
  assert.ok(edgeIndex >= 0);
  const moved = translateEdgeAlongNormal(editable, { panelIndex: 0, edgeIndex }, 0.03);
  assert.ok(Math.abs(boundsOf(moved, "tr")[3] - 0.72) < 1e-9);
  assert.ok(Math.abs(boundsOf(moved, "br")[1] - 0.71) < 1e-9, "adjacent panel stays");
});

test("outer edge classification, margin band detection, bleed snap and margin restore", () => {
  const editable = toEditableNameLayout(fourGrid());
  const boundaries = detectSharedBoundaries(editable);
  const points = panelPoints(editable, "tr");
  const rightEdgeIndex = points.findIndex((point, index) => {
    const next = points[(index + 1) % points.length]!;
    return Math.abs(point[0] - (1 - MARGIN)) < 1e-9 && Math.abs(next[0] - (1 - MARGIN)) < 1e-9;
  });
  assert.ok(rightEdgeIndex >= 0);
  const ref = { panelIndex: 0, edgeIndex: rightEdgeIndex };
  const info = outerEdgeInfo(editable, ref, boundaries);
  assert.deepEqual(info, { isOuter: true, side: "right" });
  assert.equal(edgeInMarginBand(editable, ref, "right"), false);

  const dragged = translateEdgeAlongNormal(editable, ref, 0.02); // 0.96 → 0.98(余白帯)
  assert.equal(edgeInMarginBand(dragged, ref, "right"), true);

  const bled = snapEdgeToBleed(dragged, ref, "right");
  assert.ok(Math.abs(boundsOf(bled, "tr")[2] - 1.015) < 1e-9);
  const validation = validateEditedNameLayout(bled, editable);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));

  const restored = snapEdgeToMargin(bled, ref, "right");
  assert.ok(Math.abs(boundsOf(restored, "tr")[2] - (1 - MARGIN)) < 1e-9);

  // 共有境界の辺は外周にならない。
  const innerEdgeIndex = points.findIndex((point, index) => {
    const next = points[(index + 1) % points.length]!;
    return Math.abs(point[0] - 0.51) < 1e-9 && Math.abs(next[0] - 0.51) < 1e-9;
  });
  assert.ok(innerEdgeIndex >= 0);
  assert.equal(outerEdgeInfo(editable, { panelIndex: 0, edgeIndex: innerEdgeIndex }, boundaries).isOuter, false);
});

test("outer edge bleed is restricted to page-edge-parallel (axis-aligned) edges", () => {
  const editable = toEditableNameLayout(fourGrid());
  // tr の右辺を明確な斜めに崩す(上端を内側へ 0.25 ずらす ≈ 21度 → 軸整合 <0.98)。
  const points = panelPoints(editable, "tr");
  const topRight = points.findIndex(([x, y]) => Math.abs(x - (1 - MARGIN)) < 1e-9 && Math.abs(y - MARGIN) < 1e-9);
  assert.ok(topRight >= 0);
  points[topRight] = [1 - MARGIN - 0.25, MARGIN];
  const boundaries = detectSharedBoundaries(editable);
  const slantedEdgeIndex = points.findIndex((point, index) => {
    const next = points[(index + 1) % points.length]!;
    // 右辺: 両端の x が右側にあり、y 方向に伸びる辺。
    return point[0] > 0.6 && next[0] > 0.6 && Math.abs(point[1] - next[1]) > 0.1;
  });
  assert.ok(slantedEdgeIndex >= 0);
  const info = outerEdgeInfo(editable, { panelIndex: 0, edgeIndex: slantedEdgeIndex }, boundaries);
  assert.equal(info.isOuter, false, "斜め辺は裁ち切り対象にしない");
});

test("validateEditedNameLayout rejects panel count change, tiny panels and reading-order flips", () => {
  const base = toEditableNameLayout(fourGrid());

  const dropped = { ...base, panels: base.panels.slice(0, 3) };
  assert.equal(validateEditedNameLayout(dropped, base).ok, false);
  assert.equal(validateEditedNameLayout(dropped, base).issues[0]!.code, "panel-count");

  const tiny = toEditableNameLayout(fourGrid());
  const panel = tiny.panels[0]!;
  assert.ok(panel.shape.type === "polygon");
  panel.shape.points = [[0.5, 0.5], [0.51, 0.5], [0.51, 0.51], [0.5, 0.51]];
  const tinyResult = validateEditedNameLayout(tiny, base);
  assert.equal(tinyResult.ok, false);
  assert.ok(tinyResult.issues.some((issue) => issue.code === "min-area"));

  // tr と tl の幾何を入れ替える → 読み順が変わる。
  const swapped = toEditableNameLayout(fourGrid());
  const trPanel = swapped.panels[0]!;
  const tlPanel = swapped.panels[1]!;
  const trShape = trPanel.shape;
  trPanel.shape = tlPanel.shape;
  tlPanel.shape = trShape;
  const swappedResult = validateEditedNameLayout(swapped, base);
  assert.equal(swappedResult.ok, false);
  assert.ok(swappedResult.issues.some((issue) => issue.code === "reading-order"));

  // はみ出し超過。
  const overshoot = toEditableNameLayout(fourGrid());
  const overshootPanel = overshoot.panels[0]!;
  assert.ok(overshootPanel.shape.type === "polygon");
  overshootPanel.shape.points = overshootPanel.shape.points.map(([x, y]) => [x + 0.2, y]);
  const overshootResult = validateEditedNameLayout(overshoot, base);
  assert.equal(overshootResult.ok, false);
  assert.ok(overshootResult.issues.some((issue) => issue.code === "out-of-bounds" || issue.code === "reading-order"));
});
