/**
 * ページ編集 lightbox「コマ枠」モード(Docs/Feature-CGCollectionSuite.md P5: 頂点編集・分割)の
 * ステージ描画+ツールバー(pagePanelLightboxView.ts から分割)。hover-reveal の幾何ハンドル群や
 * 頂点追加/コマ分割/フリーハンドの排他モードトグルを含む(Docs/Feature-PanelFrameEditUx.md)。
 */
import type { LayoutPanel, PageLayout } from "../../shared/pageLayout";
import { panelBounds } from "../../shared/pageLayout";
import { detectJunctions, detectSharedBoundaries, toEditableNameLayout } from "../../shared/nameLayoutEdit";
import { LAYOUT_PAGE_MARGIN } from "../../shared/layoutPresets";
import type { ParallelSnapGuide } from "../../shared/panelShapeAssist";
import type { PanelBezierNode } from "../../shared/panelBezier";
import { escapeAttr } from "../format";
import { num, panelShapeElement, shapeCenter } from "./pageLayoutSvg";
import { VIEWBOX_SCALE } from "./lightboxViewShared";

/** コマ形状編集(P5)モードの表示用状態。lightbox を開いている間の作業ドラフト+選択/分割状態をまとめる。 */
export interface PanelShapeEditViewState {
  layout: PageLayout | null;
  selectedPanelId: string | null;
  selectedVertexIndex: number | null;
  splitMode: boolean;
  splitDraft: { start: [number, number]; current: [number, number] } | null;
  gutter: number;
  /** 裁ち切り/ガター詰めドラッグ中の半透明プレビュー対象辺(人間ゲート編集と同じ表現)。 */
  geometryPreview: {
    kind: "bleed" | "gutter";
    edges: Array<{ panelIndex: number; edgeIndex: number }>;
    side?: "left" | "right" | "top" | "bottom";
  } | null;
  snapGuide: ParallelSnapGuide | null;
  freehandMode: boolean;
  freehandDraft: [number, number][] | null;
  /** ドラッグ範囲選択の作業矩形(page 座標)。 */
  marquee: { start: [number, number]; current: [number, number] } | null;
  /** 範囲選択された頂点集合(全パネル横断、一括移動対象)。 */
  selectedVertices: Array<{ panelIndex: number; vertexIndex: number }>;
  /** 頂点追加モード(全コマの辺中点＋マーカー表示)。分割/フリーハンドと排他。 */
  addVertexMode: boolean;
  /** ドラッグ中の幾何ハンドル(hover-reveal ハンドルをドラッグ中も表示し続ける)。 */
  activeGeometry: { kind: "boundary" | "gutter" | "junction" | "edge"; id: string } | null;
  /** undo/redo ボタンの活性判定。 */
  canUndo: boolean;
  canRedo: boolean;
}

// --- 「コマ枠」モード(Docs/Feature-CGCollectionSuite.md P5: 頂点編集・分割) ---

/** 頂点ハンドルの半径 / 辺中点マーカーの半径(正規化座標の初期値)。 */
const SHAPE_VERTEX_RADIUS = 0.012;
const SHAPE_EDGE_MARKER_RADIUS = 0.008;

