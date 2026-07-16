import assert from "node:assert/strict";
import test from "node:test";
import { extractLayoutFeatures } from "./layoutFeatures.ts";
import {
  buildPanelDemand,
  estimateMinimumPanelArea,
  feasibleLayouts,
  rankLayouts,
  selectDiverseLayouts
} from "./layoutMatcher.ts";
import { findLayoutPreset } from "./layoutPresets.ts";
import type { MangaVisualScale } from "./mangaPlanV2.ts";

/** 台詞なしの純粋な演出スケール構成(旧 selectScriptMangaLayoutId 相当の入力)。 */
function demands(scales: MangaVisualScale[], chars: number[] = []) {
  return scales.map((visualScale, index) => buildPanelDemand({
    visualScale,
    totalCharacters: chars[index] ?? 0,
    balloonCount: (chars[index] ?? 0) > 0 ? 1 : 0
  }));
}

function top(scales: MangaVisualScale[]): string | undefined {
  return feasibleLayouts(demands(scales))[0]?.layoutId;
}

test("feasibleLayouts top-1: 旧selectScriptMangaLayoutIdの選択を継承する(splash→裁ち切り、large×強調スロット、全medium→候補先頭)", () => {
  assert.equal(top(["splash"]), "builtin:splash-bleed");
  assert.equal(top(["medium"]), "builtin:splash");
  assert.equal(top(["medium", "medium", "medium"]), "builtin:three-horizontal");
  assert.equal(top(["large", "medium"]), "builtin:two-bleed-hero-top");
  assert.equal(top(["large", "medium", "medium"]), "builtin:three-hero-top");
  assert.equal(top(["medium", "large", "medium"]), "builtin:three-side-hero");
  assert.equal(top(["medium", "medium", "large"]), "builtin:three-hero-bottom",
    "figureレイアウトはfigure-slot-unwanted違反として実現可能集合から除外される");
  assert.equal(top(["medium", "large", "medium", "medium"]), "builtin:four-vertical-hero");
  assert.equal(top(["medium", "medium", "medium", "large"]), "builtin:four-hero-bottom");
  assert.equal(top(["large", "medium", "medium", "medium", "medium"]), "builtin:five-hero-top");
  assert.equal(top(["medium", "medium", "medium", "medium", "large"]), "builtin:five-panel");
  assert.equal(top(["medium", "medium", "large", "medium", "medium", "medium"]), "builtin:six-hero-right");
  assert.deepEqual(rankLayouts([]), []);
});

test("estimateMinimumPanelArea: 文字量+風船数から必要面積割合、無台詞は0、capで頭打ち", () => {
  assert.equal(estimateMinimumPanelArea({ totalCharacters: 0, balloonCount: 0 }), 0);
  const one = estimateMinimumPanelArea({ totalCharacters: 90, balloonCount: 1 });
  const fourBalloons = estimateMinimumPanelArea({ totalCharacters: 90, balloonCount: 4 });
  assert.ok(fourBalloons > one, "同じ文字数でも風船が多いほど必要面積が大きい");
  assert.equal(estimateMinimumPanelArea({ totalCharacters: 5000, balloonCount: 8 }), 0.8, "cap 0.8");
});

test("実現可能性ゲート: 台詞収容の絶対下限を満たさないレイアウトはhardViolationsで除外される", () => {
  // 3コマ中1コマに大量の台詞 → 均等グリッド(1/3=0.333)は収容できず、大スロット付きだけが実現可能。
  const heavy = demands(["medium", "medium", "medium"], [0, 320, 0]);
  const ranked = rankLayouts(heavy);
  const horizontal = ranked.find((entry) => entry.layoutId === "builtin:three-horizontal");
  assert.ok(horizontal);
  assert.ok(horizontal!.hardViolations.some((violation) => violation.startsWith("capacity:")),
    "均等3段は320字(必要面積0.37)を収容できない");
  const feasible = feasibleLayouts(heavy);
  assert.ok(feasible.length > 0, "収容できるレイアウトは存在する");
  for (const entry of feasible) assert.equal(entry.hardViolations.length, 0);
  // 実現可能な先頭は「台詞が多いコマ=読み順2」に大きなスロットを持つ。
  const features = extractLayoutFeatures(feasible[0]!.layoutId, findLayoutPreset(feasible[0]!.layoutId)!.layout);
  assert.ok(features.slots[1]!.areaFraction >= estimateMinimumPanelArea({ totalCharacters: 320, balloonCount: 1 }));
});

test("rankLayouts: 構造化reasonsとcosts内訳を返し、前ページ反復にはペナルティ", () => {
  const scales = demands(["large", "medium", "medium"]);
  const ranked = rankLayouts(scales, { previousLayoutId: "builtin:three-hero-top" });
  const heroTop = ranked.find((entry) => entry.layoutId === "builtin:three-hero-top")!;
  const sideHero = ranked.find((entry) => entry.layoutId === "builtin:three-side-hero")!;
  assert.ok(heroTop.costs.repetition > 0, "前ページと同じレイアウトはコスト加算");
  assert.equal(sideHero.costs.repetition, 0);
  assert.ok(sideHero.reasons.some((reason) => reason.code === "avoids-previous-layout"));
  assert.ok(heroTop.reasons.some((reason) => reason.code === "large-slot-aligned"));
  // 反復ペナルティで首位が変わり得る(hero-top以外のaligned候補が繰り上がる)。
  assert.notEqual(feasibleLayouts(scales, { previousLayoutId: "builtin:three-hero-top" })[0]!.layoutId,
    "builtin:three-hero-top");
});

test("selectDiverseLayouts: 実質同案を間引き、足りなければスコア順で埋める", () => {
  const ranked = rankLayouts(demands(["medium", "medium", "medium"]));
  const diverse = selectDiverseLayouts(ranked, { count: 3 });
  assert.equal(diverse.length, Math.min(3, ranked.length));
  const ids = new Set(diverse.map((entry) => entry.layoutId));
  assert.equal(ids.size, diverse.length, "重複なし");
  // 上位1件と「見た目が同じ」判定になる候補は、多様枠がある限り選ばれない
  //(3コマ内蔵プールは形が散っているため、ここでは件数と非重複のみを固定)。
});
