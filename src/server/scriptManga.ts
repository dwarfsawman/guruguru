import type { FountainDoc } from "../shared/fountain";
import {
  type DialoguePolicy,
  type FrozenDialogueLine,
  type MangaPlanV2,
  type MangaPlanValidationReport,
  type NormalizedBox,
  type PanelSpec,
  validateMangaPlanV2
} from "../shared/mangaPlanV2";
import { normalizeEditedPageLayout, panelBounds, panelBoundsSize, type PageLayout } from "../shared/pageLayout";
import { planScriptManga, type ScriptMangaPlanOptions } from "../shared/scriptMangaPlan";
import { validateProvidedScriptMangaPlan } from "../shared/scriptMangaProvidedPlan";
import type { GenerationRequest, StyleLoraSelection } from "../shared/types";
import type { ScriptMangaPlanView, ScriptMangaRunView, ScriptMangaTaskView } from "../shared/scriptMangaApi";
import type { DialogueBalloonStyle, DialogueSemanticKind, PageRow } from "../shared/apiTypes";
import type { ReferenceModelFamily, ScriptMangaReferenceSnapshot } from "../shared/referenceSets";
import { referenceSnapshotKey } from "../shared/referenceSets";
import { updateAssetStatus } from "./assets";
import { constrainBalloonTailTipToBounds, initialBalloonTailTip } from "../shared/balloonTailAim";
import { balloonContentMaxWidth, balloonInscribedFactor } from "../shared/balloonShape";
import { CONTENT_PADDING_RATIO } from "../shared/pageObjects";
import { computeTextLayoutForContent } from "./textLayoutApi";
import { orderPanelsByReadingDirection } from "../shared/dialogueAutoLayout";
import { normalizePageObjects, type BalloonObject, type ImageObject } from "../shared/pageObjects";
import { splitDialogueUnits, type DialogueUnit } from "../shared/dialogueAdaptation";
import { auditLettering } from "../shared/letteringQuality";
import { isMangaEffectObject } from "../shared/mangaEffects";
import { fitPageBalloonText } from "./balloonTextFit";
import { compilePanelConditioning } from "./panelPromptCompiler";
import { inferPromptProfile } from "./templates";
import { releaseComfyModelsForAudit } from "./comfy";
import { createId, getRow, getRows, runSql, toApiRow } from "./db";
import { allocateDialoguePages } from "./dialogueAllocation";
import { applyDialogueLayout, reflowDialogueLayout } from "./dialogueAutoLayoutApi";
import { cutoutFigure } from "./figureCutout";
import { createPageMediaFromBuffer, deletePageMedia } from "./pageMedia";
import { upsertPanelAssignment } from "./panelAssignments";
import { HttpError } from "./http";
import { resolveLayoutTemplate } from "./layoutTemplates";
import { createPage, updatePage } from "./pages";
import { validatePanelPreflight, type PanelPreflightReport } from "./panelPreflightValidator";
import { evaluatePanelCandidate } from "./panelVisualEvaluator";
import { evaluateDeterministicPanelQuality } from "./deterministicPanelQuality";
import { resolvePanelReferences } from "./referenceResolver";
import { createGenerationRound, ensureRoundMonitor, interruptRound } from "./rounds";
import { createImageExport, type ImageExportResult } from "./imageExport";
import { createOpenRasterExport, type OpenRasterExportResult } from "./openRasterExport";
import { planScriptMangaWithDirector } from "./scriptMangaDirector";
import { buildMangaPlanV2 } from "./scriptMangaPlanV2";
import { acquireVlmModel, getVlmAuditSettings, releaseVlmModel } from "./vlmAudit";
import type { StoryGraphCharacterInput, StoryGraphDialogueInput } from "./storyGraphBuilder";
import { objectBody, requiredString, stringOr } from "./validate";

interface RunRow {
  id: string;
  project_id: string;
  script_id: string;
  script_revision_id: string | null;
  plan_id: string | null;
  plan_version: number;
  planner_version: string;
  prompt_compiler_version: string;
  status: string;
  phase: string;
  approval_status: string;
  page_count: number;
  panel_count: number;
  completed_count: number;
  failed_count: number;
  config_json: string;
  evaluation_json: string | null;
  export_manifest_json: string | null;
  generation_budget_json: string;
  reference_snapshot_json: string | null;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface TaskRow {
  id: string;
  run_id: string;
  page_id: string;
  panel_id: string;
  round_id: string | null;
  prompt: string;
  panel_spec_json: string | null;
  reference_manifest_json: string;
  candidate_asset_ids_json: string;
  selected_asset_id: string | null;
  scores_json: string | null;
  attempt_count: number;
  repair_parent_task_id: string | null;
  dependency_task_ids_json: string;
  status: string;
  asset_id: string | null;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  id: string;
  project_id: string;
  script_id: string;
  script_revision_id: string;
  plan_version: number;
  planner_version: string;
  prompt_compiler_version: string;
  dialogue_policy: string;
  status: string;
  plan_json: string;
  validation_json: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

interface ScriptMangaRunConfig {
  templateId: string;
  providerId: string;
  batchSize: 1;
  planningMode: "heuristic" | "llm" | "provided";
  pageLimit: number;
  loras: StyleLoraSelection[];
  generateImages: boolean;
  candidateSelectionPolicy: "review" | "metadata";
  auditMode: "manual" | "vlm";
  longEdge: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  planOptions: ScriptMangaPlanOptions;
  requireReferenceSets: boolean;
  allowReferenceFallback: boolean;
}

const SCRIPT_MANGA_FONT_SCALE = 0.88;
// The 0.02 hard gate rejected even 7-16 character balloons in narrow/telecom
// shapes after fitting. 0.016 remains comfortably legible at the default B5
// export size while allowing the fitter's real glyph bbox to decide whether a
// short line fits.
const SCRIPT_MANGA_MIN_FONT_SIZE = 0.016;
/**
 * 自動レタリングでの「吹き出し等がコマ外接矩形を占有してよい面積比」の上限
 * (Docs/Feature-MangaCompositions.md)。preserve の長台詞は relax パスで超過を許すが警告が残る。
 */
const SCRIPT_MANGA_MAX_BALLOON_COVERAGE = 0.45;
/** plan の cast bbox から顔領域とみなす高さ比(bbox 上端からこの割合)。auditLettering と共有。 */
const CAST_FACE_HEIGHT_RATIO = 0.38;
const activeTaskSubmissions = new Set<string>();
const activeAuditRuns = new Map<string, Promise<void>>();
let visualAuditQueue: Promise<void> = Promise.resolve();

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function errorJson(error: unknown): string {
  return JSON.stringify({ message: error instanceof Error ? error.message : String(error) });
}

function requireScript(projectId: string, scriptId: string): void {
  if (!getRow("SELECT id FROM manga_scripts WHERE id = ? AND project_id = ?", [scriptId, projectId])) {
    throw new HttpError(404, "Script was not found in this project");
  }
}

function latestRevision(scriptId: string): { id: string; doc: FountainDoc } {
  const row = getRow<{ id: string; parsed_json: string }>(
    "SELECT id, parsed_json FROM script_revisions WHERE script_id = ? ORDER BY revision DESC LIMIT 1",
    [scriptId]
  );
  if (!row) throw new HttpError(400, "Script has no Fountain revision");
  try {
    return { id: row.id, doc: JSON.parse(row.parsed_json) as FountainDoc };
  } catch {
    throw new HttpError(500, "Stored Fountain revision is invalid");
  }
}

function requireRun(runId: string): RunRow {
  const row = getRow<RunRow>("SELECT * FROM script_manga_runs WHERE id = ?", [runId]);
  if (!row) throw new HttpError(404, "Script manga run was not found");
  return row;
}

function requirePlan(planId: string): PlanRow {
  const row = getRow<PlanRow>("SELECT * FROM script_manga_plans WHERE id = ?", [planId]);
  if (!row) throw new HttpError(404, "Script manga plan was not found");
  return row;
}

function requireTask(taskId: string): TaskRow {
  const row = getRow<TaskRow>("SELECT * FROM script_manga_tasks WHERE id = ?", [taskId]);
  if (!row) throw new HttpError(404, "Script manga task was not found");
  return row;
}

function planFromRow(row: PlanRow): MangaPlanV2 {
  return parseJson<MangaPlanV2>(row.plan_json, null as unknown as MangaPlanV2);
}

function planView(row: PlanRow): ScriptMangaPlanView {
  return {
    id: row.id,
    projectId: row.project_id,
    scriptId: row.script_id,
    scriptRevisionId: row.script_revision_id,
    status: row.status,
    plan: planFromRow(row),
    validation: parseJson<MangaPlanValidationReport>(row.validation_json, { ok: false, issues: [] }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at
  };
}

function taskView(row: TaskRow): ScriptMangaTaskView {
  const selectedId = row.selected_asset_id ?? row.asset_id;
  const selectedAssetId = selectedId && getRow("SELECT id FROM assets WHERE id = ?", [selectedId]) ? selectedId : null;
  return {
    id: row.id,
    pageId: row.page_id,
    panelId: row.panel_id,
    roundId: row.round_id,
    status: row.status,
    attemptCount: row.attempt_count,
    candidateAssetIds: parseJson<string[]>(row.candidate_asset_ids_json, []),
    selectedAssetId,
    scores: parseJson<unknown>(row.scores_json, null),
    lastError: parseJson<unknown>(row.last_error_json, null)
  };
}

function runView(row: RunRow): ScriptMangaRunView {
  const planRow = row.plan_id ? getRow<PlanRow>("SELECT * FROM script_manga_plans WHERE id = ?", [row.plan_id]) : null;
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at ASC", [row.id]);
  return {
    id: row.id,
    projectId: row.project_id,
    scriptId: row.script_id,
    scriptRevisionId: row.script_revision_id,
    planId: row.plan_id,
    planVersion: row.plan_version,
    status: row.status,
    phase: row.phase,
    approvalStatus: row.approval_status,
    pageCount: row.page_count,
    panelCount: row.panel_count,
    completedCount: row.completed_count,
    failedCount: row.failed_count,
    evaluation: parseJson<unknown>(row.evaluation_json, null),
    exportManifest: parseJson<unknown>(row.export_manifest_json, null),
    generationBudget: parseJson<unknown>(row.generation_budget_json, {}),
    referenceSnapshot: parseJson<ScriptMangaReferenceSnapshot | null>(row.reference_snapshot_json, null),
    auditMode: parseConfig(row).auditMode,
    lastError: parseJson<unknown>(row.last_error_json, null),
    plan: planRow ? planFromRow(planRow) : null,
    validation: planRow ? parseJson<MangaPlanValidationReport>(planRow.validation_json, { ok: false, issues: [] }) : null,
    tasks: tasks.map(taskView),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function roundTo64(value: number): number {
  return Math.max(256, Math.round(value / 64) * 64);
}

const SDXL_BUCKETS = [[1024, 1024], [1152, 896], [896, 1152], [1216, 832], [832, 1216], [1344, 768], [768, 1344], [1536, 640], [640, 1536]] as const;

export function panelGenerationSize(layout: PageLayout, panelId: string, longEdge = 1024, family: "sdxl" | "chroma" = "sdxl"): { width: number; height: number } {
  const edge = Math.max(512, Math.min(1536, roundTo64(longEdge)));
  const panel = layout.panels.find((item) => item.id === panelId);
  if (!panel) return { width: edge, height: edge };
  const [panelWidth, panelHeight] = panelBoundsSize(panelBounds(panel.shape));
  if (panelWidth <= 0 || panelHeight <= 0) return { width: edge, height: edge };
  const ratio = panelWidth / panelHeight;
  if (family === "sdxl") {
    const bucket = SDXL_BUCKETS.reduce((best, candidate) =>
      Math.abs(Math.log(candidate[0] / candidate[1]) - Math.log(ratio)) < Math.abs(Math.log(best[0] / best[1]) - Math.log(ratio)) ? candidate : best
    );
    return { width: bucket[0], height: bucket[1] };
  }
  const clampedRatio = Math.max(0.5, Math.min(2, ratio));
  if (clampedRatio >= 1) return { width: edge, height: roundTo64(edge / clampedRatio) };
  return { width: roundTo64(edge * clampedRatio), height: edge };
}

function removeUnusedStarterPage(projectId: string): void {
  const pages = getRows<{ id: string; title: string; layout_json: string | null; objects_json: string | null }>(
    "SELECT id, title, layout_json, objects_json FROM pages WHERE project_id = ? ORDER BY page_index ASC",
    [projectId]
  );
  if (pages.length !== 1) return;
  const page = pages[0]!;
  const owned = getRow("SELECT page_id FROM script_manga_run_pages WHERE page_id = ?", [page.id]);
  const hasRound = getRow("SELECT id FROM generation_rounds WHERE page_id = ? LIMIT 1", [page.id]);
  const hasPlacement = getRow("SELECT id FROM dialogue_placements WHERE page_id = ? LIMIT 1", [page.id]);
  if (!owned && !page.title && !page.layout_json && !page.objects_json && !hasRound && !hasPlacement) {
    runSql("DELETE FROM pages WHERE id = ?", [page.id]);
  }
}

/**
 * plan の cast bbox(コマ内正規化)を page 座標へ写像した回避領域を作る。head=true なら顔領域
 * (bbox 上端から CAST_FACE_HEIGHT_RATIO)、false なら全身。ぶち抜き立ち絵スロット
 * (layoutPanel.role === "figure")は吹き出しで隠したくないため全身を返す。
 */
function planCastAvoidZones(
  pageSpec: MangaPlanV2["pages"][number],
  layoutPanels: PageLayout["panels"]
): Array<{ x: number; y: number; width: number; height: number; label?: string }> {
  return pageSpec.panels.flatMap((panel, index) => {
    const layoutPanel = layoutPanels[index];
    if (!layoutPanel) return [];
    const [x0, y0, x1, y1] = panelBounds(layoutPanel.shape);
    const fullBody = layoutPanel.role === "figure";
    return panel.cast.map((member) => ({
      x: x0 + member.bbox.x * (x1 - x0),
      y: y0 + member.bbox.y * (y1 - y0),
      width: member.bbox.width * (x1 - x0),
      height: member.bbox.height * (y1 - y0) * (fullBody ? 1 : CAST_FACE_HEIGHT_RATIO),
      label: fullBody ? "立ち絵" : "顔"
    }));
  });
}

interface LetteringConstraints {
  avoidZones: Array<{ x: number; y: number; width: number; height: number; label?: string }>;
  maxPanelCoverageRatio: number;
}

function applyDialogueLayoutWithFallback(
  projectId: string,
  pageId: string,
  placementIds: string[],
  baseSeed: number,
  constraints?: LetteringConstraints
): void {
  let lastError: unknown;
  const constraintBody = constraints
    ? { avoidZones: constraints.avoidZones, maxPanelCoverageRatio: constraints.maxPanelCoverageRatio }
    : {};
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      applyDialogueLayout(projectId, pageId, {
        placementIds,
        seed: baseSeed * 100 + attempt,
        fontScale: SCRIPT_MANGA_FONT_SCALE,
        ...constraintBody
      });
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof HttpError) || error.statusCode !== 422) throw error;
    }
  }
  for (let offset = 0; offset < placementIds.length; offset += 1) {
    const group = placementIds.slice(offset, offset + 1);
    let placed = false;
    for (const fontScale of [SCRIPT_MANGA_FONT_SCALE, 0.75, 0.62, 0.5, 0.42, 0.35]) {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        try {
          applyDialogueLayout(projectId, pageId, {
            placementIds: group,
            seed: baseSeed * 1000 + offset * 31 + attempt,
            fontScale,
            ...constraintBody
          });
          placed = true;
          break;
        } catch (error) {
          lastError = error;
          if (!(error instanceof HttpError) || error.statusCode !== 422) throw error;
        }
      }
      if (placed) break;
    }
    if (!placed) throw lastError;
  }
}

