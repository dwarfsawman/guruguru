/**
 * OpenPose(COCO 18) の共有定義。元は client/poseTypes.ts(ポーズ編集 UI)にあったが、
 * ネームv4 D4(サーバ側の棒人間復元→ControlNet 条件付け)で server からも使うため共有化。
 * client/poseTypes.ts は本モジュールを再エクスポートする(既存 import は不変)。
 */

export interface PosePoint {
  x: number;
  y: number;
  /** 画像 natural px 座標。normalized ではない。 */
  visible: boolean;
  /** 検出時の生の信頼度(0..1)。keypointThreshold スライダーで visible を再計算するために保持。省略時は visible から補完。 */
  score?: number;
}

/** OpenPose(COCO 18) の関節順序。`points[index]` の意味を固定する。 */
export const OPENPOSE_JOINT_NAMES = [
  "nose",
  "neck",
  "rShoulder",
  "rElbow",
  "rWrist",
  "lShoulder",
  "lElbow",
  "lWrist",
  "rHip",
  "rKnee",
  "rAnkle",
  "lHip",
  "lKnee",
  "lAnkle",
  "rEye",
  "lEye",
  "rEar",
  "lEar"
] as const;

export const OPENPOSE_JOINT_COUNT = OPENPOSE_JOINT_NAMES.length;

/** 1画像あたりの最大検出/編集人数。worker の `numPoses` と検出結果の取り込み上限で共用する。 */
export const MAX_POSE_COUNT = 4;

/**
 * OpenPose(COCO 18) 標準の bone 接続(joint index ペア)。
 * ControlNet 学習時の標準 limbSeq と同じ並び。SVG 表示・スケルトン PNG 描画で共用する。
 */
export const OPENPOSE_BONES: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [1, 5],
  [2, 3],
  [3, 4],
  [5, 6],
  [6, 7],
  [1, 8],
  [8, 9],
  [9, 10],
  [1, 11],
  [11, 12],
  [12, 13],
  [1, 0],
  [0, 14],
  [14, 16],
  [0, 15],
  [15, 17]
];

/** bone ごとの OpenPose 標準配色(`OPENPOSE_BONES` と同順、RGB)。 */
export const OPENPOSE_BONE_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0],
  [255, 85, 0],
  [255, 170, 0],
  [255, 255, 0],
  [170, 255, 0],
  [85, 255, 0],
  [0, 255, 0],
  [0, 255, 85],
  [0, 255, 170],
  [0, 255, 255],
  [0, 170, 255],
  [0, 85, 255],
  [0, 0, 255],
  [85, 0, 255],
  [170, 0, 255],
  [255, 0, 255],
  [255, 0, 170]
];

/** joint ごとの OpenPose 標準配色(joint index 順、RGB)。 */
export const OPENPOSE_JOINT_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0],
  [255, 85, 0],
  [255, 170, 0],
  [255, 255, 0],
  [170, 255, 0],
  [85, 255, 0],
  [0, 255, 0],
  [0, 255, 85],
  [0, 255, 170],
  [0, 255, 255],
  [0, 170, 255],
  [0, 85, 255],
  [0, 0, 255],
  [85, 0, 255],
  [170, 0, 255],
  [255, 0, 255],
  [255, 0, 170],
  [255, 0, 85]
];
