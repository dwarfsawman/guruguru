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
