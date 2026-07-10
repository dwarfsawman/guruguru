/**
 * 構造化 JSON 生成(Docs/Feature-ScriptToManga.md S4)。1回目は `response_format: json_schema` で
 * 依頼し、非対応/パース不能/検証失敗ならプロンプト誘導(「JSONのみ出力」+スキーマ提示)へ
 * フォールバックして再試行する。検証は手書き `validate` 関数(repo 慣例。zod は入れない)。
 */
import { type ChatMessage, chatCompletion, LlmHttpError } from "./llm";
import type { LlmSettings } from "../shared/types";

export interface GenerateStructuredJsonOptions<T> {
  settings: LlmSettings;
  systemPrompt: string;
  userPrompt: string;
  /** response_format 用の JSON Schema。 */
  schema: object;
  /** 手書き検証。無効なら null を返す(zod 等は導入しない、repo 慣例)。 */
  validate: (raw: unknown) => T | null;
  /** 検証失敗時の追加再試行回数(初回を含まない)。既定 2。 */
  maxRetries?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GenerateStructuredJsonResult<T> {
  value: T;
  rawOutput: string;
  /** 成功した試行で実際に送信した messages(request_json への永続化用)。 */
  messages: ChatMessage[];
}

/**
 * 総失敗時に投げるエラー。呼び出し側(dialogueProposals.ts 等)が `dialogue_proposals.request_json` /
 * `raw_output` へ「最後に送った messages」「最後に受け取った生テキスト」を残せるよう保持する。
 */
export class StructuredJsonError extends Error {
  constructor(
    message: string,
    public messages: ChatMessage[],
    public rawOutput: string | null
  ) {
    super(message);
    this.name = "StructuredJsonError";
  }
}

function jsonSchemaResponseFormat(schema: object) {
  return {
    type: "json_schema",
    json_schema: { name: "structured_response", schema, strict: true }
  };
}

function stripCodeFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]!.trim() : text;
}

/** コードフェンス除去+"前後にゴミが付いた JSON" のベストエフォート救済。 */
function bestEffortParseJson(content: string): unknown {
  const candidate = stripCodeFence(content.trim());
  try {
    return JSON.parse(candidate);
  } catch {
    // fallthrough to the brace-slice heuristic below
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function buildSystemPrompt(basePrompt: string, schema: object): string {
  return `${basePrompt}\n\n出力は次の JSON Schema に従う JSON のみとしてください。説明文・前置き・コードフェンスは付けないでください。\n${JSON.stringify(schema)}`;
}

export async function generateStructuredJson<T>(opts: GenerateStructuredJsonOptions<T>): Promise<GenerateStructuredJsonResult<T>> {
  const maxRetries = opts.maxRetries ?? 2;
  const systemPrompt = buildSystemPrompt(opts.systemPrompt, opts.schema);

  let lastMessages: ChatMessage[] = [];
  let lastRawOutput: string | null = null;
  let lastErrorSummary: string | null = null;
  // 1回目は response_format:json_schema、失敗(非対応含む)なら以降はプレーンプロンプト誘導のみに倒す。
  let useJsonSchemaMode = true;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const userContent = lastErrorSummary
      ? `${opts.userPrompt}\n\n[前回の出力は無効でした: ${lastErrorSummary}]\nJSON のみを出力し直してください。`
      : opts.userPrompt;
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent }
    ];
    lastMessages = messages;

    let content: string;
    try {
      const result = await chatCompletion(opts.settings, {
        messages,
        temperature: opts.temperature,
        responseFormat: useJsonSchemaMode ? jsonSchemaResponseFormat(opts.schema) : undefined,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal
      });
      content = result.content;
    } catch (error) {
      if (error instanceof LlmHttpError && error.authError) {
        // 401/403 はリトライしない(既知の要求: 認証エラーを明示)。
        throw error;
      }
      if (useJsonSchemaMode) {
        // response_format 非対応の可能性 → プロンプト誘導のみのフォールバックへ切り替えて再試行する
        // (この切り替え自体は「検証失敗の再試行」回数を消費しない)。
        useJsonSchemaMode = false;
        lastErrorSummary = error instanceof Error ? error.message : String(error);
        attempt -= 1;
        continue;
      }
      lastErrorSummary = error instanceof Error ? error.message : String(error);
      if (attempt === maxRetries) {
        throw new StructuredJsonError(`LLM呼び出しに失敗しました: ${lastErrorSummary}`, lastMessages, lastRawOutput);
      }
      continue;
    }

    lastRawOutput = content;
    const parsed = bestEffortParseJson(content);
    if (parsed === undefined) {
      lastErrorSummary = "応答をJSONとして解析できませんでした。";
    } else {
      const validated = opts.validate(parsed);
      if (validated !== null) {
        return { value: validated, rawOutput: content, messages };
      }
      lastErrorSummary = "応答がスキーマ検証に失敗しました(期待した形式と異なります)。";
    }
    // json_schema モードで解析/検証に失敗した場合もプロンプト誘導へフォールバックする
    // (ローカルLLMの response_format 対応差への二段構え)。
    useJsonSchemaMode = false;
    if (attempt === maxRetries) {
      throw new StructuredJsonError(`LLMの構造化応答の検証に失敗しました: ${lastErrorSummary}`, lastMessages, lastRawOutput);
    }
  }

  // ループは必ず return か throw で抜けるためここには到達しない。
  throw new StructuredJsonError("LLMの構造化応答を取得できませんでした。", lastMessages, lastRawOutput);
}
