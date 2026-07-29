import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "./fountain.ts";
import { findLayoutPreset } from "./layoutPresets.ts";
import { planScriptManga } from "./scriptMangaPlan.ts";

test("planScriptManga preserves every dialogue order and scene boundary", () => {
  const { doc } = parseFountain(`Title: Test\n\nINT. ROOM - DAY\n\nAction one.\n\n@Alice\nHello.\n\nAction two.\n\n@Bob\nHi.\n\nEXT. STREET - NIGHT\n\nAction three.\n\n@Alice\nRun!`);
  const plan = planScriptManga(doc, { panelsPerPage: 2, maxElementsPerPanel: 2, maxDialoguesPerPanel: 1 });
  const panels = plan.pages.flatMap((page) => page.panels);
  assert.equal(plan.dialogueCount, 3);
  assert.deepEqual(panels.flatMap((panel) => panel.dialogueOrderIndexes), [0, 1, 2]);
  assert.ok(panels.every((panel) => !panel.prompt.includes("speech bubbles" ) || panel.prompt.includes("no speech bubbles")));
  assert.ok(panels.every((panel) => !panel.sourceText.includes("Action three") || panel.sceneIndex === 1));
  assert.ok(panels.every((panel) => !panel.prompt.includes("Hello.") && !panel.prompt.includes("Hi.") && !panel.prompt.includes("Run!")));
  assert.ok(panels.some((panel) => panel.prompt.includes("speechAct=exclamation")));
  assert.deepEqual(panels.flatMap((panel) => panel.sourceElementIds), [
    "scene-0-element-0",
    "scene-0-element-1",
    "scene-0-element-2",
    "scene-0-element-3",
    "scene-1-element-0",
    "scene-1-element-1"
  ]);
});

test("planScriptManga defaults to at most three dialogue elements per panel", () => {
  const { doc } = parseFountain(`INT. ROOM - DAY

@Alice
One.

@Bob
Two.

@Alice
Three.

@Bob
Four.

@Alice
Five.`);
  const plan = planScriptManga(doc, { panelsPerPage: 4, maxElementsPerPanel: 8 });
  assert.deepEqual(
    plan.pages.flatMap((page) => page.panels.map((panel) => panel.dialogueOrderIndexes.length)),
    [3, 2]
  );
});

test("planScriptManga does not compress distinct action moments into one panel", () => {
  const { doc } = parseFountain(`INT. ROOM - DAY

Alice enters.

@Alice
First.

Alice leaves.

@Bob
Second.`);
  const plan = planScriptManga(doc, {
    panelsPerPage: 4,
    maxElementsPerPanel: 8,
    maxDialoguesPerPanel: 4
  });
  const panels = plan.pages.flatMap((page) => page.panels);
  assert.equal(panels.length, 2);
  assert.deepEqual(panels.map((panel) => panel.dialogueOrderIndexes), [[0], [1]]);
  assert.match(panels[0]!.sourceText, /Alice enters/);
  assert.doesNotMatch(panels[0]!.sourceText, /Alice leaves/);
  assert.match(panels[1]!.sourceText, /Alice leaves/);
});

/** 選ばれたレイアウトのコマ数が、ページのコマ数と一致することだけを固定する。 */
function assertLayoutMatchesPanelCount(layoutTemplateId: string, panelCount: number): void {
  const preset = findLayoutPreset(layoutTemplateId);
  assert.ok(preset, `unknown layout ${layoutTemplateId}`);
  assert.equal(preset!.layout.panels.length, panelCount, layoutTemplateId);
}

test("planScriptManga selects a matching layout for the final partial page", () => {
  const { doc } = parseFountain(`INT. ROOM - DAY\n\nA.\n\nB.\n\nC.\n\nD.\n\nE.`);
  const plan = planScriptManga(doc, { panelsPerPage: 4, maxElementsPerPanel: 1 });
  assert.equal(plan.pages.length, 2);
  assertLayoutMatchesPanelCount(plan.pages[0]!.layoutTemplateId, 4);
  assert.equal(plan.pages[1]!.layoutTemplateId, "builtin:splash");
});

test("planScriptManga selects exact five and six panel layouts", () => {
  const { doc: fivePanelDoc } = parseFountain(`INT. ROOM - DAY\n\nA.\n\nB.\n\nC.\n\nD.\n\nE.`);
  const five = planScriptManga(fivePanelDoc, { panelsPerPage: 5, maxElementsPerPanel: 1 });
  assert.equal(five.pages.length, 1);
  assert.equal(five.pages[0]!.panels.length, 5);
  assertLayoutMatchesPanelCount(five.pages[0]!.layoutTemplateId, 5);

  const { doc: sixPanelDoc } = parseFountain(`INT. ROOM - DAY\n\nA.\n\nB.\n\nC.\n\nD.\n\nE.\n\nF.`);
  const six = planScriptManga(sixPanelDoc, { panelsPerPage: 6, maxElementsPerPanel: 1 });
  assert.equal(six.pages.length, 1);
  assert.equal(six.pages[0]!.panels.length, 6);
  assertLayoutMatchesPanelCount(six.pages[0]!.layoutTemplateId, 6);
});

