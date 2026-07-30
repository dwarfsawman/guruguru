import { createHash } from "node:crypto";
import type { FountainDoc, FountainElement } from "../shared/fountain";
import type {
  MangaBeat,
  NarrativeEntity,
  NarrativeGraph,
  SourceElementRef,
  WorldState
} from "../shared/mangaPlanV2";
import type { SceneBible } from "../shared/mangaPlanV2";
import { actionTextEstablishesVisibleActor } from "../shared/dialoguePresentation";

export interface StoryGraphCharacterInput {
  id: string;
  name: string;
  aliases: string[];
  notes: string;
  /** `Character.color` 由来のUI表示色(ネームポーズレイヤの色分け)。 */
  color?: string | null;
}

export interface StoryGraphDialogueInput {
  id: string;
  orderIndex: number;
  sceneIndex: number;
  characterId: string | null;
  speakerLabel: string;
  text: string;
  semanticKind: string;
  balloonStyle?: string;
}

export interface StoryGraphBuildResult {
  graph: NarrativeGraph;
  sourceIdBySceneElement: Map<string, string>;
  settingIdByScene: Map<number, string>;
  characterById: Map<string, StoryGraphCharacterInput>;
  characterIdsForText(text: string): string[];
  visibleCharacterIdsForActionText(text: string): string[];
  dialogueByOrder: Map<number, StoryGraphDialogueInput>;
}

