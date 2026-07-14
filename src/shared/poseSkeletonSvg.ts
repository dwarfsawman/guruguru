/**
 * OpenPose スケルトンの SVG 文字列描画(ネームv4 D4)。`buildPoseSkeletonDrawOps` の
 * 描画命令を黒不透明背景の SVG にする。サーバ側では sharp でラスタライズして
 * ControlNet 添付 PNG(data URL)を作る。クライアント canvas 経路
 * (`renderPoseSkeletonDataUrl`)と同じ見た目になるよう線端は round。
 */
import { buildPoseSkeletonDrawOps } from "./poseSkeleton";
import type { PosePoint } from "./poseTypes";

export function renderPoseSkeletonSvg(
  poses: PosePoint[][] | null | undefined,
  width: number,
  height: number,
  removedBones?: number[][] | null
): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const ops = buildPoseSkeletonDrawOps(poses, w, h, removedBones);
  const parts: string[] = [];
  for (const op of ops) {
    const [r, g, b] = op.color;
    if (op.kind === "line") {
      parts.push(
        `<line x1="${round2(op.x1)}" y1="${round2(op.y1)}" x2="${round2(op.x2)}" y2="${round2(op.y2)}" stroke="rgb(${r},${g},${b})" stroke-width="${op.lineWidth}" stroke-linecap="round" />`
      );
    } else {
      parts.push(
        `<circle cx="${round2(op.x)}" cy="${round2(op.y)}" r="${op.radius}" fill="rgb(${r},${g},${b})" />`
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect x="0" y="0" width="${w}" height="${h}" fill="#000000" />${parts.join("")}</svg>`;
}

function round2(value: number): string {
  return String(Math.round(value * 100) / 100);
}
