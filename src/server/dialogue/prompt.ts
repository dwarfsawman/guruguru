/**
 * DialogueProvider のプロンプト構成(Docs/Feature-ScriptToManga.md S4)。純ロジック(HTTP呼び出し無し)。
 * system: 「漫画のセリフ作家、JSONのみ出力」+ JSON Schema。
 * user: 該当シーン抜粋(scene_index 周辺)+コマ数と読み順+キャラクタ一覧+既存配置済みセリフ(重複回避)+指示。
 */
import type { DialogueSemanticKind } from "../../shared/apiTypes";

export interface DialoguePromptPanel {
  id: string;
  order: number;
}

export interface DialoguePromptCharacter {
  name: string;
  notes: string;
  aliases: string[];
}

export interface DialoguePromptExistingLine {
  speakerName: string;
  text: string;
}

export interface DialoguePromptContext {
  /** 該当シーン抜粋(前後1シーンを含む)。プレーンテキスト。 */
  sceneExcerpt: string;
  /** このページのコマ(読み順 order 昇順)。空配列 = レイアウト無しページ(panelId は常に null)。 */
  panels: DialoguePromptPanel[];
  characters: DialoguePromptCharacter[];
  /** 重複回避のため提示する、このページに既に配置済みのセリフ。 */
  existingLines: DialoguePromptExistingLine[];
  /** ユーザーからの追加指示(任意)。 */
  instruction?: string;
}

const SEMANTIC_KINDS: DialogueSemanticKind[] = ["dialogue", "monologue", "narration", "sfx"];

/** `generateStructuredJson` に渡す response_format 用 JSON Schema。 */
export const DIALOGUE_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          panelId: { type: ["string", "null"] },
          speakerName: { type: "string" },
          text: { type: "string" },
          semanticKind: { type: "string", enum: SEMANTIC_KINDS },
          emotion: { type: "string" }
        },
        required: ["speakerName", "text", "semanticKind"]
      }
    }
  },
  required: ["items"]
} as const;

export function buildDialogueSystemPrompt(): string {
  return "あなたは漫画のセリフ作家です。与えられたシーン抜粋・コマ構成・キャラクター設定から、コマに合うセリフ案を提案してください。出力はJSONのみとし、説明文・前置きは付けないでください。";
}

export function buildDialogueUserPrompt(ctx: DialoguePromptContext): string {
  const sections: string[] = [];

  sections.push("### シーン抜粋");
  sections.push(ctx.sceneExcerpt.trim() || "(シーン情報なし)");

  sections.push("### コマ構成(読み順)");
  if (ctx.panels.length > 0) {
    sections.push(
      ctx.panels
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((panel, index) => `${index + 1}コマ目: panelId="${panel.id}"`)
        .join("\n")
    );
  } else {
    sections.push("(コマ割り情報なし。ページ全体で案を出してよい。panelId は null にしてください。)");
  }

  sections.push("### キャラクター");
  if (ctx.characters.length > 0) {
    sections.push(
      ctx.characters
        .map((character) => {
          const aliasNote = character.aliases.length > 0 ? `(別名: ${character.aliases.join("、")})` : "";
          const notesNote = character.notes.trim() ? `: ${character.notes.trim()}` : "";
          return `- ${character.name}${aliasNote}${notesNote}`;
        })
        .join("\n")
    );
  } else {
    sections.push("(登録キャラクターなし。speakerName は脚本上の話者表記をそのまま使ってください。)");
  }

  sections.push("### 既に配置済みのセリフ(重複を避けてください)");
  sections.push(
    ctx.existingLines.length > 0
      ? ctx.existingLines.map((line) => `- ${line.speakerName || "(話者不明)"}: ${line.text}`).join("\n")
      : "(なし)"
  );

  const instructions = [
    "1コマにつきセリフは1〜2行程度としてください。",
    "sfx(SFX)は擬音語のみとし、通常の文にしないでください。",
    "panelId は上記コマ構成の id をそのまま使い、対応するコマが無ければ null にしてください。",
    "speakerName は上記キャラクター一覧の表記(または別名)に一致させてください。"
  ];
  if (ctx.instruction?.trim()) {
    instructions.push(`追加の指示: ${ctx.instruction.trim()}`);
  }
  sections.push("### 指示");
  sections.push(instructions.join("\n"));

  return sections.join("\n\n");
}
