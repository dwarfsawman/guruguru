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

test("N1 validator preserves importance/turnHook and pre-selects an aligned layout (ネームv4 D1)", () => {
  const base = planScriptManga(
    parseFountain("INT. A - DAY\n\nOne.\n\nTwo.\n\nThree.").doc,
    { maxElementsPerPanel: 1, panelsPerPage: 3 }
  );
  const ids = base.pages.flatMap((page) => page.panels.map((panel) => panel.id));
  assert.equal(ids.length, 3);
  const result = applyPageNaming({ pages: [{ index: 0, pageIntent: "hero top", turnHook: "cliffhanger", panels: [
    { id: "p1", importance: "hero", sourcePanelIds: [ids[0]!] },
    { id: "p2", importance: "normal", sourcePanelIds: [ids[1]!] },
    { id: "p3", importance: "normal", sourcePanelIds: [ids[2]!] }
  ] }] }, base, 1);
  assert.ok(result);
  assert.deepEqual(result!.pages[0]!.panels.map((panel) => panel.importance), ["hero", "normal", "normal"]);
  assert.equal(result!.pages[0]!.turnHook, "cliffhanger");
  assert.equal(result!.pages[0]!.layoutTemplateId, "builtin:three-hero-top");
});

test("N1 validator picks splash-bleed for splash pages and keeps the default grid for all-normal pages", () => {
  const base = planScriptManga(parseFountain("INT. A - DAY\n\nOne.\n\nTwo.").doc, { maxElementsPerPanel: 1, panelsPerPage: 2 });
  const ids = base.pages.flatMap((page) => page.panels.map((panel) => panel.id));
  const splash = applyPageNaming({ pages: [
    { index: 0, pageIntent: "impact", turnHook: "none", panels: [{ id: "s", importance: "splash", sourcePanelIds: [ids[0]!] }] },
    { index: 1, pageIntent: "cool down", turnHook: "none", panels: [{ id: "n", importance: "normal", sourcePanelIds: [ids[1]!] }] }
  ] }, base, 2);
  assert.ok(splash);
  assert.equal(splash!.pages[0]!.layoutTemplateId, "builtin:splash-bleed");
  assert.equal(splash!.pages[1]!.layoutTemplateId, "builtin:splash");
  const normals = applyPageNaming({ pages: [{ index: 0, pageIntent: "steady", turnHook: "none", panels: [
    { id: "a", importance: "normal", sourcePanelIds: [ids[0]!] },
    { id: "b", importance: "normal", sourcePanelIds: [ids[1]!] }
  ] }] }, base, 1);
  assert.ok(normals);
  assert.equal(normals!.pages[0]!.layoutTemplateId, "builtin:two-horizontal", "全normalは候補先頭(既定互換)");
});

test("N1 validator rejects reorder, duplicate coverage and scene-crossing panels", () => {
  const base = planScriptManga(parseFountain("INT. A - DAY\n\nOne.\n\nINT. B - NIGHT\n\nTwo.").doc, { maxElementsPerPanel: 1 });
  const ids = base.pages.flatMap((page) => page.panels.map((panel) => panel.id));
  assert.equal(applyPageNaming({ pages: [{ index: 0, pageIntent: "bad", turnHook: "none", panels: [
    { id: "bad", importance: "normal", sourcePanelIds: [...ids].reverse() }
  ] }] }, base, 1), null);
});
