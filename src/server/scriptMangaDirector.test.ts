import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "../shared/fountain.ts";
import { planScriptManga } from "../shared/scriptMangaPlan.ts";
import { applyScriptMangaDirectorBatch } from "./scriptMangaDirector.ts";

function basePages(panelCount: number) {
  const actions = Array.from({ length: panelCount }, (_, index) => `Action ${index + 1}.`).join("\n\n");
  const doc = parseFountain(`INT. ROOM - DAY\n\n${actions}`).doc;
  return planScriptManga(doc, { panelsPerPage: panelCount, maxElementsPerPanel: 1 }).pages;
}

function directedRaw(sourcePages: ReturnType<typeof basePages>, extras: Record<string, unknown> = {}) {
  return {
    pages: [{
      index: 0,
      pageIntent: "Directed",
      ...extras,
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
}

test("director batch preserves structured direction and page intent for five and six panel pages", () => {
  for (const panelCount of [5, 6]) {
    const sourcePages = basePages(panelCount);
    const sourceIds = sourcePages[0]!.panels.map((panel) => panel.sourceElementIds);
    const directed = applyScriptMangaDirectorBatch(directedRaw(sourcePages), sourcePages, "test style");
    assert.ok(directed);
    assert.equal(directed![0]!.layoutTemplateId, sourcePages[0]!.layoutTemplateId, "レイアウトはsourceのまま");
    assert.equal(directed![0]!.pageIntent, "Directed");
    assert.deepEqual(directed![0]!.panels.map((panel) => panel.sourceElementIds), sourceIds);
    assert.deepEqual(directed![0]!.panels[0]!.direction, {
      shot: "wide",
      angle: "eye-level",
      subject: "subject 1",
      subjects: [{ ref: "subject 1", position: "middle-center", action: "action 1", expression: "focused" }],
      avoid: undefined,
      action: "action 1",
      emotion: "focused",
      composition: "composition 1"
    });
    assert.equal(directed![0]!.panels[0]!.prompt, "rendered panel 1");
  }
});

test("V5 X3: 監督はレイアウトを変更できない — 出力にlayoutTemplateIdがあっても無視されsourceが保たれる", () => {
  const sourcePages = basePages(3);
  sourcePages[0]!.panels[0]!.visualScale = "large";
  const originalLayout = sourcePages[0]!.layoutTemplateId;
  // 監督schemaにlayoutは無い。悪意/旧形式のlayoutTemplateIdが混ざってもsourceのまま。
  const directed = applyScriptMangaDirectorBatch(
    directedRaw(sourcePages, { layoutTemplateId: "builtin:three-horizontal" }),
    sourcePages
  );
  assert.ok(directed);
  assert.equal(directed![0]!.layoutTemplateId, originalLayout);
  assert.deepEqual(directed![0]!.panels.map((panel) => panel.visualScale), ["large", undefined, undefined],
    "visualScaleは監督合成後も保持される");
});

test("director batch rejects panel-count mismatch and preserves batch-level page identity", () => {
  const sourcePages = basePages(3);
  const short = directedRaw(sourcePages);
  short.pages[0]!.panels = short.pages[0]!.panels.slice(0, 2);
  assert.equal(applyScriptMangaDirectorBatch(short, sourcePages), null, "コマ数不一致はreject");
  const wrongIndex = directedRaw(sourcePages);
  (wrongIndex.pages[0] as { index: number }).index = 1;
  assert.equal(applyScriptMangaDirectorBatch(wrongIndex, sourcePages), null, "page indexの不一致はreject");
});
