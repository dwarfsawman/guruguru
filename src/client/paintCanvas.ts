/**
 * ペイントツールの canvas / layer 合成 helper。
 * `maskCanvas.ts` と同様、`main.ts` から DOM に依存する pure helper を分離したもの。
 * 描画パスは `maskCanvas.ts` の rAF バッチ + dirtyRect 合成パターンを踏襲する
 * （`paintStroke` / `dirtyRectForSegments` / `pointerToMaskCanvasPoint` をそのまま再利用）。
 *
 * - ペイントレイヤーは 1 枚の natural-size offscreen canvas（`paintLayerCache`）。元画像には触れない。
 * - ブラシは source-over、消しゴムは destination-out でこのレイヤーにのみ描く。
 * - スポイトは「元画像 + ペイントレイヤー」を合成した offscreen canvas から採色する。
 * - 保存は同じ合成を PNG 化して source-assets API に渡す。
 *
 * 本 module は `main.ts` を import しない（circular import なし）。
 */
import { createLayerCanvas, type DirtyRect } from "./maskCanvas";

export function createPaintLayerCanvas(width: number, height: number): HTMLCanvasElement {
  return createLayerCanvas(width, height);
}

/**
 * ペイントレイヤーを可視 canvas へそのまま複製する（マスクと違い合成順序は単純：
 * レイヤーの中身がそのまま見た目になる）。`dirtyRect` を渡すとその矩形だけを再描画する。
 */
export function renderPaintLayerToCanvas(canvas: HTMLCanvasElement, layer: HTMLCanvasElement, dirtyRect?: DirtyRect) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  if (dirtyRect) {
    const x = Math.max(0, Math.floor(dirtyRect.x));
    const y = Math.max(0, Math.floor(dirtyRect.y));
    const x2 = Math.min(canvas.width, Math.ceil(dirtyRect.x + dirtyRect.width));
    const y2 = Math.min(canvas.height, Math.ceil(dirtyRect.y + dirtyRect.height));
    const width = Math.max(0, x2 - x);
    const height = Math.max(0, y2 - y);
    if (width <= 0 || height <= 0) {
      return;
    }
    context.clearRect(x, y, width, height);
    context.drawImage(layer, x, y, width, height, x, y, width, height);
    return;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(layer, 0, 0, canvas.width, canvas.height);
}

/** 貼り付けオブジェクトの合成入力(z順)。ビットマップ+変形のみの純データ。 */
export interface ComposedPasteLayer {
  bitmap: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  transform: { x: number; y: number; rotation: number; scaleX: number; scaleY: number };
}

/**
 * 元画像（`image`）+ ペイントレイヤー(+ 貼り付けオブジェクト z順)の合成結果を
 * 新規 offscreen canvas に描き、返す。スポイトの採色・保存時の PNG 化・生成時の
 * pasteComposite 作成で共通利用する。画像は同一オリジン配信のため canvas taint なし。
 * `pastedLayers` 省略時は従来どおりの 2 層合成(既存呼び出し不変)。
 */
export function composePaintResultCanvas(
  image: CanvasImageSource,
  layer: HTMLCanvasElement | null,
  width: number,
  height: number,
  pastedLayers: ReadonlyArray<ComposedPasteLayer> = []
): HTMLCanvasElement {
  const canvas = createLayerCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) {
    return canvas;
  }
  context.drawImage(image, 0, 0, width, height);
  if (layer) {
    context.drawImage(layer, 0, 0, width, height);
  }
  for (const pasted of pastedLayers) {
    context.save();
    context.translate(pasted.transform.x, pasted.transform.y);
    context.rotate(pasted.transform.rotation);
    context.scale(pasted.transform.scaleX, pasted.transform.scaleY);
    context.imageSmoothingQuality = "high";
    context.drawImage(pasted.bitmap, -pasted.sourceWidth / 2, -pasted.sourceHeight / 2);
    context.restore();
  }
  return canvas;
}

/** 合成 canvas 上の 1 点から `#rrggbb` 形式で採色する。範囲外や透明ピクセルは null。 */
export function sampleColorAt(canvas: HTMLCanvasElement, x: number, y: number): string | null {
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) {
    return null;
  }
  const pixel = context.getImageData(px, py, 1, 1).data;
  const toHex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${toHex(pixel[0]!)}${toHex(pixel[1]!)}${toHex(pixel[2]!)}`;
}

/** ペイントレイヤーの現時点のスナップショット（複製 canvas）を返す。Undo リングバッファ用。 */
export function snapshotPaintLayer(layer: HTMLCanvasElement): HTMLCanvasElement {
  const snapshot = createLayerCanvas(layer.width, layer.height);
  const context = snapshot.getContext("2d");
  context?.drawImage(layer, 0, 0);
  return snapshot;
}

/** Undo: スナップショットの内容をペイントレイヤーへ書き戻す（レイヤー全体を置き換え）。 */
export function restorePaintLayerFromSnapshot(layer: HTMLCanvasElement, snapshot: HTMLCanvasElement) {
  const context = layer.getContext("2d");
  if (!context) {
    return;
  }
  context.clearRect(0, 0, layer.width, layer.height);
  context.drawImage(snapshot, 0, 0);
}
