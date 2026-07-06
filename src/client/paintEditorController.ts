import { requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { clampNumber } from "./clientUtils";
import { formatCssNumber } from "./format";
import { findAsset, assetDimension } from "./assetLookup";
import { clearCanvas, dirtyRectForSegments, paintStroke, pointerToMaskCanvasPoint } from "./maskCanvas";
import type { PaintDraft, PaintToolKind } from "./paintTypes";
import { PAINT_UNDO_STACK_LIMIT } from "./paintTypes";
import { defaultPaintDraft, normalizePaintDraft, pushRecentColor } from "./paintDraft";
import {
  composePaintResultCanvas,
  createPaintLayerCanvas,
  renderPaintLayerToCanvas,
  restorePaintLayerFromSnapshot,
  sampleColorAt,
  snapshotPaintLayer
} from "./paintCanvas";

export const paintLayerCache = new Map<string, HTMLCanvasElement>();
export const paintUndoStacks = new Map<string, HTMLCanvasElement[]>();
let activePaintStroke: { pointerId: number; x: number; y: number; pendingSegments: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> } | null = null;
let paintStrokeRafHandle: number | null = null;
let paintAltEyedropperActive = false;

const PAINT_WHEEL_ZOOM_IDLE_MS = 150;
let paintWheelZoomIdleTimer: number | null = null;
let paintWheelZoomPendingScale: number | null = null;

/** Paint-mode analogue of `handleMaskWheelZoom`, persisting to `PaintDraft.zoomScale` instead. */
export function handlePaintWheelZoom(event: WheelEvent) {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensurePaintDraft(assetId);
  const currentScale = paintWheelZoomPendingScale ?? draft.zoomScale;
  const direction = event.deltaY < 0 ? 1 : -1;
  const nextScale = clampNumber(currentScale + direction * 0.12, 0.25, 4, 1);
  paintWheelZoomPendingScale = nextScale;

  const media = document.querySelector<HTMLElement>(".preview-media");
  media?.style.setProperty("--mask-zoom", formatCssNumber(nextScale));

  if (paintWheelZoomIdleTimer !== null) {
    window.clearTimeout(paintWheelZoomIdleTimer);
  }
  paintWheelZoomIdleTimer = window.setTimeout(() => {
    paintWheelZoomIdleTimer = null;
    const pendingScale = paintWheelZoomPendingScale;
    paintWheelZoomPendingScale = null;
    if (pendingScale === null) {
      return;
    }
    const latestDraft = paintDraftForAsset(assetId) ?? draft;
    setPaintDraft({
      ...latestDraft,
      zoomScale: pendingScale
    });
    requestRender();
  }, PAINT_WHEEL_ZOOM_IDLE_MS);
}

function togglePaintEditor() {
  if (state.paintEditMode) {
    commitActivePaintCanvas();
    state.paintEditMode = false;
  } else if (state.activeAssetId) {
    ensurePaintDraft(state.activeAssetId);
    state.paintEditMode = true;
    state.maskEditMode = false;
  }
  requestRender();
}

// --- Paint tool -----------------------------------------------------------

export function paintDraftForAsset(assetId: string | null | undefined): PaintDraft | null {
  const stored = assetId ? state.paintDrafts[assetId] : null;
  if (!stored) {
    return null;
  }
  const normalized = normalizePaintDraft(stored);
  state.paintDrafts[normalized.assetId] = normalized;
  return normalized;
}

export function ensurePaintDraft(assetId: string): PaintDraft {
  const draft = normalizePaintDraft(paintDraftForAsset(assetId) ?? defaultPaintDraft(assetId));
  state.paintDrafts[assetId] = draft;
  return draft;
}

export function setPaintDraft(draft: PaintDraft) {
  state.paintDrafts[draft.assetId] = normalizePaintDraft(draft);
}

export function getOrCreatePaintLayer(assetId: string, width: number, height: number): HTMLCanvasElement {
  let layer = paintLayerCache.get(assetId);
  if (layer && layer.width === width && layer.height === height) {
    return layer;
  }
  layer = createPaintLayerCanvas(width, height);
  paintLayerCache.set(assetId, layer);
  return layer;
}

export function activePaintCanvasAndAsset(): { canvas: HTMLCanvasElement; assetId: string } | null {
  const canvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
  const assetId = canvas?.dataset.assetId ?? state.activeAssetId;
  if (!canvas || !assetId) {
    return null;
  }
  return { canvas, assetId };
}

export function syncAssetModalPaintCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  if (!canvas || !image) {
    return;
  }

  const sync = () => {
    const asset = findAsset(canvas.dataset.assetId ?? "");
    const width = image.naturalWidth || assetDimension(asset, "width") || Math.max(1, Math.round(image.clientWidth));
    const height = image.naturalHeight || assetDimension(asset, "height") || Math.max(1, Math.round(image.clientHeight));
    if (!width || !height) {
      return;
    }
    canvas.width = width;
    canvas.height = height;
    const assetId = canvas.dataset.assetId;
    if (!assetId) {
      return;
    }
    const draft = ensurePaintDraft(assetId);
    if (draft.imageWidth !== width || draft.imageHeight !== height) {
      setPaintDraft({ ...draft, imageWidth: width, imageHeight: height });
    }
    const layer = getOrCreatePaintLayer(assetId, width, height);
    renderPaintLayerToCanvas(canvas, layer);
  };

  if (image.complete && image.naturalWidth > 0) {
    sync();
  } else {
    image.addEventListener("load", sync, { once: true });
  }
}

