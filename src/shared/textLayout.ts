/**
 * テキストレイアウト純ロジック(Docs/Feature-CGCollectionSuite.md P2)。
 * フォントパーサ(fontkit)には依存しない — `FontMetricsProvider` インターフェース経由でグリフの
 * アウトライン/送り幅を受け取る(実装は `src/server/fonts.ts` の fontkit ラッパ)。こうすることで、
 * このモジュールは実フォント無しの偽 provider(等幅メトリクス決め打ち)でゴールデンテストできる
 * (`textLayout.test.ts` 参照)。
 *
 * 座標系:「テキストブロックの中心 = 原点」の page 単位(width-relative, `pageObjects.ts` と同じスケール)。
 * `renderTextSvg`(`textSvg.ts`)が object の position/rotation 分だけ平行移動+回転して初めてページ座標になる。
 *
 * グリフのパス(`GlyphMetrics.pathD`)はフォント内部座標系(y 上向き正、原点はベースライン左端のペン位置)
 * のまま持ち回す — ページ座標(y 下向き正)への変換は `PositionedGlyph.emScale`(=style.size/unitsPerEm)を
 * 使って `scale(emScale, -emScale)` を掛けるだけで済む(`textSvg.ts` が担当)。
 */
import type { TextAlign, TextContent, TextDirection, TextStyle } from "./pageObjects";

/** 1文字分のグリフ形状+送り幅(フォント内部単位)。 */
export interface GlyphMetrics {
  /** グリフのアウトライン(フォント内部座標系、y は上向き正、原点はベースライン左端のペン位置)。 */
  pathD: string;
  /** 横書きの送り幅(フォント単位)。 */
  advanceWidth: number;
  /**
   * 縦書き代替グリフ(GSUB `vert`/`vrt2`)のアウトライン。フォントが持たない場合は undefined
   * (横書きグリフ+フォールバック回転/オフセットテーブルで代用する)。
   */
  vertPathD?: string;
  /** 縦書き代替グリフの送り幅(フォント単位)。`vertPathD` が無ければ無視。省略時は unitsPerEm(全角相当)。 */
  vertAdvance?: number;
}

/**
 * レイアウトが必要とする最小限のフォントメトリクス。実装は `src/server/fonts.ts`(fontkit)。
 * テストは実フォント無しの偽 provider(このインターフェースを満たす決め打ちオブジェクト)を使う。
 */
export interface FontMetricsProvider {
  /** フォント内部座標系の1em(通常 1000 or 2048)。 */
  unitsPerEm: number;
  /** アセンダ(フォント単位、ベースラインから上向き正)。 */
  ascent: number;
  /** ディセンダ(フォント単位、ベースラインから下向き負)。 */
  descent: number;
  getGlyph(char: string): GlyphMetrics;
}

/** 配置済み1グリフ。`textSvg.ts` がこれを `<path>` に変換する。 */
export interface PositionedGlyph {
  char: string;
  /** フォント内部座標系のパス(そのまま、変形は transform 側で行う)。 */
  pathD: string;
  /** ページ座標系でのグリフ原点(ブロック中心を原点とする)。 */
  x: number;
  y: number;
  /** ページ単位への倍率(= style.size / unitsPerEm)。 */
  emScale: number;
  /** 縦中横など、横方向だけ追加で縮小する倍率。省略時は1。 */
  scaleX?: number;
  /** フォールバック回転(度)。約物の90°回転のみ非0。回転軸はフォント内部座標の (centerX, centerY)。 */
  rotationDeg: number;
  /** 回転軸(フォント内部座標系)。advanceWidth/2, (ascent+descent)/2。 */
  centerX: number;
  centerY: number;
}

export interface TextLayoutBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TextLayoutResult {
  glyphs: PositionedGlyph[];
  bbox: TextLayoutBBox;
  /** 横書き=行数、縦書き=列数。 */
  lineCount: number;
}

export interface TextLayoutOptions {
  /** 折り返し幅(page 単位)。横書き=行の最大幅、縦書き=列の最大高さ。未指定/0以下は折り返し無し。 */
  maxWidth?: number;
}