function aimInitialBalloonTails(pageId: string): void {
  const row = getRow<{ objects_json: string | null; layout_json: string | null }>("SELECT objects_json, layout_json FROM pages WHERE id = ?", [pageId]);
  const objects = normalizePageObjects(row?.objects_json ? JSON.parse(row.objects_json) : []);
  const layout = normalizeEditedPageLayout(row?.layout_json ? JSON.parse(row.layout_json) : null);
  const panelById = new Map(layout?.panels.map((panel) => [panel.id, panel]) ?? []);
  const assignedPanelByObjectId = new Map(
    getRows<{ balloon_object_id: string; panel_id: string | null }>(
      "SELECT balloon_object_id, panel_id FROM dialogue_placements WHERE page_id = ? AND balloon_object_id IS NOT NULL",
      [pageId]
    ).map((placement) => [placement.balloon_object_id, placement.panel_id])
  );
  let order = 0;
  for (const object of objects) {
    if (object.kind !== "balloon" || !object.tail) continue;
    const initialTip = initialBalloonTailTip(object.position, object.size, order);
    const panelId = assignedPanelByObjectId.get(object.id);
    const panel = panelId ? panelById.get(panelId) : undefined;
    object.tail.tip = panel ? constrainBalloonTailTipToBounds(object.position, initialTip, panelBounds(panel.shape)) : initialTip;
    order += 1;
  }
  runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [JSON.stringify(objects), pageId]);
}

function requireReadableBalloonText(pageId: string): void {
  const row = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  const balloons = normalizePageObjects(row?.objects_json ? JSON.parse(row.objects_json) : []).filter(
    (object): object is BalloonObject => object.kind === "balloon"
  );
  const tooSmall: BalloonObject[] = [];
  let adjusted = false;
  for (const balloon of balloons) {
    if (!balloon.content || balloon.content.style.size >= SCRIPT_MANGA_MIN_FONT_SIZE) continue;
    const trial = { ...balloon.content, style: { ...balloon.content.style, size: SCRIPT_MANGA_MIN_FONT_SIZE } };
    const layout = computeTextLayoutForContent(trial, balloonContentMaxWidth(balloon.shape, balloon.size, trial.style.direction));
    const factor = balloonInscribedFactor(balloon.shape) * (1 - CONTENT_PADDING_RATIO);
    const fits = layout.bbox.maxX - layout.bbox.minX <= balloon.size.x * factor + 1e-6 &&
      layout.bbox.maxY - layout.bbox.minY <= balloon.size.y * factor + 1e-6;
    if (fits) { balloon.content.style.size = SCRIPT_MANGA_MIN_FONT_SIZE; adjusted = true; }
    else tooSmall.push(balloon);
  }
  if (adjusted) runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [JSON.stringify(normalizePageObjects(row?.objects_json ? JSON.parse(row.objects_json) : []).map((object) => balloons.find((balloon) => balloon.id === object.id) ?? object)), pageId]);
  if (tooSmall.length > 0) {
    throw new HttpError(
      422,
      `Dialogue does not fit at the minimum readable size (${SCRIPT_MANGA_MIN_FONT_SIZE}); split dialogue or re-plan the page: ${tooSmall.map((balloon) => `${balloon.sourceDialogueLineId ?? balloon.id}(${Array.from(balloon.content?.text ?? "").length} chars)`).join(", ")}`
    );
  }
}

function actualTextSafeZones(pageId: string, layout: PageLayout, panelId: string): NormalizedBox[] {
  const page = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  const objects = normalizePageObjects(page?.objects_json ? JSON.parse(page.objects_json) : []);
  const objectById = new Map(objects.filter((object): object is BalloonObject => object.kind === "balloon").map((object) => [object.id, object]));
  const objectIds = getRows<{ balloon_object_id: string }>(
    "SELECT balloon_object_id FROM dialogue_placements WHERE page_id = ? AND panel_id = ? AND balloon_object_id IS NOT NULL",
    [pageId, panelId]
  ).map((row) => row.balloon_object_id);
  const panel = layout.panels.find((candidate) => candidate.id === panelId);
  if (!panel) return [];
  const [px1, py1, px2, py2] = panelBounds(panel.shape);
  const width = px2 - px1;
  const height = py2 - py1;
  if (width <= 0 || height <= 0) return [];
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return objectIds.flatMap((id) => {
    const balloon = objectById.get(id);
    if (!balloon) return [];
    const padding = 0.01;
    const x1 = clamp((balloon.position.x - balloon.size.x / 2 - padding - px1) / width);
    const y1 = clamp((balloon.position.y - balloon.size.y / 2 - padding - py1) / height);
    const x2 = clamp((balloon.position.x + balloon.size.x / 2 + padding - px1) / width);
    const y2 = clamp((balloon.position.y + balloon.size.y / 2 + padding - py1) / height);
    return x2 > x1 && y2 > y1 ? [{ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }] : [];
  });
}

