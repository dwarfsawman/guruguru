/**
 * フォント走査+fontkit ラッパ(Docs/Feature-CGCollectionSuite.md P2)。
 * クライアントへはバンドルしない(サーバ専用) -- `fontkit` は Bun/Node 専用の重い依存で、
 * レイアウト算術自体は `src/shared/textLayout.ts`(FontMetricsProvider 抽象)へ切り出してあるので
 * ここは「実フォントから FontMetricsProvider を作る」アダプタと「フォント一覧+既定フォント解決」に専念する。
 *
 * 走査対象: `C:\Windows\Fonts`、`%LOCALAPPDATA%\Microsoft\Windows\Fonts`(いずれも Windows のみ)、
 * `dataRoot/fonts/`(無ければ作る。全 OS 共通のユーザーフォント置き場)。拡張子 .ttf/.otf/.ttc/.otc のみ。
 * 走査結果(名前テーブルのみ)は `app_settings` にキャッシュし、ファイル数+最大 mtime の署名で無効化する。
 * TTC はコレクション対応(`openSync(path)` が `FontkitCollection`(`.fonts` 配列)を返す場合、
 * 各要素を個別フォント扱いする)。
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import { openSync, type FontkitCollection, type FontkitFont, type FontkitGlyph } from "fontkit";
import type { FontSummary } from "../shared/apiTypes";
import type { FontMetricsProvider, GlyphMetrics } from "../shared/textLayout";
import { dataRoot, getSetting, setSetting } from "./db";
import { HttpError } from "./http";

interface FontCacheEntry extends FontSummary {
  path: string;
  /** TTC/OTC 内のインデックス。単体フォントファイルは null。 */
  ttcIndex: number | null;
}

interface FontCachePayload {
  signature: string;
  fonts: FontCacheEntry[];
}

const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".otc"]);
const FONT_CACHE_KEY = "fontsCacheV1";

/** 日本語環境で見つかることが多いフォント名の優先順(familyName の部分一致、小文字比較)。 */
const DEFAULT_FONT_FAMILY_PRIORITY = [
  "noto sans jp", "noto sans cjk jp",
  "游ゴシック", "yu gothic", "yugothic",
  "メイリオ", "meiryo"
];

interface ScannedFile {
  path: string;
  source: "system" | "user";
  mtimeMs: number;
}

function isCollection(font: FontkitFont | FontkitCollection): font is FontkitCollection {
  return "fonts" in font;
}

export function userFontsDir(): string {
  const dir = join(dataRoot, "fonts");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function candidateDirs(): Array<{ dir: string; source: "system" | "user" }> {
  const dirs: Array<{ dir: string; source: "system" | "user" }> = [];
  if (process.platform === "win32") {
    const windowsDir = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    dirs.push({ dir: join(windowsDir, "Fonts"), source: "system" });
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      dirs.push({ dir: join(localAppData, "Microsoft", "Windows", "Fonts"), source: "system" });
    }
  }
  dirs.push({ dir: userFontsDir(), source: "user" });
  return dirs;
}

function listFontFiles(): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (const { dir, source } of candidateDirs()) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!FONT_EXTENSIONS.has(extname(name).toLowerCase())) {
        continue;
      }
      const fullPath = join(dir, name);
      try {
        const stat = statSync(fullPath);
        if (!stat.isFile()) {
          continue;
        }
        files.push({ path: fullPath, source, mtimeMs: stat.mtimeMs });
      } catch {
        // 読めないファイルはスキップ(権限等)。
      }
    }
  }
  return files;
}

/** 直近の走査結果を短時間だけ使い回す(text-layout の debounce 連打でディレクトリ全走査を繰り返さないため)。 */
const FILES_MEMO_TTL_MS = 3000;
let filesMemo: { files: ScannedFile[]; expiresAt: number } | null = null;

function listFontFilesMemoized(): ScannedFile[] {
  const now = Date.now();
  if (filesMemo && filesMemo.expiresAt > now) {
    return filesMemo.files;
  }
  const files = listFontFiles();
  filesMemo = { files, expiresAt: now + FILES_MEMO_TTL_MS };
  return files;
}

