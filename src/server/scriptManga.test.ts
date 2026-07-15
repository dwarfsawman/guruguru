import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createId, defaultVlmAuditSettings, getRow, getRows, initializeDb, runSql, setSetting } from "./db.ts";
import { createCharacter, listCharacters, putCharacterBinding } from "./characters.ts";
import { approveReferenceSet, createReferenceSet, uploadReferenceSetImage } from "./referenceSets.ts";
import { createProject } from "./projects.ts";
import { addScriptRevision, createScript } from "./scripts.ts";
import { collectRound } from "./rounds.ts";
import {
  approveScriptMangaRun,
  auditScriptMangaTask,
  cancelScriptMangaRun,
  createScriptMangaRun,
  getScriptMangaRun,
  resumeScriptMangaRun,
  selectScriptMangaTaskCandidate,
  startScriptMangaRun,
  updateScriptMangaPlan,
  withScriptMangaRunExport
} from "./scriptManga.ts";
import { fakeProvider, programFakeOutcomes, resetFakeProvider } from "./providers/fakeProvider.ts";
import { registerProvider } from "./providers/registry.ts";
import { deleteLayoutTemplate, importLayoutTemplate } from "./layoutTemplates.ts";
import { findLayoutPreset } from "../shared/layoutPresets.ts";
import type { MangaPlanV2 } from "../shared/mangaPlanV2.ts";
import { listFonts, pickMangaFont } from "./fonts.ts";

registerProvider(fakeProvider);

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

async function createScriptMangaRunExport(runId: string, body: unknown) {
  return withScriptMangaRunExport(runId, body, async (artifact) => ({
    ...artifact,
    buffer: await readFile(artifact.artifactPath)
  }));
}

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

function chromaTemplate(): string {
  initializeDb();
  const id = createId("template");
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "Chroma1-HD.safetensors" } },
    "2": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 1 } }
  };
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Script manga Chroma fake', '', 'txt2img', 1, ?, '{}', 'chroma-hash')`,
    [id, JSON.stringify(workflow)]
  );
  return id;
}

function expandToTwoPanelPlan(plan: MangaPlanV2): MangaPlanV2 {
  const expanded = structuredClone(plan);
  const page = expanded.pages[0]!;
  const original = page.panels[0]!;
  const extra = structuredClone(original);
  extra.id = `${original.id}:budget-extra`;
  extra.sourceElementIds = [];
  extra.beatIds = [];
  extra.dialogueLineIds = [];
  extra.fillUnitIds = [];
  extra.continuityFromPanelIds = [];
  extra.compiledPrompt = `${original.compiledPrompt}, alternate reaction insert`;
  const layout = findLayoutPreset("builtin:two-horizontal");
  assert.ok(layout);
  page.layoutTemplateId = layout.id;
  page.layoutSnapshot = structuredClone(layout.layout);
  page.panels = [original, extra];
  expanded.panelCount = 2;
  return expanded;
}

function collapseToOneDialoguePanelPlan(plan: MangaPlanV2): MangaPlanV2 {
  const collapsed = structuredClone(plan);
  const panels = collapsed.pages.flatMap((page) => page.panels);
  const first = panels[0]!;
  const castByCharacter = new Map(first.cast.map((member) => [member.characterId, structuredClone(member)]));
  for (const member of panels.flatMap((panel) => panel.cast)) {
    const existing = castByCharacter.get(member.characterId);
    if (!existing) {
      castByCharacter.set(member.characterId, structuredClone(member));
      continue;
    }
    existing.speakingLineIds = [...new Set([...existing.speakingLineIds, ...member.speakingLineIds])];
  }
  first.cast = [...castByCharacter.values()];
  first.sourceElementIds = [...new Set(panels.flatMap((panel) => panel.sourceElementIds))];
  first.beatIds = [...new Set(panels.flatMap((panel) => panel.beatIds))];
  first.dialogueLineIds = [...new Set(panels.flatMap((panel) => panel.dialogueLineIds))];
  first.dialogueOrderIndexes = [...new Set(panels.flatMap((panel) => panel.dialogueOrderIndexes))].sort((a, b) => a - b);
  first.fillUnitIds = [...new Set(panels.flatMap((panel) => panel.fillUnitIds ?? []))];
  first.continuityFromPanelIds = [];
  const layout = findLayoutPreset("builtin:splash");
  assert.ok(layout);
  collapsed.pages = [{
    ...collapsed.pages[0]!,
    index: 0,
    layoutTemplateId: layout.id,
    layoutSnapshot: structuredClone(layout.layout),
    panels: [first]
  }];
  collapsed.panelCount = 1;
  return collapsed;
}

function mergeTwoSinglePanelPages(plan: MangaPlanV2): MangaPlanV2 {
  const merged = structuredClone(plan);
  const panels = merged.pages.flatMap((page) => page.panels);
  assert.equal(panels.length, 2);
  const layout = findLayoutPreset("builtin:two-horizontal");
  assert.ok(layout);
  merged.pages = [{
    ...merged.pages[0]!,
    index: 0,
    layoutTemplateId: layout.id,
    layoutSnapshot: structuredClone(layout.layout),
    panels
  }];
  merged.panelCount = panels.length;
  return merged;
}

