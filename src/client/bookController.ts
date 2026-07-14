/**
 * Book（複数ページ）モードの controller。ページグリッド ⇄ 1枚生成 UI の遷移、ページの
 * 追加/削除/リネーム、ドラッグ並び替えを扱う。単一プロジェクトの `projectController.openProject`
 * に対応する「プロジェクトを開く」処理の Book 版。AGENTS.md 規約により data-action は
 * `registerActions`、delegated な非 click イベント（DnD）は `registerEventBinder` で登録する。
 */
import type { BookPages, PageDetail } from "../shared/apiTypes";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";
import {
  carryoverFields,
  commitActivePageDrafts,
  flushProjectDraftPersist,
  persistProjectDraft,
  restoreOrResetProjectDrafts
} from "./draftStore";
import { clearPasteCaches } from "./pasteObjectController";
import { resetRoundDeletionHistory, resumeAutoCollectForActiveRounds } from "./generationController";
import { captureGenerationDraft, rememberActiveRoundDraft, restoreGenerationDraftForRound } from "./generationDraft";
import { refreshModelCheck, refreshModelCheckForTemplate } from "./modelCheckController";
import { refreshLoraChoices } from "./styleLoraController";
import { refreshRecentReferenceImages } from "./referenceController";
import { confirmDialog } from "./confirmDialogController";
import { openImageExport } from "./imageExportController";
import { clearReferenceCorner, loadReferenceCorner } from "./referenceSetController";
import { clearScriptProjectSession } from "./scriptController";

/** Book を開く（グリッド表示）。単一プロジェクトの openProject に相当するプロジェクトセッション初期化 + ページ一覧取得。 */
export async function openBook(projectId: string) {
  state.currentProjectId = projectId;
  const data = await api<BookPages>(`/api/projects/${projectId}/pages`);
  state.book = data;
  state.detail = null;
  state.activePageId = null;
  state.bookSelectionMode = false;
  state.selectedBookPageIds = [];
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.bookSettingsOpen = false;
  state.imageExportOpen = false;
  state.imageExportPageIds = null;
  state.imageExportBusy = false;
  state.bookReaderOpen = false;
  state.bookReaderSettingsOpen = false;
  state.sidebarOpen = false;
  state.pagePanelLightbox = null;
  state.pagePanelAssignments = [];
  state.referenceCornerOpen = false;
  state.referenceCornerCharacterId = null;
  state.activePanelTarget = null;
  restoreOrResetProjectDrafts(projectId);
  clearPasteCaches();
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.deletePreviewRoundId = null;
  resetRoundDeletionHistory();
  state.roundProgress = {};
  state.recentReferenceImages = [];
  state.iterationScrollReset = true;
  requestRender();
  // 顔スタイル参照(PuLID)可用性と LoRA 候補を先取りしておく(ページを開いた時に使う)。
  void refreshModelCheck("chroma");
  void refreshLoraChoices();
  void loadReferenceCorner(projectId);
}

/** ページを開く（そのページに絞った1枚生成 UI へ）。 */
export async function openPage(pageId: string) {
  if (!state.currentProjectId) {
    return;
  }
  // 離れるページの参照/LoRA ドラフトを per-page マップへ確定してから切り替える。
  commitActivePageDrafts();
  const detail = await api<PageDetail>(`/api/projects/${state.currentProjectId}/pages/${pageId}`);
  state.detail = detail;
  state.templates = detail.templates;
  state.activePageId = pageId;
  state.activeRoundId = detail.rounds[0]?.id ?? null;
  state.activeAssetId = null;
  state.sidebarOpen = false;
  // コマ内生成(Docs/Feature-PanelGeneration.md): lightbox は閉じ、そのページの割り当てを読み込む。
  // 対象コマは一旦リセットする(`generateForPanel` はこの後で明示的にセットし直す)。
  state.pagePanelLightbox = null;
  state.pagePanelAssignments = detail.panelAssignments;
  state.activePanelTarget = null;
  // ページ別の参照画像 / スタイル LoRA を復元する。
  state.referenceDraft = state.referenceDraftsByPage[pageId] ?? { imageDataUrl: null };
  state.loraDraft = state.loraDraftsByPage[pageId] ?? [];
  // アクティブラウンドの生成フォーム draft を復元(無ければラウンドの request 値へフォールバック)。
  // ラウンドがまだ無い新規ページは、引き継いだ設定(前ページ/Book共通設定)を初期フォーム値にする。
  state.generationDraft = null;
  if (state.activeRoundId) {
    restoreGenerationDraftForRound(state.activeRoundId);
  } else if (state.pageSettingsByPage[pageId]) {
    state.generationDraft = { ...state.pageSettingsByPage[pageId] };
  }
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.deletePreviewRoundId = null;
  state.roundProgress = {};
  state.iterationScrollReset = true;
  requestRender();
  resumeAutoCollectForActiveRounds();
  refreshModelCheckForTemplate();
  void refreshRecentReferenceImages();
}

