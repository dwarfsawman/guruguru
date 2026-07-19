import assert from "node:assert/strict";
import test from "node:test";
import type { PanelSpec } from "../shared/mangaPlanV2.ts";
import { OPENPOSE_JOINT_NAMES } from "../shared/poseTypes.ts";
import {
  findPosePreset,
  flipPosePresetPoints,
  matchPosePresetId,
  POSE_PRESETS
} from "../shared/posePresetLibrary.ts";
import { renderPoseSkeletonSvg } from "../shared/poseSkeletonSvg.ts";
import { reconstructCastPoses, reconstructPanelPoses, type PoseAnchor } from "./panelPoseReconstructor.ts";

function panel(overrides: Partial<PanelSpec> & { cast?: PanelSpec["cast"] } = {}): PanelSpec {
  const cast: PanelSpec["cast"] = overrides.cast ?? [{
    characterId: "char:a",
    variantId: "char:a:default",
    bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.8 },
    pose: "standing tall",
    expression: "calm",
    action: "stands",
    speakingLineIds: []
  }];
  return {
    id: "p1",
    sourceElementIds: [],
    beatIds: [],
    preStateId: "state:pre",
    postStateDelta: { notes: [] },
    settingId: "setting:0",
    props: [],
    dialogueLineIds: [],
    dialogueOrderIndexes: [],
    textSafeZones: [],
    mustShow: [],
    mustNotShow: [],
    continuityFromPanelIds: [],
    referenceManifest: [],
    sceneIndex: 0,
    sceneHeading: "INT. LAB",
    sourceText: "",
    promptBase: "",
    compiledPrompt: "x",
    shot: { size: "wide", angle: "eye-level", focalSubjectId: "char:a", compositionIntent: "clear" },
    ...overrides,
    cast
  } as PanelSpec;
}

test("posePresetLibrary: 全プリセットは18関節、キーワードマッチは決定的、反転は左右ペアを入れ替える", () => {
  for (const preset of POSE_PRESETS) assert.equal(preset.points.length, OPENPOSE_JOINT_NAMES.length, preset.id);
  assert.equal(matchPosePresetId("she sits on the chair"), "sitting");
  assert.equal(matchPosePresetId("running toward the exit"), "running");
  assert.equal(matchPosePresetId("walking slowly"), "walking");
  assert.equal(matchPosePresetId("crouching behind the crate"), "crouching");
  assert.equal(matchPosePresetId("pointing at the photo"), "pointing");
  assert.equal(matchPosePresetId("arms crossed, waiting"), "arms-crossed");
  assert.equal(matchPosePresetId("lying down on the floor"), "lying");
  assert.equal(matchPosePresetId("seen from the back"), "back-view");
  assert.equal(matchPosePresetId("mysterious silhouette"), "standing", "未知語はstanding");
  const standing = findPosePreset("standing")!;
  const flipped = flipPosePresetPoints(standing.points);
  assert.ok(Math.abs(flipped[2]!.x - (1 - standing.points[5]!.x)) < 1e-9, "rShoulder←lShoulderのミラー");
  assert.ok(Math.abs(flipped[14]!.x - (1 - standing.points[15]!.x)) < 1e-9, "rEye←lEyeのミラー");
});

test("reconstructPanelPoses: bbox内フィット・shot別可視・insert/無人/5人以上はスキップ", () => {
  const wide = reconstructPanelPoses(panel(), 1000, 1400, "full");
  assert.ok(wide);
  assert.equal(wide!.poses.length, 1);
  assert.equal(wide!.presetIds[0], "standing");
  const points = wide!.poses[0]!;
  // bbox: x 100..600, y 140..1260 に全可視関節が収まる。
  for (const point of points.filter((p) => p.visible)) {
    assert.ok(point.x >= 100 - 1e-6 && point.x <= 600 + 1e-6, `x=${point.x}`);
    assert.ok(point.y >= 140 - 1e-6 && point.y <= 1260 + 1e-6, `y=${point.y}`);
  }
  assert.ok(points.every((point) => point.visible), "wideは全身可視");
  // close-up: 頭+肩のみ可視。
  const closeUp = reconstructPanelPoses(
    panel({ shot: { size: "close-up", angle: "eye-level", focalSubjectId: "char:a", compositionIntent: "x" } }),
    1000, 1400, "full"
  );
  assert.ok(closeUp);
  const visibleIndexes = closeUp!.poses[0]!.flatMap((point, index) => (point.visible ? [index] : []));
  assert.deepEqual(visibleIndexes.sort((a, b) => a - b), [0, 1, 2, 5, 14, 15, 16, 17]);
  // faceモード: 頭部+首のみ。
  const face = reconstructPanelPoses(panel(), 1000, 1400, "face");
  const faceVisible = face!.poses[0]!.flatMap((point, index) => (point.visible ? [index] : []));
  assert.deepEqual(faceVisible.sort((a, b) => a - b), [0, 1, 14, 15, 16, 17]);
  // upperモード: 膝・足首なし。
  const upper = reconstructPanelPoses(panel(), 1000, 1400, "upper");
  const upperVisible = new Set(upper!.poses[0]!.flatMap((point, index) => (point.visible ? [index] : [])));
  for (const legJoint of [9, 10, 12, 13]) assert.ok(!upperVisible.has(legJoint), `joint ${legJoint} は upper で不可視`);
  // スキップ条件。
  assert.equal(reconstructPanelPoses(panel({ shot: { size: "insert", angle: "eye-level", focalSubjectId: "char:a", compositionIntent: "x" } }), 1000, 1400), null);
  assert.equal(reconstructPanelPoses(panel({ cast: [] }), 1000, 1400), null);
  const crowd = Array.from({ length: 5 }, (_, index) => ({
    characterId: `char:${index}`, variantId: `char:${index}:default`,
    bbox: { x: 0.1, y: 0.1, width: 0.15, height: 0.8 }, expression: "x", action: "x", speakingLineIds: []
  }));
  assert.equal(reconstructPanelPoses(panel({ cast: crowd }), 1000, 1400), null, "5人以上は骨格なし");
});

