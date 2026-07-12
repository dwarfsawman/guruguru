import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutText, type FontMetricsProvider, type GlyphMetrics } from "./textLayout.ts";
import type { TextContent, TextStyle } from "./pageObjects.ts";

// --- 偽 provider(等幅メトリクス決め打ち。実フォント無しでレイアウト算術だけを検証する) ---

const UNITS_PER_EM = 1000;
const ASCENT = 800;
const DESCENT = -200;
const ADVANCE = 600; // 全角相当のモノスペース想定

/** vert 代替を持つ文字(縦書きフォールバック回転より優先されることを確認するため)。 */
const VERT_CHAR = "V";
const VERT_ADVANCE = 900;

function fakeProvider(): FontMetricsProvider {
  return {
    unitsPerEm: UNITS_PER_EM,
    ascent: ASCENT,
    descent: DESCENT,
    getGlyph(char: string): GlyphMetrics {
      const metrics: GlyphMetrics = { pathD: `M0,0L${char.codePointAt(0)},0Z`, advanceWidth: ADVANCE };
      if (char === VERT_CHAR) {
        metrics.vertPathD = "M0,0L1,1Z";
        metrics.vertAdvance = VERT_ADVANCE;
      }
      return metrics;
    }
  };
}

function style(overrides: Partial<TextStyle> = {}): TextStyle {
  return { fontId: "default", size: 0.1, direction: "horizontal", color: "#000000", ...overrides };
}

function content(text: string, overrides: Partial<TextStyle> = {}): TextContent {
  return { text, style: style(overrides) };
}

function closeTo(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
}

// --- 横書き ---

test("layoutText horizontal: 単純な1行(折り返し無し)の座標をピンする", () => {
  const result = layoutText(fakeProvider(), content("AB"));
  assert.equal(result.lineCount, 1);
  assert.equal(result.glyphs.length, 2);
  const emScale = 0.1 / UNITS_PER_EM;
  const blockWidth = ADVANCE * emScale * 2;
  const centerX = blockWidth / 2;
  // ブロック中心 = 原点であることを直接検証する(bbox の中点が概ね0)。
  closeTo((result.bbox.minX + result.bbox.maxX) / 2, 0, "bbox centerX");
  closeTo((result.bbox.minY + result.bbox.maxY) / 2, 0, "bbox centerY");
  closeTo(result.glyphs[0]!.x, -centerX, "glyph0 x");
  closeTo(result.glyphs[1]!.x, -centerX + ADVANCE * emScale, "glyph1 x");
  closeTo(result.glyphs[0]!.y, result.glyphs[1]!.y, "同一行は同じベースライン");
  assert.equal(result.glyphs[0]!.rotationDeg, 0);
});

test("layoutText horizontal: letterSpacing/size がグリフ間隔に反映される", () => {
  const emScale = 0.2 / UNITS_PER_EM;
  const result = layoutText(fakeProvider(), content("AA", { size: 0.2, letterSpacing: 2 }));
  const step = ADVANCE * emScale * 2;
  closeTo(result.glyphs[1]!.x - result.glyphs[0]!.x, step, "letterSpacing 反映後の送り幅");
});

test("layoutText horizontal: maxWidth で折り返す(禁則の対象外の文字)", () => {
  const emScale = 0.1 / UNITS_PER_EM;
  const charWidth = ADVANCE * emScale; // 0.06
  const result = layoutText(fakeProvider(), content("AAAA", { size: 0.1 }), { maxWidth: charWidth * 3 });
  assert.equal(result.lineCount, 2);
  // 3文字目までは同じ行(同じ y)、4文字目は次の行。
  closeTo(result.glyphs[0]!.y, result.glyphs[2]!.y, "1〜3文字目は同じ行");
  const lineHeight = 0.1 * 1.6;
  closeTo(result.glyphs[3]!.y - result.glyphs[0]!.y, lineHeight, "4文字目は次の行(lineHeight 分下)");
});

test("layoutText horizontal: 文節境界を優先して語中改行を避ける", () => {
  const charWidth = ADVANCE * (0.1 / UNITS_PER_EM);
  const result = layoutText(fakeProvider(), content("あなたならできる"), { maxWidth: charWidth * 5 });
  const firstLineY = result.glyphs[0]!.y;
  const lines = result.glyphs.reduce<string[][]>((acc, glyph) => {
    const index = Math.round((glyph.y - firstLineY) / (0.1 * 1.6));
    (acc[index] ??= []).push(glyph.char);
    return acc;
  }, []);
  assert.deepEqual(lines.map((line) => line.join("")), ["あなたなら", "できる"]);
});

