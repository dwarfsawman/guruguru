import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateDialoguePages, removeDialogueAllocation } from "./dialogueAllocation.ts";
import { createScript } from "./scripts.ts";
import { createDialoguePlacement } from "./dialogueLines.ts";
import { createPage, deletePage } from "./pages.ts";
import { createProject } from "./projects.ts";
import { initializeDb, getRows } from "./db.ts";
import { HttpError } from "./http.ts";

function createTestProject() {
  initializeDb();
  const project = createProject({ name: "S5 chronicle allocation", mode: "book" });
  assert.ok(project);
  return project!.id as string;
}

const SOURCE = ["INT. 教室 - 昼", "", "@太郎", "おはよう。", "", "@花子", "おはよう、太郎。"].join("\n");

function placementsForLine(lineId: string) {
  return getRows<{ id: string; page_id: string; balloon_object_id: string | null }>(
    "SELECT id, page_id, balloon_object_id FROM dialogue_placements WHERE line_id = ?",
    [lineId]
  );
}

test("allocateDialoguePages: 一括割り当て(作成数)", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const page = createPage(projectId);
  const lineIds = script.lines.map((line) => line.id);

  const result = allocateDialoguePages(projectId, page.id, { lineIds });
  assert.equal(result.created, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.moved, 0);
  assert.deepEqual(result.warnings, []);

  for (const lineId of lineIds) {
    const placements = placementsForLine(lineId);
    assert.equal(placements.length, 1);
    assert.equal(placements[0]!.page_id, page.id);
    assert.equal(placements[0]!.balloon_object_id, null);
  }
});

test("allocateDialoguePages: 冪等(繰り返しても placement は増えない)", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const page = createPage(projectId);
  const lineIds = script.lines.map((line) => line.id);

  allocateDialoguePages(projectId, page.id, { lineIds });
  const second = allocateDialoguePages(projectId, page.id, { lineIds });
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 2);

  for (const lineId of lineIds) {
    assert.equal(placementsForLine(lineId).length, 1);
  }
});

test("allocateDialoguePages: policy skip(既定)は他ページ配置済みを動かさない", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const pageA = createPage(projectId);
  const pageB = createPage(projectId);
  const taroLine = script.lines.find((line) => line.speakerLabel === "太郎")!;

  allocateDialoguePages(projectId, pageA.id, { lineIds: [taroLine.id] });
  const result = allocateDialoguePages(projectId, pageB.id, { lineIds: [taroLine.id] });

  assert.equal(result.created, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.warnings.length, 1);

  const placements = placementsForLine(taroLine.id);
  assert.equal(placements.length, 1);
  assert.equal(placements[0]!.page_id, pageA.id);
});

test("allocateDialoguePages: policy copy は複数ページ配置を許可する", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const pageA = createPage(projectId);
  const pageB = createPage(projectId);
  const taroLine = script.lines.find((line) => line.speakerLabel === "太郎")!;

  allocateDialoguePages(projectId, pageA.id, { lineIds: [taroLine.id] });
  const result = allocateDialoguePages(projectId, pageB.id, { lineIds: [taroLine.id], existingPlacementPolicy: "copy" });

  assert.equal(result.created, 1);
  assert.equal(result.skipped, 0);

  const placements = placementsForLine(taroLine.id);
  assert.equal(placements.length, 2);
  const pageIds = placements.map((row) => row.page_id).sort();
  assert.deepEqual(pageIds, [pageA.id, pageB.id].sort());

  // copy は冪等: 同じページへ再実行しても増えない。
  const again = allocateDialoguePages(projectId, pageB.id, { lineIds: [taroLine.id], existingPlacementPolicy: "copy" });
  assert.equal(again.created, 0);
  assert.equal(again.skipped, 1);
  assert.equal(placementsForLine(taroLine.id).length, 2);
});

