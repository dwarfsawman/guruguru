import assert from "node:assert/strict";
import test from "node:test";
import { createId, getRow, initializeDb, runSql } from "./db.ts";
import { createProject } from "./projects.ts";
import { createScript, addScriptRevision } from "./scripts.ts";
import {
  adoptablePlanCandidate,
  archiveScriptMangaPlanCandidate,
  beginPlanCandidateAdoption,
  createScriptMangaPlanCandidates,
  importScriptMangaPlanCandidate,
  isExternallyDirectedPlanCandidate,
  listScriptMangaPlanCandidates,
  markPlanCandidateAdopted,
  requirePlanCandidate,
  scriptMangaCandidateDirectionInputHash,
  setCandidateLayoutOverride
} from "./scriptMangaPlanCandidates.ts";
import {
  applyNamePlanEdits,
  createScriptMangaRun,
  scriptMangaCandidateDirectionOptionsFromInput
} from "./scriptManga.ts";
import { fakeProvider, resetFakeProvider } from "./providers/fakeProvider.ts";
import { registerProvider } from "./providers/registry.ts";
import { HttpError } from "./http.ts";
import {
  scriptMangaPlanStructureSignature,
  type ScriptMangaPlan
} from "../shared/scriptMangaPlan.ts";

registerProvider(fakeProvider);

test("candidate direction settings hash is independent of object insertion order", () => {
  assert.equal(
    scriptMangaCandidateDirectionInputHash({
      scriptRevisionId: "revision-1",
      panelsPerPage: 4,
      maxDialoguesPerPanel: 3,
      characterBible: "Alice"
    }),
    scriptMangaCandidateDirectionInputHash({
      characterBible: "Alice",
      maxDialoguesPerPanel: 3,
      panelsPerPage: 4,
      scriptRevisionId: "revision-1"
    })
  );
});

test("candidate direction settings use the same effective options as adoption", () => {
  assert.deepEqual(
    scriptMangaCandidateDirectionOptionsFromInput({
      dialoguePolicy: "adapt",
      characterBible: " Alice "
    }, "revision-1"),
    {
      scriptRevisionId: "revision-1",
      panelsPerPage: 2,
      maxElementsPerPanel: 6,
      maxDialoguesPerPanel: 3,
      targetPageCount: undefined,
      stylePrompt: undefined,
      characterBible: " Alice "
    }
  );
});

const SCRIPT = ["INT. LAB - NIGHT", "", "箱を開ける。中には写真がある。", "", "@ALICE", "これは……私?"].join("\n");

function externallyDirected(plan: ScriptMangaPlan): ScriptMangaPlan {
  const directed = structuredClone(plan);
  for (const page of directed.pages) {
    page.pageIntent = `External page direction ${page.index}`;
    for (const panel of page.panels) {
      panel.prompt = `${panel.prompt}, externally directed`;
      panel.direction = {
        shot: "medium shot",
        angle: "eye-level",
        subject: "the visible story subject",
        subjects: [{
          ref: "ALICE",
          position: "middle-center",
          action: "holds the sealed box",
          expression: "restrained tension",
          gaze: "toward the box"
        }],
        avoid: ["illegible lettering", "duplicate subject"],
        action: "advance the scripted action",
        emotion: "restrained tension",
        composition: "clear focal hierarchy and readable staging"
      };
    }
  }
  return directed;
}

