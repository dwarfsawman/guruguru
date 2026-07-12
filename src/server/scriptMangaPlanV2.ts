import type { FountainDoc } from "../shared/fountain";
import {
  MANGA_PLAN_VERSION,
  MANGA_PLANNER_VERSION,
  PANEL_PROMPT_COMPILER_VERSION,
  type DialoguePolicy,
  type MangaBeat,
  type MangaPlanV2,
  type MangaShotSize,
  type NormalizedBox,
  type PanelCastSpec,
  type PanelSpec,
  type StateDelta,
  type WorldState
} from "../shared/mangaPlanV2";
import type { ScriptMangaPanelPlan, ScriptMangaPlan } from "../shared/scriptMangaPlan";
import type { PageLayout } from "../shared/pageLayout";
import type { StyleLoraSelection } from "../shared/types";
import { compilePanelPrompt } from "./panelPromptCompiler";
import { resolvePanelReferences } from "./referenceResolver";
import {
  buildStoryGraph,
  fountainSourceElementId,
  type StoryGraphCharacterInput,
  type StoryGraphDialogueInput
} from "./storyGraphBuilder";

interface DirectedPanelFields {
  shot?: string;
  angle?: string;
  subject?: string;
  subjects?: Array<{ ref: string; position: string; action: string; expression: string; gaze?: string }>;
  avoid?: string[];
  action?: string;
  emotion?: string;
  composition?: string;
}

function positionBox(position: string): NormalizedBox {
  const [vertical = "middle", horizontal = "center"] = position.split("-");
  const width = 0.3;
  const height = 0.42;
  return {
    x: horizontal === "left" ? 0.04 : horizontal === "right" ? 0.66 : 0.35,
    y: vertical === "upper" ? 0.04 : vertical === "lower" ? 0.54 : 0.29,
    width,
    height
  };
}

function panelDirection(panel: ScriptMangaPanelPlan): DirectedPanelFields {
  const value = (panel as ScriptMangaPanelPlan & { direction?: DirectedPanelFields }).direction;
  return value ?? {};
}

function pageIntent(page: ScriptMangaPlan["pages"][number]): string {
  return (page as ScriptMangaPlan["pages"][number] & { pageIntent?: string }).pageIntent?.trim() || "clear right-to-left progression";
}

function legacySourceIds(panel: ScriptMangaPanelPlan, scriptRevisionId: string): string[] {
  const ids = (panel as ScriptMangaPanelPlan & { sourceElementIds?: string[] }).sourceElementIds ?? [];
  return ids.map((id) => {
    const match = /^scene-(\d+)-element-(\d+)$/.exec(id);
    return match ? fountainSourceElementId(scriptRevisionId, Number(match[1]), Number(match[2])) : id;
  });
}

function shotSize(value: string | undefined): MangaShotSize {
  const normalized = value?.toLocaleLowerCase() ?? "";
  if (normalized.includes("extreme") && normalized.includes("wide")) return "extreme-wide";
  if (normalized.includes("close") || normalized.includes("portrait")) return "close-up";
  if (normalized.includes("insert") || normalized.includes("detail")) return "insert";
  if (normalized.includes("wide") || normalized.includes("establish")) return "wide";
  return "medium";
}

function castBoxes(count: number): NormalizedBox[] {
  if (count <= 1) return [{ x: 0.14, y: 0.18, width: 0.72, height: 0.78 }];
  if (count === 2) {
    return [
      { x: 0.54, y: 0.2, width: 0.42, height: 0.76 },
      { x: 0.04, y: 0.2, width: 0.42, height: 0.76 }
    ];
  }
  const gap = 0.025;
  const width = (0.94 - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, index) => ({
    x: 0.03 + (count - 1 - index) * (width + gap),
    y: 0.25,
    width,
    height: 0.7
  }));
}

