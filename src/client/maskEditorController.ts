import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { ensureInpaintDraft, inpaintDraftForAsset, setInpaintDraft, setInpaintEnabledForAsset } from "./draftStore";
import { ensureMaskLayerSet, getOrCreateMaskLayerSet, maskLayerCache } from "./maskLayerStore";
import { clampNumber } from "./clientUtils";
import { formatCssNumber } from "./format";
import { assetDimension, findAsset } from "./assetLookup";
import type { MaskPanelTab } from "./views/assetModal";
import type {
  ActiveImagePan,
  ActiveMaskStroke,
  InpaintDraft,
  MaskLayerSet,
  MaskBrushCursorKind,
  MaskStrokeKind
} from "./maskTypes";
import { hasMaskData, isMaskedContent } from "./maskDraft";
import {
  canvasHasMaskPixels,
  composeFinalMaskDataUrl,
  dirtyRectForSegments,
  distanceToSegmentSq,
  invertMaskLayers,
  maskLayerForStroke,
  paintStroke,
  pointerToMaskCanvasPoint,
  removeMaskIslandsFromLayers,
  renderFinalMaskToCanvas,
  renderMaskFeatherPreview,
  restoreMaskLayerSet,
  sampleBrushPromptPoints,
  snapshotMaskLayerSet
} from "./maskCanvas";
import {
  addWebSamPointPrompt,
  applySelectedSamCandidate,
  beginWebSamBoxPrompt,
  clearActiveWebSamBoxPrompt,
  requestWebSamDecode
} from "./webSamController";
import {
  clearSelectedPoseEdges,
  ensurePoseDraft,
  probeActivePoseModelCache
} from "./poseEditorController";
import { ensurePaintDraft, paintDraftForAsset, setPaintDraft } from "./paintEditorController";

let activeMaskStroke: ActiveMaskStroke | null = null;
let activeImagePan: ActiveImagePan | null = null;
let maskToolbarDrag: { pointerId: number; startX: number; startY: number; originLeft: number; originTop: number } | null = null;
let maskPanelResize: { pointerId: number; side: "left" | "right"; startX: number; startWidth: number; pendingWidth: number } | null = null;

type MaskDraftSnapshot = Pick<
  InpaintDraft,
  | "maskDataUrl"
  | "samMaskDataUrl"
  | "previewSamMaskDataUrl"
  | "manualIncludeMaskDataUrl"
  | "manualEraseMaskDataUrl"
  | "brushPromptMaskDataUrl"
  | "foregroundPoints"
  | "boxPrompt"
  | "samCandidates"
  | "selectedSamCandidateIndex"
>;

type MaskEditSnapshot = {
  layers: MaskLayerSet;
  draft: MaskDraftSnapshot;
};

const maskUndoStacks = new Map<string, MaskEditSnapshot[]>();
const MASK_UNDO_LIMIT = 20;

export function syncAssetModalMaskCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
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
    const featherCanvas = document.querySelector<HTMLCanvasElement>("#maskFeatherPreview");
    if (featherCanvas) {
      featherCanvas.width = width;
      featherCanvas.height = height;
    }
    const draft = inpaintDraftForAsset(canvas.dataset.assetId);
    if (!draft) {
      const context = canvas.getContext("2d");
      context?.clearRect(0, 0, width, height);
      featherCanvas?.getContext("2d")?.clearRect(0, 0, width, height);
      return;
    }
    if (draft.imageWidth !== width || draft.imageHeight !== height) {
      setInpaintDraft({ ...draft, imageWidth: width, imageHeight: height });
    }
    canvas.style.opacity = String(clampNumber(draft.maskOpacity, 0, 1, 0.58));
    void ensureMaskLayerSet(draft, width, height)
      .then((layers) => {
        if (!canvas.isConnected || canvas.dataset.assetId !== draft.parentAssetId) {
          return;
        }
        renderFinalMaskToCanvas(canvas, layers, draft, true);
        if (featherCanvas) {
          renderMaskFeatherPreview(featherCanvas, layers, draft);
        }
      })
      .catch((error) => {
        // レイヤ画像のロード失敗を unhandled rejection にしない(次の描画機会で再試行される)。
        pushToast(`マスクレイヤーの読み込みに失敗しました: ${error instanceof Error ? error.message : String(error)}`, "error");
      });
  };

  if (image.complete && image.naturalWidth > 0) {
    sync();
  } else {
    image.addEventListener("load", sync, { once: true });
  }

  canvas.addEventListener("pointermove", updateMaskBrushCursor);
  canvas.addEventListener("pointerdown", updateMaskBrushCursor);
  canvas.addEventListener("pointerenter", updateMaskBrushCursor);
  canvas.addEventListener("pointerleave", hideMaskBrushCursor);
  canvas.addEventListener("pointercancel", hideMaskBrushCursor);
}

function resolveMaskBrushCursorKind(draft: InpaintDraft): MaskBrushCursorKind | null {
  if (draft.eraser) {
    return "eraser";
  }
  if (draft.selectedSmartMaskProvider !== "manual") {
    return draft.webSamPromptMode === "brush" ? "brush-prompt" : null;
  }
  return "pen";
}

// Cached `.brush-cursor` element reference, avoiding a `document.querySelector` on every
// pointermove. `undefined` means "not resolved for the current render cycle yet"; `null` means
// "resolved, and the element does not currently exist". Invalidated by `invalidateMaskBrushCursorCache`,
// which `render()` calls after rebuilding `app.innerHTML` (the old element is detached each render).
let cachedMaskBrushCursor: SVGCircleElement | null | undefined;

export function invalidateMaskBrushCursorCache() {
  cachedMaskBrushCursor = undefined;
}

function getMaskBrushCursorElement(): SVGCircleElement | null {
  if (cachedMaskBrushCursor === undefined || cachedMaskBrushCursor === null || !cachedMaskBrushCursor.isConnected) {
    cachedMaskBrushCursor = document.querySelector<SVGCircleElement>(".brush-cursor");
  }
  return cachedMaskBrushCursor;
}

