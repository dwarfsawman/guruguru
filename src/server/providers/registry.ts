import { HttpError } from "../http";
import { comfyProvider } from "./comfyProvider";
import type { GenerationProvider } from "./types";

const providers = new Map<string, GenerationProvider>([[comfyProvider.id, comfyProvider]]);

/**
 * テスト専用フック(Docs/Feature-ScriptToManga.md S1 契約テスト): FakeProvider を registry へ登録する。
 * 本番コードパスからは呼ばれない(request.providerId は隠しフックでクライアントは送らない)。
 */
export function registerProvider(provider: GenerationProvider) {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): GenerationProvider {
  const provider = findProvider(id);
  if (!provider) {
    throw new HttpError(400, `Unknown generation provider: ${id}`);
  }
  return provider;
}

/**
 * `getProvider` の非例外版。未知の provider_id(例: manual アップロード由来ラウンドの `provider_id
 * = 'manual'`)に対して「監視/後始末の対象が無い」ことを表す null を返すために使う
 * (Docs/Feature-ScriptToManga.md S1 レビュー指摘1: stopRoundMonitor がこれを使う)。
 */
export function findProvider(id: string): GenerationProvider | null {
  return providers.get(id) ?? null;
}

export function listProviders(): GenerationProvider[] {
  return [...providers.values()];
}
