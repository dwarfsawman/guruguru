/**
 * 貼り付けオブジェクトの変形数学 pure helper。
 * 座標系はすべて元画像の natural px / ラジアン(transform = translate(x,y)·rotate(θ)·scale(sx,sy)、
 * アンカーはオブジェクト中心)。DOM・state に依存せず、`main.ts` を import しない。
 * 回転は canvas 2D / SVG 属性内にのみ存在し CSS transform には入れない前提
 * (`pointerToMaskCanvasPoint` の成立条件)を崩さない。
 */
import type { PastedObject, PasteTransform } from "../shared/pasteAttachments";
import { PASTE_ROTATION_SNAP_DEG } from "../shared/pasteAttachments";

export interface PastePoint {
  x: number;
  y: number;
}

/** 軸平行の矩形(natural px)。dirtyRect 計算に使う。 */
export interface PasteBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PasteGestureKind = "move" | "scale" | "rotate";

/** 変形後の 4 頂点を [左上, 右上, 右下, 左下](ローカル基準)の順で返す。 */
export function pastedObjectCorners(object: PastedObject): PastePoint[] {
  const { sourceWidth, sourceHeight, transform } = object;
  const halfW = sourceWidth / 2;
  const halfH = sourceHeight / 2;
  const locals: PastePoint[] = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH }
  ];
  return locals.map((point) => localToWorld(transform, point));
}

/** ローカル座標(スケール・回転前)→ natural px。 */
export function localToWorld(transform: PasteTransform, point: PastePoint): PastePoint {
  const sx = point.x * transform.scaleX;
  const sy = point.y * transform.scaleY;
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: transform.x + sx * cos - sy * sin,
    y: transform.y + sx * sin + sy * cos
  };
}

/** natural px → ローカル座標(逆変換)。ヒットテストに使う。 */
export function worldToLocal(transform: PasteTransform, point: PastePoint): PastePoint {
  const dx = point.x - transform.x;
  const dy = point.y - transform.y;
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  const rx = dx * cos + dy * sin;
  const ry = -dx * sin + dy * cos;
  return {
    x: rx / transform.scaleX,
    y: ry / transform.scaleY
  };
}

/** 変形後 4 頂点の軸平行バウンディングボックス。 */
export function pastedObjectBounds(object: PastedObject, margin = 0): PasteBounds {
  const corners = pastedObjectCorners(object);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    minX = Math.min(minX, corner.x);
    minY = Math.min(minY, corner.y);
    maxX = Math.max(maxX, corner.x);
    maxY = Math.max(maxY, corner.y);
  }
  return {
    x: minX - margin,
    y: minY - margin,
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2
  };
}

/** 複数矩形の合併。空配列は null。ジェスチャ中の旧 bbox ∪ 新 bbox 再描画に使う。 */
export function unionPasteBounds(bounds: ReadonlyArray<PasteBounds>): PasteBounds | null {
  if (bounds.length === 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of bounds) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 点がオブジェクト内かどうか(逆変換でローカル矩形判定)。 */
export function pointInPastedObject(object: PastedObject, point: PastePoint): boolean {
  const local = worldToLocal(object.transform, point);
  return Math.abs(local.x) <= object.sourceWidth / 2 && Math.abs(local.y) <= object.sourceHeight / 2;
}

/** 最前面(配列末尾)から探索して最初にヒットしたオブジェクトを返す。 */
export function hitTestPastedObjects(objects: ReadonlyArray<PastedObject>, point: PastePoint): PastedObject | null {
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const object = objects[index]!;
    if (pointInPastedObject(object, point)) {
      return object;
    }
  }
  return null;
}

/** 移動ジェスチャ。axisLock(Shift)時は開始点からの主軸方向にのみ動かす。 */
export function applyMoveGesture(
  startTransform: PasteTransform,
  startPoint: PastePoint,
  currentPoint: PastePoint,
  axisLock = false
): PasteTransform {
  let dx = currentPoint.x - startPoint.x;
  let dy = currentPoint.y - startPoint.y;
  if (axisLock) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      dy = 0;
    } else {
      dx = 0;
    }
  }
  return { ...startTransform, x: startTransform.x + dx, y: startTransform.y + dy };
}

/**
 * 拡大縮小ジェスチャ(中心アンカー)。既定は uniform(回転が掛かっていても
 * 中心距離比なので数式が破綻しない)。independentAxes(Shift)時は
 * ローカル軸ごとの比で XY 独立にスケールする。
 */
