/**
 * `POST /api/text-layout`(Docs/Feature-CGCollectionSuite.md P2)。テキストの自前レイアウトを計算する。
 * `openRasterExport.ts` もこの `computeTextLayoutForContent` を(HTTP を介さず)直接呼ぶことで、
 * プレビュー用レイアウト API と書き出しレンダリングが常に同じ結果になる。
 */
import type { TextContent } from "../shared/pageObjects";
import { normalizeTextContent } from "../shared/pageObjects";
import { layoutText, type TextLayoutResult } from "../shared/textLayout";
import { resolveFontProvider } from "./fonts";
import { HttpError } from "./http";
import { objectBody } from "./validate";

export interface TextLayoutResponse extends TextLayoutResult {
  resolvedFontId: string;
}

/** `(fontId, text, style, maxWidth)` キーの LRU キャッシュ(サーバ内共有、クライアント側キャッシュとは別)。 */
const LAYOUT_CACHE_LIMIT = 200;
const layoutCache = new Map<string, TextLayoutResponse>();

function cacheKeyFor(content: TextContent, maxWidth: number | undefined): string {
  return JSON.stringify({ content, maxWidth: maxWidth ?? null });
}

/**
 * `content`(text+style)から実際にレイアウトを計算する(サーバ内部呼び出し用。HTTP を介さない)。
 * `content.style.fontId` が解決できない場合は既定フォントへフォールバックし、`resolvedFontId` で知らせる。
 */
export function computeTextLayoutForContent(content: TextContent, maxWidth: number | undefined): TextLayoutResponse {
  const cacheKey = cacheKeyFor(content, maxWidth);
  const cached = layoutCache.get(cacheKey);
  if (cached) {
    layoutCache.delete(cacheKey);
    layoutCache.set(cacheKey, cached);
    return cached;
  }
  const { provider, resolvedFontId } = resolveFontProvider(content.style.fontId);
  const layout = layoutText(provider, content, { maxWidth });
  const response: TextLayoutResponse = { ...layout, resolvedFontId };
  layoutCache.set(cacheKey, response);
  if (layoutCache.size > LAYOUT_CACHE_LIMIT) {
    const oldestKey = layoutCache.keys().next().value;
    if (oldestKey !== undefined) {
      layoutCache.delete(oldestKey);
    }
  }
  return response;
}

function parseMaxWidth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** `POST /api/text-layout` のリクエストボディを検証してレイアウトを返す(不正入力は 400)。 */
export function computeTextLayout(body: unknown): TextLayoutResponse {
  const input = objectBody(body);
  const content = normalizeTextContent(input.content);
  if (!content) {
    throw new HttpError(400, "content (text + style) is required.");
  }
  return computeTextLayoutForContent(content, parseMaxWidth(input.maxWidth));
}
