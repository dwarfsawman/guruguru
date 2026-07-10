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
  ExistingPlacementPolicy
} from "../shared/chronicle";
import type { MangaScript } from "../shared/apiTypes";
import { computeBeatState } from "../shared/chronicleBeat";
import { api } from "./api";
import { pushToast, requestRender, setChronicleCollapsed, state } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";

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
  "jump-chronicle-next-unassigned": () => jumpToNextUnassignedBeat()
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
