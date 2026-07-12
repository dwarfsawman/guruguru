import test from "node:test";
import assert from "node:assert/strict";
import { parseFountain } from "../shared/fountain.ts";
import { planScriptManga } from "../shared/scriptMangaPlan.ts";
import { applyPageNaming } from "./scriptMangaPageNaming.ts";

test("N1 validator preserves source order/coverage while allowing hero regrouping", () => {
  const base = planScriptManga(parseFountain("INT. A - DAY\n\nOne.\n\n@A\nHello.\n\nTwo.").doc, { maxElementsPerPanel: 1, panelsPerPage: 2 });
  const ids = base.pages.flatMap((page) => page.panels.map((panel) => panel.id));
  const result = applyPageNaming({ pages: [{ index: 0, pageIntent: "Build then reveal", turnHook: "reveal", panels: [
    { id: "n1-hero", importance: "hero", sourcePanelIds: ids }
  ] }] }, base, 1);
  assert.ok(result);
  assert.deepEqual(result!.pages[0]!.panels[0]!.sourceElementIds, base.pages.flatMap((page) => page.panels.flatMap((panel) => panel.sourceElementIds)));
});

test("N1 validator rejects reorder, duplicate coverage and scene-crossing panels", () => {
  const base = planScriptManga(parseFountain("INT. A - DAY\n\nOne.\n\nINT. B - NIGHT\n\nTwo.").doc, { maxElementsPerPanel: 1 });
  const ids = base.pages.flatMap((page) => page.panels.map((panel) => panel.id));
  assert.equal(applyPageNaming({ pages: [{ index: 0, pageIntent: "bad", turnHook: "none", panels: [
    { id: "bad", importance: "normal", sourcePanelIds: [...ids].reverse() }
  ] }] }, base, 1), null);
});
