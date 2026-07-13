import assert from "node:assert/strict";
import test from "node:test";
import {
  LAYOUT_PRESETS,
  builtinLayoutPanelCount,
  describeScriptMangaLayouts,
  findLayoutPreset,
  scriptMangaLayoutCandidates
} from "./layoutPresets.ts";
import { PANEL_BLEED_OVERSHOOT, normalizeEditedPageLayout, panelBounds } from "./pageLayout.ts";

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

// --- 自由な構図プリセット(Docs/Feature-MangaCompositions.md) ---

test("scriptMangaLayoutCandidates: 既定(先頭)は従来のまま、新プリセットは末尾側に追加", () => {
  assert.equal(scriptMangaLayoutCandidates(1)[0], "builtin:splash");
  assert.equal(scriptMangaLayoutCandidates(2)[0], "builtin:two-horizontal");
  assert.equal(scriptMangaLayoutCandidates(3)[0], "builtin:three-horizontal");
  assert.equal(scriptMangaLayoutCandidates(4)[0], "builtin:four-grid");
  assert.ok(scriptMangaLayoutCandidates(1).includes("builtin:splash-bleed"));
  assert.ok(scriptMangaLayoutCandidates(2).includes("builtin:two-bleed-hero-top"));
  assert.ok(scriptMangaLayoutCandidates(3).includes("builtin:three-bleed-hero-top"));
  assert.ok(scriptMangaLayoutCandidates(3).includes("builtin:three-bleed-vertical"));
  assert.ok(scriptMangaLayoutCandidates(3).includes("builtin:three-diagonal"));
  assert.ok(scriptMangaLayoutCandidates(3).includes("builtin:three-figure-left"));
  assert.ok(scriptMangaLayoutCandidates(4).includes("builtin:four-figure-left"));
});

test("全プリセットのはみ出しは PANEL_BLEED_OVERSHOOT 以内(preflight と整合)", () => {
  for (const template of LAYOUT_PRESETS) {
    const height = template.layout.page.height;
    for (const panel of template.layout.panels) {
      const [x1, y1, x2, y2] = panelBounds(panel.shape);
      assert.ok(x1 >= -PANEL_BLEED_OVERSHOOT && y1 >= -PANEL_BLEED_OVERSHOOT, `${template.id}/${panel.id}`);
      assert.ok(x2 <= 1 + PANEL_BLEED_OVERSHOOT && y2 <= height + PANEL_BLEED_OVERSHOOT, `${template.id}/${panel.id}`);
    }
  }
  const bleed = findLayoutPreset("builtin:splash-bleed")!;
  const [x1, y1, x2, y2] = panelBounds(bleed.layout.panels[0]!.shape);
  assert.ok(x1 < 0 && y1 < 0 && x2 > 1 && y2 > bleed.layout.page.height, "裁ち切りはページ外へはみ出すこと");
});

test("describeScriptMangaLayouts: figureSlot は reading order の位置(1始まり)", () => {
  const described = describeScriptMangaLayouts([
    "builtin:three-figure-left",
    "builtin:four-figure-left",
    "builtin:three-hero-top",
    "builtin:unknown"
  ]);
  const three = described.find((descriptor) => descriptor.id === "builtin:three-figure-left");
  const four = described.find((descriptor) => descriptor.id === "builtin:four-figure-left");
  const hero = described.find((descriptor) => descriptor.id === "builtin:three-hero-top");
  assert.equal(described.length, 3, "未知の id は黙って除外");
  assert.equal(three?.panelCount, 3);
  assert.equal(three?.figureSlot, 3);
  assert.equal(four?.figureSlot, 3);
  assert.equal(hero?.figureSlot, undefined);
  assert.ok((three?.description ?? "").includes("punch-out"));
});

test("figure スロットの role/frame は normalizeEditedPageLayout の往復で保持される", () => {
  const template = findLayoutPreset("builtin:three-figure-left")!;
  const roundTripped = normalizeEditedPageLayout(JSON.parse(JSON.stringify(template.layout)));
  assert.ok(roundTripped);
  const figure = roundTripped!.panels.find((panel) => panel.role === "figure");
  assert.ok(figure, "role が編集往復で保持されること");
  assert.equal(figure!.frame?.visible, false);
});