function updateMaskBrushCursor(event: PointerEvent) {
  const canvas = event.currentTarget as HTMLCanvasElement | null;
  if (!canvas || !state.maskEditMode || state.maskPanelTab === "pose") {
    return;
  }
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!draft) {
    hideMaskBrushCursor();
    return;
  }
  const kind = resolveMaskBrushCursorKind(draft);
  const cursor = getMaskBrushCursorElement();
  if (!cursor || !kind) {
    hideMaskBrushCursor();
    return;
  }
  const point = pointerToMaskCanvasPoint(canvas, event);
  const withinBounds =
    point.x >= 0 && point.x <= canvas.width && point.y >= 0 && point.y <= canvas.height;
  if (!withinBounds) {
    hideMaskBrushCursor();
    return;
  }
  cursor.setAttribute("cx", formatCssNumber(point.x));
  cursor.setAttribute("cy", formatCssNumber(point.y));
  cursor.setAttribute("r", formatCssNumber(draft.brushSize / 2));
  cursor.classList.remove("pen", "eraser", "brush-prompt");
  cursor.classList.add(kind);
  cursor.classList.add("visible");
}

function hideMaskBrushCursor() {
  const cursor = getMaskBrushCursorElement();
  if (!cursor) {
    return;
  }
  cursor.removeAttribute("r");
  cursor.setAttribute("r", "0");
  cursor.classList.remove("visible", "pen", "eraser", "brush-prompt");
}

function cloneMaskDraftSnapshot(draft: InpaintDraft): MaskDraftSnapshot {
  return {
    maskDataUrl: draft.maskDataUrl,
    samMaskDataUrl: draft.samMaskDataUrl,
    previewSamMaskDataUrl: draft.previewSamMaskDataUrl,
    manualIncludeMaskDataUrl: draft.manualIncludeMaskDataUrl,
    manualEraseMaskDataUrl: draft.manualEraseMaskDataUrl,
    brushPromptMaskDataUrl: draft.brushPromptMaskDataUrl,
    foregroundPoints: draft.foregroundPoints.map((point) => ({ ...point })),
    boxPrompt: draft.boxPrompt ? { ...draft.boxPrompt } : null,
    samCandidates: draft.samCandidates.map((candidate) => ({ ...candidate })),
    selectedSamCandidateIndex: draft.selectedSamCandidateIndex
  };
}

function pushMaskUndoSnapshot(assetId: string, width: number, height: number) {
  const draft = inpaintDraftForAsset(assetId);
  if (!draft) {
    return;
  }
  const layers = getOrCreateMaskLayerSet(assetId, width, height);
  const stack = maskUndoStacks.get(assetId) ?? [];
  stack.push({
    layers: snapshotMaskLayerSet(layers),
    draft: cloneMaskDraftSnapshot(draft)
  });
  while (stack.length > MASK_UNDO_LIMIT) {
    stack.shift();
  }
  maskUndoStacks.set(assetId, stack);
}

function clearMaskUndo(assetId: string | null | undefined) {
  if (assetId) {
    maskUndoStacks.delete(assetId);
  }
}

function undoMaskEdit() {
  if (!state.maskEditMode || state.maskPanelTab === "pose") {
    return;
  }
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  const assetId = canvas?.dataset.assetId ?? state.activeAssetId;
  if (!canvas || !assetId) {
    return;
  }
  cancelPendingMaskStrokeFlush();
  activeMaskStroke = null;
  const stack = maskUndoStacks.get(assetId);
  const snapshot = stack?.pop();
  if (!snapshot) {
    return;
  }
  const current = ensureInpaintDraft(assetId);
  const layers = getOrCreateMaskLayerSet(assetId, snapshot.layers.width, snapshot.layers.height);
  restoreMaskLayerSet(layers, snapshot.layers);
  const nextDraft: InpaintDraft = {
    ...current,
    ...snapshot.draft
  };
  setInpaintDraft(nextDraft);
  renderFinalMaskToCanvas(canvas, layers, nextDraft, true);
  const featherCanvas = document.querySelector<HTMLCanvasElement>("#maskFeatherPreview");
  if (featherCanvas && featherCanvas.dataset.assetId === assetId) {
    renderMaskFeatherPreview(featherCanvas, layers, nextDraft);
  }
  requestRender();
}

function commitMaskLayers(assetId: string) {
  const draft = inpaintDraftForAsset(assetId);
  const layers = draft ? maskLayerCache.get(assetId) : null;
  if (!draft || !layers) {
    return;
  }
  setInpaintDraft({
    ...draft,
    samMaskDataUrl: canvasHasMaskPixels(layers.samMask) ? layers.samMask.toDataURL("image/png") : "",
    previewSamMaskDataUrl: draft.previewSamMaskDataUrl,
    manualIncludeMaskDataUrl: canvasHasMaskPixels(layers.manualInclude) ? layers.manualInclude.toDataURL("image/png") : "",
    manualEraseMaskDataUrl: canvasHasMaskPixels(layers.manualErase) ? layers.manualErase.toDataURL("image/png") : "",
    brushPromptMaskDataUrl: canvasHasMaskPixels(layers.brushPrompt) ? layers.brushPrompt.toDataURL("image/png") : "",
    maskDataUrl: composeFinalMaskDataUrl(layers, false)
  });
  const featherCanvas = document.querySelector<HTMLCanvasElement>("#maskFeatherPreview");
  if (featherCanvas && featherCanvas.dataset.assetId === assetId) {
    renderMaskFeatherPreview(featherCanvas, layers, inpaintDraftForAsset(assetId) ?? draft);
  }
}

const BRUSH_PROMPT_POINT_SPACING = 48;
const BRUSH_PROMPT_MAX_POINTS = 48;

