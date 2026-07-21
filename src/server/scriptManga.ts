import type { FountainDoc } from "../shared/fountain";
import {
  type DialoguePolicy,
  type MangaPlanV2,
  type MangaPlanValidationReport,
  normalizeMangaPlanV2Scales,
  type PanelSpec
} from "../shared/mangaPlanV2";
import { DEFAULT_MAX_DIALOGUES_PER_PANEL, applyCustomNameLayouts, planScriptManga, type ScriptMangaPlan, type ScriptMangaPlanOptions } from "../shared/scriptMangaPlan";
import { validateProvidedScriptMangaPlan } from "../shared/scriptMangaProvidedPlan";
import type { GenerationRequest, StyleLoraSelection } from "../shared/types";
import type { ScriptMangaPlanView, ScriptMangaRunView } from "../shared/scriptMangaApi";
import type { ScriptMangaReferenceSnapshot } from "../shared/referenceSets";
import { referenceSnapshotKey } from "../shared/referenceSets";
import { updateAssetStatus } from "./assets";
import { createId, getRow, getRows, runSql } from "./db";
import { HttpError } from "./http";
import { latestRevision, requireScript } from "./scriptRevisions";
import { resolveLayoutTemplate } from "./layoutTemplates";
import { resolvePanelReferences } from "./referenceResolver";
import { createGenerationRound, ensureRoundMonitor, interruptRound } from "./rounds";
import { resolveRoundAttachmentPath, type RoundAttachmentKind } from "./roundAttachments";
import { withImageExport, type ImageExportResult } from "./imageExport";
import { withOpenRasterExport, type OpenRasterExportResult } from "./openRasterExport";
import { OPENPOSE_JOINT_COUNT } from "../shared/poseTypes";
import { directAdoptedCandidatePlan, planScriptMangaWithDirectorDetailed } from "./scriptMangaDirector";
import { readCachedBeatAnnotation, type BeatAnnotationResult } from "./scriptBeatAnnotator";
import { buildPreLayoutUnits } from "../shared/preLayoutBeat";
import {
  adoptablePlanCandidate,
  beginPlanCandidateAdoption,
  fixedEmbeddedCandidateDirection,
  isExternallyDirectedPlanCandidate,
  isFixedDirectedPlanCandidate,
  markPlanCandidateAdopted,
  revertPlanCandidateAdoption,
  scriptMangaCandidateDirectionInputHash
} from "./scriptMangaPlanCandidates";
import { buildMangaPlanV2 } from "./scriptMangaPlanV2";
import type { StoryGraphCharacterInput, StoryGraphDialogueInput } from "./storyGraphBuilder";
import { objectBody, requiredString, stringOr } from "./validate";
import { readFile } from "node:fs/promises";
import {
  buildScriptMangaRepairGenerationRequest,
  parseScriptMangaRepairRequest
} from "./scriptMangaRepair";
import {
  clonePageLayout,
  errorJson,
  pageLayout,
  parseConfig,
  parseJson,
  planFromRow,
  planView,
  referenceModelFamily,
  refreshRunStatus,
  requirePlan,
  requireRun,
  requireTask,
  runView,
  validatePlan,
  type RunRow,
  type ScriptMangaRunConfig,
  type TaskRow
} from "./scriptMangaRows";
import { materializeRun, normalizePanelCast, persistPlan, sourceGroundedCharacterIds } from "./scriptMangaMaterialize";
import { inheritSelectedTasks, taskReuseSourceFromAsset } from "./scriptMangaReuse";
import {
  activeTaskSelections,
  activeTaskSubmissions,
  parsePoseControlInput,
  recoverInheritingTasks,
  recoverSelectingTasks,
  recoverSubmittingTasks,
  submitTasks
} from "./scriptMangaSubmission";
import { scheduleRunVisualAudit, syncTaskFromRound } from "./scriptMangaAudit";
import { materializeFigureForTask, recordFigureResult } from "./scriptMangaFigure";

// 分割前の公開APIを維持する再export(外部importerは従来どおり ./scriptManga から参照する)。
export {
  buildPanelGenerationRequest,
  buildPoseControlAttachment,
  panelGenerationSize,
  parsePoseControlInput
} from "./scriptMangaSubmission";
export { auditScriptMangaTask, recordExternalScriptMangaTaskAudit } from "./scriptMangaAudit";

function revisionById(scriptId: string, revisionId: string): { id: string; doc: FountainDoc } {
  const row = getRow<{ id: string; parsed_json: string }>(
    "SELECT id, parsed_json FROM script_revisions WHERE id = ? AND script_id = ?",
    [revisionId, scriptId]
  );
  if (!row) throw new HttpError(409, "The predecessor's pinned Fountain revision is unavailable");
  try {
    return { id: row.id, doc: JSON.parse(row.parsed_json) as FountainDoc };
  } catch {
    throw new HttpError(500, "Stored Fountain revision is invalid");
  }
}

function loadCharacters(projectId: string): StoryGraphCharacterInput[] {
  return getRows<{ id: string; name: string; aliases_json: string | null; notes: string; color: string | null }>(
    "SELECT id, name, aliases_json, notes, color FROM characters WHERE project_id = ? ORDER BY created_at ASC",
    [projectId]
  ).map((row) => ({
    id: row.id,
    name: row.name,
    aliases: parseJson<string[]>(row.aliases_json, []),
    notes: row.notes,
    color: row.color
  }));
}

function loadActiveDialogues(scriptId: string): StoryGraphDialogueInput[] {
  return getRows<{
    id: string;
    order_index: number;
    scene_index: number | null;
    character_id: string | null;
    speaker_label: string;
    text: string;
    semantic_kind: string;
    balloon_style: string;
  }>(
    `SELECT id, order_index, scene_index, character_id, speaker_label, text, semantic_kind, balloon_style
     FROM dialogue_lines WHERE script_id = ? AND status = 'active' ORDER BY order_index ASC`,
    [scriptId]
  ).map((row) => ({
    id: row.id,
    orderIndex: row.order_index,
    sceneIndex: row.scene_index ?? 0,
    characterId: row.character_id,
    speakerLabel: row.speaker_label,
    text: row.text,
    semanticKind: row.semantic_kind,
    balloonStyle: row.balloon_style
  }));
}

function collectReferenceSnapshot(run: RunRow, plan: MangaPlanV2, config: ScriptMangaRunConfig): ScriptMangaReferenceSnapshot | null {
  const modelFamily = referenceModelFamily(config.templateId);
  if (!modelFamily) return null;
  const sets = new Map<string, ScriptMangaReferenceSnapshot["sets"][number]>();
  const missing = new Set<string>();
  const dialogueById = new Map(plan.dialogueSnapshots.map((line) => [line.id, line]));
  for (const panel of plan.pages.flatMap((page) => page.panels)) {
    const normalized = normalizePanelCast(panel, dialogueById, sourceGroundedCharacterIds(panel, plan.narrativeGraph));
    const resolved = resolvePanelReferences({
      projectId: run.project_id,
      providerId: config.providerId,
      cast: normalized.cast,
      focalSubjectId: panel.shot.focalSubjectId,
      globalLoras: config.loras,
      modelFamily
    });
    for (const set of resolved.appearances) sets.set(referenceSnapshotKey(set.characterId, set.variantId), set);
    const appearanceKeys = new Set(resolved.appearances.map((set) => referenceSnapshotKey(set.characterId, set.variantId)));
    for (const member of normalized.cast) {
      if (!appearanceKeys.has(referenceSnapshotKey(member.characterId, member.variantId))) missing.add(member.characterId);
    }
    for (const characterId of resolved.missingReferenceIds) missing.add(characterId);
  }
  if (config.requireReferenceSets && missing.size > 0 && !config.allowReferenceFallback) {
    throw new HttpError(422, `Approved ${modelFamily} Reference Set is required for: ${[...missing].join(", ")}`);
  }
  return {
    modelFamily,
    approvedAt: new Date().toISOString(),
    allowFallback: config.allowReferenceFallback,
    sets: [...sets.values()]
  };
}

