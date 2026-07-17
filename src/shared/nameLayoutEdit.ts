/**
 * 人間ゲート(ネームスタジオ)のコマ割りジオメトリ編集の純ロジック。
 *
 * スタジオでは候補の基礎プランは不変のまま、ページ単位の「カスタムレイアウト」を
 * layout override の別レイヤーとして編集する(Docs/Feature-NameGateLayoutEdit.md)。
 * このモジュールは DOM・state 非依存で、クライアントの編集UIとサーバーの保存時検証の両方から使う。
 *
 * 提供する操作:
 * - 共有辺(ガター境界)の検出と法線方向の移動(隣接コマ両側が追随する)
 * - ガター幅そのものの変更(境界の中心線を保ち両側を対称に詰め/広げ)
 * - 交差点(複数コマの角が集まるジャンクション)の検出と一括移動
 * - 単一辺の法線方向平行移動 / 頂点移動 / 辺中点への頂点追加(panelShapeEdit.ts を再利用)
 * - 外周辺の裁ち切り(bleed)スナップ
 * - 編集結果の検証(コマ数・id・読み順の不変、bleed 上限、最小面積)
 *
 * 座標系は PageLayout と同じ width-relative-top-left(x∈[0,1]、y∈[0,page.height])。
 */
import { orderPanelsByReadingDirection } from "./dialogueAutoLayout";
import { LAYOUT_PAGE_MARGIN, LAYOUT_PANEL_BLEED } from "./layoutPresets";
import {
  PANEL_BLEED_OVERSHOOT,
  clonePageLayout,
  panelBounds,
  type PageLayout
} from "./pageLayout";
import { panelShapeToPolygon, polygonArea } from "./panelShapeEdit";

const EPS = 1e-9;

/** 平行判定の許容(単位ベクトル同士の外積の絶対値)。約3度。 */
const PARALLEL_SIN_TOLERANCE = 0.06;
/** 共有辺とみなすガター距離の上限(page-width 単位)。 */
const MAX_SHARED_BOUNDARY_GAP = 0.08;
/** 共有辺とみなすための、辺方向への投影の最小重なり長。 */
const MIN_EDGE_OVERLAP = 0.015;
/** 交差点クラスタリングの距離しきい値(ガター 0.02 の対角 ≈0.028 を拾える値)。 */
const JUNCTION_CLUSTER_DISTANCE = 0.04;
/** 編集後に許容する最小コマ面積(page-width^2 単位)。 */
const MIN_PANEL_AREA = 0.003;

/** 頂点座標の可動範囲(裁ち切り分だけページ外を許す)。 */
function clampVertex(x: number, y: number, pageHeight: number): [number, number] {
  return [
    Math.min(1 + LAYOUT_PANEL_BLEED, Math.max(-LAYOUT_PANEL_BLEED, x)),
    Math.min(pageHeight + LAYOUT_PANEL_BLEED, Math.max(-LAYOUT_PANEL_BLEED, y))
  ];
}

export interface LayoutEdgeRef {
  panelIndex: number;
  edgeIndex: number;
}

export interface LayoutVertexRef {
  panelIndex: number;
  vertexIndex: number;
}

export interface BoundaryEdge {
  ref: LayoutEdgeRef;
  /** 境界中心線に対しどちら側か(+1 = normal 方向)。 */
  side: 1 | -1;
}

/** 隣接コマ間の共有境界(ガターを挟んだ平行対向辺のグループ)。 */
export interface SharedBoundary {
  /** メンバー辺から決まる安定 id(再検出しても同じ辺集合なら同じ id)。 */
  id: string;
  edges: BoundaryEdge[];
  /** 境界の単位法線。side=+1 の辺は centerline から +normal 側にある。 */
  normal: [number, number];
  /** 描画用: 境界中心線の線分。 */
  start: [number, number];
  end: [number, number];
  center: [number, number];
  /** 両側の辺の平均距離(ガター幅、0 以上)。 */
  gutterWidth: number;
}

