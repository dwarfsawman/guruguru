/**
 * コマ内生成(Docs/Feature-PanelGeneration.md)。ページのコマ選択/クロップ編集 lightbox の controller。
 * 開閉・シングル/ダブルクリック判定(asset カードの `scheduleAssetCardSelect` と同型)・
 * 「選択コマを生成」→ 生成 UI 遷移・クロップドラッグ(pointer down/move/up)を扱う。
 * data-action は `registerActions`、click の単/複判定と pointer drag は main.ts の委譲から呼ぶ
 * (`handleAssetCardClick` 等と同じ理由 -- lightbox は render/morph サイクルで再描画されるため
 * imageLightboxController.ts の直接 DOM 操作とは別方式)。
 */
import type { PagePanelAssignment, PageDetail, PageSummary } from "../shared/apiTypes";
import type { LayoutPanel, PanelCrop } from "../shared/pageLayout";
import { clampPanelCrop, defaultCoverCrop, panelBounds, panelBoundsSize } from "../shared/pageLayout";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { openPage } from "./bookController";
import { restoreGenerationDraftForRound, setGenerationDraftValue } from "./generationDraft";
import { roundToStep } from "./generationController";

/** コマ生成の目標解像度(この面積になるよう、コマの外接矩形アスペクト比から幅/高さを決める)。 */
const PANEL_TARGET_PIXEL_AREA = 1024 * 1024;
const LATENT_STEP = 8;

function currentLightboxPage(): PageSummary | null {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox) {
    return null;
  }
  return state.book?.pages.find((page) => page.id === lightbox.pageId) ?? null;
}

function findPanel(page: PageSummary | null | undefined, panelId: string | null): LayoutPanel | null {
  if (!page?.layout || !panelId) {
    return null;
  }
  return page.layout.panels.find((panel) => panel.id === panelId) ?? null;
}

/** ページのコマ選択 lightbox を開く(`page.layout` が無いページでは何もしない)。 */
export async function openPagePanelLightbox(pageId: string) {
  const page = state.book?.pages.find((item) => item.id === pageId);
  if (!page?.layout || !state.currentProjectId) {
    return;
  }
  state.pagePanelLightbox = { pageId, selectedPanelId: null, cropPanelId: null, cropDraft: null };
  state.pagePanelAssignments = [];
  requestRender();
  try {
    const detail = await api<PageDetail>(`/api/projects/${state.currentProjectId}/pages/${pageId}`);
    // 取得中に閉じられた/別ページへ切り替わっていたら結果を捨てる。
    if (state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    state.pagePanelAssignments = detail.panelAssignments;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

export function closePagePanelLightbox() {
  state.pagePanelLightbox = null;
  state.pagePanelAssignments = [];
  requestRender();
}

function closeCropEditor() {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox) {
    return;
  }
  lightbox.cropPanelId = null;
  lightbox.cropDraft = null;
  requestRender();
}

function selectPanel(panelId: string) {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.cropPanelId) {
    // クロップ編集中はシングルクリックでの選択切替を無視する(ドラッグ操作に専念させる)。
    return;
  }
  lightbox.selectedPanelId = panelId;
  requestRender();
}

function openCropEditorFor(panelId: string, assignment: PagePanelAssignment) {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox) {
    return;
  }
  lightbox.selectedPanelId = panelId;
  lightbox.cropPanelId = panelId;
  lightbox.cropDraft = { ...assignment.crop };
  requestRender();
}

function handlePanelDoubleClick(panelId: string) {
  const assignment = state.pagePanelAssignments.find((item) => item.panelId === panelId);
  if (assignment) {
    openCropEditorFor(panelId, assignment);
    return;
  }
  const lightbox = state.pagePanelLightbox;
  if (lightbox) {
    void generateForPanel(lightbox.pageId, panelId);
  }
}

let pendingPanelSelect: { panelId: string; timer: number } | null = null;

function schedulePanelSelect(panelId: string) {
  clearPendingPanelSelect();
  pendingPanelSelect = {
    panelId,
    timer: window.setTimeout(() => {
      pendingPanelSelect = null;
      selectPanel(panelId);
    }, 220)
  };
}

function clearPendingPanelSelect() {
  if (!pendingPanelSelect) {
    return;
  }
  window.clearTimeout(pendingPanelSelect.timer);
  pendingPanelSelect = null;
}

function panelIdFromEventTarget(target: EventTarget | null): string | null {
  const panelEl = target instanceof Element ? target.closest("[data-panel-id]") : null;
  return panelEl?.getAttribute("data-panel-id") ?? null;
}

