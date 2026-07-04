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
import { defaultPoseModel } from "./pose/models";
import type { PoseWorkerLandmark } from "./pose/types";
import type { PoseDraft, PosePoint } from "./poseTypes";
import { MAX_POSE_COUNT, OPENPOSE_JOINT_COUNT } from "./poseTypes";

export const DEFAULT_KEYPOINT_THRESHOLD = 0.5;

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
    poses: null,
    source: "detected",
    strength: 1,
    startPercent: 0,
    endPercent: 1,
    keypointThreshold: DEFAULT_KEYPOINT_THRESHOLD,
    modelId: defaultPoseModel().id,
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
  const normalized: PoseDraft = {
    ...defaults,
    ...draft,
    keypointThreshold: draft.keypointThreshold ?? defaults.keypointThreshold,
    poses: draft.poses ?? null
  };
  // 旧フォーマット（`points: PosePoint[]` 1人分）からの移行:
  // localStorage に保存済みの draft は poses を持たないため、points があれば 1人分として包む。
  const legacy = draft as PoseDraft & { points?: PosePoint[] | null };
  if (!normalized.poses && Array.isArray(legacy.points) && legacy.points.length === OPENPOSE_JOINT_COUNT) {
    normalized.poses = [legacy.points];
  }
  delete (normalized as PoseDraft & { points?: PosePoint[] | null }).points;
  normalized.removedBones = normalizeRemovedBones(draft.removedBones, normalized.poses);
  return normalized;
}

/**
 * `removedBones` を人物 index ごとの重複なし昇順配列へ正規化する。
 * poses が null / 空、または全人物で削除が無い場合は `undefined`（＝削除なし）を返して draft を軽くする。
 */
export function normalizeRemovedBones(
  removedBones: number[][] | null | undefined,
  poses: PosePoint[][] | null
): number[][] | undefined {
  if (!removedBones || !poses || poses.length === 0) {
    return undefined;
  }
  const normalized = poses.map((_pose, poseIndex) => {
    const list = removedBones[poseIndex];
    if (!Array.isArray(list) || list.length === 0) {
      return [] as number[];
    }
    return Array.from(new Set(list.filter((index) => Number.isInteger(index) && index >= 0))).sort((a, b) => a - b);
  });
  return normalized.some((list) => list.length > 0) ? normalized : undefined;
}

/** `poses`（PosePoint[][]）を深いコピーで複製する。Undo スナップショット用。 */
export function clonePoses(poses: PosePoint[][] | null | undefined): PosePoint[][] | null {
  if (!poses) {
    return null;
  }
  return poses.map((pose) => pose.map((point) => ({ ...point })));
}

/** `removedBones` を深いコピーで複製する（Undo スナップショット用、undefined はそのまま）。 */
export function cloneRemovedBones(removedBones: number[][] | null | undefined): number[][] | undefined {
  if (!removedBones) {
    return undefined;
  }
  return removedBones.map((list) => list.slice());
}

/** `removedBones` の指定人物に `boneIndex` が含まれるか。 */
export function isBoneRemoved(
  removedBones: number[][] | null | undefined,
  poseIndex: number,
  boneIndex: number
): boolean {
  return !!removedBones?.[poseIndex]?.includes(boneIndex);
}

/**
 * `removedBones` に `(poseIndex, boneIndex)` を追加した新しい配列を返す（immutable）。
 * poses の人数に合わせて長さを揃える。
 */
export function withRemovedBone(
  removedBones: number[][] | null | undefined,
  poseCount: number,
  poseIndex: number,
  boneIndex: number
): number[][] {
  const next: number[][] = [];
  for (let index = 0; index < poseCount; index += 1) {
    next[index] = removedBones?.[index] ? removedBones[index]!.slice() : [];
  }
  if (poseIndex >= 0 && poseIndex < poseCount && !next[poseIndex]!.includes(boneIndex)) {
    next[poseIndex]!.push(boneIndex);
    next[poseIndex]!.sort((a, b) => a - b);
  }
  return next;
}

