import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDialogueLayout, previewDialogueLayout } from "./dialogueAutoLayoutApi.ts";
import { allocateDialoguePages } from "./dialogueAllocation.ts";
import { createDialoguePlacement } from "./dialogueLines.ts";
import { createScript } from "./scripts.ts";
import { createPage, updatePageLayout } from "./pages.ts";
import { createProject } from "./projects.ts";
import { initializeDb, getRow, getRows, runSql } from "./db.ts";
import { HttpError } from "./http.ts";
import type { PageLayout } from "../shared/pageLayout.ts";
import type { PageObject } from "../shared/pageObjects.ts";

function createTestProject() {
  initializeDb();
  const project = createProject({ name: "S5 chronicle auto layout", mode: "book" });
  assert.ok(project);
  return project!.id as string;
}

const TWO_PANEL_LAYOUT: PageLayout = {
  version: 1,
  page: { aspectRatio: [1, 1.4142], height: 1.4142 },
  readingDirection: "rtl",
  panels: [
    { id: "panel_left", order: 1, shape: { type: "rect", bounds: [0, 0, 0.48, 1.4142] } },
    { id: "panel_right", order: 2, shape: { type: "rect", bounds: [0.52, 0, 1, 1.4142] } }
  ]
};

const SOURCE = ["INT. 教室 - 昼", "", "@太郎", "おはよう。", "", "@花子", "おはよう、太郎。元気そうだね。"].join("\n");

function setup() {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: TWO_PANEL_LAYOUT });
  const lineIds = script.lines.map((line) => line.id);
  allocateDialoguePages(projectId, page.id, { lineIds });
  const placementRows = getRows<{ id: string; line_id: string }>(
    "SELECT id, line_id FROM dialogue_placements WHERE page_id = ?",
    [page.id]
  );
  return { projectId, pageId: page.id, script, placementRows };
}

function pageObjectsJson(pageId: string): PageObject[] {
  const row = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  return row?.objects_json ? (JSON.parse(row.objects_json) as PageObject[]) : [];
}

test("previewDialogueLayout: DB を書き換えない(before/after 同一)", () => {
  const { projectId, pageId, placementRows } = setup();
  const before = getRow<{ objects_json: string | null; updated_at: string }>("SELECT objects_json, updated_at FROM pages WHERE id = ?", [
    pageId
  ]);
  const placementsBefore = getRows("SELECT * FROM dialogue_placements WHERE page_id = ?", [pageId]);

  const preview = previewDialogueLayout(projectId, pageId, { placementIds: placementRows.map((row) => row.id), seed: 123 });
  assert.equal(preview.seed, 123);
  assert.ok(preview.objects.length > 0);

  const after = getRow<{ objects_json: string | null; updated_at: string }>("SELECT objects_json, updated_at FROM pages WHERE id = ?", [
    pageId
  ]);
  assert.deepEqual(after, before);
  const placementsAfter = getRows("SELECT * FROM dialogue_placements WHERE page_id = ?", [pageId]);
  assert.deepEqual(placementsAfter, placementsBefore);
});

test("previewDialogueLayout: seed 省略時も決定的な値を返す(同一呼び出しは同じ seed)", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  const a = previewDialogueLayout(projectId, pageId, { placementIds: ids });
  const b = previewDialogueLayout(projectId, pageId, { placementIds: ids });
  assert.equal(a.seed, b.seed);
});

test("applyDialogueLayout: 成功時に objects_json と placement 列を更新する", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  const result = applyDialogueLayout(projectId, pageId, { placementIds: ids, seed: 7 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  assert.equal(result.objects.length, ids.length);

  const objects = pageObjectsJson(pageId);
  assert.equal(objects.length, ids.length);
  for (const object of objects) {
    assert.equal(object.kind, "balloon");
    assert.ok(object.sourceDialogueLineId);
  }

  const placements = getRows<{ id: string; balloon_object_id: string | null; panel_id: string | null; auto_layout_seed: number | null; auto_layout_version: number | null }>(
    "SELECT id, balloon_object_id, panel_id, auto_layout_seed, auto_layout_version FROM dialogue_placements WHERE id IN (" +
      ids.map(() => "?").join(",") +
      ")",
    ids
  );
  for (const placement of placements) {
    assert.ok(placement.balloon_object_id);
    assert.equal(placement.auto_layout_seed, 7);
    assert.equal(placement.auto_layout_version, 1);
    // sourceDialogueLineId ⇄ balloon_object_id の双方向リンク。
    const object = objects.find((o) => o.id === placement.balloon_object_id);
    assert.ok(object);
  }
});

test("applyDialogueLayout: unplaced が混在すると 422 で全件ロールバックする(部分確定しない)", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  // 巨大サイズを要求させるため、極端に長い行を追加して1件だけ unplaced になるよう仕向ける代わりに、
  // レイアウトを1コマだけの極小コマへ差し替えて必ず配置不能を発生させる。
  const tinyLayout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1.4142], height: 1.4142 },
    readingDirection: "rtl",
    panels: [{ id: "panel_tiny", order: 1, shape: { type: "rect", bounds: [0, 0, 0.02, 0.02] } }]
  };
  updatePageLayout(projectId, pageId, { layout: tinyLayout });

  const before = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  const placementsBefore = getRows("SELECT * FROM dialogue_placements WHERE page_id = ?", [pageId]);

  assert.throws(() => applyDialogueLayout(projectId, pageId, { placementIds: ids, seed: 1 }), HttpError);

  const after = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  assert.deepEqual(after, before);
  const placementsAfter = getRows("SELECT * FROM dialogue_placements WHERE page_id = ?", [pageId]);
  assert.deepEqual(placementsAfter, placementsBefore);
});

