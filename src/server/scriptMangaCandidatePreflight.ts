import type { PanelPreflightReport } from "./panelPreflightValidator";
import {
  createScriptMangaRun,
  scriptMangaCandidateDirectionOptionsFromInput
} from "./scriptManga";
import {
  adoptablePlanCandidate,
  fixedEmbeddedCandidateDirection,
  freezeEmbeddedDirectedPlanCandidate,
  isFixedDirectedPlanCandidate,
  requirePlanCandidate,
  scriptMangaCandidateDirectionInputHash
} from "./scriptMangaPlanCandidates";
import { directAdoptedCandidatePlanDetailed } from "./scriptMangaDirector";
import type { FountainDoc } from "../shared/fountain";
import type { ScriptMangaPlan } from "../shared/scriptMangaPlan";
import {
  createIsolatedDatabaseSnapshot,
  getRow,
  getRows,
  runSql,
  withDatabaseConnection
} from "./db";
import { HttpError } from "./http";
import { objectBody, requiredString } from "./validate";

export type ScriptMangaCandidatePreflightStage =
  | "panel-preflight"
  | "dialogue-placement"
  | "dialogue-readability"
  | "plan-validation"
  | "configuration"
  | "materialization";

export interface ScriptMangaCandidatePreflightIssue {
  stage: ScriptMangaCandidatePreflightStage;
  code: string;
  severity: "error" | "warning";
  message: string;
  taskId?: string;
  pageId?: string;
  pageIndex?: number;
  panelId?: string;
  panelSpecId?: string;
  layoutPanelId?: string;
  dialogueLineId?: string;
  characterCount?: number;
}

export interface ScriptMangaCandidatePanelPreflightReport {
  taskId: string;
  pageId: string;
  pageIndex: number;
  panelId: string;
  taskStatus: string;
  report: PanelPreflightReport;
}

export interface ScriptMangaCandidateDialogueLineReport {
  lineId: string;
  pageId: string;
  pageIndex: number;
  characterCount: number;
}

export interface ScriptMangaCandidatePreflightFailure {
  kind:
    | "panel-preflight"
    | "dialogue-placement"
    | "dialogue-readability"
    | "plan-validation"
    | "configuration"
    | "materialization";
  code: string;
  message: string;
  statusCode: number | null;
  panelTaskCount?: number;
  unplacedCount?: number;
  minimumReadableSize?: number;
  dialogueLines?: ScriptMangaCandidateDialogueLineReport[];
}

export interface ScriptMangaCandidatePreflightReport {
  ok: boolean;
  candidateId: string;
  projectId: string;
  scriptId: string;
  scriptRevisionId: string;
  candidateEditVersion: number;
  /** true when the persisted candidate now contains the exact directed plan checked here. */
  candidateDirectionFixed: boolean;
  /** true only when this successful preflight fixed an embedded-directed candidate. */
  candidateDirectionFrozen: boolean;
  /** SHA-256 of the direction-affecting settings for embedded fixed candidates. */
  candidateDirectionInputHash: string | null;
  candidateDirectionModel: string | null;
  /** Checks intentionally outside structural/materialization preflight. */
  skippedChecks: Array<"reference-sets" | "image-generation" | "image-audit">;
  /** task/page/materialized panel ids in this report exist only inside the discarded snapshot. */
  materializationIdsEphemeral: true;
  checkedPanelTaskCount: number;
  failedPanelTaskCount: number;
  panelReports: ScriptMangaCandidatePanelPreflightReport[];
  issues: ScriptMangaCandidatePreflightIssue[];
  failure: ScriptMangaCandidatePreflightFailure | null;
}

interface TaskReportRow {
  task_id: string;
  page_id: string;
  page_index: number;
  panel_id: string;
  status: string;
  scores_json: string | null;
}

export interface ScriptMangaCandidatePreflightDialoguePlacement {
  line_id: string;
  page_id: string;
  page_index: number;
  text: string;
  balloon_object_id: string | null;
}

const SAVEPOINT_NAME = "script_manga_candidate_preflight";

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isPanelPreflightReport(value: unknown): value is PanelPreflightReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<PanelPreflightReport>;
  return (
    typeof report.passed === "boolean" &&
    typeof report.panelSpecId === "string" &&
    typeof report.layoutPanelId === "string" &&
    Array.isArray(report.violations) &&
    Boolean(report.checks) &&
    typeof report.checks === "object"
  );
}