/** 縦書きフォールバック: vert 代替が無い時に 90° 回転して代用する記号類。 */
const ROTATE_90_CHARS = new Set([
  "ー", "〜", "…", "‥",
  "「", "」", "『", "』", "（", "）", "〈", "〉", "《", "》", "【", "】",
  "[", "]", "(", ")", "-"
]);

/** 縦書きフォールバック: 右上寄せオフセットする句読点。 */
const PUNCT_OFFSET_CHARS = new Set(["。", "、"]);

/** 縦書きフォールバック: 右上へ小オフセットする拗促音。 */
const SMALL_KANA_CHARS = new Set([
  "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "っ", "ゃ", "ゅ", "ょ",
  "ァ", "ィ", "ゥ", "ェ", "ォ", "ッ", "ャ", "ュ", "ョ"
]);

/** 行頭禁則(行頭に来てはいけない文字。前の行末へ追い込む)。 */
const LEADING_PROHIBITED = new Set([
  "。", "、", "）", "」", "』", "，", "．",
  "ゃ", "ゅ", "ょ", "っ", "ー",
  "ァ", "ィ", "ゥ", "ェ", "ォ", "ッ", "ャ", "ュ", "ョ",
  ")", "]", "!", "?", "！", "？"
]);

/** 行末禁則(行末に来てはいけない文字。次行へ送る)。 */
const TRAILING_PROHIBITED = new Set(["（", "「", "『", "〈", "《", "【", "(", "["]);

/** 禁則処理の総調整ステップ数の上限(無限ループガード)。 */
const KINSOKU_MAX_STEPS = 40;

const PUNCT_OFFSET_EM = 0.6;
const SMALL_KANA_OFFSET_EM = 0.1;

/** unknown な文字列を Array.from で分解する(サロゲートペアは1文字として扱う。結合文字列は非対応)。 */
function toChars(text: string): string[] {
  return Array.from(text);
}

const JAPANESE_PARTICLES = ["から", "まで", "より", "って", "では", "には", "へは", "とは", "ので", "のに", "ても", "でも", "だけ", "しか", "ほど", "くらい", "ぐらい", "こそ", "さえ", "ばかり", "ながら", "たり", "だり", "を", "が", "に", "へ", "と", "で", "の", "は", "も", "や", "ね", "よ", "ぞ", "さ"];
const PHRASE_PUNCTUATION = new Set(["、", "。", "，", "．", "！", "？", "!", "?", "…", "‥"]);

/** 日本語の文節を壊しにくい折返し候補。辞書を使わず、句読点・助詞末尾・語種境界だけを採用する。 */
function phraseBreaks(chars: string[]): Set<number> {
  const result = new Set<number>();
  for (let index = 1; index < chars.length; index += 1) {
    const before = chars[index - 1]!;
    const after = chars[index]!;
    const prefix = chars.slice(0, index).join("");
    if (PHRASE_PUNCTUATION.has(before) || JAPANESE_PARTICLES.some((particle) => prefix.endsWith(particle))) {
      result.add(index);
      continue;
    }
    const beforeJapanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(before);
    const afterJapanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(after);
    if (beforeJapanese !== afterJapanese) result.add(index);
  }
  return result;
}

/**
 * 貪欲法での折り返し + 簡易禁則処理。`measureAdvance` は「この文字を追加する時の送り幅(page 単位)」。
 * `maxExtent` が undefined/0以下なら折り返さない(禁則処理も適用対象が無いので実質no-op)。
 */
