import { test } from "node:test";
import assert from "node:assert/strict";
import { getChronicle } from "./chronicle.ts";
import { createScript } from "./scripts.ts";
import { createDialoguePlacement } from "./dialogueLines.ts";
import { createPage } from "./pages.ts";
import { createProject } from "./projects.ts";
import { initializeDb } from "./db.ts";
import { HttpError } from "./http.ts";

function createTestProject() {
  initializeDb();
  const project = createProject({ name: "S5 chronicle", mode: "book" });
  assert.ok(project);
  return project!.id as string;
}

const SOURCE = ["INT. 教室 - 昼", "", "@太郎", "おはよう。", "", "@花子", "おはよう、太郎。"].join("\n");

test("getChronicle: 脚本が無いプロジェクトは 404", () => {
  const projectId = createTestProject();
  assert.throws(() => getChronicle(projectId, undefined), HttpError);
});

test("getChronicle: 存在しないプロジェクトは 404", () => {
  assert.throws(() => getChronicle("project_missing", undefined), HttpError);
});

test("getChronicle: scriptId 省略時は最初の脚本を使う", () => {
  const projectId = createTestProject();
  const first = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const result = getChronicle(projectId, undefined);
  assert.equal(result.scriptId, first.script.id);
});

test("getChronicle: 取り込み済み脚本はセリフ順と一致する beats/lines を返す", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const result = getChronicle(projectId, script.script.id);

  assert.equal(result.revisionId, script.revision.id);
  assert.equal(result.lines.length, 2);
  assert.deepEqual(
    result.lines.map((line) => line.lineId),
    script.lines.map((line) => line.id)
  );
  // 同一シーン・連続 dialogue なので1つの Beat にまとまる。
  assert.equal(result.beats.length, 1);
  assert.deepEqual(result.beats[0]!.lineIds, script.lines.map((line) => line.id));
});

test("getChronicle: placement 状態が lines/pages に反映される", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const page = createPage(projectId);
  const taroLine = script.lines.find((line) => line.speakerLabel === "太郎")!;
  createDialoguePlacement(taroLine.id, { pageId: page.id });

  const result = getChronicle(projectId, script.script.id);
  const taroSummary = result.lines.find((line) => line.lineId === taroLine.id)!;
  assert.equal(taroSummary.placements.length, 1);
  assert.equal(taroSummary.placements[0]!.pageId, page.id);
  assert.ok(taroSummary.placements[0]!.balloonObjectId);

  const hanakoLine = script.lines.find((line) => line.speakerLabel === "花子")!;
  const hanakoSummary = result.lines.find((line) => line.lineId === hanakoLine.id)!;
  assert.equal(hanakoSummary.placements.length, 0);

  const pageSummary = result.pages.find((item) => item.pageId === page.id)!;
  assert.deepEqual(pageSummary.lineIds, [taroLine.id]);
});

test("getChronicle: 存在しない scriptId は 404", () => {
  const projectId = createTestProject();
  createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  assert.throws(() => getChronicle(projectId, "script_missing"), HttpError);
});