function computeSignature(files: ScannedFile[]): string {
  const maxMtime = files.reduce((max, file) => Math.max(max, file.mtimeMs), 0);
  return `${files.length}:${Math.round(maxMtime)}`;
}

function fontIdFor(path: string, ttcIndex: number | null): string {
  return createHash("sha1").update(`${path}::${ttcIndex ?? ""}`).digest("hex").slice(0, 20);
}

/**
 * fontkit の name テーブルの値を表示用文字列へ(`getName`/`familyName` 等は非Unicodeエンコーディングの
 * 名前レコードだと Uint8Array を返すことがあるため、その場合は fallback を使う -- 生バイト列を文字列化
 * すると `.toLowerCase()` 等で例外になる)。
 */
function toDisplayString(value: string | Uint8Array | null | undefined, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

/** fontkit の name テーブルから日本語名優先で取得する(`getName` 自体が ja → en → 任意言語へフォールバックする)。 */
function preferredName(font: FontkitFont, key: string, fallback: string): string {
  return toDisplayString(font.getName(key, "ja"), fallback);
}

function toFontCacheEntry(file: ScannedFile, font: FontkitFont, ttcIndex: number | null): FontCacheEntry {
  const familyName = preferredName(font, "fontFamily", toDisplayString(font.familyName, "Unknown"));
  const subfamilyName = preferredName(font, "fontSubfamily", toDisplayString(font.subfamilyName, ""));
  return {
    id: fontIdFor(file.path, ttcIndex),
    familyName,
    subfamilyName,
    source: file.source,
    path: file.path,
    ttcIndex
  };
}

function scanFontFile(file: ScannedFile): FontCacheEntry[] {
  try {
    const opened = openSync(file.path);
    if (isCollection(opened)) {
      return opened.fonts.map((font, index) => toFontCacheEntry(file, font, index));
    }
    return [toFontCacheEntry(file, opened, null)];
  } catch {
    // 壊れたファイル/未対応形式は黙ってスキップする(走査全体を失敗させない)。
    return [];
  }
}

function loadFontCache(): FontCachePayload {
  const files = listFontFilesMemoized();
  const signature = computeSignature(files);
  const cached = getSetting<FontCachePayload>(FONT_CACHE_KEY);
  if (cached && cached.signature === signature) {
    return cached;
  }
  const fonts = files.flatMap((file) => scanFontFile(file));
  const payload: FontCachePayload = { signature, fonts };
  setSetting(FONT_CACHE_KEY, payload);
  return payload;
}

/** `GET /api/fonts` のレスポンス本体(path/ttcIndex はサーバ内部専用なので公開しない)。 */
export function listFonts(): FontSummary[] {
  return loadFontCache().fonts.map(({ id, familyName, subfamilyName, source }) => ({ id, familyName, subfamilyName, source }));
}

export function pickDefaultFont<T extends FontSummary>(fonts: T[]): T | null {
  for (const needle of DEFAULT_FONT_FAMILY_PRIORITY) {
    const matches = fonts.filter((font) => font.familyName.toLowerCase().includes(needle));
    if (matches.length === 0) continue;
    // 漫画本文はRegularだと細く見えるため、同じ日本語ファミリーのBoldを既定にする。
    // "Noto Sans JP Black" のように太さがfamily名へ入った別faceより、標準familyのBoldを優先。
    const exactFamily = matches.filter((font) => font.familyName.toLowerCase() === needle);
    const candidates = exactFamily.length > 0 ? exactFamily : matches;
    return candidates.find((font) => font.subfamilyName.toLowerCase() === "bold")
      ?? candidates.find((font) => font.subfamilyName.toLowerCase().includes("semibold"))
      ?? candidates.find((font) => font.subfamilyName.toLowerCase().includes("medium"))
      ?? candidates.find((font) => font.subfamilyName.toLowerCase() === "regular")
      ?? candidates[0]!;
  }
  return fonts[0] ?? null;
}

// --- フォント本体のオープン(LRU、数件だけ保持) ---

const OPEN_FONT_CACHE_LIMIT = 8;
const openFontCache = new Map<string, FontkitFont>();

function openFontByEntry(entry: FontCacheEntry): FontkitFont {
  const cacheKey = `${entry.path}::${entry.ttcIndex ?? ""}`;
  const cached = openFontCache.get(cacheKey);
  if (cached) {
    // 直近アクセスを最後尾へ(Map は挿入順を保持するので delete+set で LRU を表現する)。
    openFontCache.delete(cacheKey);
    openFontCache.set(cacheKey, cached);
    return cached;
  }
  const opened = openSync(entry.path);
  const font = entry.ttcIndex !== null && isCollection(opened) ? opened.fonts[entry.ttcIndex]! : (opened as FontkitFont);
  openFontCache.set(cacheKey, font);
  if (openFontCache.size > OPEN_FONT_CACHE_LIMIT) {
    const oldestKey = openFontCache.keys().next().value;
    if (oldestKey !== undefined) {
      openFontCache.delete(oldestKey);
    }
  }
  return font;
}

function safeToSvgPath(glyph: FontkitGlyph | null | undefined): string {
  if (!glyph) {
    return "";
  }
  try {
    return glyph.path.toSVG() || "";
  } catch {
    return "";
  }
}

/**
 * fontkit の Font オブジェクトから `FontMetricsProvider` を作る(`textLayout.ts` の抽象を満たすアダプタ)。
 * 縦書き代替グリフは GSUB `vert` feature を1文字ずつ layout してグリフ id が変わっていれば採用する
 * (フォントに `vert` テーブルが無い/対象外の文字は例外なく元のグリフ id のままなので、その場合は
 * `vertPathD` を省略し `textLayout.ts` 側のフォールバック回転/オフセットテーブルに委ねる)。
 */
export function createFontMetricsProvider(font: FontkitFont): FontMetricsProvider {
  const cache = new Map<string, GlyphMetrics>();
  return {
    unitsPerEm: font.unitsPerEm,
    ascent: font.ascent,
    descent: font.descent,
    getGlyph(char: string): GlyphMetrics {
      const cached = cache.get(char);
      if (cached) {
        return cached;
      }
      const codePoint = char.codePointAt(0) ?? 0;
      const glyph = font.glyphForCodePoint(codePoint);
      const metrics: GlyphMetrics = {
        pathD: safeToSvgPath(glyph),
        advanceWidth: glyph.advanceWidth || font.unitsPerEm / 2
      };
      try {
        const run = font.layout(char, ["vert"]);
        const vertGlyph = run.glyphs[0];
        if (vertGlyph && vertGlyph.id !== glyph.id) {
          metrics.vertPathD = safeToSvgPath(vertGlyph);
          const yAdvance = run.positions[0]?.yAdvance;
          if (yAdvance) {
            metrics.vertAdvance = yAdvance;
          }
        }
      } catch {
        // vert 非対応フォント/文字は無視(横書きグリフ+フォールバック回転で代用する)。
      }
      cache.set(char, metrics);
      return metrics;
    }
  };
}

export interface ResolvedFontProvider {
  provider: FontMetricsProvider;
  resolvedFontId: string;
}

/**
 * `fontId` からフォントを解決する。"default"・未登録 id・走査でヒットしなかった id は
 * すべて既定フォント(Noto Sans JP → 游ゴシック → メイリオの優先順)へフォールバックする
 * (`POST /api/text-layout` はこのフォールバックを `resolvedFontId` で呼び出し側へ知らせる)。
 * 利用可能なフォントが1つも無い(走査0件)場合のみ 400。
 */
export function resolveFontProvider(fontId: string): ResolvedFontProvider {
  const cache = loadFontCache();
  const entry = (fontId && fontId !== "default" ? cache.fonts.find((font) => font.id === fontId) : null) ?? pickDefaultFont(cache.fonts);
  if (!entry) {
    throw new HttpError(400, "利用可能なフォントが見つかりません。dataRoot/fonts にフォントを配置するか、Windows の標準フォントを確認してください。");
  }
  const font = openFontByEntry(entry);
  return { provider: createFontMetricsProvider(font), resolvedFontId: entry.id };
}

export function resolveDefaultFontId(): string {
  const cache = loadFontCache();
  return pickDefaultFont(cache.fonts)?.id ?? "default";
}