function finishBrushPromptStroke(canvas: HTMLCanvasElement) {
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  const draft = assetId ? ensureInpaintDraft(assetId) : null;
  const layers = assetId ? maskLayerCache.get(assetId) : null;
  if (!assetId || !draft || !layers) {
    return;
  }
  const manualPoints = draft.foregroundPoints.filter((point) => point.source !== "brush");
  const sampledPoints = sampleBrushPromptPoints(layers.brushPrompt, BRUSH_PROMPT_POINT_SPACING, BRUSH_PROMPT_MAX_POINTS);
  // TODO: also pass the brushPromptMask bounding box as a SAM box prompt when decoder quality needs the extra constraint.
  setInpaintDraft({
    ...draft,
    foregroundPoints: [...manualPoints, ...sampledPoints],
    brushPromptMaskDataUrl: canvasHasMaskPixels(layers.brushPrompt) ? layers.brushPrompt.toDataURL("image/png") : "",
    samCandidates: [],
    previewSamMaskDataUrl: "",
    maskDataUrl: composeFinalMaskDataUrl(layers, false)
  });
  requestRender();
  void requestWebSamDecode();
}

function removeBrushPromptPointsNearSegment(assetId: string, from: { x: number; y: number }, to: { x: number; y: number }, radius: number) {
  const draft = inpaintDraftForAsset(assetId);
  if (!draft || draft.foregroundPoints.length === 0) {
    return;
  }
  const radiusSq = radius * radius;
  const filtered = draft.foregroundPoints.filter((point) => {
    if (point.source !== "brush") {
      return true;
    }
    return distanceToSegmentSq(point, from, to) > radiusSq;
  });
  if (filtered.length !== draft.foregroundPoints.length) {
    setInpaintDraft({
      ...draft,
      foregroundPoints: filtered,
      samCandidates: [],
      previewSamMaskDataUrl: ""
    });
  }
}

const MASK_PANEL_MIN_WIDTH = 220;
const MASK_PANEL_MAX_WIDTH = 460;

/**
 * ドラッグ中は CSS 変数（`--mask-left-panel` / `--mask-right-panel`）だけを直接更新し、
 * pointerup 時に state へ確定する（wheel zoom / pan と同じ「操作中は render() しない」パターン）。
 */
function continueMaskPanelResize(event: PointerEvent) {
  if (!maskPanelResize) {
    return;
  }
  const delta = event.clientX - maskPanelResize.startX;
  const raw = maskPanelResize.side === "left"
    ? maskPanelResize.startWidth + delta
    : maskPanelResize.startWidth - delta;
  const width = clampNumber(raw, MASK_PANEL_MIN_WIDTH, MASK_PANEL_MAX_WIDTH, maskPanelResize.startWidth);
  maskPanelResize.pendingWidth = width;
  const layout = document.querySelector<HTMLElement>(".mask-editor-layout");
  layout?.style.setProperty(maskPanelResize.side === "left" ? "--mask-left-panel" : "--mask-right-panel", `${width}px`);
}

function finishMaskPanelResize() {
  if (!maskPanelResize) {
    return;
  }
  state.maskPanelWidths = {
    ...state.maskPanelWidths,
    [maskPanelResize.side]: maskPanelResize.pendingWidth
  };
  maskPanelResize = null;
  document.querySelector<HTMLElement>(".mask-panel-resizer.resizing")?.classList.remove("resizing");
}

function beginMaskToolbarDrag(event: PointerEvent, toolbar: HTMLElement) {
  const rect = toolbar.getBoundingClientRect();
  maskToolbarDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originLeft: rect.left,
    originTop: rect.top
  };
  try {
    toolbar.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture may fail if the element is not focusable; drag still works via app-level listeners.
  }
  toolbar.style.position = "fixed";
  toolbar.style.left = `${rect.left}px`;
  toolbar.style.top = `${rect.top}px`;
  toolbar.style.right = "auto";
}

function moveMaskToolbarDrag(event: PointerEvent, toolbar: HTMLElement) {
  if (!maskToolbarDrag) {
    return;
  }
  const dx = event.clientX - maskToolbarDrag.startX;
  const dy = event.clientY - maskToolbarDrag.startY;
  let left = maskToolbarDrag.originLeft + dx;
  let top = maskToolbarDrag.originTop + dy;
  const maxLeft = Math.max(0, window.innerWidth - toolbar.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - toolbar.offsetHeight);
  left = Math.max(0, Math.min(maxLeft, left));
  top = Math.max(0, Math.min(maxTop, top));
  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
}

function finishMaskToolbarDrag() {
  const toolbar = document.querySelector<HTMLElement>(".mask-toolbar");
  if (toolbar) {
    if (maskToolbarDrag) {
      try {
        toolbar.releasePointerCapture(maskToolbarDrag.pointerId);
      } catch {
        // Capture may already be released.
      }
    }
    const left = parseFloat(toolbar.style.left) || 0;
    const top = parseFloat(toolbar.style.top) || 0;
    state.maskToolbarPos = { left, top };
  }
  maskToolbarDrag = null;
}

function beginImagePan(event: PointerEvent, element: HTMLElement, assetId: string) {
  // paint 編集中の render は PaintDraft.panOffset を読む(assetModal.ts の zoomStyle)ため、
  // 開始オフセット・永続化先も PaintDraft に揃える(取り違えると pointerup 直後に snap-back する)。
  const draftKind = state.paintEditMode ? "paint" : "inpaint";
  const originOffset = draftKind === "paint" ? ensurePaintDraft(assetId).panOffset : ensureInpaintDraft(assetId).panOffset;
  activeImagePan = {
    pointerId: event.pointerId,
    assetId,
    startClient: { x: event.clientX, y: event.clientY },
    originOffset,
    draftKind
  };
  element.classList.add("panning");
  try {
    element.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture may fail if the pointer started on a child; document-level listeners still finish the pan.
  }
}

