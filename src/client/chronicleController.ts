/**
 * Chronicle バー(S5、Docs/Feature-ChroniclePageFlow.md)の controller。フェーズI: 表示のみ
 * (取得・折り畳み・複数脚本セレクタ・Beat クリックでの内容プレビュー)。範囲選択・一括割り当て・
 * 自動配置はフェーズII 以降。ページ編集 lightbox(`pagePanelLightboxController.ts`)のライフサイクルに
 * 乗る -- lightbox を開く/閉じるタイミングで一緒に開閉する(ドロワーと同じ乗せ方)。
 */
import type { ChronicleApiResponse } from "../shared/chronicle";
import type { MangaScript } from "../shared/apiTypes";
import { api } from "./api";
import { requestRender, setChronicleCollapsed, state } from "./appState";
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
    errorMessage: null
  };
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

/** Beat クリック: 内容プレビューの開閉トグル(§2.3)。選択/割り当てはフェーズII以降。 */
function toggleBeatPreview(beatId: string): void {
  state.chronicle.previewBeatId = state.chronicle.previewBeatId === beatId ? null : beatId;
  requestRender();
}

registerActions({
  "select-chronicle-script": (id) => selectChronicleScript(id),
  "toggle-chronicle-collapsed": () => toggleChronicleCollapsed(),
  "toggle-chronicle-beat-preview": (id) => toggleBeatPreview(id)
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
}

registerEventBinder(bindChronicleEvents);
