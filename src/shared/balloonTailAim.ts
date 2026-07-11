import type { PageVec } from "./pageObjects";

/**
 * 顔アンカー未取得時の初期しっぽ。真下固定を避け、吹き出しが右なら左下、左なら右下へ向ける。
 * 中央付近は発話順で交互にし、同じ垂直線が連続する機械的な見た目を防ぐ。
 */
export function initialBalloonTailTip(position: PageVec, size: PageVec, orderIndex: number): PageVec {
  const horizontal = Math.max(0.065, Math.min(0.2, size.x * 0.72));
  const vertical = Math.max(0.06, Math.min(0.18, size.y * 0.62));
  const direction = position.x > 0.55 ? -1 : position.x < 0.45 ? 1 : orderIndex % 2 === 0 ? -1 : 1;
  return { x: horizontal * direction, y: vertical };
}

/** しっぽ先端の絶対位置を所属コマの外接矩形内へ戻し、隣のコマへの越境を防ぐ。 */
export function constrainBalloonTailTipToBounds(
  position: PageVec,
  tip: PageVec,
  bounds: [number, number, number, number],
  inset = 0.025
): PageVec {
  const [x0, y0, x1, y1] = bounds;
  const minX = Math.min(x1, x0 + inset);
  const maxX = Math.max(x0, x1 - inset);
  const minY = Math.min(y1, y0 + inset);
  const maxY = Math.max(y0, y1 - inset);
  const absoluteX = Math.min(maxX, Math.max(minX, position.x + tip.x));
  const absoluteY = Math.min(maxY, Math.max(minY, position.y + tip.y));
  return { x: absoluteX - position.x, y: absoluteY - position.y };
}
