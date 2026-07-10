/**
 * モザイクツール(Docs/Feature-CGCollectionSuite.md P6)。成人向けCG集を DLsite/FANZA 等で頒布する際の
 * 修正(モザイク)要件に対応するための非破壊リージョンモデル。座標系は `pageObjects.ts`/`pageLayout.ts`
 * と同じ width-relative-top-left(x∈[0,1], y∈[0,page.height])。`pages.mosaic_json` に配列全体を保存する
 * (`objects_json`/`asset_paste_attachments` と同じ「1行に配列」パターン)。このモジュールは純ロジックのみ
 * (DOM・db・sharp 非依存)。
 *
 * 粒度規定(1粒 ≧ 画像長辺の1/100 かつ ≧ 4px、書き出し解像度基準)は `mosaicBlockSizePx` に一元化する
 * -- ユーザーが `granularity`(長辺比)を指定してもこの規定の下限を下回れない(max を取るだけ)。
 */
import { isJsonObject } from "./json";

export type MosaicShape =
  | { type: "rect"; bounds: [number, number, number, number] } // [x, y, w, h]
  | { type: "polygon"; points: [number, number][] };

export interface MosaicRegion {
  id: string;
  shape: MosaicShape;
  /** ブロック1辺 / 画像長辺の比。省略時は書き出し時に規定最小値を自動適用する。 */
  granularity?: number;
}

/** 1ページに保存できるリージョン数の上限(暴走 PATCH へのガード)。 */
export const MOSAIC_REGIONS_MAX_COUNT = 100;

/** 粒度規定: 1粒あたりの最小ピクセル数。 */
export const MOSAIC_MIN_BLOCK_PX = 4;
/** 粒度規定: 長辺の何分の1を最小ブロックサイズとするか。 */
export const MOSAIC_REGULATION_DIVISOR = 100;

/** リージョンの位置・サイズの取り得る範囲(page-width 単位)。normalize の clamp とデフォルト値生成に使う。 */
export const MOSAIC_COORD_MIN = -1;
export const MOSAIC_COORD_MAX = 10;
export const MOSAIC_SIZE_MIN = 0.005;
export const MOSAIC_SIZE_MAX = 10;

/** granularity(長辺比)の取り得る範囲。 */
export const MOSAIC_GRANULARITY_MIN = 0.0001;
export const MOSAIC_GRANULARITY_MAX = 0.5;

/** 新規矩形リージョンの既定サイズ(page-width 単位)。 */
export const DEFAULT_MOSAIC_RECT_SIZE: [number, number] = [0.2, 0.2];

/** 「粒度を指定」チェックを ON にした時の初期値(長辺比)。既定(自動)より少し粗い値にしておく。 */
export const DEFAULT_MOSAIC_GRANULARITY = 0.02;

/** 新規リージョン追加ドラッグ/クリックで許容する最小サイズ(page-width 単位)。これ未満は追加を破棄する。 */
export const MOSAIC_MIN_DRAG_SIZE = 0.01;

/** 多角形追加で「始点クリックによる閉包」を認識する距離しきい値(page-width 単位)。 */
export const MOSAIC_CLOSE_POLYGON_THRESHOLD = 0.02;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 書き出し解像度でのモザイクブロックサイズ(px)。成人向け規定「1粒 ≧ 画像長辺の1/100 かつ ≧ 4px」を
 * 常に満たすよう、規定の下限(`MOSAIC_MIN_BLOCK_PX` と `longSidePx/MOSAIC_REGULATION_DIVISOR` の大きい方)
 * と、ユーザー指定 `granularity` から求めたサイズの、大きい方を採用する
 * (`granularity` が規定より小さい値を指定しても下回れない)。
 */
export function mosaicBlockSizePx(longSidePx: number, granularity?: number): number {
  const safeLongSide = isFiniteNumber(longSidePx) && longSidePx > 0 ? longSidePx : 0;
  const regulationMin = Math.max(MOSAIC_MIN_BLOCK_PX, Math.ceil(safeLongSide / MOSAIC_REGULATION_DIVISOR));
  const fromGranularity =
    isFiniteNumber(granularity) && granularity > 0 ? Math.round(safeLongSide * granularity) : 0;
  return Math.max(regulationMin, fromGranularity);
}

/** リージョンの外接矩形([minX, minY, maxX, maxY]、page 座標系)。 */
export function regionBoundsPage(region: MosaicRegion): [number, number, number, number] {
  if (region.shape.type === "rect") {
    const [x, y, w, h] = region.shape.bounds;
    return [x, y, x + w, y + h];
  }
  const xs = region.shape.points.map((point) => point[0]);
  const ys = region.shape.points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function normalizeRectShape(raw: Record<string, unknown>): MosaicShape | null {
  const bounds = raw.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(isFiniteNumber)) {
    return null;
  }
  const [x, y, w, h] = bounds as [number, number, number, number];
  if (!(w > 0) || !(h > 0)) {
    return null;
  }
  return {
    type: "rect",
    bounds: [
      clampNumber(x, MOSAIC_COORD_MIN, MOSAIC_COORD_MAX),
      clampNumber(y, MOSAIC_COORD_MIN, MOSAIC_COORD_MAX),
      clampNumber(w, MOSAIC_SIZE_MIN, MOSAIC_SIZE_MAX),
      clampNumber(h, MOSAIC_SIZE_MIN, MOSAIC_SIZE_MAX)
    ]
  };
}

