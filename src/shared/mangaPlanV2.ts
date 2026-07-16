import type { ArtifactRef } from "./generationIntent";
import type { PageLayout } from "./pageLayout";
import type { DialogueUnit } from "./dialogueAdaptation";
import { orderPanelsByReadingDirection } from "./dialogueAutoLayout";
import { actionTextEstablishesVisibleActor, dialogueEstablishesVisibleSpeaker } from "./dialoguePresentation";

export const MANGA_PLAN_VERSION = 2 as const;
export const MANGA_PLANNER_VERSION = "manga-plan-v2.1";
export const PANEL_PROMPT_COMPILER_VERSION = "panel-prompt-v3.2";

export type DialoguePolicy = "preserve" | "adapt" | "fill" | "generate";
export type NarrativeEntityKind = "character" | "setting" | "prop" | "vehicle" | "unknown";
export type MangaShotSize = "extreme-wide" | "wide" | "medium" | "close-up" | "insert";
export type MangaReferenceRole = "identity" | "outfit" | "pose" | "background" | "prop" | "style";
/** N1ページネームが付けるコマの物語的な重み(ネームv4 D1)。省略 = normal 相当。 */
export type MangaPanelImportance = "splash" | "hero" | "normal";
/** ページめくり演出(reveal=次ページ冒頭で開示 / cliffhanger=緊張の頂点で切る)。省略 = none 相当。 */
export type MangaPageTurnHook = "reveal" | "cliffhanger" | "none";

/**
 * ネームスタジオV5 D1: 統一スケール語彙。ビート側は preferredScale(演出上の希望)、
 * コマ側は visualScale(ページ全体を踏まえて解決された値)としてフィールド名を分ける。
 */
export const MANGA_VISUAL_SCALES = ["small", "medium", "large", "splash"] as const;
export type MangaVisualScale = (typeof MANGA_VISUAL_SCALES)[number];

export function visualScaleFromImportance(importance: MangaPanelImportance): MangaVisualScale {
  return importance === "splash" ? "splash" : importance === "hero" ? "large" : "medium";
}

export function importanceFromVisualScale(scale: MangaVisualScale): MangaPanelImportance {
  return scale === "splash" ? "splash" : scale === "large" ? "hero" : "normal";
}

/**
 * 旧語彙(コマ importance enum / ビート desiredScale)が混在する永続データ・API入力を
 * visualScale へ正規化する入力adapter。適用箇所は3境界のみ: 永続 plan/candidate のparse直後、
 * provided directorPlan 入力、successorPlan 入力。旧設計の温存ではない。
 */
export function normalizeLegacyVisualScale(input: {
  importance?: unknown;
  desiredScale?: unknown;
  visualScale?: unknown;
}): MangaVisualScale | undefined {
  if (typeof input.visualScale === "string" && (MANGA_VISUAL_SCALES as readonly string[]).includes(input.visualScale)) {
    return input.visualScale as MangaVisualScale;
  }
  if (typeof input.importance === "string" && ["splash", "hero", "normal"].includes(input.importance)) {
    return visualScaleFromImportance(input.importance as MangaPanelImportance);
  }
  if (typeof input.desiredScale === "string") {
    if (input.desiredScale === "small") return "small";
    if (input.desiredScale === "normal") return "medium";
    if (input.desiredScale === "hero") return "large";
    if (input.desiredScale === "splash") return "splash";
  }
  return undefined;
}

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

export interface SceneBible {
  settingId: string;
  set: string;
  lighting: string;
  palette: string;
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
  /** ビート注釈由来(ネームv4 D2)。後付け生成のビートには無い。additive。 */
  kind?: string;
  /** ビート注釈由来の重要度 0..1(ネームv4 D2)。additive。 */
  importance?: number;
  /** ビート注釈由来の希望スケール(ネームスタジオV5 D1)。additive。 */
  preferredScale?: MangaVisualScale;
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
  /**
   * コマの役割(Docs/Reference-MangaCompositions.md)。省略 = 通常の絵コマ。"figure" は
   * layout snapshot の `role:"figure"` スロット(reading order で対応)に対応し、
   * プロンプトは「単独人物・全身・白背景」へ切り替わる。候補採用時に背景除去+白フチの
   * 切り抜きが ImageObject としてコマ枠の前面へ重ねられる(コマぶち抜き立ち絵)。
   * 実行時の正はあくまで layout snapshot 側で、materialize がここへ写す。
   */
  role?: "figure";
  /** N1由来のコマの重み(ネームv4 D1)。レイアウト事前選択・候補比較UIが使う。additive。 */
  importance?: MangaPanelImportance;
  /** 解決済みコマスケール(ネームスタジオV5 D1)。importance の後継。additive。 */
  visualScale?: MangaVisualScale;
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
  fillUnitIds?: string[];
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
  /** N1由来のページめくり演出(ネームv4 D1)。additive。 */
  turnHook?: MangaPageTurnHook;
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
  balloonStyle?: string;
}

