import type { ArtifactRef } from "./generationIntent";
import type { PageLayout } from "./pageLayout";

export const MANGA_PLAN_VERSION = 2 as const;
export const MANGA_PLANNER_VERSION = "manga-plan-v2.1";
export const PANEL_PROMPT_COMPILER_VERSION = "panel-prompt-v2.2";

export type DialoguePolicy = "preserve" | "adapt" | "fill" | "generate";
export type NarrativeEntityKind = "character" | "setting" | "prop" | "vehicle" | "unknown";
export type MangaShotSize = "extreme-wide" | "wide" | "medium" | "close-up" | "insert";
export type MangaReferenceRole = "identity" | "outfit" | "pose" | "background" | "prop" | "style";

/** Panel-local normalized coordinates. All values are in the inclusive 0..1 range. */
export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceElementRef {
  id: string;
  sceneIndex: number;
  elementIndex: number;
  type: "action" | "dialogue" | "transition" | "section" | "synopsis";
  text: string;
  /** Non-visual Fountain elements remain traceable even when they are intentionally not assigned to a panel. */
  omissionReason?: string;
}

export interface NarrativeEntityVariant {
  id: string;
  label: string;
  attributes: Record<string, string>;
}

export interface NarrativeEntity {
  id: string;
  kind: NarrativeEntityKind;
  name: string;
  aliases: string[];
  attributes: Record<string, string>;
  variants: NarrativeEntityVariant[];
}

export interface CharacterWorldState {
  variantId: string;
  location: string;
  outfit: string;
  heldEntityIds: string[];
  pose: string;
  emotion: string;
}

export interface PropWorldState {
  ownerEntityId?: string;
  state: string;
  present: boolean;
}

export interface WorldState {
  id: string;
  settingId: string;
  characterStates: Record<string, CharacterWorldState>;
  propStates: Record<string, PropWorldState>;
  time: string;
  weather: string;
  lighting: string;
  spatialNotes: string[];
}

export interface StateDelta {
  settingId?: string;
  characterStates?: Record<string, Partial<CharacterWorldState>>;
  propStates?: Record<string, Partial<PropWorldState>>;
  time?: string;
  weather?: string;
  lighting?: string;
  notes: string[];
}

export interface MangaBeat {
  id: string;
  sourceElementIds: string[];
  cause: string;
  action: string;
  result: string;
  emotionChange: string;
  mustShow: string[];
  dialogueOnly: string[];
}

export interface MangaConstraint {
  kind:
    | "entity-present"
    | "entity-absent"
    | "state"
    | "action"
    | "composition"
    | "lettering-safe-zone"
    | "continuity"
    | "other";
  description: string;
  entityId?: string;
}

export type MangaReferenceArtifact =
  | ArtifactRef
  | { kind: "providerResource"; providerId: string; resourceType: "lora"; id: string };

export interface ReferenceSpec {
  entityId: string;
  variantId: string;
  artifact: MangaReferenceArtifact;
  targetRegion?: NormalizedBox;
  role: MangaReferenceRole;
  strength: number;
}

export interface PanelCastSpec {
  characterId: string;
  variantId: string;
  bbox: NormalizedBox;
  pose?: string;
  gazeTarget?: string;
  expression: string;
  action: string;
  speakingLineIds: string[];
}

export interface PanelPropSpec {
  entityId: string;
  state: string;
  bbox?: NormalizedBox;
}

export interface PanelSpec {
  id: string;
  sourceElementIds: string[];
  beatIds: string[];
  preStateId: string;
  postStateDelta: StateDelta;
  settingId: string;
  cast: PanelCastSpec[];
  props: PanelPropSpec[];
  shot: {
    size: MangaShotSize;
    angle: string;
    focalSubjectId: string;
    compositionIntent: string;
  };
  dialogueLineIds: string[];
  /** Kept for deterministic mapping to the current dialogue_lines ordering. */
  dialogueOrderIndexes: number[];
  textSafeZones: NormalizedBox[];
  mustShow: MangaConstraint[];
  mustNotShow: MangaConstraint[];
  continuityFromPanelIds: string[];
  referenceManifest: ReferenceSpec[];
  sceneIndex: number;
  sceneHeading: string;
  sourceText: string;
  /** Planner-authored visual prompt before deterministic entity/geometry compilation. */
  promptBase: string;
  /** Prompt compiled from this structure. Dialogue text itself is intentionally excluded. */
  compiledPrompt: string;
}