function panelReportsForRun(runId: string): ScriptMangaCandidatePanelPreflightReport[] {
  const rows = getRows<TaskReportRow>(
    `SELECT task.id AS task_id, task.page_id, run_page.page_index, task.panel_id, task.status, task.scores_json
       FROM script_manga_tasks task
       JOIN script_manga_run_pages run_page
         ON run_page.run_id = task.run_id AND run_page.page_id = task.page_id
      WHERE task.run_id = ?
      ORDER BY run_page.page_index ASC, task.created_at ASC, task.id ASC`,
    [runId]
  );
  return rows.flatMap((row) => {
    const scores = parseJson(row.scores_json);
    const preflight = scores && typeof scores === "object"
      ? (scores as { preflight?: unknown }).preflight
      : null;
    if (!isPanelPreflightReport(preflight)) return [];
    return [{
      taskId: row.task_id,
      pageId: row.page_id,
      pageIndex: row.page_index,
      panelId: row.panel_id,
      taskStatus: row.status,
      report: preflight
    }];
  });
}

function dialoguePlacementsForRun(runId: string): ScriptMangaCandidatePreflightDialoguePlacement[] {
  return getRows<ScriptMangaCandidatePreflightDialoguePlacement>(
    `SELECT placement.line_id, placement.page_id, run_page.page_index,
            COALESCE(placement.text_override, line.text) AS text,
            placement.balloon_object_id
       FROM script_manga_run_pages run_page
       JOIN dialogue_placements placement ON placement.page_id = run_page.page_id
       JOIN dialogue_lines line ON line.id = placement.line_id
      WHERE run_page.run_id = ?
      ORDER BY run_page.page_index ASC,
               COALESCE(placement.order_index_override, line.order_index) ASC,
               placement.part_index ASC`,
    [runId]
  );
}

function lineReport(
  row: ScriptMangaCandidatePreflightDialoguePlacement,
  characterCount?: number
): ScriptMangaCandidateDialogueLineReport {
  return {
    lineId: row.line_id,
    pageId: row.page_id,
    pageIndex: row.page_index,
    characterCount: characterCount ?? Array.from(row.text).length
  };
}

export function classifyScriptMangaCandidatePreflightFailure(
  error: unknown,
  placements: readonly ScriptMangaCandidatePreflightDialoguePlacement[]
): ScriptMangaCandidatePreflightFailure {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = error instanceof HttpError ? error.statusCode : null;
  const readableMatch = message.match(/minimum readable size \(([0-9.]+)\)/i);
  if (readableMatch) {
    const byId = new Map(placements.map((row) => [row.line_id, row]));
    const parsedLines = [...message.matchAll(/([A-Za-z][A-Za-z0-9_-]*)\((\d+) chars\)/g)];
    const dialogueLines = parsedLines.flatMap((match) => {
      const row = byId.get(match[1]!);
      return row ? [lineReport(row, Number(match[2]))] : [];
    });
    return {
      kind: "dialogue-readability",
      code: "dialogue-minimum-readable-size",
      message,
      statusCode,
      minimumReadableSize: Number(readableMatch[1]),
      dialogueLines
    };
  }

  const unplacedMatch = message.match(/中止しました\((\d+)件\)/);
  if (unplacedMatch) {
    const unresolved = placements.filter((row) => !row.balloon_object_id);
    return {
      kind: "dialogue-placement",
      code: "dialogue-unplaced",
      message,
      statusCode,
      unplacedCount: Number(unplacedMatch[1]),
      dialogueLines: unresolved.map((row) => lineReport(row))
    };
  }

  const panelMatch = message.match(/(\d+) panel task\(s\) failed deterministic preflight/i);
  if (panelMatch) {
    return {
      kind: "panel-preflight",
      code: "panel-preflight-failed",
      message,
      statusCode,
      panelTaskCount: Number(panelMatch[1])
    };
  }

  if (/MangaPlanV2|directorPlan|panel budget|dialogue budget|panels per page/i.test(message)) {
    return {
      kind: "plan-validation",
      code: "plan-validation-failed",
      message,
      statusCode
    };
  }

  if (statusCode === 400 || statusCode === 404 || statusCode === 409) {
    return {
      kind: "configuration",
      code: "preflight-configuration",
      message,
      statusCode
    };
  }

  return {
    kind: "materialization",
    code: "materialization-failed",
    message,
    statusCode
  };
}

function panelIssues(
  reports: ScriptMangaCandidatePanelPreflightReport[]
): ScriptMangaCandidatePreflightIssue[] {
  return reports.flatMap((task) => task.report.violations.map((violation) => ({
    stage: "panel-preflight" as const,
    code: violation.code,
    severity: violation.severity,
    message: violation.message,
    taskId: task.taskId,
    pageId: task.pageId,
    pageIndex: task.pageIndex,
    panelId: task.panelId,
    panelSpecId: task.report.panelSpecId,
    layoutPanelId: task.report.layoutPanelId
  })));
}