/** ページ一覧へ戻る（グリッド）。 */
export async function backToPages() {
  if (!state.currentProjectId) {
    return;
  }
  // グリッドへ戻る前に、生成フォームの未保存編集を現ラウンドの draft へ退避する(selectRound と同じ)。
  // #generation-form がまだ DOM にあるこのタイミングで行わないと、ページを開き直した時に編集が失われる。
  rememberActiveRoundDraft();
  commitActivePageDrafts();
  flushProjectDraftPersist();
  state.detail = null;
  state.activePageId = null;
  state.bookSelectionMode = false;
  state.selectedBookPageIds = [];
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.deletePreviewRoundId = null;
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.pagePanelAssignments = [];
  state.activePanelTarget = null;
  await reloadPages();
  requestRender();
}

/** Home へ戻る等でプロジェクトを離れる時の Book セッション破棄(projectController.loadHome から呼ぶ)。 */
export function clearBookSession() {
  state.book = null;
  state.activePageId = null;
  state.bookSelectionMode = false;
  state.selectedBookPageIds = [];
  state.bookSettingsOpen = false;
  state.imageExportOpen = false;
  state.imageExportPageIds = null;
  state.imageExportBusy = false;
  state.bookReaderOpen = false;
  state.bookReaderSettingsOpen = false;
  state.recentReferenceImages = [];
  state.pagePanelLightbox = null;
  state.pagePanelAssignments = [];
  state.activePanelTarget = null;
  clearScriptProjectSession();
  clearReferenceCorner();
}

async function reloadPages() {
  if (!state.currentProjectId) {
    return;
  }
  state.book = await api<BookPages>(`/api/projects/${state.currentProjectId}/pages`);
  pruneBookPageSelection();
}

/**
 * ページ一覧を再取得して再描画する(コマ内生成でクロップ編集した後などに、ページ一覧の
 * コマ割りプレビュー `preview.png?v=...`(v=割り当ての最終更新時刻)を最新化するために呼ぶ)。
 */
export async function reloadBookPages() {
  if (!state.book) {
    return;
  }
  try {
    await reloadPages();
  } finally {
    requestRender();
  }
}

async function addPage(layoutTemplateId?: string) {
  if (!state.currentProjectId) {
    return;
  }
  // 引き継ぎ元は「追加前の末尾ページ」(Book共通設定が優先)。追加後の新ページも末尾に付く。
  const previousLastPageId = state.book?.pages.at(-1)?.id ?? null;
  const body = layoutTemplateId ? JSON.stringify({ layoutTemplateId }) : "{}";
  await api(`/api/projects/${state.currentProjectId}/pages`, { method: "POST", body });
  await reloadPages();
  const newPageId = state.book?.pages.at(-1)?.id ?? null;
  if (newPageId) {
    applyCarryoverToNewPage(newPageId, previousLastPageId);
    persistProjectDraft(state.currentProjectId);
  }
  // テンプレから追加した場合はピッカーを閉じてページ一覧へ戻す。
  if (layoutTemplateId) {
    state.layoutPickerOpen = false;
  }
  requestRender();
}

/** 画像インポートで受け付ける MIME(source-asset と同じ)。 */
const IMPORT_IMAGE_MIME = ["image/png", "image/jpeg", "image/webp"];