test("approved run freezes Reference Set version and hashes across resume after appearance changes", async () => {
  resetFakeProvider();
  const templateId = chromaTemplate();
  const project = createProject({ name: `script-manga-ref-snapshot-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const imported = createScript(project.id, {
    title: "Reference snapshot",
    fountainSource: ["INT. ROOM - DAY", "", "@Alice", "待って。"].join("\n")
  });
  const alice = listCharacters(project.id).find((character) => character.name === "Alice");
  assert.ok(alice);
  const first = createReferenceSet(alice.id, {
    modelFamily: "chroma",
    variantId: `${alice.id}:default`,
    appearanceJa: "短い銀髪、青い目、紺の上着",
    appearancePromptEn: "short silver hair, blue eyes, navy jacket",
    mustNotChange: ["silver hair"]
  });
  await uploadReferenceSetImage(first.id, "face", { imageDataUrl: TINY_PNG_DATA_URL });
  await approveReferenceSet(first.id, {});
  const prepared = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: false,
    requireReferenceSets: true
  });
  const approved = approveScriptMangaRun(prepared.id);
  const before = approved.referenceSnapshot;
  assert.equal(before?.sets[0]?.setId, first.id);
  const beforeHashes = before?.sets[0]?.images.map((image) => image.checksum);

  createReferenceSet(alice.id, {
    modelFamily: "chroma",
    variantId: `${alice.id}:default`,
    appearanceJa: "短い銀髪、青い目、赤い上着",
    appearancePromptEn: "short silver hair, blue eyes, red jacket",
    mustNotChange: ["silver hair"]
  });
  const resumed = await resumeScriptMangaRun(prepared.id);
  assert.equal(resumed.referenceSnapshot?.sets[0]?.setId, first.id);
  assert.equal(resumed.referenceSnapshot?.sets[0]?.version, 1);
  assert.deepEqual(resumed.referenceSnapshot?.sets[0]?.images.map((image) => image.checksum), beforeHashes);
  const roundRequest = getRow<{ request_json: string }>(
    "SELECT request_json FROM generation_rounds WHERE script_manga_task_id = ? ORDER BY created_at DESC LIMIT 1",
    [resumed.tasks[0]!.id]
  );
  assert.ok(roundRequest);
  assert.deepEqual(JSON.parse(roundRequest.request_json).reference.referenceSet, { setId: first.id, version: 1 });
});

test("createScriptMangaRun awaits candidate review before assigning batch-1 panel results", async () => {
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
    assert.ok([[1024, 1024], [1152, 896], [896, 1152], [1216, 832], [832, 1216], [1344, 768], [768, 1344], [1536, 640], [640, 1536]]
      .some(([width, height]) => request.width === width && request.height === height));
    assert.deepEqual(request.loras, [{ name: "anime-style.safetensors", strength: 0.65 }]);
    assert.match(request.negativePrompt, /typography/);
    assert.equal(round!.target_panel_id, task.panel_id);
    await collectRound(task.round_id);
  }

  const awaitingReview = getScriptMangaRun(run.id);
  assert.equal(awaitingReview.status, "awaiting_review");
  assert.equal(awaitingReview.phase, "reviewing");
  assert.equal(awaitingReview.completedCount, 0);
  assert.equal(awaitingReview.failedCount, 0);
  assert.equal(awaitingReview.tasks.length, 2);
  assert.ok(awaitingReview.tasks.every((task) => task.status === "awaiting_review"));
  assert.ok(awaitingReview.tasks.every((task) => task.candidateAssetIds.length === 1));

  let completed = awaitingReview;
  for (const task of awaitingReview.tasks) {
    completed = await selectScriptMangaTaskCandidate(task.id, { assetId: task.candidateAssetIds[0]! });
  }
  assert.equal(completed.status, "completed");
  assert.equal(completed.phase, "completed");
  assert.equal(completed.completedCount, 2);
  assert.equal(completed.failedCount, 0);
  assert.ok(completed.tasks.every((task) => task.status === "completed" && task.selectedAssetId));
  assert.equal(getRows("SELECT * FROM page_panel_assignments WHERE page_id = ?", [tasks[0]!.page_id]).length, 2);
  assert.equal(getRows("SELECT * FROM dialogue_placements WHERE page_id = ? AND balloon_object_id IS NOT NULL", [tasks[0]!.page_id]).length, 2);
  const pageObjects = JSON.parse(getRow<{ objects_json: string }>("SELECT objects_json FROM pages WHERE id = ?", [tasks[0]!.page_id])!.objects_json);
  const balloonFontSizes = pageObjects.filter((object: { kind: string }) => object.kind === "balloon")
    .map((object: { content: { style: { size: number } } }) => object.content.style.size);
  assert.ok(balloonFontSizes.every((size: number) => size >= 0.035), `unexpected auto manga font sizes: ${balloonFontSizes.join(", ")}`);
  const expectedMangaFontId = pickMangaFont(listFonts())?.id ?? "default";
  const balloonFontIds = pageObjects.filter((object: { kind: string }) => object.kind === "balloon")
    .map((object: { content: { style: { fontId: string } } }) => object.content.style.fontId);
  assert.ok(balloonFontIds.every((fontId: string) => fontId === expectedMangaFontId),
    `unexpected auto manga font ids: ${balloonFontIds.join(", ")}`);

  for (const asset of getRows<{ image_path: string }>(
    "SELECT a.image_path FROM assets a JOIN script_manga_tasks t ON t.selected_asset_id = a.id WHERE t.run_id = ?",
    [run.id]
  )) {
    await writeFile(asset.image_path, Buffer.from(TINY_PNG_DATA_URL.split(",")[1]!, "base64"));
  }
  const exported = await createScriptMangaRunExport(run.id, { format: "png", pixelWidth: 256 });
  assert.equal(exported.contentType, "image/png");
  assert.equal(exported.pageCount, 1);
  assert.ok(exported.buffer.byteLength > 0);
  const afterExport = getScriptMangaRun(run.id);
  assert.equal(afterExport.status, "completed");
  assert.equal((afterExport.exportManifest as { format?: string })?.format, "png");
});

test("VLM audit scores generated candidates and still requires a human selection", async () => {
  resetFakeProvider();
  const sharpModule = (await import("sharp")).default;
  const gradient = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) {
    const value = 32 + Math.round((x / 63) * 190);
    const offset = (y * 64 + x) * 3;
    gradient[offset] = value;
    gradient[offset + 1] = value;
    gradient[offset + 2] = value;
  }
  programFakeOutcomes([{
    status: "completed",
    images: [{
      bytes: await sharpModule(gradient, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer(),
      filename: "vlm-audit-candidate.png",
      outputNodeId: "fake-node"
    }]
  }]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
      const body = await request.json() as { messages?: unknown };
      assert.ok(Array.isArray(body.messages));
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          score: 0.91,
          checks: { visualIdentity: "pass", actionAlignment: "pass", fakeText: "pass", continuity: "pass" },
          violations: []
        }) } }]
      });
    }
  });
  setSetting("vlm_audit", {
    ...defaultVlmAuditSettings,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    model: "mock-vlm",
    transport: "openai-compatible",
    manageModelLifecycle: false,
    releaseComfyBeforeAudit: false,
    unloadAfterAudit: false
  });
  try {
    const templateId = template();
    const project = createProject({ name: `script-manga-vlm-${createId("test")}`, mode: "book" });
    const projectId = project!.id as string;
    const imported = createScript(projectId, {
      title: "VLM audit",
      fountainSource: ["INT. ROOM - DAY", "", "A red door opens."].join("\n")
    });
    const run = await createScriptMangaRun(projectId, {
      scriptId: imported.script.id,
      templateId,
      providerId: "fake",
      auditMode: "vlm"
    });
    assert.equal(run.auditMode, "vlm");
    await collectRound(run.tasks[0]!.roundId!);
    const queued = getScriptMangaRun(run.id);
    assert.equal(queued.status, "auditing");
    assert.equal(queued.tasks[0]!.status, "auditing");

    const audited = await auditScriptMangaTask(queued.tasks[0]!.id);
    assert.equal(audited.status, "awaiting_review");
    assert.equal(audited.phase, "reviewing");
    assert.equal(audited.tasks[0]!.status, "awaiting_review");
    const scores = audited.tasks[0]!.scores as {
      vlmAudit?: { state?: string; reports?: Array<{ score?: number; passed?: boolean; model?: string }> };
    };
    assert.equal(scores.vlmAudit?.state, "completed");
    assert.equal(scores.vlmAudit?.reports?.[0]?.score, 0.91);
    assert.equal(scores.vlmAudit?.reports?.[0]?.passed, true);
    assert.equal(scores.vlmAudit?.reports?.[0]?.model, "mock-vlm");
    const persisted = getRow<{ scores_json: string }>("SELECT scores_json FROM script_manga_tasks WHERE id = ?", [queued.tasks[0]!.id])!.scores_json;
    assert.doesNotMatch(persisted, /data:image|base64|thumbnail/i);
    const rejectedScores = JSON.parse(persisted);
    rejectedScores.vlmAudit.reports[0].passed = false;
    runSql("UPDATE script_manga_tasks SET scores_json = ? WHERE id = ?", [JSON.stringify(rejectedScores), queued.tasks[0]!.id]);
    await assert.rejects(
      () => selectScriptMangaTaskCandidate(queued.tasks[0]!.id, { assetId: audited.tasks[0]!.candidateAssetIds[0]! }),
      /failed VLM audit/
    );
  } finally {
    server.stop(true);
    setSetting("vlm_audit", defaultVlmAuditSettings);
  }
});

test("candidate auto-selection policies are rejected", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-review-gate-${createId("test")}`, mode: "book" });
  const script = createScript(project!.id as string, {
    title: "Review gate",
    fountainSource: ["INT. ROOM - DAY", "", "A chair stands by the wall."].join("\n")
  });
  await assert.rejects(
    createScriptMangaRun(project!.id as string, {
      scriptId: script.script.id,
      templateId,
      providerId: "fake",
      candidateSelectionPolicy: "metadata"
    }),
    /never auto-selected/
  );
});

test("maxPanelCount rejects an oversized plan before persisting a run or panel tasks", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-budget-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const imported = createScript(project.id, {
    title: "Panel budget",
    fountainSource: [
      "INT. LAB - NIGHT",
      "",
      "Alice enters.",
      "",
      "@Alice",
      "ここはどこ？",
      "",
      "Mira points at the exit.",
      "",
      "@Mira",
      "こちらです。"
    ].join("\n")
  });

  await assert.rejects(
    createScriptMangaRun(project.id, {
      scriptId: imported.script.id,
      templateId,
      providerId: "fake",
      generateImages: false,
      panelsPerPage: 2,
      maxElementsPerPanel: 1,
      maxDialoguesPerPanel: 1,
      maxPanelCount: 1
    }),
    /exceeding maxPanelCount 1/
  );
  assert.equal(getRows("SELECT id FROM script_manga_runs WHERE script_id = ?", [imported.script.id]).length, 0);
  assert.equal(getRows("SELECT id FROM script_manga_tasks WHERE run_id IN (SELECT id FROM script_manga_runs WHERE script_id = ?)", [imported.script.id]).length, 0);
});

