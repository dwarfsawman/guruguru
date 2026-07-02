/**
 * マスク編集の canvas / 幾何 / layer 合成 helper。
 * `src/client/main.ts` から、DOM・state に依存しない pure helper を分離したもの。
 *
 * 挙動維持の重要点:
 * - 最終マスク合成は `finalMask = (samMask OR manualInclude) AND NOT manualErase` の意味。
 * - `renderFinalMaskToCanvas(..., includePreview=true)` では preview SAM mask を表示。
 * - `composeFinalMaskDataUrl(..., false)` は preview を確定 mask に含めない。
 * - 手動ペンは `manualInclude` に描き、同じ領域を `manualErase` から `destination-out` で削る。
 * - 消しゴムは `manualErase` に描く。
 * - `strokeStyle` / `fillStyle` は白、`lineCap` / `lineJoin` は round、点描画時の円処理を維持。
 *
 * 本 module は `main.ts` を import しない（circular import なし）。
 */
import type { WebSamBox, WebSamPoint } from "./websam/types";
import type { InpaintDraft, MaskLayerSet, MaskStrokeKind } from "./maskTypes";

export function createLayerCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * 空の layer set を構築する小 helper。
 * `ensureMaskLayerSet` / `getOrCreateMaskLayerSet` の重複 layer 初期化を減らすための純粋関数。
 * cache への登録は呼び出し側で行う。
 */
export function createMaskLayerSet(assetId: string, width: number, height: number): MaskLayerSet {
  return {
    assetId,
    width,
    height,
    samMask: createLayerCanvas(width, height),
    previewSamMask: createLayerCanvas(width, height),
    manualInclude: createLayerCanvas(width, height),
    manualErase: createLayerCanvas(width, height),
    brushPrompt: createLayerCanvas(width, height)
  };
}

export function clearCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  context?.clearRect(0, 0, canvas.width, canvas.height);
}

export function drawDataUrlIntoCanvas(canvas: HTMLCanvasElement, dataUrl: string) {
  if (!dataUrl) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const context = canvas.getContext("2d");
      if (context) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      }
      resolve();
    }, { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
    image.src = dataUrl;
  });
}

export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `renderFinalMaskToCanvas` に省略可能な `dirtyRect` を渡すと、その矩形だけを
 * `clearRect` + 9引数 `drawImage`（sub-rect 指定）で再合成する。省略時（undefined）は
 * 従来どおり全面再合成する。合成順序・globalCompositeOperation の意味論は不変。
 */
