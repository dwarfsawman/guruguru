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
          angle: "eye-level",
          subjects: [{ ref: `subject ${index + 1}`, position: "middle-center", action: `action ${index + 1}`, expression: "focused" }],
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
      angle: "eye-level",
      subject: "subject 1",
      subjects: [{ ref: "subject 1", position: "middle-center", action: "action 1", expression: "focused" }],
      avoid: undefined,
      action: "action 1",
      emotion: "focused",
      composition: "composition 1"
    });
    assert.equal(directed[0]!.panels[0]!.prompt, "rendered panel 1");
  }
});

function directedRaw(sourcePages: ReturnType<typeof basePages>, layoutTemplateId: string) {
  return {
    pages: [{
      index: 0,
      layoutTemplateId,
      pageIntent: "Directed",
      panels: sourcePages[0]!.panels.map((panel, index) => ({
        id: panel.id,
        shot: "medium",
        angle: "eye-level",
        subjects: [{ ref: `subject ${index + 1}`, position: "middle-center", action: "act", expression: "calm" }],
        action: "act",
        emotion: "calm",
        composition: "clear",
        prompt: `panel ${index + 1}`
      }))
    }]
  };
}

test("director batch enforces hero×emphasized-slot alignment when an aligned candidate exists (ネームv4 D1)", () => {
  const sourcePages = basePages(3);
  sourcePages[0]!.panels[0]!.importance = "hero";
  sourcePages[0]!.panels[1]!.importance = "normal";
  sourcePages[0]!.panels[2]!.importance = "normal";
  // hero@読み順1 に対して均等3段は不整合 → reject。
  assert.equal(applyScriptMangaDirectorBatch(directedRaw(sourcePages, "builtin:three-horizontal"), sourcePages), null);
  // hero@読み順1 と整合する上段大ゴマは通る。importance は合成後も保持される。
  const directed = applyScriptMangaDirectorBatch(directedRaw(sourcePages, "builtin:three-hero-top"), sourcePages);
  assert.ok(directed);
  assert.equal(directed![0]!.layoutTemplateId, "builtin:three-hero-top");
  assert.deepEqual(directed![0]!.panels.map((panel) => panel.importance), ["hero", "normal", "normal"]);
});

test("director batch keeps grids allowed for all-normal pages and hero pages without an aligned candidate", () => {
  const allNormal = basePages(3);
  assert.ok(applyScriptMangaDirectorBatch(directedRaw(allNormal, "builtin:three-horizontal"), allNormal),
    "importance未設定(決定的N1フォールバック)では従来どおり通る");
  const unalignable = basePages(2);
  unalignable[0]!.panels[1]!.importance = "hero"; // 読み順2にheroを置ける2コマ候補は存在しない
  assert.ok(applyScriptMangaDirectorBatch(directedRaw(unalignable, "builtin:two-horizontal"), unalignable),
    "整合可能な候補がない構成では強制しない");
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
        angle: "eye-level",
        subjects: [{ ref: "subject", position: "middle-center", action: "action", expression: "focused" }],
        action: "action",
        emotion: "focused",
        composition: "balanced",
        prompt: "render"
      }))
    }]
  };
  assert.equal(applyScriptMangaDirectorBatch(raw, sourcePages), null);
});