test("maxPanelCount remains a hard ceiling when a prepared plan is edited", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-budget-edit-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const imported = createScript(project.id, {
    title: "Panel budget edit",
    fountainSource: ["INT. ROOM - DAY", "", "A clock ticks."].join("\n")
  });
  const prepared = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: false,
    panelsPerPage: 1,
    maxPanelCount: 1
  });
  assert.equal(prepared.panelCount, 1);
  const expanded = expandToTwoPanelPlan(prepared.plan!);

  assert.throws(
    () => updateScriptMangaPlan(prepared.planId!, { plan: expanded }),
    /exceeding maxPanelCount 1/
  );
  assert.equal(getScriptMangaRun(prepared.id).panelCount, 1);
  assert.equal(JSON.parse(
    getRow<{ plan_json: string }>("SELECT plan_json FROM script_manga_plans WHERE id = ?", [prepared.planId])!.plan_json
  ).panelCount, 1);
});

test("approval, start, and resume recheck the run maxPanelCount ceiling", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-budget-gates-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const imported = createScript(project.id, {
    title: "Panel budget gates",
    fountainSource: ["INT. ROOM - DAY", "", "A clock ticks."].join("\n")
  });
  const prepare = async () => createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: false,
    panelsPerPage: 1,
    maxPanelCount: 1
  });

  // Simulate a stale plan record written before the edit-time ceiling existed. Approval must still fail closed.
  const awaitingApproval = await prepare();
  const oversizedForApproval = expandToTwoPanelPlan(awaitingApproval.plan!);
  runSql("UPDATE script_manga_plans SET plan_json = ? WHERE id = ?", [
    JSON.stringify(oversizedForApproval),
    awaitingApproval.planId
  ]);
  assert.throws(() => approveScriptMangaRun(awaitingApproval.id), /exceeding maxPanelCount 1/);

  // Recheck immediately before either generation entry point, even after a run was approved.
  const awaitingStart = await prepare();
  approveScriptMangaRun(awaitingStart.id);
  const oversizedForStart = expandToTwoPanelPlan(awaitingStart.plan!);
  runSql("UPDATE script_manga_plans SET plan_json = ? WHERE id = ?", [
    JSON.stringify(oversizedForStart),
    awaitingStart.planId
  ]);
  await assert.rejects(startScriptMangaRun(awaitingStart.id), /exceeding maxPanelCount 1/);
  await assert.rejects(resumeScriptMangaRun(awaitingStart.id), /exceeding maxPanelCount 1/);
});

test("panelsPerPage is a hard gate for provided, edited, approved, started, and resumed plans", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-page-density-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const imported = createScript(project.id, {
    title: "Page density",
    fountainSource: ["INT. ROOM - DAY", "", "Alice enters.", "", "Alice sits."].join("\n")
  });

  await assert.rejects(
    createScriptMangaRun(project.id, {
      scriptId: imported.script.id,
      templateId,
      providerId: "fake",
      planningMode: "provided",
      directorPlan: {
        title: "Provided page density",
        pages: [{
          index: 0,
          layoutTemplateId: "builtin:two-horizontal",
          panels: [{
            id: "provided-page-density-1",
            sceneIndex: 0,
            sceneHeading: "INT. ROOM - DAY",
            prompt: "Alice enters the room.",
            sourceText: "Alice enters.",
            dialogueOrderIndexes: []
          }, {
            id: "provided-page-density-2",
            sceneIndex: 0,
            sceneHeading: "INT. ROOM - DAY",
            prompt: "Alice sits down.",
            sourceText: "Alice sits.",
            dialogueOrderIndexes: []
          }]
        }]
      },
      generateImages: false,
      panelsPerPage: 1
    }),
    /exceeding panelsPerPage 1/
  );

  const prepare = async () => createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: false,
    panelsPerPage: 1,
    maxElementsPerPanel: 8
  });

  const editable = await prepare();
  assert.throws(
    () => updateScriptMangaPlan(editable.planId!, { plan: mergeTwoSinglePanelPages(editable.plan!) }),
    /exceeding panelsPerPage 1/
  );

  const awaitingApproval = await prepare();
  runSql("UPDATE script_manga_plans SET plan_json = ? WHERE id = ?", [
    JSON.stringify(mergeTwoSinglePanelPages(awaitingApproval.plan!)),
    awaitingApproval.planId
  ]);
  assert.throws(() => approveScriptMangaRun(awaitingApproval.id), /exceeding panelsPerPage 1/);

  const awaitingStart = await prepare();
  approveScriptMangaRun(awaitingStart.id);
  runSql("UPDATE script_manga_plans SET plan_json = ? WHERE id = ?", [
    JSON.stringify(mergeTwoSinglePanelPages(awaitingStart.plan!)),
    awaitingStart.planId
  ]);
  await assert.rejects(startScriptMangaRun(awaitingStart.id), /exceeding panelsPerPage 1/);
  await assert.rejects(resumeScriptMangaRun(awaitingStart.id), /exceeding panelsPerPage 1/);
});

test("maxDialoguesPerPanel is a hard gate for provided, edited, approved, started, and resumed plans", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-dialogue-budget-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const imported = createScript(project.id, {
    title: "Dialogue budget",
    fountainSource: ["INT. ROOM - DAY", "", "@Alice", "One.", "", "@Bob", "Two."].join("\n")
  });

  await assert.rejects(
    createScriptMangaRun(project.id, {
      scriptId: imported.script.id,
      templateId,
      providerId: "fake",
      planningMode: "provided",
      directorPlan: {
        title: "Provided dialogue budget",
        pages: [{
          index: 0,
          layoutTemplateId: "builtin:splash",
          panels: [{
            id: "provided-panel",
            sceneIndex: 0,
            sceneHeading: "INT. ROOM - DAY",
            prompt: "Two people exchange a short response in one continuous moment.",
            sourceText: "Alice and Bob exchange two lines.",
            dialogueOrderIndexes: [0, 1]
          }]
        }]
      },
      generateImages: false,
      maxDialoguesPerPanel: 1
    }),
    /exceeding maxDialoguesPerPanel 1/
  );

  const prepare = async () => createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: false,
    panelsPerPage: 2,
    maxDialoguesPerPanel: 1
  });

  const editable = await prepare();
  const collapsedForEdit = collapseToOneDialoguePanelPlan(editable.plan!);
  assert.throws(
    () => updateScriptMangaPlan(editable.planId!, { plan: collapsedForEdit }),
    /exceeding maxDialoguesPerPanel 1/
  );

  const awaitingApproval = await prepare();
  runSql("UPDATE script_manga_plans SET plan_json = ? WHERE id = ?", [
    JSON.stringify(collapseToOneDialoguePanelPlan(awaitingApproval.plan!)),
    awaitingApproval.planId
  ]);
  assert.throws(() => approveScriptMangaRun(awaitingApproval.id), /exceeding maxDialoguesPerPanel 1/);

  const awaitingStart = await prepare();
  approveScriptMangaRun(awaitingStart.id);
  runSql("UPDATE script_manga_plans SET plan_json = ? WHERE id = ?", [
    JSON.stringify(collapseToOneDialoguePanelPlan(awaitingStart.plan!)),
    awaitingStart.planId
  ]);
  await assert.rejects(startScriptMangaRun(awaitingStart.id), /exceeding maxDialoguesPerPanel 1/);
  await assert.rejects(resumeScriptMangaRun(awaitingStart.id), /exceeding maxDialoguesPerPanel 1/);
});

