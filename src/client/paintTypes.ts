/**
 * ペイントツール（アセット詳細モーダル上の画像加工）の型定義。
 * `maskTypes.ts` と同様、DOM・state に依存しない型のみを持つ。
 * 本 module は `main.ts` を import しない（circular import なし）。
 */

import type { PastedObject } from "../shared/pasteAttachments";

/** ペイントツールの選択ツール種別。`select` は貼り付けオブジェクトの選択・変形ツール。 */
export type PaintToolKind = "brush" | "eraser" | "eyedropper" | "select";

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
  /**
   * 貼り付けオブジェクト(z順、先頭=最背面)。サーバ永続値(asset_paste_attachments)の
   * クライアント側キャッシュで、ビットマップ本体は pasteObjectController の module キャッシュに分離。
   */
  pasteObjects: PastedObject[];
  /** 選択中オブジェクト id。pasteObjects に存在しない場合は normalize で null に戻る。 */
  selectedPasteObjectId: string | null;
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