function failureIssues(failure: ScriptMangaCandidatePreflightFailure): ScriptMangaCandidatePreflightIssue[] {
  if (
    (failure.kind === "dialogue-placement" || failure.kind === "dialogue-readability") &&
    failure.dialogueLines?.length
  ) {
    return failure.dialogueLines.map((line) => ({
      stage: failure.kind,
      code: failure.code,
      severity: "error",
      message: failure.message,
      pageId: line.pageId,
      pageIndex: line.pageIndex,
      dialogueLineId: line.lineId,
      characterCount: line.characterCount
    }));
  }
  return [{
    stage: failure.kind,
    code: failure.code,
    severity: "error",
    message: failure.message
  }];
}

/**
 * Runs the candidate's effective plan through the real candidate-adoption materialization path in
 * an isolated in-memory database. Run/page/task/placement writes never reach the persistent DB.
 * On success, an embedded candidate's directed plan is intentionally fixed once in the persistent
 * candidate so the later adoption consumes the exact plan that passed this check. Feasibility
 * failures are data in `failure`/`issues`; ownership and stale-state checks use HttpError.
 */
export async function preflightScriptMangaCandidate(
  projectId: string,
  candidateId: string,
  body: unknown
): Promise<ScriptMangaCandidatePreflightReport> {
  const input = objectBody(body);
  const templateId = requiredString(input.templateId, "templateId");
  const expectedVersion = typeof input.expectedCandidateVersion === "number" && Number.isInteger(input.expectedCandidateVersion)
    ? input.expectedCandidateVersion
    : undefined;

  // Each request owns a separate in-memory connection, so A/B/C preflights may safely run in
  // parallel; their SAVEPOINT names and async DB contexts cannot collide.
  // 本番singleton接続上のSAVEPOINTは、await中に入った別requestのwriteまで巻き戻し得る。
  // 同時点のインメモリsnapshotへ全repository helperを向け、dry-runを完全に隔離する。
  const isolated = createIsolatedDatabaseSnapshot();
  let isolatedResult: {
    report: ScriptMangaCandidatePreflightReport;
    directedPlan: ScriptMangaPlan;
    freezeOriginalVersion: number | null;
    direction: { inputHash: string; model: string | null };
  };
  try {
    isolatedResult = await withDatabaseConnection(isolated, async () => {
      // queue待ち後のsnapshot内でstatus/revision/version/effective planを取り直す。
      const candidateRow = requirePlanCandidate(candidateId);
      if (candidateRow.project_id !== projectId) {
        throw new HttpError(404, "Plan candidate does not belong to this project");
      }
      const latestRevision = getRow<{ id: string; parsed_json: string }>(
        "SELECT id, parsed_json FROM script_revisions WHERE script_id = ? ORDER BY revision DESC LIMIT 1",
        [candidateRow.script_id]
      );
      if (!latestRevision) throw new HttpError(400, "Script has no Fountain revision");
      let candidate = adoptablePlanCandidate(
        candidateId,
        projectId,
        candidateRow.script_id,
        latestRevision.id,
        expectedVersion
      );
      let directedPlan = candidate.plan;
      let candidateVersionForDryRun = candidateRow.edit_version;
      let freezeOriginalVersion: number | null = null;
      const directionWasFixed = isFixedDirectedPlanCandidate(candidate.row);
      const directionOptions = scriptMangaCandidateDirectionOptionsFromInput(input, latestRevision.id);
      const directionInputHash = scriptMangaCandidateDirectionInputHash(directionOptions);
      const fixedDirection = fixedEmbeddedCandidateDirection(candidate.row, directionInputHash);
      let direction = fixedDirection ?? {
        inputHash: directionInputHash,
        model: null
      };
      if (!directionWasFixed) {
        const doc = JSON.parse(latestRevision.parsed_json) as FountainDoc;
        const directed = await directAdoptedCandidatePlanDetailed(
          doc,
          candidate.plan,
          directionOptions
        );
        if (directed.fallback) {
          throw new HttpError(
            503,
            "Embedded director LLM did not complete every page batch; import an externally directed plan or restore the LLM connection"
          );
        }
        directedPlan = directed.plan;
        direction = {
          inputHash: directionInputHash,
          model: directedPlan.plannerProvenance?.model ?? null
        };
        freezeOriginalVersion = candidateRow.edit_version;
        const frozen = freezeEmbeddedDirectedPlanCandidate(
          candidateId,
          candidateRow.edit_version,
          directedPlan,
          direction
        );
        candidateVersionForDryRun = frozen.editVersion;
        candidate = adoptablePlanCandidate(
          candidateId,
          projectId,
          candidateRow.script_id,
          latestRevision.id,
          candidateVersionForDryRun
        );
      }

      runSql(`SAVEPOINT ${SAVEPOINT_NAME}`);
      try {
        const beforeRunRowId = getRow<{ value: number }>(
          "SELECT COALESCE(MAX(rowid), 0) AS value FROM script_manga_runs"
        )?.value ?? 0;
        let runId: string | null = null;
        let caught: unknown = null;
        try {
          const run = await createScriptMangaRun(projectId, {
            ...input,
            scriptId: candidateRow.script_id,
            templateId,
            planCandidateId: candidateId,
            expectedCandidateVersion: candidateVersionForDryRun,
            predecessorRunId: undefined,
            successorPlan: undefined,
            pageLimit: candidate.plan.pages.length,
            generateImages: false,
            requireReferenceSets: false,
            candidateSelectionPolicy: "review",
            auditMode: "manual"
          });
          runId = run.id;
        } catch (error) {
          caught = error;
          // isolated snapshotではこのdry-run以外のINSERTは存在しない。
          runId = getRow<{ id: string }>(
            "SELECT id FROM script_manga_runs WHERE rowid > ? ORDER BY rowid DESC LIMIT 1",
            [beforeRunRowId]
          )?.id ?? null;
        }

        const reports = runId ? panelReportsForRun(runId) : [];
        const placements = runId ? dialoguePlacementsForRun(runId) : [];
        const failure = caught === null ? null : classifyScriptMangaCandidatePreflightFailure(caught, placements);
        const issues = [
          ...panelIssues(reports),
          ...(failure ? failureIssues(failure) : [])
        ];
        const failedPanelTaskCount = reports.filter((report) => !report.report.passed).length;
        return {
          report: {
            ok: failure === null && failedPanelTaskCount === 0,
            candidateId,
            projectId,
            scriptId: candidateRow.script_id,
            scriptRevisionId: candidateRow.script_revision_id,
            candidateEditVersion: candidateRow.edit_version,
            candidateDirectionFixed: directionWasFixed,
            candidateDirectionFrozen: false,
            candidateDirectionInputHash: fixedDirection?.inputHash ?? null,
            candidateDirectionModel: fixedDirection?.model ?? null,
            skippedChecks: ["reference-sets", "image-generation", "image-audit"],
            materializationIdsEphemeral: true,
            checkedPanelTaskCount: reports.length,
            failedPanelTaskCount,
            panelReports: reports,
            issues,
            failure
          },
          directedPlan,
          freezeOriginalVersion,
          direction
        };
      } finally {
        try {
          runSql(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
        } finally {
          runSql(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
        }
      }
    });
  } finally {
    isolated.close();
  }

  // The snapshot may have spent minutes in the embedded director. Never green-light a stale
  // candidate: all report outcomes are bound to the still-active production row and latest revision.
  const liveLatestRevision = getRow<{ id: string }>(
    "SELECT id FROM script_revisions WHERE script_id = ? ORDER BY revision DESC LIMIT 1",
    [isolatedResult.report.scriptId]
  );
  if (!liveLatestRevision || liveLatestRevision.id !== isolatedResult.report.scriptRevisionId) {
    throw new HttpError(409, "Script revision changed while candidate preflight was running");
  }
  const liveExpectedVersion = isolatedResult.freezeOriginalVersion
    ?? isolatedResult.report.candidateEditVersion;
  const liveCandidate = adoptablePlanCandidate(
    candidateId,
    projectId,
    isolatedResult.report.scriptId,
    liveLatestRevision.id,
    liveExpectedVersion
  );
  if (liveCandidate.row.status !== "active") {
    throw new HttpError(409, "Plan candidate is no longer active after preflight");
  }
  if (isolatedResult.report.ok && isolatedResult.freezeOriginalVersion !== null) {
    const frozen = freezeEmbeddedDirectedPlanCandidate(
      candidateId,
      isolatedResult.freezeOriginalVersion,
      isolatedResult.directedPlan,
      isolatedResult.direction
    );
    isolatedResult.report.candidateEditVersion = frozen.editVersion;
    isolatedResult.report.candidateDirectionFixed = true;
    isolatedResult.report.candidateDirectionFrozen = true;
    isolatedResult.report.candidateDirectionInputHash = isolatedResult.direction.inputHash;
    isolatedResult.report.candidateDirectionModel = isolatedResult.direction.model;
  }
  return isolatedResult.report;
}