function loadCharacters(projectId: string): StoryGraphCharacterInput[] {
  return getRows<{ id: string; name: string; aliases_json: string | null; notes: string }>(
    "SELECT id, name, aliases_json, notes FROM characters WHERE project_id = ? ORDER BY created_at ASC",
    [projectId]
  ).map((row) => ({ id: row.id, name: row.name, aliases: parseJson<string[]>(row.aliases_json, []), notes: row.notes }));
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

function loadDialoguesByIds(ids: string[], projectId: string, scriptId: string): StoryGraphDialogueInput[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
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
     FROM dialogue_lines WHERE project_id = ? AND script_id = ? AND id IN (${placeholders})`,
    [projectId, scriptId, ...ids]
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

function templatePromptProfile(templateId: string) {
  const row = getRow<{ workflow_json: string; prompt_dialect: string; quality_tags: string; negative_base: string }>(
    "SELECT workflow_json, prompt_dialect, quality_tags, negative_base FROM workflow_templates WHERE id = ?",
    [templateId]
  );
  const inferred = inferPromptProfile(row?.workflow_json ? JSON.parse(row.workflow_json) : {}, row?.prompt_dialect);
  return {
    dialect: inferred.promptDialect,
    qualityTags: row?.quality_tags || inferred.qualityTags,
    negativeBase: row?.negative_base || inferred.negativeBase,
    workflowJson: row?.workflow_json ?? ""
  };
}

function referenceModelFamily(templateId: string): ReferenceModelFamily | null {
  const workflowJson = templatePromptProfile(templateId).workflowJson;
  if (!workflowJson) return null;
  if (/anima|qwen_3_06b_base/iu.test(workflowJson)) return "anima";
  if (/chroma|auraflow|ModelSamplingAuraFlow/iu.test(workflowJson)) return "chroma";
  return null;
}

function frozenReferenceSnapshot(run: RunRow): ScriptMangaReferenceSnapshot | null {
  return parseJson<ScriptMangaReferenceSnapshot | null>(run.reference_snapshot_json, null);
}

function collectReferenceSnapshot(run: RunRow, plan: MangaPlanV2, config: ScriptMangaRunConfig): ScriptMangaReferenceSnapshot | null {
  const modelFamily = referenceModelFamily(config.templateId);
  if (!modelFamily) return null;
  const sets = new Map<string, ScriptMangaReferenceSnapshot["sets"][number]>();
  const missing = new Set<string>();
  const dialogueById = new Map(plan.dialogueSnapshots.map((line) => [line.id, line]));
  for (const panel of plan.pages.flatMap((page) => page.panels)) {
    const normalized = normalizePanelCast(panel, dialogueById);
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

function validatePlan(plan: MangaPlanV2): MangaPlanValidationReport {
  return validateMangaPlanV2(plan);
}

function clonePageLayout(layout: PageLayout): PageLayout {
  return JSON.parse(JSON.stringify(layout)) as PageLayout;
}

function parseDialoguePolicy(value: unknown): DialoguePolicy {
  const policy = typeof value === "string" ? value : "preserve";
  if (policy === "preserve" || policy === "adapt" || policy === "fill") return policy;
  if (policy === "generate") throw new HttpError(400, "dialoguePolicy generate requires a future lexical-similarity gate");
  throw new HttpError(400, 'dialoguePolicy must be "preserve", "adapt", "fill", or "generate"');
}

function parseConfig(run: RunRow): ScriptMangaRunConfig {
  const parsed = parseJson<Partial<ScriptMangaRunConfig>>(run.config_json, {});
  return {
    ...parsed,
    auditMode: parsed.auditMode === "vlm" ? "vlm" : "manual"
  } as ScriptMangaRunConfig;
}

function persistPlan(projectId: string, plan: MangaPlanV2, validation: MangaPlanValidationReport): void {
  runSql(
    `INSERT INTO script_manga_plans
       (id, project_id, script_id, script_revision_id, plan_version, planner_version, prompt_compiler_version,
        dialogue_policy, status, plan_json, validation_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [
      plan.id,
      projectId,
      plan.scriptId,
      plan.scriptRevisionId,
      plan.version,
      plan.plannerVersion,
      plan.promptCompilerVersion,
      plan.dialoguePolicy,
      JSON.stringify(plan),
      JSON.stringify(validation)
    ]
  );
}

function existingRunPage(runId: string, pageIndex: number): { page_id: string } | null {
  return getRow<{ page_id: string }>("SELECT page_id FROM script_manga_run_pages WHERE run_id = ? AND page_index = ?", [runId, pageIndex]);
}

function pageLayout(pageId: string): PageLayout {
  const row = getRow<{ layout_json: string | null }>("SELECT layout_json FROM pages WHERE id = ?", [pageId]);
  const layout = normalizeEditedPageLayout(row?.layout_json ? JSON.parse(row.layout_json) : null);
  if (!layout) throw new HttpError(500, `Page ${pageId} has no executable layout`);
  return layout;
}

function ensureRunPage(run: RunRow, pageSpec: MangaPlanV2["pages"][number]): { pageId: string; layout: PageLayout } {
  const existing = existingRunPage(run.id, pageSpec.index);
  if (existing) {
    const layout = pageLayout(existing.page_id);
    if (JSON.stringify(layout) !== JSON.stringify(pageSpec.layoutSnapshot)) {
      throw new HttpError(409, `Run-owned page ${pageSpec.index + 1} no longer matches its approved layout snapshot`);
    }
    return { pageId: existing.page_id, layout };
  }
  runSql("SAVEPOINT script_manga_page_create");
  try {
    const page = createPage(run.project_id);
    const layout = clonePageLayout(pageSpec.layoutSnapshot);
    runSql("UPDATE pages SET layout_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [JSON.stringify(layout), page.id]);
    updatePage(run.project_id, page.id, { title: pageSpec.title });
    runSql(
      "INSERT INTO script_manga_run_pages (run_id, page_id, page_index, layout_template_id) VALUES (?, ?, ?, ?)",
      [run.id, page.id, pageSpec.index, pageSpec.layoutTemplateId]
    );
    runSql("RELEASE script_manga_page_create");
    return { pageId: page.id, layout };
  } catch (error) {
    runSql("ROLLBACK TO script_manga_page_create");
    runSql("RELEASE script_manga_page_create");
    throw error;
  }
}

function ensureDialogueLettering(
  run: RunRow,
  pageId: string,
  pageSpec: MangaPlanV2["pages"][number],
  layoutPanels: PageLayout["panels"],
  dialogueSnapshots: Map<string, FrozenDialogueLine>,
  dialoguePolicy: DialoguePolicy,
  fillUnits: Map<string, DialogueUnit>
): void {
  const pageFillIds = pageSpec.panels.flatMap((panel) => panel.fillUnitIds ?? []);
  for (const unitId of pageFillIds) {
    const unit = fillUnits.get(unitId);
    if (!unit) throw new HttpError(422, `Frozen fill unit is missing: ${unitId}`);
    runSql(
      `INSERT OR IGNORE INTO dialogue_lines
         (id, project_id, script_id, character_id, speaker_label, text, semantic_kind, balloon_style,
          order_index, scene_index, source_hash, status, source)
       VALUES (?, ?, ?, NULL, '', ?, ?, ?, ?, NULL, ?, 'active', 'llm')`,
      [unit.id, run.project_id, run.script_id, unit.text, unit.semanticKind, unit.balloonStyle, 1_000_000 + fillUnits.size,
        unit.sourceElementId ?? unit.id]
    );
    dialogueSnapshots.set(unit.id, {
      id: unit.id, orderIndex: 1_000_000 + unit.part, sceneIndex: 0, characterId: null, speakerLabel: "",
      text: unit.text, semanticKind: unit.semanticKind, balloonStyle: unit.balloonStyle
    });
  }
  const lineIds = pageSpec.panels.flatMap((panel) => [...panel.dialogueLineIds, ...(panel.fillUnitIds ?? [])]);
  if (lineIds.length === 0) return;
  // Separate runs own separate pages/balloons, even when the same source line was already used by
  // another run. `copy` remains idempotent because allocation itself skips a placement on this page.
  allocateDialoguePages(run.project_id, pageId, { lineIds, existingPlacementPolicy: "copy" });
  for (let index = 0; index < pageSpec.panels.length; index += 1) {
    const layoutPanel = layoutPanels[index];
    if (!layoutPanel) throw new HttpError(500, `Page ${pageId} has fewer panels than planned`);
    for (const lineId of [...pageSpec.panels[index]!.dialogueLineIds, ...(pageSpec.panels[index]!.fillUnitIds ?? [])]) {
      const snapshot = dialogueSnapshots.get(lineId);
      if (!snapshot) throw new HttpError(422, `Frozen dialogue snapshot is missing: ${lineId}`);
      if (dialoguePolicy === "adapt" || dialoguePolicy === "fill") {
        const existing = getRows<{ id: string; part_index: number; balloon_object_id: string | null }>(
          "SELECT id, part_index, balloon_object_id FROM dialogue_placements WHERE page_id = ? AND line_id = ? ORDER BY part_index",
          [pageId, lineId]
        );
        if (existing.length === 1 && !existing[0]!.balloon_object_id) {
          const units = splitDialogueUnits({ lineId, text: snapshot.text, semanticKind: snapshot.semanticKind as DialogueSemanticKind,
            balloonStyle: (snapshot.balloonStyle as DialogueBalloonStyle | undefined) ?? "normal" });
          if (units.length > 1) {
            runSql("DELETE FROM dialogue_placements WHERE id = ?", [existing[0]!.id]);
            for (const unit of units) {
              const unitPanel = layoutPanels[Math.min(layoutPanels.length - 1, index + unit.part - 1)] ?? layoutPanel;
              runSql(
                `INSERT INTO dialogue_placements
                   (id, line_id, page_id, panel_id, part_index, render_kind, balloon_object_id, text_override,
                    semantic_kind_override, speaker_label_override, order_index_override)
                 VALUES (?, ?, ?, ?, ?, 'balloon', NULL, ?, ?, ?, ?)`,
                [createId("place"), lineId, pageId, unitPanel.id, unit.part - 1, unit.text, unit.semanticKind,
                  snapshot.speakerLabel, snapshot.orderIndex * 100 + unit.part]
              );
            }
          }
        }
        const splitCount = getRow<{ count: number }>(
          "SELECT COUNT(*) AS count FROM dialogue_placements WHERE page_id = ? AND line_id = ?",
          [pageId, lineId]
        )?.count ?? 0;
        if (splitCount > 1) continue;
      }
      runSql(
        `UPDATE dialogue_placements SET panel_id = ?, text_override = ?, semantic_kind_override = ?,
           speaker_label_override = ?, order_index_override = ?, updated_at = CURRENT_TIMESTAMP
         WHERE page_id = ? AND line_id = ?`,
        [
          layoutPanel.id,
          snapshot.text,
          snapshot.semanticKind,
          snapshot.speakerLabel,
          snapshot.orderIndex,
          pageId,
          lineId
        ]
      );
    }
  }
  const placementIds = getRows<{ id: string }>(
    `SELECT id FROM dialogue_placements
     WHERE page_id = ? AND balloon_object_id IS NULL AND line_id IN (${lineIds.map(() => "?").join(", ")})`,
    [pageId, ...lineIds]
  ).map((row) => row.id);
  if (placementIds.length > 0) {
    applyDialogueLayoutWithFallback(run.project_id, pageId, placementIds, pageSpec.index + 1, {
      avoidZones: planCastAvoidZones(pageSpec, layoutPanels),
      maxPanelCoverageRatio: SCRIPT_MANGA_MAX_BALLOON_COVERAGE
    });
    fitPageBalloonText(run.project_id, pageId);
    aimInitialBalloonTails(pageId);
  }
  requireReadableBalloonText(pageId);
  const pageRow = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  const objects = normalizePageObjects(pageRow?.objects_json ? JSON.parse(pageRow.objects_json) : []);
  const faceBoxes = pageSpec.panels.flatMap((panel, index) => {
    const layoutPanel = layoutPanels[index];
    if (!layoutPanel) return [];
    const [x0, y0, x1, y1] = panelBounds(layoutPanel.shape);
    return panel.cast.map((member) => ({
      x: x0 + member.bbox.x * (x1 - x0),
      y: y0 + member.bbox.y * (y1 - y0),
      width: member.bbox.width * (x1 - x0),
      height: member.bbox.height * (y1 - y0) * CAST_FACE_HEIGHT_RATIO
    }));
  });
  const letteringReport = auditLettering(pageSpec.layoutSnapshot, objects, faceBoxes);
  const evaluation = parseJson<Record<string, unknown>>(requireRun(run.id).evaluation_json, {});
  runSql("UPDATE script_manga_runs SET evaluation_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify({ ...evaluation, lettering: { ...(evaluation.lettering as Record<string, unknown> ?? {}), [pageId]: letteringReport } }),
    run.id
  ]);
}

function upsertPreparedTask(input: {
  runId: string;
  pageId: string;
  layoutPanelId: string;
  panel: PanelSpec;
  preflight: PanelPreflightReport;
}): void {
  const existing = getRow<{ id: string; status: string }>(
    "SELECT id, status FROM script_manga_tasks WHERE run_id = ? AND page_id = ? AND panel_id = ?",
    [input.runId, input.pageId, input.layoutPanelId]
  );
  if (existing) {
    if (existing.status === "pending" || existing.status === "blocked") {
      runSql(
        `UPDATE script_manga_tasks SET prompt = ?, panel_spec_json = ?, reference_manifest_json = ?, scores_json = ?,
           status = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [
          input.panel.compiledPrompt,
          JSON.stringify(input.panel),
          JSON.stringify(input.panel.referenceManifest),
          JSON.stringify({ preflight: input.preflight }),
          input.preflight.passed ? "pending" : "blocked",
          input.preflight.passed ? null : JSON.stringify({ message: "Panel preflight failed", violations: input.preflight.violations }),
          existing.id
        ]
      );
    }
    return;
  }
  runSql(
    `INSERT INTO script_manga_tasks
       (id, run_id, page_id, panel_id, prompt, panel_spec_json, reference_manifest_json, scores_json, status, last_error_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createId("manga_task"),
      input.runId,
      input.pageId,
      input.layoutPanelId,
      input.panel.compiledPrompt,
      JSON.stringify(input.panel),
      JSON.stringify(input.panel.referenceManifest),
      JSON.stringify({ preflight: input.preflight }),
      input.preflight.passed ? "pending" : "blocked",
      input.preflight.passed ? null : JSON.stringify({ message: "Panel preflight failed", violations: input.preflight.violations })
    ]
  );
}

function normalizePanelCast(panel: PanelSpec, dialogueById: Map<string, StoryGraphDialogueInput>): {
  cast: PanelSpec["cast"];
  excludedOffscreenIds: string[];
} {
  const offscreenStyles = new Set(["telecom", "machine", "vo", "caption", "monitor"]);
  const excludedOffscreenIds: string[] = [];
  const byKey = new Map<string, PanelSpec["cast"][number]>();
  for (const member of panel.cast) {
    const lines = member.speakingLineIds.map((id) => dialogueById.get(id)).filter((line): line is StoryGraphDialogueInput => Boolean(line));
    const offscreenOnly = member.characterId !== panel.shot.focalSubjectId && lines.length > 0 && lines.every((line) =>
      line.semanticKind === "narration" || offscreenStyles.has(line.balloonStyle ?? "")
    );
    if (offscreenOnly) {
      excludedOffscreenIds.push(member.characterId);
      continue;
    }
    const key = referenceSnapshotKey(member.characterId, member.variantId);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...member, speakingLineIds: [...new Set(member.speakingLineIds)] });
      continue;
    }
    existing.speakingLineIds = [...new Set([...existing.speakingLineIds, ...member.speakingLineIds])];
  }
  return { cast: [...byKey.values()], excludedOffscreenIds: [...new Set(excludedOffscreenIds)] };
}