function provisionalSafeZones(dialogueCount: number): NormalizedBox[] {
  if (dialogueCount <= 0) return [];
  if (dialogueCount === 1) return [{ x: 0.64, y: 0.03, width: 0.32, height: 0.3 }];
  return [
    { x: 0.66, y: 0.03, width: 0.31, height: 0.31 },
    { x: 0.03, y: 0.03, width: 0.31, height: 0.31 }
  ];
}

function defaultCharacterState(characterId: string): WorldState["characterStates"][string] {
  return {
    variantId: `${characterId}:default`,
    location: "in frame",
    outfit: "default continuity outfit",
    heldEntityIds: [],
    pose: "natural",
    emotion: "neutral"
  };
}

function cloneCharacterStates(states: WorldState["characterStates"]): WorldState["characterStates"] {
  return Object.fromEntries(
    Object.entries(states).map(([id, state]) => [id, { ...state, heldEntityIds: [...state.heldEntityIds] }])
  );
}

function findFocalSubject(subject: string | undefined, cast: PanelCastSpec[], characters: StoryGraphCharacterInput[], settingId: string): string {
  const normalized = subject?.trim().toLocaleLowerCase() ?? "";
  if (normalized) {
    const match = characters.find((character) =>
      [character.name, ...character.aliases].some((label) => normalized.includes(label.trim().toLocaleLowerCase()))
    );
    if (match && cast.some((member) => member.characterId === match.id)) return match.id;
  }
  return cast[0]?.characterId ?? settingId;
}

function inferSourceIds(
  panel: ScriptMangaPanelPlan,
  scriptRevisionId: string,
  sourceElements: ReturnType<typeof buildStoryGraph>["graph"]["sourceElements"]
): string[] {
  const explicit = legacySourceIds(panel, scriptRevisionId);
  if (explicit.length > 0) return explicit;
  const candidates = sourceElements.filter(
    (source) =>
      source.sceneIndex === panel.sceneIndex &&
      !source.omissionReason &&
      (panel.sourceText.includes(source.text) || source.text.split("\n").some((line) => line && panel.sourceText.includes(line)))
  );
  return candidates.length > 0
    ? candidates.map((source) => source.id)
    : [fountainSourceElementId(scriptRevisionId, panel.sceneIndex, 0)];
}

function stripDialogueWording(prompt: string, lines: StoryGraphDialogueInput[]): string {
  let out = prompt;
  for (const line of lines) {
    if (line.text.trim()) out = out.replaceAll(line.text.trim(), "");
  }
  return out.replace(/\s+/g, " ").trim();
}

