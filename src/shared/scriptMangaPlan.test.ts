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
});

test("planScriptManga selects a matching layout for the final partial page", () => {
  const { doc } = parseFountain(`INT. ROOM - DAY\n\nA.\n\nB.\n\nC.\n\nD.\n\nE.`);
  const plan = planScriptManga(doc, { panelsPerPage: 4, maxElementsPerPanel: 1 });
  assert.equal(plan.pages.length, 2);
  assert.equal(plan.pages[0]!.layoutTemplateId, "builtin:four-grid");
  assert.equal(plan.pages[1]!.layoutTemplateId, "builtin:splash");
});