test("reconstructPanelPoses: 相手の位置から左右向きを反転する", () => {
  const twoShot = panel({
    cast: [
      { characterId: "char:a", variantId: "a", bbox: { x: 0.55, y: 0.2, width: 0.4, height: 0.7 },
        pose: "pointing at him", gazeTarget: "char:b", expression: "x", action: "points", speakingLineIds: [] },
      { characterId: "char:b", variantId: "b", bbox: { x: 0.05, y: 0.2, width: 0.4, height: 0.7 },
        pose: "standing", gazeTarget: "char:a", expression: "x", action: "stands", speakingLineIds: [] }
    ]
  });
  const result = reconstructPanelPoses(twoShot, 1000, 1000, "full");
  assert.ok(result);
  assert.equal(result!.poses.length, 2);
  assert.equal(result!.presetIds[0], "pointing");
  // char:a(右側)は左の char:b を向く → pointing の伸ばした腕(rWrist)が体の左側(x小)。
  const alice = result!.poses[0]!;
  const noseA = alice[0]!;
  const rWristA = alice[4]!;
  assert.ok(rWristA.x < noseA.x, "左を向く=右手首が鼻より左");
  // char:b(左側)は右の char:a を向く → 反転で伸び手側が右。
  const bob = result!.poses[1]!;
  assert.ok(bob[4]!.x > bob[0]!.x - 200, "右向きへ反転(左向きの初期形より右側)");
});

function headCentroid(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  const indexes = [0, 14, 15, 16, 17];
  const sum = indexes.reduce((acc, index) => ({ x: acc.x + points[index]!.x, y: acc.y + points[index]!.y }), { x: 0, y: 0 });
  return { x: sum.x / indexes.length, y: sum.y / indexes.length };
}

function hipMidpoint(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  return { x: (points[8]!.x + points[11]!.x) / 2, y: (points[8]!.y + points[11]!.y) / 2 };
}

test("reconstructPanelPoses: アンカーがあると頭・胴の2点相似変換でフィットする", () => {
  const anchors = new Map<string, PoseAnchor>([
    ["char:a", { head: { x: 0.3, y: 0.2 }, torso: { x: 0.3, y: 0.6 } }]
  ]);
  const result = reconstructPanelPoses(panel(), 1000, 1000, "full", anchors);
  assert.ok(result);
  const points = result!.poses[0]!;
  const head = headCentroid(points);
  const hips = hipMidpoint(points);
  assert.ok(Math.abs(head.x - 300) < 1e-6 && Math.abs(head.y - 200) < 1e-6, `頭部重心がheadアンカーへ (${head.x},${head.y})`);
  assert.ok(Math.abs(hips.x - 300) < 1e-6 && Math.abs(hips.y - 600) < 1e-6, `ヒップ中点がtorsoアンカーへ (${hips.x},${hips.y})`);
});

test("reconstructPanelPoses: 水平アンカーは骨格ごと回転する(寝そべり)", () => {
  const anchors = new Map<string, PoseAnchor>([
    ["char:a", { head: { x: 0.7, y: 0.5 }, torso: { x: 0.3, y: 0.5 } }]
  ]);
  const result = reconstructPanelPoses(panel(), 1000, 1000, "full", anchors);
  assert.ok(result);
  const points = result!.poses[0]!;
  const head = headCentroid(points);
  const hips = hipMidpoint(points);
  assert.ok(Math.abs(head.x - 700) < 1e-6 && Math.abs(head.y - 500) < 1e-6);
  assert.ok(Math.abs(hips.x - 300) < 1e-6 && Math.abs(hips.y - 500) < 1e-6);
  // 背骨が水平 → 足首は胴の左側(x が小さい)へ伸びる。
  assert.ok(points[10]!.x < hips.x && points[13]!.x < hips.x, "足首は頭と反対側");
});

