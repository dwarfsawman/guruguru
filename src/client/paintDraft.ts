/**
 * ペイントツールの下書き (PaintDraft) に関する純粋 helper。
 * `maskDraft.ts` と同様、DOM/state に依存しない pure helper のみを持つ。
 * 本 module は `main.ts` を import しない（circular import なし）。
 */
import { PAINT_MAX_RECENT_COLORS, type PaintDraft } from "./paintTypes";
import { sanitizePastedObjects } from "../shared/pasteAttachments";

export function defaultPaintDraft(assetId: string): PaintDraft {
  return {
    assetId,
    color: "#ffffff",
    brushSize: 24,
    tool: "brush",
    previousTool: null,
    recentColors: [],
    zoomScale: 1,
    panOffset: { x: 0, y: 0 },
    imageWidth: null,
    imageHeight: null,
    pasteObjects: [],
    selectedPasteObjectId: null
  };
}

export function normalizePaintDraft(draft: PaintDraft): PaintDraft {
  const defaults = defaultPaintDraft(draft.assetId);
  const pasteObjects = sanitizePastedObjects(draft.pasteObjects);
  const selectedPasteObjectId =
    draft.selectedPasteObjectId && pasteObjects.some((object) => object.id === draft.selectedPasteObjectId)
      ? draft.selectedPasteObjectId
      : null;
  return {
    ...defaults,
    ...draft,
    panOffset: draft.panOffset ?? defaults.panOffset,
    recentColors: draft.recentColors ?? [],
    pasteObjects,
    selectedPasteObjectId
  };
}

/**
 * 色を「最近使った色」の先頭に追加する。既存の同色エントリは重複排除し、
 * 上限 `PAINT_MAX_RECENT_COLORS` を超えた分は末尾から切り捨てる。
 */
export function pushRecentColor(recentColors: string[], color: string): string[] {
  const normalized = color.toLowerCase();
  const withoutDuplicate = recentColors.filter((existing) => existing.toLowerCase() !== normalized);
  return [color, ...withoutDuplicate].slice(0, PAINT_MAX_RECENT_COLORS);
}
