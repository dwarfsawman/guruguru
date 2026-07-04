/**
 * ポーズ編集（PoseDraft）周辺の型定義。
 * `Docs/Feature-PoseControlNet.md` §3 の PoseDraft 定義に対応。
 * `PoseModelStatus` は `./pose/types` の `PoseModelStatus`（worker プロトコル）を再利用する。
 * 本 module は `main.ts` を import しない（circular import なし）。
 */
import type { PoseModelStatus } from "./pose/types";

export interface PosePoint {
  x: number;
  y: number;
  /** 画像 natural px 座標。normalized ではない。 */
  visible: boolean;
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

/**
 * OpenPose(COCO 18) 標準の bone 接続（joint index ペア）。
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

/** bone ごとの OpenPose 標準配色（`OPENPOSE_BONES` と同順、RGB）。 */
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

/** joint ごとの OpenPose 標準配色（joint index 順、RGB）。 */
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

export interface PoseDraft {
  parentAssetId: string;
  /** 次回生成に添付するか（InpaintDraft.enabled と同義） */
  enabled: boolean;
  /** OpenPose 18点。null = 未検出 */
  points: PosePoint[] | null;
  source: "detected" | "edited";
  strength: number;
  startPercent: number;
  endPercent: number;
  /** 使用する検出モデルの id（`POSE_MODELS` の要素）。未知の id は defaultPoseModel へフォールバック。 */
  modelId: string;
  modelStatus: PoseModelStatus;
  modelDownloadProgress: number;
  modelStatusText: string;
  modelError: string;
  imageWidth: number | null;
  imageHeight: number | null;
}
