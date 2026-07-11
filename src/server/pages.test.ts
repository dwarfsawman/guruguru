import { test } from "node:test";
import assert from "node:assert/strict";
import { createPage, deletePage, mergeRecentImages, updatePageLayout } from "./pages.ts";
import { createProject } from "./projects.ts";
import { createSourceAsset } from "./sourceAssets.ts";
import { createId, getRow, initializeDb, runSql } from "./db.ts";
import type { RecentReferenceImage } from "../shared/apiTypes.ts";
import { HttpError } from "./http.ts";

// 「最近使った画像」の混在マージ(重複排除は呼び出し側で済ませる前提)の純関数を pin する。
// See Docs/Feature-BookCommonSettings.md / Part 1。

function ref(url: string, createdAt: string): RecentReferenceImage {
  return { kind: "reference", url, thumbnailUrl: url, createdAt };
}

function asset(id: string, createdAt: string): RecentReferenceImage {
  return { kind: "asset", url: `/api/assets/${id}/image`, thumbnailUrl: `/api/assets/${id}/thumbnail?size=small`, createdAt };
}

test("mergeRecentImages: 参照と生成を createdAt 降順で混在させる", () => {
  const references = [ref("r-a", "2026-07-09T10:00:00Z"), ref("r-b", "2026-07-09T08:00:00Z")];
  const assets = [asset("s-1", "2026-07-09T11:00:00Z"), asset("s-2", "2026-07-09T09:00:00Z")];
  const merged = mergeRecentImages(references, assets, 10);
  assert.deepEqual(
    merged.map((image) => image.createdAt),
    ["2026-07-09T11:00:00Z", "2026-07-09T10:00:00Z", "2026-07-09T09:00:00Z", "2026-07-09T08:00:00Z"]
  );
  assert.deepEqual(merged.map((image) => image.kind), ["asset", "reference", "asset", "reference"]);
});

test("mergeRecentImages: limit で新しい順に打ち切る", () => {
  const references = [ref("r-a", "2026-07-09T10:00:00Z")];
  const assets = [
    asset("s-1", "2026-07-09T12:00:00Z"),
    asset("s-2", "2026-07-09T11:00:00Z"),
    asset("s-3", "2026-07-09T09:00:00Z")
  ];
  const merged = mergeRecentImages(references, assets, 2);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((image) => image.url), ["/api/assets/s-1/image", "/api/assets/s-2/image"]);
});

test("mergeRecentImages: limit 0 は空、負値も空", () => {
  const references = [ref("r-a", "2026-07-09T10:00:00Z")];
  assert.deepEqual(mergeRecentImages(references, [], 0), []);
  assert.deepEqual(mergeRecentImages(references, [], -3), []);
});

test("mergeRecentImages: 片方が空でも安全", () => {
  const assets = [asset("s-1", "2026-07-09T12:00:00Z")];
  assert.deepEqual(mergeRecentImages([], assets, 5), assets);
  assert.deepEqual(mergeRecentImages(assets, [], 5), assets);
});

// 1x1 の最小 PNG(dataUrl アップロード用)。src/server/comfy.ts の dummy 画像と同一。
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

function createDummyWorkflowTemplate(): string {
  initializeDb();
  const id = createId("template");
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Dummy', '', 'txt2img', 1, '{}', '{}', 'hash')`,
    [id]
  );
  return id;
}

