/**
 * ポーズ編集（PoseDraft）周辺の型定義。
 * `Docs/Done/Feature-PoseControlNet.md` §3 の PoseDraft 定義に対応。
 * `PoseModelStatus` は `./pose/types` の `PoseModelStatus`（worker プロトコル）を再利用する。
 * 本 module は `main.ts` を import しない（circular import なし）。
 *
 * OpenPose 定数・PosePoint は shared/poseTypes.ts へ移動(ネームv4 D4: サーバ側の
 * 棒人間復元と共有)。ここでは再エクスポートし、既存 import を変えない。
 */
import type { PoseModelStatus } from "./pose/types";
import type { PosePoint } from "../shared/poseTypes";

export {
  MAX_POSE_COUNT,
  OPENPOSE_BONE_COLORS,
  OPENPOSE_BONES,
  OPENPOSE_JOINT_COLORS,
  OPENPOSE_JOINT_COUNT,
  OPENPOSE_JOINT_NAMES
} from "../shared/poseTypes";
export type { PosePoint } from "../shared/poseTypes";

export interface PoseDraft {
  parentAssetId: string;
  /** 次回生成に添付するか（InpaintDraft.enabled と同義） */
  enabled: boolean;
  /** 検出/編集済みのポーズ一覧（各要素が1人分の OpenPose 18点、最大 `MAX_POSE_COUNT` 人）。null = 未検出 */
  poses: PosePoint[][] | null;
  /**
   * 人物 index ごとに手動削除した bone（`OPENPOSE_BONES` の index）の一覧。
   * `removedBones[poseIndex]` に含まれる bone は overlay・スケルトン PNG 双方で描画されない
   * （＝ControlNet 添付画像からも除外）。両端の joint が visible でも描画されない点が joint 非表示との違い。
   * 省略/未定義は「削除なし」。
   */
  removedBones?: number[][];
  source: "detected" | "edited";
  strength: number;
  startPercent: number;
  endPercent: number;
  /** キーポイント可視化の信頼度しきい値（0..1, 既定 0.5）。score >= しきい値 の関節のみ visible。 */
  keypointThreshold: number;
  /** 使用する検出モデルの id（`POSE_MODELS` の要素）。未知の id は defaultPoseModel へフォールバック。 */
  modelId: string;
  modelStatus: PoseModelStatus;
  modelDownloadProgress: number;
  modelStatusText: string;
  modelError: string;
  imageWidth: number | null;
  imageHeight: number | null;
}