function materializeRun(runId: string): void {
  const run = requireRun(runId);
  if (!run.plan_id) throw new HttpError(409, "Run has no persisted MangaPlanV2");
  const planRow = requirePlan(run.plan_id);
  const plan = planFromRow(planRow);
  const config = parseConfig(run);
  const liveDialogueRows = loadDialoguesByIds(plan.sourceDialogueLineIds, run.project_id, run.script_id);
  if (liveDialogueRows.length !== plan.sourceDialogueLineIds.length) {
    throw new HttpError(422, "One or more frozen dialogue lines no longer belong to this project/script");
  }
  const dialogueRows: StoryGraphDialogueInput[] = plan.dialogueSnapshots.map((snapshot) => ({
    id: snapshot.id,
    orderIndex: snapshot.orderIndex,
    sceneIndex: snapshot.sceneIndex,
    characterId: snapshot.characterId,
    speakerLabel: snapshot.speakerLabel,
    text: snapshot.text,
    semanticKind: snapshot.semanticKind,
    balloonStyle: snapshot.balloonStyle
  }));
  const dialogueById = new Map(dialogueRows.map((line) => [line.id, line]));
  const dialogueSnapshots = new Map(plan.dialogueSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const promptProfile = templatePromptProfile(config.templateId);
  const modelFamily = referenceModelFamily(config.templateId);
  const referenceSnapshot = frozenReferenceSnapshot(run);
  removeUnusedStarterPage(run.project_id);

  for (const pageSpec of plan.pages) {
    const { pageId, layout } = ensureRunPage(run, pageSpec);
    const layoutPanels = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
    if (layoutPanels.length !== pageSpec.panels.length) {
      throw new HttpError(422, `Layout ${pageSpec.layoutTemplateId} has ${layoutPanels.length} panels but plan requires ${pageSpec.panels.length}`);
    }
    const pageObjectRow = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
    const existingPageObjects = normalizePageObjects(pageObjectRow?.objects_json ? JSON.parse(pageObjectRow.objects_json) : []);
    const pageObjectsWithoutMangaEffects = existingPageObjects.filter((object) => !isMangaEffectObject(object));
    if (pageObjectsWithoutMangaEffects.length !== existingPageObjects.length) {
      runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
        JSON.stringify(pageObjectsWithoutMangaEffects), pageId
      ]);
    }
    ensureDialogueLettering(run, pageId, pageSpec, layoutPanels, dialogueSnapshots, plan.dialoguePolicy,
      new Map((plan.fillUnits ?? []).map((unit) => [unit.id, unit])));
    for (let index = 0; index < pageSpec.panels.length; index += 1) {
      const panel = pageSpec.panels[index]!;
      const layoutPanel = layoutPanels[index]!;
      // 役割の正は layout snapshot 側(provided plan が role を書き忘れても立ち絵仕様になる)。
      if (layoutPanel.role === "figure") panel.role = "figure";
      else delete panel.role;
      const castNormalization = normalizePanelCast(panel, dialogueById);
      panel.cast = castNormalization.cast;
      panel.textSafeZones = actualTextSafeZones(pageId, layout, layoutPanel.id);
      const references = resolvePanelReferences({
        projectId: run.project_id,
        providerId: config.providerId,
        cast: panel.cast,
        focalSubjectId: panel.shot.focalSubjectId,
        globalLoras: config.loras,
        modelFamily: modelFamily ?? "chroma",
        frozenSnapshot: referenceSnapshot
      });
      panel.referenceManifest = references.manifest;
      panel.compiledPrompt = compilePanelConditioning({
        panel,
        basePrompt: panel.promptBase,
        entities: plan.narrativeGraph.entities,
        dialogueById,
        narrativeMetadata: config.planningMode === "provided"
          ? "base-only"
          : plan.plannerProvenance?.kind === "llm-director"
            ? "english-directed"
            : "append",
        dialect: promptProfile.dialect,
        qualityTags: promptProfile.qualityTags,
        negativeBase: promptProfile.negativeBase,
        sceneBible: plan.narrativeGraph.sceneBibles?.find((bible) => bible.settingId === panel.settingId),
        referenceAppearances: references.appearances
      }).positive;
      const preflight = validatePanelPreflight({
        panel,
        layout,
        layoutPanelId: layoutPanel.id,
        dialogueTexts: panel.dialogueLineIds.map((lineId) => dialogueById.get(lineId)?.text ?? ""),
        requireReferences: config.requireReferenceSets && Boolean(modelFamily) && !config.allowReferenceFallback,
        missingReferenceIds: references.missingReferenceIds,
        castNormalized: true,
        offscreenSpeakerIds: castNormalization.excludedOffscreenIds
      });
      upsertPreparedTask({ runId: run.id, pageId, layoutPanelId: layoutPanel.id, panel, preflight });
    }
  }
  const validation = validatePlan(plan);
  runSql(
    `UPDATE script_manga_plans SET plan_json = ?, validation_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [JSON.stringify(plan), JSON.stringify(validation), plan.id]
  );
  if (!validation.ok) throw new HttpError(422, "Materialized MangaPlanV2 failed validation");
  const blocked = getRow<{ count: number }>(
    "SELECT COUNT(*) AS count FROM script_manga_tasks WHERE run_id = ? AND status = 'blocked'",
    [run.id]
  )?.count ?? 0;
  if (blocked > 0) throw new HttpError(422, `${blocked} panel task(s) failed deterministic preflight`);
  runSql(
    `UPDATE script_manga_runs SET status = CASE WHEN approval_status = 'approved' THEN 'approved' ELSE 'prepared' END,
       phase = CASE WHEN approval_status = 'approved' THEN 'preparing_references' ELSE 'awaiting_approval' END,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [run.id]
  );
}