test("a successor inherits only fingerprint-identical selected assets and generates changed panels", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-successor-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const imported = createScript(project.id, {
    title: "Successor",
    fountainSource: ["INT. LAB - NIGHT", "", "Alice looks up.", "", "@Alice", "行こう。"].join("\n")
  });
  const predecessor = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: true,
    panelsPerPage: 1,
    maxDialoguesPerPanel: 1
  });
  assert.equal(predecessor.tasks.length, 1);
  assert.ok(predecessor.tasks[0]!.roundId);
  await collectRound(predecessor.tasks[0]!.roundId!);
  const review = getScriptMangaRun(predecessor.id);
  const selectedAssetId = review.tasks[0]!.candidateAssetIds[0]!;
  const completed = await selectScriptMangaTaskCandidate(review.tasks[0]!.id, { assetId: selectedAssetId });
  assert.equal(completed.status, "completed");
  assert.ok(completed.tasks[0]!.reuseFingerprint, "selected tasks persist a generation-time reuse signature");
  assert.ok(completed.plan);
  const newerRevision = addScriptRevision(imported.script.id, {
    fountainSource: ["INT. LAB - DAY", "", "Alice sits down.", "", "@Alice", "戻ろう。"].join("\n")
  });
  assert.notEqual(newerRevision.revision.id, completed.scriptRevisionId);

  const exactSuccessor = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    planningMode: "provided",
    predecessorRunId: completed.id,
    successorPlan: structuredClone(completed.plan),
    generateImages: false
  });
  assert.equal(exactSuccessor.predecessorRunId, completed.id);
  assert.equal(exactSuccessor.scriptRevisionId, completed.scriptRevisionId);
  approveScriptMangaRun(exactSuccessor.id);
  const inherited = await startScriptMangaRun(exactSuccessor.id);
  assert.equal(inherited.status, "completed");
  assert.equal(inherited.tasks[0]!.selectedAssetId, selectedAssetId);
  assert.equal(inherited.tasks[0]!.inheritedFromTaskId, completed.tasks[0]!.id);
  assert.ok(inherited.tasks[0]!.reuseFingerprint);
  assert.equal(inherited.tasks[0]!.roundId, null);
  assert.equal(getRows("SELECT id FROM generation_rounds WHERE script_manga_task_id = ?", [inherited.tasks[0]!.id]).length, 0);
  assert.equal(
    getRow<{ asset_id: string }>(
      "SELECT asset_id FROM page_panel_assignments WHERE page_id = ? AND panel_id = ?",
      [inherited.tasks[0]!.pageId, inherited.tasks[0]!.panelId]
    )?.asset_id,
    selectedAssetId
  );

  runSql(
    "UPDATE script_manga_tasks SET inherited_from_task_id = ? WHERE id = ?",
    [inherited.tasks[0]!.id, inherited.tasks[0]!.id]
  );
  const forgedLineageSuccessor = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    planningMode: "provided",
    predecessorRunId: inherited.id,
    successorPlan: structuredClone(inherited.plan),
    generateImages: false
  });
  approveScriptMangaRun(forgedLineageSuccessor.id);
  const forgedLineage = await startScriptMangaRun(forgedLineageSuccessor.id);
  assert.equal(forgedLineage.tasks[0]!.inheritedFromTaskId, null);
  assert.ok(forgedLineage.tasks[0]!.roundId, "a forged inherited-task chain must not authorize asset reuse");
  await cancelScriptMangaRun(forgedLineageSuccessor.id);
  runSql(
    "UPDATE script_manga_tasks SET inherited_from_task_id = ? WHERE id = ?",
    [completed.tasks[0]!.id, inherited.tasks[0]!.id]
  );

  const storedReuse = getRow<{ reuse_fingerprint: string; reuse_source_json: string }>(
    "SELECT reuse_fingerprint, reuse_source_json FROM script_manga_tasks WHERE id = ?",
    [completed.tasks[0]!.id]
  )!;
  runSql("UPDATE script_manga_tasks SET reuse_fingerprint = NULL, reuse_source_json = NULL WHERE id = ?", [completed.tasks[0]!.id]);
  const legacySuccessor = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    planningMode: "provided",
    predecessorRunId: completed.id,
    successorPlan: structuredClone(completed.plan),
    generateImages: false
  });
  approveScriptMangaRun(legacySuccessor.id);
  const legacyResult = await startScriptMangaRun(legacySuccessor.id);
  assert.equal(legacyResult.tasks[0]!.inheritedFromTaskId, completed.tasks[0]!.id);
  assert.equal(legacyResult.tasks[0]!.selectedAssetId, selectedAssetId);
  const lazilySigned = getRow<{ reuse_fingerprint: string | null; reuse_source_json: string | null }>(
    "SELECT reuse_fingerprint, reuse_source_json FROM script_manga_tasks WHERE id = ?",
    [completed.tasks[0]!.id]
  );
  assert.ok(lazilySigned?.reuse_fingerprint, "legacy task is signed from its frozen generation round on demand");
  assert.ok(lazilySigned?.reuse_source_json);

  const selectedRound = getRow<{ id: string; patched_workflow_json: string }>(
    "SELECT r.id, r.patched_workflow_json FROM generation_rounds r JOIN assets a ON a.round_id = r.id WHERE a.id = ?",
    [selectedAssetId]
  )!;
  runSql("UPDATE generation_rounds SET patched_workflow_json = NULL WHERE id = ?", [selectedRound.id]);
  runSql("UPDATE script_manga_tasks SET reuse_fingerprint = NULL, reuse_source_json = NULL WHERE id = ?", [completed.tasks[0]!.id]);
  const incompleteFrozenSuccessor = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    planningMode: "provided",
    predecessorRunId: completed.id,
    successorPlan: structuredClone(completed.plan),
    generateImages: false
  });
  approveScriptMangaRun(incompleteFrozenSuccessor.id);
  const incompleteFrozen = await startScriptMangaRun(incompleteFrozenSuccessor.id);
  assert.equal(incompleteFrozen.tasks[0]!.inheritedFromTaskId, null);
  assert.ok(incompleteFrozen.tasks[0]!.roundId, "legacy signing fails closed without a frozen native workflow");
  await cancelScriptMangaRun(incompleteFrozenSuccessor.id);
  runSql("UPDATE generation_rounds SET patched_workflow_json = ? WHERE id = ?", [selectedRound.patched_workflow_json, selectedRound.id]);
  runSql(
    "UPDATE script_manga_tasks SET reuse_fingerprint = ?, reuse_source_json = ? WHERE id = ?",
    [storedReuse.reuse_fingerprint, JSON.stringify({ version: "forged" }), completed.tasks[0]!.id]
  );
  const forgedSourceSuccessor = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    planningMode: "provided",
    predecessorRunId: completed.id,
    successorPlan: structuredClone(completed.plan),
    generateImages: false
  });
  approveScriptMangaRun(forgedSourceSuccessor.id);
  const forgedSource = await startScriptMangaRun(forgedSourceSuccessor.id);
  assert.equal(forgedSource.tasks[0]!.inheritedFromTaskId, null);
  assert.ok(forgedSource.tasks[0]!.roundId, "present but invalid provenance is not silently replaced by lazy signing");
  await cancelScriptMangaRun(forgedSourceSuccessor.id);
  runSql(
    "UPDATE script_manga_tasks SET reuse_fingerprint = ?, reuse_source_json = ? WHERE id = ?",
    [storedReuse.reuse_fingerprint, storedReuse.reuse_source_json, completed.tasks[0]!.id]
  );

  const staleClaimSuccessor = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    planningMode: "provided",
    predecessorRunId: completed.id,
    successorPlan: structuredClone(completed.plan),
    generateImages: false
  });
  approveScriptMangaRun(staleClaimSuccessor.id);
  runSql("UPDATE script_manga_tasks SET status = 'inheriting' WHERE id = ?", [staleClaimSuccessor.tasks[0]!.id]);
  const recovered = await resumeScriptMangaRun(staleClaimSuccessor.id);
  assert.equal(recovered.tasks[0]!.status, "completed");
  assert.equal(recovered.tasks[0]!.inheritedFromTaskId, completed.tasks[0]!.id);
  assert.equal(
    getRows("SELECT id FROM generation_rounds WHERE script_manga_task_id = ?", [recovered.tasks[0]!.id]).length,
    0,
    "a stale inheriting claim is recovered and reused instead of generated"
  );

  const selectedImage = getRow<{ image_path: string }>("SELECT image_path FROM assets WHERE id = ?", [selectedAssetId])!;
  const hiddenSelectedImage = `${selectedImage.image_path}.reuse-missing`;
  await rename(selectedImage.image_path, hiddenSelectedImage);
  try {
    const missingImageSuccessor = await createScriptMangaRun(project.id, {
      scriptId: imported.script.id,
      planningMode: "provided",
      predecessorRunId: completed.id,
      successorPlan: structuredClone(completed.plan),
      generateImages: false
    });
    approveScriptMangaRun(missingImageSuccessor.id);
    const missingImage = await startScriptMangaRun(missingImageSuccessor.id);
    assert.equal(missingImage.tasks[0]!.inheritedFromTaskId, null);
    assert.ok(missingImage.tasks[0]!.roundId, "a missing selected-asset image must regenerate instead of completing a broken assignment");
    await cancelScriptMangaRun(missingImageSuccessor.id);
  } finally {
    await rename(hiddenSelectedImage, selectedImage.image_path);
  }

  const selectedImageBytes = await readFile(selectedImage.image_path);
  await writeFile(selectedImage.image_path, Buffer.from("not an image"));
  try {
    const corruptImageSuccessor = await createScriptMangaRun(project.id, {
      scriptId: imported.script.id,
      planningMode: "provided",
      predecessorRunId: completed.id,
      successorPlan: structuredClone(completed.plan),
      generateImages: false
    });
    approveScriptMangaRun(corruptImageSuccessor.id);
    const corruptImage = await startScriptMangaRun(corruptImageSuccessor.id);
    assert.equal(corruptImage.tasks[0]!.inheritedFromTaskId, null);
    assert.ok(corruptImage.tasks[0]!.roundId, "a corrupt selected-asset image must regenerate instead of completing a broken assignment");
    await cancelScriptMangaRun(corruptImageSuccessor.id);
  } finally {
    await writeFile(selectedImage.image_path, selectedImageBytes);
  }

  const sharpModule = (await import("sharp")).default;
  const differentValidImage = await sharpModule({
    create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } }
  }).png().toBuffer();
  await writeFile(selectedImage.image_path, differentValidImage);
  try {
    const replacedImageSuccessor = await createScriptMangaRun(project.id, {
      scriptId: imported.script.id,
      planningMode: "provided",
      predecessorRunId: completed.id,
      successorPlan: structuredClone(completed.plan),
      generateImages: false
    });
    approveScriptMangaRun(replacedImageSuccessor.id);
    const replacedImage = await startScriptMangaRun(replacedImageSuccessor.id);
    assert.equal(replacedImage.tasks[0]!.inheritedFromTaskId, null);
    assert.ok(replacedImage.tasks[0]!.roundId, "a different valid image at the same path must not inherit approval");
    await cancelScriptMangaRun(replacedImageSuccessor.id);
  } finally {
    await writeFile(selectedImage.image_path, selectedImageBytes);
  }

  runSql(
    "UPDATE workflow_templates SET version = version + 1, workflow_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ["hash-after-selected-asset", templateId]
  );
  const templateChangedSuccessor = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    planningMode: "provided",
    predecessorRunId: completed.id,
    successorPlan: structuredClone(completed.plan),
    generateImages: false
  });
  approveScriptMangaRun(templateChangedSuccessor.id);
  const templateChanged = await startScriptMangaRun(templateChangedSuccessor.id);
  assert.equal(templateChanged.tasks[0]!.inheritedFromTaskId, null);
  assert.ok(templateChanged.tasks[0]!.roundId, "a workflow-template revision change must force generation");
  await cancelScriptMangaRun(templateChanged.id);

  const changedPlan = structuredClone(completed.plan!);
  changedPlan.pages[0]!.panels[0]!.promptBase += ", camera behind Alice";
  const changedSuccessor = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    planningMode: "provided",
    predecessorRunId: completed.id,
    successorPlan: changedPlan,
    generateImages: false
  });
  approveScriptMangaRun(changedSuccessor.id);
  const changed = await startScriptMangaRun(changedSuccessor.id);
  assert.equal(changed.tasks[0]!.inheritedFromTaskId, null);
  assert.equal(changed.tasks[0]!.selectedAssetId, null);
  assert.ok(changed.tasks[0]!.roundId, "changed panel should receive a new generation round");
  assert.equal(getRows("SELECT id FROM generation_rounds WHERE script_manga_task_id = ?", [changed.tasks[0]!.id]).length, 1);
  await cancelScriptMangaRun(changed.id);
});