function layoutPanelCount(layoutTemplateId: string): number | null {
  return resolveLayoutTemplate(layoutTemplateId)?.panels.length ?? null;
}

function parseDialoguePolicy(value: unknown): DialoguePolicy {
  const policy = typeof value === "string" ? value : "preserve";
  if (policy === "preserve" || policy === "adapt" || policy === "fill") return policy;
  if (policy === "generate") throw new HttpError(400, "dialoguePolicy generate requires a future lexical-similarity gate");
  throw new HttpError(400, 'dialoguePolicy must be "preserve", "adapt", "fill", or "generate"');
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value)))
    : fallback;
}

function planningOptionsFromInput(
  input: Record<string, unknown>,
  fallback: ScriptMangaPlanOptions = {}
): ScriptMangaPlanOptions {
  const requestedTarget = input.targetPageCount;
  const targetPageCount = typeof requestedTarget === "number" && Number.isFinite(requestedTarget)
    ? Math.trunc(requestedTarget) > 0
      ? Math.max(1, Math.min(200, Math.trunc(requestedTarget)))
      : undefined
    : fallback.targetPageCount;
  const requestedStyle = typeof input.stylePrompt === "string" ? input.stylePrompt.trim() : null;
  return {
    panelsPerPage: boundedInteger(input.panelsPerPage, fallback.panelsPerPage ?? 4, 1, 6),
    maxElementsPerPanel: boundedInteger(input.maxElementsPerPanel, fallback.maxElementsPerPanel ?? 6, 1, 24),
    targetPageCount,
    maxDialoguesPerPanel: boundedInteger(input.maxDialoguesPerPanel, fallback.maxDialoguesPerPanel ?? DEFAULT_MAX_DIALOGUES_PER_PANEL, 1, 8),
    stylePrompt: requestedStyle === null ? fallback.stylePrompt : requestedStyle || undefined
  };
}

/** Candidate preflight and adoption must hash the exact same direction-affecting options. */
export function scriptMangaCandidateDirectionOptionsFromInput(
  input: Record<string, unknown>,
  scriptRevisionId: string
): ScriptMangaPlanOptions {
  const options = planningOptionsFromInput(input);
  const dialoguePolicy = parseDialoguePolicy(input.dialoguePolicy);
  if ((dialoguePolicy === "adapt" || dialoguePolicy === "fill") && input.panelsPerPage === undefined) {
    options.panelsPerPage = 2;
  }
  return {
    ...options,
    scriptRevisionId,
    characterBible: stringOr(input.characterBible, "") || undefined
  };
}

function styleLorasFromInput(value: unknown, fallback: StyleLoraSelection[] = []): StyleLoraSelection[] {
  if (!Array.isArray(value)) return fallback.map((item) => ({ ...item }));
  return value.flatMap((raw) =>
    raw && typeof raw === "object"
      ? [{
          name: stringOr((raw as Record<string, unknown>).name, ""),
          strength: typeof (raw as Record<string, unknown>).strength === "number"
            ? (raw as Record<string, number>).strength
            : 1
        }]
      : []
  ).filter((item) => item.name.trim()).slice(0, 4);
}

function restoreFrozenPlanSources(candidate: MangaPlanV2, original: MangaPlanV2): void {
  candidate.narrativeGraph = {
    ...candidate.narrativeGraph,
    sourceElements: structuredClone(original.narrativeGraph.sourceElements),
    entities: structuredClone(original.narrativeGraph.entities),
    warnings: structuredClone(original.narrativeGraph.warnings)
  };
  candidate.fillUnits = original.fillUnits ? structuredClone(original.fillUnits) : undefined;
}

function completeSuccessorPlan(raw: unknown, original: MangaPlanV2, planId: string): MangaPlanV2 {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "successorPlan must be a complete MangaPlanV2 object");
  let candidate: MangaPlanV2;
  try {
    candidate = JSON.parse(JSON.stringify(raw)) as MangaPlanV2;
  } catch {
    throw new HttpError(400, "successorPlan must be valid JSON");
  }
  if (candidate.version !== 2 || !Array.isArray(candidate.pages) || !candidate.narrativeGraph) {
    throw new HttpError(400, "successorPlan must be a complete MangaPlanV2 object");
  }
  // V5 D1: successorPlan はDB非経由の生API入力 = 旧語彙adapterの適用境界(3箇所のうちの1つ)。
  normalizeMangaPlanV2Scales(candidate);
  const originalPages = new Map(original.pages.map((page) => [page.index, page]));
  try {
    candidate.pages = candidate.pages.map((page) => {
      if (!page || typeof page !== "object" || !Array.isArray(page.panels) || typeof page.layoutTemplateId !== "string") {
        throw new HttpError(400, "successorPlan contains a malformed page");
      }
      const originalPage = originalPages.get(page.index);
      const snapshot = originalPage?.layoutTemplateId === page.layoutTemplateId
        ? originalPage.layoutSnapshot
        : resolveLayoutTemplate(page.layoutTemplateId);
      if (!snapshot) throw new HttpError(422, `Layout template could not be resolved: ${page.layoutTemplateId}`);
      return { ...page, layoutSnapshot: clonePageLayout(snapshot) };
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "successorPlan contains malformed pages");
  }
  candidate.id = planId;
  candidate.scriptId = original.scriptId;
  candidate.scriptRevisionId = original.scriptRevisionId;
  candidate.sourceDialogueLineIds = [...original.sourceDialogueLineIds];
  candidate.dialogueSnapshots = original.dialogueSnapshots.map((snapshot) => ({ ...snapshot }));
  candidate.dialoguePolicy = original.dialoguePolicy;
  candidate.plannerVersion = original.plannerVersion;
  candidate.promptCompilerVersion = original.promptCompilerVersion;
  candidate.plannerProvenance = original.plannerProvenance;
  restoreFrozenPlanSources(candidate, original);
  candidate.title = typeof candidate.title === "string" && candidate.title.trim() ? candidate.title : original.title;
  candidate.panelCount = candidate.pages.reduce((sum, page) => sum + page.panels.length, 0);
  candidate.dialogueCount = new Set(candidate.pages.flatMap((page) => page.panels.flatMap((panel) => panel.dialogueLineIds))).size;
  candidate.createdAt = new Date().toISOString();
  return candidate;
}

function requirePanelBudget(plan: MangaPlanV2, maxPanelCount: number): void {
  if (maxPanelCount > 0 && plan.panelCount > maxPanelCount) {
    throw new HttpError(
      422,
      `MangaPlanV2 has ${plan.panelCount} panels, exceeding maxPanelCount ${maxPanelCount}; revise the name before generation`
    );
  }
}

function requireDialogueBudget(plan: MangaPlanV2, maxDialoguesPerPanel: number): void {
  const maximum = Math.max(1, Math.min(8, Math.trunc(maxDialoguesPerPanel)));
  const oversized = plan.pages
    .flatMap((page) => page.panels.map((panel) => ({ pageIndex: page.index, panel })))
    .find(({ panel }) => panel.dialogueLineIds.length > maximum);
  if (oversized) {
    throw new HttpError(
      422,
      `Panel ${oversized.panel.id} on page ${oversized.pageIndex + 1} has ${oversized.panel.dialogueLineIds.length} dialogue elements, exceeding maxDialoguesPerPanel ${maximum}`
    );
  }
}