function wrapParagraph(chars: string[], measureAdvance: (char: string) => number, maxExtent: number | undefined): string[][] {
  if (chars.length === 0) {
    return [[]];
  }
  const lines: string[][] = [];
  let current: string[] = [];
  let currentExtent = 0;
  const breaks = phraseBreaks(chars);
  let sourceIndex = 0;
  for (const ch of chars) {
    const advance = measureAdvance(ch);
    if (maxExtent !== undefined && maxExtent > 0 && current.length > 0 && currentExtent + advance > maxExtent) {
      let breakAt = -1;
      const lineStart = sourceIndex - current.length;
      for (let candidate = sourceIndex; candidate > lineStart; candidate -= 1) {
        if (breaks.has(candidate)) { breakAt = candidate - lineStart; break; }
      }
      // 文節まで戻して行が半分未満になる場合は、過度な空きを避けて従来の文字折返しにする。
      if (breakAt > 0 && breakAt >= Math.ceil(current.length / 2)) {
        const carry = current.splice(breakAt);
        lines.push(current);
        current = carry;
        currentExtent = current.reduce((sum, item) => sum + measureAdvance(item), 0);
      } else {
        lines.push(current);
        current = [];
        currentExtent = 0;
      }
    }
    current.push(ch);
    currentExtent += advance;
    sourceIndex += 1;
  }
  lines.push(current);
  return applyKinsoku(lines);
}

/**
 * 禁則処理: 行頭禁則文字は前の行末へ追い込み(ぶら下げ、width超過を許容)、行末禁則文字は次行へ送る。
 * ステップ数に全体上限を掛けて無限ループを防ぐ(病的な入力 -- 禁則文字の連続等 -- でも必ず停止する)。
 */
function applyKinsoku(lines: string[][]): string[][] {
  if (lines.length <= 1) {
    return lines;
  }
  let steps = 0;
  let i = 0;
  while (i < lines.length - 1 && steps < KINSOKU_MAX_STEPS) {
    const cur = lines[i]!;
    const next = lines[i + 1]!;
    while (next.length > 0 && LEADING_PROHIBITED.has(next[0]!) && steps < KINSOKU_MAX_STEPS) {
      cur.push(next.shift()!);
      steps += 1;
    }
    while (cur.length > 1 && TRAILING_PROHIBITED.has(cur[cur.length - 1]!) && steps < KINSOKU_MAX_STEPS) {
      next.unshift(cur.pop()!);
      steps += 1;
    }
    if (next.length === 0) {
      lines.splice(i + 1, 1);
      if (lines.length <= 1) {
        break;
      }
      continue;
    }
    i += 1;
  }
  return lines;
}

interface LayoutContext {
  emScale: number;
  lineSpacing: number;
  letterSpacing: number;
  align: TextAlign;
  maxWidth: number | undefined;
  getGlyph: (char: string) => GlyphMetrics;
}

function buildContext(provider: FontMetricsProvider, style: TextStyle, options: TextLayoutOptions): LayoutContext {
  const cache = new Map<string, GlyphMetrics>();
  return {
    emScale: style.size / provider.unitsPerEm,
    lineSpacing: style.lineSpacing ?? 1.6,
    letterSpacing: style.letterSpacing ?? 1.0,
    align: style.align ?? "start",
    maxWidth: options.maxWidth && options.maxWidth > 0 ? options.maxWidth : undefined,
    getGlyph: (char: string) => {
      let glyph = cache.get(char);
      if (!glyph) {
        glyph = provider.getGlyph(char);
        cache.set(char, glyph);
      }
      return glyph;
    }
  };
}

function alignShift(align: TextAlign, extent: number, blockExtent: number): number {
  if (align === "center") {
    return (blockExtent - extent) / 2;
  }
  if (align === "end") {
    return blockExtent - extent;
  }
  return 0;
}