export function buildMangaPlanV2(input: {
  id: string;
  projectId: string;
  scriptId: string;
  scriptRevisionId: string;
  doc: FountainDoc;
  legacyPlan: ScriptMangaPlan;
  characters: StoryGraphCharacterInput[];
  dialogues: StoryGraphDialogueInput[];
  providerId: string;
  globalLoras: StyleLoraSelection[];
  dialoguePolicy: DialoguePolicy;
  resolveLayoutTemplate: (layoutTemplateId: string) => PageLayout | null;
}): MangaPlanV2 {
  const story = buildStoryGraph({
    doc: input.doc,
    scriptRevisionId: input.scriptRevisionId,
    characters: input.characters,
    dialogues: input.dialogues
  });
  const dialogueById = new Map(input.dialogues.map((line) => [line.id, line]));
  const activeCharacterStates: WorldState["characterStates"] = {};
  const beats: MangaBeat[] = [];
  const worldStates: WorldState[] = [];
  const sourceDialogueLineIds = new Set<string>();
  let previousPanelId: string | null = null;
  let previousSummary = "";
  let flatPanelIndex = 0;

  const pages = input.legacyPlan.pages.map((page) => {
    const resolvedLayout = input.resolveLayoutTemplate(page.layoutTemplateId);
    if (!resolvedLayout) throw new Error(`Layout template could not be resolved: ${page.layoutTemplateId}`);
    const layoutSnapshot = JSON.parse(JSON.stringify(resolvedLayout)) as PageLayout;
    return {
      index: page.index,
      title: page.title,
      layoutTemplateId: page.layoutTemplateId,
      layoutSnapshot,
      pageIntent: pageIntent(page),
      panels: page.panels.map((legacyPanel): PanelSpec => {
      const direction = panelDirection(legacyPanel);
      const dialogueLines = legacyPanel.dialogueOrderIndexes
        .map((order) => story.dialogueByOrder.get(order))
        .filter((line): line is StoryGraphDialogueInput => Boolean(line));
      dialogueLines.forEach((line) => sourceDialogueLineIds.add(line.id));
      const characterIds = [
        ...dialogueLines.map((line) => line.characterId).filter((id): id is string => Boolean(id)),
        ...story.characterIdsForText(legacyPanel.sourceText)
      ].filter((id, index, all) => all.indexOf(id) === index);
      const boxes = castBoxes(Math.max(1, characterIds.length));
      const cast: PanelCastSpec[] = characterIds.map((characterId, index) => {
        const character = story.characterById.get(characterId);
        const directedSubject = direction.subjects?.find((subject) =>
          [character?.name, ...(character?.aliases ?? [])].some((name) => name === subject.ref)
        );
        const speakingLineIds = dialogueLines.filter((line) => line.characterId === characterId).map((line) => line.id);
        return {
          characterId,
          variantId: `${characterId}:default`,
          bbox: directedSubject ? positionBox(directedSubject.position) : boxes[index]!,
          pose: directedSubject?.action || direction.action || "natural storytelling pose",
          gazeTarget: directedSubject?.gaze,
          expression: directedSubject?.expression || direction.emotion?.trim() || (speakingLineIds.length > 0 ? "engaged" : "observant"),
          action: directedSubject?.action || direction.action?.trim() || (speakingLineIds.length > 0 ? "speaking" : "participating in the depicted action"),
          speakingLineIds
        };
      });
      const settingId = story.settingIdByScene.get(legacyPanel.sceneIndex) ?? `setting:${input.scriptRevisionId}:scene-${legacyPanel.sceneIndex}`;
      const focalSubjectId = findFocalSubject(direction.subject, cast, [...story.characterById.values()], settingId);
      const sourceElementIds = inferSourceIds(legacyPanel, input.scriptRevisionId, story.graph.sourceElements);
      const beatId = `beat:${input.id}:${flatPanelIndex}`;
      const action = direction.action?.trim() || legacyPanel.sourceText.split("\n").find((line) => !line.includes(":")) || "visual story beat";
      const beat: MangaBeat = {
        id: beatId,
        sourceElementIds,
        cause: previousSummary || "scene setup",
        action,
        result: direction.composition?.trim() || "state shown in the next panel",
        emotionChange: direction.emotion?.trim() || "",
        mustShow: [...cast.map((member) => `character ${member.characterId}`), action],
        dialogueOnly: dialogueLines.map((line) => line.semanticKind)
      };
      beats.push(beat);

      for (const member of cast) {
        activeCharacterStates[member.characterId] ??= defaultCharacterState(member.characterId);
      }
      const preStateId = `state:${input.id}:panel-${flatPanelIndex}:pre`;
      worldStates.push({
        id: preStateId,
        settingId,
        characterStates: cloneCharacterStates(activeCharacterStates),
        propStates: {},
        time: "",
        weather: "",
        lighting: "",
        spatialNotes: []
      });
      const deltaCharacterStates: NonNullable<StateDelta["characterStates"]> = {};
      for (const member of cast) {
        deltaCharacterStates[member.characterId] = {
          pose: member.pose || member.action,
          emotion: member.expression,
          location: "in frame"
        };
        activeCharacterStates[member.characterId] = {
          ...activeCharacterStates[member.characterId]!,
          ...deltaCharacterStates[member.characterId]
        };
      }
      const postStateDelta: StateDelta = {
        settingId,
        characterStates: deltaCharacterStates,
        notes: [action]
      };
      const props = story.graph.entities
        .filter((entity) => (entity.kind === "prop" || entity.kind === "vehicle") && legacyPanel.sourceText.includes(entity.name))
        .map((entity) => ({ entityId: entity.id, state: "present" }));
      const promptBase = stripDialogueWording(legacyPanel.prompt, dialogueLines);
      const provisional: PanelSpec = {
        id: legacyPanel.id,
        sourceElementIds,
        beatIds: [beatId],
        preStateId,
        postStateDelta,
        settingId,
        cast,
        props,
        shot: {
          size: shotSize(direction.shot),
          angle: direction.angle?.trim() || direction.shot?.trim() || "eye-level",
          focalSubjectId,
          compositionIntent: direction.composition?.trim() || "single clear action with readable silhouettes"
        },
        dialogueLineIds: dialogueLines.map((line) => line.id),
        dialogueOrderIndexes: [...legacyPanel.dialogueOrderIndexes],
        textSafeZones: provisionalSafeZones(dialogueLines.length),
        mustShow: [
          ...cast.map((member) => ({ kind: "entity-present" as const, entityId: member.characterId, description: `show ${member.characterId}` })),
          ...props.map((prop) => ({ kind: "entity-present" as const, entityId: prop.entityId, description: `show ${prop.entityId}` })),
          { kind: "action", description: action }
        ],
        mustNotShow: [
          { kind: "other", description: "generated text, letters, captions, speech bubbles, logos or watermarks" },
          ...(direction.avoid ?? []).map((description) => ({ kind: "other" as const, description }))
        ],
        continuityFromPanelIds: previousPanelId ? [previousPanelId] : [],
        referenceManifest: [],
        sceneIndex: legacyPanel.sceneIndex,
        sceneHeading: legacyPanel.sceneHeading,
        sourceText: legacyPanel.sourceText,
        promptBase,
        compiledPrompt: ""
      };
      const references = resolvePanelReferences({
        projectId: input.projectId,
        providerId: input.providerId,
        cast,
        focalSubjectId,
        globalLoras: input.globalLoras
      });
      provisional.referenceManifest = references.manifest;
      provisional.compiledPrompt = compilePanelPrompt({
        panel: provisional,
        basePrompt: promptBase,
        entities: story.graph.entities,
        dialogueById,
        narrativeMetadata: input.legacyPlan.plannerProvenance?.kind === "llm-director" ? "english-directed" : "append"
      });
      for (const member of cast) {
        if (!references.manifest.some((reference) => reference.entityId === member.characterId)) {
          story.graph.warnings.push({
            code: "missing-reference",
            message: `No ${input.providerId} appearance binding for character ${member.characterId}`,
            sourceElementId: sourceElementIds[0]
          });
        }
      }
      previousPanelId = provisional.id;
      previousSummary = action;
      flatPanelIndex += 1;
        return provisional;
      })
    };
  });

  story.graph.beats = beats;
  story.graph.worldStates = worldStates;
  return {
    version: MANGA_PLAN_VERSION,
    id: input.id,
    title: input.legacyPlan.title,
    scriptId: input.scriptId,
    scriptRevisionId: input.scriptRevisionId,
    dialoguePolicy: input.dialoguePolicy,
    plannerVersion: MANGA_PLANNER_VERSION,
    promptCompilerVersion: PANEL_PROMPT_COMPILER_VERSION,
    plannerProvenance: input.legacyPlan.plannerProvenance,
    narrativeGraph: story.graph,
    sourceDialogueLineIds: [...sourceDialogueLineIds],
    dialogueSnapshots: input.dialogues
      .filter((line) => sourceDialogueLineIds.has(line.id))
      .map((line) => ({
        id: line.id,
        orderIndex: line.orderIndex,
        sceneIndex: line.sceneIndex,
        characterId: line.characterId,
        speakerLabel: line.speakerLabel,
        text: line.text,
        semanticKind: line.semanticKind
      })),
    pages,
    panelCount: pages.reduce((sum, page) => sum + page.panels.length, 0),
    dialogueCount: sourceDialogueLineIds.size,
    createdAt: new Date().toISOString()
  };
}