/**
 * 複数画像を新規ページとして順に取り込む(各画像がそのページの代表アセットになる)。
 * 1枚失敗しても残りは続行し、結果をトーストで要約する。ComfyUI は不要(ファイルコピー)。
 */
export async function importImagesAsPages(input: HTMLInputElement) {
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length === 0 || !state.currentProjectId) {
    return;
  }
  const images = files.filter((file) => IMPORT_IMAGE_MIME.includes(file.type));
  const skipped = files.length - images.length;
  if (images.length === 0) {
    pushToast("PNG / JPEG / WebP 画像を選択してください。", "error");
    return;
  }

  state.layoutPickerOpen = false;
  pushToast(`${images.length}枚の画像をページとして取り込んでいます…`, "info");

  let imported = 0;
  let failed = 0;
  let lastError = "";
  for (const file of images) {
    try {
      const dataUrl = await fileToDataUrl(file);
      await api(`/api/projects/${state.currentProjectId}/pages/import-image`, {
        method: "POST",
        body: JSON.stringify({ filename: file.name, dataUrl })
      });
      imported += 1;
    } catch (error) {
      failed += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  await reloadPages();
  if (imported === 0) {
    pushToast(lastError || "画像の取り込みに失敗しました。", "error");
  } else {
    const notes = [skipped > 0 ? `${skipped}件は非対応形式` : "", failed > 0 ? `${failed}件は失敗` : ""]
      .filter(Boolean)
      .join(" / ");
    pushToast(`${imported}枚の画像をページとして取り込みました。${notes ? `(${notes})` : ""}`, "info");
  }
  requestRender();
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("画像ファイルを読み込めませんでした。")));
    reader.readAsDataURL(file);
  });
}

/**
 * 新規ページの初期設定を「Book共通設定(あれば) > 直前ページの設定」の順で引き継ぐ。
 * 顔参照画像は引き継がず空スタート(referenceDraftsByPage に入れない)。
 */
function applyCarryoverToNewPage(newPageId: string, previousLastPageId: string | null) {
  const useCommon = state.bookCommonSettings !== null;
  const carried = useCommon
    ? state.bookCommonSettings
    : previousLastPageId
      ? state.pageSettingsByPage[previousLastPageId] ?? null
      : null;
  const lora = useCommon
    ? state.bookCommonLora ?? []
    : previousLastPageId
      ? state.loraDraftsByPage[previousLastPageId] ?? []
      : [];
  if (carried) {
    state.pageSettingsByPage[newPageId] = carryoverFields(carried);
  }
  state.loraDraftsByPage[newPageId] = [...lora];
}

function pruneBookPageSelection() {
  const pageIds = new Set((state.book?.pages ?? []).map((page) => page.id));
  state.selectedBookPageIds = state.selectedBookPageIds.filter((id) => pageIds.has(id));
  if (state.bookSelectionMode && pageIds.size === 0) {
    state.bookSelectionMode = false;
  }
}

function setBookSelectionMode(enabled: boolean) {
  state.bookSelectionMode = enabled;
  state.selectedBookPageIds = [];
  requestRender();
}

function toggleBookPageSelection(pageId: string) {
  if (!state.bookSelectionMode) {
    return;
  }
  const selected = new Set(state.selectedBookPageIds);
  if (selected.has(pageId)) {
    selected.delete(pageId);
  } else {
    selected.add(pageId);
  }
  state.selectedBookPageIds = (state.book?.pages ?? []).map((page) => page.id).filter((id) => selected.has(id));
  requestRender();
}

function selectAllBookPages() {
  state.selectedBookPageIds = (state.book?.pages ?? []).map((page) => page.id);
  requestRender();
}

async function deletePage(pageId: string) {
  await deletePages([pageId]);
}

