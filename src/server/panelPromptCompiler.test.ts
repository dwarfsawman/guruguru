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
  shot: { size: "medium", angle: "front angle", focalSubjectId: entity.id, compositionIntent: "centered composition" },
  cast: [{
    characterId: entity.id,
    variantId: `${entity.id}:default`,
    bbox: { x: 0.2, y: 0.2, width: 0.5, height: 0.7 },
    pose: "standing upright",
    expression: "smiling",
    action: "waving a hand",
    speakingLineIds: []
  }],
  props: [],
  textSafeZones: [{ x: 0.65, y: 0.05, width: 0.3, height: 0.25 }],
  mustShow: [{ kind: "action", description: "waving a hand" }],
  mustNotShow: [{ kind: "other", description: "rain" }]
} as unknown as PanelSpec;

describe("compilePanelPrompt", () => {
  test("LLM mode compiles English direction metadata without source-language identity labels", () => {
    const result = compilePanelPrompt({
      panel,
      basePrompt: "A red-haired girl waves at the camera",
      entities: [entity],
      dialogueById: new Map(),
      narrativeMetadata: "english-directed"
    });

    expect(result).toContain("A red-haired girl waves at the camera");
    expect(result).toContain("waving a hand");
    expect(result).toContain("smiling expression");
    expect(result).toContain("must not show: rain");
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
    expect(result).toContain("waving a hand");
  });

  test("provided mode restores concrete panel facts instead of using only a scene-level prompt", () => {
    const result = compilePanelPrompt({
      panel,
      basePrompt: "A red-haired pilot braces inside a damaged cockpit, wide shot",
      entities: [entity],
      dialogueById: new Map(),
      narrativeMetadata: "base-only"
    });

    expect(result).toContain("A red-haired pilot braces inside a damaged cockpit, wide shot");
    expect(result).toContain("waving a hand");
    expect(result).toContain("must show: waving a hand");
    expect(result).not.toContain("medium shot");
  });

  test("provided mode removes dialogue wording from restored visual facts", () => {
    const dialoguePanel = structuredClone(panel);
    dialoguePanel.mustShow = [{ kind: "action", description: "警告灯のコックピット。通信「もう戦わなくていい」" }];
    const result = compilePanelPrompt({
      panel: dialoguePanel,
      basePrompt: "A wounded pilot braces inside a damaged cockpit",
      entities: [entity],
      dialogueById: new Map([["line-1", {
        id: "line-1", orderIndex: 0, sceneIndex: 0, characterId: entity.id,
        speakerLabel: "Akari", text: "もう戦わなくていい", semanticKind: "dialogue"
      }]]),
      narrativeMetadata: "base-only"
    });

    expect(result).toContain("警告灯のコックピット");
    expect(result).not.toContain("もう戦わなくていい");
  });
});