function stableToken(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

/** Fountainだけから再現可能なシーン固定票。LLMが無くても同一sceneの全コマで同じ値になる。 */
export function deriveSceneBibles(doc: FountainDoc, scriptRevisionId: string): SceneBible[] {
  return doc.scenes.map((scene, sceneIndex) => {
    const settingId = `setting:${scriptRevisionId}:scene-${sceneIndex}`;
    const heading = (scene.heading || `Scene ${sceneIndex + 1}`).replace(/^(?:INT\.?|EXT\.?|I\/E\.?)\s*/iu, "").trim();
    const night = /(?:NIGHT|夜|深夜|夕)/iu.test(scene.heading);
    const day = /(?:DAY|昼|朝)/iu.test(scene.heading);
    return {
      settingId,
      // `set` は**場所**の記述に限る。以前はそのシーン最初の action 行の1文目を足していたが、
      // action 行は「The elderly woman in a dark apron and round glasses enters …」のように
      // 人物の外見と動作を書く。それをシーン全コマの prompt へ配ると、
      //  - そのコマに居ない人物の外見が混入する(実測: 単独コマの主人公に別人物の丸眼鏡が付いた)
      //  - 過去の一瞬が全コマへ重なる(実測: 人物が2体に複製された)
      // という壊れ方をする。蒸留モデル(CFG 1)では negative prompt が効かないため、
      // 混入した描写はそのまま絵に出る。人物名を書かない規約下では名前による除去も効かない。
      // コマ固有の視覚的事実は、そのコマ自身の action(basePrompt)から入るので重複は不要。
      set: heading.slice(0, 240),
      lighting: night ? "low-key night lighting with controlled practical lights" : day ? "consistent daylight with stable key direction" : "consistent cinematic lighting with stable key direction",
      // 既定の出力はモノクロ日本漫画なので、palette は色相ではなく階調で書く。
      // 以前は "deep blue and charcoal palette with restrained accent colors" のように
      // 色名を入れており、同じ prompt 内の "Japanese monochrome manga" と矛盾していた。
      // CFG を下げた蒸留モデル(Anima Turbo は CFG 1 が推奨)では negative prompt が
      // 効かないため、この矛盾がそのまま着色された絵になっていた。
      palette: night
        ? "high-contrast tonal range, deep blacks with sparse highlights"
        : day
          ? "bright tonal range, clean whites with light screentone"
          : "balanced tonal range with even screentone"
    };
  });
}

export function fountainSourceElementId(scriptRevisionId: string, sceneIndex: number, elementIndex: number): string {
  return `source:${scriptRevisionId}:scene-${sceneIndex}:element-${elementIndex}`;
}

function sourceText(element: FountainElement): string {
  if (element.type === "dialogue") return `${element.speaker}: ${element.text}`;
  return element.type === "section" ? element.text : element.text;
}

function normalizedLabels(character: StoryGraphCharacterInput): string[] {
  return [character.name, ...character.aliases]
    .map((label) => label.trim().toLocaleLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function includesLabel(haystack: string, label: string): boolean {
  if (!label) return false;
  if (/^[a-z0-9 _'-]+$/i.test(label)) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(haystack);
  }
  return haystack.includes(label);
}

function explicitEntities(doc: FountainDoc, scriptRevisionId: string): NarrativeEntity[] {
  const entities = new Map<string, NarrativeEntity>();
  const pattern = /\[\[(character|cast|prop|vehicle)\s*:\s*([^\]]+)\]\]/gi;
  for (const scene of doc.scenes) {
    for (const element of scene.elements) {
      if (element.type !== "action" && element.type !== "synopsis") continue;
      for (const match of element.text.matchAll(pattern)) {
        const rawKind = match[1]!.toLowerCase();
        const name = match[2]!.trim();
        if (!name) continue;
        const kind = rawKind === "prop" || rawKind === "vehicle" ? rawKind : "character";
        const key = `${kind}:${name.toLocaleLowerCase()}`;
        if (entities.has(key)) continue;
        const id = `entity:${scriptRevisionId}:${kind}:${stableToken(key)}`;
        entities.set(key, {
          id,
          kind,
          name,
          aliases: [],
          attributes: { source: "explicit-fountain-tag" },
          variants: [{ id: `${id}:default`, label: "default", attributes: {} }]
        });
      }
    }
  }
  return [...entities.values()];
}

/**
 * Builds the revision-frozen entity/source layer. It resolves known Character aliases in action
 * prose and supports explicit `[[character: Name]]` / `[[prop: Object]]` tags for silent entities.
 * Ambiguous natural-language pronouns are retained as warnings instead of being guessed.
 */
export function buildStoryGraph(input: {
  doc: FountainDoc;
  scriptRevisionId: string;
  characters: StoryGraphCharacterInput[];
  dialogues: StoryGraphDialogueInput[];
  /**
   * 舞台の**英語**の見た目記述(scene index → 記述)。プロンプトの背景句になる。
   *
   * 脚本の見出しは作品言語(日本語など)で書かれるため、それだけではタグ方言モデルへ
   * 渡せる背景記述が無く、生成が「人物だけ・背景は白紙」になる。白紙の余白があると
   * モデルは被写体を複製して埋めるので、背景の宣言先が必要になる
   * (Character Garage の storyBible.settings[].description が正本で、
   *  production packet 経由で渡ってくる)。
   */
  settingDescriptions?: Record<number, string>;
}): StoryGraphBuildResult {
  const { doc, scriptRevisionId, characters, dialogues } = input;
  const sourceElements: SourceElementRef[] = [];
  const sourceIdBySceneElement = new Map<string, string>();
  doc.scenes.forEach((scene, sceneIndex) => {
    scene.elements.forEach((element, elementIndex) => {
      const id = fountainSourceElementId(scriptRevisionId, sceneIndex, elementIndex);
      sourceIdBySceneElement.set(`${sceneIndex}:${elementIndex}`, id);
      sourceElements.push({
        id,
        sceneIndex,
        elementIndex,
        type: element.type,
        text: sourceText(element),
        omissionReason:
          element.type === "section" || element.type === "transition"
            ? "structural Fountain element; represented by page/scene ordering"
            : undefined
      });
    });
  });

  const characterEntities: NarrativeEntity[] = characters.map((character) => {
    const attributes: Record<string, string> = {};
    if (character.notes.trim()) attributes.description = character.notes.trim();
    return {
      id: character.id,
      kind: "character",
      name: character.name,
      aliases: [...character.aliases],
      attributes,
      variants: [{ id: `${character.id}:default`, label: "default", attributes: {} }],
      ...(character.color ? { color: character.color } : {})
    };
  });
  const taggedEntities = explicitEntities(doc, scriptRevisionId).filter(
    (entity) =>
      entity.kind !== "character" ||
      !characters.some((character) => normalizedLabels(character).some((label) => label === entity.name.toLocaleLowerCase()))
  );
  const settingIdByScene = new Map<number, string>();
  const settingEntities = doc.scenes.map((scene, sceneIndex) => {
    const id = `setting:${scriptRevisionId}:scene-${sceneIndex}`;
    settingIdByScene.set(sceneIndex, id);
    return {
      id,
      kind: "setting" as const,
      name: scene.heading || `Scene ${sceneIndex + 1}`,
      aliases: [],
      attributes: {
        heading: scene.heading,
        ...(input.settingDescriptions?.[sceneIndex]?.trim()
          ? { description: input.settingDescriptions[sceneIndex]!.trim() }
          : {})
      },
      variants: [{ id: `${id}:default`, label: "default", attributes: {} }]
    };
  });
  const sceneBibles = deriveSceneBibles(doc, scriptRevisionId);
  const bibleBySetting = new Map(sceneBibles.map((bible) => [bible.settingId, bible]));
  for (const entity of settingEntities) {
    const bible = bibleBySetting.get(entity.id);
    if (bible) Object.assign(entity.attributes, { set: bible.set, lighting: bible.lighting, palette: bible.palette });
  }

  const characterById = new Map(characters.map((character) => [character.id, character]));
  for (const entity of taggedEntities) {
    if (entity.kind === "character") {
      characterById.set(entity.id, { id: entity.id, name: entity.name, aliases: entity.aliases, notes: "" });
    }
  }
  const labelIndex = [...characterById.values()].map((character) => ({ character, labels: normalizedLabels(character) }));
  const characterIdsForText = (text: string): string[] => {
    const normalized = text.toLocaleLowerCase();
    return labelIndex
      .filter(({ labels }) => labels.some((label) => includesLabel(normalized, label)))
      .map(({ character }) => character.id);
  };
  const visibleCharacterIdsForActionText = (text: string): string[] => labelIndex
    .filter(({ labels }) => actionTextEstablishesVisibleActor(text, labels))
    .map(({ character }) => character.id);

  const warnings: NarrativeGraph["warnings"] = [];
  const japaneseGenericMention = /(?:^|[\s「『(（])(?:彼女|彼|少年|少女|男|女)(?=$|[はがをにのへともでや、。！？\s」』)）])/;
  const englishPronoun = /\b(?:he|she|they)\b/i;
  for (const source of sourceElements) {
    if (source.type !== "action" && source.type !== "synopsis") continue;
    if ((japaneseGenericMention.test(source.text) || englishPronoun.test(source.text)) && characterIdsForText(source.text).length === 0) {
      warnings.push({
        code: "unresolved-mention",
        message: `Pronoun or generic character mention requires confirmation: ${source.text.slice(0, 80)}`,
        sourceElementId: source.id
      });
    }
  }

  return {
    graph: {
      sourceElements,
      entities: [...characterEntities, ...taggedEntities, ...settingEntities],
      worldStates: [] as WorldState[],
      sceneBibles,
      beats: [] as MangaBeat[],
      warnings
    },
    sourceIdBySceneElement,
    settingIdByScene,
    characterById,
    characterIdsForText,
    visibleCharacterIdsForActionText,
    dialogueByOrder: new Map(dialogues.map((dialogue) => [dialogue.orderIndex, dialogue]))
  };
}
