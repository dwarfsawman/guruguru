import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "../shared/fountain.ts";
import { scriptMangaLayoutCandidates } from "../shared/layoutPresets.ts";
import { planScriptManga } from "../shared/scriptMangaPlan.ts";
import { applyScriptMangaDirectorBatch } from "./scriptMangaDirector.ts";

function basePages(panelCount: number) {
  const actions = Array.from({ length: panelCount }, (_, index) => `Action ${index + 1}.`).join("\n\n");
  const doc = parseFountain(`INT. ROOM - DAY\n\n${actions}`).doc;
  return planScriptManga(doc, { panelsPerPage: panelCount, maxElementsPerPanel: 1 }).pages;
}

test("director batch preserves structured direction and page intent for five and six panel pages", () => {
  for (const panelCount of [5, 6]) {
    const sourcePages = basePages(panelCount);
    const sourceIds = sourcePages[0]!.panels.map((panel) => panel.sourceElementIds);
    const layoutTemplateId = scriptMangaLayoutCandidates(panelCount)[0]!;
    const raw = {
      pages: [{
        index: 0,
        layoutTemplateId,
        pageIntent: `Intent for ${panelCount}`,
        panels: sourcePages[0]!.panels.map((panel, index) => ({
          id: panel.id,
          shot: index === 0 ? "wide" : "medium",
          subject: `subject ${index + 1}`,
          action: `action ${index + 1}`,
          emotion: "focused",
          composition: `composition ${index + 1}`,
          prompt: `rendered panel ${index + 1}`
        }))
      }]
    };

    const directed = applyScriptMangaDirectorBatch(raw, sourcePages, "test style");
    assert.ok(directed);
    assert.equal(directed[0]!.layoutTemplateId, layoutTemplateId);
    assert.equal(directed[0]!.pageIntent, `Intent for ${panelCount}`);
    assert.deepEqual(directed[0]!.panels.map((panel) => panel.sourceElementIds), sourceIds);
    assert.deepEqual(directed[0]!.panels[0]!.direction, {
      shot: "wide",
      subject: "subject 1",
      action: "action 1",
      emotion: "focused",
      composition: "composition 1"
    });
    assert.match(directed[0]!.panels[0]!.prompt, /^test style\. rendered panel 1\./);
  }
});

test("director batch rejects a layout with a different panel count", () => {
  const sourcePages = basePages(5);
  const raw = {
    pages: [{
      index: 0,
      layoutTemplateId: "builtin:four-grid",
      pageIntent: "Invalid",
      panels: sourcePages[0]!.panels.map((panel) => ({
        id: panel.id,
        shot: "wide",
        subject: "subject",
        action: "action",
        emotion: "focused",
        composition: "balanced",
        prompt: "render"
      }))
    }]
  };
  assert.equal(applyScriptMangaDirectorBatch(raw, sourcePages), null);
});
