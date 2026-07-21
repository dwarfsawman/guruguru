/**
 * ページ編集 lightbox「モザイク」モード(Docs/Feature-CGCollectionSuite.md P6: 非破壊リージョン編集)の
 * ステージ描画+ツールバー(pagePanelLightboxView.ts から分割)。
 */
import {
  MOSAIC_GRANULARITY_MAX,
  MOSAIC_GRANULARITY_MIN,
  regionBoundsPage,
  type MosaicRegion
} from "../../shared/mosaicRegion";
import { escapeAttr } from "../format";
import { iconPlus, iconTrash } from "../icons";
import { num } from "./pageLayoutSvg";
import { VIEWBOX_SCALE } from "./lightboxViewShared";

/** モザイク編集(P6)モードの表示用状態。追加モード/作業ドラフト/選択状態をまとめる。 */
export interface MosaicEditViewState {
  regions: MosaicRegion[];
  selectedRegionId: string | null;
  selectedVertexIndex: number | null;
  addMode: "rect" | "polygon" | null;
  rectDraft: { start: [number, number]; current: [number, number] } | null;
  polygonDraft: [number, number][] | null;
}

// --- 「モザイク」モード(Docs/Feature-CGCollectionSuite.md P6: 非破壊リージョン編集) ---

const MOSAIC_VERTEX_RADIUS = 0.012;
const MOSAIC_EDGE_MARKER_RADIUS = 0.008;

export function renderMosaicStageContent(mosaicEdit: MosaicEditViewState, pageHeight: number): string {
  const selected = mosaicEdit.selectedRegionId
    ? mosaicEdit.regions.find((region) => region.id === mosaicEdit.selectedRegionId) ?? null
    : null;
  const regionsHtml = mosaicEdit.regions.map((region) => renderMosaicRegionShape(region, region.id === mosaicEdit.selectedRegionId)).join("");
  const handles = selected ? renderMosaicHandles(selected, mosaicEdit.selectedVertexIndex) : "";
  const rectPreview = mosaicEdit.addMode === "rect" && mosaicEdit.rectDraft ? renderMosaicRectDraftPreview(mosaicEdit.rectDraft) : "";
  const polygonPreview =
    mosaicEdit.addMode === "polygon" && mosaicEdit.polygonDraft && mosaicEdit.polygonDraft.length > 0
      ? renderMosaicPolygonDraftPreview(mosaicEdit.polygonDraft)
      : "";
  return `
    <g id="pageMosaicStageRoot" transform="scale(${VIEWBOX_SCALE})" data-mosaic-stage="1">
      <rect x="0" y="0" width="1" height="${num(pageHeight)}" class="page-panel-paper" data-mosaic-background="1" />
      ${regionsHtml}
      ${handles}
      ${rectPreview}
      ${polygonPreview}
    </g>
  `;
}