export function renderShapesStageContent(shapeEdit: PanelShapeEditViewState, pageHeight: number): string {
  const layout = shapeEdit.layout;
  if (!layout) {
    return `<g transform="scale(${VIEWBOX_SCALE})"><rect x="0" y="0" width="1" height="${num(pageHeight)}" class="page-panel-paper" /></g>`;
  }
  // 既定モードでは静かなキャンバス(塗り+番号バッジ+枠線)を保ち、ハンドルは hover で現れる。
  // 頂点追加/分割/フリーハンドは排他のモードトグル(ツールバー)。
  const isDefaultMode = !shapeEdit.splitMode && !shapeEdit.freehandMode && !shapeEdit.addVertexMode;
  const selectedPanel = shapeEdit.selectedPanelId ? layout.panels.find((panel) => panel.id === shapeEdit.selectedPanelId) ?? null : null;
  const fillsHtml = layout.panels.map((panel) => renderShapePanelFill(panel, panel.id === shapeEdit.selectedPanelId)).join("");
  const panelsHtml = layout.panels.map((panel) => renderShapePanelOutline(panel, panel.id === shapeEdit.selectedPanelId)).join("");
  const handles = selectedPanel && isDefaultMode
    ? selectedPanel.shape.type === "polygon"
      ? renderShapeVertexHandles(selectedPanel.shape.points, shapeEdit.selectedVertexIndex)
      : selectedPanel.shape.type === "path" && selectedPanel.shape.bezier
        ? renderBezierHandles(selectedPanel.shape.bezier.nodes, shapeEdit.selectedVertexIndex)
        : ""
    : "";
  const splitPreview = shapeEdit.splitMode && shapeEdit.splitDraft ? renderShapeSplitPreview(shapeEdit.splitDraft) : "";
  const marquee = shapeEdit.marquee
    ? `<rect class="page-shape-marquee" x="${num(Math.min(shapeEdit.marquee.start[0], shapeEdit.marquee.current[0]))}"
        y="${num(Math.min(shapeEdit.marquee.start[1], shapeEdit.marquee.current[1]))}"
        width="${num(Math.abs(shapeEdit.marquee.current[0] - shapeEdit.marquee.start[0]))}"
        height="${num(Math.abs(shapeEdit.marquee.current[1] - shapeEdit.marquee.start[1]))}" />`
    : "";
  const rootClass = [
    shapeEdit.freehandMode ? "is-freehand-mode" : "",
    shapeEdit.splitMode ? "is-split-mode" : "",
    shapeEdit.addVertexMode ? "is-addvertex-mode" : ""
  ].filter(Boolean).join(" ");
  return `
    <g id="pageShapeStageRoot" class="${rootClass}" transform="scale(${VIEWBOX_SCALE})" data-shape-stage="1">
      <rect x="0" y="0" width="1" height="${num(layout.page.height)}" class="page-panel-paper" data-shape-background="1" />
      <rect class="page-shape-margin-guide" x="${num(LAYOUT_PAGE_MARGIN)}" y="${num(LAYOUT_PAGE_MARGIN)}"
        width="${num(1 - LAYOUT_PAGE_MARGIN * 2)}" height="${num(layout.page.height - LAYOUT_PAGE_MARGIN * 2)}" />
      ${fillsHtml}
      ${panelsHtml}
      ${isDefaultMode ? renderShapeGeometryHandles(layout, shapeEdit.geometryPreview, shapeEdit.activeGeometry) : ""}
      ${renderShapeOrderBadges(layout, isDefaultMode, shapeEdit.selectedPanelId)}
      ${renderParallelSnapGuide(shapeEdit.snapGuide)}
      ${handles}
      ${shapeEdit.addVertexMode ? renderAddVertexMarkers(layout) : ""}
      ${renderMultiSelectedVertexHandles(layout, shapeEdit.selectedVertices)}
      ${marquee}
      ${splitPreview}
      ${renderFreehandPreview(shapeEdit.freehandDraft)}
    </g>
  `;
}

/** コマ領域の薄い塗り(モック評価: コマ領域が一目で分かる)。クリックは枠線要素側で拾う。 */
function renderShapePanelFill(panel: LayoutPanel, isSelected: boolean): string {
  return panelShapeElement(panel.shape, `class="page-shape-panel-fill${isSelected ? " is-selected" : ""}"`);
}

/**
 * コマ番号バッジ。読み順の把握と同時に、既定モードではドラッグでコマ全体を移動するハンドルになる
 * (クリックだけならコマ選択)。他モードでは表示のみ(pointer-events なし)。
 */
function renderShapeOrderBadges(layout: PageLayout, interactive: boolean, selectedPanelId: string | null): string {
  const parts = layout.panels.map((panel) => {
    const bounds = panelBounds(panel.shape);
    const center = shapeCenter(panel.shape) ?? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    const classes = [
      "page-shape-order-badge",
      interactive ? "is-interactive" : "",
      panel.id === selectedPanelId ? "is-selected" : ""
    ].filter(Boolean).join(" ");
    return `<g class="${classes}"${interactive ? ` data-shape-panel-move="${escapeAttr(panel.id)}"` : ""} transform="translate(${num(center[0])} ${num(center[1])})">
      <circle class="page-shape-order-badge-bg" r="0.026" />
      <text class="page-shape-order-badge-text" x="0" y="0.001">${panel.order}</text>
      ${interactive ? `<title>ドラッグでコマ全体を移動 / クリックで選択</title>` : ""}
    </g>`;
  });
  return `<g class="page-shape-order-badges">${parts.join("")}</g>`;
}

