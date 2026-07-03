/**
 * ポーズ編集の下書き (PoseDraft) に関する純粋 helper。
 * `Docs/Feature-PoseControlNet.md` §3 の「MediaPipe 33 → OpenPose(COCO 18) マッピング」を実装する。
 * DOM/state に依存しない pure helper のみを置く（`maskDraft.ts` と同型）。
 *
 * - `strength` 既定は `1.0`、`startPercent` 既定は `0`、`endPercent` 既定は `1`。
 * - `enabled` 既定は `false`（InpaintDraft と同様、draft 作成時点では未添付）。
 * - `visibility < 0.5` の landmark は `visible: false` として保持する（描画対象外の判定は呼び出し側）。
 *
 * 本 module は `main.ts` を import しない（circular import なし）。
 */
import type { PoseWorkerLandmark } from "./pose/types";
import type { PoseDraft, PosePoint } from "./poseTypes";
import { OPENPOSE_JOINT_COUNT } from "./poseTypes";

const VISIBILITY_THRESHOLD = 0.5;

/**
 * OpenPose(COCO 18) index → MediaPipe 33 landmark index（単純対応分のみ）。
 * index 1 (neck) は肩の中点合成のため別処理。
 */
const OPENPOSE_TO_MEDIAPIPE: Record<number, number> = {
  0: 0, // nose
  2: 12, // rShoulder
  3: 14, // rElbow
  4: 16, // rWrist
  5: 11, // lShoulder
  6: 13, // lElbow
  7: 15, // lWrist
  8: 24, // rHip
  9: 26, // rKnee
  10: 28, // rAnkle
  11: 23, // lHip
  12: 25, // lKnee
  13: 27, // lAnkle
  14: 5, // rEye
  15: 2, // lEye
  16: 8, // rEar
  17: 7 // lEar
};

const NECK_INDEX = 1;
const MEDIAPIPE_LEFT_SHOULDER = 11;
const MEDIAPIPE_RIGHT_SHOULDER = 12;

export function defaultPoseDraft(assetId: string): PoseDraft {
  return {
    parentAssetId: assetId,
    enabled: false,
    points: null,
    source: "detected",
    strength: 1,
    startPercent: 0,
    endPercent: 1,
    modelStatus: "idle",
    modelDownloadProgress: 0,
    modelStatusText: "未取得",
    modelError: "",
    imageWidth: null,
    imageHeight: null
  };
}

export function normalizePoseDraft(draft: PoseDraft): PoseDraft {
  const defaults = defaultPoseDraft(draft.parentAssetId);
  return {
    ...defaults,
    ...draft,
    points: draft.points ?? null
  };
}

/**
 * MediaPipe 33 landmarks（正規化座標）を OpenPose(COCO 18) の PosePoint 配列（画像 natural px）へ変換する。
 * 首(index 1)は両肩の中点で合成し、両肩の visibility の平均で可視判定する。
 */
export function mediapipeToOpenPose(
  landmarks: PoseWorkerLandmark[],
  imageWidth: number,
  imageHeight: number
): PosePoint[] {
  const points: PosePoint[] = new Array(OPENPOSE_JOINT_COUNT);

  for (let openPoseIndex = 0; openPoseIndex < OPENPOSE_JOINT_COUNT; openPoseIndex += 1) {
    if (openPoseIndex === NECK_INDEX) {
      const left = landmarks[MEDIAPIPE_LEFT_SHOULDER];
      const right = landmarks[MEDIAPIPE_RIGHT_SHOULDER];
      if (!left || !right) {
        points[openPoseIndex] = { x: 0, y: 0, visible: false };
        continue;
      }
      const visibility = (left.visibility + right.visibility) / 2;
      points[openPoseIndex] = {
        x: ((left.x + right.x) / 2) * imageWidth,
        y: ((left.y + right.y) / 2) * imageHeight,
        visible: visibility >= VISIBILITY_THRESHOLD
      };
      continue;
    }

    const mediapipeIndex = OPENPOSE_TO_MEDIAPIPE[openPoseIndex];
    const landmark = mediapipeIndex === undefined ? undefined : landmarks[mediapipeIndex];
    if (!landmark) {
      points[openPoseIndex] = { x: 0, y: 0, visible: false };
      continue;
    }
    points[openPoseIndex] = {
      x: landmark.x * imageWidth,
      y: landmark.y * imageHeight,
      visible: landmark.visibility >= VISIBILITY_THRESHOLD
    };
  }

  return points;
}

/**
 * `(x, y)`（画像 natural px）から `maxDistance` 以内で最も近い関節の index を返す。
 * 見つからなければ null。不可視（`visible: false`）の関節も対象に含める
 * （半透明ハンドルをクリックして visible を復帰できるようにするため）。
 */
export function nearestPoseJointIndex(
  points: PosePoint[] | null | undefined,
  x: number,
  y: number,
  maxDistance: number
): number | null {
  if (!points || points.length === 0 || !(maxDistance >= 0)) {
    return null;
  }
  let bestIndex: number | null = null;
  let bestDistance = maxDistance;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) {
      continue;
    }
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export function hasActivePoseData(draft: PoseDraft | null | undefined): draft is PoseDraft {
  return draft?.enabled === true && !!draft.points && draft.points.length === OPENPOSE_JOINT_COUNT;
}

export function poseDraftHasAttachment(draft: PoseDraft | null | undefined) {
  return hasActivePoseData(draft);
}