/**
 * `jointIndex` の子孫関節 index を全て返す（自分自身は含まない）。
 * `OPENPOSE_JOINT_PARENT` を親→子の隣接に反転して BFS する。回転FK で「一緒に回す関節」の決定に使う。
 */
export function poseDescendants(jointIndex: number): number[] {
  const descendants: number[] = [];
  const stack = [jointIndex];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const [childStr, parent] of Object.entries(OPENPOSE_JOINT_PARENT)) {
      const child = Number(childStr);
      if (parent === current && !descendants.includes(child) && child !== jointIndex) {
        descendants.push(child);
        stack.push(child);
      }
    }
  }
  return descendants.sort((a, b) => a - b);
}

/** `point` を `anchor` を中心に `angleRad` だけ回転させた座標を返す（回転FK）。 */
export function rotatePointAround(
  point: { x: number; y: number },
  anchor: { x: number; y: number },
  angleRad: number
): { x: number; y: number } {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  return {
    x: anchor.x + dx * cos - dy * sin,
    y: anchor.y + dx * sin + dy * cos
  };
}

/**
 * MediaPipe 33 landmarks（正規化座標）を OpenPose(COCO 18) の PosePoint 配列（画像 natural px）へ変換する。
 * 首(index 1)は両肩の中点で合成し、両肩の visibility の平均で可視判定する。
 */
export function mediapipeToOpenPose(
  landmarks: PoseWorkerLandmark[],
  imageWidth: number,
  imageHeight: number,
  threshold: number = DEFAULT_KEYPOINT_THRESHOLD
): PosePoint[] {
  const points: PosePoint[] = new Array(OPENPOSE_JOINT_COUNT);

  for (let openPoseIndex = 0; openPoseIndex < OPENPOSE_JOINT_COUNT; openPoseIndex += 1) {
    if (openPoseIndex === NECK_INDEX) {
      const left = landmarks[MEDIAPIPE_LEFT_SHOULDER];
      const right = landmarks[MEDIAPIPE_RIGHT_SHOULDER];
      if (!left || !right) {
        points[openPoseIndex] = { x: 0, y: 0, visible: false, score: 0 };
        continue;
      }
      const score = (left.visibility + right.visibility) / 2;
      points[openPoseIndex] = {
        x: ((left.x + right.x) / 2) * imageWidth,
        y: ((left.y + right.y) / 2) * imageHeight,
        visible: score >= threshold,
        score
      };
      continue;
    }

    const mediapipeIndex = OPENPOSE_TO_MEDIAPIPE[openPoseIndex];
    const landmark = mediapipeIndex === undefined ? undefined : landmarks[mediapipeIndex];
    if (!landmark) {
      points[openPoseIndex] = { x: 0, y: 0, visible: false, score: 0 };
      continue;
    }
    points[openPoseIndex] = {
      x: landmark.x * imageWidth,
      y: landmark.y * imageHeight,
      visible: landmark.visibility >= threshold,
      score: landmark.visibility
    };
  }

  return points;
}

/**
 * 検出済みポーズの各関節について `score >= threshold` で visible を再計算する。
 * 座標（x, y）と score は保持するため、関節ドラッグ編集後でもしきい値だけを付け替えられる。
 * score を持たない旧データは `visible ? 1 : 0` で補完する。
 */
export function applyPoseThreshold(poses: PosePoint[][], threshold: number): PosePoint[][] {
  const t = Number.isFinite(threshold) ? threshold : DEFAULT_KEYPOINT_THRESHOLD;
  return poses.map((pose) =>
    pose.map((point) => {
      const score = point.score ?? (point.visible ? 1 : 0);
      return { ...point, visible: score >= t };
    })
  );
}

/**
 * MediaPipe の複数人検出結果（人ごとの 33 landmarks）を OpenPose ポーズ一覧へ変換する。
 * `MAX_POSE_COUNT` 人分に切り詰め、landmarks が空の人は除外する。
 */
