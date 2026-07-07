/**
 * Consistent Character(Docs/Feature-ConsistentCharacter.md)の参照画像取り込み controller。
 * 生成フォームの「参照画像」枠(親画像の直下)の取り込み・クリア・顔スタイル参照(PuLID)/
 * 全体スタイル参照(IP-Adapter)トグルを扱う。AGENTS.md 規約により data-action は
 * `registerActions` で登録する。
 */
import { requestRender, state, type ReferenceDraft } from "./appState";
import { registerActions } from "./actionRegistry";
import { persistProjectDraft } from "./draftStore";

export function defaultReferenceDraft(): ReferenceDraft {
  return { imageDataUrl: null, faceEnabled: false, styleEnabled: false };
}

/**
 * `state.modelCheck.result.features` から顔/スタイル参照の可用性を読む。
 * 未取得(モデルチェック未実行)またはComfyUI未接続時は false(トグルは無効のまま)。
 */
export function referenceFeatureAvailability(): { pulid: boolean; ipadapter: boolean } {
  const features = state.modelCheck.result?.features ?? [];
  return {
    pulid: features.find((feature) => feature.key === "pulid")?.available === true,
    ipadapter: features.find((feature) => feature.key === "ipadapter")?.available === true
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

  const imageDataUrl = await fileToDataUrl(file);
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
  "toggle-reference-face": () => {
    if (!referenceFeatureAvailability().pulid) {
      return;
    }
    const draft = state.referenceDraft ?? defaultReferenceDraft();
    state.referenceDraft = { ...draft, faceEnabled: !draft.faceEnabled };
    persist();
    requestRender();
  },
  "toggle-reference-style": () => {
    if (!referenceFeatureAvailability().ipadapter) {
      return;
    }
    const draft = state.referenceDraft ?? defaultReferenceDraft();
    state.referenceDraft = { ...draft, styleEnabled: !draft.styleEnabled };
    persist();
    requestRender();
  },
  "clear-reference-image": () => {
    clearReferenceImage();
  }
});
