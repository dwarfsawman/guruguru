import assert from "node:assert/strict";
import test from "node:test";
import { createId, getRow, initializeDb, runSql } from "./db.ts";
import { createProject } from "./projects.ts";
import { createScript, addScriptRevision } from "./scripts.ts";
import {
  adoptablePlanCandidate,
  archiveScriptMangaPlanCandidate,
  createScriptMangaPlanCandidates,
  listScriptMangaPlanCandidates,
  markPlanCandidateAdopted
} from "./scriptMangaPlanCandidates.ts";
import { createScriptMangaRun } from "./scriptManga.ts";
import { fakeProvider, resetFakeProvider } from "./providers/fakeProvider.ts";
import { registerProvider } from "./providers/registry.ts";
import { HttpError } from "./http.ts";

registerProvider(fakeProvider);

const SCRIPT = ["INT. LAB - NIGHT", "", "箱を開ける。中には写真がある。", "", "@ALICE", "これは……私?"].join("\n");

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
});

test("候補採用run: planCandidateIdでrunが作られ、候補がadoptedになり、プランは候補のレイアウトを保つ", async () => {
  resetFakeProvider();
  const templateId = fakeTemplate();
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
  // markPlanCandidateAdopted は再採用でも上書きできる(履歴は最新runを指す)。
  markPlanCandidateAdopted(candidate.id, run.id);
});
