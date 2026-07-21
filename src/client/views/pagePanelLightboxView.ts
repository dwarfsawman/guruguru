/**
 * ページ編集 lightbox(Docs/Feature-CGCollectionSuite.md P1 でモードタブ付きに拡張)。
 * 「コマ」モード(コマ内生成。Docs/Feature-PanelGeneration.md): シングルクリックでコマ選択 →
 *   「選択コマを生成」で生成 UI へ。ダブルクリックは補助導線(未生成コマ→生成 UI、生成済みコマ→クロップ編集)。
 *   クロップ編集モード: 対象コマの画像をパン/拡大縮小/回転でき(他コマは非活性で dimmed)、pointerup で保存する。
 *   参照画像貼り付け(Paste & Transform)と同型の UX。編集中は「スポットライト」表示にする
 *   -- 元画像全体を薄く(ghost)出し、コマ形状にクリップした明画像を重ねて「コマ領域だけ濃く」見せ、
 *   その上に paste 風ギズモ(コーナー=拡縮 / 上のハンドル=回転)を描く。
 *   **この「コマ」モードの描画/挙動は P1 で一切変更していない**(既存コードをそのまま関数抽出しただけ)。
 * 「オブジェクト」モード: box(P1)/text(P2)/balloon(P3)オブジェクトの追加/選択/移動/拡縮/回転/削除/
 *   z順/プロパティ編集。`page.layout` が無いページ(1枚絵)でも開け、その場合はタブ自体を出さず
 *   オブジェクトモード固定にする。
 * 座標は pageLayoutSvg.ts と同じ width-relative 正規化(x∈[0,1], y∈[0,page.height])。
 */
import type { FontSummary, PagePanelAssignment, PageSummary } from "../../shared/apiTypes";
import type { PageObject } from "../../shared/pageObjects";
import type { PagePanelLightboxState } from "../appState";
import { escapeAttr, escapeHtml } from "../format";
import { iconClose } from "../icons";
import { num } from "./pageLayoutSvg";
import type { ChronicleBarViewState } from "./chronicleBarView";
import { VIEWBOX_SCALE, type PageLayerViewState } from "./lightboxViewShared";
import { renderPanelsStageContent } from "./pagePanelCropView";
import { renderShapesStageContent, renderShapesToolbar, type PanelShapeEditViewState } from "./pageShapeEditView";
import { renderMosaicStageContent, renderMosaicToolbar, type MosaicEditViewState } from "./pageMosaicView";
import { renderObjectsStageContent } from "./pageObjectsStageView";
import { renderObjectsToolbar, type ImageObjectViewState } from "./pageObjectsSidebarView";
import type { DialogueDrawerViewState } from "./dialogueDrawerView";

// 分割前からの外部 import(コントローラ等)を維持するための re-export。
export { cropRotateHandlePoint } from "./pagePanelCropView";
export { pageObjectGizmoViewBounds } from "./pageObjectsStageView";
export type { PageLayerViewState } from "./lightboxViewShared";
export type { PanelShapeEditViewState } from "./pageShapeEditView";
export type { MosaicEditViewState } from "./pageMosaicView";
export type { ImageObjectViewState } from "./pageObjectsSidebarView";
export type { DialogueDrawerViewState } from "./dialogueDrawerView";

