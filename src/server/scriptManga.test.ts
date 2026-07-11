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
    loras: [{ name: "anime-style.safetensors", strength: 0.65 }],
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
    const request = JSON.parse(round!.request_json);
    assert.equal(request.batchSize, 1);
    assert.equal(Math.max(request.width, request.height), 1024);
    assert.deepEqual(request.loras, [{ name: "anime-style.safetensors", strength: 0.65 }]);
    assert.match(request.negativePrompt, /typography/);
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

test("createScriptMangaRun assigns directed prompts to the same RTL panels as their dialogues", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-reading-order-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const projectId = project!.id as string;
  const imported = createScript(projectId, {
    title: "Reading order",
    fountainSource: [
      "INT. COCKPIT - NIGHT",
      "",
      "@Alice",
      "最初の台詞。",
      "",
      "@Mira",
      "二番目の台詞。"
    ].join("\n")
  });

  const run = await createScriptMangaRun(projectId, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    planningMode: "provided",
    directorPlan: {
      title: "Asymmetric RTL",
      pages: [{
        index: 0,
        title: "Asymmetric page",
        layoutTemplateId: "builtin:three-side-hero",
        panels: [[], [0], [1]].map((dialogueOrderIndexes, dialogueOrderIndex) => ({
          id: `directed-${dialogueOrderIndex}`,
          sceneIndex: 0,
          sceneHeading: "INT. COCKPIT - NIGHT",
          prompt: `directed prompt ${dialogueOrderIndex}`,
          sourceText: `source ${dialogueOrderIndex}`,
          dialogueOrderIndexes
        }))
      }]
    }
  });

  const promptPanels = getRows<{ prompt: string; panel_id: string }>(
    "SELECT prompt, panel_id FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at ASC",
    [run.id]
  );
  const dialoguePanels = getRows<{ order_index: number; panel_id: string }>(
    `SELECT dl.order_index, dp.panel_id
     FROM dialogue_placements dp
     JOIN dialogue_lines dl ON dl.id = dp.line_id
     WHERE dp.page_id = ?
     ORDER BY dl.order_index ASC`,
    [getRow<{ page_id: string }>("SELECT page_id FROM script_manga_tasks WHERE run_id = ? LIMIT 1", [run.id])!.page_id]
  );

  assert.deepEqual(promptPanels.map((task) => task.prompt), ["directed prompt 0", "directed prompt 1", "directed prompt 2"]);
  assert.equal(promptPanels[1]!.panel_id, dialoguePanels[0]!.panel_id);
  assert.equal(promptPanels[2]!.panel_id, dialoguePanels[1]!.panel_id);
  assert.notEqual(promptPanels[0]!.panel_id, dialoguePanels[0]!.panel_id);
});