async function submitTasks(runId: string, taskIds?: string[]): Promise<void> {
  const run = requireRun(runId);
  const config = parseConfig(run);
  const params: unknown[] = [run.id];
  const taskFilter = taskIds && taskIds.length > 0 ? ` AND id IN (${taskIds.map(() => "?").join(", ")})` : "";
  if (taskIds) params.push(...taskIds);
  const tasks = getRows<TaskRow>(`SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'pending'${taskFilter} ORDER BY created_at ASC`, params);
  for (const task of tasks) {
    const panel = parseJson<PanelSpec>(task.panel_spec_json, null as unknown as PanelSpec);
    if (!panel) {
      runSql("UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
        JSON.stringify({ message: "PanelSpec is missing" }),
        task.id
      ]);
      continue;
    }
    const layout = pageLayout(task.page_id);
    const promptProfile = templatePromptProfile(config.templateId);
    const detectedFamily = referenceModelFamily(config.templateId);
    const size = panelGenerationSize(layout, task.panel_id, config.longEdge, detectedFamily ? "chroma" : "sdxl");
    const references = resolvePanelReferences({
      projectId: run.project_id,
      providerId: config.providerId,
      cast: panel.cast,
      focalSubjectId: panel.shot.focalSubjectId,
      globalLoras: config.loras,
      modelFamily: detectedFamily ?? "chroma",
      frozenSnapshot: frozenReferenceSnapshot(run)
    });
    panel.referenceManifest = references.manifest;
    const frozenPlan = planFromRow(requirePlan(run.plan_id!));
    const conditioning = compilePanelConditioning({ panel, basePrompt: panel.promptBase, entities: frozenPlan.narrativeGraph.entities,
      dialogueById: new Map(), narrativeMetadata: "english-directed", dialect: promptProfile.dialect,
      qualityTags: promptProfile.qualityTags, negativeBase: promptProfile.negativeBase,
      sceneBible: frozenPlan.narrativeGraph.sceneBibles?.find((bible) => bible.settingId === panel.settingId),
      referenceAppearances: references.appearances });
    panel.compiledPrompt = conditioning.positive;
    const request: GenerationRequest & { providerId?: string } = {
      templateId: config.templateId,
      prompt: panel.compiledPrompt,
      negativePrompt: conditioning.negative,
      seed: null,
      seedMode: "random",
      batchSize: 1,
      steps: config.steps,
      cfg: config.cfg,
      sampler: config.sampler,
      scheduler: config.scheduler,
      denoise: 1,
      width: size.width,
      height: size.height,
      generationMode: "txt2img",
      loras: references.loras,
      reference: references.primaryReferenceSet
        ? {
            referenceSet: references.primaryReferenceSet,
            face: { enabled: detectedFamily === "chroma" },
            animaInContext: { enabled: detectedFamily === "anima" },
            strict: true
          }
        : references.primaryCharacterBinding
        ? {
            characterBinding: references.primaryCharacterBinding,
            face: { enabled: true },
            animaInContext: { enabled: true }
          }
        : null,
      providerId: config.providerId
    };
    const claimed = runSql(
      `UPDATE script_manga_tasks SET status = 'submitting', panel_spec_json = ?, reference_manifest_json = ?,
         attempt_count = attempt_count + 1, last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending'`,
      [JSON.stringify(panel), JSON.stringify(references.manifest), task.id]
    ) as { changes?: number };
    if (claimed.changes !== 1) continue;
    activeTaskSubmissions.add(task.id);
    try {
      const created = await createGenerationRound(run.project_id, request, task.page_id, task.panel_id, task.id);
      if (!created.round) throw new Error("Generation round was not created");
      const latestRun = requireRun(run.id);
      const latestTask = requireTask(task.id);
      if (latestRun.status === "canceled" || latestTask.status === "canceled") {
        try {
          await interruptRound(created.round.id);
        } catch {
          // Cancellation state remains authoritative; provider cleanup is best effort.
        }
      } else {
        runSql(
          `UPDATE script_manga_tasks SET round_id = ?, status = 'running', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'submitting'`,
          [created.round.id, task.id]
        );
      }
    } catch (error) {
      runSql(
        `UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'submitting'`,
        [errorJson(error), task.id]
      );
    } finally {
      activeTaskSubmissions.delete(task.id);
    }
  }
  runSql(
    `UPDATE script_manga_runs SET status = 'running', phase = 'rendering', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status <> 'canceled'`,
    [run.id]
  );
}

/** Recover the only non-atomic boundary left by an external provider call after a process restart. */
function recoverSubmittingTasks(runId: string): void {
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'submitting'", [runId]);
  for (const task of tasks) {
    if (activeTaskSubmissions.has(task.id)) continue;
    if (!task.round_id) {
      // createGenerationRound links the round before provider submission. No link means no provider call occurred.
      runSql("UPDATE script_manga_tasks SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'submitting'", [task.id]);
      continue;
    }
    const round = getRow<{ status: string; last_error_json: string | null }>(
      "SELECT status, last_error_json FROM generation_rounds WHERE id = ? AND script_manga_task_id = ?",
      [task.round_id, task.id]
    );
    const jobCount = getRow<{ count: number }>("SELECT COUNT(*) AS count FROM generation_jobs WHERE round_id = ?", [task.round_id])?.count ?? 0;
    if (round?.status === "failed" || round?.status === "interrupted") {
      runSql(
        "UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [round.last_error_json, task.id]
      );
    } else if (jobCount > 0 || round?.status === "completed") {
      runSql("UPDATE script_manga_tasks SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [task.id]);
      ensureRoundMonitor(task.round_id);
    } else {
      const failure = JSON.stringify({
        message: "Generation submission outcome is unknown after restart; inspect the provider queue before retrying"
      });
      runSql(
        "UPDATE generation_rounds SET status = 'failed', last_error_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
        [failure, task.round_id]
      );
      runSql(
        "UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [failure, task.id]
      );
    }
  }
}

interface CandidateScore {
  assetId: string;
  batchIndex: number;
  score: number;
  passedMetadataGate: boolean;
  checks: {
    dimensionsPresent: boolean;
    aspectRatioDelta: number | null;
    visualIdentity: "not-evaluated";
    actionAlignment: "not-evaluated";
    fakeText: "not-evaluated";
    continuity: "not-evaluated";
  };
  violations: string[];
}

function candidateScores(task: TaskRow): CandidateScore[] {
  if (!task.round_id) return [];
  const round = getRow<{ request_json: string }>("SELECT request_json FROM generation_rounds WHERE id = ?", [task.round_id]);
  const request = parseJson<{ width?: number; height?: number }>(round?.request_json, {});
  const expectedRatio = request.width && request.height ? request.width / request.height : null;
  return getRows<{ id: string; batch_index: number; width: number | null; height: number | null }>(
    "SELECT id, batch_index, width, height FROM assets WHERE round_id = ? ORDER BY batch_index ASC",
    [task.round_id]
  ).map((asset) => {
    const dimensionsPresent = Boolean(asset.width && asset.height && asset.width > 0 && asset.height > 0);
    const aspectRatioDelta = dimensionsPresent && expectedRatio ? Math.abs(asset.width! / asset.height! - expectedRatio) / expectedRatio : null;
    const passedMetadataGate = dimensionsPresent && (aspectRatioDelta === null || aspectRatioDelta <= 0.08);
    const violations = [
      ...(dimensionsPresent ? [] : ["missing-dimensions"]),
      ...(aspectRatioDelta !== null && aspectRatioDelta > 0.08 ? ["aspect-ratio-mismatch"] : [])
    ];
    return {
      assetId: asset.id,
      batchIndex: asset.batch_index,
      score: passedMetadataGate ? Math.max(0, 1 - (aspectRatioDelta ?? 0)) : 0,
      passedMetadataGate,
      checks: {
        dimensionsPresent,
        aspectRatioDelta,
        visualIdentity: "not-evaluated",
        actionAlignment: "not-evaluated",
        fakeText: "not-evaluated",
        continuity: "not-evaluated"
      },
      violations
    };
  });
}

function selectTaskCandidateInternal(task: TaskRow, assetId: string): void {
  const candidate = getRow<{ id: string }>("SELECT id FROM assets WHERE id = ? AND round_id = ?", [assetId, task.round_id]);
  if (!candidate) throw new HttpError(400, "Asset is not a candidate for this task");
  updateAssetStatus(assetId, { status: "selected", note: `script manga run ${task.run_id}; reviewed candidate` });
  runSql(
    `UPDATE script_manga_tasks SET status = 'completed', asset_id = ?, selected_asset_id = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [assetId, assetId, task.id]
  );
}

function syncTaskFromRound(task: TaskRow, config: ScriptMangaRunConfig): void {
  if (
    !task.round_id ||
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "blocked" ||
    task.status === "canceled" ||
    task.status === "awaiting_review" ||
    task.status === "auditing"
  ) return;
  const round = getRow<{ status: string; last_error_json: string | null }>("SELECT status, last_error_json FROM generation_rounds WHERE id = ?", [
    task.round_id
  ]);
  if (!round) {
    runSql(
      "UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [JSON.stringify({ message: "Generation round no longer exists" }), task.id]
    );
    return;
  }
  if (round?.status === "completed") {
    const scores = candidateScores(task);
    if (scores.length === 0) {
      runSql(
        "UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [JSON.stringify({ message: "Generation completed without any candidate assets" }), task.id]
      );
      return;
    }
    const nextStatus = config.auditMode === "vlm" ? "auditing" : "awaiting_review";
    const previousCandidateIds = parseJson<string[]>(task.candidate_asset_ids_json, []);
    const candidateIds = [...new Set([...previousCandidateIds, ...scores.map((score) => score.assetId)])];
    runSql(
      `UPDATE script_manga_tasks SET status = ?, candidate_asset_ids_json = ?, scores_json = ?,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [
        nextStatus,
        JSON.stringify(candidateIds),
        JSON.stringify({
          ...parseJson<Record<string, unknown>>(task.scores_json, {}),
          candidates: [...(parseJson<{ candidates?: unknown[] }>(task.scores_json, {}).candidates ?? []), ...scores],
          visualAuditRequired: true,
          deterministicAudit: { state: "queued" },
          ...(config.auditMode === "vlm" ? { vlmAudit: { state: "queued" } } : {})
        }),
        task.id
      ]
    );
  } else if (round?.status === "failed" || round?.status === "interrupted") {
    runSql(
      "UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [round.last_error_json, task.id]
    );
  }
}

