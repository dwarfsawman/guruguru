/**
 * Chronicle バー(S5、Docs/Feature-ChroniclePageFlow.md)の controller。フェーズI: 表示
 * (取得・折り畳み・複数脚本セレクタ・Beat クリックでの内容プレビュー)。フェーズII: 範囲選択
 * (Shift+クリック)・一括割り当て/解除・「次の未配置区間へ」を追加(§2.3・§6)。自動配置(preview/apply)
 * はフェーズIII 以降。ページ編集 lightbox(`pagePanelLightboxController.ts`)のライフサイクルに
 * 乗る -- lightbox を開く/閉じるタイミングで一緒に開閉する(ドロワーと同じ乗せ方)。
 */
import type {
  ChronicleApiResponse,
  DialogueAllocationRemovalResult,
  DialogueAllocationResult,
  DialogueLayoutPreview,
  DialogueLayoutUnlockResult,
  ExistingPlacementPolicy
} from "../shared/chronicle";
import type { MangaScript, PageDetail } from "../shared/apiTypes";
import { computeBeatState } from "../shared/chronicleBeat";
import { api } from "./api";
import { pushToast, requestRender, setChronicleCollapsed, state } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";
import {
  currentPageObjectsSnapshot,
  ensureAllPageObjectTextLayouts,
  flushPageObjectsSave,
  markPageObjectsDirty,
  pushPageObjectHistorySnapshotExternal
} from "./pageObjectsController";
import { setPagePanelMode } from "./pagePanelLightboxController";

function resetChronicleState() {
  state.chronicle = {
    ...state.chronicle,
    status: "idle",
    scriptId: null,
    revisionId: null,
    beats: [],
    selectedBeatIds: [],
    preview: null,
    busyAction: null,
    scripts: [],
    lines: [],
    pages: [],
    pageId: null,
    previewBeatId: null,
    errorMessage: null,
    allocationPolicy: "skip"
  };
  selectionAnchorBeatId = null;
  lastHighlightedObjectId = null;
}

/**
 * lightbox を開いた時に呼ぶ(`openPagePanelLightbox` から)。まずその脚本一覧を取得し、
 * 1件も無ければバーは非表示のまま(status="idle")にする。1件以上あれば選択中(または最初)の
 * 脚本の Chronicle データを取得する。
 */