function normalizePolygonShape(raw: Record<string, unknown>): MosaicShape | null {
  const points = raw.points;
  if (!Array.isArray(points)) {
    return null;
  }
  const valid: [number, number][] = [];
  for (const entry of points) {
    if (Array.isArray(entry) && entry.length === 2 && isFiniteNumber(entry[0]) && isFiniteNumber(entry[1])) {
      valid.push([clampNumber(entry[0], MOSAIC_COORD_MIN, MOSAIC_COORD_MAX), clampNumber(entry[1], MOSAIC_COORD_MIN, MOSAIC_COORD_MAX)]);
    }
  }
  if (valid.length < 3) {
    return null;
  }
  return { type: "polygon", points: valid };
}

function normalizeShape(raw: unknown): MosaicShape | null {
  if (!isJsonObject(raw)) {
    return null;
  }
  if (raw.type === "rect") {
    return normalizeRectShape(raw);
  }
  if (raw.type === "polygon") {
    return normalizePolygonShape(raw);
  }
  return null;
}

function normalizeOne(raw: unknown, fallbackId: string): MosaicRegion | null {
  if (!isJsonObject(raw)) {
    return null;
  }
  const shape = normalizeShape(raw.shape);
  if (!shape) {
    return null;
  }
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : fallbackId;
  const region: MosaicRegion = { id, shape };
  if (isFiniteNumber(raw.granularity) && raw.granularity > 0) {
    region.granularity = clampNumber(raw.granularity, MOSAIC_GRANULARITY_MIN, MOSAIC_GRANULARITY_MAX);
  }
  return region;
}

/**
 * モザイクリージョン配列の正規化(`normalizePageObjects`/`normalizePanelCrop` と同じ役割)。
 * サーバ入力検証・クライアント読込の両方で使う。配列でない入力は空配列。型崩れ/頂点3未満の polygon/
 * 非正の rect サイズの要素は黙って捨て、数値は妥当な範囲へ clamp する。id 重複は末尾へ `_dup` を足して
 * 一意化する。
 */
export function normalizeMosaicRegions(raw: unknown): MosaicRegion[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const regions: MosaicRegion[] = [];
  const seenIds = new Set<string>();
  raw.forEach((entry, index) => {
    if (regions.length >= MOSAIC_REGIONS_MAX_COUNT) {
      return;
    }
    const normalized = normalizeOne(entry, `mosaic_${index + 1}`);
    if (!normalized) {
      return;
    }
    let id = normalized.id;
    while (seenIds.has(id)) {
      id = `${id}_dup`;
    }
    seenIds.add(id);
    regions.push({ ...normalized, id });
  });
  return regions;
}

/** 新規矩形リージョンを作る(page 座標の左上 x,y + 幅高さ)。 */
export function createRectMosaicRegion(id: string, x: number, y: number, w: number, h: number): MosaicRegion {
  return { id, shape: { type: "rect", bounds: [x, y, Math.max(MOSAIC_SIZE_MIN, w), Math.max(MOSAIC_SIZE_MIN, h)] } };
}

/** 新規多角形リージョンを作る(3点以上必須。呼び出し側が保証すること)。 */
export function createPolygonMosaicRegion(id: string, points: readonly [number, number][]): MosaicRegion {
  return { id, shape: { type: "polygon", points: points.map(([x, y]) => [x, y] as [number, number]) } };
}

/** 矩形リージョンのハンドル種別。corner: 0=左上,1=右上,2=右下,3=左下。 edge: 0=上,1=右,2=下,3=左。 */
export type MosaicRectHandleKind = "corner" | "edge";

/**
 * 矩形リージョンのコーナー/辺ハンドルドラッグ。コーナーは対角の頂点を固定して自由リサイズ、
 * 辺は対辺を固定して1軸だけリサイズする(典型的な矩形選択ハンドルの挙動)。最小サイズを下回る
 * ドラッグは、固定されている辺の位置を基準に最小サイズへ丸めて維持する(消失を防ぐ)。
 */
export function resizeMosaicRectBounds(
  bounds: readonly [number, number, number, number],
  handle: { kind: MosaicRectHandleKind; index: number },
  point: readonly [number, number],
  minSize: number = MOSAIC_SIZE_MIN
): [number, number, number, number] {
  const [x, y, w, h] = bounds;
  const left = x;
  const top = y;
  const right = x + w;
  const bottom = y + h;
  const px = isFiniteNumber(point[0]) ? point[0] : 0;
  const py = isFiniteNumber(point[1]) ? point[1] : 0;

  let nextLeft = left;
  let nextTop = top;
  let nextRight = right;
  let nextBottom = bottom;

  if (handle.kind === "corner") {
    const i = ((handle.index % 4) + 4) % 4;
    if (i === 0) {
      nextLeft = Math.min(px, right - minSize);
      nextTop = Math.min(py, bottom - minSize);
    } else if (i === 1) {
      nextRight = Math.max(px, left + minSize);
      nextTop = Math.min(py, bottom - minSize);
    } else if (i === 2) {
      nextRight = Math.max(px, left + minSize);
      nextBottom = Math.max(py, top + minSize);
    } else {
      nextLeft = Math.min(px, right - minSize);
      nextBottom = Math.max(py, top + minSize);
    }
  } else {
    const i = ((handle.index % 4) + 4) % 4;
    if (i === 0) {
      nextTop = Math.min(py, bottom - minSize);
    } else if (i === 1) {
      nextRight = Math.max(px, left + minSize);
    } else if (i === 2) {
      nextBottom = Math.max(py, top + minSize);
    } else {
      nextLeft = Math.min(px, right - minSize);
    }
  }

  return [nextLeft, nextTop, nextRight - nextLeft, nextBottom - nextTop];
}