/** 複数コマの角が集まる交差点(ジャンクション)。 */
export interface LayoutJunction {
  id: string;
  position: [number, number];
  vertices: LayoutVertexRef[];
}

interface EdgeGeometry {
  ref: LayoutEdgeRef;
  a: [number, number];
  b: [number, number];
  dir: [number, number];
  /** コマ重心から見て外向きの単位法線。 */
  outward: [number, number];
  mid: [number, number];
  length: number;
}

function polygonOf(layout: PageLayout, panelIndex: number): [number, number][] | null {
  const panel = layout.panels[panelIndex];
  if (!panel || panel.shape.type !== "polygon") return null;
  return panel.shape.points;
}

function polygonCentroid(points: readonly [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of points) {
    x += px;
    y += py;
  }
  const n = Math.max(1, points.length);
  return [x / n, y / n];
}

function edgeGeometry(layout: PageLayout, ref: LayoutEdgeRef): EdgeGeometry | null {
  const points = polygonOf(layout, ref.panelIndex);
  if (!points || points.length < 3) return null;
  const a = points[ref.edgeIndex % points.length];
  const b = points[(ref.edgeIndex + 1) % points.length];
  if (!a || !b) return null;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length <= EPS) return null;
  const dir: [number, number] = [dx / length, dy / length];
  const centroid = polygonCentroid(points);
  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let outward: [number, number] = [dir[1], -dir[0]];
  if (outward[0] * (mid[0] - centroid[0]) + outward[1] * (mid[1] - centroid[1]) < 0) {
    outward = [-outward[0], -outward[1]];
  }
  return { ref, a: [a[0], a[1]], b: [b[0], b[1]], dir, outward, mid, length };
}

function allEdgeGeometries(layout: PageLayout): EdgeGeometry[] {
  const edges: EdgeGeometry[] = [];
  layout.panels.forEach((panel, panelIndex) => {
    if (panel.shape.type !== "polygon") return;
    const count = panel.shape.points.length;
    for (let edgeIndex = 0; edgeIndex < count; edgeIndex += 1) {
      const geometry = edgeGeometry(layout, { panelIndex, edgeIndex });
      if (geometry) edges.push(geometry);
    }
  });
  return edges;
}

/**
 * 編集セッション開始時にレイアウトを編集可能な形へ正規化する。
 * rect/ellipse は polygon 化し、path は外接矩形の polygon で近似する(id/order/frame/role は保持)。
 */
export function toEditableNameLayout(layout: PageLayout): PageLayout {
  const clone = clonePageLayout(layout);
  clone.panels = clone.panels.map((panel) => {
    if (panel.shape.type === "polygon") return panel;
    const points = panelShapeToPolygon(panel.shape);
    if (points) return { ...panel, shape: { type: "polygon", points } };
    const [x0, y0, x1, y1] = panelBounds(panel.shape);
    return { ...panel, shape: { type: "polygon", points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] } };
  });
  return clone;
}

class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root]!;
    let cursor = index;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor]!;
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function edgeRefKey(ref: LayoutEdgeRef): string {
  return `p${ref.panelIndex}e${ref.edgeIndex}`;
}

/**
 * 隣接コマの共有境界を検出する。別コマの辺同士が「ほぼ平行・互いの外向き側・ガター距離以内・
 * 辺方向への投影が重なる」ときにペアとし、推移的にグループ化する。
 * 縦一直線のガターでも途中に横ガターが交差して投影が重ならない区間は別グループになる
 * (=ドラッグはその区間の隣接コマだけを動かす)。
 */