export function renderPagePanelLightbox(
  page: PageSummary,
  lightbox: PagePanelLightboxState,
  assignments: PagePanelAssignment[],
  objects: PageObject[],
  selectedObjectIds: string[],
  fonts: FontSummary[],
  shapeEdit: PanelShapeEditViewState,
  mosaicEdit: MosaicEditViewState,
  imageObjects: ImageObjectViewState,
  dialogueDrawer: DialogueDrawerViewState,
  layerView: PageLayerViewState,
  chronicleBar: ChronicleBarViewState
): string {
  if (lightbox.pageId !== page.id) {
    return "";
  }
  // コマ枠編集は `state.pageLayoutDraft`(shapeEdit.layout)に対して行われ、`page.layout`(book 一覧)へは
  // debounce PATCH の応答時にしか書き戻らない。保存前にタブを切り替えても編集結果が見えるよう、
  // lightbox 内の描画は常にドラフトを優先する(ドラフトは open 時に page.layout から clone される)。
  const layout = shapeEdit.layout ?? page.layout ?? null;
  // レイアウトの無いページ(1枚絵)は "objects"/"mosaic" のみ開ける(呼び出し側が open 時に決める)。
  const mode = layout ? (lightbox.mode === "panels" ? "objects" : lightbox.mode) : lightbox.mode === "mosaic" ? "mosaic" : "objects";
  const label = page.title.trim() || "ページ";
  const pageHeight = lightbox.pageHeight;
  const cropActive = mode === "objects" && Boolean(layout && lightbox.cropPanelId);

  const stageContent =
    cropActive && layout
      ? renderPanelsStageContent(layout, lightbox, assignments)
      : mode === "shapes" && layout
        ? renderShapesStageContent(shapeEdit, pageHeight)
        : mode === "mosaic"
          ? renderMosaicStageContent(mosaicEdit, pageHeight)
          : renderObjectsStageContent(
              objects,
              selectedObjectIds,
              pageHeight,
              layout,
              assignments,
              imageObjects.missingMediaIds,
              lightbox.selectedPanelId,
              layerView,
              chronicleBar.preview?.objects ?? []
            );
  const toolbar =
    mode === "shapes" && layout
        ? renderShapesToolbar(shapeEdit)
        : mode === "mosaic"
          ? renderMosaicToolbar(mosaicEdit)
          : renderObjectsToolbar(objects, selectedObjectIds, fonts, layout, assignments, lightbox, imageObjects, dialogueDrawer, layerView, chronicleBar);

  return `
    <div class="workflow-modal page-panel-lightbox" role="dialog" aria-modal="true" aria-label="${escapeAttr(label)} のページ編集">
      <section class="workflow-dialog page-panel-dialog">
        <header class="workflow-dialog-header">
          <div>
            <p class="section-kicker">Book · ページ編集</p>
            <h2>${escapeHtml(label)}</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-page-panels" aria-label="閉じる" title="閉じる">${iconClose()}</button>
        </header>
        ${renderModeTabs(lightbox, Boolean(layout))}
        <div class="page-panel-editor-body">
          <div class="page-panel-stage" style="aspect-ratio: 1 / ${num(pageHeight)}">
            <svg class="page-panel-svg" viewBox="0 0 ${VIEWBOX_SCALE} ${num(VIEWBOX_SCALE * pageHeight)}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"${mode === "objects" && !cropActive ? ` data-page-object-stage="1"` : ""}>
              ${stageContent}
            </svg>
          </div>
          <aside class="page-panel-sidebar" aria-label="ページ編集サイドバー">
            <div class="page-panel-sidebar-scroll">
              ${toolbar}
            </div>
          </aside>
        </div>
      </section>
    </div>
  `;
}

/**
 * コマ/オブジェクト/コマ枠/モザイクのモードタブ。レイアウト無しページは「オブジェクト」「モザイク」の
 * 2つだけを出す(P1/P6: 1枚絵ページでもオブジェクト/モザイク編集は必要)。
 */
function renderModeTabs(lightbox: PagePanelLightboxState, hasLayout: boolean): string {
  const tab = (mode: "panels" | "objects" | "shapes" | "mosaic", labelText: string) =>
    `<button type="button" class="page-panel-mode-tab${lightbox.mode === mode ? " is-active" : ""}" data-action="set-page-panel-mode" data-id="${mode}" role="tab" aria-selected="${lightbox.mode === mode ? "true" : "false"}">${escapeHtml(labelText)}</button>`;
  if (!hasLayout) {
    return `<div class="page-panel-mode-tabs" role="tablist">${tab("objects", "レイヤ")}${tab("mosaic", "モザイク")}</div>`;
  }
  return `<div class="page-panel-mode-tabs" role="tablist">${tab("objects", "レイヤ")}${tab("shapes", "コマ枠")}${tab("mosaic", "モザイク")}</div>`;
}
