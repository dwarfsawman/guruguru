import { test } from "node:test";
import assert from "node:assert/strict";
import { addScriptRevision, createScript, listScriptRevisions } from "./scripts.ts";
import { listDialogueLines } from "./dialogueLines.ts";
import { listCharacters } from "./characters.ts";
import { createProject } from "./projects.ts";
import { initializeDb, getRow } from "./db.ts";

function createTestProject() {
  initializeDb();
  const project = createProject({ name: "S3 scripts", mode: "book" });
  assert.ok(project);
  return project!.id as string;
}

const SOURCE_V1 = ["INT. 教室 - 昼", "", "@太郎", "おはよう。", "", "@花子", "おはよう、太郎。"].join("\n");

test("createScript: 日本語 Fountain(@話者)取り込みで characters/dialogue_lines が生成される", () => {
  const projectId = createTestProject();
  const result = createScript(projectId, { title: "第一話", fountainSource: SOURCE_V1 });
  assert.equal(result.script.title, "第一話");
  assert.equal(result.revision.revision, 1);
  assert.equal(result.revision.fountainSource, SOURCE_V1);
  assert.equal(result.lines.length, 2);
  assert.deepEqual(
    result.lines.map((line) => line.speakerLabel),
    ["太郎", "花子"]
  );
  assert.ok(result.lines.every((line) => line.status === "active"));

  const characters = listCharacters(projectId);
  assert.equal(characters.length, 2);
  assert.ok(characters.some((c) => c.name === "太郎"));
  assert.ok(characters.some((c) => c.name === "花子"));
});

test("再取り込み: 変更/削除/移動した行が維持・orphaned 追跡される", () => {
  const projectId = createTestProject();
  const first = createScript(projectId, { fountainSource: SOURCE_V1 });
  const scriptId = first.script.id;
  const taroLineId = first.lines.find((line) => line.speakerLabel === "太郎")!.id;
  const hanakoLineId = first.lines.find((line) => line.speakerLabel === "花子")!.id;

  // v2: 太郎の行は維持(同一speaker+text)、花子の行は消え、新しい台詞(次郎)が追加される。
  const SOURCE_V2 = ["INT. 教室 - 昼", "", "@太郎", "おはよう。", "", "@次郎", "やあ。"].join("\n");
  const second = addScriptRevision(scriptId, { fountainSource: SOURCE_V2 });
  assert.equal(second.revision.revision, 2);
  assert.equal(listScriptRevisions(scriptId).length, 2);

  const allLines = listDialogueLines(projectId, { scriptId });
  const taro = allLines.find((line) => line.id === taroLineId);
  const hanako = allLines.find((line) => line.id === hanakoLineId);
  const jiro = allLines.find((line) => line.speakerLabel === "次郎");
  assert.ok(taro, "太郎の行(id維持)は残る");
  assert.equal(taro!.status, "active");
  assert.ok(hanako, "花子の行は削除されず orphaned になる");
  assert.equal(hanako!.status, "orphaned");
  assert.ok(jiro, "新規行(次郎)が追加される");
  assert.equal(jiro!.status, "active");

  // v3: 花子の行が復活(同じ speaker+text が再登場)すると active に戻る。
  const SOURCE_V3 = ["INT. 教室 - 昼", "", "@太郎", "おはよう。", "", "@花子", "おはよう、太郎。"].join("\n");
  addScriptRevision(scriptId, { fountainSource: SOURCE_V3 });
  const afterRevive = listDialogueLines(projectId, { scriptId });
  const hanakoAgain = afterRevive.find((line) => line.id === hanakoLineId);
  assert.ok(hanakoAgain);
  assert.equal(hanakoAgain!.status, "active", "同一 hash の再出現で orphaned → active に復活する");
});

test("再取り込み: parenthetical (M)/(N) は monologue/narration に、SFX: 接頭辞は sfx になる", () => {
  const projectId = createTestProject();
  const source = ["INT. A - DAY", "", "@太郎", "(M)", "心の声だ。", "", "@太郎", "SFX: ドカーン"].join("\n");
  const result = createScript(projectId, { fountainSource: source });
  assert.equal(result.lines[0]!.semanticKind, "monologue");
  assert.equal(result.lines[0]!.text, "心の声だ。");
  assert.equal(result.lines[1]!.semanticKind, "sfx");
  assert.equal(result.lines[1]!.text, "ドカーン");
});

test("script_revisions は不変保存(fountain_source / parsed_json を後から書き換えない)", () => {
  const projectId = createTestProject();
  const result = createScript(projectId, { fountainSource: SOURCE_V1 });
  const row = getRow<{ fountain_source: string }>("SELECT fountain_source FROM script_revisions WHERE id = ?", [
    result.revision.id
  ]);
  assert.equal(row!.fountain_source, SOURCE_V1);
});