export interface MangaPageSpec {
  index: number;
  title: string;
  layoutTemplateId: string;
  /** Immutable geometry captured when the plan is created; execution never re-resolves a mutable template. */
  layoutSnapshot: PageLayout;
  pageIntent: string;
  panels: PanelSpec[];
}

export interface FrozenDialogueLine {
  id: string;
  orderIndex: number;
  sceneIndex: number;
  characterId: string | null;
  speakerLabel: string;
  text: string;
  semanticKind: string;
}

export interface NarrativeGraph {
  sourceElements: SourceElementRef[];
  entities: NarrativeEntity[];
  worldStates: WorldState[];
  beats: MangaBeat[];
  warnings: Array<{
    code: "unresolved-mention" | "ambiguous-mention" | "missing-reference" | "state-gap" | "other";
    message: string;
    sourceElementId?: string;
  }>;
}

export interface MangaPlanV2 {
  version: typeof MANGA_PLAN_VERSION;
  id: string;
  title: string;
  scriptId: string;
  scriptRevisionId: string;
  dialoguePolicy: DialoguePolicy;
  plannerVersion: string;
  promptCompilerVersion: string;
  plannerProvenance?: {
    kind: "llm-director";
    model: string;
    batches: Array<{ rawOutput: string; messages: Array<{ role: string; content: string }> }>;
  };
  narrativeGraph: NarrativeGraph;
  sourceDialogueLineIds: string[];
  /** Immutable lettering/grounding snapshot captured from the pinned revision. */
  dialogueSnapshots: FrozenDialogueLine[];
  pages: MangaPageSpec[];
  panelCount: number;
  dialogueCount: number;
  createdAt: string;
}

export interface MangaPlanValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  pageIndex?: number;
  panelId?: string;
}

export interface MangaPlanValidationReport {
  ok: boolean;
  issues: MangaPlanValidationIssue[];
}

export interface MangaPlanValidationOptions {
  resolveLayoutPanelCount?: (layoutTemplateId: string) => number | null;
}

function validBox(box: NormalizedBox): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1.000001 &&
    box.y + box.height <= 1.000001
  );
}

/**
 * Renderer, editor and orchestrator share this deterministic gate. It deliberately validates
 * executable relationships (coverage, layout cardinality, state/entity references and geometry)
 * rather than merely checking that a JSON object has the right top-level keys.
 */
