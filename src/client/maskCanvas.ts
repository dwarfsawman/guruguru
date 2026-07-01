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

export function renderFinalMaskToCanvas(canvas: HTMLCanvasElement, layers: MaskLayerSet, draft: InpaintDraft, includePreview: boolean) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  const samSource = includePreview && draft.previewSamMaskDataUrl ? layers.previewSamMask : layers.samMask;
  context.globalCompositeOperation = "source-over";
  context.drawImage(samSource, 0, 0, canvas.width, canvas.height);
  context.drawImage(layers.manualInclude, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "destination-out";
  context.drawImage(layers.manualErase, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "source-over";
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

export function maskLayerForStroke(layers: MaskLayerSet, kind: MaskStrokeKind) {
  if (kind === "manual-erase") {
    return layers.manualErase;
  }
  if (kind === "brush-prompt") {
    return layers.brushPrompt;
  }
  return layers.manualInclude;
}

export function paintStroke(canvas: HTMLCanvasElement, from: { x: number; y: number }, to: { x: number; y: number }, brushSize: number, compositeOperation: GlobalCompositeOperation) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.save();
  context.globalCompositeOperation = compositeOperation;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = brushSize;
  context.strokeStyle = "rgba(255, 255, 255, 1)";
  context.fillStyle = "rgba(255, 255, 255, 1)";
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
