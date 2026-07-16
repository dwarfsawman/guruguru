import assert from "node:assert/strict";
import test from "node:test";
import type { PageLayout } from "../shared/pageLayout";
import type { ScriptMangaPlan } from "../shared/scriptMangaPlan";
import { resolveScriptMangaLayout } from "../shared/layoutPresets.ts";
import { createId, defaultLlmSettings, getRow, getSetting, initializeDb, runSql, setSetting } from "./db.ts";
import { createProject } from "./projects.ts";
import { createScript } from "./scripts.ts";
import { createScriptMangaPlanCandidates } from "./scriptMangaPlanCandidates.ts";
import {
  classifyScriptMangaCandidatePreflightFailure,
  preflightScriptMangaCandidate
} from "./scriptMangaCandidatePreflight.ts";
import { fakeProvider } from "./providers/fakeProvider.ts";
import { registerProvider } from "./providers/registry.ts";

registerProvider(fakeProvider);

test("candidate preflight classifies the minimum-readable-size error with its exact dialogue line", () => {
  const lineId = "line_8002d350-de14-4fc8-b212-a2bd38d4eb35";
  const failure = classifyScriptMangaCandidatePreflightFailure(
    new Error(
      `Dialogue does not fit at the minimum readable size (0.016); split dialogue or re-plan the page: ${lineId}(34 chars)`
    ),
    [{
      line_id: lineId,
      page_id: "page-1",
      page_index: 7,
      text: "あ".repeat(34),
      balloon_object_id: null
    }]
  );
  assert.equal(failure.kind, "dialogue-readability");
  assert.equal(failure.code, "dialogue-minimum-readable-size");
  assert.equal(failure.minimumReadableSize, 0.016);
  assert.deepEqual(failure.dialogueLines, [{
    lineId,
    pageId: "page-1",
    pageIndex: 7,
    characterCount: 34
  }]);
});

const SIMPLE_SCRIPT = [
  "INT. LAB - NIGHT",
  "",
  "A sealed box waits under the work light.",
  "",
  "@ALICE",
  "Is this mine?"
].join("\n");

interface PersistentSnapshot {
  runs: number;
  plans: number;
  pages: number;
  runPages: number;
  tasks: number;
  placements: number;
  dialogueLines: number;
  candidate: {
    status: string;
    adopted_run_id: string | null;
    layout_overrides_json: string | null;
    edit_version: number;
    plan_json: string;
    provenance_json: string | null;
  };
}

function count(sql: string, params: unknown[] = []): number {
  return getRow<{ value: number }>(sql, params)?.value ?? 0;
}

function persistentSnapshot(projectId: string, candidateId: string): PersistentSnapshot {
  return {
    runs: count("SELECT COUNT(*) AS value FROM script_manga_runs WHERE project_id = ?", [projectId]),
    plans: count("SELECT COUNT(*) AS value FROM script_manga_plans WHERE project_id = ?", [projectId]),
    pages: count("SELECT COUNT(*) AS value FROM pages WHERE project_id = ?", [projectId]),
    runPages: count(
      `SELECT COUNT(*) AS value FROM script_manga_run_pages page
        JOIN script_manga_runs run ON run.id = page.run_id
       WHERE run.project_id = ?`,
      [projectId]
    ),
    tasks: count(
      `SELECT COUNT(*) AS value FROM script_manga_tasks task
        JOIN script_manga_runs run ON run.id = task.run_id
       WHERE run.project_id = ?`,
      [projectId]
    ),
    placements: count(
      `SELECT COUNT(*) AS value FROM dialogue_placements placement
        JOIN pages page ON page.id = placement.page_id
       WHERE page.project_id = ?`,
      [projectId]
    ),
    dialogueLines: count("SELECT COUNT(*) AS value FROM dialogue_lines WHERE project_id = ?", [projectId]),
    candidate: getRow<PersistentSnapshot["candidate"]>(
      `SELECT status, adopted_run_id, layout_overrides_json, edit_version, plan_json, provenance_json
         FROM script_manga_plan_candidates WHERE id = ?`,
      [candidateId]
    )!
  };
}