test("a successor regenerates a continuity-dependent panel when its upstream selected asset cannot be inherited", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-continuity-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const imported = createScript(project.id, {
    title: "Continuity closure",
    fountainSource: ["INT. CORRIDOR - NIGHT", "", "Alice opens the hatch.", "", "Alice steps through the hatch."].join("\n")
  });
  const prepared = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: false,
    panelsPerPage: 2,
    maxElementsPerPanel: 1
  });
  assert.equal(prepared.tasks.length, 2);
  const predecessorPlan = structuredClone(prepared.plan!);
  const firstPanel = predecessorPlan.pages[0]!.panels[0]!;
  const dependentPanel = predecessorPlan.pages[0]!.panels[1]!;
  dependentPanel.continuityFromPanelIds = [firstPanel.id];
  updateScriptMangaPlan(predecessorPlan.id, predecessorPlan);
  approveScriptMangaRun(prepared.id);
  const started = await startScriptMangaRun(prepared.id);
  for (const task of started.tasks) {
    assert.ok(task.roundId);
    await collectRound(task.roundId!);
  }
  const review = getScriptMangaRun(prepared.id);
  const selectedDependent = await selectScriptMangaTaskCandidate(review.tasks[1]!.id, {
    assetId: review.tasks[1]!.candidateAssetIds[0]!
  });
  assert.ok(selectedDependent.tasks[1]!.reuseFingerprint);
  const canceled = await cancelScriptMangaRun(prepared.id);
  assert.equal(canceled.tasks[0]!.status, "canceled");
  assert.equal(canceled.tasks[1]!.status, "completed");

  const successor = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    planningMode: "provided",
    predecessorRunId: canceled.id,
    successorPlan: structuredClone(canceled.plan),
    generateImages: false
  });
  approveScriptMangaRun(successor.id);
  const result = await startScriptMangaRun(successor.id);
  assert.deepEqual(result.tasks.map((task) => task.inheritedFromTaskId), [null, null]);
  assert.ok(result.tasks.every((task) => task.roundId), "both the unavailable root and its dependent panel must regenerate");
  const inheritance = (result.evaluation as { inheritance?: { continuitySkipped?: number; eligiblePredecessorTasks?: number } } | null)?.inheritance;
  assert.equal(inheritance?.eligiblePredecessorTasks, 1);
  assert.equal(inheritance?.continuitySkipped, 1);
  await cancelScriptMangaRun(result.id);
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

  promptPanels.forEach((task, index) => {
    assert.match(task.prompt, new RegExp(`directed prompt ${index}`));
    assert.match(task.prompt, /(?:extreme-wide|wide|medium|close-up|insert) shot/);
    assert.match(task.prompt, /one coherent moment/);
    assert.match(task.prompt, /no text\. no letters\. no speech bubbles/);
  });
  assert.equal(promptPanels[1]!.panel_id, dialoguePanels[0]!.panel_id);
  assert.equal(promptPanels[2]!.panel_id, dialoguePanels[1]!.panel_id);
  assert.notEqual(promptPanels[0]!.panel_id, dialoguePanels[0]!.panel_id);
});

