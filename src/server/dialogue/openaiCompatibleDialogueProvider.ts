/**
 * OpenAI互換 DialogueProvider(Docs/Feature-ScriptToManga.md S4)。画像の GenerationProvider とは
 * 別系統(責務分離のため src/server/dialogue/ 配下に置く)。共通 HTTP 層は src/server/llm.ts の
 * `chatCompletion` を、構造化生成は src/server/llmStructured.ts の `generateStructuredJson` を共用する。
 */
import type { LlmSettings } from "../../shared/types";
import type { DialogueProposalItem, DialogueSemanticKind } from "../../shared/apiTypes";
import { generateStructuredJson } from "../llmStructured";
import type { ChatMessage } from "../llm";
import { buildDialogueSystemPrompt, buildDialogueUserPrompt, DIALOGUE_PROPOSAL_SCHEMA, type DialoguePromptContext } from "./prompt";

const SEMANTIC_KINDS = new Set<DialogueSemanticKind>(["dialogue", "monologue", "narration", "sfx"]);

export interface DialogueSuggestContext extends DialoguePromptContext {
  settings: LlmSettings;
  signal?: AbortSignal;
}

export interface DialogueSuggestResult {
  items: DialogueProposalItem[];
  rawOutput: string;
  model: string;
  /** 送信した messages(呼び出し側が request_json へ永続化する)。 */
  messages: ChatMessage[];
}

interface RawDialogueItem {
  panelId: string | null;
  speakerName: string;
  text: string;
  semanticKind: DialogueSemanticKind;
  emotion?: string;
}

/** 手書き検証(repo 慣例。zod は導入しない)。空配列は「セリフ無し」として無意味なため検証エラー扱いにする。 */
function validateItems(raw: unknown): RawDialogueItem[] | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { items?: unknown }).items)) {
    return null;
  }
  const rawItems = (raw as { items: unknown[] }).items;
  const out: RawDialogueItem[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.speakerName !== "string" || !item.speakerName.trim()) {
      return null;
    }
    if (typeof item.text !== "string" || !item.text.trim()) {
      return null;
    }
    const semanticKind = SEMANTIC_KINDS.has(item.semanticKind as DialogueSemanticKind)
      ? (item.semanticKind as DialogueSemanticKind)
      : "dialogue";
    const parsed: RawDialogueItem = {
      panelId: typeof item.panelId === "string" && item.panelId.trim() ? item.panelId.trim() : null,
      speakerName: item.speakerName.trim(),
      text: item.text.trim(),
      semanticKind
    };
    if (typeof item.emotion === "string" && item.emotion.trim()) {
      parsed.emotion = item.emotion.trim();
    }
    out.push(parsed);
  }
  return out.length > 0 ? out : null;
}

export const openaiCompatibleDialogueProvider = {
  id: "openai-compatible" as const,

  async suggest(ctx: DialogueSuggestContext): Promise<DialogueSuggestResult> {
    const { value, rawOutput, messages } = await generateStructuredJson<RawDialogueItem[]>({
      settings: ctx.settings,
      systemPrompt: buildDialogueSystemPrompt(),
      userPrompt: buildDialogueUserPrompt(ctx),
      schema: DIALOGUE_PROPOSAL_SCHEMA,
      validate: validateItems,
      signal: ctx.signal
    });
    const items: DialogueProposalItem[] = value.map((item) => {
      const proposalItem: DialogueProposalItem = {
        panelId: item.panelId,
        speakerName: item.speakerName,
        text: item.text,
        semanticKind: item.semanticKind,
        itemStatus: "proposed"
      };
      if (item.emotion) {
        proposalItem.emotion = item.emotion;
      }
      return proposalItem;
    });
    return { items, rawOutput, model: ctx.settings.model, messages };
  }
};

export type DialogueProvider = typeof openaiCompatibleDialogueProvider;