function requirePagePanelBudget(plan: MangaPlanV2, panelsPerPage: number): void {
  const maximum = Math.max(1, Math.min(6, Math.trunc(panelsPerPage)));
  const oversized = plan.pages.find((page) => page.panels.length > maximum);
  if (oversized) {
    throw new HttpError(
      422,
      `Page ${oversized.index + 1} has ${oversized.panels.length} panels, exceeding panelsPerPage ${maximum}`
    );
  }
}

function requireRunPanelBudget(run: RunRow, plan: MangaPlanV2): void {
  const config = parseConfig(run);
  requirePanelBudget(plan, config.maxPanelCount);
  requireDialogueBudget(plan, config.planOptions?.maxDialoguesPerPanel ?? DEFAULT_MAX_DIALOGUES_PER_PANEL);
  requirePagePanelBudget(plan, config.planOptions?.panelsPerPage ?? 4);
}

function selectTaskCandidateInternal(task: TaskRow, assetId: string, options: { skipPanelAssignment?: boolean } = {}): void {
  const candidate = getRow<{ id: string }>(
    `SELECT a.id FROM assets a
     JOIN generation_rounds r ON r.id = a.round_id
     WHERE a.id = ? AND r.script_manga_task_id = ?`,
    [assetId, task.id]
  );
  if (!candidate) throw new HttpError(400, "Asset is not a candidate for this task");
  runSql("SAVEPOINT script_manga_candidate_select");
  try {
    const completed = runSql(
      `UPDATE script_manga_tasks SET status = 'completed', asset_id = ?, selected_asset_id = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'selecting'
         AND EXISTS (
           SELECT 1 FROM script_manga_runs r
           WHERE r.id = script_manga_tasks.run_id AND r.approval_status = 'approved' AND r.status <> 'canceled'
         )`,
      [assetId, assetId, task.id]
    ) as { changes?: number };
    if (completed.changes !== 1) throw new HttpError(409, "Task stopped accepting the candidate selection");
    updateAssetStatus(
      assetId,
      { status: "selected", note: `script manga run ${task.run_id}; reviewed candidate` },
      { skipAutoAssign: options.skipPanelAssignment === true }
    );
    runSql("RELEASE script_manga_candidate_select");
  } catch (error) {
    runSql("ROLLBACK TO script_manga_candidate_select");
    runSql("RELEASE script_manga_candidate_select");
    throw error;
  }
}

async function persistSelectedTaskReuseSource(task: TaskRow, assetId: string): Promise<void> {
  const run = requireRun(task.run_id);
  const plan = run.plan_id ? planFromRow(requirePlan(run.plan_id)) : null;
  if (!plan) return;
  const panels = new Map(getRows<TaskRow>(
    "SELECT * FROM script_manga_tasks WHERE run_id = ?",
    [run.id]
  ).flatMap((candidate) => {
    const panel = parseJson<PanelSpec | null>(candidate.panel_spec_json, null);
    return panel ? [[panel.id, panel] as const] : [];
  }));
  const source = await taskReuseSourceFromAsset(run, plan, task, assetId, panels);
  runSql(
    `UPDATE script_manga_tasks SET reuse_fingerprint = ?, reuse_source_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'selecting'`,
    [source?.fingerprint ?? null, source ? JSON.stringify(source) : null, task.id]
  );
}

export async function createScriptMangaRun(projectId: string, body: unknown): Promise<ScriptMangaRunView> {
  let claimedCandidateId: string | null = null;
  try {
    return await createScriptMangaRunInternal(projectId, body, (candidateId) => {
      claimedCandidateId = candidateId;
    });
  } catch (error) {
    // この呼び出しがactive→adoptingを取得した場合だけ戻す。並行した別採用のclaimは触らない。
    if (claimedCandidateId) revertPlanCandidateAdoption(claimedCandidateId);
    throw error;
  }
}