test("layoutText horizontal: align=center/end で行がブロック内央/右寄せになる", () => {
  const emScale = 0.1 / UNITS_PER_EM;
  const charWidth = ADVANCE * emScale;
  // 1行目 "AAA"(幅3), 2行目 "A"(幅1) を明示改行で作る。ブロック幅は3文字分。
  const centerResult = layoutText(fakeProvider(), content("AAA\nA", { align: "center" }));
  const shortLineGlyph = centerResult.glyphs[3]!; // 2行目の唯一のグリフ
  // center: 短い行は (blockWidth - width)/2 だけ右にずれる。
  closeTo(shortLineGlyph.x - centerResult.glyphs[0]!.x, charWidth, "center: 短い行は1文字分右へシフト");

  const endResult = layoutText(fakeProvider(), content("AAA\nA", { align: "end" }));
  const endShortGlyph = endResult.glyphs[3]!;
  closeTo(endShortGlyph.x - endResult.glyphs[0]!.x, charWidth * 2, "end: 短い行は2文字分右へシフト");
});

test("layoutText horizontal 禁則: 行頭禁則文字(。)は前の行末へ追い込まれる", () => {
  const emScale = 0.1 / UNITS_PER_EM;
  const charWidth = ADVANCE * emScale;
  // "AAA。A" を maxWidth=3文字分で折り返すと素朴には ["AAA","。A"] だが、
  // 。が行頭禁則なので前の行へ追い込まれ ["AAA。","A"] になる。
  const result = layoutText(fakeProvider(), content("AAA。A"), { maxWidth: charWidth * 3 });
  assert.equal(result.lineCount, 2, "行数は2のまま(追い込みで増減しない)");
  assert.equal(result.glyphs.length, 5);
  const chars = result.glyphs.map((g) => g.char);
  assert.deepEqual(chars, ["A", "A", "A", "。", "A"]);
  closeTo(result.glyphs[3]!.y, result.glyphs[0]!.y, "。は1行目に追い込まれる(同じベースライン)");
  const lineHeight = 0.1 * 1.6;
  closeTo(result.glyphs[4]!.y - result.glyphs[0]!.y, lineHeight, "最後のAは2行目");
});

test("layoutText horizontal 禁則: 行末禁則文字(（)は次の行へ送られる", () => {
  const emScale = 0.1 / UNITS_PER_EM;
  const charWidth = ADVANCE * emScale;
  // "A（AA" を maxWidth=2文字分で折り返すと素朴には ["A（","AA"] だが、
  // （が行末禁則なので次の行へ送られ ["A","（AA"] になる。
  const result = layoutText(fakeProvider(), content("A（AA"), { maxWidth: charWidth * 2 });
  assert.equal(result.lineCount, 2);
  const chars = result.glyphs.map((g) => g.char);
  assert.deepEqual(chars, ["A", "（", "A", "A"]);
  const lineHeight = 0.1 * 1.6;
  closeTo(result.glyphs[1]!.y, result.glyphs[2]!.y, "（は2行目に送られる(2文字目以降と同じベースライン)");
  closeTo(result.glyphs[1]!.y, result.glyphs[3]!.y, "3文字目も2行目");
  closeTo(result.glyphs[1]!.y - result.glyphs[0]!.y, lineHeight, "1行目(Aのみ)との差はlineHeight");
});

// --- 縦書き ---

test("layoutText vertical: 1列(折り返し無し)は列内で上→下、列は使わず座標をピンする", () => {
  const result = layoutText(fakeProvider(), content("あい", { direction: "vertical" }));
  assert.equal(result.lineCount, 1);
  assert.equal(result.glyphs.length, 2);
  closeTo(result.glyphs[0]!.x, result.glyphs[1]!.x, "同一列は同じ列中心x");
  const emScale = 0.1 / UNITS_PER_EM;
  const pitch = UNITS_PER_EM * emScale; // vert 代替が無いので unitsPerEm 基準の全角ピッチ
  closeTo(result.glyphs[1]!.y - result.glyphs[0]!.y, pitch, "文字間の縦ピッチ");
  closeTo((result.bbox.minY + result.bbox.maxY) / 2, 0, "bbox centerY(縦方向はブロック中心=原点)");
});

test("layoutText vertical: 列送りは右→左(列インデックスが増えるほど x が減る)", () => {
  const emScale = 0.1 / UNITS_PER_EM;
  const pitch = UNITS_PER_EM * emScale;
  const result = layoutText(fakeProvider(), content("あい", { direction: "vertical" }), { maxWidth: pitch });
  assert.equal(result.lineCount, 2);
  const columnPitch = 0.1 * 1.6;
  closeTo(result.glyphs[0]!.x - result.glyphs[1]!.x, columnPitch, "2列目は1列目より左(columnPitch 分)");
});

test("layoutText vertical: vert 代替グリフがあればそちらを使い、送り幅も vertAdvance を使う", () => {
  const emScale = 0.1 / UNITS_PER_EM;
  const result = layoutText(fakeProvider(), content(`${VERT_CHAR}あ${VERT_CHAR}`, { direction: "vertical" }));
  assert.equal(result.glyphs[0]!.pathD, "M0,0L1,1Z");
  assert.equal(result.glyphs[0]!.rotationDeg, 0, "vert 代替はフォールバック回転を使わない");
  assert.equal(result.glyphs[2]!.pathD, "M0,0L1,1Z");
  closeTo(result.glyphs[2]!.y - result.glyphs[0]!.y, (VERT_ADVANCE + UNITS_PER_EM) * emScale, "vertAdvance 基準で次セルへ送る");
});

