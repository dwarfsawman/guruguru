/**
 * OpenAI 互換 LLM 接続の共通基盤(Docs/Feature-ScriptToManga.md S4)。
 * `chatCompletion` が唯一の HTTP 呼び出し口で、既存の `improvePromptWithLlm` はその薄いラッパー。
 * `generateStructuredJson`(src/server/llmStructured.ts)や DialogueProvider(src/server/dialogue/)は
 * ここの `chatCompletion` / `LlmHttpError` を共用する。
 */
import { defaultLlmSettings, getSetting } from "./db";
import { HttpError } from "./http";
import type { LlmSettings } from "../shared/types";
import type { LlmStatus, LlmSettingsView } from "../shared/apiTypes";

export function getLlmSettings(): LlmSettings {
  return {
    ...defaultLlmSettings,
    ...(getSetting<Partial<LlmSettings>>("llm") ?? {})
  };
}

/** `apiKey` 本体を落とし `hasApiKey` フラグへ変換する(既知の罠11。API レスポンスへ生の key を出さない)。 */
export function toLlmSettingsView(settings: LlmSettings): LlmSettingsView {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    temperature: settings.temperature,
    hasApiKey: Boolean(settings.apiKey?.trim())
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

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  temperature?: number;
  /** OpenAI互換 `response_format`(json_schema 等)。渡さなければ既定(自由形式)。 */
  responseFormat?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  content: string;
  raw: unknown;
}

/**
 * `/chat/completions` の汎用呼び出し。リトライ分類(Docs/Feature-ScriptToManga.md S4):
 * 401/403 はリトライしない(即座に `LlmHttpError.authError=true` を投げる)。429・5xx は
 * 短いバックオフを挟んで1回だけ再試行する。それ以外のエラーはそのまま投げる。
 */
export async function chatCompletion(settings: LlmSettings, opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  if (!isLlmConfigured(settings)) {
    throw new HttpError(400, "OpenAI互換プロンプト接続が設定されていません。");
  }
  const body: Record<string, unknown> = {
    model: settings.model,
    temperature: opts.temperature ?? settings.temperature,
    messages: opts.messages
  };
  if (opts.responseFormat) {
    body.response_format = opts.responseFormat;
  }
  const timeoutMs = opts.timeoutMs ?? 60000;
  const attempt = () =>
    llmFetchJson(
      settings,
      "/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      },
      timeoutMs,
      opts.signal
    );

  let response: unknown;
  try {
    response = await attempt();
  } catch (error) {
    if (error instanceof LlmHttpError && error.retryable && !error.authError) {
      await delay(400 + Math.random() * 300);
      response = await attempt();
    } else {
      throw error;
    }
  }

  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLMの応答から内容を取得できませんでした。");
  }
  return { content: content.trim(), raw: response };
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

  const { content } = await chatCompletion(settings, {
    messages: [
      { role: "system", content: settings.systemPrompt || defaultLlmSettings.systemPrompt },
      { role: "user", content: userContent }
    ],
    timeoutMs: 60000
  });
  return content;
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

/** エラーボディを API/ログへ載せても問題ない長さへ切り詰める(丸ごと保存すると巨大化するため)。 */
const MAX_ERROR_BODY_LENGTH = 500;

/** OpenAI 互換 LLM サーバーからの非 2xx 応答/接続失敗を表す。リトライ分類は `retryable`/`authError` を見る。 */
export class LlmHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryable: boolean,
    public authError = false
  ) {
    super(message);
    this.name = "LlmHttpError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 低レベル fetch ヘルパ。**response.ok 判定 → JSON.parse の順**(Docs/Feature-ScriptToManga.md S4 既知の
 * 欠陥修正: 旧実装は JSON.parse を先に行っていたため、エラー応答が非 JSON だと本来のHTTPエラーではなく
 * JSON.parse の汎用例外が飛んでいた)。abort は「呼び出し元キャンセル」と「timeout」を区別したメッセージにする。
 */
async function llmFetchJson<T = unknown>(
  settings: LlmSettings,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort);
    }
  }
  try {
    const base = settings.baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (settings.apiKey?.trim()) {
      headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
    }

    let response: Response;
    try {
      response = await fetch(`${base}${path}`, { ...init, headers, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new LlmHttpError(
          0,
          externalSignal?.aborted ? "リクエストがキャンセルされました。" : "LLMサーバーへの接続がタイムアウトしました。",
          false
        );
      }
      throw error;
    }

    const text = await response.text();
    if (!response.ok) {
      const truncated = text.length > MAX_ERROR_BODY_LENGTH ? `${text.slice(0, MAX_ERROR_BODY_LENGTH)}…` : text;
      const authError = response.status === 401 || response.status === 403;
      const retryable = !authError && (response.status === 429 || response.status >= 500);
      throw new LlmHttpError(
        response.status,
        `LLMサーバーからエラーが返されました (${response.status}): ${truncated}`,
        retryable,
        authError
      );
    }
    return text ? (JSON.parse(text) as T) : (null as T);
  } finally {
    clearTimeout(timeout);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