async function createScriptMangaRunInternal(
  projectId: string,
  body: unknown,
  onCandidateClaimed: (candidateId: string) => void
): Promise<ScriptMangaRunView> {
  const input = objectBody(body);
  const scriptId = requiredString(input.scriptId, "scriptId");
  requireScript(projectId, scriptId);

  const predecessorRunId = typeof input.predecessorRunId === "string" && input.predecessorRunId.trim()
    ? input.predecessorRunId.trim()
    : null;
  const predecessor = predecessorRunId ? requireRun(predecessorRunId) : null;
  const planningMode = stringOr(input.planningMode, "heuristic");
  if (planningMode !== "heuristic" && planningMode !== "llm" && planningMode !== "provided") {
    throw new HttpError(400, 'planningMode must be "heuristic", "llm", or "provided"');
  }
  if (predecessor) {
    if (predecessor.project_id !== projectId || predecessor.script_id !== scriptId) {
      throw new HttpError(404, "predecessorRunId was not found for this project and script");
    }
    if (!(["canceled", "completed", "completed_with_errors", "failed"] as string[]).includes(predecessor.status)) {
      throw new HttpError(409, "Cancel or finish the predecessor run before creating a successor");
    }
    if (planningMode !== "provided") throw new HttpError(400, 'A successor run requires planningMode "provided"');
    if (!predecessor.plan_id || !predecessor.script_revision_id) {
      throw new HttpError(409, "The predecessor has no pinned MangaPlanV2 revision");
    }
    if (input.successorPlan === undefined) throw new HttpError(400, "A complete successorPlan is required");
    if (input.planCandidateId !== undefined) throw new HttpError(400, "planCandidateId cannot be combined with predecessorRunId");
  } else if (input.successorPlan !== undefined) {
    throw new HttpError(400, "successorPlan requires predecessorRunId");
  }

  const predecessorConfig = predecessor ? parseConfig(predecessor) : null;
  const templateId = typeof input.templateId === "string" && input.templateId.trim()
    ? input.templateId.trim()
    : predecessorConfig?.templateId ?? requiredString(input.templateId, "templateId");
  const providerId = stringOr(input.providerId, predecessorConfig?.providerId ?? "comfy");
  if (!getRow("SELECT id FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [templateId])) {
    throw new HttpError(404, "Workflow template was not found");
  }
  const planOptions = planningOptionsFromInput(input, predecessorConfig?.planOptions);
  if (input.candidateSelectionPolicy !== undefined && input.candidateSelectionPolicy !== "review") {
    throw new HttpError(400, 'candidateSelectionPolicy must be "review"; generated candidates are never auto-selected');
  }
  const candidateSelectionPolicy = "review" as const;
  if (input.auditMode !== undefined && input.auditMode !== "manual" && input.auditMode !== "vlm") {
    throw new HttpError(400, 'auditMode must be "manual" or "vlm"');
  }
  const auditMode = input.auditMode === "vlm"
    ? "vlm"
    : input.auditMode === "manual"
      ? "manual"
      : predecessorConfig?.auditMode ?? "manual";
  const predecessorPlan = predecessor?.plan_id ? planFromRow(requirePlan(predecessor.plan_id)) : null;
  const dialoguePolicy = predecessorPlan?.dialoguePolicy ?? parseDialoguePolicy(input.dialoguePolicy);
  if (predecessorPlan && input.dialoguePolicy !== undefined && parseDialoguePolicy(input.dialoguePolicy) !== predecessorPlan.dialoguePolicy) {
    throw new HttpError(409, "A successor must preserve the predecessor dialoguePolicy");
  }
  if (!predecessor && (dialoguePolicy === "adapt" || dialoguePolicy === "fill") && input.panelsPerPage === undefined) {
    // 分割unitを可読サイズで置けるよう、既定packerも呼吸単位向けの大きめコマへ切り替える。
    planOptions.panelsPerPage = 2;
  }
  const revision = predecessor
    ? revisionById(scriptId, predecessor.script_revision_id!)
    : latestRevision(scriptId);
  const planCandidateId = typeof input.planCandidateId === "string" && input.planCandidateId.trim()
    ? input.planCandidateId.trim()
    : null;
  let candidatePlanningMode: "llm" | "provided" = "llm";
  const loras = styleLorasFromInput(input.loras, predecessorConfig?.loras);
  const planId = createId("manga_plan");
  let pageLimit: number;
  let plan: MangaPlanV2;
  let candidateBalloonHints: Record<number, Record<number, { x: number; y: number }>> | null = null;
  if (predecessorPlan) {
    plan = completeSuccessorPlan(input.successorPlan, predecessorPlan, planId);
    pageLimit = plan.pages.length;
  } else {
    let beatAnnotation: BeatAnnotationResult | null = null;
    let fullPlan: ScriptMangaPlan | null;
    if (planCandidateId) {
      // V5 D5: 実効プラン(基礎プラン+人間のフリップ)を採用する。監督スキーマにレイアウトは
      // 無いので「採用後レイアウト不変」は構造的に保証される。採用は数分かかるため adopting 状態で
      // フリップを凍結し、失敗時は createScriptMangaRun wrapper が active へ巻き戻す。
      const expectedCandidateVersion = typeof input.expectedCandidateVersion === "number" && Number.isInteger(input.expectedCandidateVersion)
        ? input.expectedCandidateVersion
        : undefined;
      const adoptable = adoptablePlanCandidate(planCandidateId, projectId, scriptId, revision.id, expectedCandidateVersion);
      beginPlanCandidateAdoption(planCandidateId);
      onCandidateClaimed(planCandidateId);
      const directionIsFixed = isFixedDirectedPlanCandidate(adoptable.row);
      candidatePlanningMode = isExternallyDirectedPlanCandidate(adoptable.row) ? "provided" : "llm";
      const candidateDirectionOptions = scriptMangaCandidateDirectionOptionsFromInput(input, revision.id);
      if (directionIsFixed) {
        fixedEmbeddedCandidateDirection(
          adoptable.row,
          scriptMangaCandidateDirectionInputHash(candidateDirectionOptions)
        );
      }
      fullPlan = directionIsFixed
        ? adoptable.plan
        : await directAdoptedCandidatePlan(revision.doc, adoptable.plan, candidateDirectionOptions);
      // 監督はページを再構築するため、人間ゲートのコマ割り修正(in-memory注釈)を再適用する。
      fullPlan = applyCustomNameLayouts(fullPlan, adoptable.customLayouts);
      candidateBalloonHints = adoptable.balloonHints;
      const units = buildPreLayoutUnits(revision.doc);
      const cachedBeats = readCachedBeatAnnotation(revision.id, units);
      beatAnnotation = cachedBeats ? { units, beats: cachedBeats, fallback: false, cached: true } : null;
    } else if (planningMode === "llm") {
      const detailed = await planScriptMangaWithDirectorDetailed(revision.doc, {
        ...planOptions,
        scriptRevisionId: revision.id,
        characterBible: stringOr(input.characterBible, "") || undefined
      });
      fullPlan = detailed.plan;
      beatAnnotation = detailed.beatAnnotation;
    } else if (planningMode === "provided") {
      fullPlan = validateProvidedScriptMangaPlan(revision.doc, input.directorPlan, layoutPanelCount);
    } else {
      fullPlan = planScriptManga(revision.doc, planOptions);
    }
    if (!fullPlan) throw new HttpError(400, "directorPlan is invalid or does not preserve every dialogue exactly once");
    // 候補採用は候補全体を1つのrunへ固定する。部分runをadoptedRunIdに結び付けない。
    pageLimit = !planCandidateId && typeof input.pageLimit === "number"
      ? Math.max(1, Math.min(fullPlan.pages.length, Math.trunc(input.pageLimit)))
      : fullPlan.pages.length;
    const limitedPages = fullPlan.pages.slice(0, pageLimit);
    const legacyPlan = {
      ...fullPlan,
      pages: limitedPages,
      panelCount: limitedPages.reduce((sum, page) => sum + page.panels.length, 0),
      dialogueCount: new Set(limitedPages.flatMap((page) => page.panels.flatMap((panel) => panel.dialogueOrderIndexes))).size
    };
    plan = buildMangaPlanV2({
      id: planId,
      projectId,
      scriptId,
      scriptRevisionId: revision.id,
      doc: revision.doc,
      legacyPlan,
      characters: loadCharacters(projectId),
      dialogues: loadActiveDialogues(scriptId),
      providerId,
      globalLoras: loras,
      dialoguePolicy,
      resolveLayoutTemplate,
      beatAnnotation: beatAnnotation ? { units: beatAnnotation.units, beats: beatAnnotation.beats } : null,
      balloonCenterHints: candidateBalloonHints
    });
  }
  const validation = validatePlan(plan);
  if (!validation.ok) throw new HttpError(422, "Generated MangaPlanV2 failed deterministic validation");
  const maxPanelCount = boundedInteger(input.maxPanelCount, predecessorConfig?.maxPanelCount ?? 0, 0, 800);
  requirePanelBudget(plan, maxPanelCount);
  requireDialogueBudget(plan, planOptions.maxDialoguesPerPanel ?? DEFAULT_MAX_DIALOGUES_PER_PANEL);
  requirePagePanelBudget(plan, planOptions.panelsPerPage ?? 4);
  persistPlan(projectId, plan, validation);

  const generateImages = typeof input.generateImages === "boolean"
    ? input.generateImages
    : predecessorConfig?.generateImages ?? true;
  const poseControl = input.poseControl === undefined
    ? predecessorConfig?.poseControl
    : parsePoseControlInput(input.poseControl);
  const config: ScriptMangaRunConfig = {
    templateId,
    providerId,
    batchSize: 1,
    // 外部agentが演出済みの候補は、そのdirectionを固定して組み込み監督を重ねない。
    planningMode: predecessor
      ? "provided"
      : planCandidateId
        ? candidatePlanningMode
        : planningMode,
    pageLimit,
    maxPanelCount,
    loras,
    generateImages,
    candidateSelectionPolicy,
    auditMode,
    longEdge: typeof input.longEdge === "number" ? input.longEdge : predecessorConfig?.longEdge ?? 1024,
    steps: typeof input.steps === "number" ? input.steps : predecessorConfig?.steps ?? 20,
    cfg: typeof input.cfg === "number" ? input.cfg : predecessorConfig?.cfg ?? 5,
    sampler: stringOr(input.sampler, predecessorConfig?.sampler ?? "euler"),
    scheduler: stringOr(input.scheduler, predecessorConfig?.scheduler ?? "beta"),
    planOptions,
    requireReferenceSets: typeof input.requireReferenceSets === "boolean"
      ? input.requireReferenceSets
      : predecessorConfig?.requireReferenceSets ?? (providerId === "comfy" && generateImages),
    allowReferenceFallback: typeof input.allowReferenceFallback === "boolean"
      ? input.allowReferenceFallback
      : predecessorConfig?.allowReferenceFallback ?? false,
    ...(poseControl ? { poseControl } : {}),
    ...(planCandidateId ? { planCandidateId } : {})
  };
  const predecessorBudget = predecessor
    ? parseJson<{ maxAttemptsPerPanel?: number; maxConcurrentSubmissions?: number }>(predecessor.generation_budget_json, {})
    : {};
  const generationBudget = {
    maxAttemptsPerPanel: predecessorBudget.maxAttemptsPerPanel ?? 3,
    maxConcurrentSubmissions: predecessorBudget.maxConcurrentSubmissions ?? 1,
    candidateSelectionPolicy,
    auditMode
  };
  const runId = createId("manga");
  runSql(
    `INSERT INTO script_manga_runs
       (id, predecessor_run_id, project_id, script_id, script_revision_id, plan_id, plan_version, planner_version,
        prompt_compiler_version, status, phase, approval_status, page_count, panel_count, config_json, generation_budget_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', 'planning', 'pending', ?, ?, ?, ?)`,
    [
      runId,
      predecessor?.id ?? null,
      projectId,
      scriptId,
      revision.id,
      plan.id,
      plan.version,
      plan.plannerVersion,
      plan.promptCompilerVersion,
      plan.pages.length,
      plan.panelCount,
      JSON.stringify(config),
      JSON.stringify(generationBudget)
    ]
  );
  try {
    materializeRun(runId);
    if (generateImages) {
      approveScriptMangaRun(runId);
      await startScriptMangaRun(runId);
    }
  } catch (error) {
    runSql(
      `UPDATE script_manga_runs SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP,
       completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [errorJson(error), runId]
    );
    throw error;
  }
  // run 準備が成立した時点で候補を採用済みとして記録する(履歴は ranker の学習データにもなる)。
  if (planCandidateId) markPlanCandidateAdopted(planCandidateId, runId);
  return runView(refreshRunStatus(runId));
}

export function getScriptMangaPlan(planId: string): ScriptMangaPlanView {
  return planView(requirePlan(planId));
}

/**
 * V5 D6: スタジオ用のホワイトリスト差分編集(POST /api/script-manga-plans/:id/edits)。
 * クライアント保持のV2全体を送り返させない(ライブ更新+エージェント併走で dialogueSnapshots/
 * provenance まで lost update するため)。サーバー保存済みplanへ差分を適用し、既存の完全更新
 * フロー(凍結復元・決定的再検証・run巻き戻し・同期materialize・edit_version加算)へ委譲する。
 */
export function applyNamePlanEdits(planId: string, body: unknown): ScriptMangaPlanView {
  const input = objectBody(body);
  const row = requirePlan(planId);
  if (typeof input.expectedVersion !== "number" || !Number.isInteger(input.expectedVersion)) {
    throw new HttpError(400, "expectedVersion is required (optimistic lock)");
  }
  if (input.expectedVersion !== row.edit_version) {
    throw new HttpError(409, "Plan was modified concurrently; reload and retry");
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new HttpError(400, "edits must be a non-empty array");
  }
  const plan = planFromRow(row);
  if (!plan) throw new HttpError(500, "Stored plan is invalid JSON");
  const pageByIndex = new Map(plan.pages.map((page) => [page.index, page]));
  const panelById = new Map(plan.pages.flatMap((page) => page.panels.map((panel) => [panel.id, panel] as const)));
  const shotSizes = new Set(["extreme-wide", "wide", "medium", "close-up", "insert"]);
  const editedText = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${field} must be a non-empty string`);
    return value.trim();
  };
  for (const rawEdit of input.edits as unknown[]) {
    if (!rawEdit || typeof rawEdit !== "object") throw new HttpError(400, "edits contains a malformed entry");
    const edit = rawEdit as Record<string, unknown>;
    if (edit.kind === "page") {
      const page = typeof edit.pageIndex === "number" ? pageByIndex.get(edit.pageIndex) : undefined;
      if (!page) throw new HttpError(400, `page ${String(edit.pageIndex)} was not found`);
      page.pageIntent = editedText(edit.pageIntent, "pageIntent");
      continue;
    }
    if (edit.kind === "panel" || edit.kind === "cast") {
      const panel = typeof edit.panelId === "string" ? panelById.get(edit.panelId) : undefined;
      if (!panel) throw new HttpError(400, `panel ${String(edit.panelId)} was not found`);
      if (edit.kind === "panel") {
        if (edit.shotSize !== undefined) {
          if (typeof edit.shotSize !== "string" || !shotSizes.has(edit.shotSize)) {
            throw new HttpError(400, "shotSize must be one of extreme-wide/wide/medium/close-up/insert");
          }
          panel.shot.size = edit.shotSize as PanelSpec["shot"]["size"];
        }
        if (edit.shotAngle !== undefined) panel.shot.angle = editedText(edit.shotAngle, "shotAngle");
        if (edit.compositionIntent !== undefined) panel.shot.compositionIntent = editedText(edit.compositionIntent, "compositionIntent");
        if (edit.promptBase !== undefined) panel.promptBase = editedText(edit.promptBase, "promptBase");
      } else {
        const member = typeof edit.characterId === "string"
          ? panel.cast.find((candidateMember) => candidateMember.characterId === edit.characterId)
          : undefined;
        if (!member) throw new HttpError(400, `cast member ${String(edit.characterId)} was not found on panel ${panel.id}`);
        if (edit.expression !== undefined) member.expression = editedText(edit.expression, "expression");
        if (edit.action !== undefined) member.action = editedText(edit.action, "action");
      }
      panel.directionSource = "human";
      continue;
    }
    if (edit.kind === "pose") {
      const panel = typeof edit.panelId === "string" ? panelById.get(edit.panelId) : undefined;
      if (!panel) throw new HttpError(400, `panel ${String(edit.panelId)} was not found`);
      const characterId = typeof edit.characterId === "string" ? edit.characterId : "";
      if (!panel.cast.some((member) => member.characterId === characterId)) {
        throw new HttpError(400, `cast member ${String(edit.characterId)} was not found on panel ${panel.id}`);
      }
      if (edit.joints === undefined && edit.depth === undefined) {
        throw new HttpError(400, "pose edit requires joints and/or depth");
      }
      const validPoseJoint = (joint: unknown): joint is { x: number; y: number; visible: boolean } => {
        if (!joint || typeof joint !== "object") return false;
        const candidate = joint as { x?: unknown; y?: unknown; visible?: unknown };
        return (
          typeof candidate.x === "number" && Number.isFinite(candidate.x) && candidate.x >= -1 && candidate.x <= 2 &&
          typeof candidate.y === "number" && Number.isFinite(candidate.y) && candidate.y >= -1 && candidate.y <= 2 &&
          typeof candidate.visible === "boolean"
        );
      };
      const poses = panel.castPoses ?? [];
      if (edit.joints === null) {
        // 骨格の削除。depth 併記は無視(消えた骨格に深度は無い)。
        panel.castPoses = poses.filter((pose) => pose.characterId !== characterId);
        if (panel.castPoses.length === 0) delete panel.castPoses;
        panel.directionSource = "human";
        continue;
      }
      let pose = poses.find((candidatePose) => candidatePose.characterId === characterId);
      if (edit.joints !== undefined) {
        const joints = edit.joints;
        if (!Array.isArray(joints) || joints.length !== OPENPOSE_JOINT_COUNT || !joints.every(validPoseJoint)) {
          throw new HttpError(400, `joints must be ${OPENPOSE_JOINT_COUNT} panel-local points with x/y in [-1, 2] and boolean visible`);
        }
        const nextJoints = (joints as Array<{ x: number; y: number; visible: boolean }>)
          .map((joint) => ({ x: joint.x, y: joint.y, visible: joint.visible }));
        if (!pose) {
          pose = { characterId, depth: poses.length, joints: nextJoints, source: "human" };
          poses.push(pose);
          panel.castPoses = poses;
        } else {
          pose.joints = nextJoints;
          pose.source = "human";
        }
      }
      if (edit.depth !== undefined) {
        if (typeof edit.depth !== "number" || !Number.isFinite(edit.depth)) {
          throw new HttpError(400, "depth must be a finite number");
        }
        if (!pose) throw new HttpError(400, `no pose exists for ${characterId} on panel ${panel.id}; send joints to create one`);
        pose.depth = edit.depth;
        pose.source = "human";
      }
      panel.directionSource = "human";
      continue;
    }
    throw new HttpError(400, 'edit.kind must be "page", "panel", "cast", or "pose"');
  }
  return updateScriptMangaPlan(planId, { plan });
}

export function updateScriptMangaPlan(planId: string, body: unknown): ScriptMangaPlanView {
  const row = requirePlan(planId);
  const input = objectBody(body);
  const candidate = (input.plan ?? body) as MangaPlanV2;
  if (!candidate || typeof candidate !== "object" || candidate.version !== 2 || !Array.isArray(candidate.pages) || !candidate.narrativeGraph) {
    throw new HttpError(400, "A complete MangaPlanV2 object is required");
  }
  const runRows = getRows<RunRow>("SELECT * FROM script_manga_runs WHERE plan_id = ?", [planId]);
  if (runRows.some((run) => run.approval_status === "approved" || run.status === "running" || run.status === "awaiting_review")) {
    throw new HttpError(409, "Approved or running plans cannot be edited; create a new run or cancel it first");
  }
  // V5 D1: 完全V2 PATCH もDB非経由の生API入力 = 旧語彙adapterの適用境界。
  normalizeMangaPlanV2Scales(candidate);
  candidate.id = row.id;
  candidate.scriptId = row.script_id;
  candidate.scriptRevisionId = row.script_revision_id;
  const originalPlan = planFromRow(row);
  const originalPages = new Map(originalPlan.pages.map((page) => [page.index, page]));
  candidate.pages = candidate.pages.map((page) => {
    const originalPage = originalPages.get(page.index);
    const snapshot = originalPage?.layoutTemplateId === page.layoutTemplateId
      ? originalPage.layoutSnapshot
      : resolveLayoutTemplate(page.layoutTemplateId);
    if (!snapshot) throw new HttpError(422, `Layout template could not be resolved: ${page.layoutTemplateId}`);
    return { ...page, layoutSnapshot: clonePageLayout(snapshot) };
  });
  candidate.sourceDialogueLineIds = [...originalPlan.sourceDialogueLineIds];
  candidate.dialogueSnapshots = originalPlan.dialogueSnapshots.map((snapshot) => ({ ...snapshot }));
  candidate.dialoguePolicy = originalPlan.dialoguePolicy;
  candidate.plannerVersion = row.planner_version;
  candidate.promptCompilerVersion = row.prompt_compiler_version;
  candidate.plannerProvenance = originalPlan.plannerProvenance;
  restoreFrozenPlanSources(candidate, originalPlan);
  candidate.createdAt = originalPlan.createdAt;
  let validation: MangaPlanValidationReport;
  try {
    validation = validatePlan(candidate);
  } catch {
    throw new HttpError(400, "Malformed MangaPlanV2 object");
  }
  if (!validation.ok) throw new HttpError(422, "Edited MangaPlanV2 failed deterministic validation");
  for (const run of runRows) requireRunPanelBudget(run, candidate);
  runSql("BEGIN IMMEDIATE");
  try {
    runSql(
      `UPDATE script_manga_plans SET plan_json = ?, validation_json = ?, dialogue_policy = ?, status = 'draft',
         approved_at = NULL, edit_version = edit_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [JSON.stringify(candidate), JSON.stringify(validation), candidate.dialoguePolicy, planId]
    );
    for (const run of runRows) {
      const pageIds = getRows<{ page_id: string }>("SELECT page_id FROM script_manga_run_pages WHERE run_id = ?", [run.id]).map((item) => item.page_id);
      for (const pageId of pageIds) runSql("DELETE FROM pages WHERE id = ?", [pageId]);
      runSql(
        `UPDATE script_manga_runs SET status = 'preparing', phase = 'planning', approval_status = 'pending', page_count = ?,
         panel_count = ?, completed_count = 0, failed_count = 0, evaluation_json = NULL, completed_at = NULL,
         last_error_json = NULL, reference_snapshot_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [candidate.pages.length, candidate.panelCount, run.id]
      );
      materializeRun(run.id);
    }
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    throw error;
  }
  return planView(requirePlan(planId));
}