export async function openChronicleForPage(projectId: string, pageId: string): Promise<void> {
  resetChronicleState();
  state.chronicle.status = "loading";
  requestRender();
  try {
    const result = await api<{ scripts: MangaScript[] }>(`/api/projects/${projectId}/scripts`);
    // 取得中に閉じられた/別ページへ切り替わっていたら結果を捨てる(既知の罠6と同型)。
    if (state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    state.chronicle.scripts = result.scripts;
    if (result.scripts.length === 0) {
      state.chronicle.status = "idle";
      return;
    }
    const scriptId = result.scripts[0]!.id;
    await loadChronicleData(projectId, scriptId, pageId);
  } catch (error) {
    if (state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    state.chronicle.status = "error";
    state.chronicle.errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    requestRender();
  }
}

async function loadChronicleData(projectId: string, scriptId: string, pageId: string): Promise<void> {
  state.chronicle.status = "loading";
  requestRender();
  try {
    const result = await api<ChronicleApiResponse>(
      `/api/projects/${projectId}/chronicle?scriptId=${encodeURIComponent(scriptId)}`
    );
    // ページ切替/lightbox クローズ後の到着は捨てる(非同期完了後の state 書き込みガード)。
    if (state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    state.chronicle.status = "ready";
    state.chronicle.scriptId = result.scriptId;
    state.chronicle.revisionId = result.revisionId;
    state.chronicle.beats = result.beats;
    state.chronicle.lines = result.lines;
    state.chronicle.pages = result.pages;
    state.chronicle.pageId = pageId;
    state.chronicle.errorMessage = null;
  } catch (error) {
    if (state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    // このプロジェクトに脚本はあるが revision が無い等(通常は起きない)。バーは出さず静かに失敗する。
    state.chronicle.status = "idle";
    state.chronicle.errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    requestRender();
  }
}

/** lightbox を閉じる時に呼ぶ(`closePagePanelLightbox` から)。 */
export function closeChronicle(): void {
  resetChronicleState();
  lastAutoScrollKey = null;
}

/** 複数脚本セレクタでの切替。 */
function selectChronicleScript(scriptId: string): void {
  const projectId = state.currentProjectId;
  const pageId = state.pagePanelLightbox?.pageId;
  if (!projectId || !pageId || scriptId === state.chronicle.scriptId) {
    return;
  }
  void loadChronicleData(projectId, scriptId, pageId);
}

function toggleChronicleCollapsed(): void {
  setChronicleCollapsed(!state.chronicle.collapsed);
  requestRender();
}

/** Beat クリック: 内容プレビューの開閉トグル(§2.3)。 */
function toggleBeatPreview(beatId: string): void {
  state.chronicle.previewBeatId = state.chronicle.previewBeatId === beatId ? null : beatId;
  requestRender();
}

/**
 * Shift+クリックでの範囲選択(§2.3)。直近のクリック(shift無し)を選択のアンカーとし、
 * shift+クリックでアンカー〜クリック位置(Beat 表示順のインデックス)を選択する。
 * shift 無しの通常クリックは選択をこの1件へリセットし、アンカーを更新した上で
 * 内容プレビューは従来どおりトグルする(「Beat クリック=プレビュー」は維持、§2.3)。
 */
let selectionAnchorBeatId: string | null = null;

function handleBeatClick(beatId: string, shiftKey: boolean): void {
  const beats = state.chronicle.beats;
  const clickedIndex = beats.findIndex((beat) => beat.id === beatId);
  if (clickedIndex < 0) {
    return;
  }
  if (shiftKey && selectionAnchorBeatId) {
    const anchorIndex = beats.findIndex((beat) => beat.id === selectionAnchorBeatId);
    if (anchorIndex >= 0) {
      const [start, end] = anchorIndex <= clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex];
      state.chronicle.selectedBeatIds = beats.slice(start, end + 1).map((beat) => beat.id);
      requestRender();
      return;
    }
  }
  selectionAnchorBeatId = beatId;
  state.chronicle.selectedBeatIds = [beatId];
  toggleBeatPreview(beatId);
}

function clearChronicleSelection(): void {
  state.chronicle.selectedBeatIds = [];
  selectionAnchorBeatId = null;
  requestRender();
}

const ALLOCATION_POLICIES: ReadonlySet<ExistingPlacementPolicy> = new Set(["skip", "move", "copy"]);

function selectChronicleAllocationPolicy(policy: string): void {
  if (!ALLOCATION_POLICIES.has(policy as ExistingPlacementPolicy)) {
    return;
  }
  state.chronicle.allocationPolicy = policy as ExistingPlacementPolicy;
  requestRender();
}

/** 現在の lightbox / Chronicle が有効な状態かをまとめて確認する(非同期完了ガードの土台)。 */
function currentAllocationContext(): { projectId: string; pageId: string; scriptId: string } | null {
  const projectId = state.currentProjectId;
  const pageId = state.pagePanelLightbox?.pageId ?? null;
  const scriptId = state.chronicle.scriptId;
  if (!projectId || !pageId || !scriptId || state.chronicle.status !== "ready") {
    return null;
  }
  return { projectId, pageId, scriptId };
}

/** 選択中 Beat に含まれる行 id(重複無し)。 */
function selectedLineIds(): string[] {
  const beatById = new Map(state.chronicle.beats.map((beat) => [beat.id, beat]));
  const ids = new Set<string>();
  for (const beatId of state.chronicle.selectedBeatIds) {
    const beat = beatById.get(beatId);
    if (!beat) {
      continue;
    }
    for (const lineId of beat.lineIds) {
      ids.add(lineId);
    }
  }
  return Array.from(ids);
}

/**
 * 選択中 Beat に含まれる行のうち、現在ページへ割り当て済み・かつ未吹き出し化(balloon_object_id=NULL)の
 * placement id(§2.3「配置案」の対象)。他ページ配置や吹き出し化済みの placement は含めない。
 */
function selectedUnmaterializedPlacementIds(): string[] {
  const currentPageId = state.pagePanelLightbox?.pageId ?? null;
  if (!currentPageId) {
    return [];
  }
  const lineIds = new Set(selectedLineIds());
  const ids: string[] = [];
  for (const line of state.chronicle.lines) {
    if (!lineIds.has(line.lineId)) {
      continue;
    }
    for (const placement of line.placements) {
      if (placement.pageId === currentPageId && !placement.balloonObjectId) {
        ids.push(placement.id);
      }
    }
  }
  return ids;
}

/** preview 結果が実際にリクエストした placementIds 全体(配置済み+unplaced の和集合)を復元する。 */
function requestedPlacementIdsOf(preview: DialogueLayoutPreview): string[] {
  return [...preview.assignments.map((assignment) => assignment.placementId), ...preview.unplacedPlacementIds];
}

/** 「配置案」(§2.3・§3): preview API を叩き、DB を書き換えずに `state.chronicle.preview` へ保持する。 */
async function previewChronicleLayout(): Promise<void> {
  const context = currentAllocationContext();
  const placementIds = selectedUnmaterializedPlacementIds();
  if (!context || state.chronicle.busyAction) {
    return;
  }
  if (placementIds.length === 0) {
    pushToast("配置案の対象(未吹き出し化の行)がありません。", "info");
    return;
  }
  state.chronicle.busyAction = "preview";
  requestRender();
  try {
    const result = await api<DialogueLayoutPreview>(
      `/api/projects/${context.projectId}/pages/${context.pageId}/dialogue-layout/preview`,
      { method: "POST", body: JSON.stringify({ placementIds }) }
    );
    if (state.pagePanelLightbox?.pageId !== context.pageId) {
      return;
    }
    state.chronicle.preview = result;
    for (const warning of result.warnings) {
      pushToast(warning, "info");
    }
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    if (state.chronicle.busyAction === "preview") {
      state.chronicle.busyAction = null;
    }
    requestRender();
  }
}

/** 「キャンセル」(§2.3): プレビューを破棄する(DB は元々未更新なので取り消す対象は state のみ)。 */
function cancelChronicleLayoutPreview(): void {
  state.chronicle.preview = null;
  requestRender();
}

/**
 * 「確定」(§2.3・§3): apply API でトランザクション一括保存する。apply 直前の draft スナップショットを
 * `pageObjectHistory` へ1エントリとして積み、Undo 一回で一括配置前へ戻せるようにする。apply はサーバー側
 * DB の現在の objects_json を基準に動くため、まず未保存の draft 編集を flush してから呼ぶ
 * (クライアント draft と DB の食い違いを避ける -- flush 完了後に取るスナップショットが Undo の基準点になる)。
 */
async function applyChronicleLayoutPreview(): Promise<void> {
  const context = currentAllocationContext();
  const preview = state.chronicle.preview;
  if (!context || !preview || state.chronicle.busyAction) {
    return;
  }
  if (preview.unplacedPlacementIds.length > 0) {
    pushToast("配置できない行が含まれています。seed を変えて再試行するか、対象を絞ってください。", "error");
    return;
  }
  state.chronicle.busyAction = "apply";
  requestRender();
  try {
    await flushPageObjectsSave();
    if (state.pagePanelLightbox?.pageId !== context.pageId) {
      return;
    }
    const previousSnapshot = currentPageObjectsSnapshot();
    const placementIds = requestedPlacementIdsOf(preview);
    const result = await api<DialogueLayoutPreview>(
      `/api/projects/${context.projectId}/pages/${context.pageId}/dialogue-layout/apply`,
      { method: "POST", body: JSON.stringify({ placementIds, seed: preview.seed }) }
    );
    if (state.pagePanelLightbox?.pageId !== context.pageId) {
      return;
    }
    pushPageObjectHistorySnapshotExternal(previousSnapshot);
    const detail = await api<PageDetail>(`/api/projects/${context.projectId}/pages/${context.pageId}`);
    if (state.pagePanelLightbox?.pageId !== context.pageId) {
      return;
    }
    state.pageObjectsDraft = detail.page.objects ?? [];
    ensureAllPageObjectTextLayouts(state.pageObjectsDraft);
    markPageObjectsDirty();
    state.chronicle.preview = null;
    pushToast(`${result.objects.length}件の吹き出しを配置しました。`, "info");
    await loadChronicleData(context.projectId, context.scriptId, context.pageId);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    if (state.chronicle.busyAction === "apply") {
      state.chronicle.busyAction = null;
    }
    requestRender();
  }
}

/**
 * 「再配置」(§2.6・§3・§6 フェーズIV): 現在ページの materialized かつ auto_layout_locked=0 の
 * placement 群を新しい seed で配置し直す。`applyChronicleLayoutPreview` と同じ手順(flush→snapshot→
 * API→pageObjectsDraft 最新化→履歴1エントリ)を踏む -- Undo 1回で reflow 前へ戻せるようにするため。
 * 選択中の Beat/preview には依存しない(常に「現在ページの対象全部」を再配置する、seed は毎回サーバー生成)。
 */
async function reflowChronicleLayout(): Promise<void> {
  const context = currentAllocationContext();
  if (!context || state.chronicle.busyAction) {
    return;
  }
  state.chronicle.busyAction = "reflow";
  requestRender();
  try {
    await flushPageObjectsSave();
    if (state.pagePanelLightbox?.pageId !== context.pageId) {
      return;
    }
    const previousSnapshot = currentPageObjectsSnapshot();
    const result = await api<DialogueLayoutPreview>(
      `/api/projects/${context.projectId}/pages/${context.pageId}/dialogue-layout/reflow`,
      { method: "POST", body: JSON.stringify({}) }
    );
    if (state.pagePanelLightbox?.pageId !== context.pageId) {
      return;
    }
    if (result.objects.length === 0) {
      for (const warning of result.warnings) {
        pushToast(warning, "info");
      }
      return;
    }
    pushPageObjectHistorySnapshotExternal(previousSnapshot);
    const detail = await api<PageDetail>(`/api/projects/${context.projectId}/pages/${context.pageId}`);
    if (state.pagePanelLightbox?.pageId !== context.pageId) {
      return;
    }
    state.pageObjectsDraft = detail.page.objects ?? [];
    ensureAllPageObjectTextLayouts(state.pageObjectsDraft);
    markPageObjectsDirty();
    for (const warning of result.warnings) {
      pushToast(warning, "info");
    }
    pushToast(`${result.objects.length}件を再配置しました(seed ${result.seed})。`, "info");
    await loadChronicleData(context.projectId, context.scriptId, context.pageId);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    if (state.chronicle.busyAction === "reflow") {
      state.chronicle.busyAction = null;
    }
    requestRender();
  }
}

/**
 * 「ロック解除(現在ページ一括)」(§2.6・§6 フェーズIV)。busyAction を専有しない(reflow/apply とは
 * 独立した軽い操作のため専用の in-flight フラグでガードする)。解除後は再配置対象へ復帰する
 * (`loadChronicleData` で lines/beats を再取得すれば `autoLayoutLocked` が false に戻って反映される)。
 */
let chronicleUnlockAllInFlight = false;

async function unlockAllChroniclePlacementsForCurrentPage(): Promise<void> {
  const context = currentAllocationContext();
  if (!context || chronicleUnlockAllInFlight) {
    return;
  }
  chronicleUnlockAllInFlight = true;
  requestRender();
  try {
    const result = await api<DialogueLayoutUnlockResult>(
      `/api/projects/${context.projectId}/pages/${context.pageId}/dialogue-layout/unlock`,
      { method: "POST", body: JSON.stringify({}) }
    );
    if (state.pagePanelLightbox?.pageId !== context.pageId) {
      return;
    }
    pushToast(`${result.unlocked}件のロックを解除しました。`, "info");
    await loadChronicleData(context.projectId, context.scriptId, context.pageId);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    chronicleUnlockAllInFlight = false;
    requestRender();
  }
}

/** Beat プレビュー内の個別行の「ロック解除」(§2.6・§6 フェーズIV)。 */
async function unlockChroniclePlacement(placementId: string): Promise<void> {
  const context = currentAllocationContext();
  if (!context) {
    return;
  }
  try {
    await api(`/api/dialogue-placements/${placementId}`, {
      method: "PATCH",
      body: JSON.stringify({ autoLayoutLocked: false })
    });
    if (state.pagePanelLightbox?.pageId !== context.pageId) {
      return;
    }
    await loadChronicleData(context.projectId, context.scriptId, context.pageId);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  }
}

/**
 * 相互選択ジャンプ(§2.6・§6 フェーズIV): Beat プレビュー内の行クリックで、現在ページに対応する
 * 吹き出し(balloonObjectId)があればオブジェクトモードへ切り替えて選択+スクロールする。
 * 対応する吹き出しが無ければ(未配置/他ページ配置/未吹き出し化)何もせず通知するだけ。
 */
function selectChronicleLineObject(lineId: string): void {
  const currentPageId = state.pagePanelLightbox?.pageId ?? null;
  if (!currentPageId) {
    return;
  }
  const line = state.chronicle.lines.find((item) => item.lineId === lineId);
  const placement = line?.placements.find((item) => item.pageId === currentPageId && item.balloonObjectId);
  if (!placement || !placement.balloonObjectId) {
    pushToast("このページに対応する吹き出しがありません。", "info");
    return;
  }
  const objectId = placement.balloonObjectId;
  setPagePanelMode("objects");
  state.selectedPageObjectId = objectId;
  lastHighlightedObjectId = objectId; // 直後の syncChronicleObjectSelectionHighlight による自己ハイライトを抑止する。
  requestRender();
  requestAnimationFrame(() => {
    const el = document.querySelector<SVGElement>(`[data-page-object="${objectId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  });
}

/**
 * 手動編集での自動ロック(§2.6): ユーザーが自動生成吹き出し(placement に auto_layout_seed があり
 * balloon_object_id が一致)を移動/リサイズ/回転/尻尾変更したら、対応 placement の
 * `auto_layout_locked=1` を自動設定する。`pageObjectsController.ts` のギズモドラッグ確定
 * (`handlePageObjectsPointerUp`)・回転リセット/尻尾プロパティ変更(`commitObjectMutation`/
 * `commitFieldChange` 経由)から objectId を渡して呼ぶ。Chronicle バーが開いていない
 * (`status !== "ready"`)/対象が見つからない/既にロック済みなら何もしない(サイレントに no-op)。
 */
export function notifyChroniclePageObjectManualEdit(objectId: string): void {
  if (state.chronicle.status !== "ready") {
    return;
  }
  const currentPageId = state.pagePanelLightbox?.pageId ?? null;
  if (!currentPageId) {
    return;
  }
  for (const line of state.chronicle.lines) {
    for (const placement of line.placements) {
      if (
        placement.balloonObjectId === objectId &&
        placement.pageId === currentPageId &&
        placement.autoLayoutSeed !== null &&
        placement.autoLayoutSeed !== undefined &&
        !placement.autoLayoutLocked
      ) {
        // 楽観的にローカル state を更新してから PATCH する(バーのロック表示を即座に反映する)。
        placement.autoLayoutLocked = true;
        requestRender();
        void api(`/api/dialogue-placements/${placement.id}`, {
          method: "PATCH",
          body: JSON.stringify({ autoLayoutLocked: true })
        }).catch((error) => {
          pushToast(error instanceof Error ? error.message : String(error), "error");
        });
        return;
      }
    }
  }
}

/** 「現在ページへ割り当て」(§2.3・§3)。busyAction="assign" でガードする。 */
async function assignSelectionToCurrentPage(): Promise<void> {
  const context = currentAllocationContext();
  const lineIds = selectedLineIds();
  if (!context || lineIds.length === 0 || state.chronicle.busyAction) {
    return;
  }
  state.chronicle.busyAction = "assign";
  requestRender();
  try {
    const result = await api<DialogueAllocationResult>(
      `/api/projects/${context.projectId}/pages/${context.pageId}/dialogue-allocation`,
      { method: "POST", body: JSON.stringify({ lineIds, existingPlacementPolicy: state.chronicle.allocationPolicy }) }
    );
    if (state.pagePanelLightbox?.pageId !== context.pageId) {
      return;
    }
    reportAllocationResult(result);
    await loadChronicleData(context.projectId, context.scriptId, context.pageId);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    if (state.chronicle.busyAction === "assign") {
      state.chronicle.busyAction = null;
    }
    requestRender();
  }
}

function reportAllocationResult(result: DialogueAllocationResult): void {
  for (const warning of result.warnings) {
    pushToast(warning, "info");
  }
  const parts = [`${result.created}件を割り当てました`];
  if (result.moved > 0) {
    parts.push(`移動 ${result.moved}件`);
  }
  if (result.skipped > 0) {
    parts.push(`スキップ ${result.skipped}件`);
  }
  pushToast(`${parts.join("・")}。`, "info");
}

/**
 * 「割り当て解除」(§2.3)。選択 Beat のうち吹き出し化済み(balloon_object_id 有り)の行は
 * サーバ側で対象外となり warnings で返る(吹き出し削除はフェーズIVの領域)。
 */
async function removeSelectionFromCurrentPage(): Promise<void> {
  const context = currentAllocationContext();
  const lineIds = selectedLineIds();
  if (!context || lineIds.length === 0 || state.chronicle.busyAction) {
    return;
  }
  state.chronicle.busyAction = "assign";
  requestRender();
  try {
    const result = await api<DialogueAllocationRemovalResult>(
      `/api/projects/${context.projectId}/pages/${context.pageId}/dialogue-allocation/remove`,
      { method: "POST", body: JSON.stringify({ lineIds }) }
    );
    if (state.pagePanelLightbox?.pageId !== context.pageId) {
      return;
    }
    for (const warning of result.warnings) {
      pushToast(warning, "info");
    }
    pushToast(`${result.removed}件の割り当てを解除しました。`, "info");
    await loadChronicleData(context.projectId, context.scriptId, context.pageId);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    if (state.chronicle.busyAction === "assign") {
      state.chronicle.busyAction = null;
    }
    requestRender();
  }
}

/** 「次の未配置区間へ」(§2.1): 最初の unassigned Beat をプレビュー表示+横スクロールでハイライトする。 */
function jumpToNextUnassignedBeat(): void {
  const currentPageId = state.pagePanelLightbox?.pageId ?? null;
  const lineSummaryById = new Map(state.chronicle.lines.map((line) => [line.lineId, line]));
  const target = state.chronicle.beats.find(
    (beat) => computeBeatState(beat, lineSummaryById, currentPageId).status === "unassigned"
  );
  if (!target) {
    pushToast("未配置の区間はありません。", "info");
    return;
  }
  state.chronicle.previewBeatId = target.id;
  requestRender();
  requestAnimationFrame(() => {
    const chip = document.querySelector<HTMLElement>(`.chronicle-beat[data-id="${target.id}"]`);
    if (!chip) {
      return;
    }
    chip.scrollIntoView({ inline: "center", block: "nearest" });
    chip.classList.add("is-jump-highlight");
    window.setTimeout(() => chip.classList.remove("is-jump-highlight"), 1200);
  });
}

/** `bindChronicleEvents` の capture リスナーが記録する、直近の Beat クリックの Shift 押下有無。 */
let shiftKeyForLastBeatClick = false;

registerActions({
  "select-chronicle-script": (id) => selectChronicleScript(id),
  "toggle-chronicle-collapsed": () => toggleChronicleCollapsed(),
  "toggle-chronicle-beat-preview": (id) => handleBeatClick(id, shiftKeyForLastBeatClick),
  "select-chronicle-allocation-policy": (id) => selectChronicleAllocationPolicy(id),
  "clear-chronicle-selection": () => clearChronicleSelection(),
  "assign-chronicle-selection": () => void assignSelectionToCurrentPage(),
  "remove-chronicle-selection": () => void removeSelectionFromCurrentPage(),
  "jump-chronicle-next-unassigned": () => jumpToNextUnassignedBeat(),
  "preview-chronicle-layout": () => void previewChronicleLayout(),
  "apply-chronicle-layout": () => void applyChronicleLayoutPreview(),
  "cancel-chronicle-layout": () => cancelChronicleLayoutPreview(),
  "reflow-chronicle-layout": () => void reflowChronicleLayout(),
  "unlock-all-chronicle-placements": () => void unlockAllChroniclePlacementsForCurrentPage(),
  "unlock-chronicle-placement": (id) => void unlockChroniclePlacement(id),
  "select-chronicle-line-object": (id) => selectChronicleLineObject(id)
});

/** ページ切替時(=lightbox 再オープン)ごとに1回だけ自動スクロールする(ユーザーの手動スクロールを尊重)。 */
let lastAutoScrollKey: string | null = null;

/**
 * main.ts の render() 後 sync 処理から呼ぶ(`syncPagePanelCropGizmo` 等と同型)。現在ページに
 * 割り当て済みの先頭 Beat が見えるようスクロールする(§2.1)。
 */
export function syncChronicleBarScroll(): void {
  if (state.chronicle.status !== "ready" || !state.pagePanelLightbox || state.chronicle.collapsed) {
    return;
  }
  const key = `${state.chronicle.scriptId}:${state.pagePanelLightbox.pageId}`;
  if (lastAutoScrollKey === key) {
    return;
  }
  const track = document.querySelector<HTMLElement>(".chronicle-bar-track");
  if (!track) {
    return;
  }
  lastAutoScrollKey = key;
  const target = track.querySelector<HTMLElement>(".chronicle-beat.is-current-page");
  target?.scrollIntoView({ inline: "center", block: "nearest" });
}

/**
 * 相互選択ジャンプの逆方向(§2.6・§6 フェーズIV): ページ上で自動生成吹き出しを選択したら、対応する
 * Beat を Chronicle 上で強調+スクロールする。`state.selectedPageObjectId` の変化を検知して1回だけ
 * 処理する(無限ループ防止 -- `selectChronicleLineObject` は選択直後に `lastHighlightedObjectId` を
 * 先回りで更新するので、Beat→オブジェクト方向のジャンプがこの関数を再度発火させることはない)。
 */
let lastHighlightedObjectId: string | null = null;

export function syncChronicleObjectSelectionHighlight(): void {
  if (state.chronicle.status !== "ready" || !state.pagePanelLightbox) {
    lastHighlightedObjectId = null;
    return;
  }
  const selectedId = state.selectedPageObjectId;
  if (selectedId === lastHighlightedObjectId) {
    return;
  }
  lastHighlightedObjectId = selectedId;
  if (!selectedId) {
    return;
  }
  const currentPageId = state.pagePanelLightbox.pageId;
  let targetLineId: string | null = null;
  for (const line of state.chronicle.lines) {
    if (line.placements.some((placement) => placement.pageId === currentPageId && placement.balloonObjectId === selectedId)) {
      targetLineId = line.lineId;
      break;
    }
  }
  if (!targetLineId) {
    return;
  }
  const beat = state.chronicle.beats.find((item) => item.lineIds.includes(targetLineId!));
  if (!beat) {
    return;
  }
  requestAnimationFrame(() => {
    const chip = document.querySelector<HTMLElement>(`.chronicle-beat[data-id="${beat.id}"]`);
    if (!chip) {
      return;
    }
    chip.scrollIntoView({ inline: "center", block: "nearest" });
    chip.classList.add("is-jump-highlight");
    window.setTimeout(() => chip.classList.remove("is-jump-highlight"), 1200);
  });
}

/** Shift+ホイールでの横スクロール(§2.1)。app 全体へ委譲し、`.chronicle-bar-track` 内だけ処理する。 */
function bindChronicleEvents(app: HTMLElement) {
  app.addEventListener(
    "wheel",
    (event) => {
      if (!event.shiftKey || event.deltaY === 0) {
        return;
      }
      const track = (event.target as HTMLElement | null)?.closest<HTMLElement>(".chronicle-bar-track");
      if (!track) {
        return;
      }
      track.scrollLeft += event.deltaY;
      event.preventDefault();
    },
    { passive: false }
  );

  // Beat クリックの Shift 修飾を拾う(§2.3)。`registerActions` のハンドラは (id, target) しか
  // 受け取らないため(main.ts の click 委譲が生イベントを渡さない)、capture フェーズで先取りして
  // モジュール変数に記録する。capture リスナーは同一要素上の bubble リスナー(main.ts の click 委譲)
  // より必ず先に走るため、登録順に依存しない。
  app.addEventListener(
    "click",
    (event) => {
      const chip = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        '.chronicle-beat[data-action="toggle-chronicle-beat-preview"]'
      );
      shiftKeyForLastBeatClick = chip ? event.shiftKey : false;
    },
    { capture: true }
  );
}

registerEventBinder(bindChronicleEvents);