function continueImagePan(event: PointerEvent) {
  if (!activeImagePan) {
    return;
  }
  const nextOffset = {
    x: activeImagePan.originOffset.x + event.clientX - activeImagePan.startClient.x,
    y: activeImagePan.originOffset.y + event.clientY - activeImagePan.startClient.y
  };
  const media = document.querySelector<HTMLElement>(".preview-media");
  if (media) {
    media.style.setProperty("--mask-pan-x", `${formatCssNumber(nextOffset.x)}px`);
    media.style.setProperty("--mask-pan-y", `${formatCssNumber(nextOffset.y)}px`);
  }
}

function finishImagePan() {
  if (!activeImagePan) {
    return;
  }
  const media = document.querySelector<HTMLElement>(".preview-media");
  const left = media ? parseFloat(media.style.getPropertyValue("--mask-pan-x")) : activeImagePan.originOffset.x;
  const top = media ? parseFloat(media.style.getPropertyValue("--mask-pan-y")) : activeImagePan.originOffset.y;
  if (media) {
    media.classList.remove("panning");
    try {
      media.releasePointerCapture(activeImagePan.pointerId);
    } catch {
      // Capture may already be released.
    }
  }
  const panOffset = {
    x: Number.isFinite(left) ? left : activeImagePan.originOffset.x,
    y: Number.isFinite(top) ? top : activeImagePan.originOffset.y
  };
  if (activeImagePan.draftKind === "paint") {
    const paintDraft = paintDraftForAsset(activeImagePan.assetId);
    if (paintDraft) {
      setPaintDraft({ ...paintDraft, panOffset });
    }
  } else {
    const draft = inpaintDraftForAsset(activeImagePan.assetId);
    if (draft) {
      setInpaintDraft({ ...draft, panOffset });
    }
  }
  activeImagePan = null;
  requestRender();
}

export function clearActiveImagePan() {
  activeImagePan = null;
}

/**
 * bindEvents の pointerdown ハンドラから呼ばれるマスク編集系の分岐
 * （ツールバードラッグ / パネルリサイズ / 画像パン）。true を返した場合、
 * 呼び出し側は以降の分岐を処理しない（従来の early return と同じ扱い）。
 */
export function handleMaskEditorPointerDown(event: PointerEvent): boolean {
  const target = event.target as HTMLElement;
  const handle = target.closest<HTMLElement>("[data-mask-toolbar-handle]");
  if (handle) {
    if (target.closest("button")) {
      return true;
    }
    const toolbar = handle.closest<HTMLElement>(".mask-toolbar");
    if (toolbar) {
      if (toolbar.classList.contains("minimized")) {
        return true;
      }
      event.preventDefault();
      beginMaskToolbarDrag(event, toolbar);
    }
    return true;
  }
  const panelResizer = target.closest<HTMLElement>("[data-mask-panel-resizer]");
  if (panelResizer) {
    const side = panelResizer.dataset.maskPanelResizer === "right" ? "right" : "left";
    event.preventDefault();
    panelResizer.classList.add("resizing");
    maskPanelResize = {
      pointerId: event.pointerId,
      side,
      startX: event.clientX,
      startWidth: state.maskPanelWidths[side],
      pendingWidth: state.maskPanelWidths[side]
    };
    return true;
  }
  const previewMedia = target.closest<HTMLElement>(".preview-media");
  const activeAssetId = state.activeAssetId;
  const shouldPanImage =
    !!previewMedia &&
    !!activeAssetId &&
    (event.button === 1 || (!state.maskEditMode && !state.paintEditMode && event.button === 0));
  if (shouldPanImage) {
    event.preventDefault();
    beginImagePan(event, previewMedia, activeAssetId);
    return true;
  }
  return false;
}

export function handleMaskEditorPointerMove(event: PointerEvent): boolean {
  if (activeImagePan) {
    if (event.pointerId !== activeImagePan.pointerId) {
      return true;
    }
    event.preventDefault();
    continueImagePan(event);
    return true;
  }
  if (maskPanelResize) {
    if (event.pointerId !== maskPanelResize.pointerId) {
      return true;
    }
    event.preventDefault();
    continueMaskPanelResize(event);
    return true;
  }
  if (maskToolbarDrag) {
    if (event.pointerId !== maskToolbarDrag.pointerId) {
      return true;
    }
    const toolbar = document.querySelector<HTMLElement>(".mask-toolbar");
    if (toolbar) {
      event.preventDefault();
      moveMaskToolbarDrag(event, toolbar);
    }
    return true;
  }
  return false;
}

export function handleMaskEditorPointerUp(event: PointerEvent): boolean {
  if (activeImagePan && event.pointerId === activeImagePan.pointerId) {
    event.preventDefault();
    finishImagePan();
    return true;
  }
  if (maskPanelResize && event.pointerId === maskPanelResize.pointerId) {
    finishMaskPanelResize();
    return true;
  }
  if (maskToolbarDrag && event.pointerId === maskToolbarDrag.pointerId) {
    finishMaskToolbarDrag();
    return true;
  }
  return false;
}

export function handleMaskEditorPointerCancel(event: PointerEvent): boolean {
  if (activeImagePan && event.pointerId === activeImagePan.pointerId) {
    activeImagePan = null;
    return true;
  }
  if (maskPanelResize && event.pointerId === maskPanelResize.pointerId) {
    finishMaskPanelResize();
    return true;
  }
  if (maskToolbarDrag && event.pointerId === maskToolbarDrag.pointerId) {
    maskToolbarDrag = null;
    return true;
  }
  return false;
}

export function handleMaskPointerDown(event: PointerEvent, canvas: HTMLCanvasElement) {
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensureInpaintDraft(assetId);
  if (draft.selectedSmartMaskProvider !== "manual" && !draft.eraser) {
    if (draft.webSamPromptMode === "point") {
      addWebSamPointPrompt(event, canvas);
      return;
    }
    if (draft.webSamPromptMode === "box") {
      beginWebSamBoxPrompt(event, canvas);
      return;
    }
    beginMaskStroke(event, canvas, "brush-prompt");
    return;
  }
  beginMaskStroke(event, canvas, draft.eraser ? "manual-erase" : "manual-include");
}