test("reconstructPanelPoses: 退化アンカー(頭≒胴)は従来の bbox フィットへ落ちる", () => {
  const anchors = new Map<string, PoseAnchor>([
    ["char:a", { head: { x: 0.5, y: 0.5 }, torso: { x: 0.5, y: 0.505 } }]
  ]);
  const withAnchor = reconstructPanelPoses(panel(), 1000, 1400, "full", anchors)!;
  const without = reconstructPanelPoses(panel(), 1000, 1400, "full")!;
  assert.deepEqual(withAnchor.poses, without.poses, "bbox フィット結果と一致");
});

test("reconstructCastPoses: パネルローカル0..1へ正規化し depth は focal 最前面 > cast 順", () => {
  const twoShot = panel({
    cast: [
      { characterId: "char:a", variantId: "a", bbox: { x: 0.55, y: 0.2, width: 0.4, height: 0.7 },
        pose: "standing", expression: "x", action: "stands", speakingLineIds: [] },
      { characterId: "char:b", variantId: "b", bbox: { x: 0.05, y: 0.2, width: 0.4, height: 0.7 },
        pose: "standing", expression: "x", action: "stands", speakingLineIds: [] }
    ]
  });
  const poses = reconstructCastPoses(twoShot, { aspect: 1.4 });
  assert.ok(poses);
  assert.equal(poses!.length, 2);
  // focalSubject=char:a が最前面(depth最大)。配列は depth 昇順。
  assert.equal(poses![0]!.characterId, "char:b");
  assert.equal(poses![0]!.depth, 0);
  assert.equal(poses![1]!.characterId, "char:a");
  assert.equal(poses![1]!.depth, 1);
  for (const pose of poses!) {
    assert.equal(pose.joints.length, 18);
    assert.equal(pose.source, "reconstructed");
    assert.ok(pose.presetId);
    for (const joint of pose.joints) {
      assert.ok(joint.x >= 0 && joint.x <= 1 && joint.y >= 0 && joint.y <= 1, "bboxフィットは0..1に収まる");
    }
  }
});

test("reconstructCastPoses: layers ヒントが depth を上書きし、アンカー由来は source=llm", () => {
  const twoShot = panel({
    cast: [
      { characterId: "char:a", variantId: "a", bbox: { x: 0.55, y: 0.2, width: 0.4, height: 0.7 },
        pose: "standing", expression: "x", action: "stands", speakingLineIds: [] },
      { characterId: "char:b", variantId: "b", bbox: { x: 0.05, y: 0.2, width: 0.4, height: 0.7 },
        pose: "standing", expression: "x", action: "stands", speakingLineIds: [] }
    ]
  });
  const anchors = new Map<string, PoseAnchor>([
    ["char:a", { head: { x: 0.7, y: 0.2 }, torso: { x: 0.7, y: 0.6 } }]
  ]);
  const layers = new Map<string, number>([["char:a", 0], ["char:b", 1]]);
  const poses = reconstructCastPoses(twoShot, { anchors, layers, aspect: 1.4 });
  assert.ok(poses);
  // layers 指定時は focal より layers が優先: char:a が奥(depth 0)。
  assert.equal(poses![0]!.characterId, "char:a");
  assert.equal(poses![0]!.source, "llm");
  assert.equal(poses![1]!.characterId, "char:b");
  assert.equal(poses![1]!.source, "reconstructed");
  // アンカーは正規化座標のまま反映される(ヒップ中点=torso)。
  const alice = poses![0]!;
  const hips = hipMidpoint(alice.joints);
  assert.ok(Math.abs(hips.x - 0.7) < 1e-6 && Math.abs(hips.y - 0.6) < 1e-6, `(${hips.x},${hips.y})`);
  const head = headCentroid(alice.joints);
  assert.ok(Math.abs(head.x - 0.7) < 1e-6 && Math.abs(head.y - 0.2) < 1e-6);
});

test("renderPoseSkeletonSvg: 黒背景+可視関節ぶんの line/circle を出力する", () => {
  const result = reconstructPanelPoses(panel(), 512, 512, "full")!;
  const svg = renderPoseSkeletonSvg(result.poses, 512, 512);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes('fill="#000000"'));
  const circles = (svg.match(/<circle/g) ?? []).length;
  const lines = (svg.match(/<line/g) ?? []).length;
  assert.equal(circles, 18, "standing全身は18関節");
  assert.equal(lines, 17, "OpenPose 17ボーン");
  const empty = renderPoseSkeletonSvg([], 512, 512);
  assert.ok(!empty.includes("<line") && !empty.includes("<circle"));
});