function beginPaintStroke(event: PointerEvent, canvas: HTMLCanvasElement) {
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensurePaintDraft(assetId);
  if (draft.tool === "eyedropper") {
    pickPaintColorAt(event, canvas, assetId);
    return;
  }
  pushPaintUndoSnapshot(assetId);
  canvas.setPointerCapture(event.pointerId);
  const point = pointerToMaskCanvasPoint(canvas, event);
  activePaintStroke = {
    pointerId: event.pointerId,
    x: point.x,
    y: point.y,
    pendingSegments: []
  };
  paintCanvasSegments(canvas, [{ from: point, to: point }]);
}

function continuePaintStroke(event: PointerEvent, canvas: HTMLCanvasElement) {
  if (!activePaintStroke) {
    return;
  }
  const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const pointerEvents = coalesced.length > 0 ? coalesced : [event];
  let cursor = { x: activePaintStroke.x, y: activePaintStroke.y };
  for (const pointerEvent of pointerEvents) {
    const point = pointerToMaskCanvasPoint(canvas, pointerEvent);
    activePaintStroke.pendingSegments.push({ from: cursor, to: point });
    cursor = point;
  }
  activePaintStroke.x = cursor.x;
  activePaintStroke.y = cursor.y;
  schedulePaintStrokeFlush(canvas);
}

function schedulePaintStrokeFlush(canvas: HTMLCanvasElement) {
  if (paintStrokeRafHandle !== null) {
    return;
  }
  paintStrokeRafHandle = requestAnimationFrame(() => {
    paintStrokeRafHandle = null;
    flushPaintStrokeQueue(canvas);
  });
}

export function cancelPendingPaintStrokeFlush() {
  if (paintStrokeRafHandle !== null) {
    cancelAnimationFrame(paintStrokeRafHandle);
    paintStrokeRafHandle = null;
  }
}

function flushPaintStrokeQueue(canvas: HTMLCanvasElement) {
  if (!activePaintStroke || activePaintStroke.pendingSegments.length === 0) {
    return;
  }
  const segments = activePaintStroke.pendingSegments;
  activePaintStroke.pendingSegments = [];
  paintCanvasSegments(canvas, segments);
}

