/**
 * Book Reader（漫画ビューア）の controller。ページ一覧グリッドの「読む」ボタンから開き、
 * ページ送り・見開き/方向/フィット/背景の切替を扱う。純ロジックは `bookReader.ts`、DOM 生成は
 * `views/bookReaderView.ts` に分離してある。ここはそれらと `state` を橋渡しするだけ。
 *
 * AGENTS.md 規約: data-action は `registerActions`、キーボードは main.ts の keydown から
 * `handleBookReaderKeydown` を呼ぶ（他の editor controller と同じ委譲パターン）。設定の
 * 永続化は localStorage（プロジェクト別キー）。DB へ移す可能性に備え read/write を分離する。
 *
 * ナビゲーションは「画面右＝次へ / 左＝前へ」で固定（direction によらず）。生成・削除・リネームは
 * Reader からは行わない（既存のページ一覧/1枚生成 UI の責務）。Reader を開いている間は
 * `state.detail` を使わない（bookReaderOpen と detail は排他）。
 */
import { requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { isTextEntryTarget } from "./clientUtils";
import {
  DEFAULT_BOOK_READER_SETTINGS,
  canonicalReaderIndex,
  firstReaderIndex,
  goNextReaderIndex,
  goPrevReaderIndex,
  lastReaderIndex,
  normalizeBookReaderSettings,
  type BookReaderBackground,
  type BookReaderDirection,
  type BookReaderFitMode,
  type BookReaderLayout,
  type BookReaderSettings
} from "./bookReader";

const READER_SETTINGS_KEY_PREFIX = "guruguru:bookReaderSettings:";

/** プロジェクト別の Reader 設定を localStorage から読む（無ければ既定）。将来 DB 化する場合の差し替え点。 */
export function loadBookReaderSettings(projectId: string): BookReaderSettings {
  try {
    const raw = window.localStorage.getItem(READER_SETTINGS_KEY_PREFIX + projectId);
    if (!raw) {
      return { ...DEFAULT_BOOK_READER_SETTINGS };
    }
    return normalizeBookReaderSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BOOK_READER_SETTINGS };
  }
}

/** プロジェクト別の Reader 設定を localStorage へ書く（プロジェクトを跨いで混ざらないようキーを分ける）。 */
export function saveBookReaderSettings(projectId: string, settings: BookReaderSettings): void {
  try {
    window.localStorage.setItem(
      READER_SETTINGS_KEY_PREFIX + projectId,
      JSON.stringify(normalizeBookReaderSettings(settings))
    );
  } catch {
    // localStorage が使えない環境では永続化しない（セッション内は state で維持される）。
  }
}

function pagesLength(): number {
  return state.book?.pages.length ?? 0;
}

/** ページ一覧の「読む」ボタンから Reader を開く。設定を復元し、先頭ページから表示する。 */
function openBookReader() {
  if (!state.currentProjectId || !state.book) {
    return;
  }
  state.bookReaderSettings = loadBookReaderSettings(state.currentProjectId);
  state.bookReaderPageIndex = canonicalReaderIndex(0, pagesLength(), state.bookReaderSettings);
  state.bookReaderOpen = true;
  state.bookReaderSettingsOpen = false;
  requestRender();
}

/** Reader を閉じてページ一覧グリッドへ戻る（state.book はそのままなのでグリッドが再描画される）。 */
function closeBookReader() {
  state.bookReaderOpen = false;
  state.bookReaderSettingsOpen = false;
  requestRender();
}

function readerNext() {
  state.bookReaderPageIndex = goNextReaderIndex(state.bookReaderPageIndex, pagesLength(), state.bookReaderSettings);
  requestRender();
}

function readerPrev() {
  state.bookReaderPageIndex = goPrevReaderIndex(state.bookReaderPageIndex, pagesLength(), state.bookReaderSettings);
  requestRender();
}

function readerFirst() {
  state.bookReaderPageIndex = firstReaderIndex(pagesLength(), state.bookReaderSettings);
  requestRender();
}