/**
 * main.ts の click ハンドラから同じ優先順位で呼ばれる(`handleAssetCardClick` と同型)。
 * シングルクリックは遅延予約するだけで、ダブルクリックの実処理は `handlePagePanelDblClick`
 * (dblclick イベント)側が担う -- ここでは detail>=2 の2発目クリックを握り潰すだけにする
 * (dblclick はブラウザ既定のダブルクリック判定に委ね、detail の連続性に頼らない)。
 */
export function handlePagePanelClick(event: MouseEvent): boolean {
  if (!state.pagePanelLightbox) {
    return false;
  }
  const panelId = panelIdFromEventTarget(event.target);
  if (!panelId) {
    return false;
  }
  event.preventDefault();
  if (state.pagePanelLightbox.cropPanelId) {
    // クロップ編集モード中はコマクリックでの選択切替を無視する(ドラッグに専念)。
    return true;
  }
  if (event.detail >= 2) {
    clearPendingPanelSelect();
    return true;
  }
  schedulePanelSelect(panelId);
  return true;
}

/** main.ts の dblclick ハンドラから呼ばれる。未生成コマ→生成 UI、生成済みコマ→クロップ編集モード。 */
export function handlePagePanelDblClick(event: MouseEvent): boolean {
  if (!state.pagePanelLightbox || state.pagePanelLightbox.cropPanelId) {
    return false;
  }
  const panelId = panelIdFromEventTarget(event.target);
  if (!panelId) {
    return false;
  }
  event.preventDefault();
  clearPendingPanelSelect();
  handlePanelDoubleClick(panelId);
  return true;
}

/** main.ts の keydown ハンドラから呼ばれる。Escape は「クロップ編集→選択モード→閉じる」の順に1段ずつ戻す。 */
export function handlePagePanelLightboxKeydown(event: KeyboardEvent): boolean {
  if (!state.pagePanelLightbox || event.key !== "Escape") {
    return false;
  }
  event.preventDefault();
  if (state.pagePanelLightbox.cropPanelId) {
    closeCropEditor();
  } else {
    closePagePanelLightbox();
  }
  return true;
}

function resolutionForAspectRatio(aspect: number): { width: number; height: number } {
  if (!Number.isFinite(aspect) || aspect <= 0) {
    return { width: 1024, height: 1024 };
  }
  const height = Math.sqrt(PANEL_TARGET_PIXEL_AREA / aspect);
  const width = height * aspect;
  return {
    width: roundToStep(width, LATENT_STEP),
    height: roundToStep(height, LATENT_STEP)
  };
}

function applyPanelAspectToGenerationDraft(panel: LayoutPanel) {
  const [boxWidth, boxHeight] = panelBoundsSize(panelBounds(panel.shape));
  const { width, height } = resolutionForAspectRatio(boxWidth / boxHeight);
  setGenerationDraftValue("width", String(width));
  setGenerationDraftValue("height", String(height));
}

/** 「選択コマを生成」/ 未生成コマのダブルクリック共通: そのページ・コマを対象に生成 UI へ遷移する。 */
async function generateForPanel(pageId: string, panelId: string) {
  const page = state.book?.pages.find((item) => item.id === pageId);
  const panel = findPanel(page, panelId);
  closePagePanelLightbox();
  if (state.activePageId !== pageId) {
    await openPage(pageId);
  }
  state.activePanelTarget = { pageId, panelId };
  state.activeRoundId = state.detail?.rounds.find((round) => round.targetPanelId === panelId)?.id ?? null;
  state.activeAssetId = null;
  if (state.activeRoundId) {
    restoreGenerationDraftForRound(state.activeRoundId);
  }
  if (panel) {
    applyPanelAspectToGenerationDraft(panel);
  }
  requestRender();
}

function generateSelectedPanel() {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox?.selectedPanelId) {
    return;
  }
  void generateForPanel(lightbox.pageId, lightbox.selectedPanelId);
}

/** 生成フォームの「対象コマ」バッジの「対象を解除」ボタン。 */
function clearPanelTarget() {
  state.activePanelTarget = null;
  requestRender();
}

async function commitCropDraft(panelId: string) {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.cropPanelId !== panelId || !lightbox.cropDraft || !state.currentProjectId) {
    return;
  }
  const assignment = state.pagePanelAssignments.find((item) => item.panelId === panelId);
  if (!assignment) {
    return;
  }
  const crop = lightbox.cropDraft;
  try {
    const result = await api<{ assignment: PagePanelAssignment | null }>(
      `/api/projects/${state.currentProjectId}/pages/${lightbox.pageId}/panels/${panelId}/assignment`,
      { method: "PATCH", body: JSON.stringify({ assetId: assignment.assetId, crop }) }
    );
    if (result.assignment) {
      state.pagePanelAssignments = state.pagePanelAssignments.map((item) => (item.panelId === panelId ? result.assignment! : item));
    }
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
    requestRender();
  }
}