function layoutHorizontal(provider: FontMetricsProvider, text: string, style: TextStyle, ctx: LayoutContext): TextLayoutResult {
  const lineHeight = style.size * ctx.lineSpacing;
  const paragraphs = text.split("\n");
  const allLines: string[][] = [];
  for (const paragraph of paragraphs) {
    const chars = toChars(paragraph);
    const measureAdvance = (ch: string) => ctx.getGlyph(ch).advanceWidth * ctx.emScale * ctx.letterSpacing;
    allLines.push(...wrapParagraph(chars, measureAdvance, ctx.maxWidth));
  }

  const lineWidths: number[] = [];
  const rawGlyphsByLine: PositionedGlyph[][] = [];
  allLines.forEach((line, lineIndex) => {
    let cursorX = 0;
    const baselineY = lineIndex * lineHeight;
    const lineGlyphs: PositionedGlyph[] = [];
    for (const ch of line) {
      const glyph = ctx.getGlyph(ch);
      const advancePage = glyph.advanceWidth * ctx.emScale * ctx.letterSpacing;
      lineGlyphs.push({
        char: ch,
        pathD: glyph.pathD,
        x: cursorX,
        y: baselineY,
        emScale: ctx.emScale,
        rotationDeg: 0,
        centerX: glyph.advanceWidth / 2,
        centerY: (provider.ascent + provider.descent) / 2
      });
      cursorX += advancePage;
    }
    lineWidths.push(cursorX);
    rawGlyphsByLine.push(lineGlyphs);
  });

  const blockWidth = lineWidths.length ? Math.max(0, ...lineWidths) : 0;
  const glyphs: PositionedGlyph[] = [];
  rawGlyphsByLine.forEach((lineGlyphs, lineIndex) => {
    const shiftX = alignShift(ctx.align, lineWidths[lineIndex]!, blockWidth);
    for (const glyph of lineGlyphs) {
      glyphs.push({ ...glyph, x: glyph.x + shiftX });
    }
  });

  const ascentPage = provider.ascent * ctx.emScale;
  const descentPage = provider.descent * ctx.emScale; // 通常は負
  const blockTop = -ascentPage;
  const blockBottom = (allLines.length - 1) * lineHeight - descentPage;
  const centerX = blockWidth / 2;
  const centerY = (blockTop + blockBottom) / 2;
  const centeredGlyphs = glyphs.map((glyph) => ({ ...glyph, x: glyph.x - centerX, y: glyph.y - centerY }));

  return {
    glyphs: centeredGlyphs,
    bbox: { minX: -centerX, minY: blockTop - centerY, maxX: blockWidth - centerX, maxY: blockBottom - centerY },
    lineCount: allLines.length
  };
}