function finishPaintStroke(canvas: HTMLCanvasElement) {
  cancelPendingPaintStrokeFlush();
  flushPaintStrokeQueue(canvas);
  if (activePaintStroke) {
    try {
      canvas.releasePointerCapture(activePaintStroke.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }
  activePaintStroke = null;
}

const PAINT_DIRTY_RECT_MARGIN = 2;

function paintCanvasSegments(canvas: HTMLCanvasElement, segments: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>) {
  if (segments.length === 0) {
    return;
  }
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensurePaintDraft(assetId);
  const layer = getOrCreatePaintLayer(assetId, canvas.width, canvas.height);
  const brushSize = draft.brushSize;
  const compositeOperation: GlobalCompositeOperation = draft.tool === "eraser" ? "destination-out" : "source-over";
  for (const segment of segments) {
    paintStroke(layer, segment.from, segment.to, brushSize, compositeOperation, draft.color);
  }
  const dirtyRect = dirtyRectForSegments(segments, brushSize, PAINT_DIRTY_RECT_MARGIN) ?? undefined;
  renderPaintLayerToCanvas(canvas, layer, dirtyRect);
}

export function commitActivePaintCanvas() {
  cancelPendingPaintStrokeFlush();
  const canvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
  if (canvas) {
    finishPaintStroke(canvas);
  }
}

function pushPaintUndoSnapshot(assetId: string) {
  const layer = paintLayerCache.get(assetId);
  if (!layer) {
    return;
  }
  const stack = paintUndoStacks.get(assetId) ?? [];
  stack.push(snapshotPaintLayer(layer));
  while (stack.length > PAINT_UNDO_STACK_LIMIT) {
    stack.shift();
  }
  paintUndoStacks.set(assetId, stack);
}

function undoPaintStroke() {
  const active = activePaintCanvasAndAsset();
  if (!active) {
    return;
  }
  const { canvas, assetId } = active;
  const stack = paintUndoStacks.get(assetId);
  const snapshot = stack?.pop();
  if (!snapshot) {
    return;
  }
  const layer = getOrCreatePaintLayer(assetId, canvas.width, canvas.height);
  restorePaintLayerFromSnapshot(layer, snapshot);
  renderPaintLayerToCanvas(canvas, layer);
}

function setPaintTool(tool: PaintToolKind | undefined) {
  if (!tool || !state.activeAssetId) {
    return;
  }
  const draft = ensurePaintDraft(state.activeAssetId);
  setPaintDraft({ ...draft, tool });
  requestRender();
}

export function setPaintColor(color: string) {
  if (!state.activeAssetId) {
    return;
  }
  const draft = ensurePaintDraft(state.activeAssetId);
  setPaintDraft({
    ...draft,
    color,
    recentColors: pushRecentColor(draft.recentColors, color)
  });
  requestRender();
}

export function setPaintBrushSize(size: number) {
  if (!state.activeAssetId) {
    return;
  }
  const draft = ensurePaintDraft(state.activeAssetId);
  setPaintDraft({ ...draft, brushSize: clampNumber(size, 1, 256, 24) });
}

function pickPaintColorAt(event: PointerEvent, canvas: HTMLCanvasElement, assetId: string) {
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  if (!image) {
    return;
  }
  const point = pointerToMaskCanvasPoint(canvas, event);
  const layer = getOrCreatePaintLayer(assetId, canvas.width, canvas.height);
  const composed = composePaintResultCanvas(image, layer, canvas.width, canvas.height);
  const color = sampleColorAt(composed, point.x, point.y);
  if (!color) {
    return;
  }
  const draft = ensurePaintDraft(assetId);
  if (paintAltEyedropperActive && draft.previousTool) {
    setPaintDraft({
      ...draft,
      color,
      recentColors: pushRecentColor(draft.recentColors, color),
      tool: draft.previousTool,
      previousTool: null
    });
    paintAltEyedropperActive = false;
  } else {
    setPaintDraft({
      ...draft,
      color,
      recentColors: pushRecentColor(draft.recentColors, color)
    });
  }
  requestRender();
}

function beginAltEyedropper() {
  if (!state.paintEditMode || !state.activeAssetId) {
    return;
  }
  const draft = ensurePaintDraft(state.activeAssetId);
  if (draft.tool === "eyedropper" || draft.previousTool) {
    return;
  }
  paintAltEyedropperActive = true;
  setPaintDraft({ ...draft, previousTool: draft.tool, tool: "eyedropper" });
  requestRender();
}

function endAltEyedropper() {
  if (!paintAltEyedropperActive || !state.activeAssetId) {
    return;
  }
  const draft = paintDraftForAsset(state.activeAssetId);
  if (draft?.previousTool) {
    setPaintDraft({ ...draft, tool: draft.previousTool, previousTool: null });
  }
  paintAltEyedropperActive = false;
  requestRender();
}

function clearActivePaintCanvas() {
  const active = activePaintCanvasAndAsset();
  if (!active) {
    return;
  }
  const { canvas, assetId } = active;
  pushPaintUndoSnapshot(assetId);
  const layer = getOrCreatePaintLayer(assetId, canvas.width, canvas.height);
  clearCanvas(layer);
  renderPaintLayerToCanvas(canvas, layer);
}

/**
 * bindEvents の pointerdown/move/up/cancel ハンドラから呼ばれるペイント編集系の分岐。
 * true を返した場合、呼び出し側は以降の分岐を処理しない（従来の early return と同じ扱い）。
 */
export function handlePaintEditorPointerDown(event: PointerEvent, target: HTMLElement): boolean {
  if (target.id !== "paintCanvas") {
    return false;
  }
  if (!state.paintEditMode) {
    return true;
  }
  event.preventDefault();
  beginPaintStroke(event, target as HTMLCanvasElement);
  return true;
}

export function handlePaintEditorPointerMove(event: PointerEvent): boolean {
  if (!activePaintStroke) {
    return false;
  }
  if (event.pointerId !== activePaintStroke.pointerId) {
    return true;
  }
  const paintCanvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
  if (!paintCanvas) {
    return true;
  }
  event.preventDefault();
  continuePaintStroke(event, paintCanvas);
  return true;
}

export function handlePaintEditorPointerUp(event: PointerEvent): boolean {
  if (!activePaintStroke || event.pointerId !== activePaintStroke.pointerId) {
    return false;
  }
  const paintCanvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
  if (paintCanvas) {
    event.preventDefault();
    finishPaintStroke(paintCanvas);
  }
  return true;
}

export function handlePaintEditorPointerCancel(event: PointerEvent): boolean {
  if (!activePaintStroke || event.pointerId !== activePaintStroke.pointerId) {
    return false;
  }
  const paintCanvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
  if (paintCanvas) {
    finishPaintStroke(paintCanvas);
  }
  return true;
}

/**
 * paint-mode の Ctrl+Z(undo) / Alt 一時スポイト keydown 分岐。
 * main.ts の window keydown ハンドラから、pose editor 分岐より前の位置で呼ばれる。
 * true を返した場合は呼び出し側で以降の処理（return）を行う。
 */
export function handlePaintEditorKeydown(event: KeyboardEvent): boolean {
  if (!state.paintEditMode) {
    return false;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undoPaintStroke();
    return true;
  }
  if (event.key === "Alt" && !event.repeat) {
    beginAltEyedropper();
  }
  return false;
}

export function handlePaintEditorKeyup(event: KeyboardEvent) {
  if (event.key === "Alt") {
    endAltEyedropper();
  }
}

export function handlePaintEditorBlur() {
  endAltEyedropper();
}

/**
 * 画像詳細モーダルを閉じるときのペイント編集セッション破棄。
 * 進行中ストロークの確定とポインタ操作状態のリセットを行う
 * （mask controller の `closeMaskEditorSession()` と同じパターン）。
 */
export function closePaintEditorSession() {
  cancelPendingPaintStrokeFlush();
  activePaintStroke = null;
}

registerActions({
  "toggle-paint-editor": () => {
    togglePaintEditor();
  },
  "paint-tool": (_id, target) => {
    setPaintTool(target.dataset.tool as PaintToolKind);
  },
  "paint-color": (_id, target) => {
    setPaintColor(target.dataset.color ?? "#ffffff");
  },
  "paint-clear": () => {
    clearActivePaintCanvas();
  },
  "paint-undo": () => {
    undoPaintStroke();
  }
});
