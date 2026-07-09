/**
 * ページのコマ割り(漫画パネルレイアウト)の共有モデル。
 *
 * Book のページに `layout_json` として紐づく正規化レイアウト。`dwarfsawman/guruguru-layout-template`
 * (SPEC v0.2) の `.guruguru-layout.json5` を取り込む際の正規化先でもある。座標系は元フォーマットと同じ
 * **width-relative-top-left**(origin=top-left, x∈[0,1], y∈[0,page.height], 長さの単位=page-width)。
 *
 * このモジュールは純ロジックのみ(json5 依存を持たない)。取り込み時のテキスト→オブジェクト変換は
 * サーバ側(`src/server/layoutTemplates.ts`)で `JSON5.parse` してからここへ渡す。balloons/texts は
 * 将来機能(吹き出し追加・翻訳)のために保持だけする。
 */
import { isJsonObject } from "./json";

/** パネル(コマ)形状。将来のコマ形状編集に備え polygon 以外も型で受ける。 */
export type PanelShape =
  | { type: "polygon"; points: [number, number][] }
  | { type: "rect"; bounds: [number, number, number, number]; cornerRadius?: number }
  | { type: "ellipse"; center: [number, number]; radius: [number, number] }
  | { type: "path"; d: string };

/** コマ枠の描画スタイル。style は元フォーマットの意味(solid/none/wavy/cloud/jagged/custom)を保持。 */
export interface PanelFrame {
  visible: boolean;
  style: string;
  /** 線幅(page-width 単位)。 */
  strokeWidth: number;
  strokeColor: string;
}

export interface LayoutPanel {
  id: string;
  /** 読み順(昇順)。 */
  order: number;
  shape: PanelShape;
  /** 未指定なら描画側の既定枠を使う。 */
  frame?: PanelFrame;
}

/** 将来機能(吹き出し)の予約型。今回は生成しないが取り込み時に保持する。 */
export interface LayoutBalloon {
  id: string;
  order?: number;
  shape?: PanelShape;
  kind?: string;
  scope?: string;
  [key: string]: unknown;
}

/** ページのコマ割りレイアウト(1ページ分)。 */
export interface PageLayout {
  version: 1;
  page: {
    /** [w, h] の比。描画のアスペクト比に使う。 */
    aspectRatio: [number, number];
    /** width=1 に正規化したときの高さ(y の最大値)。 */
    height: number;
  };
  readingDirection: "rtl" | "ltr";
  panels: LayoutPanel[];
  /** 予約(将来: 吹き出し追加)。 */
  balloons?: LayoutBalloon[];
  /** 予約(将来: テキスト/翻訳)。 */
  texts?: unknown[];
  /** 取り込み元の素性(再エクスポートや表示用)。 */
  source?: { format: "guruguru-layout"; schemaVersion?: string; title?: string };
}

/** 既定のコマ枠(元フォーマットの defaults に近い値)。取り込み/プリセットで frame 未指定時に使う。 */
export const DEFAULT_PANEL_FRAME: PanelFrame = {
  visible: true,
  style: "solid",
  strokeWidth: 0.006,
  strokeColor: "#000000"
};

const EPSILON = 1e-9;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** [number, number] の数値ペアを厳密に取り出す(不正なら null)。 */
function asNumberPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const a = value[0];
  const b = value[1];
  return isFiniteNumber(a) && isFiniteNumber(b) ? [a, b] : null;
}

/** points 配列([[x,y], ...])を厳密に取り出す。 */
function asPoints(value: unknown): [number, number][] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const points: [number, number][] = [];
  for (const entry of value) {
    const pair = asNumberPair(entry);
    if (!pair) {
      return null;
    }
    points.push(pair);
  }
  return points;
}

/** 4要素の数値 bounds を取り出す。 */
function asBounds(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length < 4) {
    return null;
  }
  const nums = value.slice(0, 4);
  if (nums.every(isFiniteNumber)) {
    return [nums[0] as number, nums[1] as number, nums[2] as number, nums[3] as number];
  }
  return null;
}

/** 任意の shape 記述を PanelShape へ正規化(不正なら null)。 */
export function normalizePanelShape(raw: unknown): PanelShape | null {
  if (!isJsonObject(raw)) {
    return null;
  }
  const type = raw.type;
  if (type === "polygon") {
    const points = asPoints(raw.points);
    return points ? { type: "polygon", points } : null;
  }
  if (type === "rect") {
    const bounds = asBounds(raw.bounds);
    if (!bounds) {
      return null;
    }
    const shape: PanelShape = { type: "rect", bounds };
    if (isFiniteNumber(raw.cornerRadius)) {
      shape.cornerRadius = raw.cornerRadius;
    }
    return shape;
  }
  if (type === "ellipse") {
    const center = asNumberPair(raw.center);
    const radius = asNumberPair(raw.radius);
    return center && radius ? { type: "ellipse", center, radius } : null;
  }
  if (type === "path") {
    return typeof raw.d === "string" && raw.d.trim() ? { type: "path", d: raw.d } : null;
  }
  return null;
}