/**
 * main.ts の pointerdown ハンドラから同じ優先順位で呼ばれる。maskCanvas 上の直接ストローク
 * 開始判定(maskEditMode かつ pose タブでない場合のみ)をまとめ、`handleMaskPointerDown` を呼ぶ。
 */
export function handleMaskStrokeStartPointerDown(event: PointerEvent): boolean {
  const target = event.target as HTMLElement;
  if (target.id !== "maskCanvas") {
    return false;
  }
  if (!state.maskEditMode || state.maskPanelTab === "pose") {
    return false;
  }
  event.preventDefault();
  handleMaskPointerDown(event, target as HTMLCanvasElement);
  return true;
}

let maskStrokeRafHandle: number | null = null;

function beginMaskStroke(event: PointerEvent, canvas: HTMLCanvasElement, kind: MaskStrokeKind) {
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  ensureInpaintDraft(assetId);
  pushMaskUndoSnapshot(assetId, canvas.width, canvas.height);
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    // capture 失敗でもストローク自体は app レベルの委譲で継続する(throw させると undo だけ積まれる)。
  }
  const point = pointerToMaskCanvasPoint(canvas, event);
  activeMaskStroke = {
    pointerId: event.pointerId,
    x: point.x,
    y: point.y,
    kind,
    pendingSegments: []
  };
  // The initial dab paints immediately (no pointermove/coalesced events exist yet for pointerdown),
  // so a single click without any drag still shows a mark right away.
  paintMaskSegments(canvas, [{ from: point, to: point }], kind);
}

function continueMaskStroke(event: PointerEvent, canvas: HTMLCanvasElement) {
  if (!activeMaskStroke) {
    return;
  }
  const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const pointerEvents = coalesced.length > 0 ? coalesced : [event];
  let cursor = { x: activeMaskStroke.x, y: activeMaskStroke.y };
  for (const pointerEvent of pointerEvents) {
    const point = pointerToMaskCanvasPoint(canvas, pointerEvent);
    activeMaskStroke.pendingSegments.push({ from: cursor, to: point });
    cursor = point;
  }
  activeMaskStroke.x = cursor.x;
  activeMaskStroke.y = cursor.y;
  scheduleMaskStrokeFlush(canvas);
}

export function handleMaskStrokePointerMove(event: PointerEvent): boolean {
  if (!activeMaskStroke) {
    return false;
  }
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  if (!canvas || event.pointerId !== activeMaskStroke.pointerId) {
    return true;
  }
  event.preventDefault();
  continueMaskStroke(event, canvas);
  return true;
}

export function handleMaskStrokePointerUp(event: PointerEvent): boolean {
  if (!activeMaskStroke || event.pointerId !== activeMaskStroke.pointerId) {
    return false;
  }
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  if (canvas) {
    event.preventDefault();
    finishMaskStroke(canvas);
  } else {
    // canvas が消えていても stroke を残さない(残すと以降のポインタイベントを飲み続ける)。
    cancelPendingMaskStrokeFlush();
    activeMaskStroke = null;
  }
  return true;
}

export function handleMaskStrokePointerCancel(event: PointerEvent): boolean {
  if (!activeMaskStroke || event.pointerId !== activeMaskStroke.pointerId) {
    return false;
  }
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  if (canvas) {
    finishMaskStroke(canvas);
  } else {
    cancelPendingMaskStrokeFlush();
    activeMaskStroke = null;
  }
  return true;
}

function scheduleMaskStrokeFlush(canvas: HTMLCanvasElement) {
  if (maskStrokeRafHandle !== null) {
    return;
  }
  maskStrokeRafHandle = requestAnimationFrame(() => {
    maskStrokeRafHandle = null;
    flushMaskStrokeQueue(canvas);
  });
}

export function cancelPendingMaskStrokeFlush() {
  if (maskStrokeRafHandle !== null) {
    cancelAnimationFrame(maskStrokeRafHandle);
    maskStrokeRafHandle = null;
  }
}

/**
 * Persists any pending wheel-zoom scale immediately (without waiting for the idle timer) and
 * clears the timer. Used when the mask editor closes mid-zoom so the last scale the user saw
 * is not silently lost, matching the pre-batching behavior where every tick persisted.
 */
export function flushPendingMaskWheelZoom() {
  if (maskWheelZoomIdleTimer !== null) {
    window.clearTimeout(maskWheelZoomIdleTimer);
    maskWheelZoomIdleTimer = null;
  }
  const pendingScale = maskWheelZoomPendingScale;
  maskWheelZoomPendingScale = null;
  if (pendingScale === null) {
    return;
  }
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!draft) {
    return;
  }
  setInpaintDraft({
    ...draft,
    zoomScale: pendingScale
  });
}

/** Paints and drains any queued pending segments for the active stroke, then re-composites once. */
function flushMaskStrokeQueue(canvas: HTMLCanvasElement) {
  if (!activeMaskStroke || activeMaskStroke.pendingSegments.length === 0) {
    return;
  }
  const segments = activeMaskStroke.pendingSegments;
  activeMaskStroke.pendingSegments = [];
  paintMaskSegments(canvas, segments, activeMaskStroke.kind);
}

