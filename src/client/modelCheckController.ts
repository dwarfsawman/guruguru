/**
 * 「必要モデルインストール」モーダルの controller。
 * `settingsController.ts` の `refreshComfyStatus()` と同じ「api<T>() → state更新 → requestRender()」
 * パターンを踏襲する。AGENTS.md 規約により data-action は `registerActions` で登録する。
 */
import type { ModelCheckResult } from "../shared/apiTypes";
import { api } from "./api";
import { requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";

let modelCheckInFlight = false;

export async function refreshModelCheck(family: "chroma") {
  if (modelCheckInFlight) {
    return;
  }
  modelCheckInFlight = true;
  state.modelCheck = { status: "loading", result: state.modelCheck.result };
  requestRender();
  try {
    const result = await api<ModelCheckResult>(`/api/comfy/model-check?family=${family}`);
    state.modelCheck = { status: "ready", result };
  } catch {
    state.modelCheck = { status: "error", result: state.modelCheck.result };
  } finally {
    modelCheckInFlight = false;
    requestRender();
  }
}

registerActions({
  "open-model-install": (_id, target) => {
    const family = target.closest<HTMLElement>("[data-family]")?.dataset.family;
    if (family !== "chroma") {
      return;
    }
    state.modelInstallFamily = family;
    requestRender();
    void refreshModelCheck(family);
  },
  "close-model-install": () => {
    state.modelInstallFamily = null;
    requestRender();
  },
  "recheck-models": () => {
    if (state.modelInstallFamily) {
      void refreshModelCheck(state.modelInstallFamily);
    }
  }
});
