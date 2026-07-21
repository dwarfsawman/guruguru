/**
 * コマ内生成(Docs/Feature-PanelGeneration.md)。ページのコマ選択/クロップ編集 lightbox の controller。
 * 開閉・シングル/ダブルクリック判定(asset カードの `scheduleAssetCardSelect` と同型)・
 * 「選択コマを生成」→ 生成 UI 遷移・クロップドラッグ(pointer down/move/up)を扱う。
 * data-action は `registerActions`、click の単/複判定と pointer drag は main.ts の委譲から呼ぶ
 * (`handleAssetCardClick` 等と同じ理由 -- lightbox は render/morph サイクルで再描画されるため
 * imageLightboxController.ts の直接 DOM 操作とは別方式)。
 */
import type {
  AdoptDialogueProposalResult,
  CreateDialogueProposalResult,
  CreatePlacementResult,
  DialogueLine,
  DialogueProposal,
  PagePanelAssignment,
  PageDetail,
  PageSummary
} from "../shared/apiTypes";
import type { LayoutPanel, PanelCrop } from "../shared/pageLayout";
import {
  clampPanelCrop,
  clonePageLayout,
  defaultCoverCrop,
  normalizeRotation,
  panelBounds,
  panelBoundsSize,
  panelImageRect,
  scaleCropAboutCenter
} from "../shared/pageLayout";
import { api } from "./api";
import { createDragSession } from "./dragSession";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { openPage, reloadBookPages } from "./bookController";
import { restoreGenerationDraftForRound, setGenerationDraftValue } from "./generationDraft";
import { roundToStep } from "./generationController";
import { cropRotateHandlePoint } from "./views/pagePanelLightboxView";
import {
  consumePageObjectsDirtyFlag,
  ensureAllPageObjectTextLayouts,
  ensureFontsLoaded,
  flushPageObjectsSave,
  markPageObjectsDirty,
  resetPageObjectsSession
} from "./pageObjectsController";
import { consumeShapeEditDirtyFlag, flushShapeEditSave, resetShapeEditSession } from "./panelShapeController";
import { consumeMosaicDirtyFlag, flushMosaicEditSave, resetMosaicEditSession } from "./pageMosaicController";
import { closeChronicle, openChronicleForPage } from "./chronicleController";

/** レイアウト/代表アセットどちらからも解決できない時のページ高さフォールバック(A4 縦比に近い値。pageLayout.ts の resolveHeight と同じ値)。 */
const FALLBACK_PAGE_HEIGHT = 1.4142;

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
  // コマ枠編集の未保存分も含む最新形状で扱えるよう、lightbox 表示中はドラフトを優先する
  // (ビュー側 renderPagePanelLightbox と同じ優先順位。ドラフトが無いページは book 側 layout)。
  const layout = state.pageLayoutDraft ?? page?.layout ?? null;
  if (!layout || !panelId) {
    return null;
  }
  return layout.panels.find((panel) => panel.id === panelId) ?? null;
}

/**
 * ページのコマ選択/オブジェクト編集 lightbox を開く。`page.layout` の有無に関わらず開ける
 * (Docs/Feature-CGCollectionSuite.md P1: レイアウトの無い1枚絵ページでもオブジェクト編集は必要)。
 * 既定モードはレイアウトの有無にかかわらず、コマ画像とオブジェクトを合成表示する "objects"。
 */
