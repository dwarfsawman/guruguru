/**
 * Book Reader（漫画ビューア）の純ロジック。ページのペアリング（見開き）とページ送りを
 * DOM から完全に分離し、ユニットテストで pin する（`bookReader.test.ts`）。ここには副作用
 * （localStorage / DOM）を置かない ── 永続化は `bookReaderController` が担当する。
 *
 * 用語:
 * - 「論理ページ順」= 引数 `pages` の配列順（= `pages.page_index` 昇順）。index は 0-based。
 * - `spreadStartIndex` は UI 上 1-based。内部では 0-based の `spreadStart` に変換して使う。
 * - ナビゲーションは「画面の右＝次へ / 左＝前へ」で固定（direction によらず）。`direction` は
 *   見開き時の左右の並び（どちらの論理ページを右に置くか）だけを切り替える。RTL は先の
 *   ページを右に置くため、漫画本として自然な見た目になる。
 */

export type BookReaderDirection = "rtl" | "ltr";
export type BookReaderLayout = "single" | "spread";
export type BookReaderFitMode = "fit-screen" | "fit-width" | "fit-height";
export type BookReaderBackground = "black" | "gray" | "white";

export interface BookReaderSettings {
  direction: BookReaderDirection;
  layout: BookReaderLayout;
  /** 見開きを開始する 1-based ページ番号。これより前のページは常に単ページ表示。 */
  spreadStartIndex: number;
  showPageNumber: boolean;
  fitMode: BookReaderFitMode;
  background: BookReaderBackground;
}

export const DEFAULT_BOOK_READER_SETTINGS: BookReaderSettings = {
  direction: "rtl",
  layout: "single",
  spreadStartIndex: 1,
  showPageNumber: true,
  fitMode: "fit-screen",
  background: "black"
};

/** 表示中の1ページ。論理 index と 1-based 番号を保持する（ペアリング/ページ送りの結果）。 */
export interface VisibleReaderPage<T> {
  page: T;
  /** 0-based の論理ページ index。 */
  index: number;
  /** 1-based のページ番号（ラベル/プレースホルダ用）。 */
  pageNumber: number;
}

const DIRECTIONS: BookReaderDirection[] = ["rtl", "ltr"];
const LAYOUTS: BookReaderLayout[] = ["single", "spread"];
const FIT_MODES: BookReaderFitMode[] = ["fit-screen", "fit-width", "fit-height"];
const BACKGROUNDS: BookReaderBackground[] = ["black", "gray", "white"];

function oneOf<T>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * 任意の入力（localStorage の JSON など）を有効な設定へ矯正する。未知/不正なフィールドは
 * 既定値に落とす。`spreadStartIndex` は 1 以上の整数へクランプする。
 */
export function normalizeBookReaderSettings(input: unknown): BookReaderSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const spreadRaw = Number(raw.spreadStartIndex);
  const spreadStartIndex =
    Number.isFinite(spreadRaw) && spreadRaw >= 1
      ? Math.floor(spreadRaw)
      : DEFAULT_BOOK_READER_SETTINGS.spreadStartIndex;
  return {
    direction: oneOf(raw.direction, DIRECTIONS, DEFAULT_BOOK_READER_SETTINGS.direction),
    layout: oneOf(raw.layout, LAYOUTS, DEFAULT_BOOK_READER_SETTINGS.layout),
    spreadStartIndex,
    showPageNumber:
      typeof raw.showPageNumber === "boolean" ? raw.showPageNumber : DEFAULT_BOOK_READER_SETTINGS.showPageNumber,
    fitMode: oneOf(raw.fitMode, FIT_MODES, DEFAULT_BOOK_READER_SETTINGS.fitMode),
    background: oneOf(raw.background, BACKGROUNDS, DEFAULT_BOOK_READER_SETTINGS.background)
  };
}

/** 見開き開始の 0-based index（1-based の `spreadStartIndex` を変換、0 未満にはしない）。 */
function spreadStartZeroBased(settings: BookReaderSettings): number {
  return Math.max(0, Math.floor(settings.spreadStartIndex) - 1);
}

function clampIndex(index: number, pagesLength: number): number {
  if (!Number.isFinite(index) || index < 0) {
    return 0;
  }
  const last = Math.max(0, pagesLength - 1);
  return Math.min(last, Math.floor(index));
}

/**
 * 与えられた index を「その index が属する表示の先頭ページ index」に正規化する。
 * single ではクランプのみ。spread では、見開き領域内は必ずペア先頭（`spreadStart` から
 * 2つ刻み）へ丸める。ページ送り・表示ページ算出の基準はすべてこの正規化 index を使う。
 */
