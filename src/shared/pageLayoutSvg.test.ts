import assert from "node:assert/strict";
import test from "node:test";
import { findLayoutPreset } from "./layoutPresets.ts";
import { renderPageLayoutSvg, renderPageWireframeSvg } from "./pageLayoutSvg.ts";

test("renderPageLayoutSvg: 従来のコマ枠サムネは shared 移動後も同じ形(viewBox/scale/枠)", () => {
  const layout = findLayoutPreset("builtin:three-hero-top")!.layout;
  const svg = renderPageLayoutSvg(layout, { className: "thumb", showOrder: true });
  assert.ok(svg.includes('viewBox="0 0 1000'));
  assert.ok(svg.includes('transform="scale(1000)"'));
  assert.ok(svg.includes('class="thumb"'));
  assert.ok((svg.match(/<rect/g) ?? []).length >= 4, "紙面+3コマ");
  assert.ok(svg.includes("page-layout-order"));
});

test("renderPageWireframeSvg: importance塗り分け・台詞量バー・ビートkind・turnHookマーク・diff枠", () => {
  const layout = findLayoutPreset("builtin:three-hero-top")!.layout;
  const svg = renderPageWireframeSvg(layout, {
    panels: [
      { importance: "hero", dialogueCharacters: 60, beatKinds: ["reveal"] },
      { importance: "normal", beatKinds: ["reaction"] },
      { importance: "normal" }
    ],
    turnHook: "reveal",
    highlight: true,
    ariaLabel: "候補ページ"
  });
  assert.ok(svg.includes("--wire-hero"), "hero塗り");
  assert.ok(!svg.includes("--wire-splash"), "splashなし");
  assert.ok(svg.includes("--wire-dialogue"), "台詞量バー");
  assert.ok(svg.includes(">!</text>"), "revealグリフ");
  assert.ok(svg.includes(">R</text>"), "reactionグリフ");
  assert.ok(svg.includes("▼reveal"), "turnHookマーク");
  assert.ok(svg.includes("--wire-diff"), "diffハイライト枠");
  assert.ok(svg.includes('aria-label="候補ページ"'));
  const splash = renderPageWireframeSvg(findLayoutPreset("builtin:splash-bleed")!.layout, {
    panels: [{ importance: "splash" }],
    turnHook: "cliffhanger"
  });
  assert.ok(splash.includes("--wire-splash"));
  assert.ok(splash.includes("▼cliff"));
  const plain = renderPageWireframeSvg(layout, {});
  assert.ok(!plain.includes("--wire-diff") && !plain.includes("▼"), "注釈なしは素のコマ枠のみ");
});