function finishMaskStroke(canvas: HTMLCanvasElement) {
  cancelPendingMaskStrokeFlush();
  // Flush any segments queued for the next rAF so the final commit sees the full stroke.
  flushMaskStrokeQueue(canvas);
  if (activeMaskStroke) {
    try {
      canvas.releasePointerCapture(activeMaskStroke.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }
  const finishedKind = activeMaskStroke?.kind ?? "manual-include";
  activeMaskStroke = null;
  if (finishedKind === "brush-prompt") {
    finishBrushPromptStroke(canvas);
  } else {
    commitActiveMaskCanvas();
    // 最初のストロークで「マスクあり」に変わる表示(添付ランプ・mask active バッジ)を
    // 即時反映する(commit だけでは再描画されない)。
    requestRender();
  }
}

const MASK_DIRTY_RECT_MARGIN = 2;

/**
 * Paints a batch of line segments (1 rAF frame's worth, or a single pointerdown dab) into the
 * appropriate layer canvas(es), then re-composites the visible mask canvas exactly once for the
 * whole batch, limited to the dirty rect covering all segments (plus brush radius + margin).
 * Per-segment side effects (brush-prompt point removal near erase strokes) still run once per
 * segment so their distance-based logic is unaffected by batching.
 */
function paintMaskSegments(canvas: HTMLCanvasElement, segments: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>, kind: MaskStrokeKind) {
  if (segments.length === 0) {
    return;
  }
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  const draft = inpaintDraftForAsset(assetId) ?? (assetId ? ensureInpaintDraft(assetId) : null);
  if (!draft || !assetId) {
    return;
  }
  const layers = getOrCreateMaskLayerSet(assetId, canvas.width, canvas.height);
  const brushSize = draft.brushSize;

  for (const segment of segments) {
    if (kind === "manual-include") {
      // Add to the include layer, and lift any prior erase strokes in the same area so
      // a previously erased region can be re-masked by drawing over it with the pen.
      paintStroke(layers.manualInclude, segment.from, segment.to, brushSize, "source-over");
      paintStroke(layers.manualErase, segment.from, segment.to, brushSize, "destination-out");
    } else if (kind === "manual-erase") {
      paintStroke(layers.manualErase, segment.from, segment.to, brushSize, "source-over");
      removeBrushPromptPointsNearSegment(assetId, segment.from, segment.to, brushSize / 2);
    } else {
      paintStroke(maskLayerForStroke(layers, kind), segment.from, segment.to, brushSize, "source-over");
    }
  }
  const dirtyRect = dirtyRectForSegments(segments, brushSize, MASK_DIRTY_RECT_MARGIN) ?? undefined;
  renderFinalMaskToCanvas(canvas, layers, draft, true, dirtyRect);
}

export function commitActiveMaskCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  if (canvas) {
    commitMaskCanvas(canvas);
  }
}

function commitMaskCanvas(canvas: HTMLCanvasElement) {
  const assetId = canvas?.dataset.assetId ?? state.activeAssetId;
  if (!canvas || !assetId) {
    return;
  }

  commitMaskLayers(assetId);
}

export function updateInpaintDraftFromControl(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const field = control.dataset.inpaintField;
  if (!field) {
    return;
  }

  const assetId = state.generationDraft?.inpaint?.parentAssetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }

  const current = ensureInpaintDraft(assetId);
  const next: InpaintDraft = { ...current };
  if (field === "enabled" && control instanceof HTMLInputElement) {
    // タブのチェックボックス: マスクを次回生成に添付するか（編集モードとは独立）
    next.enabled = control.checked;
    setInpaintDraft(next);
    requestRender();
    return;
  }
  if (field === "maskedContent" && isMaskedContent(control.value)) {
    next.maskedContent = control.value;
  } else if (field === "inpaintArea") {
    next.inpaintArea = "only_masked";
  } else if (field === "onlyMaskedPadding") {
    next.onlyMaskedPadding = clampNumber(Number(control.value), 0, 512, 32);
  } else if (field === "featherRadius") {
    next.featherRadius = clampNumber(Number(control.value), 0, 30, 0);
  } else if (field === "brushSize") {
    next.brushSize = clampNumber(Number(control.value), 1, 256, 48);
  }
  setInpaintDraft(next);
  if (field === "featherRadius") {
    refreshMaskFeatherPreview(assetId, next);
  }
}

/** feather スライダー操作中に、全体 render() なしで境界プレビューだけを更新する軽量パス。 */
function refreshMaskFeatherPreview(assetId: string, draft: InpaintDraft) {
  const featherCanvas = document.querySelector<HTMLCanvasElement>("#maskFeatherPreview");
  const layers = maskLayerCache.get(assetId);
  if (!featherCanvas || !layers || featherCanvas.dataset.assetId !== assetId) {
    return;
  }
  renderMaskFeatherPreview(featherCanvas, layers, draft);
}

const MASK_WHEEL_ZOOM_IDLE_MS = 150;
let maskWheelZoomIdleTimer: number | null = null;
let maskWheelZoomPendingScale: number | null = null;

/**
 * Wheel zoom ticks update `--mask-zoom` directly on `.preview-media` (same element/mechanism
 * `continueImagePan` uses for `--mask-pan-x`/`--mask-pan-y`), skipping the full `render()` per tick.
 * Once wheel input goes idle (~150ms), the final scale is persisted to the draft and `render()`
 * runs once, mirroring `finishImagePan`'s persist-on-release pattern.
 */
export function handleMaskWheelZoom(event: WheelEvent) {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  if (!assetId) {
    return;
  }
  const draft = ensureInpaintDraft(assetId);
  const currentScale = maskWheelZoomPendingScale ?? draft.zoomScale;
  const direction = event.deltaY < 0 ? 1 : -1;
  const nextScale = clampNumber(currentScale + direction * 0.12, 0.25, 4, 1);
  maskWheelZoomPendingScale = nextScale;

  const media = document.querySelector<HTMLElement>(".preview-media");
  media?.style.setProperty("--mask-zoom", formatCssNumber(nextScale));

  if (maskWheelZoomIdleTimer !== null) {
    window.clearTimeout(maskWheelZoomIdleTimer);
  }
  maskWheelZoomIdleTimer = window.setTimeout(() => {
    maskWheelZoomIdleTimer = null;
    const pendingScale = maskWheelZoomPendingScale;
    maskWheelZoomPendingScale = null;
    if (pendingScale === null) {
      return;
    }
    const latestDraft = inpaintDraftForAsset(assetId) ?? draft;
    setInpaintDraft({
      ...latestDraft,
      zoomScale: pendingScale
    });
    requestRender();
  }, MASK_WHEEL_ZOOM_IDLE_MS);
}

