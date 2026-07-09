import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BOOK_READER_SETTINGS,
  canonicalReaderIndex,
  getReaderStep,
  getVisibleReaderPages,
  goNextReaderIndex,
  goPrevReaderIndex,
  normalizeBookReaderSettings,
  readerPageLabel,
  type BookReaderSettings
} from "./bookReader.ts";

// Book Reader（漫画ビューア）のページペアリング・ページ送りの純ロジックを pin する。
// See Docs/Feature-BookReader.md。ナビは「画面右＝次へ / 左＝前へ」で固定、direction は
// 見開きの左右並びだけを切り替える。

/** テスト用ページ（img が undefined = 画像なしページ）。 */
interface TestPage {
  id: string;
  img?: string;
}

function makePages(count: number, opts: { missing?: number[] } = {}): TestPage[] {
  const missing = new Set(opts.missing ?? []);
  return Array.from({ length: count }, (_unused, index) => {
    const page: TestPage = { id: `p${index + 1}` };
    if (!missing.has(index)) {
      page.img = `/api/img/p${index + 1}`;
    }
    return page;
  });
}

function settings(overrides: Partial<BookReaderSettings> = {}): BookReaderSettings {
  return { ...DEFAULT_BOOK_READER_SETTINGS, ...overrides };
}

/** DISPLAY 順の pageNumber 配列（画面の左→右）。 */
function visibleNumbers<T>(visible: { pageNumber: number }[]): number[] {
  return visible.map((entry) => entry.pageNumber);
}

// --- normalizeBookReaderSettings ---

test("normalize: 空/不正入力は既定値", () => {
  assert.deepEqual(normalizeBookReaderSettings({}), DEFAULT_BOOK_READER_SETTINGS);
  assert.deepEqual(normalizeBookReaderSettings(null), DEFAULT_BOOK_READER_SETTINGS);
  assert.deepEqual(normalizeBookReaderSettings("nope"), DEFAULT_BOOK_READER_SETTINGS);
  assert.deepEqual(
    normalizeBookReaderSettings({ direction: "sideways", layout: "grid", fitMode: "zoom", background: "pink" }),
    DEFAULT_BOOK_READER_SETTINGS
  );
});

test("normalize: 正しい値はそのまま保持", () => {
  const input: BookReaderSettings = {
    direction: "ltr",
    layout: "spread",
    spreadStartIndex: 3,
    showPageNumber: false,
    fitMode: "fit-width",
    background: "white"
  };
  assert.deepEqual(normalizeBookReaderSettings(input), input);
});

test("normalize: spreadStartIndex は 1 以上の整数へ矯正", () => {
  assert.equal(normalizeBookReaderSettings({ spreadStartIndex: 0 }).spreadStartIndex, 1);
  assert.equal(normalizeBookReaderSettings({ spreadStartIndex: -4 }).spreadStartIndex, 1);
  assert.equal(normalizeBookReaderSettings({ spreadStartIndex: 2.7 }).spreadStartIndex, 2);
  assert.equal(normalizeBookReaderSettings({ spreadStartIndex: "5" }).spreadStartIndex, 5);
  assert.equal(normalizeBookReaderSettings({ spreadStartIndex: "abc" }).spreadStartIndex, 1);
});

// --- single 表示 ---

test("single + rtl: 常に 1 ページ・順次移動", () => {
  const pages = makePages(3);
  const config = settings({ layout: "single", direction: "rtl" });
  const view = getVisibleReaderPages(pages, 0, config);
  assert.equal(view.length, 1);
  assert.deepEqual(visibleNumbers(view), [1]);
  assert.equal(getReaderStep(0, pages.length, config), 1);
  assert.equal(goNextReaderIndex(0, pages.length, config), 1);
  assert.equal(goNextReaderIndex(1, pages.length, config), 2);
  assert.equal(goNextReaderIndex(2, pages.length, config), 2, "末尾で止まる");
  assert.equal(goPrevReaderIndex(0, pages.length, config), 0, "先頭で止まる");
  assert.equal(readerPageLabel(getVisibleReaderPages(pages, 2, config), pages.length), "3 / 3");
});

test("single + ltr: direction は単ページに影響しない", () => {
  const pages = makePages(3);
  const config = settings({ layout: "single", direction: "ltr" });
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 1, config)), [2]);
  assert.equal(readerPageLabel(getVisibleReaderPages(pages, 1, config), pages.length), "2 / 3");
});

// --- spread 表示 ---

test("spread + rtl + spreadStartIndex=1: 先頭からペア・先のページが右", () => {
  const pages = makePages(6);
  const config = settings({ layout: "spread", direction: "rtl", spreadStartIndex: 1 });
  // 論理 1,2 の見開き → 画面は [2][1]（右に 1、左に 2）。DISPLAY 配列は左→右なので [2,1]。
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 0, config)), [2, 1]);
  assert.equal(readerPageLabel(getVisibleReaderPages(pages, 0, config), pages.length), "1-2 / 6");
  assert.equal(getReaderStep(0, pages.length, config), 2);
  assert.equal(goNextReaderIndex(0, pages.length, config), 2);
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 2, config)), [4, 3]);
  assert.equal(goPrevReaderIndex(2, pages.length, config), 0);
});