test("allocateDialoguePages: policy move は既存placementを当該ページへ移動する", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const pageA = createPage(projectId);
  const pageB = createPage(projectId);
  const taroLine = script.lines.find((line) => line.speakerLabel === "太郎")!;

  allocateDialoguePages(projectId, pageA.id, { lineIds: [taroLine.id] });
  const result = allocateDialoguePages(projectId, pageB.id, { lineIds: [taroLine.id], existingPlacementPolicy: "move" });

  assert.equal(result.moved, 1);
  assert.equal(result.created, 0);
  assert.equal(result.warnings.length, 0);

  const placements = placementsForLine(taroLine.id);
  assert.equal(placements.length, 1);
  assert.equal(placements[0]!.page_id, pageB.id);
});

test("allocateDialoguePages: policy move は吹き出し化済み placement を移動しない(警告)", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const pageA = createPage(projectId);
  const pageB = createPage(projectId);
  const taroLine = script.lines.find((line) => line.speakerLabel === "太郎")!;

  // createDialoguePlacement は吹き出し(balloon_object_id)付きで作成する(既存の個別配置 API)。
  createDialoguePlacement(taroLine.id, { pageId: pageA.id });
  const result = allocateDialoguePages(projectId, pageB.id, { lineIds: [taroLine.id], existingPlacementPolicy: "move" });

  assert.equal(result.moved, 0);
  assert.equal(result.created, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.warnings.length, 1);

  const placements = placementsForLine(taroLine.id);
  assert.equal(placements.length, 1);
  assert.equal(placements[0]!.page_id, pageA.id);
  assert.ok(placements[0]!.balloon_object_id);
});

test("allocateDialoguePages: 不正な lineId は 404", () => {
  const projectId = createTestProject();
  createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const page = createPage(projectId);
  assert.throws(() => allocateDialoguePages(projectId, page.id, { lineIds: ["line_missing"] }), HttpError);
});

test("allocateDialoguePages: 不正な pageId は 404", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  assert.throws(
    () => allocateDialoguePages(projectId, "page_missing", { lineIds: [script.lines[0]!.id] }),
    HttpError
  );
});

test("allocateDialoguePages: lineIds が空配列/非配列は 400", () => {
  const projectId = createTestProject();
  createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const page = createPage(projectId);
  assert.throws(() => allocateDialoguePages(projectId, page.id, { lineIds: [] }), HttpError);
  assert.throws(() => allocateDialoguePages(projectId, page.id, { lineIds: "not-an-array" }), HttpError);
});

test("removeDialogueAllocation: 選択行の placement を一括解除する", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const page = createPage(projectId);
  const lineIds = script.lines.map((line) => line.id);
  allocateDialoguePages(projectId, page.id, { lineIds });

  const result = removeDialogueAllocation(projectId, page.id, { lineIds });
  assert.equal(result.removed, 2);
  assert.equal(result.skipped, 0);

  for (const lineId of lineIds) {
    assert.equal(placementsForLine(lineId).length, 0);
  }
});

test("removeDialogueAllocation: 吹き出し化済み placement は解除しない(警告)", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const page = createPage(projectId);
  const taroLine = script.lines.find((line) => line.speakerLabel === "太郎")!;
  createDialoguePlacement(taroLine.id, { pageId: page.id });

  const result = removeDialogueAllocation(projectId, page.id, { lineIds: [taroLine.id] });
  assert.equal(result.removed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.warnings.length, 1);
  assert.equal(placementsForLine(taroLine.id).length, 1);
});

test("removeDialogueAllocation: 元々未配置の行は冪等に無視する", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const page = createPage(projectId);
  const taroLine = script.lines.find((line) => line.speakerLabel === "太郎")!;

  const result = removeDialogueAllocation(projectId, page.id, { lineIds: [taroLine.id] });
  assert.equal(result.removed, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.warnings.length, 0);
});

test("ページ削除時に dialogue_placements が残らない(FK CASCADE)", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const page = createPage(projectId);
  const lineIds = script.lines.map((line) => line.id);
  allocateDialoguePages(projectId, page.id, { lineIds });

  deletePage(projectId, page.id);

  for (const lineId of lineIds) {
    assert.equal(placementsForLine(lineId).length, 0);
  }
});
