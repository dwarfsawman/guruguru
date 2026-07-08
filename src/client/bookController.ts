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
import { commitActivePageDrafts, flushProjectDraftPersist, restoreOrResetProjectDrafts } from "./draftStore";
import { clearPasteCaches } from "./pasteObjectController";
import { resetRoundDeletionHistory, resumeAutoCollectForActiveRounds } from "./generationController";
import { rememberActiveRoundDraft, restoreGenerationDraftForRound } from "./generationDraft";
import { refreshModelCheck } from "./modelCheckController";
import { refreshLoraChoices } from "./styleLoraController";
import { refreshRecentReferenceImages } from "./referenceController";

/** ドラッグ並び替えの MIME。paste 画像 DnD とは別枠にして相互干渉を防ぐ。 */
const PAGE_DRAG_MIME = "application/x-guruguru-page-id";

/** Book を開く（グリッド表示）。単一プロジェクトの openProject に相当するプロジェクトセッション初期化 + ページ一覧取得。 */
export async function openBook(projectId: string) {
  state.currentProjectId = projectId;
  const data = await api<BookPages>(`/api/projects/${projectId}/pages`);
  state.book = data;
  state.detail = null;
  state.activePageId = null;
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.sidebarOpen = false;
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
  // ページ別の参照画像 / スタイル LoRA を復元する。
  state.referenceDraft = state.referenceDraftsByPage[pageId] ?? { imageDataUrl: null };
  state.loraDraft = state.loraDraftsByPage[pageId] ?? [];
  // アクティブラウンドの生成フォーム draft を復元(無ければラウンドの request 値へフォールバック)。
  state.generationDraft = null;
  if (state.activeRoundId) {
    restoreGenerationDraftForRound(state.activeRoundId);
  }
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.deletePreviewRoundId = null;
  state.roundProgress = {};
  state.iterationScrollReset = true;
  requestRender();
  resumeAutoCollectForActiveRounds();
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
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.deletePreviewRoundId = null;
  state.maskEditMode = false;
  state.paintEditMode = false;
  await reloadPages();
  requestRender();
}

/** Home へ戻る等でプロジェクトを離れる時の Book セッション破棄(projectController.loadHome から呼ぶ)。 */
export function clearBookSession() {
  state.book = null;
  state.activePageId = null;
  state.recentReferenceImages = [];
}

async function reloadPages() {
  if (!state.currentProjectId) {
    return;
  }
  state.book = await api<BookPages>(`/api/projects/${state.currentProjectId}/pages`);
}

async function addPage() {
  if (!state.currentProjectId) {
    return;
  }
  await api(`/api/projects/${state.currentProjectId}/pages`, { method: "POST", body: "{}" });
  await reloadPages();
  requestRender();
}

async function deletePage(pageId: string) {
  if (!state.currentProjectId) {
    return;
  }
  const page = state.book?.pages.find((item) => item.id === pageId);
  const label = page?.title.trim() || "このページ";
  if (!window.confirm(`ページ「${label}」を削除します。このページの生成画像も削除されます。よろしいですか？`)) {
    return;
  }
  await api(`/api/projects/${state.currentProjectId}/pages/${pageId}`, { method: "DELETE" });
  delete state.referenceDraftsByPage[pageId];
  delete state.loraDraftsByPage[pageId];
  if (state.activePageId === pageId) {
    state.detail = null;
    state.activePageId = null;
  }
  await reloadPages();
  pushToast("ページを削除しました。", "info");
  requestRender();
}

async function renamePage(pageId: string) {
  if (!state.currentProjectId) {
    return;
  }
  const page = state.book?.pages.find((item) => item.id === pageId);
  const next = window.prompt("ページ名を入力してください。", page?.title ?? "");
  if (next === null) {
    return;
  }
  await api(`/api/projects/${state.currentProjectId}/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ title: next.trim() })
  });
  await reloadPages();
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

// --- ドラッグ並び替え（ネイティブ HTML5 DnD） ---
// ドラッグ中の一時状態はモジュール変数に持ち、ハイライトは classList を直接操作する(render を通さない)。
// 確定(drop)時のみ reorder API → requestRender する。カードは data-key で morph に同一視され、
// 並び替え後は既存 DOM ノードが移動する(サムネの再デコードなし)。
let draggedPageId: string | null = null;

function clearDropTargets(app: HTMLElement) {
  app.querySelectorAll(".page-drop-active").forEach((el) => el.classList.remove("page-drop-active"));
}

async function commitPageReorder(draggedId: string, targetId: string) {
  const ids = (state.book?.pages ?? []).map((page) => page.id);
  const from = ids.indexOf(draggedId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) {
    return;
  }
  ids.splice(from, 1);
  let insertAt = ids.indexOf(targetId);
  if (from < to) {
    // 前方（右）へのドラッグはターゲットの後ろへ落とす方が直感に合う。
    insertAt += 1;
  }
  ids.splice(insertAt, 0, draggedId);
  await persistReorder(ids);
}

function bindPageDragEvents(app: HTMLElement) {
  app.addEventListener("dragstart", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>(".page-card");
    if (!card?.dataset.pageId) {
      return;
    }
    draggedPageId = card.dataset.pageId;
    event.dataTransfer?.setData(PAGE_DRAG_MIME, draggedPageId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
    card.classList.add("page-dragging");
  });

  app.addEventListener("dragover", (event) => {
    if (!draggedPageId) {
      return;
    }
    const card = (event.target as HTMLElement).closest<HTMLElement>(".page-card");
    if (!card || card.dataset.pageId === draggedPageId) {
      clearDropTargets(app);
      return;
    }
    // preventDefault しないと drop が発火しない。
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    clearDropTargets(app);
    card.classList.add("page-drop-active");
  });

  app.addEventListener("dragleave", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>(".page-card");
    if (card && !card.contains(event.relatedTarget as Node | null)) {
      card.classList.remove("page-drop-active");
    }
  });

  app.addEventListener("drop", (event) => {
    if (!draggedPageId) {
      return;
    }
    const card = (event.target as HTMLElement).closest<HTMLElement>(".page-card");
    const targetId = card?.dataset.pageId;
    const dragged = draggedPageId;
    clearDropTargets(app);
    if (!targetId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (targetId !== dragged) {
      void commitPageReorder(dragged, targetId);
    }
  });

  app.addEventListener("dragend", () => {
    draggedPageId = null;
    clearDropTargets(app);
    app.querySelectorAll(".page-dragging").forEach((el) => el.classList.remove("page-dragging"));
  });
}

registerActions({
  "open-page": (id) => openPage(id),
  "add-page": () => addPage(),
  "delete-page": (id) => deletePage(id),
  "rename-page": (id) => renamePage(id),
  "back-to-pages": () => backToPages()
});

registerEventBinder(bindPageDragEvents);