test("prepared runs persist their frozen plan, pages and tasks and resume without duplication", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-prepared-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const projectId = project!.id as string;
  const imported = createScript(projectId, {
    title: "Prepared episode",
    fountainSource: [
      "INT. ROOM - DAY",
      "",
      "@Alice",
      "First line.",
      "",
      "Alice opens the door.",
      "",
      "@Bob",
      "Second line."
    ].join("\n")
  });

  const prepared = await createScriptMangaRun(projectId, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: false,
    panelsPerPage: 2,
    maxElementsPerPanel: 2,
    maxDialoguesPerPanel: 1
  });

  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.phase, "awaiting_approval");
  assert.equal(prepared.approvalStatus, "pending");
  assert.equal(prepared.scriptRevisionId, imported.revision.id);
  assert.ok(prepared.planId);
  assert.equal(prepared.plan?.scriptRevisionId, imported.revision.id);
  assert.equal(prepared.validation?.ok, true);
  assert.equal(prepared.tasks.length, prepared.panelCount);
  assert.ok(prepared.tasks.every((task) => task.status === "pending" && task.roundId === null));

  const planRow = getRow<{ script_revision_id: string; plan_json: string }>(
    "SELECT script_revision_id, plan_json FROM script_manga_plans WHERE id = ?",
    [prepared.planId]
  );
  assert.equal(planRow?.script_revision_id, imported.revision.id);
  assert.equal(JSON.parse(planRow!.plan_json).version, 2);

  const beforePages = getRows<{ page_id: string }>(
    "SELECT page_id FROM script_manga_run_pages WHERE run_id = ? ORDER BY page_index ASC",
    [prepared.id]
  );
  const beforeTasks = getRows<{ id: string }>(
    "SELECT id FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at ASC",
    [prepared.id]
  );
  assert.equal(beforePages.length, prepared.pageCount);
  assert.equal(beforeTasks.length, prepared.panelCount);

  const approved = approveScriptMangaRun(prepared.id);
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvalStatus, "approved");
  const started = await startScriptMangaRun(prepared.id);
  assert.equal(started.status, "running");
  assert.ok(started.tasks.every((task) => task.status === "running" && task.roundId));
  const resumed = await resumeScriptMangaRun(prepared.id);
  assert.equal(resumed.status, "running");

  assert.deepEqual(
    getRows<{ page_id: string }>("SELECT page_id FROM script_manga_run_pages WHERE run_id = ? ORDER BY page_index ASC", [prepared.id]),
    beforePages
  );
  assert.deepEqual(
    getRows<{ id: string }>("SELECT id FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at ASC", [prepared.id]),
    beforeTasks
  );
});

test("a replacement run reuses canceled plan-only pages without growing the book", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-page-reuse-${createId("test")}`, mode: "book" })!;
  const imported = createScript(project.id, {
    title: "Reusable pages",
    fountainSource: ["INT. ROOM - DAY", "", "@Alice", "Keep this on one page."].join("\n")
  });
  const request = {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: false,
    panelsPerPage: 1
  };

  const first = await createScriptMangaRun(project.id, request);
  const firstPages = getRows<{ page_id: string }>(
    "SELECT page_id FROM script_manga_run_pages WHERE run_id = ? ORDER BY page_index",
    [first.id]
  );
  await cancelScriptMangaRun(first.id);

  const replacement = await createScriptMangaRun(project.id, request);
  const replacementPages = getRows<{ page_id: string }>(
    "SELECT page_id FROM script_manga_run_pages WHERE run_id = ? ORDER BY page_index",
    [replacement.id]
  );
  assert.deepEqual(replacementPages, firstPages);
  assert.equal(getRows("SELECT id FROM pages WHERE project_id = ?", [project.id]).length, replacement.pageCount);
  assert.equal(getRows("SELECT page_id FROM script_manga_run_pages WHERE run_id = ?", [first.id]).length, 0);
});

test("replacement runs do not take canceled pages containing user objects", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-page-ownership-${createId("test")}`, mode: "book" })!;
  const imported = createScript(project.id, {
    title: "Protected page",
    fountainSource: ["INT. ROOM - DAY", "", "@Alice", "Do not replace my edit."].join("\n")
  });
  const request = {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: false,
    panelsPerPage: 1
  };

  const first = await createScriptMangaRun(project.id, request);
  const firstPageId = getRow<{ page_id: string }>(
    "SELECT page_id FROM script_manga_run_pages WHERE run_id = ? AND page_index = 0",
    [first.id]
  )!.page_id;
  await cancelScriptMangaRun(first.id);
  const userObjects = JSON.stringify([{ id: "manual-note", kind: "text" }]);
  runSql("UPDATE pages SET objects_json = ? WHERE id = ?", [userObjects, firstPageId]);

  const replacement = await createScriptMangaRun(project.id, request);
  const replacementPageId = getRow<{ page_id: string }>(
    "SELECT page_id FROM script_manga_run_pages WHERE run_id = ? AND page_index = 0",
    [replacement.id]
  )!.page_id;
  assert.notEqual(replacementPageId, firstPageId);
  assert.equal(getRow<{ objects_json: string }>("SELECT objects_json FROM pages WHERE id = ?", [firstPageId])!.objects_json, userObjects);
  assert.equal(getRows("SELECT id FROM pages WHERE project_id = ?", [project.id]).length, first.pageCount + replacement.pageCount);
});