function normalizeFrame(rawFrame: unknown, fallback: PanelFrame): PanelFrame {
  if (!isJsonObject(rawFrame)) {
    return { ...fallback };
  }
  return {
    visible: typeof rawFrame.visible === "boolean" ? rawFrame.visible : fallback.visible,
    style: typeof rawFrame.style === "string" ? rawFrame.style : fallback.style,
    strokeWidth: isFiniteNumber(rawFrame.strokeWidth) ? rawFrame.strokeWidth : fallback.strokeWidth,
    strokeColor: typeof rawFrame.strokeColor === "string" ? rawFrame.strokeColor : fallback.strokeColor
  };
}

/** shape の y 最大値(ページ高さ推定のフォールバックに使う)。 */
function shapeMaxY(shape: PanelShape): number {
  if (shape.type === "polygon") {
    return shape.points.reduce((max, [, y]) => Math.max(max, y), 0);
  }
  if (shape.type === "rect") {
    return Math.max(shape.bounds[1], shape.bounds[3]);
  }
  if (shape.type === "ellipse") {
    return shape.center[1] + shape.radius[1];
  }
  return 0;
}

/**
 * コマ内生成(Docs/Feature-PanelGeneration.md)。パネルの外接矩形 [minX, minY, maxX, maxY]。
 * 生成フォームの width/height 初期値やクロップ計算に使う。`path` はコマンド文字列を厳密に
 * パースせず、含まれる数値を (x, y) ペアとして拾う近似(内蔵プリセット/取り込み仕様は
 * polygon/rect/ellipse のみを使うため、path は将来の任意形状コマ用のベストエフォート)。
 */