test("spread + rtl + spreadStartIndex=2: 1ページ目は単ページ、2-3から見開き", () => {
  const pages = makePages(7);
  const config = settings({ layout: "spread", direction: "rtl", spreadStartIndex: 2 });
  // 1 ページ目は単ページ。
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 0, config)), [1]);
  assert.equal(getReaderStep(0, pages.length, config), 1);
  assert.equal(goNextReaderIndex(0, pages.length, config), 1);
  // 論理 2,3 の見開き → 右に 2、左に 3 → DISPLAY [3,2]。
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 1, config)), [3, 2]);
  assert.equal(readerPageLabel(getVisibleReaderPages(pages, 1, config), pages.length), "2-3 / 7");
  // 次: 4-5 の見開き。
  assert.equal(goNextReaderIndex(1, pages.length, config), 3);
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 3, config)), [5, 4]);
  // 見開き → 単ページ境界へ自然に戻る。
  assert.equal(goPrevReaderIndex(3, pages.length, config), 1, "4-5 の前は 2-3");
  assert.equal(goPrevReaderIndex(1, pages.length, config), 0, "2-3 の前は 1（単ページ）");
});

test("spread + rtl + spreadStartIndex=3: 1,2は単ページ、3-4から見開き", () => {
  const pages = makePages(6);
  const config = settings({ layout: "spread", direction: "rtl", spreadStartIndex: 3 });
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 0, config)), [1]);
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 1, config)), [2]);
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 2, config)), [4, 3]);
  assert.equal(goNextReaderIndex(0, pages.length, config), 1);
  assert.equal(goNextReaderIndex(1, pages.length, config), 2);
  assert.equal(goNextReaderIndex(2, pages.length, config), 4);
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 4, config)), [6, 5]);
});

test("spread + ltr + spreadStartIndex=2: 先のページが左", () => {
  const pages = makePages(7);
  const config = settings({ layout: "spread", direction: "ltr", spreadStartIndex: 2 });
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 0, config)), [1]);
  // 論理 2,3 の見開き → 左に 2、右に 3 → DISPLAY [2,3]。
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 1, config)), [2, 3]);
  assert.equal(readerPageLabel(getVisibleReaderPages(pages, 1, config), pages.length), "2-3 / 7");
});

test("最終ページが奇数で片側だけになるケース", () => {
  const pages = makePages(5); // spreadStartIndex=1 → ペア (1,2)(3,4)(5,-)
  const config = settings({ layout: "spread", direction: "rtl", spreadStartIndex: 1 });
  const last = getVisibleReaderPages(pages, 4, config);
  assert.equal(last.length, 1, "最終ページは片側だけ");
  assert.deepEqual(visibleNumbers(last), [5]);
  assert.equal(readerPageLabel(last, pages.length), "5 / 5");
  assert.equal(goNextReaderIndex(2, pages.length, config), 4, "3-4 の次は単独の 5");
  assert.equal(goNextReaderIndex(4, pages.length, config), 4, "末尾で止まる");
  assert.equal(goPrevReaderIndex(4, pages.length, config), 2, "単独 5 の前は 3-4");
});

test("画像がないページが混じっても落ちず、そのまま含める", () => {
  const pages = makePages(4, { missing: [1, 3] }); // p2, p4 は画像なし
  const config = settings({ layout: "spread", direction: "rtl", spreadStartIndex: 1 });
  const view = getVisibleReaderPages(pages, 0, config); // 論理 1,2 → DISPLAY [p2, p1]
  assert.equal(view.length, 2);
  const p2 = view.find((entry) => entry.pageNumber === 2);
  assert.ok(p2, "画像なしページも表示対象に含まれる");
  assert.equal(p2?.page.img, undefined);
  assert.equal(p2?.page.id, "p2");
});

// --- ページ数 0 / 境界 ---

test("ページ数 0 でも落ちない", () => {
  const config = settings({ layout: "spread", direction: "rtl" });
  assert.deepEqual(getVisibleReaderPages([], 0, config), []);
  assert.equal(goNextReaderIndex(0, 0, config), 0);
  assert.equal(goPrevReaderIndex(0, 0, config), 0);
  assert.equal(canonicalReaderIndex(3, 0, config), 0);
  assert.equal(readerPageLabel([], 0), "0 / 0");
});

test("範囲外 index はクランプされる", () => {
  const pages = makePages(4);
  const config = settings({ layout: "single" });
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, 99, config)), [4]);
  assert.deepEqual(visibleNumbers(getVisibleReaderPages(pages, -5, config)), [1]);
});

test("canonical: 見開き領域内はペア先頭へ丸める", () => {
  const config = settings({ layout: "spread", direction: "rtl", spreadStartIndex: 2 });
  // s=1: (0)単, (1,2), (3,4), (5,6)...
  assert.equal(canonicalReaderIndex(0, 10, config), 0);
  assert.equal(canonicalReaderIndex(1, 10, config), 1);
  assert.equal(canonicalReaderIndex(2, 10, config), 1, "2 は 1-2 ペアの先頭 1 へ");
  assert.equal(canonicalReaderIndex(3, 10, config), 3);
  assert.equal(canonicalReaderIndex(4, 10, config), 3, "4 は 3-4 ペアの先頭 3 へ");
});
