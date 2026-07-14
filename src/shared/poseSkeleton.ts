/**
 * OpenPose スケルトンの描画命令(pure helper)。元は client/poseSkeleton.ts にあった
 * `buildPoseSkeletonDrawOps` を共有化(ネームv4 D4: サーバ側 SVG→PNG 描画でも使う)。
 *
 * 可視性ルールは `renderPoseOverlay`(views/posePanel.ts)と同一:
 * bone は両端の joint が存在し `visible` な場合のみ描画、joint は `visible` な場合のみ描画する。
 */
import type { PosePoint } from "./poseTypes";
import { OPENPOSE_BONE_COLORS, OPENPOSE_BONES, OPENPOSE_JOINT_COLORS } from "./poseTypes";

export interface PoseSkeletonLineOp {
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: readonly [number, number, number];
  lineWidth: number;
}

export interface PoseSkeletonCircleOp {
  kind: "circle";
  x: number;
  y: number;
  radius: number;
  color: readonly [number, number, number];
}

export type PoseSkeletonDrawOp = PoseSkeletonLineOp | PoseSkeletonCircleOp;

/**
 * 線幅（= 関節円の半径と同径）。`Docs/Done/Feature-PoseControlNet.md` §3 の式:
 * `max(4, round(min(w,h)/128))`
 */
export function poseSkeletonLineWidth(width: number, height: number): number {
  const shortSide = Math.min(width, height);
  if (!Number.isFinite(shortSide) || shortSide <= 0) {
    return 4;
  }
  return Math.max(4, Math.round(shortSide / 128));
}

/**
 * `poses`（人ごとの OpenPose 18点、null 可）から描画すべき bone(line) / joint(circle) の一覧を返す pure helper。
 * DOM/canvas に依存しないため fake canvas なしでユニットテスト可能。
 * 描画順序: 人ごとに bone を先に全て、その後 joint を全て（`renderPoseOverlay` の重ね順と揃える）。
 */
export function buildPoseSkeletonDrawOps(
  poses: PosePoint[][] | null | undefined,
  width: number,
  height: number,
  removedBones?: number[][] | null
): PoseSkeletonDrawOp[] {
  if (!poses || poses.length === 0) {
    return [];
  }
  return poses.flatMap((points, poseIndex) =>
    buildSinglePoseDrawOps(points, width, height, removedBones?.[poseIndex])
  );
}

function buildSinglePoseDrawOps(
  points: PosePoint[],
  width: number,
  height: number,
  removed?: number[] | null
): PoseSkeletonDrawOp[] {
  if (points.length === 0) {
    return [];
  }
  const lineWidth = poseSkeletonLineWidth(width, height);
  const ops: PoseSkeletonDrawOp[] = [];

  OPENPOSE_BONES.forEach((bone, index) => {
    if (removed?.includes(index)) {
      return;
    }
    const from = points[bone[0]];
    const to = points[bone[1]];
    if (!from || !to || !from.visible || !to.visible) {
      return;
    }
    const color = OPENPOSE_BONE_COLORS[index] ?? [255, 255, 255];
    ops.push({
      kind: "line",
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      color,
      lineWidth
    });
  });

  points.forEach((point, index) => {
    if (!point || !point.visible) {
      return;
    }
    const color = OPENPOSE_JOINT_COLORS[index] ?? [255, 255, 255];
    ops.push({
      kind: "circle",
      x: point.x,
      y: point.y,
      radius: lineWidth,
      color
    });
  });

  return ops;
}