export function detectSharedBoundaries(
  layout: PageLayout,
  options: { maxGap?: number } = {}
): SharedBoundary[] {
  const maxGap = options.maxGap ?? MAX_SHARED_BOUNDARY_GAP;
  const edges = allEdgeGeometries(layout);
  const uf = new UnionFind(edges.length);
  const paired = new Set<number>();

  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const ea = edges[i]!;
      const eb = edges[j]!;
      if (ea.ref.panelIndex === eb.ref.panelIndex) continue;
      const cross = Math.abs(ea.dir[0] * eb.dir[1] - ea.dir[1] * eb.dir[0]);
      if (cross > PARALLEL_SIN_TOLERANCE) continue;
      // 互いの外向き側にあること(コマ内部方向の辺を誤ってペアにしない)。
      const abx = eb.mid[0] - ea.mid[0];
      const aby = eb.mid[1] - ea.mid[1];
      const gapA = abx * ea.outward[0] + aby * ea.outward[1];
      const gapB = -(abx * eb.outward[0] + aby * eb.outward[1]);
      if (gapA < -EPS || gapB < -EPS) continue;
      if (gapA > maxGap || gapB > maxGap) continue;
      // 辺方向への投影の重なり。
      const project = (p: readonly [number, number]) => (p[0] - ea.a[0]) * ea.dir[0] + (p[1] - ea.a[1]) * ea.dir[1];
      const a0 = Math.min(project(ea.a), project(ea.b));
      const a1 = Math.max(project(ea.a), project(ea.b));
      const b0 = Math.min(project(eb.a), project(eb.b));
      const b1 = Math.max(project(eb.a), project(eb.b));
      const overlap = Math.min(a1, b1) - Math.max(a0, b0);
      if (overlap < MIN_EDGE_OVERLAP) continue;
      uf.union(i, j);
      paired.add(i);
      paired.add(j);
    }
  }

  const groups = new Map<number, number[]>();
  for (const index of paired) {
    const root = uf.find(index);
    const list = groups.get(root) ?? [];
    list.push(index);
    groups.set(root, list);
  }

  const boundaries: SharedBoundary[] = [];
  for (const memberIndexes of groups.values()) {
    const members = memberIndexes.map((index) => edges[index]!);
    if (members.length < 2) continue;
    const reference = members.reduce((best, entry) => (entry.length > best.length ? entry : best));
    const dir = reference.dir;
    const normal: [number, number] = [dir[1], -dir[0]];
    // 全メンバーの重み付き重心を基準に、法線方向オフセットで両側へ分ける。
    let totalLength = 0;
    let cx = 0;
    let cy = 0;
    for (const member of members) {
      totalLength += member.length;
      cx += member.mid[0] * member.length;
      cy += member.mid[1] * member.length;
    }
    cx /= Math.max(EPS, totalLength);
    cy /= Math.max(EPS, totalLength);
    const offsetOf = (point: readonly [number, number]) => (point[0] - cx) * normal[0] + (point[1] - cy) * normal[1];
    const sides = members.map((member) => (offsetOf(member.mid) >= 0 ? 1 : -1) as 1 | -1);
    const positive = members.filter((_, index) => sides[index] === 1);
    const negative = members.filter((_, index) => sides[index] === -1);
    if (positive.length === 0 || negative.length === 0) continue;
    const meanOffset = (list: EdgeGeometry[]) => {
      let weight = 0;
      let sum = 0;
      for (const entry of list) {
        weight += entry.length;
        sum += offsetOf(entry.mid) * entry.length;
      }
      return sum / Math.max(EPS, weight);
    };
    const offsetPositive = meanOffset(positive);
    const offsetNegative = meanOffset(negative);
    const centerOffset = (offsetPositive + offsetNegative) / 2;
    const gutterWidth = Math.max(0, offsetPositive - offsetNegative);
    const lineCx = cx + normal[0] * centerOffset;
    const lineCy = cy + normal[1] * centerOffset;
    // 中心線分の描画範囲: 全端点の dir 方向投影の min/max。
    let tMin = Number.POSITIVE_INFINITY;
    let tMax = Number.NEGATIVE_INFINITY;
    for (const member of members) {
      for (const point of [member.a, member.b]) {
        const t = (point[0] - lineCx) * dir[0] + (point[1] - lineCy) * dir[1];
        tMin = Math.min(tMin, t);
        tMax = Math.max(tMax, t);
      }
    }
    const edgesOut: BoundaryEdge[] = members.map((member, index) => ({ ref: member.ref, side: sides[index]! }));
    edgesOut.sort((a, b) => a.ref.panelIndex - b.ref.panelIndex || a.ref.edgeIndex - b.ref.edgeIndex);
    boundaries.push({
      id: edgesOut.map((entry) => edgeRefKey(entry.ref)).join("|"),
      edges: edgesOut,
      normal,
      start: [lineCx + dir[0] * tMin, lineCy + dir[1] * tMin],
      end: [lineCx + dir[0] * tMax, lineCy + dir[1] * tMax],
      center: [lineCx + dir[0] * ((tMin + tMax) / 2), lineCy + dir[1] * ((tMin + tMax) / 2)],
      gutterWidth
    });
  }
  boundaries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return boundaries;
}

