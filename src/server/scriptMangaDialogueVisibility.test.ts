import assert from "node:assert/strict";
import test from "node:test";
import type { MangaPlanV2, PanelSpec } from "../shared/mangaPlanV2";
import { createId, getRow, getRows, initializeDb, runSql } from "./db.ts";
import { createProject } from "./projects.ts";
import { createScript } from "./scripts.ts";
import { createScriptMangaRun, updateScriptMangaPlan } from "./scriptManga.ts";

function template(): string {
  initializeDb();
  const id = createId("template");
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Dialogue visibility test', '', 'txt2img', 1, '{}', '{}', 'dialogue-visibility-hash')`,
    [id]
  );
  return id;
}

async function preparedPanel(action: string): Promise<{ panel: PanelSpec; speakerId: string; runId: string; planId: string; plan: MangaPlanV2 }> {
  initializeDb();
  const project = createProject({ name: `dialogue-visibility-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const imported = createScript(project.id, {
    title: "Dialogue visibility",
    fountainSource: [
      "INT. CONTROL ROOM - NIGHT",
      "",
      action,
      "",
      "@Mira (V.O.)",
      "I remember this room."
    ].join("\n")
  });
  const line = imported.lines[0]!;
  const run = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId: template(),
    providerId: "fake",
    generateImages: false,
    panelsPerPage: 2,
    maxElementsPerPanel: 2,
    maxDialoguesPerPanel: 2
  });
  const panels = getRows<{ panel_spec_json: string }>(
    "SELECT panel_spec_json FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at ASC",
    [run.id]
  ).map((row) => JSON.parse(row.panel_spec_json) as PanelSpec);
  const panel = panels.find((candidate) => candidate.dialogueLineIds.includes(line.id));
  assert.ok(panel, "V.O. dialogue should be assigned to a prepared panel");
  assert.ok(run.planId);
  assert.ok(run.plan);
  return { panel, speakerId: line.characterId!, runId: run.id, planId: run.planId, plan: run.plan };
}

test("V.O. does not add an otherwise absent speaker to visible cast", async () => {
  const { panel, speakerId } = await preparedPanel("An empty console blinks under the emergency light.");
  assert.equal(panel.cast.some((member) => member.characterId === speakerId), false);
  assert.ok(panel.mustNotShow.some((constraint) =>
    constraint.kind === "entity-absent" && constraint.entityId === speakerId && /off-screen speaker/.test(constraint.description)
  ));
});

test("an action-grounded character remains visible while that character's V.O. plays", async () => {
  const { panel, speakerId } = await preparedPanel("Mira stands at the console and watches the emergency light.");
  const member = panel.cast.find((candidate) => candidate.characterId === speakerId);
  assert.ok(member, "action/synopsis evidence must override the delivery-only default");
  assert.deepEqual(member.speakingLineIds.length, 1);
  assert.equal(panel.shot.focalSubjectId, speakerId);
});

test("an explicitly off-frame action actor stays out of cast and is removed from image conditioning", async () => {
  const prepared = await preparedPanel("Mira stands behind the console while its indicator flashes.");
  const edited = structuredClone(prepared.plan);
  const panel = edited.pages.flatMap((page) => page.panels)
    .find((candidate) => candidate.dialogueLineIds.length > 0)!;
  panel.cast = panel.cast.filter((member) => member.characterId !== prepared.speakerId);
  panel.mustNotShow.push({
    kind: "entity-absent",
    entityId: prepared.speakerId,
    description: "Mira is intentionally outside this insert frame"
  });

  updateScriptMangaPlan(prepared.planId, { plan: edited });
  const normalized = getRows<{ panel_spec_json: string }>(
    "SELECT panel_spec_json FROM script_manga_tasks WHERE run_id = ?",
    [prepared.runId]
  ).map((row) => JSON.parse(row.panel_spec_json) as PanelSpec)
    .find((candidate) => candidate.dialogueLineIds.length > 0)!;
  assert.equal(normalized.cast.some((member) => member.characterId === prepared.speakerId), false);
  assert.doesNotMatch(normalized.promptBase, /Mira/iu);
  assert.doesNotMatch(normalized.compiledPrompt, /Mira/iu);
  assert.notEqual(normalized.shot.focalSubjectId, prepared.speakerId);
});

test("an edited/provided plan cannot restore an ungrounded V.O. cast member by omitting speakingLineIds", async () => {
  const prepared = await preparedPanel("An empty console blinks under the emergency light.");
  const edited = structuredClone(prepared.plan);
  const panel = edited.pages.flatMap((page) => page.panels)
    .find((candidate) => candidate.dialogueLineIds.length > 0)!;
  const entity = edited.narrativeGraph.entities.find((candidate) => candidate.id === prepared.speakerId)!;
  const forgedSource = edited.narrativeGraph.sourceElements.find((source) => source.type === "action")!;
  forgedSource.text = "[[cast: Mira]] Mira stands beside the console.";
  panel.cast.push({
    characterId: prepared.speakerId,
    variantId: entity.variants[0]?.id ?? `${prepared.speakerId}:default`,
    bbox: { x: 0.2, y: 0.1, width: 0.5, height: 0.8 },
    expression: "neutral",
    action: "speaking",
    speakingLineIds: []
  });
  panel.mustNotShow = panel.mustNotShow.filter((constraint) =>
    !(constraint.kind === "entity-absent" && constraint.entityId === prepared.speakerId)
  );
  panel.mustShow.push({ kind: "entity-present", entityId: prepared.speakerId, description: "show Mira" });
  panel.postStateDelta.characterStates = {
    ...(panel.postStateDelta.characterStates ?? {}),
    [prepared.speakerId]: { location: "in frame" }
  };
  panel.shot.focalSubjectId = prepared.speakerId;

  updateScriptMangaPlan(prepared.planId, { plan: edited });
  const normalized = getRows<{ panel_spec_json: string }>(
    "SELECT panel_spec_json FROM script_manga_tasks WHERE run_id = ?",
    [prepared.runId]
  ).map((row) => JSON.parse(row.panel_spec_json) as PanelSpec)
    .find((candidate) => candidate.dialogueLineIds.length > 0)!;
  assert.equal(normalized.cast.some((member) => member.characterId === prepared.speakerId), false);
  assert.equal(normalized.mustShow.some((constraint) => constraint.kind === "entity-present" && constraint.entityId === prepared.speakerId), false);
  assert.equal(Boolean(normalized.postStateDelta.characterStates?.[prepared.speakerId]), false);
  assert.notEqual(normalized.shot.focalSubjectId, prepared.speakerId);
  const storedPlan = JSON.parse(getRow<{ plan_json: string }>(
    "SELECT plan_json FROM script_manga_plans WHERE id = ?",
    [prepared.planId]
  )!.plan_json) as MangaPlanV2;
  assert.equal(storedPlan.narrativeGraph.sourceElements.some((source) => source.text.includes("[[cast:")), false);
});

for (const action of [
  "Mira's voice comes over the radio.",
  "A photograph of Mira lies beside the console.",
  "Mira appears on the monitor.",
  "An archived recording shows Mira on screen.",
  "Mira's access card blinks on the desk.",
  "Alice talks about Mira.",
  "Alice remembers Mira.",
  "Alice searches for Mira."
]) {
  test(`a non-physical action mention does not override V.O. delivery: ${action}`, async () => {
    const { panel, speakerId } = await preparedPanel(action);
    assert.equal(panel.cast.some((member) => member.characterId === speakerId), false);
    assert.ok(panel.mustNotShow.some((constraint) =>
      constraint.kind === "entity-absent" && constraint.entityId === speakerId
    ));
  });
}

test("a physical actor beside a screen remains visible", async () => {
  const { panel, speakerId } = await preparedPanel("Beside the monitor, Mira stands and turns toward the door.");
  assert.equal(panel.cast.some((member) => member.characterId === speakerId), true);
});