function template(): string {
  initializeDb();
  const id = createId("template");
  runSql(
    `INSERT INTO workflow_templates
       (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Candidate preflight fake', '', 'txt2img', 1, '{}', '{}', 'candidate-preflight-hash')`,
    [id]
  );
  return id;
}

function customSinglePanelLayout(bounds: [number, number, number, number]): string {
  const source = resolveScriptMangaLayout("builtin:splash");
  assert.ok(source);
  const layout = structuredClone(source) as PageLayout;
  layout.panels[0]!.shape = { type: "rect", bounds };
  const id = createId("layout");
  runSql(
    "INSERT INTO layout_templates (id, name, source, layout_json) VALUES (?, 'Candidate preflight layout', 'imported', ?)",
    [id, JSON.stringify(layout)]
  );
  return id;
}

async function candidateFor(projectId: string, fountainSource: string) {
  const imported = createScript(projectId, {
    title: "Candidate preflight",
    fountainSource
  });
  const response = await createScriptMangaPlanCandidates(projectId, {
    scriptId: imported.script.id,
    count: 1
  });
  assert.equal(response.candidates.length, 1);
  return { imported, candidate: response.candidates[0]! };
}

function replaceCandidatePlan(candidateId: string, plan: ScriptMangaPlan): void {
  runSql(
    `UPDATE script_manga_plan_candidates
        SET plan_json = ?, provenance_json = ? WHERE id = ?`,
    [JSON.stringify(plan), JSON.stringify({ origin: "external", directorMode: "provided" }), candidateId]
  );
}

function directedResponse(plan: ScriptMangaPlan): unknown {
  return {
    pages: plan.pages.map((page) => ({
      index: page.index,
      pageIntent: "A clear laboratory reveal",
      panels: page.panels.map((panel) => ({
        id: panel.id,
        shot: "medium",
        angle: "eye-level",
        subjects: [],
        action: "The subject studies the sealed box",
        emotion: "Focused curiosity",
        composition: "Balanced subject and work light",
        prompt: "cinematic manga laboratory scene with a sealed box"
      }))
    }))
  };
}

test("candidate full preflight isolates materialization writes and fixes the exact directed plan on success", async () => {
  initializeDb();
  const project = createProject({ name: `candidate-preflight-ok-${createId("test")}`, mode: "book" })!;
  const templateId = template();
  const { imported, candidate } = await candidateFor(project.id, SIMPLE_SCRIPT);
  const before = persistentSnapshot(project.id, candidate.id);

  const llmServer = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        choices: [{ message: { content: JSON.stringify(directedResponse(candidate.plan)) } }]
      });
    }
  });
  setSetting("llm", {
    ...defaultLlmSettings,
    baseUrl: `http://127.0.0.1:${llmServer.port}`,
    model: "candidate-preflight-director"
  });

  const markerKey = `preflight-concurrent-${createId("setting")}`;
  let concurrentWriteError: unknown = null;
  const pendingReport = preflightScriptMangaCandidate(project.id, candidate.id, {
    templateId,
    providerId: "fake",
    dialoguePolicy: "preserve",
    panelsPerPage: 8,
    maxDialoguesPerPanel: 8,
    expectedCandidateVersion: candidate.editVersion
  });
  queueMicrotask(() => {
    try {
      setSetting(markerKey, { survived: true });
    } catch (error) {
      concurrentWriteError = error;
    }
  });
  let report: Awaited<ReturnType<typeof preflightScriptMangaCandidate>>;
  try {
    report = await pendingReport;
  } finally {
    llmServer.stop(true);
    setSetting("llm", defaultLlmSettings);
  }

  assert.equal(report.ok, true);
  assert.equal(report.failure, null);
  assert.equal(report.scriptId, imported.script.id);
  assert.equal(report.scriptRevisionId, candidate.scriptRevisionId);
  assert.equal(report.checkedPanelTaskCount, candidate.plan.panelCount);
  assert.equal(report.failedPanelTaskCount, 0);
  assert.equal(report.candidateDirectionFixed, true);
  assert.equal(report.candidateDirectionFrozen, true);
  assert.deepEqual(report.skippedChecks, ["reference-sets", "image-generation", "image-audit"]);
  const after = persistentSnapshot(project.id, candidate.id);
  assert.deepEqual(
    { ...after, candidate: before.candidate },
    before,
    "run/page/task/dialogue materialization must stay inside the isolated DB"
  );
  assert.equal(after.candidate.status, "active");
  assert.equal(after.candidate.adopted_run_id, null);
  assert.equal(after.candidate.layout_overrides_json, null);
  assert.equal(after.candidate.edit_version, before.candidate.edit_version + 1);
  assert.equal(report.candidateEditVersion, after.candidate.edit_version);
  assert.equal(report.candidateDirectionModel, "candidate-preflight-director");
  assert.match(report.candidateDirectionInputHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(after.candidate.provenance_json ?? "{}").directorMode, "provided");

  const repeated = await preflightScriptMangaCandidate(project.id, candidate.id, {
    templateId,
    providerId: "fake",
    dialoguePolicy: "preserve",
    panelsPerPage: 8,
    maxDialoguesPerPanel: 8,
    expectedCandidateVersion: report.candidateEditVersion
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.candidateDirectionFixed, true);
  assert.equal(repeated.candidateDirectionFrozen, false);
  assert.equal(repeated.candidateDirectionInputHash, report.candidateDirectionInputHash);
  await assert.rejects(
    () => preflightScriptMangaCandidate(project.id, candidate.id, {
      templateId,
      providerId: "fake",
      dialoguePolicy: "preserve",
      panelsPerPage: 8,
      maxDialoguesPerPanel: 8,
      characterBible: "A different character bible",
      expectedCandidateVersion: report.candidateEditVersion
    }),
    /Direction-affecting candidate settings differ/
  );
  assert.equal(concurrentWriteError, null);
  assert.deepEqual(getSetting(markerKey), { survived: true }, "preflight rollback must not erase another DB writer");
  runSql("DELETE FROM app_settings WHERE key = ?", [markerKey]);
});