async function deletePages(pageIds: string[]) {
  if (!state.currentProjectId) {
    return;
  }
  const pages = (state.book?.pages ?? []).filter((page) => pageIds.includes(page.id));
  if (pages.length === 0) {
    return;
  }
  const label = pages.length === 1
    ? `ページ「${pages[0]!.title.trim() || "このページ"}」`
    : `${pages.length}ページ`;
  const confirmed = await confirmDialog({
    title: "ページを削除",
    message: `${label}を削除します。対象ページの生成画像も削除されます。よろしいですか？`,
    confirmLabel: "削除",
    tone: "danger"
  });
  if (!confirmed) {
    return;
  }
  for (const page of pages) {
    await api(`/api/projects/${state.currentProjectId}/pages/${page.id}`, { method: "DELETE" });
    delete state.referenceDraftsByPage[page.id];
    delete state.loraDraftsByPage[page.id];
    delete state.pageSettingsByPage[page.id];
    if (state.activePageId === page.id) {
      state.detail = null;
      state.activePageId = null;
    }
  }
  await reloadPages();
  state.bookSelectionMode = false;
  state.selectedBookPageIds = [];
  pushToast(pages.length === 1 ? "ページを削除しました。" : `${pages.length}ページを削除しました。`, "info");
  requestRender();
}

// --- Book共通設定(新規ページの既定値)。生成サイドバーを編集バッファとして再利用する ---

/** Book共通設定画面を開く。生成フォームを共通設定の編集バッファとして使う(既存の共通設定があれば復元)。 */
function openBookSettings() {
  if (!state.currentProjectId || !state.book) {
    return;
  }
  state.detail = null;
  state.activePageId = null;
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.bookSettingsOpen = true;
  state.generationDraft = state.bookCommonSettings ? { ...state.bookCommonSettings } : null;
  state.loraDraft = state.bookCommonLora ? [...state.bookCommonLora] : [];
  state.referenceDraft = { imageDataUrl: null };
  state.sidebarOpen = false;
  state.maskEditMode = false;
  state.paintEditMode = false;
  requestRender();
  // 顔参照は使わないが、LoRA 候補とモデルチェックは設定 UI で必要。
  void refreshModelCheck("chroma");
  void refreshLoraChoices();
}

/** 共通設定を保存する(以後の新規ページの既定になる)。 */
function saveBookSettings() {
  if (!state.currentProjectId) {
    return;
  }
  captureGenerationDraft();
  state.bookCommonSettings = carryoverFields(state.generationDraft);
  state.bookCommonLora = [...state.loraDraft];
  persistProjectDraft(state.currentProjectId);
  flushProjectDraftPersist();
  backFromBookSettings();
  pushToast("Book共通設定を保存しました。新規ページの初期値に使われます。", "info");
}

/** 共通設定をクリアする(新規ページは直前ページからの引き継ぎに戻る)。画面には留まる。 */
function clearBookSettings() {
  if (!state.currentProjectId) {
    return;
  }
  state.bookCommonSettings = null;
  state.bookCommonLora = null;
  state.generationDraft = null;
  state.loraDraft = [];
  persistProjectDraft(state.currentProjectId);
  flushProjectDraftPersist();
  pushToast("Book共通設定をクリアしました。新規ページは直前ページから引き継ぎます。", "info");
  requestRender();
}

/** 共通設定画面からページ一覧へ戻る(編集バッファは破棄。保存済みの共通設定はそのまま)。 */
function backFromBookSettings() {
  state.bookSettingsOpen = false;
  state.generationDraft = null;
  state.loraDraft = [];
  state.referenceDraft = null;
  requestRender();
}

async function persistReorder(orderedIds: string[]) {
  if (!state.currentProjectId) {
    return;
  }
  state.book = await api<BookPages>(`/api/projects/${state.currentProjectId}/pages/reorder`, {
    method: "POST",
    body: JSON.stringify({ orderedIds })
  });
  requestRender();
}

// --- ドラッグ並び替え（Pointer Events で自前実装）+ 挿入位置プレビュー ---
// ネイティブ HTML5 DnD は、カード全面を覆う <button> が実マウスのドラッグ開始を握り潰す
// （form control 上では draggable な祖先のドラッグが始まらない）ため使わない。pointerdown →
// 閾値超えで drag 開始 → カーソル近傍のカードから挿入位置を算出してインジケータ（縦バー）を表示 →
// pointerup で確定、という流れを自前で持つ。ドラッグ中の一時状態はモジュール変数に持ち、確定時のみ
// reorder API → requestRender する。カードは data-key で morph に同一視され、並び替え後も既存 DOM
// ノードが移動する（サムネ再デコードなし）。マウス/タッチ/ペンを pointer で一括で扱える。