function markVisualAuditUnavailable(runId: string, error: unknown, deferred: boolean): void {
  const detail = error instanceof Error ? error.message : String(error);
  for (const task of getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'auditing'", [runId])) {
    const scores = parseJson<Record<string, unknown>>(task.scores_json, {});
    runSql(
      `UPDATE script_manga_tasks SET status = ?, scores_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'auditing'`,
      [
        deferred ? "auditing" : "awaiting_review",
        JSON.stringify({ ...scores, vlmAudit: { state: deferred ? "deferred" : "unavailable", error: detail.slice(0, 500) } }),
        task.id
      ]
    );
  }
  runSql("UPDATE script_manga_runs SET last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify({ message: detail.slice(0, 500), phase: "vlm-audit", deferred }),
    runId
  ]);
}

async function performRunVisualAudit(runId: string): Promise<void> {
  const run = requireRun(runId);
  if (run.status === "canceled") return;
  const config = parseConfig(run);
  if (config.auditMode !== "vlm") return;
  const allTasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ?", [runId]);
  if (allTasks.some((task) => task.status === "pending" || task.status === "submitting" || task.status === "running")) {
    throw new Error("VLM audit is deferred until every generation task is idle");
  }
  const auditTasks = allTasks.filter((task) => task.status === "auditing");
  if (auditTasks.length === 0) return;

  const settings = getVlmAuditSettings();
  if (config.providerId === "comfy" && settings.releaseComfyBeforeAudit !== false) {
    await releaseComfyModelsForAudit();
  }
  const lease = await acquireVlmModel(settings);
  let releaseError: unknown = null;
  const rerollTaskIds: string[] = [];
  try {
    for (const originalTask of auditTasks) {
      const task = requireTask(originalTask.id);
      if (task.status !== "auditing") continue;
      const panel = parseJson<PanelSpec>(task.panel_spec_json, null as unknown as PanelSpec);
      const assetIds = parseJson<string[]>(task.candidate_asset_ids_json, []);
      if (!panel || assetIds.length === 0) {
        markVisualAuditUnavailable(runId, new Error("PanelSpec or candidate set is missing for VLM audit"), false);
        continue;
      }
      try {
        const deterministicReports = [];
        for (const assetId of assetIds) deterministicReports.push(await safeDeterministicQuality(assetId, panel.cast.map((member) => member.characterId)));
        const budget = parseJson<{ maxAttemptsPerPanel?: number }>(run.generation_budget_json, {});
        if (deterministicReports.every((report) => !report.passed) && task.attempt_count < (budget.maxAttemptsPerPanel ?? 3)) {
          const previous = parseJson<Record<string, unknown>>(task.scores_json, {});
          runSql(
            `UPDATE script_manga_tasks SET status = 'pending', round_id = NULL, scores_json = ?, last_error_json = NULL,
               updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'auditing'`,
            [JSON.stringify({ ...previous, deterministicAudit: { state: "reroll", reports: deterministicReports } }), task.id]
          );
          rerollTaskIds.push(task.id);
          continue;
        }
        const reports = [];
        for (const assetId of assetIds) {
          reports.push(await evaluatePanelCandidate({ assetId, panel, settings: lease.settings }));
        }
        const previous = parseJson<Record<string, unknown>>(task.scores_json, {});
        runSql(
          `UPDATE script_manga_tasks SET status = 'awaiting_review', scores_json = ?, last_error_json = NULL,
             updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'auditing'`,
          [
            JSON.stringify({
              ...previous,
              deterministicAudit: { state: "completed", reports: deterministicReports },
              vlmAudit: {
                state: "completed",
                model: lease.settings.model,
                evaluatedAt: new Date().toISOString(),
                reports
              }
            }),
            task.id
          ]
        );
      } catch (error) {
        const previous = parseJson<Record<string, unknown>>(task.scores_json, {});
        const detail = error instanceof Error ? error.message : String(error);
        runSql(
          `UPDATE script_manga_tasks SET status = 'awaiting_review', scores_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'auditing'`,
          [JSON.stringify({ ...previous, vlmAudit: { state: "unavailable", error: detail.slice(0, 500) } }), task.id]
        );
      }
    }
  } finally {
    try {
      await releaseVlmModel(lease);
    } catch (error) {
      releaseError = error;
    }
  }
  if (releaseError) throw releaseError;
  if (rerollTaskIds.length > 0) await submitTasks(runId, rerollTaskIds);
  runSql("UPDATE script_manga_runs SET last_error_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [runId]);
}

async function performRunDeterministicAudit(runId: string): Promise<void> {
  const run = requireRun(runId);
  const rerollTaskIds: string[] = [];
  for (const task of getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'auditing'", [runId])) {
    const assetIds = parseJson<string[]>(task.candidate_asset_ids_json, []);
    const reports = [];
    for (const assetId of assetIds) reports.push(await safeDeterministicQuality(assetId));
    const previous = parseJson<Record<string, unknown>>(task.scores_json, {});
    const budget = parseJson<{ maxAttemptsPerPanel?: number }>(run.generation_budget_json, {});
    if (reports.length > 0 && reports.every((report) => !report.passed) && task.attempt_count < (budget.maxAttemptsPerPanel ?? 3)) {
      runSql(`UPDATE script_manga_tasks SET status = 'pending', round_id = NULL, scores_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify({ ...previous, deterministicAudit: { state: "reroll", reports } }), task.id]);
      rerollTaskIds.push(task.id);
    } else {
      runSql(`UPDATE script_manga_tasks SET status = 'awaiting_review', scores_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify({ ...previous, deterministicAudit: { state: "completed", reports } }), task.id]);
    }
  }
  if (rerollTaskIds.length > 0) await submitTasks(runId, rerollTaskIds);
}