export function approveScriptMangaRun(runId: string): ScriptMangaRunView {
  const run = requireRun(runId);
  if (run.status === "canceled") throw new HttpError(409, "Canceled runs cannot be approved");
  if (!run.plan_id) throw new HttpError(409, "Run has no persisted plan");
  const plan = requirePlan(run.plan_id);
  const validation = parseJson<MangaPlanValidationReport>(plan.validation_json, { ok: false, issues: [] });
  if (!validation.ok) throw new HttpError(422, "Plan validation must pass before approval");
  const mangaPlan = planFromRow(plan);
  requireRunPanelBudget(run, mangaPlan);
  const snapshot = collectReferenceSnapshot(run, mangaPlan, parseConfig(run));
  runSql("BEGIN");
  try {
    runSql("UPDATE script_manga_plans SET status = 'approved', approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [plan.id]);
    runSql(
      `UPDATE script_manga_runs SET status = 'approved', phase = 'preparing_references', approval_status = 'approved',
       reference_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [snapshot ? JSON.stringify(snapshot) : null, run.id]
    );
    // Re-materialize inside the approval transaction so every task is compiled and preflighted
    // against the newly frozen Reference Set snapshot before approval becomes visible.
    materializeRun(run.id);
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    throw error;
  }
  return runView(requireRun(run.id));
}

export async function startScriptMangaRun(runId: string): Promise<ScriptMangaRunView> {
  const run = requireRun(runId);
  if (run.approval_status !== "approved") throw new HttpError(409, "Approve the prepared run before starting generation");
  if (run.status === "canceled") throw new HttpError(409, "Canceled runs cannot be started");
  if (!run.plan_id) throw new HttpError(409, "Run has no persisted plan");
  requireRunPanelBudget(run, planFromRow(requirePlan(run.plan_id)));
  recoverInheritingTasks(run.id);
  recoverSelectingTasks(run.id);
  materializeRun(run.id);
  await inheritSelectedTasks(run.id);
  await submitTasks(run.id);
  return runView(refreshRunStatus(run.id));
}

export async function resumeScriptMangaRun(runId: string): Promise<ScriptMangaRunView> {
  const run = requireRun(runId);
  if (run.status === "canceled") throw new HttpError(409, "Canceled runs cannot be resumed");
  if (run.approval_status === "approved") {
    if (!run.plan_id) throw new HttpError(409, "Run has no persisted plan");
    requireRunPanelBudget(run, planFromRow(requirePlan(run.plan_id)));
  }
  recoverSubmittingTasks(run.id);
  recoverInheritingTasks(run.id);
  recoverSelectingTasks(run.id);
  materializeRun(run.id);
  await inheritSelectedTasks(run.id);
  for (const task of getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'running'", [run.id])) {
    if (task.round_id) ensureRoundMonitor(task.round_id);
  }
  if (run.approval_status === "approved") await submitTasks(run.id);
  return getScriptMangaRun(run.id);
}

export async function cancelScriptMangaRun(runId: string): Promise<ScriptMangaRunView> {
  const run = requireRun(runId);
  const roundIds = getRows<{ round_id: string }>(
    "SELECT round_id FROM script_manga_tasks WHERE run_id = ? AND status IN ('submitting', 'running') AND round_id IS NOT NULL",
    [run.id]
  ).map((row) => row.round_id);
  // Close every local commit/submit gate before awaiting a provider. An interrupt can take an
  // arbitrary amount of time; leaving the run active during that wait admits new work which was
  // not present in roundIds and therefore would escape this cancellation.
  runSql(
    `UPDATE script_manga_runs SET status = 'canceled', phase = 'canceled', completed_at = CURRENT_TIMESTAMP,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [run.id]
  );
  runSql(
    "UPDATE script_manga_tasks SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE run_id = ? AND status NOT IN ('completed', 'failed')",
    [run.id]
  );
  for (const roundId of roundIds) {
    try {
      await interruptRound(roundId);
    } catch {
      // Run cancellation remains authoritative even if a provider is temporarily unreachable.
    }
  }
  return runView(requireRun(run.id));
}

export async function retryScriptMangaTask(taskId: string): Promise<ScriptMangaRunView> {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  if (run.approval_status !== "approved" || run.status === "canceled") throw new HttpError(409, "Task cannot be retried in the current run state");
  if (task.status !== "failed" && task.status !== "blocked" && task.status !== "awaiting_review") {
    throw new HttpError(409, "Only failed, blocked, or unselected review tasks can be retried");
  }
  const budget = parseJson<{ maxAttemptsPerPanel?: number }>(run.generation_budget_json, {});
  if (task.attempt_count >= (budget.maxAttemptsPerPanel ?? 3)) throw new HttpError(409, "Task generation budget is exhausted");
  const previousScores = parseJson<{ preflight?: unknown }>(task.scores_json, {});
  const reset = runSql(
    `UPDATE script_manga_tasks SET status = 'pending', round_id = NULL, asset_id = NULL, selected_asset_id = NULL,
     inherited_from_task_id = NULL, reuse_fingerprint = NULL, reuse_source_json = NULL,
     candidate_asset_ids_json = '[]', scores_json = ?, last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status IN ('failed', 'blocked', 'awaiting_review')
       AND EXISTS (
         SELECT 1 FROM script_manga_runs r
         WHERE r.id = script_manga_tasks.run_id AND r.approval_status = 'approved' AND r.status <> 'canceled'
       )`,
    [JSON.stringify({ preflight: previousScores.preflight ?? null }), task.id]
  ) as { changes?: number };
  if (reset.changes !== 1) throw new HttpError(409, "Task stopped accepting the retry request");
  runSql(
    `UPDATE script_manga_runs SET status = 'running', phase = 'repairing', completed_at = NULL,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [run.id]
  );
  await submitTasks(run.id, [task.id]);
  return runView(refreshRunStatus(run.id));
}

interface RepairParentAssetRow {
  id: string;
  project_id: string;
  round_id: string;
  width: number | null;
  height: number | null;
  seed: number | null;
  workflow_template_id: string;
  workflow_template_version: number;
  workflow_snapshot_hash: string;
  request_json: string;
  provider_id: string;
}

function attachmentMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function repairAttachmentDataUrl(roundId: string, kind: RoundAttachmentKind): Promise<string> {
  try {
    const path = resolveRoundAttachmentPath(roundId, kind);
    const bytes = await readFile(path);
    return `data:${attachmentMimeType(path)};base64,${bytes.toString("base64")}`;
  } catch {
    throw new HttpError(409, `The parent candidate ${kind} attachment could not be reproduced`);
  }
}

/**
 * Repair one persisted candidate in-place while retaining the old candidate set. The caller may
 * supply only the mask controls; all story and generation conditioning is frozen from the parent.
 */
export async function repairScriptMangaTask(taskId: string, body: unknown): Promise<ScriptMangaRunView> {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  if (run.approval_status !== "approved" || run.status === "canceled") {
    throw new HttpError(409, "Task cannot be repaired in the current run state");
  }
  if (task.status !== "awaiting_review") {
    throw new HttpError(409, "Only an unselected candidate review task can be repaired");
  }
  const repair = parseScriptMangaRepairRequest(body);
  const candidateIds = parseJson<string[]>(task.candidate_asset_ids_json, []);
  if (!candidateIds.includes(repair.assetId)) {
    throw new HttpError(400, "Asset is not in the persisted candidate set");
  }
  const budget = parseJson<{ maxAttemptsPerPanel?: number }>(run.generation_budget_json, {});
  if (task.attempt_count >= (budget.maxAttemptsPerPanel ?? 3)) {
    throw new HttpError(409, "Task generation budget is exhausted");
  }

  const parent = getRow<RepairParentAssetRow>(
    `SELECT a.id, a.project_id, a.round_id, a.width, a.height, a.seed,
            a.workflow_template_id, a.workflow_template_version, a.workflow_snapshot_hash,
            r.request_json, r.provider_id
     FROM assets a
     JOIN generation_rounds r ON r.id = a.round_id
     WHERE a.id = ? AND a.project_id = ? AND r.script_manga_task_id = ?`,
    [repair.assetId, run.project_id, task.id]
  );
  if (!parent) throw new HttpError(400, "Asset is not a candidate generated for this task");
  const currentTemplate = getRow<{ id: string; version: number; workflow_hash: string }>(
    "SELECT id, version, workflow_hash FROM workflow_templates WHERE id = ? AND deleted_at IS NULL",
    [parent.workflow_template_id]
  );
  if (
    !currentTemplate ||
    currentTemplate.version !== parent.workflow_template_version ||
    currentTemplate.workflow_hash !== parent.workflow_snapshot_hash
  ) {
    throw new HttpError(409, "The parent candidate workflow revision is no longer available for exact repair");
  }
  const parentRequest = parseJson<GenerationRequest | null>(parent.request_json, null);
  if (!parentRequest || parentRequest.templateId !== parent.workflow_template_id) {
    throw new HttpError(409, "The parent candidate generation request is not reproducible");
  }

  const poseImageDataUrl = parentRequest.controlnet
    ? typeof parentRequest.controlnet.poseImageDataUrl === "string" && parentRequest.controlnet.poseImageDataUrl
      ? parentRequest.controlnet.poseImageDataUrl
      : await repairAttachmentDataUrl(parent.round_id, "pose")
    : null;
  const hasPinnedReferenceSet = Boolean(
    parentRequest.reference?.referenceSet?.setId && parentRequest.reference.referenceSet.version > 0
  );
  const usesUnpinnedReference = Boolean(
    parentRequest.reference &&
    !hasPinnedReferenceSet &&
    (
      parentRequest.reference.imageDataUrl ||
      parentRequest.reference.imagePath ||
      parentRequest.reference.images?.facePath ||
      parentRequest.reference.characterBinding
    )
  );
  const referenceImageDataUrl = usesUnpinnedReference
    ? typeof parentRequest.reference?.imageDataUrl === "string" && parentRequest.reference.imageDataUrl
      ? parentRequest.reference.imageDataUrl
      : await repairAttachmentDataUrl(parent.round_id, "reference")
    : null;
  const request = buildScriptMangaRepairGenerationRequest({
    assetId: parent.id,
    width: parent.width ?? 0,
    height: parent.height ?? 0,
    seed: parent.seed,
    providerId: parent.provider_id,
    request: parentRequest,
    poseImageDataUrl,
    referenceImageDataUrl
  }, repair);

  const previousScores = parseJson<Record<string, unknown>>(task.scores_json, {});
  const previousRepairs = Array.isArray(previousScores.repairs) ? previousScores.repairs : [];
  const claimed = runSql(
    `UPDATE script_manga_tasks SET status = 'submitting', round_id = NULL,
       attempt_count = attempt_count + 1, last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'awaiting_review'`,
    [task.id]
  ) as { changes?: number };
  if (claimed.changes !== 1) throw new HttpError(409, "Task is no longer awaiting candidate review");
  runSql(
    `UPDATE script_manga_runs SET status = 'running', phase = 'repairing', completed_at = NULL,
       last_error_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'canceled'`,
    [run.id]
  );

  activeTaskSubmissions.add(task.id);
  let createdRoundId: string | null = null;
  try {
    const created = await createGenerationRound(run.project_id, request, task.page_id, task.panel_id, task.id);
    if (!created.round) throw new Error("Repair generation round was not created");
    createdRoundId = created.round.id;
    const latestRun = requireRun(run.id);
    const latestTask = requireTask(task.id);
    if (latestRun.status === "canceled" || latestTask.status === "canceled") {
      try {
        await interruptRound(createdRoundId);
      } catch {
        // Cancellation remains authoritative; provider cleanup is best effort.
      }
      return runView(requireRun(run.id));
    }
    const repairs = [
      ...previousRepairs,
      {
        roundId: createdRoundId,
        parentAssetId: parent.id,
        denoise: repair.denoise,
        maskedContent: repair.inpaint.maskedContent,
        onlyMaskedPadding: repair.inpaint.onlyMaskedPadding,
        featherRadius: repair.inpaint.featherRadius,
        createdAt: new Date().toISOString()
      }
    ];
    const updated = runSql(
      `UPDATE script_manga_tasks SET round_id = ?, status = 'running', scores_json = ?,
         updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'submitting'`,
      [createdRoundId, JSON.stringify({ ...previousScores, repairs }), task.id]
    ) as { changes?: number };
    if (updated.changes !== 1) {
      try {
        await interruptRound(createdRoundId);
      } catch {
        // The task CAS failure is the primary error.
      }
      throw new HttpError(409, "Task stopped accepting the repair generation round");
    }
  } catch (error) {
    runSql(
      `UPDATE script_manga_tasks SET status = 'awaiting_review', round_id = ?, attempt_count = ?,
         scores_json = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'submitting'`,
      [task.round_id, task.attempt_count, task.scores_json, errorJson(error), task.id]
    );
    runSql(
      "UPDATE script_manga_runs SET last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'canceled'",
      [JSON.stringify({ message: error instanceof Error ? error.message : String(error), phase: "repairing" }), run.id]
    );
    refreshRunStatus(run.id);
    throw error;
  } finally {
    activeTaskSubmissions.delete(task.id);
  }
  return runView(refreshRunStatus(run.id));
}

export async function selectScriptMangaTaskCandidate(taskId: string, body: unknown): Promise<ScriptMangaRunView> {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  const input = objectBody(body);
  const assetId = requiredString(input.assetId, "assetId");
  if (run.approval_status !== "approved" || run.status === "canceled") {
    throw new HttpError(409, "Task cannot accept candidate selection in the current run state");
  }
  if (task.status !== "awaiting_review") throw new HttpError(409, "Task is not awaiting candidate review");
  const candidates = parseJson<string[]>(task.candidate_asset_ids_json, []);
  if (!candidates.includes(assetId)) throw new HttpError(400, "Asset is not in the persisted candidate set");
  const auditMode = parseConfig(run).auditMode;
  if (auditMode === "manual") {
    const scores = parseJson<{
      externalAudit?: { reports?: Array<{ assetId?: string; passed?: boolean }> };
    }>(task.scores_json, {});
    const report = scores.externalAudit?.reports?.find((candidate) => candidate.assetId === assetId);
    if (report?.passed === false) {
      throw new HttpError(409, "The selected candidate failed external audit; repair or regenerate this panel");
    }
  }
  if (auditMode === "vlm") {
    const scores = parseJson<{ vlmAudit?: { state?: string; reports?: Array<{ assetId?: string; passed?: boolean }> } }>(
      task.scores_json,
      {}
    );
    const report = scores.vlmAudit?.reports?.find((candidate) => candidate.assetId === assetId);
    if (scores.vlmAudit?.state !== "completed" || !report) {
      throw new HttpError(409, "The selected candidate must complete VLM audit before selection");
    }
    if (report.passed !== true) {
      throw new HttpError(409, "The selected candidate failed VLM audit; repair or regenerate this panel");
    }
  }
  const claimed = runSql(
    `UPDATE script_manga_tasks SET status = 'selecting', last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'awaiting_review'
       AND EXISTS (
         SELECT 1 FROM script_manga_runs r
         WHERE r.id = script_manga_tasks.run_id AND r.approval_status = 'approved' AND r.status <> 'canceled'
       )`,
    [task.id]
  ) as { changes?: number };
  if (claimed.changes !== 1) throw new HttpError(409, "Task is no longer awaiting candidate review");
  activeTaskSelections.add(task.id);
  try {
    await persistSelectedTaskReuseSource(task, assetId);
    const latestTask = requireTask(task.id);
    const layout = pageLayout(latestTask.page_id);
    const layoutPanel = layout.panels.find((panel) => panel.id === latestTask.panel_id);
    let skipPanelAssignment = false;
    if (layoutPanel?.role === "figure") {
      try {
        const result = await materializeFigureForTask(latestTask, assetId, {
          canCommit: () => {
            const latestRun = requireRun(task.run_id);
            const currentTask = requireTask(task.id);
            return latestRun.status !== "canceled" && currentTask.status === "selecting";
          }
        });
        skipPanelAssignment = result.committed && result.mode === "cutout";
      } catch (error) {
        // 切り抜き失敗時も通常のコマ割当で採用できるようにし、原因は evaluation に残す。
        recordFigureResult(task.run_id, task.id, {
          state: "failed",
          assetId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    selectTaskCandidateInternal(task, assetId, { skipPanelAssignment });
  } catch (error) {
    runSql(
      `UPDATE script_manga_tasks SET status = 'awaiting_review', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'selecting'
         AND EXISTS (SELECT 1 FROM script_manga_runs r WHERE r.id = script_manga_tasks.run_id AND r.status <> 'canceled')`,
      [task.id]
    );
    throw error;
  } finally {
    activeTaskSelections.delete(task.id);
  }
  return runView(refreshRunStatus(task.run_id));
}

/** Exports only the pages owned by a fully reviewed run and persists a reproducible manifest. */
export async function withScriptMangaRunExport<T>(
  runId: string,
  body: unknown,
  operation: (artifact: ImageExportResult | OpenRasterExportResult) => Promise<T>
): Promise<T> {
  const run = refreshRunStatus(runId);
  if (run.status !== "completed") {
    throw new HttpError(409, "Every panel candidate must be generated and selected before exporting this run");
  }
  const pageIds = getRows<{ page_id: string }>(
    "SELECT page_id FROM script_manga_run_pages WHERE run_id = ? ORDER BY page_index ASC",
    [run.id]
  ).map((row) => row.page_id);
  if (pageIds.length !== run.page_count) throw new HttpError(409, "Run-owned export pages are incomplete");
  const input = objectBody(body);
  const format = stringOr(input.format, "png").toLowerCase();
  runSql(
    "UPDATE script_manga_runs SET status = 'exporting', phase = 'exporting', last_error_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [run.id]
  );
  try {
    const completeExport = async (result: ImageExportResult | OpenRasterExportResult) => {
      const manifest = {
        format,
        filename: result.filename,
        contentType: result.contentType,
        pageCount: result.pageCount,
        pageIds,
        createdAt: new Date().toISOString()
      };
      runSql(
        `UPDATE script_manga_runs SET status = 'completed', phase = 'completed', export_manifest_json = ?,
           last_error_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify(manifest), run.id]
      );
      return operation(result);
    };
    return format === "ora"
      ? await withOpenRasterExport(run.project_id, { pageIds }, completeExport)
      : await withImageExport(
          run.project_id,
          { pageIds, format, pixelWidth: input.pixelWidth, quality: input.quality },
          completeExport
        );
  } catch (error) {
    runSql(
      `UPDATE script_manga_runs SET status = 'completed', phase = 'completed', last_error_json = ?,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [errorJson(error), run.id]
    );
    throw error;
  }
}

/** Pull round state into persisted candidate/audit state. GET polling is idempotent. */
export function getScriptMangaRun(runId: string): ScriptMangaRunView {
  const run = requireRun(runId);
  recoverSubmittingTasks(run.id);
  recoverInheritingTasks(run.id);
  recoverSelectingTasks(run.id);
  const config = parseConfig(run);
  for (const task of getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ?", [run.id])) {
    syncTaskFromRound(task, config);
  }
  scheduleRunVisualAudit(run.id);
  return runView(refreshRunStatus(run.id));
}