export function applyScaleGesture(
  startTransform: PasteTransform,
  startPoint: PastePoint,
  currentPoint: PastePoint,
  independentAxes = false
): PasteTransform {
  const center = { x: startTransform.x, y: startTransform.y };
  if (!independentAxes) {
    const startDistance = Math.hypot(startPoint.x - center.x, startPoint.y - center.y);
    const currentDistance = Math.hypot(currentPoint.x - center.x, currentPoint.y - center.y);
    if (startDistance <= 0) {
      return { ...startTransform };
    }
    const factor = currentDistance / startDistance;
    return {
      ...startTransform,
      scaleX: startTransform.scaleX * factor,
      scaleY: startTransform.scaleY * factor
    };
  }
  const startLocal = rotateIntoLocal(startTransform, startPoint);
  const currentLocal = rotateIntoLocal(startTransform, currentPoint);
  const factorX = Math.abs(startLocal.x) > 1e-6 ? Math.abs(currentLocal.x / startLocal.x) : 1;
  const factorY = Math.abs(startLocal.y) > 1e-6 ? Math.abs(currentLocal.y / startLocal.y) : 1;
  return {
    ...startTransform,
    scaleX: startTransform.scaleX * factorX,
    scaleY: startTransform.scaleY * factorY
  };
}

/** 中心基準で回転だけ打ち消したローカル方向ベクトル(スケールは掛けない)。 */
function rotateIntoLocal(transform: PasteTransform, point: PastePoint): PastePoint {
  const dx = point.x - transform.x;
  const dy = point.y - transform.y;
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/** 回転ジェスチャ(中心周り atan2 差分)。snap(Shift)時は 15° 刻みへスナップ。 */
export function applyRotateGesture(
  startTransform: PasteTransform,
  startPoint: PastePoint,
  currentPoint: PastePoint,
  snap = false
): PasteTransform {
  const startAngle = Math.atan2(startPoint.y - startTransform.y, startPoint.x - startTransform.x);
  const currentAngle = Math.atan2(currentPoint.y - startTransform.y, currentPoint.x - startTransform.x);
  let rotation = startTransform.rotation + (currentAngle - startAngle);
  if (snap) {
    rotation = snapRotation(rotation, PASTE_ROTATION_SNAP_DEG);
  }
  return { ...startTransform, rotation };
}

/** ラジアン角を stepDeg 度刻みの最寄り値へスナップする。 */
export function snapRotation(rotation: number, stepDeg: number): number {
  const stepRad = (stepDeg * Math.PI) / 180;
  return Math.round(rotation / stepRad) * stepRad;
}

/** 矢印キーのナッジ(natural px)。 */
export function nudgeTransform(transform: PasteTransform, dx: number, dy: number): PasteTransform {
  return { ...transform, x: transform.x + dx, y: transform.y + dy };
}

/** スケールの下限(変形後の長辺 >= 8px)。 */
const PASTE_MIN_RESULT_LONG_EDGE = 8;
/** スケールの上限係数(変形後の短辺 <= canvas 長辺 × 4)。 */
const PASTE_MAX_RESULT_FACTOR = 4;

/**
 * 変形のクランプ。スケールは「変形後長辺 >= 8px」〜「変形後短辺 <= canvas 長辺 × 4」、
 * 中心はキャンバス矩形内(一部はみ出し配置は許可 — 端に寄せる合成の常套手段)。
 * 非有限値は安全側(scale 1 / 中心)へ戻す。
 */
export function clampPasteTransform(
  transform: PasteTransform,
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number
): PasteTransform {
  const longEdge = Math.max(sourceWidth, sourceHeight);
  const shortEdge = Math.max(1, Math.min(sourceWidth, sourceHeight));
  const minScale = PASTE_MIN_RESULT_LONG_EDGE / Math.max(1, longEdge);
  const maxScale = (PASTE_MAX_RESULT_FACTOR * Math.max(canvasWidth, canvasHeight)) / shortEdge;
  const clampScale = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) {
      return 1;
    }
    return Math.min(maxScale, Math.max(minScale, value));
  };
  const clampCoord = (value: number, max: number, fallback: number) => {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.min(max, Math.max(0, value));
  };
  return {
    x: clampCoord(transform.x, canvasWidth, canvasWidth / 2),
    y: clampCoord(transform.y, canvasHeight, canvasHeight / 2),
    rotation: Number.isFinite(transform.rotation) ? transform.rotation : 0,
    scaleX: clampScale(transform.scaleX),
    scaleY: clampScale(transform.scaleY)
  };
}

/** ドロップ直後の初期スケール係数(ベース画像の 60% に収める。拡大はしない)。 */
const PASTE_INITIAL_FIT_RATIO = 0.6;

/**
 * 初期配置の変形を求める。dropPoint(natural px)があればそこへ、無ければ中央へ。
 * スケールは「ベース画像の 60% に収まる縮小率」(拡大しない・uniform)。
 */
export function fitInitialPasteTransform(
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  dropPoint?: PastePoint | null
): PasteTransform {
  const scale = Math.min(
    1,
    (PASTE_INITIAL_FIT_RATIO * canvasWidth) / Math.max(1, sourceWidth),
    (PASTE_INITIAL_FIT_RATIO * canvasHeight) / Math.max(1, sourceHeight)
  );
  const transform: PasteTransform = {
    x: dropPoint ? dropPoint.x : canvasWidth / 2,
    y: dropPoint ? dropPoint.y : canvasHeight / 2,
    rotation: 0,
    scaleX: scale,
    scaleY: scale
  };
  return clampPasteTransform(transform, sourceWidth, sourceHeight, canvasWidth, canvasHeight);
}