function attachScriptMangaRunOwnership(projectId: string, pageId: string): string {
  initializeDb();
  const scriptId = createId("script");
  const revisionId = createId("revision");
  const planId = createId("plan");
  const runId = createId("run");
  runSql("INSERT INTO manga_scripts (id, project_id, title) VALUES (?, ?, 'Owned page test')", [scriptId, projectId]);
  runSql(
    `INSERT INTO script_revisions (id, script_id, revision, fountain_source, parsed_json, warnings_json)
     VALUES (?, ?, 1, '', '{}', '[]')`,
    [revisionId, scriptId]
  );
  runSql(
    `INSERT INTO script_manga_plans
       (id, project_id, script_id, script_revision_id, plan_version, planner_version,
        prompt_compiler_version, dialogue_policy, status, plan_json, validation_json)
     VALUES (?, ?, ?, ?, 2, 'test-planner', 'test-compiler', 'preserve', 'draft', '{}', '{"ok":true,"issues":[]}')`,
    [planId, projectId, scriptId, revisionId]
  );
  runSql(
    `INSERT INTO script_manga_runs
       (id, project_id, script_id, script_revision_id, plan_id, plan_version, planner_version,
        prompt_compiler_version, status, phase, approval_status, page_count, panel_count,
        config_json, generation_budget_json)
     VALUES (?, ?, ?, ?, ?, 2, 'test-planner', 'test-compiler', 'prepared', 'awaiting_approval',
             'pending', 1, 1, '{}', '{}')`,
    [runId, projectId, scriptId, revisionId, planId]
  );
  runSql(
    `INSERT INTO script_manga_run_pages (run_id, page_id, page_index, layout_template_id)
     VALUES (?, ?, 0, 'builtin:splash')`,
    [runId, pageId]
  );
  return runId;
}

function isConflict(error: unknown): boolean {
  return error instanceof HttpError && error.statusCode === 409;
}

test("updatePageLayout: rejects layout mutation for a script manga run-owned page", () => {
  initializeDb();
  const project = createProject({ name: "Owned layout", mode: "book" });
  assert.ok(project);
  const projectId = project!.id as string;
  const page = createPage(projectId, { layoutTemplateId: "builtin:splash" });
  assert.ok(page.layout);
  const runId = attachScriptMangaRunOwnership(projectId, page.id);

  assert.throws(() => updatePageLayout(projectId, page.id, { layout: page.layout }), isConflict);
  assert.ok(getRow("SELECT page_id FROM script_manga_run_pages WHERE run_id = ?", [runId]));
  assert.ok(getRow("SELECT id FROM pages WHERE id = ?", [page.id]));
});

test("deletePage: rejects deletion of a script manga run-owned page", () => {
  initializeDb();
  const project = createProject({ name: "Owned delete", mode: "book" });
  assert.ok(project);
  const projectId = project!.id as string;
  const page = createPage(projectId, { layoutTemplateId: "builtin:splash" });
  const runId = attachScriptMangaRunOwnership(projectId, page.id);

  assert.throws(() => deletePage(projectId, page.id), isConflict);
  assert.ok(getRow("SELECT page_id FROM script_manga_run_pages WHERE run_id = ?", [runId]));
  assert.ok(getRow("SELECT id FROM pages WHERE id = ?", [page.id]));
});

// S1 レビュー指摘1(critical, Docs/Feature-ScriptToManga.md S1): provider_id='manual' の Round
// (ソースアセットのアップロード)を含むページの削除が、以前は stopRoundMonitor 内の
// getProvider('manual') が HttpError(400) を投げることで deleteRoundTree の ROLLBACK を招き、
// ページ削除全体が失敗していた(ページ半壊のリスクあり)。findProvider ベースへ修正した後の回帰テスト。
test("deletePage: succeeds for a page whose round tree includes a manual (uploaded) source asset round", async () => {
  const templateId = createDummyWorkflowTemplate();
  const project = createProject({ name: "S1 regression", mode: "book" });
  assert.ok(project);
  const page = createPage(project!.id as string, undefined);

  const { round, asset } = await createSourceAsset(project!.id as string, {
    templateId,
    pageId: page.id,
    dataUrl: TINY_PNG_DATA_URL,
    filename: "source.png"
  });
  assert.equal(round?.providerId, "manual");
  assert.ok(asset);

  const result = deletePage(project!.id as string, page.id);
  assert.deepEqual(result, { deleted: true, pageId: page.id });
  assert.equal(getRow("SELECT id FROM pages WHERE id = ?", [page.id]), null);
  assert.equal(getRow("SELECT id FROM generation_rounds WHERE id = ?", [round!.id as string]), null);
});