/** リージョン1件の形状(半透明ハッチ塗り+枠)。実際のピクセル化プレビューは preview.png 側で確認する(ライブ canvas ピクセル化は省略)。 */
function renderMosaicRegionShape(region: MosaicRegion, isSelected: boolean): string {
  const stateClass = `page-mosaic-region${isSelected ? " is-selected" : ""}`;
  const attrs = `class="${stateClass}" data-mosaic-region-id="${escapeAttr(region.id)}" stroke-width="${num(isSelected ? 0.01 : 0.005)}"`;
  if (region.shape.type === "rect") {
    const [x, y, w, h] = region.shape.bounds;
    return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ${attrs} />`;
  }
  const points = region.shape.points.map(([x, y]) => `${num(x)},${num(y)}`).join(" ");
  return `<polygon points="${points}" ${attrs} />`;
}

function renderMosaicHandles(region: MosaicRegion, selectedVertexIndex: number | null): string {
  if (region.shape.type === "rect") {
    const [x, y, w, h] = region.shape.bounds;
    const corners: [number, number][] = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h]
    ];
    const edgeMids: [number, number][] = [
      [x + w / 2, y],
      [x + w, y + h / 2],
      [x + w / 2, y + h],
      [x, y + h / 2]
    ];
    const cornerHandles = corners
      .map(([cx, cy], i) => `<circle class="page-mosaic-rect-handle" data-mosaic-rect-corner="${i}" cx="${num(cx)}" cy="${num(cy)}" r="${num(MOSAIC_VERTEX_RADIUS)}" />`)
      .join("");
    const edgeHandles = edgeMids
      .map(([ex, ey], i) => `<circle class="page-mosaic-rect-edge-handle" data-mosaic-rect-edge="${i}" cx="${num(ex)}" cy="${num(ey)}" r="${num(MOSAIC_EDGE_MARKER_RADIUS)}" />`)
      .join("");
    return `<g class="page-mosaic-handles">${edgeHandles}${cornerHandles}</g>`;
  }
  const points = region.shape.points;
  const n = points.length;
  const edges = points
    .map((point, i) => {
      const next = points[(i + 1) % n]!;
      const mx = (point[0] + next[0]) / 2;
      const my = (point[1] + next[1]) / 2;
      return `<circle class="page-mosaic-edge-handle" data-mosaic-edge="${i}" cx="${num(mx)}" cy="${num(my)}" r="${num(MOSAIC_EDGE_MARKER_RADIUS)}" />`;
    })
    .join("");
  const vertices = points
    .map(
      ([x, y], i) =>
        `<circle class="page-mosaic-vertex-handle${i === selectedVertexIndex ? " is-selected" : ""}" data-mosaic-vertex="${i}" cx="${num(x)}" cy="${num(y)}" r="${num(MOSAIC_VERTEX_RADIUS)}" />`
    )
    .join("");
  return `<g class="page-mosaic-handles">${edges}${vertices}</g>`;
}

function renderMosaicRectDraftPreview(draft: { start: [number, number]; current: [number, number] }): string {
  const x = Math.min(draft.start[0], draft.current[0]);
  const y = Math.min(draft.start[1], draft.current[1]);
  const w = Math.abs(draft.current[0] - draft.start[0]);
  const h = Math.abs(draft.current[1] - draft.start[1]);
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" class="page-mosaic-draft-preview page-mosaic-draft-rect" />`;
}

function renderMosaicPolygonDraftPreview(points: [number, number][]): string {
  const pointsAttr = points.map(([x, y]) => `${num(x)},${num(y)}`).join(" ");
  const vertices = points.map(([x, y]) => `<circle class="page-mosaic-draft-vertex" cx="${num(x)}" cy="${num(y)}" r="${num(MOSAIC_EDGE_MARKER_RADIUS)}" />`).join("");
  return `<g class="page-mosaic-draft-polygon"><polyline points="${pointsAttr}" class="page-mosaic-draft-preview page-mosaic-draft-line" />${vertices}</g>`;
}

export function renderMosaicToolbar(mosaicEdit: MosaicEditViewState): string {
  const selected = mosaicEdit.selectedRegionId
    ? mosaicEdit.regions.find((region) => region.id === mosaicEdit.selectedRegionId) ?? null
    : null;
  const addButtons = `
    <button class="button-secondary compact${mosaicEdit.addMode === "rect" ? " is-active" : ""}" type="button" data-action="set-mosaic-add-mode" data-id="rect">${iconPlus()}矩形を追加</button>
    <button class="button-secondary compact${mosaicEdit.addMode === "polygon" ? " is-active" : ""}" type="button" data-action="set-mosaic-add-mode" data-id="polygon">${iconPlus()}多角形を追加</button>
  `;

  if (mosaicEdit.addMode === "rect") {
    return `
      <footer class="page-panel-toolbar page-mosaic-toolbar">
        <div class="page-object-toolbar-row">${addButtons}</div>
        <p class="page-panel-hint-text">ステージ上をドラッグして矩形リージョンを作成(もう一度ボタンを押すとキャンセル)</p>
      </footer>
    `;
  }
  if (mosaicEdit.addMode === "polygon") {
    return `
      <footer class="page-panel-toolbar page-mosaic-toolbar">
        <div class="page-object-toolbar-row">${addButtons}</div>
        <p class="page-panel-hint-text">クリックで頂点を追加、ダブルクリックまたは始点クリックで確定(もう一度ボタンを押すとキャンセル)</p>
      </footer>
    `;
  }

  const [minX, minY, maxX, maxY] = selected ? regionBoundsPage(selected) : [0, 0, 0, 0];
  const hasGranularity = Boolean(selected?.granularity);

  return `
    <footer class="page-panel-toolbar page-mosaic-toolbar">
      <div class="page-object-toolbar-row">
        ${addButtons}
        ${selected ? `<button class="button-danger compact" type="button" data-action="delete-selected-mosaic-region" title="削除(Delete キー)">${iconTrash()}削除</button>` : ""}
      </div>
      ${
        selected
          ? `
            <div class="page-object-property-row">
              <span class="page-panel-hint-text">範囲: (${num(minX)}, ${num(minY)}) - (${num(maxX)}, ${num(maxY)})</span>
              <label class="page-object-property-field page-object-checkbox-field">
                <input type="checkbox" data-mosaic-field="granularityEnabled" ${hasGranularity ? "checked" : ""} /> 粒度を指定
              </label>
              ${
                hasGranularity
                  ? `
                    <label class="page-object-property-field">粒度(長辺比)
                      <input type="number" step="0.001" min="${MOSAIC_GRANULARITY_MIN}" max="${MOSAIC_GRANULARITY_MAX}" data-mosaic-field="granularity" value="${num(selected!.granularity ?? 0)}" />
                    </label>
                  `
                  : ""
              }
            </div>
            <p class="page-panel-hint-text">${
              selected.shape.type === "rect"
                ? "4隅で自由リサイズ・辺の中点で1軸リサイズ"
                : "頂点をドラッグで移動・辺の中点クリックで頂点追加・ダブルクリック(または選択+Delete)で頂点削除"
            }。粒度は未指定(自動)でも規定の最小粒度が書き出し時に適用されます -- 実際のモザイク画像はページ一覧のプレビューや書き出しでご確認ください。</p>
          `
          : `<p class="page-panel-hint-text">リージョンをクリックして選択(Delete で削除)。「矩形を追加」「多角形を追加」で新規作成できます。</p>`
      }
    </footer>
  `;
}
