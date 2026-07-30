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
    // 余白の要求は「文字を置く場所」ではなく「detail を置かない領域」として言う
    // (positive に lettering / speech と書くと CFG 1 では偽文字を描かせる)。
    expect(result).toContain("keep upper-right region free of detail");
    expect(result).not.toContain("lettering");
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

  test("an action-grounded visible character may also carry V.O. without a contradictory absence instruction", () => {
    const voPanel = structuredClone(panel);
    voPanel.cast[0]!.speakingLineIds = ["line-vo"];
    const result = compilePanelPrompt({
      panel: voPanel,
      basePrompt: "Akari stands at the window and watches the rain",
      entities: [entity],
      dialogueById: new Map([["line-vo", {
        id: "line-vo", orderIndex: 0, sceneIndex: 0, characterId: entity.id,
        speakerLabel: "Akari (V.O.)", text: "I remember that night.", semanticKind: "dialogue", balloonStyle: "vo"
      }]]),
      narrativeMetadata: "append"
    });

    expect(result).toContain("voice-over delivered separately from the depicted action");
    expect(result).not.toContain("speaker is not depicted");
    expect(result).toContain("あかり");
  });

  test("v3 moves avoid facts to negative conditioning and injects identity tags", () => {
    const englishEntity = { ...entity, attributes: { tags: "short silver hair, blue eyes, black jacket" } };
    const result = compilePanelConditioning({ panel, basePrompt: "damaged cockpit", entities: [englishEntity], dialogueById: new Map(), dialect: "tags" });
    expect(result.positive).toContain("short silver hair");
    expect(result.positive).not.toContain("rain");
    expect(result.negative).toContain("rain");
  });

  test("multi-character panels bind each appearance to that character's region", () => {
    // 実測: 老人と若者が同居するコマの 4/4 で、老人の丸眼鏡が若者の顔に付いた。
    // 外見句が平坦に連結され、どの特徴が誰のものか判別できないため。
    const elder = { id: "character-toyo", kind: "character", name: "Toyo", aliases: [],
      attributes: { tags: "elderly woman, round glasses, dark bib apron" }, variants: [] } as unknown as NarrativeEntity;
    const young = { id: "character-haru", kind: "character", name: "Haru", aliases: [],
      attributes: { tags: "young woman, paint-stained overalls" }, variants: [] } as unknown as NarrativeEntity;
    const two = { ...panel, cast: [
      { characterId: young.id, variantId: young.id + ":default", bbox: { x: 0.05, y: 0.1, width: 0.35, height: 0.8 },
        pose: "standing", expression: "neutral", action: "holding a pail", speakingLineIds: [] },
      { characterId: elder.id, variantId: elder.id + ":default", bbox: { x: 0.6, y: 0.1, width: 0.35, height: 0.8 },
        pose: "standing", expression: "neutral", action: "pointing", speakingLineIds: [] }
    ] } as unknown as PanelSpec;
    const result = compilePanelConditioning({
      panel: two, basePrompt: "a bathhouse", entities: [elder, young],
      dialogueById: new Map(), dialect: "tags"
    });
    // 各人物の外見はカンマ分割を跨がない1語にまとまり、領域名を伴う
    const bound = result.positive.split(/\s*,\s*/).filter((term) => /in the .*region/.test(term));
    expect(bound.length).toBe(2);
    const elderTerm = bound.find((term) => /elderly woman/.test(term)) ?? "";
    const youngTerm = bound.find((term) => /young woman/.test(term)) ?? "";
    expect(elderTerm).toMatch(/round glasses/);
    expect(youngTerm).not.toMatch(/round glasses/);
    expect(youngTerm).toMatch(/paint-stained overalls/);
    expect(elderTerm).not.toMatch(/paint-stained overalls/);
    // 左右が取り違えられていない
    expect(youngTerm).toMatch(/left/);
    expect(elderTerm).toMatch(/right/);
  });

  test("single-character panels keep the flat appearance form", () => {
    const englishEntity = { ...entity, attributes: { tags: "short silver hair, blue eyes" } };
    const result = compilePanelConditioning({ panel, basePrompt: "cockpit", entities: [englishEntity], dialogueById: new Map(), dialect: "tags" });
    expect(result.positive).not.toMatch(/in the .*region/);
  });

  test("background detail scales with shot size so close-ups do not inherit the whole room", () => {
    // 実測: 壁際で刷毛を止める手のクローズアップに部屋の目録が丸ごと入り、
    // 4候補とも洗い場の引きの絵になって指定の動作が消えた。
    const setting = { id: "setting-bath", kind: "setting", name: "bath", aliases: [],
      attributes: { tags: "tiled floor, row of washing stations with mirrors and taps, deep tub, painted wall mural" },
      variants: [] } as unknown as NarrativeEntity;
    const forSize = (size: string) => compilePanelConditioning({
      panel: { ...panel, cast: [], settingId: setting.id, shot: { ...(panel as any).shot, size } } as unknown as PanelSpec,
      basePrompt: "a hand at the wall", entities: [setting], dialogueById: new Map(), dialect: "tags"
    }).positive;
    const closeUp = forSize("close-up");
    expect(closeUp).toMatch(/tiled floor/);
    expect(closeUp).not.toMatch(/washing stations/);
    expect(closeUp).not.toMatch(/painted wall mural/);
    expect(forSize("medium")).toMatch(/deep tub/);
    expect(forSize("medium")).not.toMatch(/painted wall mural/);
    // 引きのコマは従来どおり舞台の記述を丸ごと使う
    expect(forSize("wide")).toMatch(/painted wall mural/);
    // どの寄りでも背景が空になってはいけない(白紙は人物の複製を招く)
    expect(closeUp).toMatch(/no empty background/);
  });

  test("monochrome styles neutralize colour-implying material words and add a colour negative", () => {
    // 実測: 脚本の "a brass tap" がそのまま通り、生成では蛇口だけが金色になって
    // 該当コマの全候補が不合格になった。色名を避けるだけでは足りず、素材名も色を含意する。
    const result = compilePanelConditioning({
      panel: { ...panel, cast: [], promptBase: "a brass tap over a rusty blue basin" },
      basePrompt: "Japanese monochrome manga, ink line art. a brass tap over a rusty blue basin",
      entities: [], dialogueById: new Map(), dialect: "tags"
    });
    expect(result.positive).not.toMatch(/\bbrass\b/);
    expect(result.positive).not.toMatch(/\bblue\b/);
    expect(result.positive).not.toMatch(/\brusty\b/);
    expect(result.positive).toMatch(/metal/);
    expect(result.positive).toMatch(/corroded/);
    expect(result.positive).not.toMatch(/(?:,\s*){2,}/);
    expect(result.negative).toContain("color");
  });

  test("colour styles keep colour words untouched", () => {
    const result = compilePanelConditioning({
      panel: { ...panel, cast: [], promptBase: "a brass tap over a blue basin" },
      basePrompt: "full color illustration. a brass tap over a blue basin",
      entities: [], dialogueById: new Map(), dialect: "tags"
    });
    expect(result.positive).toMatch(/\bbrass\b/);
    expect(result.positive).toMatch(/\bblue\b/);
  });

  test("tags dialect preserves untranslated source-language visual facts and does not invent characters for an empty cast", () => {
    const empty = { ...panel, cast: [], promptBase: "漆黒の宇宙。砕けた人工衛星。白い人型機動兵器。" };
    const result = compilePanelConditioning({ panel: empty, basePrompt: empty.promptBase, entities: [], dialogueById: new Map(), dialect: "tags" });
    expect(result.positive).toMatch(/漆黒の宇宙/);
    expect(result.positive).toMatch(/砕けた人工衛星/);
    expect(result.positive).toMatch(/白い人型機動兵器/);
    expect(result.positive).not.toMatch(/0characters/);
  });

  test("both dialects retain non-SF visual facts and never expand Japanese names into genre tags", () => {
    const period = { ...panel, cast: [], promptBase: "江戸時代の茶屋で侍が刀を抜く。雨宮と月城と夜神が見守る。" };
    for (const dialect of ["natural", "tags"] as const) {
      const result = compilePanelConditioning({ panel: period, basePrompt: period.promptBase, entities: [], dialogueById: new Map(), dialect });
      expect(result.positive).toMatch(/江戸時代の茶屋/);
      expect(result.positive).toMatch(/侍が刀を抜く/);
      expect(result.positive).toMatch(/雨宮と月城と夜神/);
      expect(result.positive).not.toMatch(/\brain\b|\bmoon\b|\bnight\b|satellite|mecha|futuristic/iu);
    }
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

describe("background grounding", () => {
  test("人物だけで背景が白紙にならないよう settingId から背景句を足す", () => {
    // 人物だけを指定して背景が白紙だと、モデルは余白を埋めるために被写体を複製する
    // (実測: クローズアップが続くキャラのコマで 12/12 が「同一人物を並べた設定表」になり、
    //  背景句を1つ足しただけで単独に戻った)。
    const withSetting = structuredClone(panel);
    (withSetting as { settingId?: string }).settingId = "setting-bath";
    const settingEntity = {
      id: "setting-bath", kind: "setting", name: "bath", aliases: [],
      attributes: { description: "old japanese public bath, tiled walls, deep rectangular tub" },
      variants: []
    } as unknown as NarrativeEntity;
    const result = compilePanelConditioning({
      panel: withSetting,
      basePrompt: "Close on her face",
      entities: [entity, settingEntity],
      dialogueById: new Map(),
      dialect: "tags"
    });
    expect(result.positive).toContain("filling the background");
    expect(result.positive).toContain("tiled walls");
    expect(result.positive).toContain("no empty background");
  });

  test("舞台の記述が日本語/未設定なら中立の背景句へ落とす", () => {
    const withSetting = structuredClone(panel);
    (withSetting as { settingId?: string }).settingId = "setting-ja";
    const settingEntity = {
      id: "setting-ja", kind: "setting", name: "浴室", aliases: [],
      attributes: { description: "鶴の湯 浴室" }, variants: []
    } as unknown as NarrativeEntity;
    const result = compilePanelConditioning({
      panel: withSetting,
      basePrompt: "A brass tap drips",
      entities: [entity, settingEntity],
      dialogueById: new Map(),
      dialect: "tags"
    });
    // 日本語の記述はタグ方言モデルへ渡さない(既存規約)。中立句で余白だけ潰す。
    expect(result.positive).toContain("detailed background filling the frame");
  });
});