function layoutVertical(provider: FontMetricsProvider, text: string, style: TextStyle, ctx: LayoutContext): TextLayoutResult {
  const columnPitch = style.size * ctx.lineSpacing;
  const paragraphs = text.split("\n");
  const allColumns: string[][] = [];
  for (const paragraph of paragraphs) {
    const chars = toChars(paragraph);
    const cells: string[] = [];
    for (let index = 0; index < chars.length;) {
      const tail = chars.slice(index).join("");
      const asciiRun = tail.match(/^[0-9A-Za-z%.!?]+/)?.[0];
      if (asciiRun && Array.from(asciiRun).length > 3) {
        cells.push(...Array.from(asciiRun));
        index += Array.from(asciiRun).length;
        continue;
      }
      if (asciiRun && Array.from(asciiRun).length <= 3) {
        cells.push(asciiRun);
        index += Array.from(asciiRun).length;
      } else if ((chars[index] === "！" || chars[index] === "？") && (chars[index + 1] === "！" || chars[index + 1] === "？")) {
        cells.push(chars[index]! + chars[index + 1]!);
        index += 2;
      } else {
        cells.push(chars[index]!);
        index += 1;
      }
    }
    const measureAdvance = (ch: string) => {
      if (Array.from(ch).length > 1) return provider.unitsPerEm * ctx.emScale * ctx.letterSpacing;
      const glyph = ctx.getGlyph(ch);
      const base = glyph.vertPathD ? glyph.vertAdvance || provider.unitsPerEm : provider.unitsPerEm;
      return base * ctx.emScale * ctx.letterSpacing;
    };
    allColumns.push(...wrapParagraph(cells, measureAdvance, ctx.maxWidth));
  }

  const colHeights: number[] = [];
  const rawGlyphsByCol: PositionedGlyph[][] = [];
  allColumns.forEach((col, colIndex) => {
    let cursorY = 0;
    // 列は右→左に進む(第0列が最も右)。
    const colCenterX = -colIndex * columnPitch;
    const colGlyphs: PositionedGlyph[] = [];
    for (const ch of col) {
      const run = Array.from(ch);
      if (run.length > 1) {
        const metrics = run.map((char) => ctx.getGlyph(char));
        const totalAdvance = metrics.reduce((sum, glyph) => sum + glyph.advanceWidth, 0);
        const scaleX = Math.min(1, provider.unitsPerEm / Math.max(1, totalAdvance));
        let localX = -totalAdvance * scaleX * ctx.emScale / 2;
        const cellCenterY = cursorY + style.size / 2;
        metrics.forEach((glyph, index) => {
          colGlyphs.push({
            char: run[index]!, pathD: glyph.pathD,
            x: colCenterX + localX, y: cellCenterY + ((provider.ascent + provider.descent) / 2) * ctx.emScale,
            emScale: ctx.emScale, scaleX, rotationDeg: 0,
            centerX: glyph.advanceWidth / 2, centerY: (provider.ascent + provider.descent) / 2
          });
          localX += glyph.advanceWidth * scaleX * ctx.emScale;
        });
        cursorY += provider.unitsPerEm * ctx.emScale * ctx.letterSpacing;
        continue;
      }
      const glyph = ctx.getGlyph(ch);
      const useVert = Boolean(glyph.vertPathD);
      const baseAdvance = useVert ? glyph.vertAdvance || provider.unitsPerEm : provider.unitsPerEm;
      const advancePage = baseAdvance * ctx.emScale * ctx.letterSpacing;
      const centerX = glyph.advanceWidth / 2;
      const centerY = (provider.ascent + provider.descent) / 2;
      // グリフをセル(幅=columnPitch相当、高さ=advancePage)の中心に置く。回転はこの中心軸まわりに掛かるので
      // 90°回転してもセルからはみ出さない(センタリング後に回すため)。
      let originX = colCenterX - centerX * ctx.emScale;
      let originY = cursorY + advancePage / 2 + centerY * ctx.emScale;
      let rotationDeg = 0;
      let pathD = glyph.pathD;
      if (useVert) {
        pathD = glyph.vertPathD!;
      } else if (ROTATE_90_CHARS.has(ch)) {
        rotationDeg = 90;
      } else if (PUNCT_OFFSET_CHARS.has(ch)) {
        originX += PUNCT_OFFSET_EM * style.size;
        originY -= PUNCT_OFFSET_EM * style.size;
      } else if (SMALL_KANA_CHARS.has(ch)) {
        originX += SMALL_KANA_OFFSET_EM * style.size;
        originY -= SMALL_KANA_OFFSET_EM * style.size;
      }
      colGlyphs.push({ char: ch, pathD, x: originX, y: originY, emScale: ctx.emScale, rotationDeg, centerX, centerY });
      cursorY += advancePage;
    }
    colHeights.push(cursorY);
    rawGlyphsByCol.push(colGlyphs);
  });

  const blockHeight = colHeights.length ? Math.max(0, ...colHeights) : 0;
  const glyphs: PositionedGlyph[] = [];
  rawGlyphsByCol.forEach((colGlyphs, colIndex) => {
    const shiftY = alignShift(ctx.align, colHeights[colIndex]!, blockHeight);
    for (const glyph of colGlyphs) {
      glyphs.push({ ...glyph, y: glyph.y + shiftY });
    }
  });

  const numCols = allColumns.length;
  const minX = -(numCols - 1) * columnPitch - style.size / 2;
  const maxX = style.size / 2;
  const minY = 0;
  const maxY = blockHeight;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centeredGlyphs = glyphs.map((glyph) => ({ ...glyph, x: glyph.x - centerX, y: glyph.y - centerY }));

  return {
    glyphs: centeredGlyphs,
    bbox: { minX: minX - centerX, minY: minY - centerY, maxX: maxX - centerX, maxY: maxY - centerY },
    lineCount: numCols
  };
}

/**
 * テキストをレイアウトする(横書き/縦書き・折り返し・禁則・約物回転/オフセットを含む)。
 * `provider` は実フォント(`src/server/fonts.ts`)またはテスト用の偽 provider。
 */
export function layoutText(provider: FontMetricsProvider, content: TextContent, options: TextLayoutOptions = {}): TextLayoutResult {
  const ctx = buildContext(provider, content.style, options);
  const direction: TextDirection = content.style.direction;
  return direction === "vertical"
    ? layoutVertical(provider, content.text, content.style, ctx)
    : layoutHorizontal(provider, content.text, content.style, ctx);
}
