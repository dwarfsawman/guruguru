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
  modelStatus: PoseModelStatus;
  modelDownloadProgress: number;
  modelStatusText: string;
  modelError: string;
  imageWidth: number | null;
  imageHeight: number | null;
}