/** 頂点追加モードの＋マーカー(全 polygon コマの辺中点)。クリックで頂点追加。 */
function renderAddVertexMarkers(layout: PageLayout): string {
  const parts: string[] = [];
  layout.panels.forEach((panel) => {
    if (panel.shape.type !== "polygon") return;
    const points = panel.shape.points;
    const n = points.length;
    for (let i = 0; i < n; i += 1) {
      const a = points[i]!;
      const b = points[(i + 1) % n]!;
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      parts.push(`<g class="page-shape-addvertex" data-shape-addvertex="${i}" data-shape-addvertex-panel="${escapeAttr(panel.id)}" transform="translate(${num(mx)} ${num(my)})">
        <circle class="page-shape-addvertex-hit" r="0.018" />
        <circle class="page-shape-addvertex-dot" r="${num(SHAPE_EDGE_MARKER_RADIUS)}" />
        <path class="page-shape-addvertex-plus" d="M -0.0045 0 H 0.0045 M 0 -0.0045 V 0.0045" />
        <title>クリックで頂点を追加</title>
      </g>`);
    }
  });
  return `<g class="page-shape-addvertex-layer">${parts.join("")}</g>`;
}

/** 範囲選択された頂点のハンドル(ドラッグでまとめて移動)。 */
function renderMultiSelectedVertexHandles(
  layout: PageLayout,
  selectedVertices: PanelShapeEditViewState["selectedVertices"]
): string {
  if (selectedVertices.length === 0) return "";
  const parts: string[] = [];
  for (const ref of selectedVertices) {
    const panel = layout.panels[ref.panelIndex];
    if (!panel || panel.shape.type !== "polygon") continue;
    const point = panel.shape.points[ref.vertexIndex];
    if (!point) continue;
    parts.push(
      `<circle class="page-shape-mvertex-handle" data-shape-mvertex="${ref.panelIndex}:${ref.vertexIndex}" cx="${num(point[0])}" cy="${num(point[1])}" r="${num(SHAPE_VERTEX_RADIUS)}"><title>選択中の頂点(ドラッグで一括移動)</title></circle>`
    );
  }
  return `<g class="page-shape-mvertex-handles">${parts.join("")}</g>`;
}

/**
 * 幾何編集ハンドル群(A案「ダイレクト仕切り」×モックの融合)。常時表示はせず、対象へマウスを
 * 寄せた時(グループ hover)かドラッグ中(activeGeometry)だけ可視化する。
 * - 共有境界: 太い透明バンドをドラッグ=境界移動(両側追随)。hover で中心線と両側の
 *   ガターシェブロン(外向きへドラッグで余白を広げる/内向きで詰める)が現れる。
 * - 非共有辺(外周など): hover でハイライト線。ドラッグで法線方向へ平行移動(裁ち切り対応)。
 * - 交差点: hover でドットが現れ、ドラッグで接続する全コマの角を一括移動。
 * 検出は polygon 化した複製(toEditableNameLayout)上で行い、panelIndex/edgeIndex はドラフトと
 * 1:1 対応する(コントローラ側もドラッグ開始時に同じ polygon 化を行う)。
 */
