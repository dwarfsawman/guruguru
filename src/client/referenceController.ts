/**
 * Consistent Character(Docs/Feature-ConsistentCharacter.md)の参照画像取り込み controller。
 * 生成フォームの「参照画像」枠(親画像の直下)の取り込み・クリア・顔スタイル参照(PuLID)
 * トグルを扱う。AGENTS.md 規約により data-action は `registerActions` で登録する。
 */
import type { RecentReferenceImage } from "../shared/apiTypes";
import { pushToast, requestRender, state, type ReferenceDraft } from "./appState";
import { registerActions } from "./actionRegistry";
import { persistProjectDraft } from "./draftStore";
import { api } from "./api";

export function defaultReferenceDraft(): ReferenceDraft {
  return { imageDataUrl: null };
}

/**
 * 「最近使った参照画像」を取得して state.recentReferenceImages を更新する(Book のページ間で
 * 同じキャラ顔を再利用しやすくするピッカー用)。現在のプロジェクトのラウンドから収集する。
 */
export async function refreshRecentReferenceImages() {
  if (!state.currentProjectId) {
    state.recentReferenceImages = [];
    return;
  }
  try {
    const result = await api<{ images: RecentReferenceImage[] }>(
      `/api/projects/${state.currentProjectId}/reference-images?limit=12`
    );
    state.recentReferenceImages = result.images;
  } catch {
    state.recentReferenceImages = [];
  }
  requestRender();
}

/** 「最近使った画像」から1枚を選んで現在の参照画像ドラフトに設定する(画像を fetch → dataURL 化)。 */
async function useRecentReferenceImage(url: string) {
  // fetch/FileReader の await 中にページを離れる可能性があるため、クリック時のページを捕捉しておく。
  const targetPageId = state.activePageId;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`参照画像を取得できませんでした (${response.status})`);
    }
    const dataUrl = await blobToDataUrl(await response.blob());
    // 別ページへ移動していたら、そのページの参照ドラフトに誤って適用しないよう破棄する。
    if (state.activePageId !== targetPageId) {
      return;
    }
    state.referenceDraft = { ...(state.referenceDraft ?? defaultReferenceDraft()), imageDataUrl: dataUrl };
    persist();
    requestRender();
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
    requestRender();
  }
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("画像を読み込めませんでした。")));
    reader.readAsDataURL(blob);
  });
}

/**
 * `state.modelCheck.result.features` から顔スタイル参照(PuLID)の可用性を読む。
 * 未取得(モデルチェック未実行)またはComfyUI未接続時は false(トグルは無効のまま)。
 */
export function referenceFeatureAvailability(): { pulid: boolean } {
  const features = state.modelCheck.result?.features ?? [];
  return {
    pulid: features.find((feature) => feature.key === "pulid")?.available === true
  };
}

function persist() {
  if (state.currentProjectId) {
    persistProjectDraft(state.currentProjectId);
  }
}

export async function uploadReferenceImage(input: HTMLInputElement) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) {
    return;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    state.message = "参照画像は PNG / JPEG / WebP 画像を選択してください。";
    requestRender();
    return;
  }

  const targetPageId = state.activePageId;
  const imageDataUrl = await fileToDataUrl(file);
  // FileReader の await 中に別ページへ移動していたら、そのページへ誤適用しないよう破棄する。
  if (state.activePageId !== targetPageId) {
    return;
  }
  state.referenceDraft = { ...(state.referenceDraft ?? defaultReferenceDraft()), imageDataUrl };
  persist();
  requestRender();
}

export function clearReferenceImage() {
  state.referenceDraft = defaultReferenceDraft();
  persist();
  requestRender();
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("参照画像を読み込めませんでした。")));
    reader.readAsDataURL(file);
  });
}

registerActions({
  "clear-reference-image": () => {
    clearReferenceImage();
  },
  "use-recent-reference": (_id, target) => {
    const url = target.dataset.url;
    if (url) {
      void useRecentReferenceImage(url);
    }
  }
});