export function panelBounds(shape: PanelShape): [number, number, number, number] {
  if (shape.type === "polygon") {
    const xs = shape.points.map(([x]) => x);
    const ys = shape.points.map(([, y]) => y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (shape.type === "rect") {
    const [x1, y1, x2, y2] = shape.bounds;
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  }
  if (shape.type === "ellipse") {
    const [cx, cy] = shape.center;
    const [rx, ry] = shape.radius;
    return [cx - rx, cy - ry, cx + rx, cy + ry];
  }
  const numbers = shape.d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    xs.push(numbers[i]!);
    ys.push(numbers[i + 1]!);
  }
  if (xs.length === 0) {
    return [0, 0, 1, 1];
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** パネル外接矩形の幅・高さ([minX,minY,maxX,maxY] → [width, height])。0除算を避け最小値を敷く。 */
export function panelBoundsSize(bounds: [number, number, number, number]): [number, number] {
  const width = Math.max(EPSILON, bounds[2] - bounds[0]);
  const height = Math.max(EPSILON, bounds[3] - bounds[1]);
  return [width, height];
}

/**
 * コマへ割り当てた画像の表示範囲。asset 画像座標系で正規化(x,y,width,height ∈ [0,1])した
 * 「見えている矩形(窓)」。`renderPagePanelLightbox` はこれを panel の外接矩形へ cover フィットで
 * マップする。パン=x/y、拡大縮小=width/height(小さいほどズームイン)、`rotation`=窓の中心
 * まわりの画像回転(ラジアン、省略/0 で無回転=従来と完全に同一)。
 */
export interface PanelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 窓の中心まわりの画像回転(ラジアン, (-π, π])。省略/0 で無回転。 */
  rotation?: number;
}

export const FULL_PANEL_CROP: PanelCrop = { x: 0, y: 0, width: 1, height: 1, rotation: 0 };

/** 拡大縮小(ズーム)の最小窓サイズ。これより小さい窓=より強いズームインは許さない。 */
export const MIN_CROP_ZOOM_SIZE = 0.05;

/** 角度を (-π, π] へ正規化(非数は 0)。 */
export function normalizeRotation(value: unknown): number {
  if (!isFiniteNumber(value)) {
    return 0;
  }
  const twoPi = Math.PI * 2;
  let r = value % twoPi;
  if (r <= -Math.PI) {
    r += twoPi;
  } else if (r > Math.PI) {
    r -= twoPi;
  }
  return r;
}

/**
 * asset 画像をパネル外接矩形へ「cover」フィットさせた時の既定 crop(中央寄せ)。
 * 入力が不正(0以下等)なら全体表示にフォールバックする。
 */
export function defaultCoverCrop(assetWidth: number, assetHeight: number, boxWidth: number, boxHeight: number): PanelCrop {
  if (!(assetWidth > 0) || !(assetHeight > 0) || !(boxWidth > 0) || !(boxHeight > 0)) {
    return { ...FULL_PANEL_CROP };
  }
  const imageAspect = assetWidth / assetHeight;
  const boxAspect = boxWidth / boxHeight;
  if (imageAspect > boxAspect + EPSILON) {
    const width = boxAspect / imageAspect;
    return { x: (1 - width) / 2, y: 0, width, height: 1, rotation: 0 };
  }
  if (imageAspect < boxAspect - EPSILON) {
    const height = imageAspect / boxAspect;
    return { x: 0, y: (1 - height) / 2, width: 1, height, rotation: 0 };
  }
  return { ...FULL_PANEL_CROP };
}

/** crop を有効範囲([0,1] かつ x+width<=1 等)へ丸める。回転は保持し (-π, π] へ正規化する。 */
export function clampPanelCrop(crop: PanelCrop): PanelCrop {
  const width = Math.min(1, Math.max(0.01, isFiniteNumber(crop.width) ? crop.width : 1));
  const height = Math.min(1, Math.max(0.01, isFiniteNumber(crop.height) ? crop.height : 1));
  const x = Math.min(1 - width, Math.max(0, isFiniteNumber(crop.x) ? crop.x : 0));
  const y = Math.min(1 - height, Math.max(0, isFiniteNumber(crop.y) ? crop.y : 0));
  return { x, y, width, height, rotation: normalizeRotation(crop.rotation) };
}

/**
 * width/height を中心固定で `factor` 倍にズームする(回転は保持)。factor<1=ズームイン。
 * **縦横比を必ず保つ**ため、両辺に同じ factor をかける。片辺だけ `[MIN_CROP_ZOOM_SIZE, 1]` の
 * 境界に当たって縦横比が崩れることが無いよう、実効 factor を「両辺が範囲内に収まる」区間へ丸める。
 */
export function scaleCropAboutCenter(crop: PanelCrop, factor: number): PanelCrop {
  const centerX = crop.x + crop.width / 2;
  const centerY = crop.y + crop.height / 2;
  const baseWidth = crop.width > 0 ? crop.width : 1;
  const baseHeight = crop.height > 0 ? crop.height : 1;
  // どちらの辺も 1 を超えない上限 / MIN を下回らない下限。両辺共通の factor をこの区間へクランプ。
  const maxFactor = Math.min(1 / baseWidth, 1 / baseHeight);
  const minFactor = Math.min(maxFactor, Math.max(MIN_CROP_ZOOM_SIZE / baseWidth, MIN_CROP_ZOOM_SIZE / baseHeight));
  const effective = Math.min(maxFactor, Math.max(minFactor, isFiniteNumber(factor) ? factor : 1));
  return clampPanelCrop({
    x: centerX - (baseWidth * effective) / 2,
    y: centerY - (baseHeight * effective) / 2,
    width: baseWidth * effective,
    height: baseHeight * effective,
    rotation: crop.rotation
  });
}

/** 任意値を厳密な `PanelCrop` へ正規化する(不正なら null)。取り込み(DB/API 入力)の検証に使う。 */
export function normalizePanelCrop(raw: unknown): PanelCrop | null {
  if (!isJsonObject(raw)) {
    return null;
  }
  const { x, y, width, height } = raw;
  if (![x, y, width, height].every(isFiniteNumber)) {
    return null;
  }
  return clampPanelCrop({
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
    rotation: normalizeRotation(raw.rotation)
  });
}

/**
 * `.guruguru-layout.json5` をパースしたオブジェクト(JSON5.parse 済み)を PageLayout へ正規化する。
 * 複数ページ(見開き)の場合は先頭ページ(と、その pageId のパネル)を採用する。
 * width は 1 に正規化されている前提。height は pages[].height → aspectRatio → パネルの y 最大値 の順で解決。
 */
export function normalizeGuruguruLayout(parsed: unknown): PageLayout {
  if (!isJsonObject(parsed)) {
    throw new Error("レイアウトデータがオブジェクトではありません。");
  }

  const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
  const firstPage = pages.find(isJsonObject) ?? null;

  const rawPanels = Array.isArray(parsed.panels) ? parsed.panels : [];
  // 見開き等で複数ページある場合は先頭ページのパネルだけに絞る(pageId 一致、無ければ全件)。
  const pageId = firstPage && typeof firstPage.id === "string" ? firstPage.id : null;
  const scopedPanels = pageId
    ? rawPanels.filter((panel) => isJsonObject(panel) && (panel.pageId === pageId || panel.pageId === undefined))
    : rawPanels;

  const defaultsFrame = normalizeFrame(
    isJsonObject(parsed.defaults) && isJsonObject(parsed.defaults.panel) ? parsed.defaults.panel.frame : undefined,
    DEFAULT_PANEL_FRAME
  );

  const panels: LayoutPanel[] = [];
  scopedPanels.forEach((raw, index) => {
    if (!isJsonObject(raw)) {
      return;
    }
    const shape = normalizePanelShape(raw.shape);
    if (!shape) {
      return;
    }
    const id = typeof raw.id === "string" && raw.id ? raw.id : `panel_${index + 1}`;
    const order = isFiniteNumber(raw.order) ? raw.order : index + 1;
    panels.push({ id, order, shape, frame: normalizeFrame(raw.frame, defaultsFrame) });
  });

  if (panels.length === 0) {
    throw new Error("パネル(コマ)が1つも見つかりませんでした。panels 配列を確認してください。");
  }

  panels.sort((a, b) => a.order - b.order);

  const aspectRatio = resolveAspectRatio(firstPage);
  const height = resolveHeight(firstPage, aspectRatio, panels);

  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio, height },
    readingDirection: resolveReadingDirection(parsed),
    panels
  };

  const balloons = normalizeBalloons(parsed.balloons, pageId);
  if (balloons.length > 0) {
    layout.balloons = balloons;
  }
  if (Array.isArray(parsed.texts) && parsed.texts.length > 0) {
    layout.texts = parsed.texts;
  }

  layout.source = {
    format: "guruguru-layout",
    schemaVersion: typeof parsed.schemaVersion === "string" ? parsed.schemaVersion : undefined,
    title: readTitle(parsed)
  };

  return layout;
}

