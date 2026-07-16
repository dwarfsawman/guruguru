import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSummary } from "../../shared/apiTypes.ts";
import { projectMangaProgress, renderProjectCard } from "./homeView.ts";

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "project-1",
    name: "Book",
    description: "",
    mode: "book",
    canvasWidth: 1820,
    canvasHeight: 2570,
    updatedAt: "2026-07-16 10:00:00",
    roundCount: 0,
    assetCount: 0,
    pageCount: 1,
    ...overrides
  };
}

test("project list shows the latest active Name Studio human gate and exact IDs", () => {
  const item = project({
    scriptMangaCandidateCount: 3,
    latestScriptMangaCandidateId: "candidate-1",
    latestScriptMangaCandidateScriptId: "script-1",
    latestScriptMangaCandidateRevisionId: "revision-2",
    latestScriptMangaCandidateCreatedAt: "2026-07-16 10:05:00"
  });
  assert.deepEqual(projectMangaProgress(item), {
    kind: "candidate",
    tone: "waiting",
    label: "ネーム選択待ち",
    detail: "3案・人間ゲート",
    projectId: "project-1",
    scriptId: "script-1",
    revisionId: "revision-2",
    candidateId: "candidate-1"
  });
  const html = renderProjectCard(item);
  assert.match(html, /ネーム選択待ち/);
  assert.match(html, /data-action="open-script-manga-progress"/);
  assert.match(html, /data-candidate-id="candidate-1"/);
});

test("project list maps a running CLI manga run to live panel progress", () => {
  const item = project({
    latestScriptMangaRunId: "run-1",
    latestScriptMangaRunScriptId: "script-1",
    latestScriptMangaRunRevisionId: "revision-2",
    latestScriptMangaRunPlanId: "plan-1",
    latestScriptMangaRunStatus: "running",
    latestScriptMangaRunPhase: "rendering",
    latestScriptMangaRunApprovalStatus: "approved",
    latestScriptMangaRunPanelCount: 12,
    latestScriptMangaRunCompletedCount: 5,
    latestScriptMangaRunFailedCount: 1,
    latestScriptMangaRunCreatedAt: "2026-07-16 10:05:00"
  });
  const progress = projectMangaProgress(item);
  assert.equal(progress?.label, "漫画生成中");
  assert.equal(progress?.detail, "5/12コマ・失敗1");
  const html = renderProjectCard(item);
  assert.match(html, /漫画生成中/);
  assert.match(html, /5\/12コマ・失敗1/);
  assert.match(html, /data-run-id="run-1"/);
  assert.match(html, /data-plan-id="plan-1"/);
});

test("project list distinguishes agent-side planning from the later human approval gate", () => {
  const baseRun = {
    latestScriptMangaRunId: "run-1",
    latestScriptMangaRunScriptId: "script-1",
    latestScriptMangaRunRevisionId: "revision-2",
    latestScriptMangaRunPlanId: "plan-1",
    latestScriptMangaRunApprovalStatus: "pending",
    latestScriptMangaRunCreatedAt: "2026-07-16 10:05:00"
  } satisfies Partial<ProjectSummary>;
  assert.equal(projectMangaProgress(project({
    ...baseRun,
    latestScriptMangaRunStatus: "preparing",
    latestScriptMangaRunPhase: "planning"
  }))?.label, "演出ネーム準備中");
  assert.equal(projectMangaProgress(project({
    ...baseRun,
    latestScriptMangaRunStatus: "prepared",
    latestScriptMangaRunPhase: "awaiting_approval"
  }))?.label, "演出ネーム・参照承認待ち");
});

test("a newer active candidate supersedes an older completed run on the project card", () => {
  const progress = projectMangaProgress(project({
    scriptMangaCandidateCount: 2,
    latestScriptMangaCandidateId: "candidate-new",
    latestScriptMangaCandidateScriptId: "script-1",
    latestScriptMangaCandidateRevisionId: "revision-3",
    latestScriptMangaCandidateCreatedAt: "2026-07-16 11:00:00",
    latestScriptMangaRunId: "run-old",
    latestScriptMangaRunScriptId: "script-1",
    latestScriptMangaRunRevisionId: "revision-2",
    latestScriptMangaRunStatus: "completed",
    latestScriptMangaRunCreatedAt: "2026-07-16 10:00:00"
  }));
  assert.equal(progress?.kind, "candidate");
  assert.equal(progress?.candidateId, "candidate-new");
});
