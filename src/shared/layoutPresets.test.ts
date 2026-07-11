import assert from "node:assert/strict";
import test from "node:test";
import { builtinLayoutPanelCount, findLayoutPreset, scriptMangaLayoutCandidates } from "./layoutPresets.ts";

test("dramatic manga presets keep the advertised panel count and RTL order", () => {
  const cases = [
    ["builtin:three-hero-top", 3],
    ["builtin:three-side-hero", 3],
    ["builtin:three-hero-bottom", 3],
    ["builtin:four-hero-bottom", 4],
    ["builtin:four-vertical-hero", 4]
  ] as const;
  for (const [id, count] of cases) {
    const preset = findLayoutPreset(id);
    assert.ok(preset, id);
    assert.equal(preset.layout.readingDirection, "rtl");
    assert.equal(preset.layout.panels.length, count);
    assert.deepEqual(preset.layout.panels.map((panel) => panel.order), Array.from({ length: count }, (_, i) => i + 1));
  }
});

test("script manga layout candidates cover every panel count from one through six", () => {
  for (let panelCount = 1; panelCount <= 6; panelCount += 1) {
    const candidates = scriptMangaLayoutCandidates(panelCount);
    assert.ok(candidates.length > 0, `missing candidates for ${panelCount} panels`);
    for (const id of candidates) assert.equal(builtinLayoutPanelCount(id), panelCount, id);
  }
  assert.deepEqual(scriptMangaLayoutCandidates(5), ["builtin:five-panel"]);
  assert.deepEqual(scriptMangaLayoutCandidates(6), ["builtin:six-panel"]);
  assert.deepEqual(scriptMangaLayoutCandidates(0), []);
  assert.deepEqual(scriptMangaLayoutCandidates(7), []);
});

test("five-panel preset keeps five ordered panels inside the page", () => {
  const preset = findLayoutPreset("builtin:five-panel");
  assert.ok(preset);
  assert.deepEqual(preset.layout.panels.map((panel) => panel.order), [1, 2, 3, 4, 5]);
  for (const panel of preset.layout.panels) {
    assert.equal(panel.shape.type, "rect");
    if (panel.shape.type !== "rect") continue;
    const [x1, y1, x2, y2] = panel.shape.bounds;
    assert.ok(x1 >= 0 && y1 >= 0 && x2 <= 1 && y2 <= preset.layout.page.height);
    assert.ok(x2 > x1 && y2 > y1);
  }
});