async function safeDeterministicQuality(assetId: string, characterIds: string[] = []) {
  try {
    return await evaluateDeterministicPanelQuality(assetId, characterIds);
  } catch (error) {
    return {
      assetId, passed: true,
      metrics: { luminanceStdDev: 0, saturationMean: 0, edgeDensity: 0, pseudoTextRisk: 0, ocrTokens: [], identitySimilarity: null },
      violations: [`gate-unavailable: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

function scheduleRunVisualAudit(runId: string): void {
  if (activeAuditRuns.has(runId)) return;
  const run = requireRun(runId);
  const config = parseConfig(run);
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ?", [runId]);
  if (!tasks.some((task) => task.status === "auditing")) return;
  if (tasks.some((task) => task.status === "pending" || task.status === "submitting" || task.status === "running")) return;

  const operation = visualAuditQueue.then(() => config.auditMode === "vlm" ? performRunVisualAudit(runId) : performRunDeterministicAudit(runId));
  visualAuditQueue = operation.catch(() => undefined);
  activeAuditRuns.set(runId, operation);
  void operation
    .catch((error) => markVisualAuditUnavailable(runId, error, /deferred/i.test(error instanceof Error ? error.message : String(error))))
    .finally(() => activeAuditRuns.delete(runId));
}

function refreshRunStatus(runId: string): RunRow {
  const run = requireRun(runId);
  if (run.status === "canceled" || run.status === "exporting" || (run.status === "failed" && run.phase !== "rendering")) return run;
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ?", [run.id]);
  const completed = tasks.filter((task) => task.status === "completed").length;
  const failed = tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
  const awaitingReview = tasks.filter((task) => task.status === "awaiting_review").length;
  const auditing = tasks.filter((task) => task.status === "auditing").length;
  const active = tasks.filter((task) => task.status === "running" || task.status === "submitting").length;
  const pending = tasks.filter((task) => task.status === "pending").length;
  const vlmReports = tasks.flatMap((task) => {
    const scores = parseJson<{ vlmAudit?: { reports?: unknown } }>(task.scores_json, {});
    return Array.isArray(scores.vlmAudit?.reports) ? scores.vlmAudit.reports : [];
  }).filter((report): report is { passed?: unknown; score?: unknown } => Boolean(report) && typeof report === "object");
  const terminal = tasks.length === run.panel_count && completed + failed === run.panel_count;
  let status = run.status;
  let phase = run.phase;
  if (terminal) {
    status = failed > 0 ? "completed_with_errors" : "completed";
    phase = "completed";
  } else if (active > 0) {
    status = "running";
    phase = "rendering";
  } else if (auditing > 0) {
    status = "auditing";
    phase = "auditing";
  } else if (awaitingReview > 0) {
    status = "awaiting_review";
    phase = "reviewing";
  } else if (pending > 0 && run.approval_status === "approved") {
    status = "approved";
    phase = "preparing_references";
  }
  // 集計以外のキー(materialize が書く lettering、候補採用が書く figures)は上書きで消さない。
  const previousEvaluation = parseJson<Record<string, unknown>>(run.evaluation_json, {});
  const evaluation = {
    ...previousEvaluation,
    taskCount: tasks.length,
    completed,
    failed,
    auditing,
    awaitingReview,
    visualAuditRequired: auditing > 0 || awaitingReview > 0,
    vlmAuditedCandidates: vlmReports.length,
    vlmPassedCandidates: vlmReports.filter((report) => report.passed === true).length,
    vlmMeanScore: vlmReports.length > 0
      ? vlmReports.reduce((sum, report) => sum + (typeof report.score === "number" ? report.score : 0), 0) / vlmReports.length
      : null,
    updatedAt: new Date().toISOString()
  };
  runSql(
    `UPDATE script_manga_runs SET status = ?, phase = ?, completed_count = ?, failed_count = ?, evaluation_json = ?,
       updated_at = CURRENT_TIMESTAMP,
       completed_at = CASE WHEN ? THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE completed_at END WHERE id = ?`,
    [status, phase, completed, failed, JSON.stringify(evaluation), terminal ? 1 : 0, run.id]
  );
  return requireRun(run.id);
}

export async function createScriptMangaRun(projectId: string, body: unknown): Promise<ScriptMangaRunView> {
  const input = objectBody(body);
  const scriptId = requiredString(input.scriptId, "scriptId");
  const templateId = requiredString(input.templateId, "templateId");
  const providerId = stringOr(input.providerId, "comfy");
  requireScript(projectId, scriptId);
  if (!getRow("SELECT id FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [templateId])) {
    throw new HttpError(404, "Workflow template was not found");
  }
  const planOptions: ScriptMangaPlanOptions = {
    panelsPerPage: typeof input.panelsPerPage === "number" ? input.panelsPerPage : 4,
    maxElementsPerPanel: typeof input.maxElementsPerPanel === "number" ? input.maxElementsPerPanel : 6,
    targetPageCount: typeof input.targetPageCount === "number" ? input.targetPageCount : undefined,
    maxDialoguesPerPanel: typeof input.maxDialoguesPerPanel === "number" ? input.maxDialoguesPerPanel : 2,
    stylePrompt: stringOr(input.stylePrompt, "") || undefined
  };
  const planningMode = stringOr(input.planningMode, "heuristic");
  if (planningMode !== "heuristic" && planningMode !== "llm" && planningMode !== "provided") {
    throw new HttpError(400, 'planningMode must be "heuristic", "llm", or "provided"');
  }
  if (input.candidateSelectionPolicy !== undefined && input.candidateSelectionPolicy !== "review") {
    throw new HttpError(400, 'candidateSelectionPolicy must be "review"; generated candidates are never auto-selected');
  }
  const candidateSelectionPolicy = "review" as const;
  if (input.auditMode !== undefined && input.auditMode !== "manual" && input.auditMode !== "vlm") {
    throw new HttpError(400, 'auditMode must be "manual" or "vlm"');
  }
  const auditMode = input.auditMode === "vlm" ? "vlm" : "manual";
  const dialoguePolicy = parseDialoguePolicy(input.dialoguePolicy);
  if ((dialoguePolicy === "adapt" || dialoguePolicy === "fill") && input.panelsPerPage === undefined) {
    // 分割unitを可読サイズで置けるよう、既定packerも呼吸単位向けの大きめコマへ切り替える。
    planOptions.panelsPerPage = 2;
    if (input.maxDialoguesPerPanel === undefined) planOptions.maxDialoguesPerPanel = 1;
  }
  const revision = latestRevision(scriptId);
  const fullPlan = planningMode === "llm"
    ? await planScriptMangaWithDirector(revision.doc, { ...planOptions, characterBible: stringOr(input.characterBible, "") || undefined })
    : planningMode === "provided"
      ? validateProvidedScriptMangaPlan(revision.doc, input.directorPlan, layoutPanelCount)
      : planScriptManga(revision.doc, planOptions);
  if (!fullPlan) throw new HttpError(400, "directorPlan is invalid or does not preserve every dialogue exactly once");
  const pageLimit =
    typeof input.pageLimit === "number"
      ? Math.max(1, Math.min(fullPlan.pages.length, Math.trunc(input.pageLimit)))
      : fullPlan.pages.length;
  const limitedPages = fullPlan.pages.slice(0, pageLimit);
  const legacyPlan = {
    ...fullPlan,
    pages: limitedPages,
    panelCount: limitedPages.reduce((sum, page) => sum + page.panels.length, 0),
    dialogueCount: new Set(limitedPages.flatMap((page) => page.panels.flatMap((panel) => panel.dialogueOrderIndexes))).size
  };
  const loras: StyleLoraSelection[] = Array.isArray(input.loras)
    ? input.loras.flatMap((raw) =>
        raw && typeof raw === "object"
          ? [{
              name: stringOr((raw as Record<string, unknown>).name, ""),
              strength: typeof (raw as Record<string, unknown>).strength === "number" ? (raw as Record<string, number>).strength : 1
            }]
          : []
      ).filter((item) => item.name.trim()).slice(0, 4)
    : [];
  const planId = createId("manga_plan");
  const plan = buildMangaPlanV2({
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
    resolveLayoutTemplate
  });
  const validation = validatePlan(plan);
  if (!validation.ok) throw new HttpError(422, "Generated MangaPlanV2 failed deterministic validation");
  persistPlan(projectId, plan, validation);

  const generateImages = input.generateImages !== false;
  const config: ScriptMangaRunConfig = {
    templateId,
    providerId,
    batchSize: 1,
    planningMode,
    pageLimit,
    loras,
    generateImages,
    candidateSelectionPolicy,
    auditMode,
    longEdge: typeof input.longEdge === "number" ? input.longEdge : 1024,
    steps: typeof input.steps === "number" ? input.steps : 20,
    cfg: typeof input.cfg === "number" ? input.cfg : 5,
    sampler: stringOr(input.sampler, "euler"),
    scheduler: stringOr(input.scheduler, "beta"),
    planOptions,
    requireReferenceSets: providerId === "comfy" && (input.requireReferenceSets === true || generateImages),
    allowReferenceFallback: input.allowReferenceFallback === true
  };
  const generationBudget = {
    maxAttemptsPerPanel: 3,
    maxConcurrentSubmissions: 1,
    candidateSelectionPolicy,
    auditMode
  };
  const runId = createId("manga");
  runSql(
    `INSERT INTO script_manga_runs
       (id, project_id, script_id, script_revision_id, plan_id, plan_version, planner_version,
        prompt_compiler_version, status, phase, approval_status, page_count, panel_count, config_json, generation_budget_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', 'planning', 'pending', ?, ?, ?, ?)`,
    [
      runId,
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
      await submitTasks(runId);
    }
  } catch (error) {
    runSql(
      `UPDATE script_manga_runs SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP,
       completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [errorJson(error), runId]
    );
    throw error;
  }
  return runView(refreshRunStatus(runId));
}

export function getScriptMangaPlan(planId: string): ScriptMangaPlanView {
  return planView(requirePlan(planId));
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
  candidate.createdAt = originalPlan.createdAt;
  let validation: MangaPlanValidationReport;
  try {
    validation = validatePlan(candidate);
  } catch {
    throw new HttpError(400, "Malformed MangaPlanV2 object");
  }
  if (!validation.ok) throw new HttpError(422, "Edited MangaPlanV2 failed deterministic validation");
  runSql("BEGIN IMMEDIATE");
  try {
    runSql(
      `UPDATE script_manga_plans SET plan_json = ?, validation_json = ?, dialogue_policy = ?, status = 'draft',
         approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
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
  const snapshot = collectReferenceSnapshot(run, planFromRow(plan), parseConfig(run));
  runSql("UPDATE script_manga_plans SET status = 'approved', approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [plan.id]);
  runSql(
    `UPDATE script_manga_runs SET status = 'approved', phase = 'preparing_references', approval_status = 'approved',
     reference_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [snapshot ? JSON.stringify(snapshot) : null, run.id]
  );
  return runView(requireRun(run.id));
}

export async function startScriptMangaRun(runId: string): Promise<ScriptMangaRunView> {
  const run = requireRun(runId);
  if (run.approval_status !== "approved") throw new HttpError(409, "Approve the prepared run before starting generation");
  if (run.status === "canceled") throw new HttpError(409, "Canceled runs cannot be started");
  materializeRun(run.id);
  await submitTasks(run.id);
  return runView(refreshRunStatus(run.id));
}

export async function resumeScriptMangaRun(runId: string): Promise<ScriptMangaRunView> {
  const run = requireRun(runId);
  if (run.status === "canceled") throw new HttpError(409, "Canceled runs cannot be resumed");
  recoverSubmittingTasks(run.id);
  materializeRun(run.id);
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
  for (const roundId of roundIds) {
    try {
      await interruptRound(roundId);
    } catch {
      // Run cancellation remains authoritative even if a provider is temporarily unreachable.
    }
  }
  runSql(
    "UPDATE script_manga_tasks SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE run_id = ? AND status NOT IN ('completed', 'failed')",
    [run.id]
  );
  runSql(
    `UPDATE script_manga_runs SET status = 'canceled', phase = 'canceled', completed_at = CURRENT_TIMESTAMP,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [run.id]
  );
  return runView(requireRun(run.id));
}

export async function retryScriptMangaTask(taskId: string): Promise<ScriptMangaRunView> {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  if (run.approval_status !== "approved" || run.status === "canceled") throw new HttpError(409, "Task cannot be retried in the current run state");
  if (task.status === "running" || task.status === "submitting" || task.status === "auditing" || task.status === "completed" || task.status === "canceled") {
    throw new HttpError(409, "Only failed, blocked, or unselected review tasks can be retried");
  }
  const budget = parseJson<{ maxAttemptsPerPanel?: number }>(run.generation_budget_json, {});
  if (task.attempt_count >= (budget.maxAttemptsPerPanel ?? 3)) throw new HttpError(409, "Task generation budget is exhausted");
  const previousScores = parseJson<{ preflight?: unknown }>(task.scores_json, {});
  runSql(
    `UPDATE script_manga_tasks SET status = 'pending', round_id = NULL, asset_id = NULL, selected_asset_id = NULL,
     candidate_asset_ids_json = '[]', scores_json = ?, last_error_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [JSON.stringify({ preflight: previousScores.preflight ?? null }), task.id]
  );
  runSql(
    `UPDATE script_manga_runs SET status = 'running', phase = 'repairing', completed_at = NULL,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [run.id]
  );
  await submitTasks(run.id, [task.id]);
  return runView(refreshRunStatus(run.id));
}

/** run の evaluation_json へ figure 切り抜きの結果(成功/フォールバック/失敗)を記録する。 */
function recordFigureResult(runId: string, taskId: string, value: unknown): void {
  const evaluation = parseJson<Record<string, unknown>>(requireRun(runId).evaluation_json, {});
  const figures = { ...((evaluation.figures as Record<string, unknown>) ?? {}), [taskId]: value };
  runSql("UPDATE script_manga_runs SET evaluation_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify({ ...evaluation, figures }),
    runId
  ]);
}

/**
 * ぶち抜き立ち絵(Docs/Feature-MangaCompositions.md)の再レタリング。立ち絵 ImageObject が
 * 障害物として増えた後、ロックされていない吹き出しを顔・立ち絵回避と専有率制約付きで
 * 組み直す。失敗しても既存配置を維持する(切り抜き自体は成功している)best effort。
 */
function reflowLetteringAroundFigure(run: RunRow, task: TaskRow): void {
  try {
    if (!run.plan_id) return;
    const plan = planFromRow(requirePlan(run.plan_id));
    const pageIndex = getRow<{ page_index: number }>(
      "SELECT page_index FROM script_manga_run_pages WHERE run_id = ? AND page_id = ?",
      [run.id, task.page_id]
    )?.page_index;
    const pageSpec = typeof pageIndex === "number" ? plan.pages[pageIndex] : undefined;
    if (!pageSpec) return;
    const layout = pageLayout(task.page_id);
    const layoutPanels = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
    reflowDialogueLayout(run.project_id, task.page_id, {
      seed: (pageSpec.index + 1) * 7919 + 17,
      fontScale: SCRIPT_MANGA_FONT_SCALE,
      avoidZones: planCastAvoidZones(pageSpec, layoutPanels),
      maxPanelCoverageRatio: SCRIPT_MANGA_MAX_BALLOON_COVERAGE
    });
    fitPageBalloonText(run.project_id, task.page_id);
    aimInitialBalloonTails(task.page_id);
  } catch {
    // 再配置できないページはそのまま(手動の再配置・ロック解除で調整できる)。
  }
}

/**
 * 採用候補がぶち抜き立ち絵スロット(layout panel role:"figure")のものなら、背景除去+白フチの
 * 切り抜きを page_media 化し、`figure_<panelId>` の ImageObject(band:"front"、クリップ無し)として
 * コマ枠の前面へ重ねる。切り抜きが成立しない画像(無地背景でない等)は通常のコマ画像割当へ
 * フォールバックする。再採用時は同 id のオブジェクトと旧メディアを差し替える。
 */
async function materializeFigureForTask(task: TaskRow, assetId: string): Promise<void> {
  const run = requireRun(task.run_id);
  const layout = pageLayout(task.page_id);
  const layoutPanel = layout.panels.find((panel) => panel.id === task.panel_id);
  if (layoutPanel?.role !== "figure") return;
  const asset = getRow<{ image_path: string }>("SELECT image_path FROM assets WHERE id = ?", [assetId]);
  if (!asset) return;

  const cutout = await cutoutFigure(asset.image_path);
  if (!cutout) {
    // 無地背景でない等で切り抜き不成立 → 枠なしコマとして通常割当(絵は出るがぶち抜きにはならない)。
    const page = toApiRow(getRow("SELECT * FROM pages WHERE id = ?", [task.page_id])) as unknown as PageRow | null;
    if (page?.layout) {
      try {
        upsertPanelAssignment(page, task.panel_id, { assetId });
      } catch {
        // 割当に失敗しても候補採用自体は成立させる。
      }
    }
    recordFigureResult(run.id, task.id, { state: "fallback-panel-assignment", assetId });
    return;
  }

  const media = await createPageMediaFromBuffer(run.project_id, cutout.png, assetId);
  const [px0, py0, px1, py1] = panelBounds(layoutPanel.shape);
  const slotWidth = Math.max(1e-6, px1 - px0);
  const slotHeight = Math.max(1e-6, py1 - py0);
  const aspect = cutout.width / Math.max(1, cutout.height);
  let height = slotHeight;
  let width = height * aspect;
  const maxWidth = slotWidth * 1.25; // ぶち抜き: 横はスロット幅の 25% まで隣へ張り出してよい。
  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspect;
  }
  const objectId = `figure_${task.panel_id}`;
  const figureObject: ImageObject = {
    id: objectId,
    kind: "image",
    mediaId: media.mediaId,
    position: { x: (px0 + px1) / 2, y: py1 - height / 2 },
    size: { x: width, y: height },
    rotation: 0,
    opacity: 1,
    band: "front",
    clipPanelId: null
  };
  const pageRow = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [task.page_id]);
  const objects = normalizePageObjects(pageRow?.objects_json ? JSON.parse(pageRow.objects_json) : []);
  const previous = objects.find((object): object is ImageObject => object.kind === "image" && object.id === objectId);
  // 万一 figure スロットに旧来の矩形割当が残っていたら取り除く(切り抜きの下に敷かれるのを防ぐ)。
  runSql("DELETE FROM page_panel_assignments WHERE page_id = ? AND panel_id = ?", [task.page_id, task.panel_id]);
  const nextObjects = normalizePageObjects([...objects.filter((object) => object.id !== objectId), figureObject]);
  runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify(nextObjects),
    task.page_id
  ]);
  if (previous && previous.mediaId !== media.mediaId) {
    deletePageMedia(previous.mediaId);
  }
  recordFigureResult(run.id, task.id, {
    state: "cutout",
    assetId,
    mediaId: media.mediaId,
    foregroundRatio: Number(cutout.foregroundRatio.toFixed(4))
  });
  reflowLetteringAroundFigure(run, task);
}

export async function selectScriptMangaTaskCandidate(taskId: string, body: unknown): Promise<ScriptMangaRunView> {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  const input = objectBody(body);
  const assetId = requiredString(input.assetId, "assetId");
  if (task.status !== "awaiting_review") throw new HttpError(409, "Task is not awaiting candidate review");
  const candidates = parseJson<string[]>(task.candidate_asset_ids_json, []);
  if (!candidates.includes(assetId)) throw new HttpError(400, "Asset is not in the persisted candidate set");
  if (parseConfig(run).auditMode === "vlm") {
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
  selectTaskCandidateInternal(task, assetId);
  try {
    await materializeFigureForTask(requireTask(task.id), assetId);
  } catch (error) {
    // 立ち絵化の失敗で候補採用まで巻き戻さない(採用は成立、原因は evaluation で追える)。
    recordFigureResult(task.run_id, task.id, {
      state: "failed",
      assetId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  return runView(refreshRunStatus(task.run_id));
}

/** Explicitly queue/retry the VLM audit while retaining human review as the final gate. */
export async function auditScriptMangaTask(taskId: string): Promise<ScriptMangaRunView> {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  const config = parseConfig(run);
  if (config.auditMode !== "vlm") throw new HttpError(409, "This run is configured for manual audit only");
  if (task.status !== "auditing" && task.status !== "awaiting_review") {
    throw new HttpError(409, "Only generated, unselected candidates can be audited");
  }
  if (task.status === "awaiting_review") {
    const scores = parseJson<Record<string, unknown>>(task.scores_json, {});
    runSql("UPDATE script_manga_tasks SET status = 'auditing', scores_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
      JSON.stringify({ ...scores, vlmAudit: { state: "queued" } }),
      task.id
    ]);
  }
  scheduleRunVisualAudit(run.id);
  await activeAuditRuns.get(run.id)?.catch(() => undefined);
  return runView(refreshRunStatus(run.id));
}

/** Exports only the pages owned by a fully reviewed run and persists a reproducible manifest. */
export async function createScriptMangaRunExport(
  runId: string,
  body: unknown
): Promise<ImageExportResult | OpenRasterExportResult> {
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
    const result = format === "ora"
      ? await createOpenRasterExport(run.project_id, { pageIds })
      : await createImageExport(run.project_id, {
          pageIds,
          format,
          pixelWidth: input.pixelWidth,
          quality: input.quality
        });
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
    return result;
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
  const config = parseConfig(run);
  for (const task of getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ?", [run.id])) {
    syncTaskFromRound(task, config);
  }
  scheduleRunVisualAudit(run.id);
  return runView(refreshRunStatus(run.id));
}