/** クリックとドラッグを分ける開始閾値（px）。これ未満の移動はクリック扱い。 */
const PAGE_DRAG_THRESHOLD_PX = 6;
/** 挿入インジケータをカード間ギャップの中央付近に置くオフセット（.page-grid の column-gap の約半分）。 */
const PAGE_DROP_INDICATOR_OFFSET_PX = 18;

/** 挿入先。refId のカードの前(before=true)/後ろ、または末尾(refId=null)。 */
interface PageDropSlot {
  refId: string | null;
  before: boolean;
}

interface PageReorderState {
  pointerId: number;
  draggedId: string;
  card: HTMLElement;
  startX: number;
  startY: number;
  dragging: boolean;
  slot: PageDropSlot | null;
}

let pageReorder: PageReorderState | null = null;
/** ドラッグ確定直後に発火する click（=ページを開く）を1回だけ抑止するフラグ。 */
let suppressPageCardClick = false;

function pageGridEl(app: HTMLElement): HTMLElement | null {
  return app.querySelector<HTMLElement>(".page-grid");
}

function realPageCards(grid: HTMLElement): HTMLElement[] {
  return Array.from(grid.querySelectorAll<HTMLElement>(".page-card"));
}

/** カーソルに最も近い（ドラッグ中カード以外の）カードを基準に、その左右どちらへ挿入するかを決める。 */
function pickInsertSlot(grid: HTMLElement, x: number, y: number, draggedId: string): PageDropSlot {
  const cards = realPageCards(grid).filter((card) => card.dataset.pageId !== draggedId);
  if (cards.length === 0) {
    return { refId: null, before: false };
  }
  let nearest = cards[0];
  let nearestDist = Infinity;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const dx = x - (rect.left + rect.width / 2);
    const dy = y - (rect.top + rect.height / 2);
    const dist = dx * dx + dy * dy;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = card;
    }
  }
  const rect = nearest.getBoundingClientRect();
  return { refId: nearest.dataset.pageId ?? null, before: x < rect.left + rect.width / 2 };
}

function updateDropIndicator(grid: HTMLElement, slot: PageDropSlot) {
  const cards = realPageCards(grid);
  let refCard = slot.refId ? cards.find((card) => card.dataset.pageId === slot.refId) ?? null : null;
  let leftEdge: boolean;
  if (refCard) {
    leftEdge = slot.before;
  } else {
    // 末尾: 最後のカードの右端に置く。
    refCard = cards[cards.length - 1] ?? null;
    leftEdge = false;
  }
  if (!refCard) {
    removeDropIndicator(grid);
    return;
  }
  const gridRect = grid.getBoundingClientRect();
  const rect = refCard.getBoundingClientRect();
  const x = leftEdge
    ? rect.left - gridRect.left - PAGE_DROP_INDICATOR_OFFSET_PX
    : rect.right - gridRect.left + PAGE_DROP_INDICATOR_OFFSET_PX;
  let indicator = grid.querySelector<HTMLElement>(".page-drop-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "page-drop-indicator";
    indicator.setAttribute("aria-hidden", "true");
    grid.appendChild(indicator);
  }
  indicator.style.left = `${x}px`;
  indicator.style.top = `${rect.top - gridRect.top}px`;
  indicator.style.height = `${rect.height}px`;
}

function removeDropIndicator(grid: HTMLElement) {
  grid.querySelector(".page-drop-indicator")?.remove();
}

/** 現在のページ順に対し slot を反映した新しい id 順を返す。変化が無ければ null。 */
function slotToOrderedIds(draggedId: string, slot: PageDropSlot): string[] | null {
  const current = (state.book?.pages ?? []).map((page) => page.id);
  const ids = current.filter((id) => id !== draggedId);
  let insertAt: number;
  if (!slot.refId || slot.refId === draggedId) {
    insertAt = ids.length;
  } else {
    const idx = ids.indexOf(slot.refId);
    insertAt = idx < 0 ? ids.length : slot.before ? idx : idx + 1;
  }
  ids.splice(Math.max(0, Math.min(ids.length, insertAt)), 0, draggedId);
  if (ids.length === current.length && ids.every((id, index) => id === current[index])) {
    return null;
  }
  return ids;
}

