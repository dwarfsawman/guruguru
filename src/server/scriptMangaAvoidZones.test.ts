import assert from "node:assert/strict";
import test from "node:test";
import type { MangaPlanV2, PanelCastPose } from "../shared/mangaPlanV2.ts";
import type { LayoutPanel } from "../shared/pageLayout.ts";
import { planCastAvoidZones } from "./scriptMangaLettering.ts";

const OPENPOSE_JOINT_COUNT = 18;

/** 全関節を非可視の原点に置き、指定 index だけ可視座標へ差し替えた OpenPose-18。 */
function joints(overrides: Record<number, [number, number]>): PanelCastPose["joints"] {
  return Array.from({ length: OPENPOSE_JOINT_COUNT }, (_, index) => {
    const point = overrides[index];
    return point
      ? { x: point[0], y: point[1], visible: true }
      : { x: 0, y: 0, visible: false };
  });
}

function pageSpec(input: {
  cast: Array<{ characterId: string; bbox: { x: number; y: number; width: number; height: number } }>;
  castPoses?: PanelCastPose[];
}): MangaPlanV2["pages"][number] {
  return {
    panels: [
      {
        cast: input.cast.map((member) => ({ ...member, expression: "", action: "", speakingLineIds: [] })),
        ...(input.castPoses ? { castPoses: input.castPoses } : {})
      }
    ]
  } as unknown as MangaPlanV2["pages"][number];
}

/** ページ全面 1 コマ(page 座標 = コマ内正規化座標と一致するので検算しやすい)。 */
function fullPagePanels(role?: "figure"): LayoutPanel[] {
  return [
    {
      id: "p1",
      order: 0,
      shape: { type: "rect", bounds: [0, 0, 1, 1] },
      ...(role ? { role } : {})
    }
  ];
}

test("planCastAvoidZones: castPoses の頭部関節から顔ゾーンを作る", () => {
  // 立ち姿だが顔はコマ下半分(しゃがみ・見上げ)。bbox 上部38%の推定とは重ならない位置。
  const zones = planCastAvoidZones(
    pageSpec({
      cast: [{ characterId: "MIO", bbox: { x: 0.1, y: 0, width: 0.5, height: 1 } }],
      castPoses: [
        {
          characterId: "MIO",
          depth: 0,
          source: "human",
          joints: joints({
            0: [0.35, 0.7], // 鼻
            14: [0.32, 0.68],
            15: [0.38, 0.68],
            16: [0.29, 0.7],
            17: [0.41, 0.7],
            1: [0.35, 0.8] // 首
          })
        }
      ]
    }),
    fullPagePanels()
  );
  assert.equal(zones.length, 1);
  const zone = zones[0]!;
  const centerY = zone.y + zone.height / 2;
  assert.ok(Math.abs(centerY - 0.692) < 0.02, `顔ゾーンは頭部関節の位置(y≈0.69)に来る: ${centerY}`);
  assert.ok(zone.height > 0.1, `頭部関節の広がりだけでなく実頭部を覆う大きさになる: ${zone.height}`);
  assert.ok(zone.y > 0.5, "bbox 上部38%のフォールバック領域(y<0.38)ではない");
  assert.equal(zone.label, "顔");
});

test("planCastAvoidZones: castPoses が無いコマは bbox 上部38%へフォールバックする", () => {
  const zones = planCastAvoidZones(
    pageSpec({ cast: [{ characterId: "MIO", bbox: { x: 0.2, y: 0.1, width: 0.4, height: 0.8 } }] }),
    fullPagePanels()
  );
  assert.deepEqual(zones, [{ x: 0.2, y: 0.1, width: 0.4, height: 0.8 * 0.38, label: "顔" }]);
});

test("planCastAvoidZones: 頭部関節が全て不可視(後ろ姿・見切れ)なら bbox へフォールバックする", () => {
  const zones = planCastAvoidZones(
    pageSpec({
      cast: [{ characterId: "MIO", bbox: { x: 0.2, y: 0.1, width: 0.4, height: 0.8 } }],
      castPoses: [{ characterId: "MIO", depth: 0, source: "reconstructed", joints: joints({ 1: [0.4, 0.5] }) }]
    }),
    fullPagePanels()
  );
  assert.deepEqual(zones, [{ x: 0.2, y: 0.1, width: 0.4, height: 0.8 * 0.38, label: "顔" }]);
});

test("planCastAvoidZones: ぶち抜き立ち絵スロットはポーズがあっても全身を避ける", () => {
  const zones = planCastAvoidZones(
    pageSpec({
      cast: [{ characterId: "MIO", bbox: { x: 0.2, y: 0.1, width: 0.4, height: 0.8 } }],
      castPoses: [{ characterId: "MIO", depth: 0, source: "human", joints: joints({ 0: [0.4, 0.2] }) }]
    }),
    fullPagePanels("figure")
  );
  assert.deepEqual(zones, [{ x: 0.2, y: 0.1, width: 0.4, height: 0.8, label: "立ち絵" }]);
});

test("planCastAvoidZones: ポーズを持つキャラと持たないキャラが混在しても両方ゾーンが出る", () => {
  const zones = planCastAvoidZones(
    pageSpec({
      cast: [
        { characterId: "MIO", bbox: { x: 0.0, y: 0.0, width: 0.5, height: 1 } },
        { characterId: "RUI", bbox: { x: 0.5, y: 0.0, width: 0.5, height: 1 } }
      ],
      castPoses: [
        { characterId: "MIO", depth: 0, source: "human", joints: joints({ 0: [0.25, 0.6], 14: [0.22, 0.58], 15: [0.28, 0.58] }) }
      ]
    }),
    fullPagePanels()
  );
  assert.equal(zones.length, 2);
  assert.ok(zones[0]!.y > 0.4, "ポーズ由来(下方の顔)");
  assert.equal(zones[1]!.y, 0, "ポーズ無しは bbox 上端起点のフォールバック");
});