function resolveAspectRatio(firstPage: Record<string, unknown> | null): [number, number] {
  const ratio = firstPage ? asNumberPair(firstPage.aspectRatio) : null;
  if (ratio && ratio[0] > EPSILON && ratio[1] > EPSILON) {
    return ratio;
  }
  // aspectRatio 無し: width/height から。width 未指定は 1 とみなす。
  const width = firstPage && isFiniteNumber(firstPage.width) ? firstPage.width : 1;
  const height = firstPage && isFiniteNumber(firstPage.height) ? firstPage.height : 1.4142;
  return [width > EPSILON ? width : 1, height > EPSILON ? height : 1];
}

function resolveHeight(
  firstPage: Record<string, unknown> | null,
  aspectRatio: [number, number],
  panels: LayoutPanel[]
): number {
  if (firstPage && isFiniteNumber(firstPage.height) && firstPage.height > EPSILON) {
    return firstPage.height;
  }
  // width=1 正規化前提: height = aspectRatio.h / aspectRatio.w。
  const fromRatio = aspectRatio[1] / aspectRatio[0];
  if (Number.isFinite(fromRatio) && fromRatio > EPSILON) {
    return fromRatio;
  }
  // 最後の砦: パネルの y 最大値。
  const maxY = panels.reduce((max, panel) => Math.max(max, shapeMaxY(panel.shape)), 0);
  return maxY > EPSILON ? maxY : 1.4142;
}

function resolveReadingDirection(parsed: Record<string, unknown>): "rtl" | "ltr" {
  const doc = isJsonObject(parsed.document) ? parsed.document : null;
  const dir = doc?.readingDirection ?? doc?.pageProgression;
  return dir === "ltr" ? "ltr" : "rtl";
}

function readTitle(parsed: Record<string, unknown>): string | undefined {
  const metadata = isJsonObject(parsed.metadata) ? parsed.metadata : null;
  const title = metadata?.title;
  return typeof title === "string" && title.trim() ? title : undefined;
}

function normalizeBalloons(raw: unknown, pageId: string | null): LayoutBalloon[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const balloons: LayoutBalloon[] = [];
  raw.forEach((entry, index) => {
    if (!isJsonObject(entry)) {
      return;
    }
    if (pageId && typeof entry.pageId === "string" && entry.pageId !== pageId) {
      return;
    }
    const id = typeof entry.id === "string" && entry.id ? entry.id : `balloon_${index + 1}`;
    balloons.push({ ...entry, id });
  });
  return balloons;
}