/** 指定頂点集合へ同じ移動量を適用した新しいレイアウトを返す(可動範囲へ clamp)。 */
export function movePanelVertices(
  layout: PageLayout,
  vertices: readonly LayoutVertexRef[],
  delta: readonly [number, number]
): PageLayout {
  const clone = clonePageLayout(layout);
  for (const ref of vertices) {
    const panel = clone.panels[ref.panelIndex];
    if (!panel || panel.shape.type !== "polygon") continue;
    const point = panel.shape.points[ref.vertexIndex];
    if (!point) continue;
    const [x, y] = clampVertex(point[0] + delta[0], point[1] + delta[1], clone.page.height);
    panel.shape.points[ref.vertexIndex] = [x, y];
  }
  return clone;
}

function uniqueVertexRefs(layout: PageLayout, edges: readonly LayoutEdgeRef[]): LayoutVertexRef[] {
  const seen = new Set<string>();
  const refs: LayoutVertexRef[] = [];
  for (const edge of edges) {
    const points = polygonOf(layout, edge.panelIndex);
    if (!points) continue;
    const count = points.length;
    for (const vertexIndex of [edge.edgeIndex % count, (edge.edgeIndex + 1) % count]) {
      const key = `p${edge.panelIndex}v${vertexIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ panelIndex: edge.panelIndex, vertexIndex });
    }
  }
  return refs;
}

/** 共有境界を法線方向へ offset だけ移動する(両側のコマの辺が一緒に動く)。 */
export function moveBoundaryAlongNormal(layout: PageLayout, boundary: SharedBoundary, offset: number): PageLayout {
  if (!Number.isFinite(offset) || Math.abs(offset) <= EPS) return clonePageLayout(layout);
  const vertices = uniqueVertexRefs(layout, boundary.edges.map((entry) => entry.ref));
  return movePanelVertices(layout, vertices, [boundary.normal[0] * offset, boundary.normal[1] * offset]);
}

/**
 * 共有境界のガター幅を newGutter へ変更する。中心線は動かさず、両側の辺を対称に動かす
 * (newGutter=0 で完全に詰まる)。負値は 0 に丸める。
 */
export function setBoundaryGutter(layout: PageLayout, boundary: SharedBoundary, newGutter: number): PageLayout {
  const target = Math.max(0, Number.isFinite(newGutter) ? newGutter : boundary.gutterWidth);
  const half = (target - boundary.gutterWidth) / 2;
  if (Math.abs(half) <= EPS) return clonePageLayout(layout);
  let result = clonePageLayout(layout);
  for (const side of [1, -1] as const) {
    const refs = boundary.edges.filter((entry) => entry.side === side).map((entry) => entry.ref);
    const vertices = uniqueVertexRefs(result, refs);
    result = movePanelVertices(result, vertices, [
      boundary.normal[0] * half * side,
      boundary.normal[1] * half * side
    ]);
  }
  return result;
}

/** 辺の外向き単位法線(UIがポインタ移動を法線方向オフセットへ射影するために使う)。 */
export function edgeOutwardNormal(layout: PageLayout, ref: LayoutEdgeRef): [number, number] | null {
  return edgeGeometry(layout, ref)?.outward ?? null;
}

/** 単一辺を法線方向へ offset だけ平行移動する(外向き正)。 */
export function translateEdgeAlongNormal(layout: PageLayout, ref: LayoutEdgeRef, offset: number): PageLayout {
  const geometry = edgeGeometry(layout, ref);
  if (!geometry || !Number.isFinite(offset) || Math.abs(offset) <= EPS) return clonePageLayout(layout);
  const vertices = uniqueVertexRefs(layout, [ref]);
  return movePanelVertices(layout, vertices, [geometry.outward[0] * offset, geometry.outward[1] * offset]);
}

/**
 * 交差点(複数コマの角が近接するクラスタ)を検出する。2コマ以上の頂点が
 * `JUNCTION_CLUSTER_DISTANCE` 以内で連結し、かつ「3頂点以上」または「ページ内部」
 * (外周余白帯の外)にあるものだけを返す。
 */
export function detectJunctions(layout: PageLayout): LayoutJunction[] {
  interface Entry {
    ref: LayoutVertexRef;
    point: [number, number];
  }
  const entries: Entry[] = [];
  layout.panels.forEach((panel, panelIndex) => {
    if (panel.shape.type !== "polygon") return;
    panel.shape.points.forEach((point, vertexIndex) => {
      entries.push({ ref: { panelIndex, vertexIndex }, point: [point[0], point[1]] });
    });
  });
  const uf = new UnionFind(entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]!;
      const b = entries[j]!;
      if (Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1]) <= JUNCTION_CLUSTER_DISTANCE) {
        uf.union(i, j);
      }
    }
  }
  const clusters = new Map<number, Entry[]>();
  entries.forEach((entry, index) => {
    const root = uf.find(index);
    const list = clusters.get(root) ?? [];
    list.push(entry);
    clusters.set(root, list);
  });

  const junctions: LayoutJunction[] = [];
  const margin = LAYOUT_PAGE_MARGIN;
  for (const cluster of clusters.values()) {
    const panels = new Set(cluster.map((entry) => entry.ref.panelIndex));
    if (panels.size < 2) continue;
    let cx = 0;
    let cy = 0;
    for (const entry of cluster) {
      cx += entry.point[0];
      cy += entry.point[1];
    }
    cx /= cluster.length;
    cy /= cluster.length;
    // 2頂点だけのクラスタは、外周余白帯(境界ハンドルの端)にあるものをノイズとして除く。
    const band = margin * 1.5;
    const interior = cx > band && cx < 1 - band && cy > band && cy < layout.page.height - band;
    if (cluster.length < 3 && !interior) continue;
    const refs = cluster.map((entry) => entry.ref);
    refs.sort((a, b) => a.panelIndex - b.panelIndex || a.vertexIndex - b.vertexIndex);
    junctions.push({
      id: refs.map((ref) => `p${ref.panelIndex}v${ref.vertexIndex}`).join("|"),
      position: [cx, cy],
      vertices: refs
    });
  }
  junctions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return junctions;
}

/** 交差点の全頂点を delta だけ一括移動する。 */
export function moveJunction(layout: PageLayout, junction: LayoutJunction, delta: readonly [number, number]): PageLayout {
  return movePanelVertices(layout, junction.vertices, delta);
}

export type PageSide = "left" | "right" | "top" | "bottom";

export interface OuterEdgeInfo {
  isOuter: boolean;
  side: PageSide | null;
}

/**
 * 外周辺かどうかの判定。共有境界に属さず、外向き法線の主軸成分が明確な辺を外周とみなす。
 * `boundaries` は同じレイアウトで検出済みのものを渡す(呼び出し毎の再検出を避ける)。
 */
export function outerEdgeInfo(
  layout: PageLayout,
  ref: LayoutEdgeRef,
  boundaries: readonly SharedBoundary[]
): OuterEdgeInfo {
  const geometry = edgeGeometry(layout, ref);
  if (!geometry) return { isOuter: false, side: null };
  const inBoundary = boundaries.some((boundary) =>
    boundary.edges.some((entry) => entry.ref.panelIndex === ref.panelIndex && entry.ref.edgeIndex === ref.edgeIndex)
  );
  if (inBoundary) return { isOuter: false, side: null };
  const [nx, ny] = geometry.outward;
  if (Math.abs(nx) < 0.5 && Math.abs(ny) < 0.5) return { isOuter: false, side: null };
  const side: PageSide = Math.abs(nx) >= Math.abs(ny) ? (nx > 0 ? "right" : "left") : (ny > 0 ? "bottom" : "top");
  return { isOuter: true, side };
}

/** 辺が外周余白帯(MARGIN の内側境界より外)へ入っているか。裁ち切りプレビューのトリガー判定。 */
export function edgeInMarginBand(layout: PageLayout, ref: LayoutEdgeRef, side: PageSide): boolean {
  const geometry = edgeGeometry(layout, ref);
  if (!geometry) return false;
  const margin = LAYOUT_PAGE_MARGIN;
  const height = layout.page.height;
  const coords = [geometry.a, geometry.b];
  switch (side) {
    case "left":
      return coords.some(([x]) => x < margin - EPS);
    case "right":
      return coords.some(([x]) => x > 1 - margin + EPS);
    case "top":
      return coords.some(([, y]) => y < margin - EPS);
    case "bottom":
      return coords.some(([, y]) => y > height - margin + EPS);
  }
}

/**
 * 外周辺を裁ち切り位置へスナップする。対象辺の両端点の主軸座標をページ外
 * `LAYOUT_PANEL_BLEED` へ揃える(プリセットの裁ち切り規約と同じ)。
 */
export function snapEdgeToBleed(layout: PageLayout, ref: LayoutEdgeRef, side: PageSide): PageLayout {
  const clone = clonePageLayout(layout);
  const panel = clone.panels[ref.panelIndex];
  if (!panel || panel.shape.type !== "polygon") return clone;
  const points = panel.shape.points;
  const count = points.length;
  const height = clone.page.height;
  for (const vertexIndex of [ref.edgeIndex % count, (ref.edgeIndex + 1) % count]) {
    const point = points[vertexIndex];
    if (!point) continue;
    if (side === "left") point[0] = -LAYOUT_PANEL_BLEED;
    else if (side === "right") point[0] = 1 + LAYOUT_PANEL_BLEED;
    else if (side === "top") point[1] = -LAYOUT_PANEL_BLEED;
    else point[1] = height + LAYOUT_PANEL_BLEED;
  }
  return clone;
}

/** 外周辺を余白(MARGIN)位置へ戻す。裁ち切り解除用。 */
export function snapEdgeToMargin(layout: PageLayout, ref: LayoutEdgeRef, side: PageSide): PageLayout {
  const clone = clonePageLayout(layout);
  const panel = clone.panels[ref.panelIndex];
  if (!panel || panel.shape.type !== "polygon") return clone;
  const points = panel.shape.points;
  const count = points.length;
  const height = clone.page.height;
  const margin = LAYOUT_PAGE_MARGIN;
  for (const vertexIndex of [ref.edgeIndex % count, (ref.edgeIndex + 1) % count]) {
    const point = points[vertexIndex];
    if (!point) continue;
    if (side === "left") point[0] = margin;
    else if (side === "right") point[0] = 1 - margin;
    else if (side === "top") point[1] = margin;
    else point[1] = height - margin;
  }
  return clone;
}

export interface NameLayoutValidationIssue {
  code:
    | "panel-count"
    | "panel-id"
    | "panel-order"
    | "invalid-shape"
    | "out-of-bounds"
    | "min-area"
    | "reading-order";
  message: string;
  panelId?: string;
}

export interface NameLayoutValidationResult {
  ok: boolean;
  issues: NameLayoutValidationIssue[];
}

/**
 * 編集済みレイアウトの検証。基礎レイアウト(候補の実効レイアウト)と比較し、
 * コマ数・id・order・読み順が保たれ、幾何が健全であることを確かめる。
 * クライアントの保存前チェックとサーバーの set-custom-layout 検証で共用する。
 */
export function validateEditedNameLayout(edited: PageLayout, base: PageLayout): NameLayoutValidationResult {
  const issues: NameLayoutValidationIssue[] = [];
  if (edited.panels.length !== base.panels.length) {
    issues.push({
      code: "panel-count",
      message: `コマ数が変わっています(${base.panels.length}→${edited.panels.length})。コマの追加・削除はできません。`
    });
    return { ok: false, issues };
  }
  for (let index = 0; index < edited.panels.length; index += 1) {
    const editedPanel = edited.panels[index]!;
    const basePanel = base.panels[index]!;
    if (editedPanel.id !== basePanel.id) {
      issues.push({
        code: "panel-id",
        panelId: editedPanel.id,
        message: `コマ id が一致しません(${basePanel.id}→${editedPanel.id})。`
      });
    }
    if (editedPanel.order !== basePanel.order) {
      issues.push({
        code: "panel-order",
        panelId: editedPanel.id,
        message: `コマ「${editedPanel.id}」の order が変わっています。`
      });
    }
    if ((basePanel.role === "figure") !== (editedPanel.role === "figure")) {
      issues.push({
        code: "panel-id",
        panelId: editedPanel.id,
        message: `コマ「${editedPanel.id}」の role(figure)は編集で変更できません。`
      });
    }
    const shape = editedPanel.shape;
    if (shape.type !== "polygon" && shape.type !== "rect" && shape.type !== "ellipse" && shape.type !== "path") {
      issues.push({ code: "invalid-shape", panelId: editedPanel.id, message: `コマ「${editedPanel.id}」の形状が不正です。` });
      continue;
    }
    if (shape.type === "polygon") {
      if (shape.points.length < 3 || shape.points.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
        issues.push({
          code: "invalid-shape",
          panelId: editedPanel.id,
          message: `コマ「${editedPanel.id}」の頂点列が不正です(3点以上・有限値が必要)。`
        });
        continue;
      }
      if (polygonArea(shape.points) < MIN_PANEL_AREA) {
        issues.push({
          code: "min-area",
          panelId: editedPanel.id,
          message: `コマ「${editedPanel.id}」が小さすぎます(潰れています)。`
        });
      }
    }
    const [x0, y0, x1, y1] = panelBounds(shape);
    const limit = PANEL_BLEED_OVERSHOOT + EPS;
    if (x0 < -limit || y0 < -limit || x1 > 1 + limit || y1 > edited.page.height + limit) {
      issues.push({
        code: "out-of-bounds",
        panelId: editedPanel.id,
        message: `コマ「${editedPanel.id}」がページ境界から裁ち切り許容(${PANEL_BLEED_OVERSHOOT})を超えてはみ出しています。`
      });
    }
  }
  // 読み順(reading direction の行検出)が基礎レイアウトと同じ id 列であること。
  // 台詞の自動配置はコマの幾何順に依存するため、順序が入れ替わる編集は拒否する。
  const baseOrder = orderPanelsByReadingDirection(base.panels, base.readingDirection).map((panel) => panel.id);
  const editedOrder = orderPanelsByReadingDirection(edited.panels, edited.readingDirection).map((panel) => panel.id);
  if (baseOrder.join(" ") !== editedOrder.join(" ")) {
    issues.push({
      code: "reading-order",
      message: `編集によりコマの読み順が変わっています(${baseOrder.join("→")} が ${editedOrder.join("→")} になりました)。読み順を保つ範囲で調整してください。`
    });
  }
  return { ok: issues.length === 0, issues };
}
