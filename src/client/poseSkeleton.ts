/**
 * OpenPose スケルトン PNG 描画（`Docs/Done/Feature-PoseControlNet.md` §3「スケルトン PNG 描画」）。
 * 座標計算・描画対象の決定(pure helper `buildPoseSkeletonDrawOps`)は shared/poseSkeleton.ts へ
 * 移動(ネームv4 D4: サーバ側 SVG→PNG と共有)。ここは canvas 依存の
 * `renderPoseSkeletonDataUrl` と再エクスポートのみ。
 *
 * 本 module は `main.ts` を import しない（circular import なし）。
 */
import type { PosePoint } from "./poseTypes";
import { buildPoseSkeletonDrawOps } from "../shared/poseSkeleton";

export {
  buildPoseSkeletonDrawOps,
  poseSkeletonLineWidth,
  type PoseSkeletonCircleOp,
  type PoseSkeletonDrawOp,
  type PoseSkeletonLineOp
} from "../shared/poseSkeleton";

/**
 * 黒不透明背景の offscreen canvas に OpenPose スケルトンを描画し、PNG data URL を返す。
 * Phase 5（サーバ添付パイプライン）から呼び出される想定。
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