export function renderFinalMaskToCanvas(canvas: HTMLCanvasElement, layers: MaskLayerSet, draft: InpaintDraft, includePreview: boolean, dirtyRect?: DirtyRect) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const samSource = includePreview && draft.previewSamMaskDataUrl ? layers.previewSamMask : layers.samMask;
  context.globalCompositeOperation = "source-over";
  if (dirtyRect) {
    const rect = clampDirtyRectToCanvas(dirtyRect, canvas.width, canvas.height);
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    context.clearRect(rect.x, rect.y, rect.width, rect.height);
    context.drawImage(samSource, rect.x, rect.y, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
    context.drawImage(layers.manualInclude, rect.x, rect.y, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
    context.globalCompositeOperation = "destination-out";
    context.drawImage(layers.manualErase, rect.x, rect.y, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
    context.globalCompositeOperation = "source-over";
    return;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(samSource, 0, 0, canvas.width, canvas.height);
  context.drawImage(layers.manualInclude, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "destination-out";
  context.drawImage(layers.manualErase, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "source-over";
}

/**
 * 1 線分（brush stroke segment）の bbox をブラシ半径 + margin ぶん拡張した DirtyRect を返す。
 * from===to（点描画）の場合も arc 半径ぶん正しく含む。
 */
export function segmentDirtyRect(from: { x: number; y: number }, to: { x: number; y: number }, brushSize: number, margin = 0): DirtyRect {
  const radius = brushSize / 2 + margin;
  const minX = Math.min(from.x, to.x) - radius;
  const minY = Math.min(from.y, to.y) - radius;
  const maxX = Math.max(from.x, to.x) + radius;
  const maxY = Math.max(from.y, to.y) + radius;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 2つの DirtyRect の和集合（bounding box）を返す。 */
export function mergeDirtyRects(a: DirtyRect, b: DirtyRect): DirtyRect {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 複数線分（1 rAF フレームぶんの pending queue）をまとめた DirtyRect を返す。
 * 空配列の場合は null（呼び出し側は全面再合成にフォールバックすること）。
 */
export function dirtyRectForSegments(segments: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>, brushSize: number, margin = 0): DirtyRect | null {
  if (segments.length === 0) {
    return null;
  }
  let rect = segmentDirtyRect(segments[0]!.from, segments[0]!.to, brushSize, margin);
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index]!;
    rect = mergeDirtyRects(rect, segmentDirtyRect(segment.from, segment.to, brushSize, margin));
  }
  return rect;
}

/**
 * DirtyRect を canvas 境界内・整数ピクセルへクランプする。`clearRect` / sub-rect `drawImage` の
 * 引数は整数座標である必要はないが、境界外の負サイズ・NaN を避けるために正規化する。
 */
export function clampDirtyRectToCanvas(rect: DirtyRect, canvasWidth: number, canvasHeight: number): DirtyRect {
  const x1 = Math.max(0, Math.floor(rect.x));
  const y1 = Math.max(0, Math.floor(rect.y));
  const x2 = Math.min(canvasWidth, Math.ceil(rect.x + rect.width));
  const y2 = Math.min(canvasHeight, Math.ceil(rect.y + rect.height));
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

export function composeFinalMaskDataUrl(layers: MaskLayerSet, includeSamPreview = false) {
  const canvas = createLayerCanvas(layers.width, layers.height);
  const context = canvas.getContext("2d");
  if (!context) {
    return "";
  }
  context.drawImage(includeSamPreview ? layers.previewSamMask : layers.samMask, 0, 0);
  context.drawImage(layers.manualInclude, 0, 0);
  context.globalCompositeOperation = "destination-out";
  context.drawImage(layers.manualErase, 0, 0);
  context.globalCompositeOperation = "source-over";
  return canvasHasMaskPixels(canvas) ? canvas.toDataURL("image/png") : "";
}

/**
 * 現在の最終マスク（(sam OR manualInclude) AND NOT manualErase、`includeSamPreview` 時は
 * samMask の代わりに previewSamMask）を反転し、結果を manualInclude 層へ格納する。
 * 反転後は「単一の手動 include 層」として扱えるように samMask / previewSamMask / manualErase を
 * クリアする。呼び出し側は draft の各 dataUrl を再commitすること。
 */
export function invertMaskLayers(layers: MaskLayerSet, includeSamPreview: boolean) {
  const final = createLayerCanvas(layers.width, layers.height);
  const finalContext = final.getContext("2d");
  if (!finalContext) {
    return;
  }
  finalContext.drawImage(includeSamPreview ? layers.previewSamMask : layers.samMask, 0, 0);
  finalContext.drawImage(layers.manualInclude, 0, 0);
  finalContext.globalCompositeOperation = "destination-out";
  finalContext.drawImage(layers.manualErase, 0, 0);
  finalContext.globalCompositeOperation = "source-over";

  const includeContext = layers.manualInclude.getContext("2d");
  if (!includeContext) {
    return;
  }
  includeContext.save();
  includeContext.globalCompositeOperation = "source-over";
  includeContext.clearRect(0, 0, layers.width, layers.height);
  includeContext.fillStyle = "rgba(255, 255, 255, 1)";
  includeContext.fillRect(0, 0, layers.width, layers.height);
  includeContext.globalCompositeOperation = "destination-out";
  includeContext.drawImage(final, 0, 0);
  includeContext.restore();

  clearCanvas(layers.samMask);
  clearCanvas(layers.previewSamMask);
  clearCanvas(layers.manualErase);
}

export function maskLayerForStroke(layers: MaskLayerSet, kind: MaskStrokeKind) {
  if (kind === "manual-erase") {
    return layers.manualErase;
  }
  if (kind === "brush-prompt") {
    return layers.brushPrompt;
  }
  return layers.manualInclude;
}

export function paintStroke(canvas: HTMLCanvasElement, from: { x: number; y: number }, to: { x: number; y: number }, brushSize: number, compositeOperation: GlobalCompositeOperation, color = "rgba(255, 255, 255, 1)") {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.save();
  context.globalCompositeOperation = compositeOperation;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = brushSize;
  context.strokeStyle = color;
  context.fillStyle = color;
  if (from.x === to.x && from.y === to.y) {
    context.beginPath();
    context.arc(to.x, to.y, brushSize / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }
  context.restore();
}

export function canvasHasMaskPixels(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context || canvas.width <= 0 || canvas.height <= 0) {
    return false;
  }

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index]! > 0) {
      return true;
    }
  }
  return false;
}

export function pointerToMaskCanvasPoint(canvas: HTMLCanvasElement, event: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
  const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

export function normalizePromptBox(box: WebSamBox | null): WebSamBox | null {
  if (!box) {
    return null;
  }
  const x1 = Math.min(box.x1, box.x2);
  const x2 = Math.max(box.x1, box.x2);
  const y1 = Math.min(box.y1, box.y2);
  const y2 = Math.max(box.y1, box.y2);
  if (Math.abs(x2 - x1) < 2 || Math.abs(y2 - y1) < 2) {
    return null;
  }
  return { x1, y1, x2, y2 };
}

export function sampleBrushPromptPoints(canvas: HTMLCanvasElement, spacing: number, maxPoints: number): WebSamPoint[] {
  const context = canvas.getContext("2d");
  if (!context || canvas.width <= 0 || canvas.height <= 0) {
    return [];
  }
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const points: WebSamPoint[] = [];
  for (let y = Math.floor(spacing / 2); y < canvas.height; y += spacing) {
    for (let x = Math.floor(spacing / 2); x < canvas.width; x += spacing) {
      if (pixels[(y * canvas.width + x) * 4 + 3]! <= 0) {
        continue;
      }
      points.push({ x, y, label: 1, source: "brush" });
      if (points.length >= maxPoints) {
        return points;
      }
    }
  }
  return points;
}

export function distanceToSegmentSq(point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    return (point.x - from.x) ** 2 + (point.y - from.y) ** 2;
  }
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy)));
  const projectedX = from.x + t * dx;
  const projectedY = from.y + t * dy;
  return (point.x - projectedX) ** 2 + (point.y - projectedY) ** 2;
}
