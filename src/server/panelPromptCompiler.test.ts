import { describe, expect, test } from "bun:test";
import type { NarrativeEntity, PanelSpec } from "../shared/mangaPlanV2";
import { compilePanelPrompt } from "./panelPromptCompiler";

const entity: NarrativeEntity = {
  id: "character-akari",
  kind: "character",
  name: "あかり",
  aliases: [],
  attributes: { description: "赤い髪の少女" },
  variants: []
};

const panel = {
  shot: { size: "medium", angle: "正面", focalSubjectId: entity.id, compositionIntent: "中央構図" },
  cast: [{
    characterId: entity.id,
    variantId: `${entity.id}:default`,
    bbox: { x: 0.2, y: 0.2, width: 0.5, height: 0.7 },
    pose: "立っている",
    expression: "笑顔",
    action: "手を振る",
    speakingLineIds: []
  }],
  props: [],
  textSafeZones: [{ x: 0.65, y: 0.05, width: 0.3, height: 0.25 }],
  mustShow: [{ kind: "action", description: "手を振る" }],
  mustNotShow: [{ kind: "other", description: "雨" }]
} as unknown as PanelSpec;

describe("compilePanelPrompt", () => {
  test("LLM mode keeps stored narrative metadata out of the English generation prompt", () => {
    const result = compilePanelPrompt({
      panel,
      basePrompt: "A red-haired girl waves at the camera",
      entities: [entity],
      dialogueById: new Map(),
      narrativeMetadata: "base-only"
    });

    expect(result).toContain("A red-haired girl waves at the camera");
    expect(result).toContain("leave upper-right region visually quiet");
    expect(result).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff]/u);
  });

  test("deterministic mode still appends narrative metadata", () => {
    const result = compilePanelPrompt({
      panel,
      basePrompt: "Monochrome manga",
      entities: [entity],
      dialogueById: new Map(),
      narrativeMetadata: "append"
    });

    expect(result).toContain("あかり");
    expect(result).toContain("手を振る");
  });
});
