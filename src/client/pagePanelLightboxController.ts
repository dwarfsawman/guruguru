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
import {
  clampPanelCrop,
  defaultCoverCrop,
  normalizeRotation,
  panelBounds,
  panelBoundsSize,
  scaleCropAboutCenter
} from "../shared/pageLayout";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { openPage, reloadBookPages } from "./bookController";
import { restoreGenerationDraftForRound, setGenerationDraftValue } from "./generationDraft";
import { roundToStep } from "./generationController";
import { cropRotateHandlePoint } from "./views/pagePanelLightboxView";

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

/** クロップを編集(commit)した後 true。lightbox を閉じる時にページ一覧プレビューを最新化する目印。 */
let panelPreviewDirty = false;

export function closePagePanelLightbox() {
  const wasDirty = panelPreviewDirty;
  panelPreviewDirty = false;
  state.pagePanelLightbox = null;
  state.pagePanelAssignments = [];
  requestRender();
  // クロップ編集があった場合だけ、ページ一覧の preview.png?v=... を最新化するため再取得する。
  if (wasDirty) {
    void reloadBookPages();
  }
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
  const lightbox = state.pagePanelLightbox;
  if (!lightbox) {
    return false;
  }
  if (lightbox.cropPanelId) {
    // クロップ編集中: 枠外(画像・ギズモハンドル以外)のダブルクリックで編集を抜ける(「選択に戻る」相当)。
    const target = event.target;
    const onInteractive =
      target instanceof Element && target.closest("[data-crop-drag-panel], [data-crop-handle]");
    if (!onInteractive) {
      event.preventDefault();
      clearPendingPanelSelect();
      closeCropEditor();
      return true;
    }
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
    // 保存できたので、閉じる時にページ一覧のコマ割りプレビューを最新化する。
    panelPreviewDirty = true;
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

// --- クロップ編集のジェスチャ(pointer events で自前実装。参照画像貼り付けと同型) ---
// パン(本体ドラッグ)/ 拡縮(コーナーハンドル)/ 回転(上ハンドル)。座標は正規化ページ座標で扱い、
// 画面px↔正規化は getScreenCTM に一本化する(CSS aspect-ratio 目算に頼らない)。

type CropGestureKind = "pan" | "scale" | "rotate";

/** 回転の Shift スナップ刻み(15°)。 */
const ROTATE_SNAP_RAD = Math.PI / 12;

interface CropDragState {
  pointerId: number;
  panelId: string;
  kind: CropGestureKind;
  startX: number;
  startY: number;
  startCrop: PanelCrop;
  boxWidth: number;
  boxHeight: number;
  /** 画面px → SVG正規化座標1単位あたりの px 数(ctm.a)。 */
  pxPerUnit: number;
  /** パネル外接矩形中心の画面px座標(拡縮/回転の基準)。 */
  centerScreenX: number;
  centerScreenY: number;
  /** 拡縮開始時の「中心→ポインタ」距離(px)。 */
  startDist: number;
  /** 回転開始時の「中心→ポインタ」角度(rad)。 */
  startAngle: number;
}

let cropDrag: CropDragState | null = null;

/** クロップ編集中の対象画像レイヤー(getScreenCTM の取得元)。ハンドルでも本体でも同じ座標系。 */
function cropCtmElement(): SVGGraphicsElement | null {
  const el = document.querySelector<SVGGraphicsElement>("[data-crop-drag-panel]");
  return el instanceof SVGGraphicsElement ? el : null;
}

/** main.ts の pointerdown 委譲から呼ばれる。ギズモハンドル(拡縮/回転)と本体(パン)を切り分ける。 */
export function handlePagePanelCropPointerDown(event: PointerEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox?.cropPanelId || !lightbox.cropDraft) {
    return false;
  }
  const target = event.target;
  const handle = target instanceof Element ? target.closest<SVGElement>("[data-crop-handle]") : null;
  const onBody = target instanceof Element ? target.closest(`[data-crop-drag-panel="${lightbox.cropPanelId}"]`) : null;
  if (!handle && !onBody) {
    return false;
  }
  const panel = findPanel(currentLightboxPage(), lightbox.cropPanelId);
  const ctmEl = cropCtmElement();
  const ctm = ctmEl?.getScreenCTM() ?? null;
  if (!panel || !ctm || !ctm.a) {
    return false;
  }
  event.preventDefault();
  const kind: CropGestureKind = handle?.getAttribute("data-crop-handle") === "scale" ? "scale" : handle?.getAttribute("data-crop-handle") === "rotate" ? "rotate" : "pan";

  // 回転ハンドルのダブルクリック = 0° リセット(paste の前例に倣う)。
  if (kind === "rotate" && event.detail >= 2) {
    lightbox.cropDraft = clampPanelCrop({ ...lightbox.cropDraft, rotation: 0 });
    requestRender();
    void commitCropDraft(lightbox.cropPanelId);
    return true;
  }

  const bounds = panelBounds(panel.shape);
  const [boxWidth, boxHeight] = panelBoundsSize(bounds);
  const centerX = (bounds[0] + bounds[2]) / 2;
  const centerY = (bounds[1] + bounds[3]) / 2;
  const centerScreenX = ctm.a * centerX + ctm.c * centerY + ctm.e;
  const centerScreenY = ctm.b * centerX + ctm.d * centerY + ctm.f;
  const dx = event.clientX - centerScreenX;
  const dy = event.clientY - centerScreenY;
  cropDrag = {
    pointerId: event.pointerId,
    panelId: lightbox.cropPanelId,
    kind,
    startX: event.clientX,
    startY: event.clientY,
    startCrop: { ...lightbox.cropDraft },
    boxWidth,
    boxHeight,
    pxPerUnit: ctm.a,
    centerScreenX,
    centerScreenY,
    startDist: Math.hypot(dx, dy),
    startAngle: Math.atan2(dy, dx)
  };
  const captureTarget = handle ?? (onBody instanceof Element ? onBody : null);
  if (captureTarget && "setPointerCapture" in captureTarget) {
    try {
      (captureTarget as SVGElement).setPointerCapture(event.pointerId);
    } catch {
      // capture に失敗しても pointermove/up は app への委譲で届く。
    }
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
  if (cropDrag.kind === "pan") {
    lightbox.cropDraft = panGestureCrop(cropDrag, event);
  } else if (cropDrag.kind === "scale") {
    const dist = Math.hypot(event.clientX - cropDrag.centerScreenX, event.clientY - cropDrag.centerScreenY);
    // ポインタが中心から遠ざかる = ズームイン = 窓を小さく。factor = startDist / dist。
    const factor = cropDrag.startDist / Math.max(1, dist);
    lightbox.cropDraft = scaleCropAboutCenter(cropDrag.startCrop, factor);
  } else {
    const angle = Math.atan2(event.clientY - cropDrag.centerScreenY, event.clientX - cropDrag.centerScreenX);
    let rotation = (cropDrag.startCrop.rotation ?? 0) + (angle - cropDrag.startAngle);
    if (event.shiftKey) {
      rotation = Math.round(rotation / ROTATE_SNAP_RAD) * ROTATE_SNAP_RAD;
    }
    lightbox.cropDraft = clampPanelCrop({ ...cropDrag.startCrop, rotation: normalizeRotation(rotation) });
  }
  requestRender();
  return true;
}

/** パン: 画面デルタを画像の回転に合わせて image 軸へ回してから crop の x/y に反映する。 */
function panGestureCrop(drag: CropDragState, event: PointerEvent): PanelCrop {
  const dxPage = (event.clientX - drag.startX) / drag.pxPerUnit;
  const dyPage = (event.clientY - drag.startY) / drag.pxPerUnit;
  const rotation = drag.startCrop.rotation ?? 0;
  // 画面デルタを -rotation 回転して image 軸のデルタにする(無回転なら恒等)。
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const imgDx = dxPage * cos + dyPage * sin;
  const imgDy = -dxPage * sin + dyPage * cos;
  const dxAsset = imgDx * (drag.startCrop.width / drag.boxWidth);
  const dyAsset = imgDy * (drag.startCrop.height / drag.boxHeight);
  return clampPanelCrop({
    x: drag.startCrop.x - dxAsset,
    y: drag.startCrop.y - dyAsset,
    width: drag.startCrop.width,
    height: drag.startCrop.height,
    rotation
  });
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

/** main.ts の wheel 委譲から呼ばれる。クロップ編集中のホイールでズーム(拡大縮小)する。 */
export function handlePagePanelCropWheel(event: WheelEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox?.cropPanelId || !lightbox.cropDraft) {
    return false;
  }
  const target = event.target;
  const insideStage = target instanceof Element ? target.closest(".page-panel-stage") : null;
  if (!insideStage) {
    return false;
  }
  event.preventDefault();
  // 上スクロール(deltaY<0)= ズームイン = 窓を小さく。
  const factor = event.deltaY < 0 ? 0.92 : 1 / 0.92;
  lightbox.cropDraft = scaleCropAboutCenter(lightbox.cropDraft, factor);
  requestRender();
  scheduleCropWheelCommit(lightbox.cropPanelId);
  return true;
}

// ホイールズームは連続で来るので、止まってから 1 回だけ PATCH 保存する。
let cropWheelCommitTimer: number | null = null;
function scheduleCropWheelCommit(panelId: string) {
  if (cropWheelCommitTimer !== null) {
    window.clearTimeout(cropWheelCommitTimer);
  }
  cropWheelCommitTimer = window.setTimeout(() => {
    cropWheelCommitTimer = null;
    void commitCropDraft(panelId);
  }, 400);
}

/**
 * render ループ末尾から呼ばれ、ギズモのハンドル半径・回転ハンドルの柄長を画面基準の一定サイズへ直す
 * (paste の `syncPasteGizmo` と同型)。ハンドル位置自体は render が crop draft から出すのでここでは触らない。
 */
export function syncPagePanelCropGizmo(): void {
  const gizmo = document.querySelector<SVGGElement>("#pagePanelGizmo");
  if (!gizmo) {
    return;
  }
  const ctm = gizmo.getScreenCTM();
  if (!ctm || !ctm.a) {
    return;
  }
  const unitPerPx = 1 / ctm.a;
  const radius = GIZMO_HANDLE_SCREEN_RADIUS_PX * unitPerPx;
  const stick = GIZMO_ROTATE_STICK_SCREEN_PX * unitPerPx;
  const topMidX = Number(gizmo.dataset.tmx);
  const topMidY = Number(gizmo.dataset.tmy);
  const upX = Number(gizmo.dataset.upx);
  const upY = Number(gizmo.dataset.upy);
  const pageHeight = Number(gizmo.dataset.ph);
  for (let i = 0; i < 4; i += 1) {
    gizmo.querySelector<SVGCircleElement>(`#pagePanelGizmoCorner${i}`)?.setAttribute("r", String(radius));
  }
  const rotateHandle = gizmo.querySelector<SVGCircleElement>("#pagePanelGizmoRotate");
  const stickLine = gizmo.querySelector<SVGLineElement>("#pagePanelGizmoStick");
  if ([topMidX, topMidY, upX, upY, pageHeight].every(Number.isFinite)) {
    // render と同じ反転ロジックで、画面基準の柄長を使ってハンドル位置を確定する(最上段コマでも掴める)。
    const [handleX, handleY] = cropRotateHandlePoint([topMidX, topMidY], [upX, upY], stick, pageHeight);
    rotateHandle?.setAttribute("cx", String(handleX));
    rotateHandle?.setAttribute("cy", String(handleY));
    rotateHandle?.setAttribute("r", String(radius));
    stickLine?.setAttribute("x2", String(handleX));
    stickLine?.setAttribute("y2", String(handleY));
  }
}

/** ハンドルの画面基準サイズ(px)。paste の PASTE_HANDLE_SCREEN_RADIUS 相当。 */
const GIZMO_HANDLE_SCREEN_RADIUS_PX = 7;
const GIZMO_ROTATE_STICK_SCREEN_PX = 30;

registerActions({
  "open-page-panels": (id) => openPagePanelLightbox(id),
  "close-page-panels": () => closePagePanelLightbox(),
  "generate-selected-panel": () => generateSelectedPanel(),
  "close-panel-crop": () => closeCropEditor(),
  "reset-panel-crop": () => resetPanelCrop(),
  "clear-panel-target": () => clearPanelTarget()
});
