/**
 * ネームポーズレイヤの描画と差分抽出(Docs/Feature-NamePoseLayer.md P4/P5)。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { findLayoutPreset } from "../../shared/layoutPresets.ts";
import type { MangaPageSpec, MangaPlanV2, PanelCastPose, PanelSpec } from "../../shared/mangaPlanV2.ts";
import { buildPoseEdits } from "../namePoseEditController.ts";
import { poseCharacterColor, renderNamePoseOverlaySvg } from "./namePoseLayerView.ts";

function joints(x = 0.5): PanelCastPose["joints"] {
  return Array.from({ length: 18 }, (_, index) => ({ x, y: 0.06 + index * 0.05, visible: true }));
}

function plan(entities: Array<{ id: string; name: string; color?: string | null }>): MangaPlanV2 {
  return {
    narrativeGraph: {
      entities: entities.map((entity) => ({
        id: entity.id,
        kind: "character",
        name: entity.name,
        aliases: [],
        attributes: {},
        variants: [],
        ...(entity.color !== undefined ? { color: entity.color } : {})
      })),
      sourceElements: [],
      worldStates: [],
      beats: [],
      warnings: []
    }
  } as unknown as MangaPlanV2;
}

function pageWith(castPoses: PanelCastPose[]): MangaPageSpec {
  const layoutSnapshot = JSON.parse(JSON.stringify(findLayoutPreset("builtin:splash")!.layout));
  return {
    index: 0,
    title: "p1",
    layoutTemplateId: "builtin:splash",
    layoutSnapshot,
    pageIntent: "",
    panels: [{ id: "panel-1", castPoses, cast: [], shot: { size: "wide" } } as unknown as PanelSpec]
  } as MangaPageSpec;
}

test("poseCharacterColor: entity.color 優先、無ければ characterId から決定的フォールバック", () => {
  const withColor = plan([{ id: "char-a", name: "Alice", color: "#ff3366" }]);
  assert.equal(poseCharacterColor(withColor, "char-a"), "#ff3366");
  const noColor = plan([{ id: "char-a", name: "Alice" }, { id: "char-b", name: "Bob" }]);
  const colorA = poseCharacterColor(noColor, "char-a");
  const colorB = poseCharacterColor(noColor, "char-b");
  assert.match(colorA, /^#[0-9a-f]{6}$/u);
  assert.equal(colorA, poseCharacterColor(noColor, "char-a"), "決定的");
  assert.notEqual(colorA, colorB, "別キャラは別色(このid組では衝突しない)");
  // 不正な color 文字列はフォールバックへ。
  const badColor = plan([{ id: "char-a", name: "Alice", color: "red; evil" }]);
  assert.equal(poseCharacterColor(badColor, "char-a"), colorA);
});

test("renderNamePoseOverlaySvg: キャラ色ボーン+名前ラベルを depth 昇順で描く(表示モード)", () => {
  const testPlan = plan([
    { id: "char-a", name: "Alice", color: "#ff3366" },
    { id: "char-b", name: "Bob", color: "#3366ff" }
  ]);
  const page = pageWith([
    { characterId: "char-a", depth: 1, joints: joints(0.3), source: "llm" },
    { characterId: "char-b", depth: 0, joints: joints(0.7), source: "reconstructed" }
  ]);
  const svg = renderNamePoseOverlaySvg(page, testPlan);
  assert.match(svg, /studio-pose-svg/);
  assert.match(svg, /aria-hidden="true"/, "表示モードは装飾");
  assert.ok(!svg.includes("data-pose-stage"), "表示モードにステージ属性は無い");
  assert.ok(!svg.includes("pose-layer-bone-hit"), "表示モードにヒット線は無い");
  assert.match(svg, /stroke="#ff3366"/);
  assert.match(svg, /stroke="#3366ff"/);
  assert.match(svg, />Alice</);
  assert.match(svg, />Bob</);
  // depth 0(Bob)が先に描かれ、depth 1(Alice)が上に重なる。
  assert.ok(svg.indexOf(">Bob<") < svg.indexOf(">Alice<"), "奥→手前の描画順");
  // 骨格の無いページはレイヤ自体が空。
  const empty = renderNamePoseOverlaySvg(pageWith([]), testPlan);
  assert.ok(!empty.includes("pose-layer-bone"));
});

test("renderNamePoseOverlaySvg: 編集モードはステージ属性+ヒット線+不可視関節ハンドル", () => {
  const testPlan = plan([{ id: "char-a", name: "Alice", color: "#ff3366" }]);
  const hiddenJoints = joints(0.4);
  hiddenJoints[10] = { ...hiddenJoints[10]!, visible: false };
  const page = pageWith([{ characterId: "char-a", depth: 0, joints: hiddenJoints, source: "human" }]);
  const edit = {
    runId: "run-1",
    planId: "plan-1",
    baseVersion: 0,
    pageIndex: 0,
    draft: { "panel-1": page.panels[0]!.castPoses! },
    saved: {},
    selected: { panelId: "panel-1", characterId: "char-a" },
    saveBusy: false,
    canUndo: false,
    canRedo: false
  };
  const svg = renderNamePoseOverlaySvg(page, testPlan, edit);
  assert.match(svg, /data-pose-stage="1"/);
  assert.match(svg, /id="nameStudioPoseRoot"/);
  assert.match(svg, /pose-layer-bone-hit/, "ボーンの透明ヒット線");
  assert.match(svg, /is-hidden-joint/, "不可視関節も編集ハンドルとして出る");
  assert.match(svg, /is-selected/, "選択中骨格の強調");
  assert.match(svg, /Alice \[1\]/, "編集時は深度バッジ付きラベル");
  assert.match(svg, /data-pose-panel="panel-1"/);
  assert.match(svg, /data-joint-index="10"/);
});

test("buildPoseEdits: 置換/深度変更/削除/新規だけを {kind:\"pose\"} 差分にする", () => {
  const base = (): PanelCastPose[] => [
    { characterId: "char-a", depth: 0, joints: joints(0.3), source: "llm" },
    { characterId: "char-b", depth: 1, joints: joints(0.7), source: "reconstructed" }
  ];
  // 変更なし → 空。
  assert.deepEqual(buildPoseEdits({ saved: { p1: base() }, draft: { p1: base() } }), []);

  // char-a の関節変更 + char-b の削除。
  const moved = base();
  moved[0] = { ...moved[0]!, joints: joints(0.35), source: "human" };
  const edits = buildPoseEdits({
    saved: { p1: base() },
    draft: { p1: [moved[0]!] }
  });
  assert.equal(edits.length, 2);
  const jointEdit = edits.find((edit) => edit.kind === "pose" && edit.characterId === "char-a");
  assert.ok(jointEdit && jointEdit.kind === "pose" && Array.isArray(jointEdit.joints) && jointEdit.joints.length === 18);
  assert.equal((jointEdit as { depth?: number }).depth, undefined, "深度不変なら depth は送らない");
  const removeEdit = edits.find((edit) => edit.kind === "pose" && edit.characterId === "char-b");
  assert.ok(removeEdit && removeEdit.kind === "pose" && removeEdit.joints === null);

  // 深度だけの入れ替え → depth のみ。
  const swapped = base();
  swapped[0]!.depth = 1;
  swapped[1]!.depth = 0;
  const depthEdits = buildPoseEdits({ saved: { p1: base() }, draft: { p1: swapped } });
  assert.equal(depthEdits.length, 2);
  for (const edit of depthEdits) {
    assert.ok(edit.kind === "pose" && edit.joints === undefined && typeof edit.depth === "number");
  }
});