export async function openPagePanelLightbox(pageId: string) {
  const page = state.book?.pages.find((item) => item.id === pageId);
  const projectId = state.currentProjectId;
  if (!page || !projectId) {
    return;
  }
  state.pagePanelLightbox = {
    pageId,
    mode: "objects",
    selectedPanelId: null,
    cropPanelId: null,
    cropDraft: null,
    pageHeight: page.layout?.page.height ?? FALLBACK_PAGE_HEIGHT
  };
  state.pagePanelAssignments = [];
  state.pageObjectsDraft = [];
  state.selectedPageObjectIds = [];
  state.pageLayerHiddenObjectIds = [];
  state.pageLayerHiddenPanelIds = [];
  state.pageLayerHideNonImage = false;
  state.pagePanelLightboxAssets = [];
  state.pagePanelLightboxMissingMediaIds = [];
  state.pageObjectImagePicker = null;
  state.pageLayoutDraft = page.layout ? clonePageLayout(page.layout) : null;
  state.shapeSelectedPanelId = null;
  state.shapeSelectedVertexIndex = null;
  state.shapeSplitMode = false;
  state.shapeSplitDraft = null;
  state.pageMosaicDraft = [];
  state.mosaicSelectedRegionId = null;
  state.mosaicSelectedVertexIndex = null;
  state.mosaicAddMode = null;
  state.mosaicRectDraft = null;
  state.mosaicPolygonDraft = null;
  state.dialogueDrawerOpen = false;
  state.pagePanelLightboxDialogueLines = [];
  state.dialogueProposals = [];
  state.dialogueProposalBusy = false;
  state.dialogueProposalRequestPageId = null;
  resetPageObjectsSession();
  resetShapeEditSession();
  resetMosaicEditSession();
  if (state.pagePanelLightbox.mode === "objects") {
    ensureFontsLoaded();
  }
  requestRender();
  void openChronicleForPage(projectId, pageId);
  try {
    const detail = await api<PageDetail>(`/api/projects/${projectId}/pages/${pageId}`);
    // 取得中に閉じられた/別ページへ切り替わっていたら結果を捨てる。
    if (state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    state.pagePanelAssignments = detail.panelAssignments;
    state.pageObjectsDraft = detail.page.objects ?? [];
    state.pageMosaicDraft = detail.page.mosaic ?? [];
    state.pagePanelLightboxAssets = detail.assets;
    state.pagePanelLightboxMissingMediaIds = detail.missingPageMediaIds;
    if (detail.page.layout) {
      state.pageLayoutDraft = clonePageLayout(detail.page.layout);
    }
    state.pagePanelLightbox.pageHeight = resolveLightboxPageHeight(detail, page);
    ensureAllPageObjectTextLayouts(state.pageObjectsDraft);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

/**
 * オブジェクトモードの座標系で使うページ高さ。レイアウトがあればその `page.height`、
 * 無ければ代表アセット(`page.representativeAssetId`)のアスペクト比から求める。
 */
function resolveLightboxPageHeight(detail: PageDetail, pageSummary: PageSummary): number {
  if (detail.page.layout) {
    return detail.page.layout.page.height;
  }
  const assetId = pageSummary.representativeAssetId;
  const asset = assetId ? detail.assets.find((item) => item.id === assetId) : null;
  if (asset?.width && asset?.height && asset.width > 0 && asset.height > 0) {
    return asset.height / asset.width;
  }
  return FALLBACK_PAGE_HEIGHT;
}

/** クロップ/オブジェクトを編集(commit)した後 true。lightbox を閉じる時にページ一覧プレビューを最新化する目印。 */
let panelPreviewDirty = false;

export function closePagePanelLightbox() {
  // flush は state クリアの前に呼ぶ(persistPageObjects/persistShapeLayout/persistMosaicRegions は
  // 呼び出しと同期に pageId/送信ボディを確定するので、この後 state をクリアしても PATCH 自体は完走する)。
  // 完了は下の async ブロックで待つ。
  const flushObjectsPromise = flushPageObjectsSave();
  const flushShapePromise = flushShapeEditSave();
  const flushMosaicPromise = flushMosaicEditSave();
  const wasCropDirty = panelPreviewDirty;
  panelPreviewDirty = false;
  state.pagePanelLightbox = null;
  state.pagePanelAssignments = [];
  state.pageObjectsDraft = [];
  state.selectedPageObjectIds = [];
  state.pageLayerHiddenObjectIds = [];
  state.pageLayerHiddenPanelIds = [];
  state.pageLayerHideNonImage = false;
  state.pagePanelLightboxAssets = [];
  state.pagePanelLightboxMissingMediaIds = [];
  state.pageObjectImagePicker = null;
  state.pageLayoutDraft = null;
  state.shapeSelectedPanelId = null;
  state.shapeSelectedVertexIndex = null;
  state.shapeSplitMode = false;
  state.shapeSplitDraft = null;
  state.shapeAddVertexMode = false;
  state.shapeActiveGeometry = null;
  state.pageMosaicDraft = [];
  state.mosaicSelectedRegionId = null;
  state.mosaicSelectedVertexIndex = null;
  state.mosaicAddMode = null;
  state.mosaicRectDraft = null;
  state.mosaicPolygonDraft = null;
  state.dialogueDrawerOpen = false;
  state.pagePanelLightboxDialogueLines = [];
  state.dialogueProposals = [];
  state.dialogueProposalBusy = false;
  state.dialogueProposalRequestPageId = null;
  closeChronicle();
  requestRender();
  // クロップ/オブジェクト/コマ形状/モザイク編集があった場合だけ、ページ一覧の preview.png?v=... を
  // 最新化するため再取得する。dirty 判定は flush(クローズ直前1秒以内の編集の PATCH)完了後に
  // 読むこと -- 完了前に読むと false のままスキップされ、PATCH 前の古い `?v=` を拾ってしまう。
  void (async () => {
    await Promise.all([flushObjectsPromise, flushShapePromise, flushMosaicPromise]);
    if (wasCropDirty || consumePageObjectsDirtyFlag() || consumeShapeEditDirtyFlag() || consumeMosaicDirtyFlag()) {
      await reloadBookPages();
    }
  })();
}

/**
 * ページ編集モードタブ(コマ/オブジェクト/コマ枠/モザイク)の切り替え。`chronicleController.ts` の
 * 「Beat から対応吹き出しへジャンプ」(§2.6 フェーズIV相互選択ジャンプ)がオブジェクトモードへ
 * 強制切替するために export する。
 */
export function setPagePanelMode(mode: string) {
  const lightbox = state.pagePanelLightbox;
  const nextMode = mode === "panels" ? "objects" : mode;
  if (!lightbox || (nextMode !== "objects" && nextMode !== "shapes" && nextMode !== "mosaic") || lightbox.mode === nextMode) {
    return;
  }
  lightbox.mode = nextMode;
  if (nextMode === "objects") {
    ensureFontsLoaded();
    ensureAllPageObjectTextLayouts(state.pageObjectsDraft);
  }
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
  state.selectedPageObjectIds = [];
  state.dialogueDrawerOpen = false;
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

function editSelectedPanelCrop() {
  const panelId = state.pagePanelLightbox?.selectedPanelId;
  const assignment = panelId ? state.pagePanelAssignments.find((item) => item.panelId === panelId) : null;
  if (panelId && assignment) {
    openCropEditorFor(panelId, assignment);
  }
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
 * クロップ編集中は、対象画像/ギズモ/操作 UI 以外のシングルクリック(紙面の余白・ステージ外・
 * 背景など)で編集を抜けて選択モードへ戻す。
 */
export function handlePagePanelClick(event: MouseEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox) {
    return false;
  }
  if (lightbox.cropPanelId) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-action], input, select, textarea, label")) {
      // ツールバーのボタン等は通常の data-action 委譲(main.ts)に流す。
      return false;
    }
    if (target?.closest("[data-crop-drag-panel], [data-crop-handle], [data-panel-id]")) {
      // 対象画像/ギズモ上のクリック(パン等ドラッグの一環)とコマクリックは無視する(ドラッグに専念)。
      event.preventDefault();
      return true;
    }
    // 枠外のシングルクリックで編集を抜ける(「選択に戻る」相当。dblclick 側の既存導線と同じ判定思想)。
    event.preventDefault();
    clearPendingPanelSelect();
    closeCropEditor();
    return true;
  }
  const panelId = panelIdFromEventTarget(event.target);
  if (!panelId) {
    return false;
  }
  event.preventDefault();
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

/**
 * main.ts のバックドロップ(`.page-panel-lightbox` 自身)クリックから呼ばれる。
 * Escape と同じ段階的挙動: クロップ編集中なら編集を抜けるだけにし、そうでなければ lightbox を閉じる。
 */
export function handlePagePanelLightboxBackdropClick(): void {
  if (state.pagePanelLightbox?.cropPanelId) {
    closeCropEditor();
  } else {
    closePagePanelLightbox();
  }
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

interface CropDragData {
  panelId: string;
  kind: CropGestureKind;
  startX: number;
  startY: number;
  startCrop: PanelCrop;
  boxWidth: number;
  boxHeight: number;
  /** ドラッグ開始時の描画矩形(page 単位、panelImageRect)。パンの px→crop 換算に使う。 */
  drawnWidth: number;
  drawnHeight: number;
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

// pointerId 照合・setPointerCapture/release・up/cancel でのクリアは createDragSession(dragSession.ts)へ委譲。
const cropSession = createDragSession<CropDragData>({
  onMove: (event, drag) => {
    const lightbox = state.pagePanelLightbox;
    if (!lightbox || lightbox.cropPanelId !== drag.panelId) {
      // 対象パネルが変わった: セッションを破棄して「未処理」として後続チェーンへ流す(従来挙動)。
      return false;
    }
    if (drag.kind === "pan") {
      lightbox.cropDraft = panGestureCrop(drag, event);
    } else if (drag.kind === "scale") {
      const dist = Math.hypot(event.clientX - drag.centerScreenX, event.clientY - drag.centerScreenY);
      // ポインタが中心から遠ざかる = ズームイン = 窓を小さく。factor = startDist / dist。
      const factor = drag.startDist / Math.max(1, dist);
      lightbox.cropDraft = scaleCropAboutCenter(drag.startCrop, factor);
    } else {
      const angle = Math.atan2(event.clientY - drag.centerScreenY, event.clientX - drag.centerScreenX);
      let rotation = (drag.startCrop.rotation ?? 0) + (angle - drag.startAngle);
      if (event.shiftKey) {
        rotation = Math.round(rotation / ROTATE_SNAP_RAD) * ROTATE_SNAP_RAD;
      }
      lightbox.cropDraft = clampPanelCrop({ ...drag.startCrop, rotation: normalizeRotation(rotation) });
    }
    requestRender();
  },
  onCommit: (_event, drag) => {
    void commitCropDraft(drag.panelId);
  },
  onCancel: (_event, drag) => {
    // pointercancel はドラッグ開始前のクロップへ復元する(保存しない)。従来は移動後の見た目のまま
    // 未保存で放置されていた(復元処理の欠落)ため、他コントローラの cancel 規約に合わせて修正。
    const lightbox = state.pagePanelLightbox;
    if (lightbox && lightbox.cropPanelId === drag.panelId) {
      lightbox.cropDraft = { ...drag.startCrop };
      requestRender();
    }
  }
});

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
  const assignment = state.pagePanelAssignments.find((item) => item.panelId === lightbox.cropPanelId) ?? null;
  const drawnRect = panelImageRect(bounds, lightbox.cropDraft, assignment?.assetWidth, assignment?.assetHeight);
  const centerX = (bounds[0] + bounds[2]) / 2;
  const centerY = (bounds[1] + bounds[3]) / 2;
  const centerScreenX = ctm.a * centerX + ctm.c * centerY + ctm.e;
  const centerScreenY = ctm.b * centerX + ctm.d * centerY + ctm.f;
  const dx = event.clientX - centerScreenX;
  const dy = event.clientY - centerScreenY;
  cropSession.begin(
    event,
    {
      panelId: lightbox.cropPanelId,
      kind,
      startX: event.clientX,
      startY: event.clientY,
      startCrop: { ...lightbox.cropDraft },
      boxWidth,
      boxHeight,
      drawnWidth: drawnRect.width,
      drawnHeight: drawnRect.height,
      pxPerUnit: ctm.a,
      centerScreenX,
      centerScreenY,
      startDist: Math.hypot(dx, dy),
      startAngle: Math.atan2(dy, dx)
    },
    handle ?? (onBody instanceof Element ? onBody : null)
  );
  return true;
}

export function handlePagePanelCropPointerMove(event: PointerEvent): boolean {
  return cropSession.handleMove(event);
}

/** パン: 画面デルタを画像の回転に合わせて image 軸へ回してから crop の x/y に反映する。 */
function panGestureCrop(drag: CropDragData, event: PointerEvent): PanelCrop {
  const dxPage = (event.clientX - drag.startX) / drag.pxPerUnit;
  const dyPage = (event.clientY - drag.startY) / drag.pxPerUnit;
  const rotation = drag.startCrop.rotation ?? 0;
  // 画面デルタを -rotation 回転して image 軸のデルタにする(無回転なら恒等)。
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const imgDx = dxPage * cos + dyPage * sin;
  const imgDy = -dxPage * sin + dyPage * cos;
  // 等倍描画(panelImageRect)に合わせて、描画矩形の実寸で page→asset 正規化へ換算する。
  const dxAsset = imgDx / Math.max(1e-9, drag.drawnWidth);
  const dyAsset = imgDy / Math.max(1e-9, drag.drawnHeight);
  return clampPanelCrop({
    x: drag.startCrop.x - dxAsset,
    y: drag.startCrop.y - dyAsset,
    width: drag.startCrop.width,
    height: drag.startCrop.height,
    rotation
  });
}

export function handlePagePanelCropPointerUp(event: PointerEvent): boolean {
  return cropSession.handleUp(event);
}

export function handlePagePanelCropPointerCancel(event: PointerEvent): boolean {
  return cropSession.handleCancel(event);
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

// --- セリフドロワー(Docs/Feature-ScriptToManga.md S3 UI 2) ---

/**
 * 「セリフ」ドロワーの開閉。開く時はそのプロジェクトの active なセリフ行を取得する
 * (dialogue_lines は page_id を持たないため、行の絞り込みは「このページに配置済みか」を
 * `pageObjectsDraft` の `sourceDialogueLineId` から数える方式 -- renderDialogueDrawer 参照)。
 * 自動配置はこの本人操作(lightbox を開いている間のクリック)としてのみ実行する
 * (last-write-wins 競合回避、設計書 UI 3)。
 */
function toggleDialogueDrawer() {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "objects") {
    return;
  }
  state.dialogueDrawerOpen = !state.dialogueDrawerOpen;
  requestRender();
  if (state.dialogueDrawerOpen) {
    void loadDialogueDrawerLines();
    void loadDialogueProposals();
  }
}

async function loadDialogueDrawerLines() {
  const projectId = state.currentProjectId;
  if (!projectId) {
    return;
  }
  try {
    const result = await api<{ lines: DialogueLine[] }>(`/api/projects/${projectId}/dialogue-lines?status=active`);
    if (state.currentProjectId === projectId) {
      state.pagePanelLightboxDialogueLines = result.lines;
    }
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

/**
 * セリフ行をこのページへ配置する(placement 作成+吹き出し生成が対)。選択中のコマがあれば
 * そのコマ中心、無ければページ中央に配置される(サーバ側 `createDialoguePlacement` の挙動)。
 * 保留中の pageObjects 編集を先に flush してから叩く(サーバの pages.objects_json を最新化してから
 * 追記させることで、ローカル未保存編集が応答で巻き戻らないようにする)。
 */
async function placeDialogueLine(lineId: string) {
  const lightbox = state.pagePanelLightbox;
  const projectId = state.currentProjectId;
  if (!lightbox || !projectId) {
    return;
  }
  const pageId = lightbox.pageId;
  await flushPageObjectsSave();
  if (state.pagePanelLightbox?.pageId !== pageId) {
    return;
  }
  try {
    const body: { pageId: string; panelId?: string } = { pageId };
    if (lightbox.selectedPanelId) {
      body.panelId = lightbox.selectedPanelId;
    }
    const result = await api<CreatePlacementResult>(`/api/dialogue-lines/${lineId}/placements`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    if (state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    state.pageObjectsDraft = result.objects;
    // 既に専用 API でサーバへ保存済み(このモジュールの debounce PATCH は経由しない)。
    // undo 履歴は「配置」を安全に取り消せない(取り消すと dialogue_placements 行と PageObject が
    // 食い違う)ため、ここでリセットする。
    resetPageObjectsSession();
    ensureAllPageObjectTextLayouts(state.pageObjectsDraft);
    // ページ一覧プレビューのキャッシュバスタ(閉じる時の dirty 判定)に乗せる。
    markPageObjectsDirty();
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

// --- 構造化 LLM セリフ提案(Docs/Feature-ScriptToManga.md S4) ---

async function loadDialogueProposals() {
  const projectId = state.currentProjectId;
  const lightbox = state.pagePanelLightbox;
  if (!projectId || !lightbox) {
    return;
  }
  const pageId = lightbox.pageId;
  try {
    const result = await api<{ proposals: DialogueProposal[] }>(
      `/api/projects/${projectId}/dialogue-proposals?pageId=${encodeURIComponent(pageId)}`
    );
    // 取得中に別ページへ切り替わっていたら結果を捨てる(既知の罠6: 非同期完了後の state 書き込みガード)。
    if (state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    state.dialogueProposals = result.proposals;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

/**
 * 「AIセリフ提案」ボタン。LLM 呼び出しは数十秒かかりうるため、リクエスト発行時点の pageId を
 * `dialogueProposalRequestPageId` に捕捉し、完了時に現在の lightbox.pageId と一致する場合のみ
 * 結果を state へ反映する(LLM 待ち中のページ移動ガード -- 別ページへ移動/lightbox を閉じた後に
 * 結果が返っても無視する。既知の罠6と同型)。サーバは LLM 呼び出し失敗時も status='failed' の
 * proposal を返す(HttpError にはならない)ので、catch は主にネットワーク断/バリデーションエラー用。
 */
async function requestDialogueProposal() {
  const projectId = state.currentProjectId;
  const lightbox = state.pagePanelLightbox;
  if (!projectId || !lightbox || state.dialogueProposalBusy) {
    return;
  }
  const pageId = lightbox.pageId;
  state.dialogueProposalBusy = true;
  state.dialogueProposalRequestPageId = pageId;
  requestRender();
  try {
    const result = await api<CreateDialogueProposalResult>(
      `/api/projects/${projectId}/pages/${pageId}/dialogue-proposals`,
      { method: "POST", body: JSON.stringify({}) }
    );
    if (state.dialogueProposalRequestPageId !== pageId || state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    state.dialogueProposals = [result.proposal, ...state.dialogueProposals];
    if (result.proposal.status === "failed") {
      pushToast(result.proposal.error ?? "LLMセリフ提案の生成に失敗しました。", "error");
    }
  } catch (error) {
    if (state.dialogueProposalRequestPageId !== pageId || state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    if (state.dialogueProposalRequestPageId === pageId) {
      state.dialogueProposalBusy = false;
      state.dialogueProposalRequestPageId = null;
    }
    requestRender();
  }
}

function replaceProposalInState(proposal: DialogueProposal) {
  state.dialogueProposals = state.dialogueProposals.map((item) => (item.id === proposal.id ? proposal : item));
}

/** 提案項目1件の採用(文言修正可)。採用で作られた行はセリフ一覧に合流するので再取得する。 */
async function adoptDialogueProposalItem(proposalId: string, itemIndex: number, editedText?: string) {
  const pageId = state.pagePanelLightbox?.pageId;
  if (!pageId) {
    return;
  }
  try {
    const proposal = state.dialogueProposals.find((item) => item.id === proposalId);
    const originalText = proposal?.items?.[itemIndex]?.text ?? "";
    const body: { itemIndices: number[]; edits?: Array<{ index: number; text: string }> } = { itemIndices: [itemIndex] };
    if (editedText?.trim() && editedText.trim() !== originalText) {
      body.edits = [{ index: itemIndex, text: editedText.trim() }];
    }
    const result = await api<AdoptDialogueProposalResult>(`/api/dialogue-proposals/${proposalId}/adopt`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    if (state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    replaceProposalInState(result.proposal);
    void loadDialogueDrawerLines();
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

/** 提案項目1件の却下。 */
async function rejectDialogueProposalItem(proposalId: string, itemIndex: number) {
  const pageId = state.pagePanelLightbox?.pageId;
  if (!pageId) {
    return;
  }
  try {
    const result = await api<{ proposal: DialogueProposal }>(`/api/dialogue-proposals/${proposalId}/reject`, {
      method: "POST",
      body: JSON.stringify({ itemIndices: [itemIndex] })
    });
    if (state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    replaceProposalInState(result.proposal);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

registerActions({
  "open-page-panels": (id) => openPagePanelLightbox(id),
  "close-page-panels": () => closePagePanelLightbox(),
  "generate-selected-panel": () => generateSelectedPanel(),
  "edit-selected-panel-crop": () => editSelectedPanelCrop(),
  "close-panel-crop": () => closeCropEditor(),
  "reset-panel-crop": () => resetPanelCrop(),
  "clear-panel-target": () => clearPanelTarget(),
  "set-page-panel-mode": (id) => setPagePanelMode(id),
  "toggle-dialogue-drawer": () => toggleDialogueDrawer(),
  "place-dialogue-line": (id) => void placeDialogueLine(id),
  "request-dialogue-proposal": () => void requestDialogueProposal(),
  "adopt-dialogue-proposal-item": (id, target) => {
    const itemIndex = Number(target.dataset.itemIndex);
    if (!Number.isInteger(itemIndex)) {
      return;
    }
    const container = target.closest<HTMLElement>("[data-dialogue-proposal-item]");
    const textarea = container?.querySelector<HTMLTextAreaElement>("[data-dialogue-proposal-edit]");
    void adoptDialogueProposalItem(id, itemIndex, textarea?.value);
  },
  "reject-dialogue-proposal-item": (id, target) => {
    const itemIndex = Number(target.dataset.itemIndex);
    if (!Number.isInteger(itemIndex)) {
      return;
    }
    void rejectDialogueProposalItem(id, itemIndex);
  }
});