test("applyDialogueLayout: PAGE_OBJECTS_MAX_COUNT 超過は拒否する", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  const filler: PageObject[] = Array.from({ length: 299 }, (_, i) => ({
    id: `filler_${i}`,
    kind: "box",
    position: { x: 0.1, y: 0.1 },
    rotation: 0,
    size: { x: 0.01, y: 0.01 },
    fill: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 0.004
  }));
  runSql("UPDATE pages SET objects_json = ? WHERE id = ?", [JSON.stringify(filler), pageId]);

  assert.throws(() => applyDialogueLayout(projectId, pageId, { placementIds: ids, seed: 1 }), HttpError);
});

test("applyDialogueLayout: 既に吹き出し化済みの placement を対象にすると拒否する", () => {
  const { projectId, pageId, script } = setup();
  const taroLine = script.lines.find((line) => line.speakerLabel === "太郎")!;
  const created = createDialoguePlacement(taroLine.id, { pageId });
  assert.throws(() => applyDialogueLayout(projectId, pageId, { placementIds: [created.placement.id], seed: 1 }), HttpError);
});

// --- 回帰テスト: サイズバリアントで従来 unplaced だった長めの行が配置できる(問題2) ---

const FOUR_GRID_LAYOUT: PageLayout = {
  version: 1,
  page: { aspectRatio: [182, 257], height: 257 / 182 },
  readingDirection: "rtl",
  panels: [
    { id: "r1c2", order: 1, shape: { type: "rect", bounds: [0.51, 0.04, 0.96, 0.696044] } },
    { id: "r1c1", order: 2, shape: { type: "rect", bounds: [0.04, 0.04, 0.49, 0.696044] } },
    { id: "r2c2", order: 3, shape: { type: "rect", bounds: [0.51, 0.716044, 0.96, 1.372088] } },
    { id: "r2c1", order: 4, shape: { type: "rect", bounds: [0.04, 0.716044, 0.49, 1.372088] } }
  ]
};

const LONG_DIALOGUE_SOURCE = [
  "INT. 教室 - 昼",
  "",
  "@ソラ",
  "(M)",
  "……寒い。まだ着いたはずがない。どうして私だけ起こされた?",
  "",
  "@アマネ",
  "おはようございます、ソラ。緊急事態です。起こしてしまってごめんなさい。",
  "",
  "@ソラ",
  "アマネ? 船のAIが謝るなんて、プログラムにあったかしら。"
].join("\n");

test("previewDialogueLayout: four-grid の四半ページに26〜35字の会話が『コマに対して文字量が多すぎる』で誤って弾かれない(回帰)", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "回帰テスト", fountainSource: LONG_DIALOGUE_SOURCE });
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: FOUR_GRID_LAYOUT });
  const lineIds = script.lines.map((line) => line.id);
  allocateDialoguePages(projectId, page.id, { lineIds });
  const placementRows = getRows<{ id: string }>("SELECT id FROM dialogue_placements WHERE page_id = ?", [page.id]);

  const preview = previewDialogueLayout(projectId, page.id, { placementIds: placementRows.map((row) => row.id), seed: 1234 });

  // 修正前は「コマに対して文字量が多すぎる」判定で全滅していた3行構成。修正後は全て配置できる
  // (このレイアウト・行数では各行が別コマへ収まる)。
  assert.equal(preview.unplacedPlacementIds.length, 0, JSON.stringify(preview.warnings));
  assert.equal(preview.objects.length, placementRows.length);
  for (const warning of preview.warnings) {
    assert.ok(!warning.includes("文字量が多すぎる"), `unexpected size-rejection warning: ${warning}`);
  }
});

test("previewDialogueLayout: six-panel で26字程度のセリフが配置できる(受け入れ基準)", () => {
  const sixPanelLayout: PageLayout = {
    version: 1,
    page: { aspectRatio: [182, 257], height: 257 / 182 },
    readingDirection: "rtl",
    panels: [
      { id: "r1c2", order: 1, shape: { type: "rect", bounds: [0.51, 0.04, 0.96, 0.45] } },
      { id: "r1c1", order: 2, shape: { type: "rect", bounds: [0.04, 0.04, 0.49, 0.45] } },
      { id: "r2c2", order: 3, shape: { type: "rect", bounds: [0.51, 0.47, 0.96, 0.9] } },
      { id: "r2c1", order: 4, shape: { type: "rect", bounds: [0.04, 0.47, 0.49, 0.9] } },
      { id: "r3c2", order: 5, shape: { type: "rect", bounds: [0.51, 0.92, 0.96, 1.372088] } },
      { id: "r3c1", order: 6, shape: { type: "rect", bounds: [0.04, 0.92, 0.49, 1.372088] } }
    ]
  };
  const projectId = createTestProject();
  const source = ["INT. 教室 - 昼", "", "@太郎", "おはようございます、今日はいい天気ですね元気にしていますか。"].join("\n");
  const script = createScript(projectId, { title: "six-panel", fountainSource: source });
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: sixPanelLayout });
  allocateDialoguePages(projectId, page.id, { lineIds: script.lines.map((line) => line.id) });
  const placementRows = getRows<{ id: string }>("SELECT id FROM dialogue_placements WHERE page_id = ?", [page.id]);

  const preview = previewDialogueLayout(projectId, page.id, { placementIds: placementRows.map((row) => row.id), seed: 7 });
  assert.equal(preview.unplacedPlacementIds.length, 0, JSON.stringify(preview.warnings));
});