function renderShapeGeometryHandles(
  layout: PageLayout,
  geometryPreview: PanelShapeEditViewState["geometryPreview"],
  activeGeometry: PanelShapeEditViewState["activeGeometry"]
): string {
  const editable = toEditableNameLayout(layout);
  const parts: string[] = [];
  const boundaries = detectSharedBoundaries(editable);
  // 共有境界に属する辺は境界バンドで操作する(片側だけの調整は頂点ドラッグで可能)。
  const boundaryEdgeKeys = new Set(
    boundaries.flatMap((boundary) => boundary.edges.map((entry) => `${entry.ref.panelIndex}:${entry.ref.edgeIndex}`))
  );
  editable.panels.forEach((panel, panelIndex) => {
    if (panel.shape.type !== "polygon") return;
    const points = panel.shape.points;
    const n = points.length;
    for (let edgeIndex = 0; edgeIndex < n; edgeIndex += 1) {
      const id = `${panelIndex}:${edgeIndex}`;
      if (boundaryEdgeKeys.has(id)) continue;
      const [x1, y1] = points[edgeIndex]!;
      const [x2, y2] = points[(edgeIndex + 1) % n]!;
      const isActive = activeGeometry?.kind === "edge" && activeGeometry.id === id;
      parts.push(`<g class="page-shape-edge-group${isActive ? " is-active" : ""}">
        <line class="page-shape-edge-glow" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" />
        <line class="page-shape-edgeline-hit" data-shape-edgeline="${id}" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"><title>辺をドラッグで移動(外周辺は余白の外へで裁ち切り)</title></line>
      </g>`);
    }
  });
  for (const boundary of boundaries) {
    const id = escapeAttr(boundary.id);
    const [nx, ny] = boundary.normal;
    // 法線が水平寄り=縦の仕切り(左右へ動かす)、垂直寄り=横の仕切り。カーソル向きに使う。
    const axisClass = Math.abs(nx) >= Math.abs(ny) ? "is-x" : "is-y";
    const isActive = activeGeometry !== null &&
      (activeGeometry.kind === "boundary" || activeGeometry.kind === "gutter") &&
      activeGeometry.id === boundary.id;
    const hitWidth = Math.max(0.034, boundary.gutterWidth + 0.02);
    const chevronOffset = boundary.gutterWidth / 2 + 0.02;
    const chevron = (dir: 1 | -1) => {
      const cx = boundary.center[0] + nx * chevronOffset * dir;
      const cy = boundary.center[1] + ny * chevronOffset * dir;
      const angle = (Math.atan2(ny * dir, nx * dir) * 180) / Math.PI;
      return `<g class="page-shape-gutter-chevron ${axisClass}" data-shape-gutter="${id}" data-gutter-dir="${dir}" transform="translate(${num(cx)} ${num(cy)}) rotate(${num(angle)})">
        <circle class="page-shape-gutter-chevron-hit" r="0.019" />
        <path class="page-shape-gutter-chevron-mark" d="M -0.0045 -0.0075 L 0.0055 0 L -0.0045 0.0075" />
        <title>外へドラッグで余白を広げる / 内へで詰める</title>
      </g>`;
    };
    parts.push(`<g class="page-shape-boundary-group${isActive ? " is-active" : ""}">
      <line class="page-shape-boundary-hit ${axisClass}" data-shape-boundary="${id}" x1="${num(boundary.start[0])}" y1="${num(boundary.start[1])}" x2="${num(boundary.end[0])}" y2="${num(boundary.end[1])}" style="stroke-width: ${num(hitWidth)}"><title>仕切りをドラッグで移動(両側のコマが追随)</title></line>
      <line class="page-shape-boundary-line" x1="${num(boundary.start[0])}" y1="${num(boundary.start[1])}" x2="${num(boundary.end[0])}" y2="${num(boundary.end[1])}" />
      ${chevron(1)}${chevron(-1)}
    </g>`);
  }
  // 交差点(複数コマの角)ハンドル。hover でドットが現れる。
  for (const junction of detectJunctions(editable)) {
    const isActive = activeGeometry?.kind === "junction" && activeGeometry.id === junction.id;
    parts.push(`<g class="page-shape-junction-group${isActive ? " is-active" : ""}" transform="translate(${num(junction.position[0])} ${num(junction.position[1])})">
      <circle class="page-shape-junction-hit" data-shape-junction="${escapeAttr(junction.id)}" r="0.02" />
      <circle class="page-shape-junction-dot" r="0.01" />
      <title>交差点(接続する全コマの角)を移動</title>
    </g>`);
  }
  // 裁ち切りはページ端の帯・トリム線・状態ラベルを重ね、枠線が消えて絵が端まで続く結果を予告する。
  if (geometryPreview) {
    if (geometryPreview.kind === "bleed" && geometryPreview.side) {
      const side = geometryPreview.side;
      const band = 0.045;
      const x = side === "right" ? 1 - band : 0;
      const y = side === "bottom" ? layout.page.height - band : 0;
      const width = side === "left" || side === "right" ? band : 1;
      const height = side === "top" || side === "bottom" ? band : layout.page.height;
      const trim = side === "left" || side === "right"
        ? `<line class="page-shape-bleed-trim" x1="${side === "left" ? 0 : 1}" y1="0" x2="${side === "left" ? 0 : 1}" y2="${num(layout.page.height)}" />`
        : `<line class="page-shape-bleed-trim" x1="0" y1="${side === "top" ? 0 : num(layout.page.height)}" x2="1" y2="${side === "top" ? 0 : num(layout.page.height)}" />`;
      const labelX = side === "right" ? 0.79 : 0.035;
      const labelY = side === "bottom" ? layout.page.height - 0.07 : 0.035;
      parts.push(`<g class="page-shape-bleed-preview">
        <rect class="page-shape-bleed-band" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" />
        ${trim}
        <g transform="translate(${num(labelX)} ${num(labelY)})">
          <rect class="page-shape-bleed-pill" width="0.175" height="0.04" rx="0.02" />
          <text class="page-shape-bleed-label" x="0.0875" y="0.022">裁ち切り</text>
        </g>
      </g>`);
    }
    for (const edge of geometryPreview.edges) {
      const panel = layout.panels[edge.panelIndex];
      if (!panel || panel.shape.type !== "polygon") continue;
      const points = panel.shape.points;
      const a = points[edge.edgeIndex % points.length];
      const b = points[(edge.edgeIndex + 1) % points.length];
      if (!a || !b) continue;
      parts.push(
        `<line class="page-shape-preview-mask" x1="${num(a[0])}" y1="${num(a[1])}" x2="${num(b[0])}" y2="${num(b[1])}" />`,
        `<line class="page-shape-preview-edge${geometryPreview.kind === "bleed" ? " is-bleed" : ""}" x1="${num(a[0])}" y1="${num(a[1])}" x2="${num(b[0])}" y2="${num(b[1])}" />`
      );
    }
  }
  return `<g class="page-shape-geometry">${parts.join("")}</g>`;
}

