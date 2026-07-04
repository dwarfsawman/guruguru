/**
 * OpenPose スケルトン PNG 描画（`Docs/Feature-PoseControlNet.md` §3「スケルトン PNG 描画」）。
 * 座標計算・描画対象の決定は pure helper（`buildPoseSkeletonDrawOps`）に切り出し、
 * canvas 依存の `renderPoseSkeletonDataUrl` から利用する（fake canvas 不要でユニットテスト可能にするため）。
 *
 * 可視性ルールは `renderPoseOverlay`（`views/posePanel.ts`）と同一:
 * bone は両端の joint が存在し `visible` な場合のみ描画、joint は `visible` な場合のみ描画する。
 *
 * 本 module は `main.ts` を import しない（circular import なし）。
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
 * 線幅（= 関節円の半径と同径）。`Docs/Feature-PoseControlNet.md` §3 の式:
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

/**
 * 黒不透明背景の offscreen canvas に OpenPose スケルトンを描画し、PNG data URL を返す。
 * Phase 5（サーバ添付パイプライン）から呼び出される想定。Phase 4 ではまだどこからも呼ばれない。
 */
export function renderPoseSkeletonDataUrl(
  poses: PosePoint[][] | null | undefined,
  width: number,
  height: number,
  removedBones?: number[][] | null
): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) {
    return "";
  }
  context.fillStyle = "#000000";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const ops = buildPoseSkeletonDrawOps(poses, width, height, removedBones);
  for (const op of ops) {
    const [r, g, b] = op.color;
    if (op.kind === "line") {
      context.strokeStyle = `rgb(${r},${g},${b})`;
      context.lineWidth = op.lineWidth;
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(op.x1, op.y1);
      context.lineTo(op.x2, op.y2);
      context.stroke();
    } else {
      context.fillStyle = `rgb(${r},${g},${b})`;
      context.beginPath();
      context.arc(op.x, op.y, op.radius, 0, Math.PI * 2);
      context.fill();
    }
  }

  return canvas.toDataURL("image/png");
}