test("candidate preflight does not freeze an embedded director fallback", async () => {
  initializeDb();
  setSetting("llm", defaultLlmSettings);
  const project = createProject({ name: `candidate-preflight-llm-${createId("test")}`, mode: "book" })!;
  const templateId = template();
  const { candidate } = await candidateFor(project.id, SIMPLE_SCRIPT);
  const before = persistentSnapshot(project.id, candidate.id);

  await assert.rejects(
    () => preflightScriptMangaCandidate(project.id, candidate.id, {
      templateId,
      providerId: "fake",
      panelsPerPage: 6,
      maxDialoguesPerPanel: 8,
      expectedCandidateVersion: candidate.editVersion
    }),
    (error: unknown) => error instanceof Error && /Embedded director LLM did not complete/.test(error.message)
  );
  assert.deepEqual(persistentSnapshot(project.id, candidate.id), before);
});

test("candidate full preflight returns every persisted panel violation before rollback", async () => {
  initializeDb();
  const project = createProject({ name: `candidate-preflight-panel-${createId("test")}`, mode: "book" })!;
  const templateId = template();
  const actionOnly = ["INT. LAB - NIGHT", "", "A sealed box waits under the work light."].join("\n");
  const { candidate } = await candidateFor(project.id, actionOnly);
  const originalPanel = candidate.plan.pages[0]!.panels[0]!;
  const layoutTemplateId = customSinglePanelLayout([0.1, 0.1, 0.13, 0.13]);
  const plan: ScriptMangaPlan = {
    ...candidate.plan,
    pages: [{
      ...candidate.plan.pages[0]!,
      index: 0,
      layoutTemplateId,
      panels: [originalPanel]
    }],
    panelCount: 1,
    dialogueCount: 0
  };
  replaceCandidatePlan(candidate.id, plan);
  const before = persistentSnapshot(project.id, candidate.id);

  const report = await preflightScriptMangaCandidate(project.id, candidate.id, {
    templateId,
    providerId: "fake",
    dialoguePolicy: "preserve",
    panelsPerPage: 1
  });

  assert.equal(report.ok, false);
  assert.equal(report.failure?.kind, "panel-preflight");
  assert.equal(report.failure?.panelTaskCount, 1);
  assert.equal(report.checkedPanelTaskCount, 1);
  assert.equal(report.failedPanelTaskCount, 1);
  assert.equal(report.panelReports[0]!.pageIndex, 0);
  assert.ok(report.panelReports[0]!.report.violations.some((violation) => violation.code === "layout-geometry"));
  assert.ok(report.issues.some((issue) => issue.code === "layout-geometry" && issue.pageIndex === 0));
  assert.deepEqual(persistentSnapshot(project.id, candidate.id), before);
});

