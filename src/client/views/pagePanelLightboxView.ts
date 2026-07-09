/**
 * コマ内生成(Docs/Feature-PanelGeneration.md)。ページのコマ選択/クロップ編集 lightbox。
 * 通常モード: シングルクリックでコマ選択 →「選択コマを生成」で生成 UI へ。ダブルクリックは補助導線
 * (pagePanelLightboxController が担当: 未生成コマ→生成 UI、生成済みコマ→クロップ編集モード)。
 * クロップ編集モード: 対象コマの画像だけドラッグでき(他コマは非活性で dimmed)、pointerup で保存する。
 * 座標は pageLayoutSvg.ts と同じ width-relative 正規化(x∈[0,1], y∈[0,page.height])。
 */
import type { PagePanelAssignment, PageSummary } from "../../shared/apiTypes";
import type { LayoutPanel, PanelCrop } from "../../shared/pageLayout";
import { panelBounds, panelBoundsSize } from "../../shared/pageLayout";
import type { PagePanelLightboxState } from "../appState";
import { escapeAttr, escapeHtml } from "../format";
import { iconClose, iconSparkle } from "../icons";
import { num, panelShapeElement, shapeCenter } from "./pageLayoutSvg";

const VIEWBOX_SCALE = 1000;

export function renderPagePanelLightbox(
  page: PageSummary,
  lightbox: PagePanelLightboxState,
  assignments: PagePanelAssignment[]
): string {
  const layout = page.layout;
  if (!layout || lightbox.pageId !== page.id) {
    return "";
  }
  const label = page.title.trim() || "ページ";
  const assignmentByPanel = new Map(assignments.map((assignment) => [assignment.panelId, assignment]));
  const cropPanel = lightbox.cropPanelId ? layout.panels.find((panel) => panel.id === lightbox.cropPanelId) ?? null : null;

  return `
    <div class="workflow-modal page-panel-lightbox" role="dialog" aria-modal="true" aria-label="${escapeAttr(label)} のコマ選択">
      <section class="workflow-dialog page-panel-dialog">
        <header class="workflow-dialog-header">
          <div>
            <p class="section-kicker">Book · コマ内生成</p>
            <h2>${escapeHtml(label)}</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-page-panels" aria-label="閉じる" title="閉じる">${iconClose()}</button>
        </header>
        <div class="page-panel-stage" style="aspect-ratio: 1 / ${num(layout.page.height)}">
          <svg class="page-panel-svg" viewBox="0 0 ${VIEWBOX_SCALE} ${num(VIEWBOX_SCALE * layout.page.height)}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
            <defs>${layout.panels.map(renderPanelClipPath).join("")}</defs>
            <rect x="0" y="0" width="1" height="${num(layout.page.height)}" class="page-panel-paper" />
            <g transform="scale(${VIEWBOX_SCALE})">
              ${layout.panels.map((panel) => renderPanelGroup(panel, assignmentByPanel.get(panel.id) ?? null, lightbox)).join("")}
            </g>
          </svg>
        </div>
        ${cropPanel ? renderCropToolbar() : renderSelectToolbar(lightbox)}
      </section>
    </div>
  `;
}

function panelClipId(panelId: string): string {
  return `page-panel-clip-${panelId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function renderPanelClipPath(panel: LayoutPanel): string {
  return `<clipPath id="${panelClipId(panel.id)}">${panelShapeElement(panel.shape)}</clipPath>`;
}

function renderPanelGroup(panel: LayoutPanel, assignment: PagePanelAssignment | null, lightbox: PagePanelLightboxState): string {
  const isSelected = lightbox.selectedPanelId === panel.id;
  const isCropTarget = lightbox.cropPanelId === panel.id;
  const isDimmed = lightbox.cropPanelId !== null && !isCropTarget;
  const stateClass = ["page-panel-group", isSelected ? "is-selected" : "", isCropTarget ? "is-crop-target" : "", isDimmed ? "is-dimmed" : ""]
    .filter(Boolean)
    .join(" ");

  const crop = isCropTarget ? lightbox.cropDraft ?? assignment?.crop ?? null : assignment?.crop ?? null;
  const image = assignment && crop ? renderAssignmentImage(panel, assignment, crop, isCropTarget) : "";
  // stroke-width は正規化座標系の数値属性(pageLayoutSvg.ts と同じ規約)。色は CSS クラスで状態別に出し分ける。
  const strokeWidth = isSelected || isCropTarget ? 0.01 : 0.005;
  const outline = panelShapeElement(panel.shape, `class="page-panel-outline" fill="none" stroke-width="${num(strokeWidth)}" stroke-linejoin="miter"`);
  const hint = assignment ? "" : renderEmptyPanelHint(panel);

  return `<g class="${stateClass}" data-panel-id="${escapeAttr(panel.id)}">${image}${outline}${hint}</g>`;
}

/** crop(asset 画像座標系で正規化)をパネル外接矩形へ cover フィットさせた `<image>` の x/y/width/height。 */
function imageRectForCrop(bounds: [number, number, number, number], crop: PanelCrop) {
  const [boxWidth, boxHeight] = panelBoundsSize(bounds);
  const width = boxWidth / crop.width;
  const height = boxHeight / crop.height;
  const x = bounds[0] - crop.x * width;
  const y = bounds[1] - crop.y * height;
  return { x, y, width, height };
}

function renderAssignmentImage(panel: LayoutPanel, assignment: PagePanelAssignment, crop: PanelCrop, draggable: boolean): string {
  const rect = imageRectForCrop(panelBounds(panel.shape), crop);
  const clipId = panelClipId(panel.id);
  const dragAttrs = draggable ? ` data-crop-drag-panel="${escapeAttr(panel.id)}" class="page-panel-image is-draggable"` : ` class="page-panel-image"`;
  return `<image href="${escapeAttr(assignment.assetImageUrl)}" x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" preserveAspectRatio="none" clip-path="url(#${clipId})"${dragAttrs} />`;
}

/** 未割り当てコマの中央に小さなドットを描き、「ここに生成できる」ことを示す控えめなヒント。 */
function renderEmptyPanelHint(panel: LayoutPanel): string {
  const center = shapeCenter(panel.shape);
  if (!center) {
    return "";
  }
  return `<circle class="page-panel-hint-dot" cx="${num(center[0])}" cy="${num(center[1])}" r="0.016" />`;
}

function renderSelectToolbar(lightbox: PagePanelLightboxState): string {
  const disabled = !lightbox.selectedPanelId;
  return `
    <footer class="page-panel-toolbar">
      <p class="page-panel-hint-text">コマをクリックして選択(ダブルクリックで生成 / クロップ編集)</p>
      <button class="button-primary page-panel-generate-button" type="button" data-action="generate-selected-panel" ${disabled ? "disabled" : ""}>${iconSparkle()}選択コマを生成</button>
    </footer>
  `;
}

function renderCropToolbar(): string {
  return `
    <footer class="page-panel-toolbar">
      <p class="page-panel-hint-text">画像をドラッグして表示位置を調整できます</p>
      <div class="page-panel-toolbar-actions">
        <button class="button-secondary compact" type="button" data-action="reset-panel-crop">リセット</button>
        <button class="button-primary compact" type="button" data-action="close-panel-crop">選択に戻る</button>
      </div>
    </footer>
  `;
}
