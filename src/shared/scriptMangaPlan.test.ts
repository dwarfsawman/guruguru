import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "./fountain.ts";
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

test("planScriptManga selects a matching layout for the final partial page", () => {
  const { doc } = parseFountain(`INT. ROOM - DAY\n\nA.\n\nB.\n\nC.\n\nD.\n\nE.`);
  const plan = planScriptManga(doc, { panelsPerPage: 4, maxElementsPerPanel: 1 });
  assert.equal(plan.pages.length, 2);
  assert.equal(plan.pages[0]!.layoutTemplateId, "builtin:four-grid");
  assert.equal(plan.pages[1]!.layoutTemplateId, "builtin:splash");
});

test("planScriptManga selects exact five and six panel layouts", () => {
  const { doc: fivePanelDoc } = parseFountain(`INT. ROOM - DAY\n\nA.\n\nB.\n\nC.\n\nD.\n\nE.`);
  const five = planScriptManga(fivePanelDoc, { panelsPerPage: 5, maxElementsPerPanel: 1 });
  assert.equal(five.pages.length, 1);
  assert.equal(five.pages[0]!.panels.length, 5);
  assert.equal(five.pages[0]!.layoutTemplateId, "builtin:five-panel");

  const { doc: sixPanelDoc } = parseFountain(`INT. ROOM - DAY\n\nA.\n\nB.\n\nC.\n\nD.\n\nE.\n\nF.`);
  const six = planScriptManga(sixPanelDoc, { panelsPerPage: 6, maxElementsPerPanel: 1 });
  assert.equal(six.pages.length, 1);
  assert.equal(six.pages[0]!.panels.length, 6);
  assert.equal(six.pages[0]!.layoutTemplateId, "builtin:six-panel");
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