test("candidate full preflight structures dialogue placement failures with line identity", async () => {
  initializeDb();
  const project = createProject({ name: `candidate-preflight-dialogue-${createId("test")}`, mode: "book" })!;
  const templateId = template();
  const longText = "あ".repeat(34);
  const script = [
    "INT. EMPTY ROOM - NIGHT",
    "",
    "A small status light glows in the empty room.",
    "",
    "@ALICE (V.O.)",
    longText
  ].join("\n");
  const { imported, candidate } = await candidateFor(project.id, script);
  const dialoguePanel = candidate.plan.pages
    .flatMap((page) => page.panels)
    .find((panel) => panel.dialogueOrderIndexes.includes(0));
  assert.ok(dialoguePanel);
  const layoutTemplateId = customSinglePanelLayout([0.1, 0.1, 0.22, 0.22]);
  const plan: ScriptMangaPlan = {
    ...candidate.plan,
    pages: [{
      ...candidate.plan.pages[0]!,
      index: 0,
      layoutTemplateId,
      panels: [{ ...dialoguePanel, dialogueOrderIndexes: [0] }]
    }],
    panelCount: 1,
    dialogueCount: 1
  };
  replaceCandidatePlan(candidate.id, plan);
  const before = persistentSnapshot(project.id, candidate.id);

  const report = await preflightScriptMangaCandidate(project.id, candidate.id, {
    templateId,
    providerId: "fake",
    dialoguePolicy: "preserve",
    panelsPerPage: 1,
    maxDialoguesPerPanel: 1
  });

  assert.equal(report.ok, false);
  assert.equal(report.failure?.kind, "dialogue-placement", JSON.stringify(report.failure));
  assert.equal(report.failure.unplacedCount, 1);
  assert.ok(report.failure.dialogueLines?.some((line) => line.lineId === imported.lines[0]!.id));
  assert.ok(report.issues.some((issue) => issue.dialogueLineId === imported.lines[0]!.id && issue.characterCount === 34));
  assert.deepEqual(persistentSnapshot(project.id, candidate.id), before);
});

test("independent fixed candidates can preflight concurrently without leaking isolated writes", async () => {
  initializeDb();
  const project = createProject({ name: `candidate-preflight-parallel-${createId("test")}`, mode: "book" })!;
  const templateId = template();
  const first = await candidateFor(project.id, SIMPLE_SCRIPT);
  const second = await candidateFor(project.id, SIMPLE_SCRIPT.replace("sealed box", "sealed envelope"));
  replaceCandidatePlan(first.candidate.id, first.candidate.plan);
  replaceCandidatePlan(second.candidate.id, second.candidate.plan);
  const firstBefore = persistentSnapshot(project.id, first.candidate.id);
  const secondBefore = persistentSnapshot(project.id, second.candidate.id);

  const [firstReport, secondReport] = await Promise.all([
    preflightScriptMangaCandidate(project.id, first.candidate.id, {
      templateId,
      providerId: "fake",
      panelsPerPage: 6,
      maxDialoguesPerPanel: 8
    }),
    preflightScriptMangaCandidate(project.id, second.candidate.id, {
      templateId,
      providerId: "fake",
      panelsPerPage: 6,
      maxDialoguesPerPanel: 8
    })
  ]);

  assert.equal(firstReport.ok, true);
  assert.equal(secondReport.ok, true);
  assert.deepEqual(persistentSnapshot(project.id, first.candidate.id), firstBefore);
  assert.deepEqual(persistentSnapshot(project.id, second.candidate.id), secondBefore);
});
