import {
  type MangaPlanV2,
  type MangaPlanValidationReport,
  normalizeMangaPlanV2Scales,
  validateMangaPlanV2
} from "../shared/mangaPlanV2";
import { normalizeEditedPageLayout, type PageLayout } from "../shared/pageLayout";
import type { ScriptMangaPlanOptions } from "../shared/scriptMangaPlan";
import type { StyleLoraSelection } from "../shared/types";
import type { ScriptMangaPlanView, ScriptMangaRunView, ScriptMangaTaskView } from "../shared/scriptMangaApi";
import type { ReferenceModelFamily, ScriptMangaReferenceSnapshot } from "../shared/referenceSets";
import type { PoseControlMode } from "./panelPoseReconstructor";
import { inferPromptProfile } from "./templates";
import { getRow, getRows, runSql } from "./db";
import { HttpError } from "./http";

export interface RunRow {
  id: string;
  predecessor_run_id: string | null;
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

export interface TaskRow {
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
  inherited_from_task_id: string | null;
  reuse_fingerprint: string | null;
  reuse_source_json: string | null;
  dependency_task_ids_json: string;
  status: string;
  asset_id: string | null;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanRow {
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
  edit_version: number;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

/** 棒人間ControlNet(ネームv4 D4)。既定OFF・弱め/早期終了(骨格で漫画的デフォルメを殺さない)。 */
export interface PoseControlConfig {
  enabled: boolean;
  mode: PoseControlMode;
  strength: number;
  endPercent: number;
}

export interface ScriptMangaRunConfig {
  templateId: string;
  providerId: string;
  batchSize: 1;
  planningMode: "heuristic" | "llm" | "provided";
  pageLimit: number;
  maxPanelCount: number;
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
  poseControl?: PoseControlConfig;
  /** Persisted before materialization so startup can reconcile a crash after candidate claim. */
  planCandidateId?: string;
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function errorJson(error: unknown): string {
  return JSON.stringify({ message: error instanceof Error ? error.message : String(error) });
}

export function requireRun(runId: string): RunRow {
  const row = getRow<RunRow>("SELECT * FROM script_manga_runs WHERE id = ?", [runId]);
  if (!row) throw new HttpError(404, "Script manga run was not found");
  return row;
}

export function requirePlan(planId: string): PlanRow {
  const row = getRow<PlanRow>("SELECT * FROM script_manga_plans WHERE id = ?", [planId]);
  if (!row) throw new HttpError(404, "Script manga plan was not found");
  return row;
}

export function requireTask(taskId: string): TaskRow {
  const row = getRow<TaskRow>("SELECT * FROM script_manga_tasks WHERE id = ?", [taskId]);
  if (!row) throw new HttpError(404, "Script manga task was not found");
  return row;
}

export function planFromRow(row: PlanRow): MangaPlanV2 {
  const plan = parseJson<MangaPlanV2>(row.plan_json, null as unknown as MangaPlanV2);
  // V5 D1: 旧語彙(importance)だけの旧planへ visualScale を補完する入力adapter。
  return plan ? normalizeMangaPlanV2Scales(plan) : plan;
}

export function planView(row: PlanRow): ScriptMangaPlanView {
  return {
    id: row.id,
    projectId: row.project_id,
    scriptId: row.script_id,
    scriptRevisionId: row.script_revision_id,
    status: row.status,
    plan: planFromRow(row),
    validation: parseJson<MangaPlanValidationReport>(row.validation_json, { ok: false, issues: [] }),
    editVersion: row.edit_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at
  };
}

/** assets 実在チェック用の id 一括取得(taskView の per-task SELECT を IN 1回に集約する)。 */
export function fetchExistingAssetIds(assetIds: Iterable<string>): ReadonlySet<string> {
  const distinct = [...new Set(assetIds)];
  const existing = new Set<string>();
  const CHUNK = 400;
  for (let offset = 0; offset < distinct.length; offset += CHUNK) {
    const chunk = distinct.slice(offset, offset + CHUNK);
    const rows = getRows<{ id: string }>(
      `SELECT id FROM assets WHERE id IN (${chunk.map(() => "?").join(", ")})`,
      chunk
    );
    for (const row of rows) existing.add(row.id);
  }
  return existing;
}

export function taskView(row: TaskRow, existingAssetIds?: ReadonlySet<string>): ScriptMangaTaskView {
  const selectedId = row.selected_asset_id ?? row.asset_id;
  const selectedAssetId = selectedId && (existingAssetIds
    ? existingAssetIds.has(selectedId)
    : Boolean(getRow("SELECT id FROM assets WHERE id = ?", [selectedId])))
    ? selectedId
    : null;
  return {
    id: row.id,
    pageId: row.page_id,
    panelId: row.panel_id,
    roundId: row.round_id,
    status: row.status,
    attemptCount: row.attempt_count,
    candidateAssetIds: parseJson<string[]>(row.candidate_asset_ids_json, []),
    selectedAssetId,
    inheritedFromTaskId: row.inherited_from_task_id,
    reuseFingerprint: row.reuse_fingerprint,
    scores: parseJson<unknown>(row.scores_json, null),
    lastError: parseJson<unknown>(row.last_error_json, null)
  };
}

export function runView(row: RunRow): ScriptMangaRunView {
  const planRow = row.plan_id ? getRow<PlanRow>("SELECT * FROM script_manga_plans WHERE id = ?", [row.plan_id]) : null;
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at ASC", [row.id]);
  const existingAssetIds = fetchExistingAssetIds(
    tasks.flatMap((task) => {
      const selectedId = task.selected_asset_id ?? task.asset_id;
      return selectedId ? [selectedId] : [];
    })
  );
  return {
    id: row.id,
    predecessorRunId: row.predecessor_run_id,
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
    planEditVersion: planRow ? planRow.edit_version : null,
    validation: planRow ? parseJson<MangaPlanValidationReport>(planRow.validation_json, { ok: false, issues: [] }) : null,
    tasks: tasks.map((task) => taskView(task, existingAssetIds)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

export function templatePromptProfile(templateId: string) {
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

export function referenceModelFamily(templateId: string): ReferenceModelFamily | null {
  const workflowJson = templatePromptProfile(templateId).workflowJson;
  if (!workflowJson) return null;
  if (/anima|qwen_3_06b_base/iu.test(workflowJson)) return "anima";
  if (/chroma|auraflow|ModelSamplingAuraFlow/iu.test(workflowJson)) return "chroma";
  return null;
}

export function frozenReferenceSnapshot(run: RunRow): ScriptMangaReferenceSnapshot | null {
  return parseJson<ScriptMangaReferenceSnapshot | null>(run.reference_snapshot_json, null);
}

export function validatePlan(plan: MangaPlanV2): MangaPlanValidationReport {
  return validateMangaPlanV2(plan);
}

export function clonePageLayout(layout: PageLayout): PageLayout {
  return JSON.parse(JSON.stringify(layout)) as PageLayout;
}

export function parseConfig(run: RunRow): ScriptMangaRunConfig {
  const parsed = parseJson<Partial<ScriptMangaRunConfig>>(run.config_json, {});
  return {
    ...parsed,
    auditMode: parsed.auditMode === "vlm" ? "vlm" : "manual",
    maxPanelCount: typeof parsed.maxPanelCount === "number" ? parsed.maxPanelCount : 0
  } as ScriptMangaRunConfig;
}

/**
 * 生成系の入口で config の必須フィールドを検証する。壊れた config_json のまま生成要求へ進むと
 * templateId: undefined で不可解に失敗するため、ここで明示エラーにする(表示系 parseConfig は
 * レガシーrunの閲覧を壊さないよう lenient のまま)。
 */
export function requireGenerationConfig(run: RunRow): ScriptMangaRunConfig {
  const config = parseConfig(run);
  if (typeof config.templateId !== "string" || !config.templateId) {
    throw new HttpError(422, `Run ${run.id} has a corrupt config_json (missing templateId)`);
  }
  return config;
}

export function pageLayout(pageId: string): PageLayout {
  const row = getRow<{ layout_json: string | null }>("SELECT layout_json FROM pages WHERE id = ?", [pageId]);
  const layout = normalizeEditedPageLayout(row?.layout_json ? JSON.parse(row.layout_json) : null);
  if (!layout) throw new HttpError(500, `Page ${pageId} has no executable layout`);
  return layout;
}

export function refreshRunStatus(runId: string): RunRow {
  const run = requireRun(runId);
  if (run.status === "canceled" || run.status === "exporting" || (run.status === "failed" && run.phase !== "rendering")) return run;
  // 集計に使う列だけ取得する(panel_spec_json 等の巨大JSON列をポーリング毎に持ち出さない)。
  const tasks = getRows<Pick<TaskRow, "status" | "scores_json">>(
    "SELECT status, scores_json FROM script_manga_tasks WHERE run_id = ?",
    [run.id]
  );
  const completed = tasks.filter((task) => task.status === "completed").length;
  const failed = tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
  const selecting = tasks.filter((task) => task.status === "selecting").length;
  const awaitingReview = tasks.filter((task) => task.status === "awaiting_review").length + selecting;
  const auditing = tasks.filter((task) => task.status === "auditing").length;
  const active = tasks.filter((task) => task.status === "running" || task.status === "submitting" || task.status === "inheriting").length;
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
    selecting,
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
