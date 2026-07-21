import type { PanelSpec } from "../shared/mangaPlanV2";
import type {
  RecordExternalScriptMangaTaskAuditResponse,
  ScriptMangaExternalAuditReport,
  ScriptMangaRunView
} from "../shared/scriptMangaApi";
import { releaseComfyModelsForAudit } from "./comfy";
import { getRow, getRows, runSql } from "./db";
import { HttpError } from "./http";
import { evaluatePanelCandidate } from "./panelVisualEvaluator";
import { evaluateDeterministicPanelQuality } from "./deterministicPanelQuality";
import { acquireVlmModel, getVlmAuditSettings, releaseVlmModel } from "./vlmAudit";
import { objectBody, requiredString } from "./validate";
import { submitTasks } from "./scriptMangaSubmission";
import {
  parseConfig,
  parseJson,
  refreshRunStatus,
  requireRun,
  requireTask,
  runView,
  type ScriptMangaRunConfig,
  type TaskRow
} from "./scriptMangaRows";

const activeAuditRuns = new Map<string, Promise<void>>();
let visualAuditQueue: Promise<void> = Promise.resolve();

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

export function syncTaskFromRound(task: TaskRow, config: ScriptMangaRunConfig): void {
  if (
    !task.round_id ||
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "blocked" ||
    task.status === "canceled" ||
    task.status === "selecting" ||
    task.status === "awaiting_review" ||
    task.status === "auditing"
  ) return;
  const hasFallbackCandidates = parseJson<string[]>(task.candidate_asset_ids_json, []).length > 0;
  const round = getRow<{ status: string; last_error_json: string | null }>("SELECT status, last_error_json FROM generation_rounds WHERE id = ?", [
    task.round_id
  ]);
  if (!round) {
    runSql(
      "UPDATE script_manga_tasks SET status = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [hasFallbackCandidates ? "awaiting_review" : "failed", JSON.stringify({ message: "Generation round no longer exists" }), task.id]
    );
    return;
  }
  if (round?.status === "completed") {
    const scores = candidateScores(task);
    if (scores.length === 0) {
      runSql(
        "UPDATE script_manga_tasks SET status = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [
          hasFallbackCandidates ? "awaiting_review" : "failed",
          JSON.stringify({ message: "Generation completed without any candidate assets" }),
          task.id
        ]
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
      "UPDATE script_manga_tasks SET status = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [hasFallbackCandidates ? "awaiting_review" : "failed", round.last_error_json, task.id]
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
  if (allTasks.some((task) => task.status === "pending" || task.status === "inheriting" || task.status === "submitting" || task.status === "running" || task.status === "selecting")) {
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

export function scheduleRunVisualAudit(runId: string): void {
  if (activeAuditRuns.has(runId)) return;
  const run = requireRun(runId);
  const config = parseConfig(run);
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ?", [runId]);
  if (!tasks.some((task) => task.status === "auditing")) return;
  if (tasks.some((task) => task.status === "pending" || task.status === "inheriting" || task.status === "submitting" || task.status === "running" || task.status === "selecting")) return;

  const operation = visualAuditQueue.then(() => config.auditMode === "vlm" ? performRunVisualAudit(runId) : performRunDeterministicAudit(runId));
  visualAuditQueue = operation.catch(() => undefined);
  activeAuditRuns.set(runId, operation);
  void operation
    .catch((error) => markVisualAuditUnavailable(runId, error, /deferred/i.test(error instanceof Error ? error.message : String(error))))
    .finally(() => activeAuditRuns.delete(runId));
}

function requiredExternalAuditText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new HttpError(400, `${name} is too long`);
  return normalized;
}

function externalAuditNotes(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HttpError(400, "notes must be a string");
  const normalized = value.trim();
  if (normalized.length > 2000) throw new HttpError(400, "notes is too long");
  return normalized;
}

function externalAuditChecks(value: unknown): Record<string, "pass" | "fail"> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "checks must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) throw new HttpError(400, "checks has too many entries");
  const checks: Record<string, "pass" | "fail"> = {};
  for (const [rawName, result] of entries) {
    const name = rawName.trim();
    if (!name || name.length > 80 || (result !== "pass" && result !== "fail")) {
      throw new HttpError(400, "checks must contain short names with pass or fail values");
    }
    checks[name] = result;
  }
  return checks;
}

function externalAuditViolations(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new HttpError(400, "violations must be a bounded string array");
  }
  const violations: string[] = [];
  for (const rawViolation of value) {
    if (typeof rawViolation !== "string" || !rawViolation.trim() || rawViolation.length > 300) {
      throw new HttpError(400, "violations must contain short non-empty strings");
    }
    const violation = rawViolation.trim();
    if (!violations.includes(violation)) violations.push(violation);
  }
  return violations;
}

/**
 * Persist an explicit external-agent review without retaining the caller's raw payload. Manual
 * selection stays backward compatible when no report exists, while an explicit failed report is
 * authoritative for that candidate until it is replaced or the task is retried.
 */
export function recordExternalScriptMangaTaskAudit(
  taskId: string,
  body: unknown
): RecordExternalScriptMangaTaskAuditResponse {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  if (parseConfig(run).auditMode !== "manual") {
    throw new HttpError(409, "Only manual-audit runs accept external audit results");
  }
  if (run.approval_status !== "approved" || run.status === "canceled") {
    throw new HttpError(409, "Task cannot accept external audit in the current run state");
  }
  if (task.status !== "awaiting_review") throw new HttpError(409, "Task is not awaiting candidate review");

  const input = objectBody(body);
  const assetId = requiredString(input.assetId, "assetId");
  const candidates = parseJson<string[]>(task.candidate_asset_ids_json, []);
  if (!candidates.includes(assetId)) throw new HttpError(400, "Asset is not in the persisted candidate set");
  if (typeof input.passed !== "boolean") throw new HttpError(400, "passed must be a boolean");
  if (input.score !== undefined && (
    typeof input.score !== "number" || !Number.isFinite(input.score) || input.score < 0 || input.score > 1
  )) {
    throw new HttpError(400, "score must be between 0 and 1");
  }

  const report: ScriptMangaExternalAuditReport = {
    assetId,
    passed: input.passed,
    ...(typeof input.score === "number" ? { score: input.score } : {}),
    checks: externalAuditChecks(input.checks),
    violations: externalAuditViolations(input.violations),
    reviewer: requiredExternalAuditText(input.reviewer, "reviewer", 160),
    model: requiredExternalAuditText(input.model, "model", 160),
    notes: externalAuditNotes(input.notes),
    evaluatedAt: new Date().toISOString()
  };
  const scores = parseJson<Record<string, unknown>>(task.scores_json, {});
  const previousAudit = scores.externalAudit && typeof scores.externalAudit === "object" && !Array.isArray(scores.externalAudit)
    ? scores.externalAudit as { reports?: unknown }
    : {};
  const previousReports = Array.isArray(previousAudit.reports)
    ? previousAudit.reports.filter((candidate): candidate is Record<string, unknown> => (
        Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)
      ))
    : [];
  const reports = [
    ...previousReports.filter((candidate) => candidate.assetId !== assetId),
    report
  ];
  const updated = runSql(
    `UPDATE script_manga_tasks SET scores_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'awaiting_review'`,
    [JSON.stringify({
      ...scores,
      externalAudit: { state: "completed", reports, updatedAt: report.evaluatedAt }
    }), task.id]
  ) as { changes?: number };
  if (updated.changes !== 1) throw new HttpError(409, "Task stopped accepting the external audit result");
  return { report, run: runView(refreshRunStatus(task.run_id)) };
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
    const claimed = runSql("UPDATE script_manga_tasks SET status = 'auditing', scores_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'awaiting_review'", [
      JSON.stringify({ ...scores, vlmAudit: { state: "queued" } }),
      task.id
    ]) as { changes?: number };
    if (claimed.changes !== 1) throw new HttpError(409, "Task stopped accepting the audit request");
  }
  scheduleRunVisualAudit(run.id);
  await activeAuditRuns.get(run.id)?.catch(() => undefined);
  return runView(refreshRunStatus(run.id));
}
