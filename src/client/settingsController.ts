import type { ComfySettings, LlmSettings } from "../shared/types";
import type { ComfyStatus, LlmStatus } from "../shared/apiTypes";
import { api } from "./api";
import { type Json } from "./json";
import { requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { readForm } from "./formUtils";
import { setPositivePromptDraft } from "./generationDraft";

async function persistComfySettings() {
  const form = readForm("settings-form");
  state.settings = await api<ComfySettings>("/api/settings/comfy", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: form.baseUrl,
      websocketUrl: form.websocketUrl,
      timeoutSeconds: Number(form.timeoutSeconds),
      storageDir: form.storageDir,
      webSamModelBaseUrl: form.webSamModelBaseUrl
    })
  });
}

async function saveSettings() {
  await persistComfySettings();
  state.message = "ComfyUI接続設定を保存しました。";
  requestRender();
  await refreshComfyStatus(true);
}

/** 「接続」ボタン: 設定の保存と接続テストを1操作にまとめる */
async function connectComfy() {
  await persistComfySettings();
  await testComfy();
}

async function testComfy() {
  state.comfyConnection = "checking";
  state.comfyStatusText = "接続確認中";
  requestRender();
  const result = await api<Json>("/api/comfy/test", { method: "POST", body: "{}" });
  state.comfyConnection = isComfyTestSuccessful(result) ? "connected" : "disconnected";
  state.comfyStatusText = state.comfyConnection === "connected" ? "ComfyUI 接続済み" : "ComfyUI 未接続";
  state.message = JSON.stringify(result, null, 2);
  requestRender();
}

export async function refreshComfyStatus(showMessage = false) {
  state.comfyConnection = "checking";
  state.comfyStatusText = "接続確認中";
  requestRender();
  try {
    const status = await api<ComfyStatus>("/api/comfy/status");
    state.comfyConnection = status.ok ? "connected" : "disconnected";
    state.comfyStatusText = status.ok ? "ComfyUI 接続済み" : `ComfyUI 未接続: ${status.error ?? status.baseUrl}`;
    if (showMessage) {
      state.message = state.comfyStatusText;
    }
  } catch (error) {
    state.comfyConnection = "disconnected";
    state.comfyStatusText = error instanceof Error ? error.message : String(error);
    if (showMessage) {
      state.message = state.comfyStatusText;
    }
  }
  requestRender();
}

function isComfyTestSuccessful(result: Json) {
  const objectInfo = result.objectInfo as { ok?: unknown } | undefined;
  const queue = result.queue as { ok?: unknown } | undefined;
  const websocket = result.websocket as { ok?: unknown } | undefined;
  return objectInfo?.ok === true && queue?.ok === true && websocket?.ok === true;
}

async function persistLlmSettings() {
  const form = readForm("llm-settings-form");
  state.llmSettings = await api<LlmSettings>("/api/settings/llm", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: form.baseUrl,
      model: form.model,
      systemPrompt: form.systemPrompt,
      temperature: Number(form.temperature)
    })
  });
}

/** 「接続」ボタン: LLM設定の保存と接続テストを1操作にまとめる（ComfyUI側と同じ挙動） */
async function connectLlm() {
  await persistLlmSettings();
  await testLlm();
}

async function testLlm() {
  state.llmConnection = "checking";
  state.llmStatusText = "接続確認中";
  requestRender();
  const result = await api<Json>("/api/llm/test", { method: "POST", body: "{}" });
  state.llmConnection = result.ok === true ? "connected" : "disconnected";
  state.llmStatusText = state.llmConnection === "connected" ? "OpenAI互換 接続済み" : `OpenAI互換 未接続: ${result.error ?? ""}`;
  state.message = JSON.stringify(result, null, 2);
  requestRender();
}

export async function refreshLlmStatus() {
  if (!state.llmSettings?.baseUrl.trim() || !state.llmSettings?.model.trim()) {
    state.llmConnection = "unknown";
    state.llmStatusText = "未設定";
    requestRender();
    return;
  }
  state.llmConnection = "checking";
  requestRender();
  try {
    const status = await api<LlmStatus>("/api/llm/status");
    state.llmConnection = status.ok ? "connected" : "disconnected";
    state.llmStatusText = status.ok ? "OpenAI互換 接続済み" : `OpenAI互換 未接続: ${status.error ?? status.baseUrl}`;
  } catch (error) {
    state.llmConnection = "disconnected";
    state.llmStatusText = error instanceof Error ? error.message : String(error);
  }
  requestRender();
}

let improveController: AbortController | null = null;

function cancelImprovePrompt() {
  improveController?.abort();
}

async function improvePrompt() {
  if (state.llmImproving) {
    return;
  }
  const promptValue = state.generationDraft?.prompt ?? "";
  const negativePromptValue = state.generationDraft?.negativePrompt ?? "";
  const controller = new AbortController();
  improveController = controller;
  state.llmImproving = true;
  requestRender();
  try {
    const result = await api<{ prompt: string }>("/api/llm/improve-prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: promptValue, negativePrompt: negativePromptValue }),
      signal: controller.signal
    });
    setPositivePromptDraft(result.prompt);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      throw error;
    }
  } finally {
    if (improveController === controller) {
      improveController = null;
    }
    state.llmImproving = false;
    requestRender();
  }
}

registerActions({
  "save-settings": () => saveSettings(),
  "test-comfy": () => testComfy(),
  "connect-comfy": () => connectComfy(),
  "check-comfy-connection": () => {
    if (state.comfyConnection !== "checking") {
      return refreshComfyStatus(true);
    }
  },
  "connect-llm": () => connectLlm(),
  "improve-prompt": () => improvePrompt(),
  "cancel-improve-prompt": () => cancelImprovePrompt()
});
