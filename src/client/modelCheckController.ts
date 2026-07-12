/**
 * 「必要モデルインストール」モーダルの controller。
 * `settingsController.ts` の `refreshComfyStatus()` と同じ「api<T>() → state更新 → requestRender()」
 * パターンを踏襲する。AGENTS.md 規約により data-action は `registerActions` で登録する。
 */
import type { ModelCheckResult, WorkflowTemplate } from "../shared/apiTypes";
import type { ModelFamily } from "../shared/workflowModels";
import { api } from "./api";
import { requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";

let modelCheckRequestId = 0;

export async function refreshModelCheck(family: ModelFamily) {
  const requestId = ++modelCheckRequestId;
  state.modelCheck = {
    status: "loading",
    result: state.modelCheck.result?.family === family ? state.modelCheck.result : null
  };
  requestRender();
  try {
    const result = await api<ModelCheckResult>(`/api/comfy/model-check?family=${family}`);
    if (requestId === modelCheckRequestId) {
      state.modelCheck = { status: "ready", result };
    }
  } catch {
    if (requestId === modelCheckRequestId) {
      state.modelCheck = { status: "error", result: state.modelCheck.result };
    }
  } finally {
    if (requestId === modelCheckRequestId) {
      requestRender();
    }
  }
}

registerActions({
  "open-model-install": (_id, target) => {
    const family = target.closest<HTMLElement>("[data-family]")?.dataset.family;
    if (family !== "chroma" && family !== "anima") {
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
  },
  "install-model-preset": async (_id, target) => {
    const family = target.closest<HTMLElement>("[data-family]")?.dataset.family;
    if (family !== "chroma" && family !== "anima") {
      return;
    }
    await api(`/api/model-presets/${family}`, { method: "POST" });
    state.templates = (await api<{ templates: WorkflowTemplate[] }>("/api/templates")).templates;
    state.modelInstallFamily = null;
    requestRender();
  }
});