export function canonicalReaderIndex(index: number, pagesLength: number, settings: BookReaderSettings): number {
  if (pagesLength <= 0) {
    return 0;
  }
  const clamped = clampIndex(index, pagesLength);
  if (settings.layout === "single") {
    return clamped;
  }
  const s = spreadStartZeroBased(settings);
  if (clamped < s) {
    return clamped;
  }
  const offset = clamped - s;
  return s + Math.floor(offset / 2) * 2;
}

/** Home キーなどで先頭の表示へ移動するための正規化済み index。 */
export function firstReaderIndex(pagesLength: number, settings: BookReaderSettings): number {
  return canonicalReaderIndex(0, pagesLength, settings);
}

/** End キーなどで末尾を含む表示へ移動するための正規化済み index。 */
export function lastReaderIndex(pagesLength: number, settings: BookReaderSettings): number {
  return canonicalReaderIndex(Math.max(0, pagesLength - 1), pagesLength, settings);
}

/** 現在の表示から次の表示へ進むときに動かす論理ページ数（1 または 2）。 */
export function getReaderStep(currentIndex: number, pagesLength: number, settings: BookReaderSettings): number {
  if (settings.layout === "single") {
    return 1;
  }
  const canonical = canonicalReaderIndex(currentIndex, pagesLength, settings);
  return canonical < spreadStartZeroBased(settings) ? 1 : 2;
}

/** 次の表示の先頭 index。末尾ならそれ以上進めず現在の正規化 index を返す。 */
export function goNextReaderIndex(currentIndex: number, pagesLength: number, settings: BookReaderSettings): number {
  if (pagesLength <= 0) {
    return 0;
  }
  const canonical = canonicalReaderIndex(currentIndex, pagesLength, settings);
  const next = canonical + getReaderStep(canonical, pagesLength, settings);
  if (next > pagesLength - 1) {
    return canonical;
  }
  return canonicalReaderIndex(next, pagesLength, settings);
}

/** 前の表示の先頭 index。先頭ならそれ以上戻れず 0 を返す。 */
export function goPrevReaderIndex(currentIndex: number, pagesLength: number, settings: BookReaderSettings): number {
  if (pagesLength <= 0) {
    return 0;
  }
  const canonical = canonicalReaderIndex(currentIndex, pagesLength, settings);
  if (canonical <= 0) {
    return 0;
  }
  if (settings.layout === "single") {
    return canonical - 1;
  }
  // 見開き領域のペア先頭からは 2 つ戻る。ただし spreadStart 直上のペア先頭からは
  // 単ページ領域の 1 つ手前へ（自然に spreadStart 境界へ揃う）。単ページ領域では 1 つずつ。
  const s = spreadStartZeroBased(settings);
  const prev = canonical >= s + 2 ? canonical - 2 : canonical - 1;
  return canonicalReaderIndex(Math.max(0, prev), pagesLength, settings);
}

/**
 * 現在表示すべきページを DISPLAY 順（画面の左→右）で返す。
 * - single: 常に 1 ページ。
 * - spread: `spreadStart` より前は単ページ。以降は 2 ページを組み、`direction === "rtl"` は
 *   左右を反転（先の論理ページを右に置く）。最終ページが片側だけになる場合は 1 ページ。
 * 画像の有無は問わない（画像なしページもそのまま含め、プレースホルダ表示は view 側の責務）。
 */
export function getVisibleReaderPages<T>(
  pages: T[],
  currentIndex: number,
  settings: BookReaderSettings
): VisibleReaderPage<T>[] {
  if (pages.length === 0) {
    return [];
  }
  const canonical = canonicalReaderIndex(currentIndex, pages.length, settings);
  const makeVisible = (index: number): VisibleReaderPage<T> => ({
    page: pages[index],
    index,
    pageNumber: index + 1
  });

  if (settings.layout === "single") {
    return [makeVisible(canonical)];
  }

  const s = spreadStartZeroBased(settings);
  if (canonical < s) {
    return [makeVisible(canonical)];
  }

  const logical: VisibleReaderPage<T>[] = [makeVisible(canonical)];
  if (canonical + 1 <= pages.length - 1) {
    logical.push(makeVisible(canonical + 1));
  }
  if (logical.length === 2 && settings.direction === "rtl") {
    return [logical[1], logical[0]];
  }
  return logical;
}

/**
 * ページ番号ラベル。単ページは `3 / 12`、見開きは論理番号の昇順で `2-3 / 12`。
 * DISPLAY 順（rtl 反転）に依らず、常に小さいページ番号を先に出す。
 */
export function readerPageLabel<T>(visiblePages: VisibleReaderPage<T>[], totalPages: number): string {
  if (visiblePages.length === 0) {
    return `0 / ${totalPages}`;
  }
  const numbers = visiblePages.map((visible) => visible.pageNumber).sort((a, b) => a - b);
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  const range = first === last ? `${first}` : `${first}-${last}`;
  return `${range} / ${totalPages}`;
}
