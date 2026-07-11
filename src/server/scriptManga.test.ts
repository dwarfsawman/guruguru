import assert from "node:assert/strict";
import test from "node:test";
import { createId, getRow, getRows, initializeDb, runSql } from "./db.ts";
import { createProject } from "./projects.ts";
import { createScript } from "./scripts.ts";
import { collectRound } from "./rounds.ts";
import { createScriptMangaRun, getScriptMangaRun } from "./scriptManga.ts";
import { fakeProvider, resetFakeProvider } from "./providers/fakeProvider.ts";
import { registerProvider } from "./providers/registry.ts";

registerProvider(fakeProvider);

function template(): string {
  initializeDb();
  const id = createId("template");
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Script manga fake', '', 'txt2img', 1, '{}', '{}', 'hash')`,
    [id]
  );
  return id;
}

test("createScriptMangaRun builds pages, balloons and batch-1 panel generations, then assigns results", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const projectId = project!.id as string;
  const imported = createScript(projectId, {
    title: "Episode",
    fountainSource: [
      "INT. LAB - NIGHT",
      "",
      "Alice enters the ruined laboratory.",
      "",
      "@Alice",
      "ここはどこ？",
      "",
      "A blue hologram appears.",
      "",
      "@Mira",
      "旧研究棟です。"
    ].join("\n")
  });

  const run = await createScriptMangaRun(projectId, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    panelsPerPage: 2,
    maxElementsPerPanel: 2,
    maxDialoguesPerPanel: 1
  });
  assert.equal(run.pageCount, 1);
  assert.equal(run.panelCount, 2);

  const tasks = getRows<{ round_id: string; page_id: string; panel_id: string }>(
    "SELECT round_id, page_id, panel_id FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at ASC",
    [run.id]
  );
  assert.equal(tasks.length, 2);
  for (const task of tasks) {
    const round = getRow<{ request_json: string; target_panel_id: string }>("SELECT request_json, target_panel_id FROM generation_rounds WHERE id = ?", [
      task.round_id
    ]);
    assert.ok(round);
    assert.equal(JSON.parse(round!.request_json).batchSize, 1);
    assert.equal(Math.max(JSON.parse(round!.request_json).width, JSON.parse(round!.request_json).height), 1024);
    assert.equal(round!.target_panel_id, task.panel_id);
    await collectRound(task.round_id);
  }

  const completed = getScriptMangaRun(run.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completedCount, 2);
  assert.equal(completed.failedCount, 0);
  assert.equal(getRows("SELECT * FROM page_panel_assignments WHERE page_id = ?", [tasks[0]!.page_id]).length, 2);
  assert.equal(getRows("SELECT * FROM dialogue_placements WHERE page_id = ? AND balloon_object_id IS NOT NULL", [tasks[0]!.page_id]).length, 2);
});
