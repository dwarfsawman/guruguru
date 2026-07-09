/**
 * テキストレイアウトのクライアント側 LRU キャッシュ + フェッチ(Docs/Feature-CGCollectionSuite.md P2)。
 * `POST /api/text-layout` を叩いて結果を `(content, maxWidth)` キーでキャッシュする(サーバ側の
 * `textLayoutApi.ts` と同じキー方針、キャッシュ自体は別)。debounce は呼び出し側(`pageObjectsController.ts`)
 * の責務 -- ここは「無ければ取りに行く/あれば即返す」だけの薄いレイヤ。
 * レイアウト未着の間、`getCachedTextLayout` は null を返す(呼び出し側=view がプレースホルダ枠を出す)。
 */
import type { TextLayoutResponse } from "../shared/apiTypes";
import type { TextContent } from "../shared/pageObjects";
import { api } from "./api";
import { requestRender } from "./appState";

const CACHE_LIMIT = 100;
const cache = new Map<string, TextLayoutResponse>();
const inflight = new Set<string>();

function cacheKeyFor(content: TextContent, maxWidth: number | undefined): string {
  return JSON.stringify({ content, maxWidth: maxWidth ?? null });
}

/** キャッシュ済みならそれを返す(副作用なし)。無ければ null -- 呼び出し側は `ensureTextLayout` で取得をトリガーする。 */
export function getCachedTextLayout(content: TextContent, maxWidth: number | undefined): TextLayoutResponse | null {
  return cache.get(cacheKeyFor(content, maxWidth)) ?? null;
}

function remember(key: string, response: TextLayoutResponse): void {
  cache.delete(key);
  cache.set(key, response);
  if (cache.size > CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
}

/**
 * キャッシュに無く、かつ同一キーで進行中のリクエストも無ければ `POST /api/text-layout` を叩く。
 * 取得できたら `requestRender()` して view に反映させる(view は毎回 `getCachedTextLayout` を読むだけの
 * 受動的な参照なので、fetch 完了を知らせるトリガーが要る)。debounce したい場合は呼び出し側が
 * `window.setTimeout` でこの関数呼び出し自体を遅延させること。
 */
export async function ensureTextLayout(content: TextContent, maxWidth: number | undefined): Promise<void> {
  const key = cacheKeyFor(content, maxWidth);
  if (cache.has(key) || inflight.has(key)) {
    return;
  }
  inflight.add(key);
  try {
    const response = await api<TextLayoutResponse>("/api/text-layout", {
      method: "POST",
      body: JSON.stringify({ content, maxWidth })
    });
    remember(key, response);
    requestRender();
  } catch {
    // レイアウト取得失敗はプレースホルダ表示のまま静かに諦める(ローカルサーバ前提でリトライの価値は薄い)。
  } finally {
    inflight.delete(key);
  }
}