function resetPanelCrop() {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox?.cropPanelId) {
    return;
  }
  const assignment = state.pagePanelAssignments.find((item) => item.panelId === lightbox.cropPanelId);
  const panel = findPanel(currentLightboxPage(), lightbox.cropPanelId);
  if (!assignment || !panel) {
    return;
  }
  const [boxWidth, boxHeight] = panelBoundsSize(panelBounds(panel.shape));
  lightbox.cropDraft = defaultCoverCrop(assignment.assetWidth ?? 0, assignment.assetHeight ?? 0, boxWidth, boxHeight);
  requestRender();
  void commitCropDraft(lightbox.cropPanelId);
}

// --- クロップ編集のドラッグ(pointer events で自前実装。ページ並び替えの pageReorder と同型) ---

interface CropDragState {
  pointerId: number;
  panelId: string;
  startX: number;
  startY: number;
  startCrop: PanelCrop;
  boxWidth: number;
  boxHeight: number;
  /** 画面px → SVG正規化座標1単位あたりの px 数。getScreenCTM 由来なので、ダイアログの実際の
   * 表示サイズや `preserveAspectRatio` によるレターボックスに関係なく常に正確(CSS の
   * aspect-ratio 目算に頼らない)。 */
  pxPerUnit: number;
}

let cropDrag: CropDragState | null = null;

/** main.ts の pointerdown 委譲から呼ばれる。クロップ編集モード中の対象画像レイヤーへの操作だけを扱う。 */
export function handlePagePanelCropPointerDown(event: PointerEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox?.cropPanelId || !lightbox.cropDraft) {
    return false;
  }
  const target = event.target;
  const layer = target instanceof Element ? target.closest(`[data-crop-drag-panel="${lightbox.cropPanelId}"]`) : null;
  const panel = findPanel(currentLightboxPage(), lightbox.cropPanelId);
  if (!layer || !panel || !(layer instanceof SVGGraphicsElement)) {
    return false;
  }
  const ctm = layer.getScreenCTM();
  if (!ctm || !ctm.a) {
    return false;
  }
  event.preventDefault();
  const [boxWidth, boxHeight] = panelBoundsSize(panelBounds(panel.shape));
  cropDrag = {
    pointerId: event.pointerId,
    panelId: lightbox.cropPanelId,
    startX: event.clientX,
    startY: event.clientY,
    startCrop: { ...lightbox.cropDraft },
    boxWidth,
    boxHeight,
    pxPerUnit: ctm.a
  };
  try {
    layer.setPointerCapture(event.pointerId);
  } catch {
    // capture に失敗しても pointermove/up は app への委譲で届く。
  }
  return true;
}

export function handlePagePanelCropPointerMove(event: PointerEvent): boolean {
  if (!cropDrag || event.pointerId !== cropDrag.pointerId) {
    return false;
  }
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.cropPanelId !== cropDrag.panelId) {
    cropDrag = null;
    return false;
  }
  const dxPage = (event.clientX - cropDrag.startX) / cropDrag.pxPerUnit;
  const dyPage = (event.clientY - cropDrag.startY) / cropDrag.pxPerUnit;
  const dxAsset = dxPage * (cropDrag.startCrop.width / cropDrag.boxWidth);
  const dyAsset = dyPage * (cropDrag.startCrop.height / cropDrag.boxHeight);
  lightbox.cropDraft = clampPanelCrop({
    x: cropDrag.startCrop.x - dxAsset,
    y: cropDrag.startCrop.y - dyAsset,
    width: cropDrag.startCrop.width,
    height: cropDrag.startCrop.height
  });
  requestRender();
  return true;
}

function finishCropDrag(event: PointerEvent, commit: boolean): boolean {
  if (!cropDrag || event.pointerId !== cropDrag.pointerId) {
    return false;
  }
  const panelId = cropDrag.panelId;
  cropDrag = null;
  if (commit) {
    void commitCropDraft(panelId);
  }
  return true;
}

export function handlePagePanelCropPointerUp(event: PointerEvent): boolean {
  return finishCropDrag(event, true);
}

export function handlePagePanelCropPointerCancel(event: PointerEvent): boolean {
  return finishCropDrag(event, false);
}

registerActions({
  "open-page-panels": (id) => openPagePanelLightbox(id),
  "close-page-panels": () => closePagePanelLightbox(),
  "generate-selected-panel": () => generateSelectedPanel(),
  "close-panel-crop": () => closeCropEditor(),
  "reset-panel-crop": () => resetPanelCrop(),
  "clear-panel-target": () => clearPanelTarget()
});