function renderShapePanelOutline(panel: LayoutPanel, isSelected: boolean): string {
  const strokeWidth = isSelected ? 0.01 : 0.005;
  return panelShapeElement(
    panel.shape,
    `class="page-shape-outline${isSelected ? " is-selected" : ""}" data-shape-panel-id="${escapeAttr(panel.id)}" fill="transparent" stroke-width="${num(strokeWidth)}" stroke-linejoin="miter"`
  );
}

function renderShapeVertexHandles(points: [number, number][], selectedIndex: number | null): string {
  // 辺中点の頂点追加マーカーは「頂点追加」モード(renderAddVertexMarkers)へ移した。
  // 選択中コマには頂点ハンドルだけを出す(静かなキャンバスを保つ)。
  const vertices = points
    .map(
      ([x, y], i) =>
        `<circle class="page-shape-vertex-handle${i === selectedIndex ? " is-selected" : ""}" data-shape-vertex="${i}" cx="${num(x)}" cy="${num(y)}" r="${num(SHAPE_VERTEX_RADIUS)}" />`
    )
    .join("");
  return `<g class="page-shape-handles">${vertices}</g>`;
}

function renderBezierHandles(nodes: readonly PanelBezierNode[], selectedIndex: number | null): string {
  const controls = nodes.map((node, index) => `
    <line class="page-shape-bezier-control-line" x1="${num(node.point[0])}" y1="${num(node.point[1])}" x2="${num(node.in[0])}" y2="${num(node.in[1])}" />
    <line class="page-shape-bezier-control-line" x1="${num(node.point[0])}" y1="${num(node.point[1])}" x2="${num(node.out[0])}" y2="${num(node.out[1])}" />
    <circle class="page-shape-bezier-control" data-shape-bezier-handle="${index}:in" cx="${num(node.in[0])}" cy="${num(node.in[1])}" r="${num(SHAPE_EDGE_MARKER_RADIUS)}"><title>入る方向ハンドル(Altで片側だけ編集)</title></circle>
    <circle class="page-shape-bezier-control" data-shape-bezier-handle="${index}:out" cx="${num(node.out[0])}" cy="${num(node.out[1])}" r="${num(SHAPE_EDGE_MARKER_RADIUS)}"><title>出る方向ハンドル(Altで片側だけ編集)</title></circle>
  `).join("");
  const anchors = nodes.map((node, index) =>
    `<rect class="page-shape-bezier-anchor${index === selectedIndex ? " is-selected" : ""}" data-shape-bezier-anchor="${index}" x="${num(node.point[0] - SHAPE_VERTEX_RADIUS)}" y="${num(node.point[1] - SHAPE_VERTEX_RADIUS)}" width="${num(SHAPE_VERTEX_RADIUS * 2)}" height="${num(SHAPE_VERTEX_RADIUS * 2)}" rx="0.003"><title>Bezierアンカー</title></rect>`
  ).join("");
  return `<g class="page-shape-bezier-handles">${controls}${anchors}</g>`;
}