export function validateMangaPlanV2(plan: MangaPlanV2, options: MangaPlanValidationOptions = {}): MangaPlanValidationReport {
  const issues: MangaPlanValidationIssue[] = [];
  const error = (code: string, message: string, pageIndex?: number, panelId?: string) => {
    issues.push({ severity: "error", code, message, pageIndex, panelId });
  };
  const warning = (code: string, message: string, pageIndex?: number, panelId?: string) => {
    issues.push({ severity: "warning", code, message, pageIndex, panelId });
  };

  if (plan.version !== MANGA_PLAN_VERSION) error("unsupported-version", `Expected MangaPlanV2 version ${MANGA_PLAN_VERSION}`);
  if (!plan.scriptRevisionId) error("missing-revision", "scriptRevisionId is required");
  if (!plan.plannerVersion?.trim()) error("planner-version", "plannerVersion is required");
  if (!plan.promptCompilerVersion?.trim()) error("prompt-compiler-version", "promptCompilerVersion is required");
  if (!(plan.dialoguePolicy === "preserve" || plan.dialoguePolicy === "adapt" || plan.dialoguePolicy === "fill" || plan.dialoguePolicy === "generate")) {
    error("dialogue-policy", `Unsupported dialoguePolicy: ${String(plan.dialoguePolicy)}`);
  }
  if (!plan.createdAt || Number.isNaN(Date.parse(plan.createdAt))) error("created-at", "createdAt must be an ISO-compatible timestamp");
  if (plan.pages.length === 0 || plan.pages.length > 200) error("page-count", "Plan must contain 1..200 pages");

  const sourceIds = new Set<string>();
  for (const source of plan.narrativeGraph.sourceElements) {
    if (!source.id || sourceIds.has(source.id)) error("source-id", `Duplicate or empty source element id: ${source.id}`);
    sourceIds.add(source.id);
  }
  const entityIds = new Set<string>();
  for (const entity of plan.narrativeGraph.entities) {
    if (!entity.id || entityIds.has(entity.id)) error("entity-id", `Duplicate or empty entity id: ${entity.id}`);
    entityIds.add(entity.id);
  }
  const stateIds = new Set<string>();
  for (const state of plan.narrativeGraph.worldStates) {
    if (!state.id || stateIds.has(state.id)) error("state-id", `Duplicate or empty world-state id: ${state.id}`);
    stateIds.add(state.id);
    if (!entityIds.has(state.settingId)) error("state-setting", `World state references unknown setting: ${state.settingId}`);
    for (const characterId of Object.keys(state.characterStates)) {
      if (!entityIds.has(characterId)) error("state-character", `World state references unknown character: ${characterId}`);
    }
    for (const propId of Object.keys(state.propStates)) {
      if (!entityIds.has(propId)) error("state-prop", `World state references unknown prop: ${propId}`);
    }
  }
  const beatIds = new Set<string>();
  for (const beat of plan.narrativeGraph.beats) {
    if (!beat.id || beatIds.has(beat.id)) error("beat-id", `Duplicate or empty beat id: ${beat.id}`);
    beatIds.add(beat.id);
    for (const sourceId of beat.sourceElementIds) {
      if (!sourceIds.has(sourceId)) error("beat-source", `Beat references unknown source element: ${sourceId}`);
    }
  }
  const panelIds = new Set<string>();
  const dialogueSeen = new Set<string>();
  const snapshotIds = new Set<string>();
  for (const snapshot of plan.dialogueSnapshots) {
    if (!snapshot.id || snapshotIds.has(snapshot.id)) error("dialogue-snapshot", `Duplicate or empty dialogue snapshot id: ${snapshot.id}`);
    snapshotIds.add(snapshot.id);
  }
  for (const lineId of plan.sourceDialogueLineIds) {
    if (!snapshotIds.has(lineId)) error("dialogue-snapshot-missing", `Frozen dialogue snapshot is missing: ${lineId}`);
  }
  for (const lineId of snapshotIds) {
    if (!plan.sourceDialogueLineIds.includes(lineId)) error("dialogue-snapshot-extra", `Dialogue snapshot is outside the frozen source set: ${lineId}`);
  }
  let actualPanelCount = 0;

  plan.pages.forEach((page, pageIndex) => {
    if (page.index !== pageIndex) error("page-index", `Page index ${page.index} is not contiguous`, pageIndex);
    if (!page.layoutTemplateId?.trim()) error("layout-id", "layoutTemplateId is required", pageIndex);
    const snapshot = page.layoutSnapshot;
    const expectedPanelCount = snapshot?.version === 1 && Array.isArray(snapshot.panels)
      ? snapshot.panels.length
      : options.resolveLayoutPanelCount?.(page.layoutTemplateId) ?? null;
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.panels)) {
      error("layout-snapshot", `Layout snapshot is missing or invalid for ${page.layoutTemplateId}`, pageIndex);
    } else {
      if (
        !Array.isArray(snapshot.page?.aspectRatio) ||
        snapshot.page.aspectRatio.length !== 2 ||
        !snapshot.page.aspectRatio.every((value) => Number.isFinite(value) && value > 0) ||
        !Number.isFinite(snapshot.page.height) ||
        snapshot.page.height <= 0 ||
        (snapshot.readingDirection !== "rtl" && snapshot.readingDirection !== "ltr")
      ) {
        error("layout-snapshot", `Layout snapshot has invalid page geometry for ${page.layoutTemplateId}`, pageIndex);
      }
      const layoutPanelIds = new Set<string>();
      for (const layoutPanel of snapshot.panels) {
        if (!layoutPanel?.id || layoutPanelIds.has(layoutPanel.id)) {
          error("layout-panel-id", `Layout snapshot has a duplicate or empty panel id: ${layoutPanel?.id ?? ""}`, pageIndex);
        }
        layoutPanelIds.add(layoutPanel?.id ?? "");
      }
    }
    if (expectedPanelCount === null) {
      error("layout-unresolved", `Layout ${page.layoutTemplateId} could not be resolved`, pageIndex);
    } else if (expectedPanelCount !== page.panels.length) {
      error(
        "layout-panel-count",
        `Layout ${page.layoutTemplateId} has ${expectedPanelCount} panels but plan contains ${page.panels.length}`,
        pageIndex
      );
    }
    if (page.panels.length === 0) error("empty-page", "A page must contain at least one panel", pageIndex);
    for (const panel of page.panels) {
      actualPanelCount += 1;
      if (!panel.id || panelIds.has(panel.id)) error("panel-id", `Duplicate or empty panel id: ${panel.id}`, pageIndex, panel.id);
      panelIds.add(panel.id);
      if (!stateIds.has(panel.preStateId)) error("pre-state", `Unknown preStateId: ${panel.preStateId}`, pageIndex, panel.id);
      if (!entityIds.has(panel.settingId)) error("setting", `Unknown setting entity: ${panel.settingId}`, pageIndex, panel.id);
      for (const sourceId of panel.sourceElementIds) {
        if (!sourceIds.has(sourceId)) error("source-reference", `Unknown source element: ${sourceId}`, pageIndex, panel.id);
      }
      for (const beatId of panel.beatIds) {
        if (!beatIds.has(beatId)) error("beat-reference", `Unknown beat: ${beatId}`, pageIndex, panel.id);
      }
      for (const cast of panel.cast) {
        if (!entityIds.has(cast.characterId)) error("cast-reference", `Unknown character: ${cast.characterId}`, pageIndex, panel.id);
        if (!validBox(cast.bbox)) error("cast-box", `Invalid cast bbox for ${cast.characterId}`, pageIndex, panel.id);
      }
      if (!entityIds.has(panel.shot.focalSubjectId)) {
        error("focal-subject", `Unknown focal subject: ${panel.shot.focalSubjectId}`, pageIndex, panel.id);
      }
      for (const prop of panel.props) {
        if (!entityIds.has(prop.entityId)) error("prop-reference", `Unknown prop: ${prop.entityId}`, pageIndex, panel.id);
        if (prop.bbox && !validBox(prop.bbox)) error("prop-box", `Invalid prop bbox for ${prop.entityId}`, pageIndex, panel.id);
      }
      for (const zone of panel.textSafeZones) {
        if (!validBox(zone)) error("safe-zone", "Invalid lettering safe zone", pageIndex, panel.id);
      }
      for (const characterId of Object.keys(panel.postStateDelta.characterStates ?? {})) {
        if (!entityIds.has(characterId)) error("delta-character", `State delta references unknown character: ${characterId}`, pageIndex, panel.id);
      }
      for (const propId of Object.keys(panel.postStateDelta.propStates ?? {})) {
        if (!entityIds.has(propId)) error("delta-prop", `State delta references unknown prop: ${propId}`, pageIndex, panel.id);
      }
      for (const reference of panel.referenceManifest) {
        if (!entityIds.has(reference.entityId)) error("reference-entity", `Reference targets unknown entity: ${reference.entityId}`, pageIndex, panel.id);
        if (!Number.isFinite(reference.strength) || reference.strength < 0 || reference.strength > 2) {
          error("reference-strength", `Invalid reference strength for ${reference.entityId}`, pageIndex, panel.id);
        }
        if (reference.targetRegion && !validBox(reference.targetRegion)) {
          error("reference-box", `Invalid reference target region for ${reference.entityId}`, pageIndex, panel.id);
        }
      }
      for (const lineId of panel.dialogueLineIds) {
        if (dialogueSeen.has(lineId)) error("dialogue-duplicate", `Dialogue line is assigned more than once: ${lineId}`, pageIndex, panel.id);
        dialogueSeen.add(lineId);
      }
      if (!panel.compiledPrompt.trim()) error("prompt", "compiledPrompt must not be empty", pageIndex, panel.id);
    }
  });

  if (actualPanelCount !== plan.panelCount) error("panel-total", `panelCount=${plan.panelCount}, actual=${actualPanelCount}`);
  for (const page of plan.pages) {
    for (const panel of page.panels) {
      for (const priorPanelId of panel.continuityFromPanelIds) {
        if (!panelIds.has(priorPanelId) || priorPanelId === panel.id) {
          error("continuity-panel", `Invalid continuity panel reference: ${priorPanelId}`, page.index, panel.id);
        }
      }
    }
  }
  if (dialogueSeen.size !== plan.dialogueCount) error("dialogue-total", `dialogueCount=${plan.dialogueCount}, assigned=${dialogueSeen.size}`);
  for (const lineId of plan.sourceDialogueLineIds) {
    if (!dialogueSeen.has(lineId)) error("dialogue-missing", `Dialogue line is not assigned: ${lineId}`);
  }
  for (const lineId of dialogueSeen) {
    if (!plan.sourceDialogueLineIds.includes(lineId)) error("dialogue-extra", `Panel references a line outside the frozen revision set: ${lineId}`);
  }
  for (const source of plan.narrativeGraph.sourceElements) {
    const assigned = plan.pages.some((page) => page.panels.some((panel) => panel.sourceElementIds.includes(source.id)));
    if (!assigned && !source.omissionReason) warning("source-unassigned", `Source element is not assigned and has no omission reason: ${source.id}`);
  }

  return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}