export function mediapipePosesToOpenPose(
  landmarksList: PoseWorkerLandmark[][],
  imageWidth: number,
  imageHeight: number,
  threshold: number = DEFAULT_KEYPOINT_THRESHOLD
): PosePoint[][] {
  return landmarksList
    .filter((landmarks) => landmarks.length > 0)
    .slice(0, MAX_POSE_COUNT)
    .map((landmarks) => mediapipeToOpenPose(landmarks, imageWidth, imageHeight, threshold));
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
  return (
    draft?.enabled === true &&
    !!draft.poses &&
    draft.poses.length > 0 &&
    draft.poses.every((pose) => pose.length === OPENPOSE_JOINT_COUNT)
  );
}

export function poseDraftHasAttachment(draft: PoseDraft | null | undefined) {
  return hasActivePoseData(draft);
}

/**
 * OpenPose(COCO 18) joint index → 親 joint index。`OPENPOSE_BONES` の [親, 子] ペアから導出した固定表。
 * neck(1) はルートのため親を持たない（undefined）。
 * Shift ドラッグの回転拘束（骨長固定）で「どの関節を中心に回すか」の決定に使う。
 */
export const OPENPOSE_JOINT_PARENT: Record<number, number> = {
  0: 1, // nose ← neck
  2: 1, // rShoulder ← neck
  3: 2, // rElbow ← rShoulder
  4: 3, // rWrist ← rElbow
  5: 1, // lShoulder ← neck
  6: 5, // lElbow ← lShoulder
  7: 6, // lWrist ← lElbow
  8: 1, // rHip ← neck
  9: 8, // rKnee ← rHip
  10: 9, // rAnkle ← rKnee
  11: 1, // lHip ← neck
  12: 11, // lKnee ← lHip
  13: 12, // lAnkle ← lKnee
  14: 0, // rEye ← nose
  15: 0, // lEye ← nose
  16: 14, // rEar ← rEye
  17: 15 // lEar ← lEye
};

export interface PoseBoneConstraint {
  /** 回転中心（親関節の座標、画像 natural px） */
  anchor: { x: number; y: number };
  /** 固定する骨長（ドラッグ開始時点の親子間距離、px） */
  radius: number;
}

/**
 * `jointIndex` の関節をドラッグする際の回転拘束を返す。
 * 親関節が存在しない（neck）、点が欠けている、骨長が 0 の場合は null（拘束なし）。
 * 親の visible は問わない（座標としては常に存在するため）。
 */
export function poseBoneConstraintForJoint(
  points: PosePoint[] | null | undefined,
  jointIndex: number
): PoseBoneConstraint | null {
  const parentIndex = OPENPOSE_JOINT_PARENT[jointIndex];
  if (parentIndex === undefined || !points) {
    return null;
  }
  const child = points[jointIndex];
  const parent = points[parentIndex];
  if (!child || !parent) {
    return null;
  }
  const radius = Math.hypot(child.x - parent.x, child.y - parent.y);
  if (!(radius > 0)) {
    return null;
  }
  return { anchor: { x: parent.x, y: parent.y }, radius };
}

/**
 * `(x, y)` を拘束円（anchor 中心・半径 radius）上へ射影する。
 * ポインタが anchor と一致して方向が定まらない場合は現在角度が保てないため、
 * anchor の真右（+x 方向）の点を返す（実操作ではほぼ到達しない縮退ケース）。
 */
export function projectPointToBoneCircle(
  constraint: PoseBoneConstraint,
  x: number,
  y: number
): { x: number; y: number } {
  const dx = x - constraint.anchor.x;
  const dy = y - constraint.anchor.y;
  const distance = Math.hypot(dx, dy);
  if (!(distance > 0)) {
    return { x: constraint.anchor.x + constraint.radius, y: constraint.anchor.y };
  }
  const scale = constraint.radius / distance;
  return {
    x: constraint.anchor.x + dx * scale,
    y: constraint.anchor.y + dy * scale
  };
}
