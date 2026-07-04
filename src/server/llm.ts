import { defaultLlmSettings, getSetting } from "./db";
import { HttpError } from "./http";
import type { LlmSettings } from "../shared/types";
import type { LlmStatus } from "../shared/apiTypes";

export function getLlmSettings(): LlmSettings {
  return {
    ...defaultLlmSettings,
    ...(getSetting<Partial<LlmSettings>>("llm") ?? {})
  };
}

export function isLlmConfigured(settings: LlmSettings = getLlmSettings()) {
  return Boolean(settings.baseUrl.trim() && settings.model.trim());
}

export async function getLlmStatus(): Promise<LlmStatus> {
  const settings = getLlmSettings();
  if (!isLlmConfigured(settings)) {
    return {
      ok: false,
      state: "disconnected",
      baseUrl: settings.baseUrl,
      checkedAt: new Date().toISOString(),
      error: "未設定"
    };
  }
  try {
    await llmFetchJson(settings, "/models", {}, 1500);
    return {
      ok: true,
      state: "connected",
      baseUrl: settings.baseUrl,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      state: "disconnected",
      baseUrl: settings.baseUrl,
      checkedAt: new Date().toISOString(),
      error: errorMessage(error)
    };
  }
}

export async function testLlmConnection() {
  const settings = getLlmSettings();
  if (!isLlmConfigured(settings)) {
    return { ok: false, baseUrl: settings.baseUrl, error: "Base URLとModelを入力してください。" };
  }
  try {
    const models = await llmFetchJson(settings, "/models", {}, 8000);
    const modelIds = extractModelIds(models);
    return {
      ok: true,
      baseUrl: settings.baseUrl,
      model: settings.model,
      modelListed: modelIds.length === 0 ? null : modelIds.includes(settings.model)
    };
  } catch (error) {
    return { ok: false, baseUrl: settings.baseUrl, error: errorMessage(error) };
  }
}

export async function improvePromptWithLlm(prompt: string, negativePrompt?: string): Promise<string> {
  const settings = getLlmSettings();
  if (!isLlmConfigured(settings)) {
    throw new HttpError(400, "OpenAI互換プロンプト接続が設定されていません。");
  }

  const userContent = [
    "以下の画像生成プロンプトを、より具体的で効果的な内容に改善してください。",
    "出力は改善後のプロンプト本文のみとし、説明・前置き・引用符は付けないでください。",
    "",
    `現在のプロンプト: ${prompt.trim() || "(空)"}`,
    negativePrompt?.trim() ? `ネガティブプロンプト: ${negativePrompt.trim()}` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const response = await llmFetchJson(
    settings,
    "/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        temperature: settings.temperature,
        messages: [
          { role: "system", content: settings.systemPrompt || defaultLlmSettings.systemPrompt },
          { role: "user", content: userContent }
        ]
      })
    },
    60000
  );

  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
    ?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLMの応答からプロンプトを取得できませんでした。");
  }
  return content.trim();
}

function extractModelIds(response: unknown): string[] {
  const data = (response as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

async function llmFetchJson(settings: LlmSettings, path: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = settings.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(`LLMサーバーからエラーが返されました (${response.status}): ${text}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