function renderParallelSnapGuide(guide: ParallelSnapGuide | null): string {
  if (!guide) return "";
  const [labelX, labelY] = guide.activeEnd;
  return `<g class="page-shape-smart-guide">
    <line class="page-shape-smart-guide-reference" x1="${num(guide.referenceStart[0])}" y1="${num(guide.referenceStart[1])}" x2="${num(guide.referenceEnd[0])}" y2="${num(guide.referenceEnd[1])}" />
    <line class="page-shape-smart-guide-active" x1="${num(guide.activeStart[0])}" y1="${num(guide.activeStart[1])}" x2="${num(guide.activeEnd[0])}" y2="${num(guide.activeEnd[1])}" />
    <g transform="translate(${num(Math.max(0.04, Math.min(0.89, labelX - 0.1)))} ${num(Math.max(0.045, Math.min(1.35, labelY - 0.03)))})">
      <rect class="page-shape-smart-guide-pill" width="0.095" height="0.035" rx="0.0175" />
      <text class="page-shape-smart-guide-label" x="0.0475" y="0.019">${guide.label}</text>
    </g>
  </g>`;
}

function renderFreehandPreview(points: readonly [number, number][] | null): string {
  if (!points?.length) return "";
  const d = points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${num(x)} ${num(y)}`).join(" ");
  const close = points.length > 2 ? ` L ${num(points[0]![0])} ${num(points[0]![1])}` : "";
  return `<g class="page-shape-freehand-preview">
    <path class="page-shape-freehand-fill" d="${d}${close} Z" />
    <path class="page-shape-freehand-stroke" d="${d}" />
    ${points.length > 2 ? `<path class="page-shape-freehand-close" d="M ${num(points[points.length - 1]![0])} ${num(points[points.length - 1]![1])} L ${num(points[0]![0])} ${num(points[0]![1])}" />` : ""}
  </g>`;
}

function renderShapeSplitPreview(splitDraft: { start: [number, number]; current: [number, number] }): string {
  const [x1, y1] = splitDraft.start;
  const [x2, y2] = splitDraft.current;
  return `<line class="page-shape-split-line" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" />`;
}

/** undo/redo ボタン(コマ枠モード共通、Ctrl+Z / Ctrl+Shift+Z)。 */
function shapeHistoryButtons(shapeEdit: PanelShapeEditViewState): string {
  return `
    <div class="page-panel-toolbar-actions page-shape-history">
      <button class="button-secondary compact" type="button" data-action="page-shape-undo"
        title="元に戻す (Ctrl+Z)" ${shapeEdit.canUndo ? "" : "disabled"}>↩ 元に戻す</button>
      <button class="button-secondary compact" type="button" data-action="page-shape-redo"
        title="やり直す (Ctrl+Shift+Z)" ${shapeEdit.canRedo ? "" : "disabled"}>↪ やり直す</button>
    </div>`;
}

/** モードトグル(頂点追加/コマ分割/フリーハンド)。排他で、押し直すと既定モードへ戻る。 */
function shapeModeButtons(shapeEdit: PanelShapeEditViewState): string {
  return `
    <div class="page-panel-toolbar-actions page-shape-mode-actions">
      <button class="button-secondary compact${shapeEdit.addVertexMode ? " is-active" : ""}" type="button"
        data-action="toggle-panel-shape-add-vertex-mode" title="辺の中点に＋マーカーを表示し、クリックで頂点を追加">＋ 頂点追加</button>
      <button class="button-secondary compact${shapeEdit.splitMode ? " is-active" : ""}" type="button"
        data-action="toggle-panel-shape-split-mode" title="コマを横切る線を引いて2分割">⧉ コマ分割</button>
      <button class="button-secondary compact${shapeEdit.freehandMode ? " is-active" : ""}" type="button"
        data-action="toggle-panel-shape-freehand-mode" title="一周描いて滑らかな曲線コマを追加">✎ 曲線枠を描く</button>
    </div>`;
}