function fakeTemplate(): string {
  initializeDb();
  const id = createId("template");
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Candidates fake', '', 'txt2img', 1, '{}', '{}', 'hash')`,
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
     VALUES (?, 'Candidates Chroma fake', '', 'txt2img', 1, ?, '{}', 'chroma-hash')`,
    [id, JSON.stringify(workflow)]
  );
  return id;
}

test("プラン候補: LLM不通でも決定的候補が1件だけ貯まり(重複排除)、一覧・破棄が機能する", async () => {
  initializeDb();
  const project = createProject({ name: `plan-cand-${createId("t")}`, mode: "book" })!;
  const imported = createScript(project.id, { title: "Cand", fountainSource: SCRIPT });
  const created = await createScriptMangaPlanCandidates(project.id, { scriptId: imported.script.id, count: 3 });
  assert.equal(created.candidates.length, 1, "決定的フォールバックはグループに1件へ重複排除");
  assert.equal(created.candidates[0]!.pageNaming?.mode, "deterministic");
  assert.ok(created.dialogueCharsByOrderIndex.length >= 1);
  const listed = listScriptMangaPlanCandidates(project.id, imported.script.id);
  assert.equal(listed.candidates.length, 1);
  assert.equal(listed.candidates[0]!.status, "active");
  // 同グループへの追加生成も決定的1件のまま増えない。
  const extended = await createScriptMangaPlanCandidates(project.id, {
    scriptId: imported.script.id, count: 2, groupId: listed.candidates[0]!.groupId
  });
  assert.equal(extended.candidates.length, 0);
  // 破棄で一覧から消える。
  archiveScriptMangaPlanCandidate(listed.candidates[0]!.id);
  assert.equal(listScriptMangaPlanCandidates(project.id, imported.script.id).candidates.length, 0);
  assert.throws(
    () => adoptablePlanCandidate(listed.candidates[0]!.id, project.id, imported.script.id, listed.candidates[0]!.scriptRevisionId),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409
  );
});

test("外部候補import: fixed revisionを検証し、同一groupの構造重複を演出済みplanへupsertする", async () => {
  initializeDb();
  const project = createProject({ name: `plan-cand-external-${createId("t")}`, mode: "book" })!;
  const importedScript = createScript(project.id, { title: "External Cand", fountainSource: SCRIPT });
  const created = await createScriptMangaPlanCandidates(project.id, {
    scriptId: importedScript.script.id,
    count: 1
  });
  const embedded = created.candidates[0]!;
  assert.equal(embedded.origin, "embedded");
  assert.equal(embedded.directorMode, "embedded");
  assert.equal(isExternallyDirectedPlanCandidate(requirePlanCandidate(embedded.id)), false);

  const plan = externallyDirected(embedded.plan);
  assert.equal(
    scriptMangaPlanStructureSignature(plan),
    scriptMangaPlanStructureSignature(embedded.plan),
    "prompt/direction/pageIntentの差は同じネーム構造"
  );
  const withoutBeatAnnotations = structuredClone(plan);
  for (const page of withoutBeatAnnotations.pages) {
    for (const panel of page.panels) delete panel.sourceBeatIds;
  }
  assert.equal(
    scriptMangaPlanStructureSignature(withoutBeatAnnotations),
    scriptMangaPlanStructureSignature(plan),
    "optional beat注釈の有無だけでは別構造にしない"
  );
  const differentDialogueAssignment = structuredClone(plan);
  const dialoguePanel = differentDialogueAssignment.pages.flatMap((page) => page.panels)
    .find((panel) => panel.dialogueOrderIndexes.length > 0)!;
  dialoguePanel.dialogueOrderIndexes = [];
  assert.notEqual(
    scriptMangaPlanStructureSignature(differentDialogueAssignment),
    scriptMangaPlanStructureSignature(plan),
    "同じbeatでも台詞割当が違えば別構造"
  );
  const imported = importScriptMangaPlanCandidate(project.id, {
    scriptId: importedScript.script.id,
    scriptRevisionId: embedded.scriptRevisionId,
    groupId: embedded.groupId,
    plan,
    profile: "cinematic",
    agent: "Codex",
    model: "external-test-model",
    notes: "directed outside the embedded LLM"
  });
  assert.equal(imported.imported, false);
  assert.equal(imported.duplicateOf, embedded.id);
  assert.equal(imported.candidate.id, embedded.id, "deep linkを保つため既存candidate idへupsert");
  assert.equal(imported.candidate.editVersion, embedded.editVersion + 1);
  assert.equal(imported.candidate.origin, "external");
  assert.equal(imported.candidate.directorMode, "provided");
  assert.equal(imported.candidate.plan.pages[0]!.panels[0]!.direction?.shot, "medium shot");
  assert.equal(imported.candidate.plan.pages[0]!.panels[0]!.direction?.angle, "eye-level");
  assert.deepEqual(imported.candidate.plan.pages[0]!.panels[0]!.direction?.subjects?.[0], {
    ref: "ALICE",
    position: "middle-center",
    action: "holds the sealed box",
    expression: "restrained tension",
    gaze: "toward the box"
  });
  assert.deepEqual(imported.candidate.plan.pages[0]!.panels[0]!.direction?.avoid, [
    "illegible lettering",
    "duplicate subject"
  ]);
  const stored = requirePlanCandidate(embedded.id);
  assert.equal(isExternallyDirectedPlanCandidate(stored), true);
  assert.deepEqual(JSON.parse(stored.provenance_json!).external, {
    agent: "Codex",
    model: "external-test-model",
    notes: "directed outside the embedded LLM"
  });
  const replayedImport = importScriptMangaPlanCandidate(project.id, {
    scriptId: importedScript.script.id,
    scriptRevisionId: embedded.scriptRevisionId,
    groupId: embedded.groupId,
    plan,
    profile: "cinematic",
    agent: "Codex",
    model: "external-test-model",
    notes: "directed outside the embedded LLM"
  });
  assert.equal(replayedImport.candidate.editVersion, imported.candidate.editVersion, "同一import再送はversionを進めない");
  assert.equal(getRow<{ count: number }>(
    "SELECT COUNT(*) AS count FROM script_manga_plan_candidates WHERE group_id = ?",
    [embedded.groupId]
  )!.count, 1);

  const generatedAgain = await createScriptMangaPlanCandidates(project.id, {
    scriptId: importedScript.script.id,
    count: 2,
    groupId: embedded.groupId
  });
  assert.equal(generatedAgain.candidates.length, 0, "embedded生成側も共通の構造dedupを使う");

  const inserted = importScriptMangaPlanCandidate(project.id, {
    scriptId: importedScript.script.id,
    scriptRevisionId: embedded.scriptRevisionId,
    plan,
    profile: "tempo",
    agent: "Codex"
  });
  assert.equal(inserted.imported, true, "group省略時は新しい比較groupへINSERT");
  assert.equal(inserted.duplicateOf, null);
  assert.notEqual(inserted.candidate.groupId, embedded.groupId);

  const run = await createScriptMangaRun(project.id, {
    scriptId: importedScript.script.id,
    templateId: fakeTemplate(),
    providerId: "fake",
    planCandidateId: embedded.id,
    generateImages: false,
    requireReferenceSets: false,
    auditMode: "manual"
  });
  assert.equal(
    run.plan?.pages[0]?.panels[0]?.directionSource,
    "provided",
    "外部演出済み候補は組み込み監督を重ねずprovidedとして採用する"
  );
});

test("プラン候補: 旧revisionの候補は一覧から消え、採用も409で拒否される", async () => {
  initializeDb();
  const project = createProject({ name: `plan-cand-stale-${createId("t")}`, mode: "book" })!;
  const imported = createScript(project.id, { title: "Cand", fountainSource: SCRIPT });
  const created = await createScriptMangaPlanCandidates(project.id, { scriptId: imported.script.id, count: 1 });
  assert.equal(created.candidates.length, 1);
  const candidate = created.candidates[0]!;
  addScriptRevision(imported.script.id, { fountainSource: `${SCRIPT}\n\n@BOB\n追加の台詞。` });
  assert.equal(listScriptMangaPlanCandidates(project.id, imported.script.id).candidates.length, 0, "stale候補は出さない");
  const latest = getRow<{ id: string }>(
    "SELECT id FROM script_revisions WHERE script_id = ? ORDER BY revision DESC LIMIT 1",
    [imported.script.id]
  )!;
  assert.throws(
    () => adoptablePlanCandidate(candidate.id, project.id, imported.script.id, latest.id),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409
  );
  assert.throws(
    () => importScriptMangaPlanCandidate(project.id, {
      scriptId: imported.script.id,
      scriptRevisionId: candidate.scriptRevisionId,
      plan: externallyDirected(candidate.plan)
    }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409,
    "stale fixed revisionへの外部importも409"
  );
});

test("候補採用run: planCandidateIdでrunが作られ、候補がadoptedになり、プランは候補のレイアウトを保つ", async () => {
  resetFakeProvider();
  const templateId = chromaTemplate();
  const project = createProject({ name: `plan-cand-adopt-${createId("t")}`, mode: "book" })!;
  const imported = createScript(project.id, { title: "Cand", fountainSource: SCRIPT });
  const created = await createScriptMangaPlanCandidates(project.id, { scriptId: imported.script.id, count: 1 });
  const candidate = created.candidates[0]!;
  const run = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    planCandidateId: candidate.id,
    generateImages: false,
    requireReferenceSets: true,
    dialoguePolicy: "preserve",
    auditMode: "manual"
  });
  assert.ok(run.plan);
  assert.equal(run.plan!.pages.length, candidate.plan.pages.length);
  assert.deepEqual(
    run.plan!.pages.map((page) => page.layoutTemplateId),
    candidate.plan.pages.map((page) => page.layoutTemplateId),
    "採用候補のレイアウトは監督(不通時fallback含む)後も不変"
  );
  const row = getRow<{ status: string; adopted_run_id: string | null }>(
    "SELECT status, adopted_run_id FROM script_manga_plan_candidates WHERE id = ?",
    [candidate.id]
  )!;
  assert.equal(row.status, "adopted");
  assert.equal(row.adopted_run_id, run.id);
  assert.equal(run.status, "prepared", "Reference Set作成前でも候補採用runは成立する");
  await assert.rejects(
    () => createScriptMangaRun(project.id, {
      scriptId: imported.script.id,
      templateId,
      providerId: "fake",
      planCandidateId: candidate.id,
      generateImages: false,
      requireReferenceSets: true,
      auditMode: "manual"
    }),
    /no longer active/,
    "汎用run APIの再送でも同じ候補から別runを二重作成しない"
  );
  assert.throws(
    () => markPlanCandidateAdopted(candidate.id, run.id),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409,
    "完了済みclaimを別runで上書きしない"
  );
  runSql(
    "UPDATE script_manga_plan_candidates SET status = 'adopting', adopted_run_id = NULL WHERE id = ?",
    [candidate.id]
  );
  initializeDb();
  const recovered = requirePlanCandidate(candidate.id);
  assert.equal(recovered.status, "adopted", "materialize済みrunとのclaimは起動時に採用成立へ回復する");
  assert.equal(recovered.adopted_run_id, run.id, "起動時回復で別runを作らず既存run identityを結ぶ");

  // --- V5 D6: ホワイトリスト差分編集(/edits 相当)と directionSource ---
  assert.ok(run.planId && run.plan && run.planEditVersion !== null);
  const targetPanel = run.plan!.pages[0]!.panels[0]!;
  assert.equal(targetPanel.directionSource, "fallback", "LLM不通の監督バッチフォールバックは未演出");
  // versionずれは409。
  assert.throws(
    () => applyNamePlanEdits(run.planId!, {
      expectedVersion: run.planEditVersion! + 5,
      edits: [{ kind: "panel", panelId: targetPanel.id, shotSize: "close-up" }]
    }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409
  );
  const edited = applyNamePlanEdits(run.planId!, {
    expectedVersion: run.planEditVersion!,
    edits: [
      { kind: "panel", panelId: targetPanel.id, shotSize: "close-up", compositionIntent: "tight on the open box" },
      { kind: "page", pageIndex: 0, pageIntent: "quiet reveal of the photo" }
    ]
  });
  assert.ok(edited.editVersion > run.planEditVersion!, "plan_json書き込みでeditVersionが進む");
  const editedPanel = edited.plan.pages[0]!.panels.find((panel) => panel.id === targetPanel.id)!;
  assert.equal(editedPanel.shot.size, "close-up");
  assert.equal(editedPanel.shot.compositionIntent, "tight on the open box");
  assert.equal(editedPanel.directionSource, "human", "人間の差分編集はhumanへ");
  assert.equal(edited.plan.pages[0]!.pageIntent, "quiet reveal of the photo");
  // 凍結フィールドは差分編集で不変。
  assert.deepEqual(edited.plan.dialogueSnapshots, run.plan!.dialogueSnapshots);
  // ホワイトリスト外・未知kindは400。
  assert.throws(
    () => applyNamePlanEdits(run.planId!, {
      expectedVersion: edited.editVersion,
      edits: [{ kind: "layout", pageIndex: 0 }]
    }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});

test("候補採用runはpageLimit指定を無視して複数ページ候補の全ページを固定する", async () => {
  initializeDb();
  const project = createProject({ name: `plan-cand-all-pages-${createId("t")}`, mode: "book" })!;
  const source = [
    "INT. LAB - NIGHT", "", "Alice studies a sealed box.", "", "@ALICE", "The lock is warm.", "",
    "INT. HALL - NIGHT", "", "Bob reaches the laboratory door.", "", "@BOB", "Alice, are you there?", "",
    "INT. LAB - NIGHT", "", "The box opens and blue light fills the room.", "", "@ALICE", "I found it."
  ].join("\n");
  const imported = createScript(project.id, { title: "All pages", fountainSource: source });
  const created = await createScriptMangaPlanCandidates(project.id, {
    scriptId: imported.script.id,
    count: 1,
    targetPageCount: 3,
    panelsPerPage: 3,
    maxDialoguesPerPanel: 2
  });
  const candidate = created.candidates[0]!;
  assert.ok(candidate.plan.pages.length > 1, "fixture must produce a multi-page candidate");

  const run = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId: fakeTemplate(),
    providerId: "fake",
    planCandidateId: candidate.id,
    pageLimit: 1,
    panelsPerPage: 6,
    maxDialoguesPerPanel: 8,
    generateImages: false,
    requireReferenceSets: false,
    auditMode: "manual"
  });
  assert.equal(run.pageCount, candidate.plan.pages.length);
  assert.equal(run.plan?.pages.length, candidate.plan.pages.length);
});

test("起動時回復はplanning中に途切れた候補runと所有ページを除去して再採用可能へ戻す", async () => {
  initializeDb();
  const project = createProject({ name: `plan-cand-partial-recovery-${createId("t")}`, mode: "book" })!;
  const imported = createScript(project.id, { title: "Partial recovery", fountainSource: SCRIPT });
  const created = await createScriptMangaPlanCandidates(project.id, { scriptId: imported.script.id, count: 1 });
  const candidate = created.candidates[0]!;
  const run = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId: fakeTemplate(),
    providerId: "fake",
    planCandidateId: candidate.id,
    generateImages: false,
    requireReferenceSets: false,
    auditMode: "manual"
  });
  const ownedPages = getRow<{ count: number }>(
    "SELECT COUNT(*) AS count FROM script_manga_run_pages WHERE run_id = ?",
    [run.id]
  )!.count;
  assert.ok(ownedPages > 0);
  const ownedPage = getRow<{ page_id: string }>(
    "SELECT page_id FROM script_manga_run_pages WHERE run_id = ? LIMIT 1",
    [run.id]
  )!;
  runSql("UPDATE script_manga_runs SET status = 'preparing', phase = 'planning' WHERE id = ?", [run.id]);
  runSql(
    "UPDATE script_manga_plan_candidates SET status = 'adopting', adopted_run_id = NULL WHERE id = ?",
    [candidate.id]
  );

  initializeDb();
  assert.equal(requirePlanCandidate(candidate.id).status, "active");
  assert.equal(getRow("SELECT id FROM script_manga_runs WHERE id = ?", [run.id]), null);
  assert.equal(getRow("SELECT id FROM script_manga_plans WHERE id = ?", [run.planId]), null);
  assert.equal(getRow("SELECT id FROM pages WHERE id = ?", [ownedPage.page_id]), null);
});

test("set-layout(V5 D5): 基礎プラン不変+overrides+楽観ロック、リセット、採用は実効プランを使う", async () => {
  initializeDb();
  const project = createProject({ name: `plan-cand-flip-${createId("t")}`, mode: "book" })!;
  const imported = createScript(project.id, { title: "Flip", fountainSource: SCRIPT });
  const created = await createScriptMangaPlanCandidates(project.id, { scriptId: imported.script.id, count: 1 });
  const candidate = created.candidates[0]!;
  assert.equal(candidate.editVersion, 0);
  assert.deepEqual(candidate.layoutOverrides, {});
  const baseLayout = candidate.plan.pages[0]!.layoutTemplateId;
  const panelCount = candidate.plan.pages[0]!.panels.length;
  // 同コマ数の別レイアウトへフリップ(内蔵プールから基礎と違うものを選ぶ)。
  const { scriptMangaLayoutCandidates } = await import("../shared/layoutPresets.ts");
  const alternative = scriptMangaLayoutCandidates(panelCount).find((id) => id !== baseLayout);
  if (!alternative) return; // プールに1種しかないコマ数(現状ないが保険)
  // 楽観ロック: version不一致は409。
  assert.throws(
    () => setCandidateLayoutOverride(candidate.id, { pageIndex: 0, layoutTemplateId: alternative, expectedVersion: 9 }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409
  );
  const flipped = setCandidateLayoutOverride(candidate.id, { pageIndex: 0, layoutTemplateId: alternative, expectedVersion: 0 });
  assert.equal(flipped.version, 1);
  assert.equal(flipped.candidate.layoutOverrides[0], alternative);
  assert.equal(flipped.candidate.plan.pages[0]!.layoutTemplateId, baseLayout, "基礎プランは不変");
  // 採用は実効プラン(override適用済み)を返す。
  const latest = getRow<{ id: string }>(
    "SELECT id FROM script_revisions WHERE script_id = ? ORDER BY revision DESC LIMIT 1",
    [imported.script.id]
  )!;
  const adoptable = adoptablePlanCandidate(candidate.id, project.id, imported.script.id, latest.id, 1);
  assert.equal(adoptable.plan.pages[0]!.layoutTemplateId, alternative);
  // 採用中(adopting)はフリップも再採用も409、revertで戻る。
  beginPlanCandidateAdoption(candidate.id);
  assert.throws(
    () => setCandidateLayoutOverride(candidate.id, { pageIndex: 0, layoutTemplateId: baseLayout, expectedVersion: 1 }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409
  );
  assert.throws(
    () => adoptablePlanCandidate(candidate.id, project.id, imported.script.id, latest.id),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409
  );
  assert.throws(
    () => archiveScriptMangaPlanCandidate(candidate.id),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409,
    "採用中claimをarchiveで奪わない"
  );
  initializeDb();
  assert.equal(requirePlanCandidate(candidate.id).status, "active", "再起動初期化で孤児adoptingを回復する");
  // 基礎プランと同じレイアウトを選ぶ = リセット(overrideが消える)。
  const reset = setCandidateLayoutOverride(candidate.id, { pageIndex: 0, layoutTemplateId: baseLayout, expectedVersion: 1 });
  assert.equal(reset.version, 2);
  assert.deepEqual(reset.candidate.layoutOverrides, {});
  // コマ数不一致のレイアウトは400。
  const wrongCount = scriptMangaLayoutCandidates(panelCount === 1 ? 2 : 1)[0]!;
  assert.throws(
    () => setCandidateLayoutOverride(candidate.id, { pageIndex: 0, layoutTemplateId: wrongCount, expectedVersion: 2 }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});
