import assert from "node:assert/strict";
import test from "node:test";
import {
  LAYOUT_PRESETS,
  builtinLayoutPanelCount,
  describeScriptMangaLayouts,
  emphasizedSlotIndex,
  findLayoutPreset,
  layoutAreaProfile,
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
  assert.deepEqual(scriptMangaLayoutCandidates(5), ["builtin:five-panel", "builtin:five-hero-top"]);
  assert.deepEqual(scriptMangaLayoutCandidates(6), ["builtin:six-panel", "builtin:six-hero-right"]);
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

// --- 自由な構図プリセット(Docs/Reference-MangaCompositions.md) ---

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

// --- 面積プロファイルとレイアウト事前選択(ネームv4 D1) ---

test("layoutAreaProfile: 全プリセットの reading-order 面積比スナップショット", () => {
  const expected: Record<string, number[]> = {
    "builtin:cover": [0.1829, 0.8171],
    "builtin:splash": [1],
    "builtin:splash-bleed": [1],
    "builtin:two-horizontal": [0.5, 0.5],
    "builtin:two-vertical": [0.5, 0.5],
    "builtin:two-bleed-hero-top": [0.7078, 0.2922],
    "builtin:three-horizontal": [0.3333, 0.3333, 0.3333],
    "builtin:three-hero-top": [0.5542, 0.2229, 0.2229],
    "builtin:three-side-hero": [0.2228, 0.526, 0.2512],
    "builtin:three-hero-bottom": [0.1614, 0.1614, 0.6771],
    "builtin:three-bleed-hero-top": [0.6705, 0.1647, 0.1647],
    "builtin:three-bleed-vertical": [0.3384, 0.3232, 0.3384],
    "builtin:three-diagonal": [0.2941, 0.356, 0.3499],
    "builtin:three-figure-left": [0.2818, 0.3146, 0.4036],
    "builtin:four-grid": [0.25, 0.25, 0.25, 0.25],
    "builtin:four-hero-bottom": [0.1141, 0.1141, 0.1711, 0.6006],
    "builtin:four-vertical-hero": [0.179, 0.4631, 0.179, 0.179],
    "builtin:four-figure-left": [0.205, 0.205, 0.385, 0.205],
    "builtin:five-panel": [0.1654, 0.1654, 0.1654, 0.1654, 0.3382],
    "builtin:five-hero-top": [0.4388, 0.1403, 0.1403, 0.1403, 0.1403],
    "builtin:six-panel": [0.1667, 0.1667, 0.1667, 0.1667, 0.1667, 0.1667],
    "builtin:six-hero-right": [0.1316, 0.1316, 0.3199, 0.1445, 0.1362, 0.1362],
    "builtin:yonkoma": [0.25, 0.25, 0.25, 0.25]
  };
  for (const template of LAYOUT_PRESETS) {
    const profile = layoutAreaProfile(template.id);
    assert.ok(profile, template.id);
    const pinned = expected[template.id];
    assert.ok(pinned, `snapshot missing for ${template.id}`);
    assert.equal(profile!.length, pinned!.length, template.id);
    assert.ok(Math.abs(profile!.reduce((sum, share) => sum + share, 0) - 1) < 1e-9, `${template.id} sums to 1`);
    profile!.forEach((share, index) => {
      assert.ok(Math.abs(share - pinned![index]!) < 5e-4, `${template.id}[${index}] = ${share} ≠ ${pinned![index]}`);
    });
  }
  assert.equal(layoutAreaProfile("builtin:unknown"), null);
});

test("emphasizedSlotIndex: 均等グリッドと単コマは強調なし、大ゴマ持ちは最大スロット", () => {
  assert.equal(emphasizedSlotIndex([1]), null);
  assert.equal(emphasizedSlotIndex([0.25, 0.25, 0.25, 0.25]), null);
  assert.equal(emphasizedSlotIndex(layoutAreaProfile("builtin:three-hero-top")!), 0);
  assert.equal(emphasizedSlotIndex(layoutAreaProfile("builtin:three-side-hero")!), 1);
  assert.equal(emphasizedSlotIndex(layoutAreaProfile("builtin:three-hero-bottom")!), 2);
  assert.equal(emphasizedSlotIndex(layoutAreaProfile("builtin:three-diagonal")!), null, "斜めゴマは強調扱いしない");
  assert.equal(emphasizedSlotIndex(layoutAreaProfile("builtin:five-panel")!), 4);
  assert.equal(emphasizedSlotIndex(layoutAreaProfile("builtin:five-hero-top")!), 0);
  assert.equal(emphasizedSlotIndex(layoutAreaProfile("builtin:six-hero-right")!), 2);
});

test("five-hero-top / six-hero-right: RTL順・ページ内・強調スロット", () => {
  for (const [id, count] of [["builtin:five-hero-top", 5], ["builtin:six-hero-right", 6]] as const) {
    const preset = findLayoutPreset(id);
    assert.ok(preset, id);
    assert.equal(preset!.layout.panels.length, count);
    assert.deepEqual(preset!.layout.panels.map((panel) => panel.order), Array.from({ length: count }, (_, i) => i + 1));
    for (const panel of preset!.layout.panels) {
      const [x1, y1, x2, y2] = panelBounds(panel.shape);
      assert.ok(x1 >= 0 && y1 >= 0 && x2 <= 1 && y2 <= preset!.layout.page.height, `${id}/${panel.id}`);
    }
  }
});

test("figure スロットの role/frame は normalizeEditedPageLayout の往復で保持される", () => {
  const template = findLayoutPreset("builtin:three-figure-left")!;
  const roundTripped = normalizeEditedPageLayout(JSON.parse(JSON.stringify(template.layout)));
  assert.ok(roundTripped);
  const figure = roundTripped!.panels.find((panel) => panel.role === "figure");
  assert.ok(figure, "role が編集往復で保持されること");
  assert.equal(figure!.frame?.visible, false);
});
