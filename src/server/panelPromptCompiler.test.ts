import { describe, expect, test } from "bun:test";
import type { NarrativeEntity, PanelSpec } from "../shared/mangaPlanV2";
import { compilePanelConditioning, compilePanelPrompt } from "./panelPromptCompiler";

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

  test("v3 moves avoid facts to negative conditioning and injects identity tags", () => {
    const englishEntity = { ...entity, attributes: { tags: "short silver hair, blue eyes, black jacket" } };
    const result = compilePanelConditioning({ panel, basePrompt: "damaged cockpit", entities: [englishEntity], dialogueById: new Map(), dialect: "tags" });
    expect(result.positive).toContain("short silver hair");
    expect(result.positive).not.toContain("rain");
    expect(result.negative).toContain("rain");
  });

  test("tags dialect translates source-language visual facts and does not invent characters for an empty cast", () => {
    const empty = { ...panel, cast: [], promptBase: "漆黒の宇宙。砕けた人工衛星。白い人型機動兵器。" };
    const result = compilePanelConditioning({ panel: empty, basePrompt: empty.promptBase, entities: [], dialogueById: new Map(), dialect: "tags" });
    expect(result.positive).toMatch(/outer space/);
    expect(result.positive).toMatch(/broken satellite debris/);
    expect(result.positive).toMatch(/white humanoid mecha/);
    expect(result.positive).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff]|0characters/);
  });

  test("approved Reference Set appearance is injected even for english-directed prompts", () => {
    const result = compilePanelConditioning({
      panel,
      basePrompt: "A character waits beside a train",
      entities: [entity],
      dialogueById: new Map(),
      narrativeMetadata: "english-directed",
      referenceAppearances: [{
        setId: "refset-1", characterId: entity.id, variantId: `${entity.id}:default`, modelFamily: "anima",
        version: 3, appearanceJa: "銀髪、青い目", appearancePromptEn: "short silver bob hair, vivid blue eyes, navy combat coat",
        mustNotChange: ["silver bob hair", "star-shaped left earring"], appearanceHash: "hash", images: []
      }]
    });
    expect(result.positive).toContain("short silver bob hair");
    expect(result.positive).toContain("star-shaped left earring");
    expect(result.positive).not.toContain("銀髪");
  });
});

describe("compileFigureConditioning (role: figure)", () => {
  test("figure slots compile to a solo full-body white-background prompt in both dialects", () => {
    const figurePanel = structuredClone(panel);
    (figurePanel as { role?: "figure" }).role = "figure";
    for (const dialect of ["tags", "natural"] as const) {
      const result = compilePanelConditioning({
        panel: figurePanel,
        basePrompt: "confident heroine introduction",
        entities: [entity],
        dialogueById: new Map(),
        narrativeMetadata: "english-directed",
        dialect,
        sceneBible: { set: "ruined lunar base", lighting: "harsh sunlight", palette: "grey and blue" }
      });
      expect(result.positive).toContain("solo");
      expect(result.positive).toContain("full body");
      expect(result.positive).toContain("white background");
      // シーンバイブルは立ち絵へ持ち込まない(背景は無地が前提)。
      expect(result.positive).not.toContain("ruined lunar base");
      expect(result.positive).not.toContain("visually quiet");
      expect(result.negative).toContain("scenery");
      // mustNotShow は negative へ移送されたまま。
      expect(result.negative).toContain("rain");
      expect(result.positive).not.toMatch(/[぀-ヿ㐀-鿿]/u);
    }
  });

  test("non-figure panels keep the scene conditioning path", () => {
    const result = compilePanelConditioning({
      panel,
      basePrompt: "a busy hangar",
      entities: [entity],
      dialogueById: new Map(),
      narrativeMetadata: "english-directed",
      dialect: "natural",
      sceneBible: { set: "ruined lunar base", lighting: "harsh sunlight", palette: "grey and blue" }
    });
    expect(result.positive).toContain("ruined lunar base");
    expect(result.positive).not.toContain("white background");
  });
});
