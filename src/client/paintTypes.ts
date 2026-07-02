/**
 * ペイントツール（アセット詳細モーダル上の画像加工）の型定義。
 * `maskTypes.ts` と同様、DOM・state に依存しない型のみを持つ。
 * 本 module は `main.ts` を import しない（circular import なし）。
 */

/** ペイントツールの選択ツール種別。 */
export type PaintToolKind = "brush" | "eraser" | "eyedropper";

export interface PaintDraft {
  assetId: string;
  color: string;
  brushSize: number;
  tool: PaintToolKind;
  /** Alt 一時スポイト中に退避する直前のツール。一時スポイト解除時に戻す。 */
  previousTool: PaintToolKind | null;
  recentColors: string[];
  zoomScale: number;
  panOffset: { x: number; y: number };
  imageWidth: number | null;
  imageHeight: number | null;
}

export const PAINT_BASE_PALETTE: string[] = [
  "#000000",
  "#ffffff",
  "#808080",
  "#ef4444",
  "#f97316",
  "#facc15",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#92400e"
];

export const PAINT_MAX_RECENT_COLORS = 8;
export const PAINT_UNDO_STACK_LIMIT = 5;
