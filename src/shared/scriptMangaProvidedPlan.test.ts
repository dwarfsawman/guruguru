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

test("provided manga plan accepts one-based page numbers and injects a generic matching character bible entry", () => {
  const raw = plan();
  raw.pages[0]!.index = 1;
  Object.assign(raw, {
    characterBible: {
      visualContinuity: "same costume",
      "月城ルナ": { aliases: ["Captain Luna"], hair: "silver bob" }
    }
  });
  Object.assign(raw.pages[0]!.panels[0]!, { subject: "Captain Luna at the console" });
  const result = validateProvidedScriptMangaPlan(doc, raw);
  assert.ok(result);
  assert.equal(result.pages[0]!.index, 0);
  assert.match(result.pages[0]!.panels[0]!.prompt, /silver bob/);
});

test("provided manga plan accepts caller-resolved custom layouts", () => {
  const raw = plan();
  raw.pages[0]!.layoutTemplateId = "imported:conversation";
  assert.equal(validateProvidedScriptMangaPlan(doc, raw), null);
  const result = validateProvidedScriptMangaPlan(doc, raw, (id) => id === "imported:conversation" ? 2 : null);
  assert.ok(result);
  assert.equal(result.pages[0]!.layoutTemplateId, "imported:conversation");
});

test("provided manga plan preserves source ids, structured direction and page intent", () => {
  const raw = plan();
  Object.assign(raw.pages[0]!, { pageIntent: "Quiet reveal" });
  Object.assign(raw.pages[0]!.panels[0]!, {
    sourceElementIds: ["scene-0-element-0"],
    direction: {
      shot: "close-up",
      subject: "Alice",
      action: "looks toward Bob",
      emotion: "uncertain",
      composition: "Alice on the right"
    }
  });
  const result = validateProvidedScriptMangaPlan(doc, raw);
  assert.ok(result);
  assert.equal(result.pages[0]!.pageIntent, "Quiet reveal");
  assert.deepEqual(result.pages[0]!.panels[0]!.sourceElementIds, ["scene-0-element-0"]);
  assert.deepEqual(result.pages[0]!.panels[0]!.direction, {
    shot: "close-up",
    subject: "Alice",
    action: "looks toward Bob",
    emotion: "uncertain",
    composition: "Alice on the right"
  });
});

test("provided manga plan accepts the built-in five and six panel layouts", () => {
  const actionDoc = parseFountain(`INT. ROOM - DAY\n\nAction.`).doc;
  for (const [layoutTemplateId, panelCount] of [["builtin:five-panel", 5], ["builtin:six-panel", 6]] as const) {
    const raw = {
      title: "Dense page",
      pages: [{
        index: 0,
        title: "Dense",
        layoutTemplateId,
        panels: Array.from({ length: panelCount }, (_, index) => ({
          id: `p${index + 1}`,
          sceneIndex: 0,
          sceneHeading: "INT. ROOM - DAY",
          sourceElementIds: index === 0 ? ["scene-0-element-0"] : [],
          prompt: `panel ${index + 1}, no text`,
          sourceText: `source ${index + 1}`,
          dialogueOrderIndexes: []
        }))
      }]
    };
    const result = validateProvidedScriptMangaPlan(actionDoc, raw);
    assert.ok(result, layoutTemplateId);
    assert.equal(result.pages[0]!.panels.length, panelCount);
  }
});
