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