function bindPageDragEvents(app: HTMLElement) {
  app.addEventListener("pointerdown", (event) => {
    if (state.bookSelectionMode) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    // リネーム/削除/生成アイコン(.page-card-actions)や「追加」タイルの上では並び替えを開始しない。
    if (target.closest(".page-card-actions") || target.closest(".page-add-card")) {
      return;
    }
    const card = target.closest<HTMLElement>(".page-card");
    if (!card?.dataset.pageId) {
      return;
    }
    pageReorder = {
      pointerId: event.pointerId,
      draggedId: card.dataset.pageId,
      card,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      slot: null
    };
    suppressPageCardClick = false;
  });

  app.addEventListener("pointermove", (event) => {
    const reorder = pageReorder;
    if (!reorder || event.pointerId !== reorder.pointerId) {
      return;
    }
    if (!reorder.dragging) {
      const dx = event.clientX - reorder.startX;
      const dy = event.clientY - reorder.startY;
      if (dx * dx + dy * dy < PAGE_DRAG_THRESHOLD_PX * PAGE_DRAG_THRESHOLD_PX) {
        return;
      }
      reorder.dragging = true;
      reorder.card.classList.add("page-dragging");
      try {
        reorder.card.setPointerCapture(reorder.pointerId);
      } catch {
        // capture に失敗しても pointermove/up は app への委譲で届く。
      }
    }
    const grid = pageGridEl(app);
    if (!grid) {
      return;
    }
    // テキスト選択やスクロールを抑止してドラッグに専念させる。
    event.preventDefault();
    reorder.slot = pickInsertSlot(grid, event.clientX, event.clientY, reorder.draggedId);
    updateDropIndicator(grid, reorder.slot);
  });

  const finishDrag = (event: PointerEvent, commit: boolean) => {
    const reorder = pageReorder;
    if (!reorder || event.pointerId !== reorder.pointerId) {
      return;
    }
    const grid = pageGridEl(app);
    if (grid) {
      removeDropIndicator(grid);
    }
    reorder.card.classList.remove("page-dragging");
    try {
      reorder.card.releasePointerCapture(reorder.pointerId);
    } catch {
      // capture していない場合は無視。
    }
    if (commit && reorder.dragging && reorder.slot) {
      // ドラッグが成立したら、その後に来る click（ページを開く）を抑止する。
      suppressPageCardClick = true;
      const ids = slotToOrderedIds(reorder.draggedId, reorder.slot);
      if (ids) {
        void persistReorder(ids);
      }
    }
    pageReorder = null;
  };

  app.addEventListener("pointerup", (event) => finishDrag(event, true));
  app.addEventListener("pointercancel", (event) => finishDrag(event, false));

  // ドラッグ直後の click（ページを開く）を capture phase で1回だけ握り潰す。
  app.addEventListener(
    "click",
    (event) => {
      if (!suppressPageCardClick) {
        return;
      }
      suppressPageCardClick = false;
      if ((event.target as HTMLElement).closest(".page-card")) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );
}

registerActions({
  "open-page": (id) => openPage(id),
  "add-page": () => addPage(),
  "add-page-from-template": (id) => addPage(id),
  "delete-page": (id) => deletePage(id),
  "toggle-page-selection-mode": () => setBookSelectionMode(!state.bookSelectionMode),
  "toggle-book-page-selection": (id) => toggleBookPageSelection(id),
  "select-all-book-pages": () => selectAllBookPages(),
  "clear-book-page-selection": () => setBookSelectionMode(false),
  "delete-selected-pages": () => deletePages(state.selectedBookPageIds),
  "export-book": () => openImageExport(null),
  "export-selected-pages": () => openImageExport(state.selectedBookPageIds),
  "export-page": (id) => openImageExport([id]),
  "back-to-pages": () => backToPages(),
  "open-book-settings": () => openBookSettings(),
  "save-book-settings": () => saveBookSettings(),
  "clear-book-settings": () => clearBookSettings(),
  "back-from-book-settings": () => backFromBookSettings()
});

registerEventBinder(bindPageDragEvents);