test("layoutText vertical: フォールバック回転(ー等)は90°回転し、送り幅はunitsPerEm基準のまま", () => {
  const emScale = 0.1 / UNITS_PER_EM;
  const result = layoutText(fakeProvider(), content("Aー", { direction: "vertical" }));
  assert.equal(result.glyphs[0]!.rotationDeg, 0);
  assert.equal(result.glyphs[1]!.rotationDeg, 90, "ー は90°回転フォールバック対象");
  closeTo(result.glyphs[1]!.y - result.glyphs[0]!.y, UNITS_PER_EM * emScale, "回転対象も送り幅は全角ピッチ");
});

test("layoutText vertical: 1〜3字の半角英数字runを縦中横1セルに収める", () => {
  const result = layoutText(fakeProvider(), content("同期率98%", { direction: "vertical" }));
  const run = result.glyphs.filter((glyph) => "98%".includes(glyph.char));
  assert.equal(result.lineCount, 1);
  assert.equal(new Set(run.map((glyph) => glyph.y)).size, 1, "98% が1セルを共有する");
  assert.ok(run.every((glyph) => (glyph.scaleX ?? 1) < 1));
  const japaneseStep = result.glyphs[1]!.y - result.glyphs[0]!.y;
  const precedingY = result.glyphs[result.glyphs.length - 4]!.y;
  closeTo(run[0]!.y - precedingY, japaneseStep, "縦中横runも1emだけ送る");
});

test("layoutText vertical: 4字以上の半角runは従来どおり1字ずつ縦積み", () => {
  const result = layoutText(fakeProvider(), content("1234", { direction: "vertical" }));
  assert.equal(new Set(result.glyphs.map((glyph) => glyph.y)).size, 4);
  assert.ok(result.glyphs.every((glyph) => glyph.scaleX === undefined));
});

test("layoutText vertical: ！？連続を縦中横1セルにする", () => {
  const result = layoutText(fakeProvider(), content("本当！？", { direction: "vertical" }));
  const punctuation = result.glyphs.slice(-2);
  closeTo(punctuation[0]!.y, punctuation[1]!.y, "！？は同じセル");
  assert.ok(punctuation.every((glyph) => (glyph.scaleX ?? 1) < 1));
});

test("layoutText vertical: 句読点(。)は右上寄せオフセットされ、回転はしない", () => {
  const emScale = 0.1 / UNITS_PER_EM;
  const size = 0.1;
  const result = layoutText(fakeProvider(), content("A。", { direction: "vertical", size }));
  const [a, punct] = result.glyphs;
  assert.equal(punct!.rotationDeg, 0);
  const naturalX = a!.x; // 同じ列なので回転/オフセット無しなら同じ列中心 x のはず
  const naturalY = a!.y + UNITS_PER_EM * emScale;
  closeTo(punct!.x - naturalX, 0.6 * size, "。の右方向オフセット(+0.6em)");
  closeTo(punct!.y - naturalY, -0.6 * size, "。の上方向オフセット(-0.6em)");
});

test("layoutText vertical: 拗促音(っ)は右上へ小オフセットされる", () => {
  const emScale = 0.1 / UNITS_PER_EM;
  const size = 0.1;
  const result = layoutText(fakeProvider(), content("Aっ", { direction: "vertical", size }));
  const [a, small] = result.glyphs;
  const naturalX = a!.x;
  const naturalY = a!.y + UNITS_PER_EM * emScale;
  closeTo(small!.x - naturalX, 0.1 * size, "っの右方向小オフセット(+0.1em)");
  closeTo(small!.y - naturalY, -0.1 * size, "っの上方向小オフセット(-0.1em)");
});

test("layoutText vertical 禁則: 行頭禁則文字(。)は前の列末へ追い込まれる", () => {
  const emScale = 0.1 / UNITS_PER_EM;
  const pitch = UNITS_PER_EM * emScale;
  // "AAA。A" を maxWidth(=最大列高さ)=3文字分で折り返すと素朴には ["AAA","。A"] だが、
  // 。が行頭禁則なので前の列へ追い込まれ ["AAA。","A"] になる。
  const result = layoutText(fakeProvider(), content("あいう。え", { direction: "vertical" }), { maxWidth: pitch * 3 });
  assert.equal(result.lineCount, 2);
  const chars = result.glyphs.map((g) => g.char);
  assert.deepEqual(chars, ["あ", "い", "う", "。", "え"]);
  // 。は1列目へ追い込まれる(列中心xは同じだが、句読点オフセット(+0.6em)がx方向にも掛かる)。
  closeTo(result.glyphs[3]!.x, result.glyphs[0]!.x + 0.6 * 0.1, "。は1列目に追い込まれる(列中心x+オフセット)");
  closeTo(result.glyphs[4]!.x, result.glyphs[0]!.x - 0.1 * 1.6, "最後のAは2列目");
});

test("layoutText: 空文字列でも例外を投げない", () => {
  const result = layoutText(fakeProvider(), content(""));
  assert.equal(result.glyphs.length, 0);
  assert.equal(result.lineCount, 1);
});