test("an invalid plan edit rolls back without replacing run-owned pages or tasks", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-plan-rollback-${createId("test")}`, mode: "book" });
  const projectId = project!.id as string;
  const script = createScript(projectId, {
    title: "Plan rollback",
    fountainSource: ["INT. ROOM - DAY", "", "A clock ticks."].join("\n")
  });
  const prepared = await createScriptMangaRun(projectId, {
    scriptId: script.script.id,
    templateId,
    providerId: "fake",
    generateImages: false
  });
  const planBefore = getRow<{ plan_json: string }>("SELECT plan_json FROM script_manga_plans WHERE id = ?", [prepared.planId])!.plan_json;
  const pagesBefore = getRows<{ page_id: string }>(
    "SELECT page_id FROM script_manga_run_pages WHERE run_id = ? ORDER BY page_index",
    [prepared.id]
  );
  const tasksBefore = getRows<{ id: string }>(
    "SELECT id FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at",
    [prepared.id]
  );
  const invalid = structuredClone(prepared.plan!);
  invalid.pages[0]!.layoutTemplateId = "missing:layout";
  assert.throws(() => updateScriptMangaPlan(prepared.planId!, { plan: invalid }), /could not be resolved/);
  assert.equal(getRow<{ plan_json: string }>("SELECT plan_json FROM script_manga_plans WHERE id = ?", [prepared.planId])!.plan_json, planBefore);
  assert.deepEqual(
    getRows<{ page_id: string }>("SELECT page_id FROM script_manga_run_pages WHERE run_id = ? ORDER BY page_index", [prepared.id]),
    pagesBefore
  );
  assert.deepEqual(
    getRows<{ id: string }>("SELECT id FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at", [prepared.id]),
    tasksBefore
  );
  assert.equal(getScriptMangaRun(prepared.id).status, "prepared");
});

test("a run remains pinned to its original script revision and MangaPlanV2", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-revision-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const projectId = project!.id as string;
  const imported = createScript(projectId, {
    title: "Revision pin",
    fountainSource: ["INT. ROOM - DAY", "", "@Alice", "Original line."].join("\n")
  });
  const run = await createScriptMangaRun(projectId, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: false
  });
  const frozenPlan = structuredClone(run.plan);

  const newer = addScriptRevision(imported.script.id, {
    fountainSource: ["EXT. STREET - NIGHT", "", "@Alice", "Replacement line.", "", "@Bob", "New line."].join("\n")
  });
  assert.notEqual(newer.revision.id, imported.revision.id);

  const afterRevision = getScriptMangaRun(run.id);
  assert.equal(afterRevision.scriptRevisionId, imported.revision.id);
  assert.equal(afterRevision.plan?.scriptRevisionId, imported.revision.id);
  assert.deepEqual(afterRevision.plan, frozenPlan);
  assert.ok(afterRevision.plan?.narrativeGraph.sourceElements.some((element) => element.text.includes("Original line")));
  assert.ok(afterRevision.plan?.narrativeGraph.sourceElements.every((element) => !element.text.includes("Replacement line")));
});

test("five- and six-panel prepared runs use matching layouts and materialize every task", async () => {
  resetFakeProvider();
  const templateId = template();
  for (const panelCount of [5, 6]) {
    const project = createProject({ name: `script-manga-${panelCount}-panels-${createId("test")}`, mode: "book" });
    assert.ok(project);
    const projectId = project!.id as string;
    const fountainSource = [
      "INT. TEST CHAMBER - DAY",
      "",
      ...Array.from({ length: panelCount }, (_, index) => [`Visual beat ${index + 1}.`, ""]).flat()
    ].join("\n");
    const imported = createScript(projectId, { title: `${panelCount} panels`, fountainSource });
    const run = await createScriptMangaRun(projectId, {
      scriptId: imported.script.id,
      templateId,
      providerId: "fake",
      generateImages: false,
      panelsPerPage: panelCount,
      maxElementsPerPanel: 1
    });

    const expectedLayout = panelCount === 5 ? "builtin:five-panel" : "builtin:six-panel";
    assert.equal(run.status, "prepared");
    assert.equal(run.pageCount, 1);
    assert.equal(run.panelCount, panelCount);
    assert.equal(run.plan?.pages[0]?.layoutTemplateId, expectedLayout);
    assert.equal(
      getRow<{ layout_template_id: string }>(
        "SELECT layout_template_id FROM script_manga_run_pages WHERE run_id = ? AND page_index = 0",
        [run.id]
      )?.layout_template_id,
      expectedLayout
    );
    const tasks = getRows<{ status: string; round_id: string | null }>(
      "SELECT status, round_id FROM script_manga_tasks WHERE run_id = ?",
      [run.id]
    );
    assert.equal(tasks.length, panelCount);
    assert.ok(tasks.every((task) => task.status === "pending" && task.round_id === null));
  }
});

test("a prepared run executes from its layout snapshot after an imported template is deleted", async () => {
  resetFakeProvider();
  const templateId = template();
  const importedLayout = importLayoutTemplate({
    name: "Ephemeral one panel",
    json5: `{
      schemaVersion: '0.2.0',
      metadata: { title: 'Ephemeral one panel' },
      coordinateSystem: { preset: 'width-relative-top-left' },
      document: { mode: 'single-page', readingDirection: 'rtl', pageProgression: 'rtl' },
      pages: [{ id: 'page_1', role: 'single', aspectRatio: [1, 1.4], width: 1, height: 1.4, bounds: [0, 0, 1, 1.4] }],
      panels: [{ id: 'only', pageId: 'page_1', order: 1, shape: { type: 'rect', bounds: [0.04, 0.04, 0.96, 1.36] } }],
      balloons: [], texts: []
    }`
  });
  const project = createProject({ name: `script-manga-layout-snapshot-${createId("test")}`, mode: "book" });
  const projectId = project!.id as string;
  const script = createScript(projectId, {
    title: "Layout snapshot",
    fountainSource: ["INT. ROOM - DAY", "", "A door opens."].join("\n")
  });
  const prepared = await createScriptMangaRun(projectId, {
    scriptId: script.script.id,
    templateId,
    providerId: "fake",
    generateImages: false,
    planningMode: "provided",
    directorPlan: {
      title: "Snapshot plan",
      pages: [{
        index: 0,
        title: "Page 1",
        layoutTemplateId: importedLayout.template.id,
        panels: [{
          id: "snapshot-panel",
          sceneIndex: 0,
          sceneHeading: "INT. ROOM - DAY",
          prompt: "an opening door",
          sourceText: "A door opens.",
          dialogueOrderIndexes: []
        }]
      }]
    }
  });
  assert.equal(prepared.plan?.pages[0]?.layoutSnapshot.panels[0]?.id, "only");
  deleteLayoutTemplate(importedLayout.template.id);
  approveScriptMangaRun(prepared.id);
  const started = await startScriptMangaRun(prepared.id);
  assert.equal(started.status, "running");
  assert.equal(started.tasks.length, 1);
  assert.ok(started.tasks[0]!.roundId);
});

test("character aliases and bindings feed PanelSpec references and the generation request", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-references-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const projectId = project!.id as string;
  const character = createCharacter(projectId, { name: "Alice Kisaragi", aliases: ["ALICE", "アリス"] });
  const comfyBinding = await putCharacterBinding(character.id, "comfy", {
    faceImageDataUrl: TINY_PNG_DATA_URL,
    loraName: "alice-identity.safetensors",
    loraStrength: 0.8
  });
  assert.equal(comfyBinding.hasFaceImage, true);
  const storedBinding = getRow<{ binding_json: string }>(
    "SELECT binding_json FROM character_bindings WHERE character_id = ? AND provider_id = 'comfy'",
    [character.id]
  );
  assert.ok(storedBinding);
  runSql(
    "INSERT INTO character_bindings (id, character_id, provider_id, binding_json) VALUES (?, ?, 'fake', ?)",
    [createId("bind"), character.id, storedBinding!.binding_json]
  );

  const imported = createScript(projectId, {
    title: "Bound character",
    fountainSource: ["INT. LAB - NIGHT", "", "@ALICE", "Are you there?"].join("\n")
  });
  assert.equal(
    getRow<{ character_id: string }>("SELECT character_id FROM dialogue_lines WHERE script_id = ?", [imported.script.id])?.character_id,
    character.id
  );

  const run = await createScriptMangaRun(projectId, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: true,
    loras: [{ name: "global-style.safetensors", strength: 0.5 }]
  });
  assert.equal(run.tasks.length, 1);
  const task = getRow<{
    round_id: string;
    panel_spec_json: string;
    reference_manifest_json: string;
  }>("SELECT round_id, panel_spec_json, reference_manifest_json FROM script_manga_tasks WHERE id = ?", [run.tasks[0]!.id]);
  assert.ok(task?.round_id);
  const panelSpec = JSON.parse(task!.panel_spec_json);
  const manifest = JSON.parse(task!.reference_manifest_json);
  assert.ok(panelSpec.cast.some((member: { characterId: string }) => member.characterId === character.id));
  assert.ok(manifest.some((reference: { entityId: string; role: string }) => reference.entityId === character.id && reference.role === "identity"));
  assert.ok(manifest.some((reference: { entityId: string; role: string }) => reference.entityId === character.id && reference.role === "style"));

  const round = getRow<{ request_json: string; intent_json: string }>(
    "SELECT request_json, intent_json FROM generation_rounds WHERE id = ?",
    [task!.round_id]
  );
  const request = JSON.parse(round!.request_json);
  const intent = JSON.parse(round!.intent_json);
  assert.deepEqual(request.loras, [
    { name: "alice-identity.safetensors", strength: 0.8 },
    { name: "global-style.safetensors", strength: 0.5 }
  ]);
  assert.equal(request.reference.face.enabled, true);
  assert.equal(typeof request.reference.imagePath, "string");
  assert.ok(request.reference.imagePath.length > 0);
  assert.equal(intent.identity.face.kind, "roundAttachment");
  assert.equal(intent.identity.face.attachment, "reference");
});

test("figure スロット付きレイアウトの採用は切り抜き ImageObject を作り、矩形割当を残さない", async () => {
  resetFakeProvider();
  const templateId = template();
  const project = createProject({ name: `script-manga-figure-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const projectId = project!.id as string;
  const imported = createScript(projectId, {
    title: "Figure",
    fountainSource: [
      "INT. LAB - NIGHT",
      "",
      "Alice enters the lab.",
      "",
      "@Alice",
      "ここはどこ？",
      "",
      "@Mira",
      "旧研究棟です。",
      "",
      "Alice walks to the window.",
      "",
      "@Alice",
      "広いね。",
      "",
      "@Mira",
      "はい。",
      "",
      "Alice stands tall.",
      "",
      "@Alice",
      "行こう。"
    ].join("\n")
  });
  const prepared = await createScriptMangaRun(projectId, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    generateImages: false,
    maxDialoguesPerPanel: 2
  });
  assert.equal(prepared.pageCount, 1);
  assert.equal(prepared.panelCount, 3);

  // 監督(または provided plan 作者)が figure スロット付きレイアウトを選んだ状況を再現する。
  const plan = structuredClone(prepared.plan!);
  plan.pages[0]!.layoutTemplateId = "builtin:three-figure-left";
  updateScriptMangaPlan(prepared.planId!, { plan });
  approveScriptMangaRun(prepared.id);
  const started = await startScriptMangaRun(prepared.id);
  for (const task of started.tasks) {
    assert.ok(task.roundId);
    await collectRound(task.roundId!);
  }

  const awaitingReview = getScriptMangaRun(prepared.id);
  assert.equal(awaitingReview.status, "awaiting_review");
  const figureTask = awaitingReview.tasks.find((task) => task.panelId === "figure");
  assert.ok(figureTask, "figure スロットの task が存在すること");
  const figureSpec = JSON.parse(
    getRow<{ panel_spec_json: string }>("SELECT panel_spec_json FROM script_manga_tasks WHERE id = ?", [figureTask!.id])!
      .panel_spec_json
  ) as { role?: string; compiledPrompt: string; cast: unknown[] };
  assert.equal(figureSpec.role, "figure");
  assert.match(figureSpec.compiledPrompt, /white background/);
  assert.equal(figureSpec.cast.length, 1);

  // fake provider の候補画像を「白背景の全身立ち絵」に差し替えてから採用する。
  const figureAssetId = figureTask!.candidateAssetIds[0]!;
  const figureAsset = getRow<{ image_path: string }>("SELECT image_path FROM assets WHERE id = ?", [figureAssetId])!;
  const figureSvg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="420">`,
    `<rect width="240" height="420" fill="#ffffff"/>`,
    `<ellipse cx="120" cy="90" rx="40" ry="46" fill="#aa3344"/>`,
    `<rect x="85" y="130" width="70" height="240" fill="#443366"/>`,
    `</svg>`
  ].join("");
  const sharpModule = (await import("sharp")).default;
  await writeFile(figureAsset.image_path, await sharpModule(Buffer.from(figureSvg)).png().toBuffer());

  let view = awaitingReview;
  for (const task of awaitingReview.tasks.filter((task) => task.id !== figureTask!.id)) {
    view = await selectScriptMangaTaskCandidate(task.id, { assetId: task.candidateAssetIds[0]! });
  }
  const figureSelection = selectScriptMangaTaskCandidate(figureTask!.id, { assetId: figureAssetId });
  const whileMaterializing = getScriptMangaRun(prepared.id);
  assert.equal(
    whileMaterializing.tasks.find((task) => task.id === figureTask!.id)?.status,
    "selecting",
    "figure selection remains non-terminal until its async cutout is committed"
  );
  assert.notEqual(whileMaterializing.status, "completed");
  view = await figureSelection;
  assert.equal(view.status, "completed");

  const pageObjects = JSON.parse(
    getRow<{ objects_json: string }>("SELECT objects_json FROM pages WHERE id = ?", [figureTask!.pageId])!.objects_json
  ) as Array<Record<string, unknown>>;
  const figureObject = pageObjects.find((object) => object.id === "figure_figure");
  assert.ok(figureObject, "figure ImageObject が作られること");
  assert.equal(figureObject!.kind, "image");
  assert.equal(figureObject!.band, "front");
  assert.equal(figureObject!.clipPanelId ?? null, null);

  const media = getRow<{ id: string; file_path: string; source_asset_id: string | null }>(
    "SELECT id, file_path, source_asset_id FROM page_media WHERE id = ?",
    [figureObject!.mediaId as string]
  );
  assert.ok(media, "page_media 行が作られること");
  assert.equal(media!.source_asset_id, figureAssetId);
  assert.ok(existsSync(media!.file_path), "切り抜き PNG が保存されること");

  const assignments = getRows<{ panel_id: string }>(
    "SELECT panel_id FROM page_panel_assignments WHERE page_id = ?",
    [figureTask!.pageId]
  );
  assert.equal(assignments.length, 2, "矩形割当は story コマ2つだけ");
  assert.ok(assignments.every((row) => row.panel_id !== "figure"));

  const evaluation = JSON.parse(
    getRow<{ evaluation_json: string }>("SELECT evaluation_json FROM script_manga_runs WHERE id = ?", [prepared.id])!
      .evaluation_json
  ) as { figures?: Record<string, { state?: string }> };
  assert.equal(evaluation.figures?.[figureTask!.id]?.state, "cutout");

  // 立ち絵の再レタリング後も全 placement が吹き出し化されたまま。
  assert.equal(
    getRows("SELECT id FROM dialogue_placements WHERE page_id = ? AND balloon_object_id IS NULL", [figureTask!.pageId]).length,
    0
  );

  const successor = await createScriptMangaRun(projectId, {
    scriptId: imported.script.id,
    planningMode: "provided",
    predecessorRunId: view.id,
    successorPlan: structuredClone(view.plan),
    generateImages: false
  });
  approveScriptMangaRun(successor.id);
  await Promise.all([
    startScriptMangaRun(successor.id),
    resumeScriptMangaRun(successor.id)
  ]);
  const successorView = getScriptMangaRun(successor.id);
  assert.ok(successorView.tasks.every((task) => task.status === "completed"));
  assert.ok(successorView.tasks.every((task) => task.inheritedFromTaskId));
  assert.equal(
    getRows("SELECT id FROM generation_rounds WHERE script_manga_task_id IN (SELECT id FROM script_manga_tasks WHERE run_id = ?)", [successor.id]).length,
    0,
    "concurrent start/resume must not submit inherited tasks"
  );
  const inheritedFigureTask = successorView.tasks.find((task) => task.panelId === "figure")!;
  const inheritedFigureObjects = JSON.parse(
    getRow<{ objects_json: string }>("SELECT objects_json FROM pages WHERE id = ?", [inheritedFigureTask.pageId])!.objects_json
  ) as Array<Record<string, unknown>>;
  assert.equal(inheritedFigureObjects.filter((object) => object.id === "figure_figure").length, 1);
  assert.equal(
    getRows("SELECT id FROM page_media WHERE source_asset_id = ?", [figureAssetId]).length,
    2,
    "the predecessor and successor should each materialize one figure media row"
  );

  const canceledSuccessor = await createScriptMangaRun(projectId, {
    scriptId: imported.script.id,
    planningMode: "provided",
    predecessorRunId: view.id,
    successorPlan: structuredClone(view.plan),
    generateImages: false
  });
  approveScriptMangaRun(canceledSuccessor.id);
  const canceledFigureTask = canceledSuccessor.tasks.find((task) => task.panelId === "figure")!;
  const startCanceledSuccessor = startScriptMangaRun(canceledSuccessor.id);
  let observedFigureInheritance = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = getRow<{ status: string }>("SELECT status FROM script_manga_tasks WHERE id = ?", [canceledFigureTask.id])?.status;
    if (status === "inheriting") {
      observedFigureInheritance = true;
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(observedFigureInheritance, true, "test must cancel while figure cutout is awaiting async work");
  await cancelScriptMangaRun(canceledSuccessor.id);
  await startCanceledSuccessor;
  const canceledView = getScriptMangaRun(canceledSuccessor.id);
  assert.equal(canceledView.status, "canceled");
  assert.equal(canceledView.tasks.find((task) => task.id === canceledFigureTask.id)?.status, "canceled");
  const canceledObjects = JSON.parse(
    getRow<{ objects_json: string }>("SELECT objects_json FROM pages WHERE id = ?", [canceledFigureTask.pageId])!.objects_json
  ) as Array<Record<string, unknown>>;
  assert.equal(canceledObjects.some((object) => object.id === "figure_figure"), false);
  assert.equal(
    getRows("SELECT id FROM page_media WHERE source_asset_id = ?", [figureAssetId]).length,
    2,
    "canceled async figure inheritance removes any newly created media before returning"
  );
});