export function renderShapesToolbar(shapeEdit: PanelShapeEditViewState): string {
  const layout = shapeEdit.layout;
  const selectedPanel = layout && shapeEdit.selectedPanelId ? layout.panels.find((panel) => panel.id === shapeEdit.selectedPanelId) ?? null : null;
  const history = shapeHistoryButtons(shapeEdit);
  const modes = shapeModeButtons(shapeEdit);

  if (shapeEdit.freehandMode) {
    return `
      <footer class="page-panel-toolbar page-shape-freehand-toolbar">
        <p class="page-panel-hint-text"><strong>フリーハンド曲線枠:</strong> 紙面上を一周ドラッグしてください。軌跡を滑らかな閉じたBezierへ整えます(Escで解除)。</p>
        ${modes}
        ${history}
      </footer>`;
  }
  if (shapeEdit.addVertexMode) {
    return `
      <footer class="page-panel-toolbar page-shape-addvertex-toolbar">
        <p class="page-panel-hint-text"><strong>頂点追加:</strong> 辺の中点の＋をクリックすると頂点が増えます。続けて追加できます(Escで解除)。</p>
        ${modes}
        ${history}
      </footer>`;
  }
  if (shapeEdit.splitMode) {
    return `
      <footer class="page-panel-toolbar page-shape-split-toolbar">
        <p class="page-panel-hint-text"><strong>コマ分割:</strong> 分割したいコマを横切るようにドラッグで線を引いてください。続けて分割できます(Escで解除)。</p>
        <div class="page-panel-toolbar-actions">
          <label class="page-object-property-field">ガター幅
            <input type="number" step="0.005" min="0" max="0.1" data-shape-gutter-field="1" value="${num(shapeEdit.gutter)}" />
          </label>
        </div>
        ${modes}
        ${history}
      </footer>
    `;
  }

  if (shapeEdit.selectedVertices.length > 0) {
    return `
      <footer class="page-panel-toolbar">
        <p class="page-panel-hint-text">${shapeEdit.selectedVertices.length}個の頂点を選択中。
          いずれかの頂点をドラッグすると選択した全頂点が一緒に動きます(Escで選択解除)。</p>
        ${history}
      </footer>
    `;
  }
  if (!selectedPanel) {
    return `
      <footer class="page-panel-toolbar">
        <p class="page-panel-hint-text">仕切り線・コマの辺・交差点は、マウスを寄せるとハンドルが現れます。
          仕切りはドラッグで移動(両側が追随)、現れる〈 〉をドラッグでコマ間余白を調整。
          中央の番号はドラッグでコマ全体を移動、クリックで選択(頂点編集)。
          外周辺を余白の外へドラッグすると裁ち切り。背景ドラッグで頂点を範囲選択(一括移動)。</p>
        ${modes}
        ${history}
      </footer>
    `;
  }
  if (selectedPanel.shape.type === "path" && selectedPanel.shape.bezier) {
    return `
      <footer class="page-panel-toolbar">
        <p class="page-panel-hint-text">□=アンカー移動 / ○=曲線の方向と強さ。通常ドラッグは反対側も滑らかに連動、Alt+ドラッグで片側だけ調整。アンカーはダブルクリックまたはDeleteで削除。</p>
        ${modes}
        ${history}
      </footer>`;
  }
  if (selectedPanel.shape.type === "path") {
    return `
      <footer class="page-panel-toolbar">
        <p class="page-panel-hint-text">このコマ形状は編集できません。</p>
        ${history}
      </footer>
    `;
  }
  if (selectedPanel.shape.type !== "polygon") {
    return `
      <footer class="page-panel-toolbar">
        <p class="page-panel-hint-text">頂点を編集するには多角形に変換してください。</p>
        <div class="page-panel-toolbar-actions">
          <button class="button-secondary compact" type="button" data-action="convert-panel-shape-to-polygon">多角形に変換して編集</button>
        </div>
        ${history}
      </footer>
    `;
  }
  return `
    <footer class="page-panel-toolbar">
      <p class="page-panel-hint-text">頂点をドラッグで移動・ダブルクリック(または選択+Delete)で頂点削除。
        番号をドラッグするとコマ全体が動きます。頂点の追加は「＋ 頂点追加」モードで。</p>
      <div class="page-panel-toolbar-actions">
        <button class="button-secondary compact" type="button" data-action="convert-panel-shape-to-bezier">曲線に変換</button>
      </div>
      ${modes}
      ${history}
    </footer>
  `;
}