test("planScriptManga: 決定的パッカーでもページごとにレイアウトが散る(均一段組固定の回帰)", () => {
  // 台詞つきの実務的な脚本。かつては候補先頭固定で全ページ two/three-horizontal になった。
  const scenes = Array.from({ length: 8 }, (_, index) => [
    `INT. ROOM ${index + 1} - DAY`,
    "",
    `Someone opens the door of room ${index + 1}.`,
    "",
    "@RIN",
    "ここにいたんだ。",
    "",
    `Rin looks down at the floor of room ${index + 1}.`,
    "",
    "@AOI",
    "ずっと待ってた。",
    "",
    `A dropped notebook lies open in room ${index + 1}.`
  ].join("\n")).join("\n\n");
  const plan = planScriptManga(parseFountain(scenes).doc, { panelsPerPage: 3, maxElementsPerPanel: 2 });
  const used = new Set(plan.pages.map((page) => page.layoutTemplateId));
  assert.ok(plan.pages.length >= 6, `pages=${plan.pages.length}`);
  // 完全に同構造のページが続く極端な入力でも、反復ペナルティで連続ページは別レイアウトになる。
  assert.ok(used.size >= 2, `使用レイアウト: ${[...used].join(", ")}`);
  for (const [index, page] of plan.pages.entries()) {
    assertLayoutMatchesPanelCount(page.layoutTemplateId, page.panels.length);
    if (index > 0) {
      assert.notEqual(page.layoutTemplateId, plan.pages[index - 1]!.layoutTemplateId, `page ${index}`);
    }
  }
});

test("planScriptManga: 内容が変化する脚本ではレイアウトが3種類以上に散る", () => {
  // コマ数・台詞量がページごとに変わる、実務に近い入力。
  const scenes = Array.from({ length: 10 }, (_, index) => {
    const lines = [`INT. PLACE ${index + 1} - DAY`, "", `A hand pushes open a heavy door in place ${index + 1}.`, ""];
    for (let turn = 0; turn <= index % 3; turn += 1) {
      lines.push("@RIN", "…".repeat(1) + `ここは違う。${"それでも探す。".repeat(turn)}`, "");
      lines.push(`Rin steps over a fallen chair in place ${index + 1}.`, "");
    }
    lines.push(`A single photograph lies face down in place ${index + 1}.`);
    return lines.join("\n");
  }).join("\n\n");
  const plan = planScriptManga(parseFountain(scenes).doc, { panelsPerPage: 4, maxElementsPerPanel: 2 });
  const used = new Set(plan.pages.map((page) => page.layoutTemplateId));
  assert.ok(used.size >= 3, `使用レイアウトが3種類以上: ${[...used].join(", ")}`);
  for (const page of plan.pages) assertLayoutMatchesPanelCount(page.layoutTemplateId, page.panels.length);
});

test("planScriptManga creates stable source element ids", () => {
  const { doc } = parseFountain(`INT. ROOM - DAY\n\nFirst action.\n\n@Rin\nWhere are you?`);
  const first = planScriptManga(doc, { maxElementsPerPanel: 1 });
  const second = planScriptManga(doc, { maxElementsPerPanel: 1 });
  assert.deepEqual(
    first.pages.flatMap((page) => page.panels.flatMap((panel) => panel.sourceElementIds)),
    second.pages.flatMap((page) => page.panels.flatMap((panel) => panel.sourceElementIds))
  );
});

test("planScriptManga uses targetPageCount as a best-effort deterministic page target", () => {
  const { doc } = parseFountain(`INT. ROOM - DAY\n\nA.\n\nB.\n\nC.\n\nD.\n\nE.\n\nF.`);
  const compact = planScriptManga(doc, { panelsPerPage: 4, maxElementsPerPanel: 1, targetPageCount: 1 });
  const paced = planScriptManga(doc, { panelsPerPage: 4, maxElementsPerPanel: 1, targetPageCount: 3 });
  const overTarget = planScriptManga(doc, { panelsPerPage: 4, maxElementsPerPanel: 1, targetPageCount: 100 });
  const automatic = planScriptManga(doc, { panelsPerPage: 4, maxElementsPerPanel: 1, targetPageCount: 0 });

  // 6 panels cannot fit on one page with a 4-panel ceiling, so the hard minimum wins.
  assert.equal(compact.pages.length, 2);
  assert.deepEqual(paced.pages.map((page) => page.panels.length), [2, 2, 2]);
  // Empty pages are never synthesized; one panel per page is the deterministic upper bound.
  assert.equal(overTarget.pages.length, 6);
  assert.equal(automatic.pages.length, 2, "targetPageCount 0 keeps automatic packing semantics");
  assert.deepEqual(
    paced.pages.flatMap((page) => page.panels.flatMap((panel) => panel.sourceElementIds)),
    compact.pages.flatMap((page) => page.panels.flatMap((panel) => panel.sourceElementIds))
  );
});