function setMaskPanelTab(tab: MaskPanelTab) {
  if (state.maskPanelTab === tab) {
    return;
  }
  clearSelectedPoseEdges();
  if (tab === "pose") {
    // マスクタブを離れる前に描画途中のストロークを確定しておく
    commitActiveMaskCanvas();
    if (state.activeAssetId) {
      ensurePoseDraft(state.activeAssetId);
      // キャッシュ済みモデルなら自動でロード（再試行ボタン不要）。未取得は自動DLしない。
      probeActivePoseModelCache();
    }
  }
  state.maskPanelTab = tab;
  requestRender();
}

/**
 * 生成リクエストへ渡す最終マスクを解決する。
 * 未適用の SAM 候補 preview が表示されている場合は、キャンバス表示と同じ意味論
 * （preview SAM OR manualInclude、AND NOT manualErase）で合成し直す。
 * これにより「SAM候補を適用せず手動マスクと併用して生成すると手動領域だけが
 * inpaintされる」不整合を防ぐ。layer cache が無い場合は commit 済みの
 * `maskDataUrl` にフォールバックする（その場合 preview も画面に出ていない）。
 */
export function effectiveMaskDataUrl(draft: InpaintDraft): string {
  if (draft.previewSamMaskDataUrl) {
    const layers = maskLayerCache.get(draft.parentAssetId);
    if (layers) {
      return composeFinalMaskDataUrl(layers, true);
    }
  }
  return draft.maskDataUrl;
}

function toggleMaskEditor() {
  // 編集モードの開閉のみを扱い、添付状態（InpaintDraft.enabled）は変更しない。
  // 添付のON/OFFはタブのチェックボックス／「適用」で独立して制御する。
  if (state.maskEditMode) {
    commitActiveMaskCanvas();
    state.maskEditMode = false;
    state.maskToolbarMinimized = false;
  } else if (state.activeAssetId) {
    ensureInpaintDraft(state.activeAssetId);
    state.maskEditMode = true;
    state.maskToolbarMinimized = false;
    state.paintEditMode = false;
  }
  state.maskToolbarPos = null;
  requestRender();
}

/** Asset detailを外部の候補カードから開いた直後、既存のマスク編集sessionを開始する。 */
export function openMaskEditorForActiveAsset() {
  if (!state.maskEditMode && state.activeAssetId) toggleMaskEditor();
}

async function applyMaskEditor() {
  commitActiveMaskCanvas();
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!assetId || !draft) {
    return;
  }
  if (draft.samCandidates.length > 0 && draft.previewSamMaskDataUrl) {
    await applySelectedSamCandidate();
    return;
  }
  setInpaintDraft({
    ...draft,
    enabled: true
  });
  state.message = hasMaskData(draft) ? "マスクを適用しました。" : "マスクがありません。";
  requestRender();
}

function setMaskTool(eraser: boolean) {
  if (!state.activeAssetId) {
    return;
  }
  const draft = ensureInpaintDraft(state.activeAssetId);
  const next: InpaintDraft = {
    ...draft,
    eraser
  };
  if (!eraser && draft.selectedSmartMaskProvider !== "manual") {
    next.selectedSmartMaskProvider = "manual";
    next.webSamStatusText = "Manual";
  }
  setInpaintDraft({
    ...next
  });
  requestRender();
}

/**
 * 表示中の最終マスク（未適用の SAM 候補 preview を含む）を反転し、
 * 反転結果を単一の手動 include 層として commit する。
 */
async function invertActiveMask() {
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  const assetId = canvas?.dataset.assetId ?? state.activeAssetId;
  if (!canvas || !assetId || canvas.width <= 0 || canvas.height <= 0) {
    return;
  }
  const draft = ensureInpaintDraft(assetId);
  const layers = await ensureMaskLayerSet(draft, canvas.width, canvas.height);
  pushMaskUndoSnapshot(assetId, canvas.width, canvas.height);
  invertMaskLayers(layers, !!draft.previewSamMaskDataUrl);
  const nextDraft: InpaintDraft = {
    ...draft,
    samMaskDataUrl: "",
    previewSamMaskDataUrl: "",
    samCandidates: [],
    selectedSamCandidateIndex: 0,
    manualIncludeMaskDataUrl: canvasHasMaskPixels(layers.manualInclude) ? layers.manualInclude.toDataURL("image/png") : "",
    manualEraseMaskDataUrl: "",
    maskDataUrl: composeFinalMaskDataUrl(layers, false)
  };
  setInpaintDraft(nextDraft);
  renderFinalMaskToCanvas(canvas, layers, nextDraft, false);
  state.message = "マスク領域を反転しました。";
  requestRender();
}

/**
 * 微小な島マスク除去のしきい値（面積 px^2）。画像解像度に比例させ、短辺の 0.4% を半径とする
 * 円の面積を目安にする（例: 短辺1024pxなら半径約4px、短辺4000pxなら半径16px）。
 */
function maskIslandMinAreaPx(width: number, height: number) {
  const radius = Math.max(3, Math.round(Math.min(width, height) * 0.004));
  return Math.round(Math.PI * radius * radius);
}

function removeSmallMaskIslands() {
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  const assetId = canvas?.dataset.assetId ?? state.activeAssetId;
  if (!canvas || !assetId || canvas.width <= 0 || canvas.height <= 0) {
    return;
  }
  const draft = inpaintDraftForAsset(assetId);
  const layers = maskLayerCache.get(assetId);
  if (!draft || !layers) {
    return;
  }
  const minAreaPx = maskIslandMinAreaPx(canvas.width, canvas.height);
  pushMaskUndoSnapshot(assetId, canvas.width, canvas.height);
  const changed = removeMaskIslandsFromLayers(layers, !!draft.previewSamMaskDataUrl, minAreaPx);
  if (!changed) {
    maskUndoStacks.get(assetId)?.pop();
    state.message = "微小なマスク領域は見つかりませんでした。";
    requestRender();
    return;
  }
  const nextDraft: InpaintDraft = {
    ...draft,
    samMaskDataUrl: "",
    previewSamMaskDataUrl: "",
    samCandidates: [],
    selectedSamCandidateIndex: 0,
    manualIncludeMaskDataUrl: canvasHasMaskPixels(layers.manualInclude) ? layers.manualInclude.toDataURL("image/png") : "",
    manualEraseMaskDataUrl: "",
    maskDataUrl: composeFinalMaskDataUrl(layers, false)
  };
  setInpaintDraft(nextDraft);
  renderFinalMaskToCanvas(canvas, layers, nextDraft, false);
  state.message = "微小なマスク領域を除去しました。";
  requestRender();
}

function clearActiveMaskCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  const assetId = canvas?.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  if (canvas) {
    pushMaskUndoSnapshot(assetId, canvas.width, canvas.height);
  }
  maskLayerCache.delete(assetId);
  const draft = ensureInpaintDraft(assetId);
  setInpaintDraft({
    ...draft,
    maskDataUrl: "",
    samMaskDataUrl: "",
    previewSamMaskDataUrl: "",
    manualIncludeMaskDataUrl: "",
    manualEraseMaskDataUrl: "",
    brushPromptMaskDataUrl: "",
    foregroundPoints: [],
    boxPrompt: null,
    samCandidates: [],
    selectedSamCandidateIndex: 0,
    webSamError: "",
    webSamStatusText: draft.selectedSmartMaskProvider === "manual" ? draft.webSamStatusText : "Ready"
  });
  requestRender();
}

function clearInpaintDraft() {
  cancelPendingMaskStrokeFlush();
  activeMaskStroke = null;
  clearActiveWebSamBoxPrompt();
  if (state.activeAssetId) {
    maskLayerCache.delete(state.activeAssetId);
    clearMaskUndo(state.activeAssetId);
  }
  setInpaintDraft(null);
  requestRender();
}

/**
 * 画像詳細モーダルを閉じるときのマスク編集セッション破棄。
 * 進行中ストロークの確定・保留中の wheel zoom 永続化・ポインタ操作状態のリセットを行う。
 */
export function closeMaskEditorSession() {
  commitActiveMaskCanvas();
  cancelPendingMaskStrokeFlush();
  flushPendingMaskWheelZoom();
  activeMaskStroke = null;
  activeImagePan = null;
  maskToolbarDrag = null;
  // Undoスタックはフル解像度canvasを保持する(2048²で1件≒84MB)。モーダルを閉じたら
  // 全アセット分を破棄しないとGB級のメモリリークになる。
  maskUndoStacks.clear();
}

export function handleMaskEditorKeydown(event: KeyboardEvent): boolean {
  if (!state.maskEditMode || state.maskPanelTab === "pose") {
    return false;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undoMaskEdit();
    return true;
  }
  return false;
}

/**
 * タブ横のランプ(四角トグル)によるマスク添付の ON/OFF。
 * マスク未作成(データなし)のときは何もしない(ランプ側も disabled 灰色)。
 * なお enabled=true でもマスクが空なら inpaint リクエストは組まれない
 * (`inpaintRequestForParent` が有効な maskDataUrl を要求する)ため、生成には影響しない。
 * SAM 候補プレビューが未適用(`previewSamMaskDataUrl` のみで `maskDataUrl` 未確定)のときは、
 * ランプを有効表示にしている都合上、トグル ON 操作で候補を確定適用してから有効化する。
 */
async function toggleMaskAttach() {
  commitActiveMaskCanvas();
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  let draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!draft) {
    return;
  }
  if (!hasMaskData(draft)) {
    if (!draft.previewSamMaskDataUrl) {
      return;
    }
    await applySelectedSamCandidate();
    draft = assetId ? inpaintDraftForAsset(assetId) : null;
    if (!draft || !hasMaskData(draft)) {
      return;
    }
    setInpaintDraft({ ...draft, enabled: true });
    requestRender();
    return;
  }
  setInpaintDraft({ ...draft, enabled: !draft.enabled });
  requestRender();
}

/**
 * グリッドの MASK バッジ用の添付トグル。対象がモーダルで開いている active asset なら
 * 既存の `toggleMaskAttach`(SAM 候補の自動確定込み)に委譲し、それ以外(グリッド上の
 * 非 active asset)は `setInpaintEnabledForAsset` で `enabled` だけを直接切り替える。
 */
function toggleMaskAttachForAsset(assetId: string | null) {
  const targetId = assetId || state.activeAssetId;
  if (!targetId) {
    return;
  }
  if (targetId === state.activeAssetId) {
    void toggleMaskAttach();
    return;
  }
  const draft = inpaintDraftForAsset(targetId);
  if (!draft || !hasMaskData(draft)) {
    return;
  }
  setInpaintEnabledForAsset(targetId, !draft.enabled);
  requestRender();
}

registerActions({
  "toggle-mask-editor": () => {
    toggleMaskEditor();
  },
  "toggle-mask-attach": (id) => {
    toggleMaskAttachForAsset(id || null);
  },
  "apply-mask-editor": () => applyMaskEditor(),
  "minimize-mask-toolbar": () => {
    state.maskToolbarMinimized = true;
    requestRender();
  },
  "restore-mask-toolbar": () => {
    state.maskToolbarMinimized = false;
    requestRender();
  },
  "mask-tool": (_id, target) => {
    setMaskTool(target.dataset.tool === "eraser");
  },
  "clear-mask": () => {
    clearActiveMaskCanvas();
  },
  "mask-undo": () => {
    undoMaskEdit();
  },
  "invert-mask": () => invertActiveMask(),
  "remove-mask-islands": () => {
    removeSmallMaskIslands();
  },
  "set-mask-panel-tab": (_id, target) => {
    setMaskPanelTab(target.dataset.tab === "pose" ? "pose" : "mask");
  },
  "clear-inpaint": () => {
    clearInpaintDraft();
  }
});