function readerLast() {
  state.bookReaderPageIndex = lastReaderIndex(pagesLength(), state.bookReaderSettings);
  requestRender();
}

function toggleReaderSettingsPanel() {
  state.bookReaderSettingsOpen = !state.bookReaderSettingsOpen;
  requestRender();
}

/**
 * 設定を差分更新して正規化・永続化・再描画する。レイアウトや見開き開始が変わると現在 index が
 * ペア途中に来る場合があるので、必ず正規化し直して見開き境界に揃える。
 */
function updateReaderSettings(patch: Partial<BookReaderSettings>) {
  if (!state.currentProjectId) {
    return;
  }
  const next = normalizeBookReaderSettings({ ...state.bookReaderSettings, ...patch });
  state.bookReaderSettings = next;
  state.bookReaderPageIndex = canonicalReaderIndex(state.bookReaderPageIndex, pagesLength(), next);
  saveBookReaderSettings(state.currentProjectId, next);
  requestRender();
}

/** 見開き開始ページ（1-based）を増減する。1 以上・総ページ数以下にクランプする。 */
function adjustSpreadStart(delta: number) {
  const upper = Math.max(1, pagesLength());
  const nextIndex = Math.min(upper, Math.max(1, state.bookReaderSettings.spreadStartIndex + delta));
  updateReaderSettings({ spreadStartIndex: nextIndex });
}

function toggleReaderPageNumber() {
  updateReaderSettings({ showPageNumber: !state.bookReaderSettings.showPageNumber });
}

/**
 * Reader が開いている間のキーボード操作。main.ts の window keydown から呼ぶ。
 * - Escape: 設定パネルが開いていれば閉じ、無ければ Reader を閉じる。
 * - Space / ArrowRight: 次へ、ArrowLeft: 前へ（画面右＝次で固定）。
 * - Home / End: 先頭 / 末尾を含む表示へジャンプする。
 * text-entry（見開き開始の数値入力など）にフォーカス中はページ送りキーを奪わない。
 * 処理したら true を返す（呼び出し側はそこで return する）。
 */
export function handleBookReaderKeydown(event: KeyboardEvent): boolean {
  if (!state.bookReaderOpen) {
    return false;
  }
  if (event.key === "Escape") {
    if (state.bookReaderSettingsOpen) {
      state.bookReaderSettingsOpen = false;
      requestRender();
    } else {
      closeBookReader();
    }
    return true;
  }
  if (isTextEntryTarget(event.target)) {
    return false;
  }
  if (event.key === "ArrowRight" || event.key === " " || event.key === "Spacebar") {
    event.preventDefault();
    readerNext();
    return true;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    readerPrev();
    return true;
  }
  if (event.key === "Home") {
    event.preventDefault();
    readerFirst();
    return true;
  }
  if (event.key === "End") {
    event.preventDefault();
    readerLast();
    return true;
  }
  return false;
}

registerActions({
  "open-book-reader": () => openBookReader(),
  "close-book-reader": () => closeBookReader(),
  "book-reader-next": () => readerNext(),
  "book-reader-prev": () => readerPrev(),
  "book-reader-first": () => readerFirst(),
  "book-reader-last": () => readerLast(),
  "book-reader-toggle-settings": () => toggleReaderSettingsPanel(),
  "book-reader-set-direction": (id) => updateReaderSettings({ direction: id as BookReaderDirection }),
  "book-reader-set-layout": (id) => updateReaderSettings({ layout: id as BookReaderLayout }),
  "book-reader-set-fit": (id) => updateReaderSettings({ fitMode: id as BookReaderFitMode }),
  "book-reader-set-bg": (id) => updateReaderSettings({ background: id as BookReaderBackground }),
  "book-reader-toggle-page-number": () => toggleReaderPageNumber(),
  "book-reader-spread-inc": () => adjustSpreadStart(1),
  "book-reader-spread-dec": () => adjustSpreadStart(-1)
});
