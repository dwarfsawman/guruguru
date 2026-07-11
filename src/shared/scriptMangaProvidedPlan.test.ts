import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "./fountain.ts";
import { validateProvidedScriptMangaPlan } from "./scriptMangaProvidedPlan.ts";

const doc = parseFountain(`Title: Test\n\nINT. ROOM - DAY\n\n@Alice\nHello.\n\n@Bob\nHi.`).doc;

function plan(indexes: number[][] = [[0], [1]]) {
  return {
    title: "Directed",
    pages: [{
      index: 0,
      title: "Reveal",
      layoutTemplateId: "builtin:two-vertical",
      panels: indexes.map((dialogueOrderIndexes, index) => ({
        id: `p${index + 1}`,
        sceneIndex: 0,
        sceneHeading: "INT. ROOM - DAY",
        prompt: `panel ${index + 1}, no text`,
        sourceText: `source ${index + 1}`,
        dialogueOrderIndexes
      }))
    }]
  };
}

test("provided manga plan accepts complete dialogue coverage", () => {
  const result = validateProvidedScriptMangaPlan(doc, plan());
  assert.ok(result);
  assert.equal(result.panelCount, 2);
  assert.equal(result.dialogueCount, 2);
});

test("provided manga plan rejects duplicate or missing dialogue indexes", () => {
  assert.equal(validateProvidedScriptMangaPlan(doc, plan([[0], [0]])), null);
  assert.equal(validateProvidedScriptMangaPlan(doc, plan([[0], []])), null);
});

test("provided manga plan rejects a layout whose panel count differs", () => {
  const raw = plan();
  raw.pages[0]!.layoutTemplateId = "builtin:splash";
  assert.equal(validateProvidedScriptMangaPlan(doc, raw), null);
});

test("provided manga plan accepts one-based page numbers and injects matching character bible", () => {
  const raw = plan();
  raw.pages[0]!.index = 1;
  Object.assign(raw, { characterBible: { visualContinuity: "same costume", "アリス・キサラギ（現在）": { hair: "silver bob" } } });
  Object.assign(raw.pages[0]!.panels[0]!, { subject: "adult Alice" });
  const result = validateProvidedScriptMangaPlan(doc, raw);
  assert.ok(result);
  assert.equal(result.pages[0]!.index, 0);
  assert.match(result.pages[0]!.panels[0]!.prompt, /silver bob/);
});