export interface NarrativeGraph {
  sourceElements: SourceElementRef[];
  entities: NarrativeEntity[];
  worldStates: WorldState[];
  sceneBibles?: SceneBible[];
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
  fillUnits?: DialogueUnit[];
  pages: MangaPageSpec[];
  panelCount: number;
  dialogueCount: number;
  createdAt: string;
}

/**
 * 永続 MangaPlanV2 のparse直後に呼ぶ入力adapter(V5 D1)。旧語彙(importance)しか持たない
 * コマへ visualScale を補完する(in-place)。旧planの読み込み・resume・repairを無傷に保つ。
 */
export function normalizeMangaPlanV2Scales<T extends { pages?: Array<{ panels?: PanelSpec[] }> }>(plan: T): T {
  for (const page of plan.pages ?? []) {
    for (const panel of page.panels ?? []) {
      if (!panel.visualScale) {
        const scale = normalizeLegacyVisualScale({ importance: panel.importance });
        if (scale) panel.visualScale = scale;
      }
    }
  }
  return plan;
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
  const sourceById = new Map<string, SourceElementRef>();
  for (const source of plan.narrativeGraph.sourceElements) {
    if (!source.id || sourceIds.has(source.id)) error("source-id", `Duplicate or empty source element id: ${source.id}`);
    sourceIds.add(source.id);
    if (source.id && !sourceById.has(source.id)) sourceById.set(source.id, source);
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
  const sceneBibleSettings = new Set<string>();
  for (const bible of plan.narrativeGraph.sceneBibles ?? []) {
    if (!entityIds.has(bible.settingId)) error("scene-bible-setting", `Scene bible references unknown setting: ${bible.settingId}`);
    if (sceneBibleSettings.has(bible.settingId)) error("scene-bible-duplicate", `Duplicate scene bible: ${bible.settingId}`);
    sceneBibleSettings.add(bible.settingId);
    if (!bible.set.trim() || !bible.lighting.trim() || !bible.palette.trim()) error("scene-bible-empty", `Scene bible fields must be non-empty: ${bible.settingId}`);
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
  const dialogueAssignmentOrder: string[] = [];
  const snapshotIds = new Set<string>();
  const snapshotById = new Map<string, FrozenDialogueLine>();
  const fillUnitIds = new Set((plan.fillUnits ?? []).map((unit) => unit.id));
  for (const snapshot of plan.dialogueSnapshots) {
    if (!snapshot.id || snapshotIds.has(snapshot.id)) error("dialogue-snapshot", `Duplicate or empty dialogue snapshot id: ${snapshot.id}`);
    snapshotIds.add(snapshot.id);
    if (snapshot.id && !snapshotById.has(snapshot.id)) snapshotById.set(snapshot.id, snapshot);
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
      // ぶち抜き立ち絵スロット(role:"figure"、reading order で plan panel と対応)は単独人物が
      // 前提(Docs/Reference-MangaCompositions.md)。壊れた snapshot でも検証自体は落とさない。
      try {
        const orderedLayoutPanels = orderPanelsByReadingDirection(
          snapshot.panels,
          snapshot.readingDirection === "ltr" ? "ltr" : "rtl"
        );
        orderedLayoutPanels.forEach((layoutPanel, panelIndex) => {
          if (layoutPanel.role !== "figure") return;
          const panel = page.panels[panelIndex];
          if (panel && panel.cast.length !== 1) {
            warning(
              "figure-cast-count",
              `Figure slot panel ${panel.id} should have exactly one cast member (got ${panel.cast.length})`,
              pageIndex,
              panel.id
            );
          }
        });
      } catch {
        // geometry が壊れている場合は layout-snapshot 系の error 側で報告済み。
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
        const source = sourceById.get(sourceId);
        if (!source) {
          error("source-reference", `Unknown source element: ${sourceId}`, pageIndex, panel.id);
        } else if (source.sceneIndex !== panel.sceneIndex) {
          error(
            "source-scene",
            `Panel scene ${panel.sceneIndex} references source ${sourceId} from scene ${source.sceneIndex}`,
            pageIndex,
            panel.id
          );
        }
      }
      const panelVisualSources = panel.sourceElementIds
        .map((sourceId) => sourceById.get(sourceId))
        .filter((source): source is SourceElementRef =>
          source !== undefined &&
          source.sceneIndex === panel.sceneIndex &&
          (source.type === "action" || source.type === "synopsis")
        );
      const intentionallyAbsentCharacterIds = new Set(panel.mustNotShow
        .filter((constraint) => constraint.kind === "entity-absent" && constraint.entityId)
        .map((constraint) => constraint.entityId!));
      for (const entity of plan.narrativeGraph.entities) {
        if (
          entity.kind === "character" &&
          !panel.cast.some((member) => member.characterId === entity.id) &&
          !intentionallyAbsentCharacterIds.has(entity.id) &&
          panelVisualSources.some((source) => actionTextEstablishesVisibleActor(source.text, [entity.name, ...entity.aliases]))
        ) {
          error(
            "source-actor-cast",
            `Action-grounded visible character is missing from panel cast: ${entity.id}`,
            pageIndex,
            panel.id
          );
        }
      }
      for (const beatId of panel.beatIds) {
        if (!beatIds.has(beatId)) error("beat-reference", `Unknown beat: ${beatId}`, pageIndex, panel.id);
      }
      for (const cast of panel.cast) {
        if (!entityIds.has(cast.characterId)) error("cast-reference", `Unknown character: ${cast.characterId}`, pageIndex, panel.id);
        if (intentionallyAbsentCharacterIds.has(cast.characterId)) {
          error("cast-explicitly-absent", `Panel cast includes a character marked entity-absent: ${cast.characterId}`, pageIndex, panel.id);
        }
        if (!validBox(cast.bbox)) error("cast-box", `Invalid cast bbox for ${cast.characterId}`, pageIndex, panel.id);
        for (const lineId of cast.speakingLineIds) {
          const line = snapshotById.get(lineId);
          if (!panel.dialogueLineIds.includes(lineId)) {
            error("cast-dialogue-panel", `Cast member references dialogue outside the panel: ${lineId}`, pageIndex, panel.id);
          } else if (!line || line.characterId !== cast.characterId) {
            error("cast-dialogue-speaker", `Cast member does not match dialogue speaker: ${lineId}`, pageIndex, panel.id);
          }
        }
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
        dialogueAssignmentOrder.push(lineId);
        if (dialogueSeen.has(lineId)) error("dialogue-duplicate", `Dialogue line is assigned more than once: ${lineId}`, pageIndex, panel.id);
        dialogueSeen.add(lineId);
        const line = snapshotById.get(lineId);
        if (line && line.sceneIndex !== panel.sceneIndex) {
          error(
            "dialogue-scene",
            `Panel scene ${panel.sceneIndex} references dialogue ${lineId} from scene ${line.sceneIndex}`,
            pageIndex,
            panel.id
          );
        }
        if (
          line?.characterId &&
          dialogueEstablishesVisibleSpeaker(line) &&
          !panel.cast.some((member) => member.characterId === line.characterId)
        ) {
          error("visible-speaker-cast", `Visible dialogue speaker is missing from panel cast: ${lineId}`, pageIndex, panel.id);
        }
      }
      const expectedOrderIndexes = panel.dialogueLineIds
        .map((lineId) => snapshotById.get(lineId)?.orderIndex)
        .filter((orderIndex): orderIndex is number => orderIndex !== undefined);
      if (
        expectedOrderIndexes.length !== panel.dialogueOrderIndexes.length ||
        expectedOrderIndexes.some((orderIndex, index) => panel.dialogueOrderIndexes[index] !== orderIndex)
      ) {
        error(
          "dialogue-order-indexes",
          "dialogueOrderIndexes must match dialogueLineIds in panel reading order",
          pageIndex,
          panel.id
        );
      }
      for (const unitId of panel.fillUnitIds ?? []) {
        if (!fillUnitIds.has(unitId)) error("fill-unit-missing", `Panel references unknown fill unit: ${unitId}`, pageIndex, panel.id);
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
  const sourceOrderIndexes = plan.sourceDialogueLineIds
    .map((lineId) => snapshotById.get(lineId)?.orderIndex)
    .filter((orderIndex): orderIndex is number => orderIndex !== undefined);
  if (sourceOrderIndexes.some((orderIndex, index) => index > 0 && sourceOrderIndexes[index - 1]! >= orderIndex)) {
    error("dialogue-source-order", "sourceDialogueLineIds must follow strictly increasing frozen orderIndex values");
  }
  if (
    dialogueAssignmentOrder.length !== plan.sourceDialogueLineIds.length ||
    dialogueAssignmentOrder.some((lineId, index) => plan.sourceDialogueLineIds[index] !== lineId)
  ) {
    error("dialogue-order", "Panel dialogue assignments must follow the frozen script order");
  }
  for (const source of plan.narrativeGraph.sourceElements) {
    const assigned = plan.pages.some((page) => page.panels.some((panel) => panel.sourceElementIds.includes(source.id)));
    if (!assigned && !source.omissionReason) warning("source-unassigned", `Source element is not assigned and has no omission reason: ${source.id}`);
  }

  return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}
