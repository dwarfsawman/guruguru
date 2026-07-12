import { createHash } from "node:crypto";
import type { FountainDoc, FountainElement } from "../shared/fountain";
import type {
  MangaBeat,
  NarrativeEntity,
  NarrativeGraph,
  SourceElementRef,
  WorldState
} from "../shared/mangaPlanV2";

export interface StoryGraphCharacterInput {
  id: string;
  name: string;
  aliases: string[];
  notes: string;
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
  dialogueByOrder: Map<number, StoryGraphDialogueInput>;
}

function stableToken(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
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
      variants: [{ id: `${character.id}:default`, label: "default", attributes: {} }]
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
      attributes: { heading: scene.heading },
      variants: [{ id: `${id}:default`, label: "default", attributes: {} }]
    };
  });

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
      beats: [] as MangaBeat[],
      warnings
    },
    sourceIdBySceneElement,
    settingIdByScene,
    characterById,
    characterIdsForText,
    dialogueByOrder: new Map(dialogues.map((dialogue) => [dialogue.orderIndex, dialogue]))
  };
}
