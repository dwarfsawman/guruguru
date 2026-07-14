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
  /**
   * コマの役割(Docs/Reference-MangaCompositions.md)。省略 = 通常の絵コマ。
   * "figure" = コマぶち抜き立ち絵スロット: 枠を描かず、自動漫画では担当キャラの全身を
   * 白背景で生成 → 背景除去+白フチの切り抜きを ImageObject(band:"front", clipPanelId:null)
   * としてコマ枠の前面へ重ねる。テンプレート上は読み順最後に置く規約。
   */
  role?: "figure";
}

/** 将来機能(吹き出し)の予約型。今回は生成しないが取り込み時に保持する。 */
export interface LayoutBalloon {
  id: string;
  order?: number;
  shape?: PanelShape;
  kind?: string;
  scope?: string | { type: string; id?: string };
  [key: string]: unknown;
}

/**
 * 自動コマ割り候補メタデータ(SPEC v0.3 §23.1 `extensions['com.guruguru'].autoManga`)。
 * candidate:true のテンプレは自動漫画のレイアウト候補プールへ参加できる(参加要件は取り込み側が検証)。
 */
export interface PageLayoutAutoManga {
  candidate: boolean;
  /** LLMネーム監督へ渡す英語一文説明。省略時は面積プロファイルから自動生成される。 */
  description?: string;
  /** 見せ場(hero)相当スロットの panel id。省略時は面積最大のコマを hero とみなす。 */
  emphasisPanelIds?: string[];
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
  source?: {
    format: "guruguru-layout";
    schemaVersion?: string;
    title?: string;
    /** SPEC v0.3: 自動コマ割り候補メタデータ(extensions['com.guruguru'].autoManga)。 */
    autoManga?: PageLayoutAutoManga;
    /** 見開き(mode:'spread')分割取り込み時の元ページ id。単ページ取り込みは省略。 */
    pageId?: string;
  };
}

/** 既定のコマ枠(元フォーマットの defaults に近い値)。取り込み/プリセットで frame 未指定時に使う。 */
export const DEFAULT_PANEL_FRAME: PanelFrame = {
  visible: true,
  style: "solid",
  strokeWidth: 0.006,
  strokeColor: "#000000"
};

/**
 * 裁ち切り(bleed)コマがページ外へはみ出してよい上限(page-width 単位)。内蔵プリセットの
 * BLEED(0.015)を許容しつつ、桁違いの座標崩れは preflight(layout-geometry)で弾くための境界。
 */
export const PANEL_BLEED_OVERSHOOT = 0.02;

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

/** extensions['com.guruguru'].autoManga を正規化する(不正・candidate欠落は undefined)。 */
function readAutoManga(parsed: Record<string, unknown>): PageLayoutAutoManga | undefined {
  const extensions = isJsonObject(parsed.extensions) ? parsed.extensions : null;
  const guruguru = extensions && isJsonObject(extensions["com.guruguru"]) ? extensions["com.guruguru"] : null;
  const raw = guruguru && isJsonObject(guruguru.autoManga) ? guruguru.autoManga : null;
  if (!raw || typeof raw.candidate !== "boolean") return undefined;
  const autoManga: PageLayoutAutoManga = { candidate: raw.candidate };
  if (typeof raw.description === "string" && raw.description.trim()) autoManga.description = raw.description.trim();
  if (Array.isArray(raw.emphasisPanelIds)) {
    const ids = raw.emphasisPanelIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    if (ids.length > 0) autoManga.emphasisPanelIds = ids;
  }
  return autoManga;
}

/**
 * 座標はみ出し検証(SPEC v0.3 §11.2)。`allowOutOfBounds: true` なら無制限、そうでなければ
 * ページ境界から `bleedOvershoot`(既定 0.02)以内のはみ出しだけを許す。超過は取り込みエラー。
 */
function assertBleedOvershoot(
  parsed: Record<string, unknown>,
  panels: readonly LayoutPanel[],
  pageWidth: number,
  pageHeight: number
): void {
  const validation = isJsonObject(parsed.validation) ? parsed.validation : null;
  if (validation?.allowOutOfBounds === true) return;
  const overshoot = validation && isFiniteNumber(validation.bleedOvershoot) && validation.bleedOvershoot >= 0
    ? validation.bleedOvershoot
    : PANEL_BLEED_OVERSHOOT;
  for (const panel of panels) {
    const [x1, y1, x2, y2] = panelBounds(panel.shape);
    if (x1 < -overshoot - EPSILON || y1 < -overshoot - EPSILON || x2 > pageWidth + overshoot + EPSILON || y2 > pageHeight + overshoot + EPSILON) {
      throw new Error(
        `コマ「${panel.id}」がページ境界から bleedOvershoot(${overshoot})を超えてはみ出しています。座標を確認してください。`
      );
    }
  }
}

interface NormalizedGuruguruPage {
  /** 元ファイルのページ id(pages が無いファイルは null)。 */
  pageId: string | null;
  layout: PageLayout;
}

/**
 * `.guruguru-layout.json5` をパースしたオブジェクト(JSON5.parse 済み)をページ毎の PageLayout へ
 * 正規化する(SPEC v0.3 §27.2: 見開き mode:'spread' はページ毎に分割して取り込んでよい)。
 * 見開き左ページ(bounds x1>0)のパネル座標はページローカル(0..1)へ平行移動する。
 * width は 1 に正規化されている前提。height は pages[].height → aspectRatio → パネルの y 最大値 の順で解決。
 */
export function normalizeGuruguruLayoutPages(parsed: unknown): NormalizedGuruguruPage[] {
  if (!isJsonObject(parsed)) {
    throw new Error("レイアウトデータがオブジェクトではありません。");
  }
  const rawPages = Array.isArray(parsed.pages) ? parsed.pages.filter(isJsonObject) : [];
  const pageEntries: Array<Record<string, unknown> | null> = rawPages.length > 0 ? rawPages : [null];
  const autoManga = readAutoManga(parsed);
  const results: NormalizedGuruguruPage[] = [];
  for (const page of pageEntries) {
    const pageId = page && typeof page.id === "string" && page.id ? page.id : null;
    const layout = normalizeSingleGuruguruPage(parsed, page, pageId, rawPages.length > 1);
    if (autoManga) layout.source = { ...layout.source!, autoManga };
    if (pageId && rawPages.length > 1) layout.source = { ...layout.source!, pageId };
    results.push({ pageId, layout });
  }
  if (results.length === 0) {
    throw new Error("ページが1つも見つかりませんでした。");
  }
  return results;
}

function normalizeSingleGuruguruPage(
  parsed: Record<string, unknown>,
  page: Record<string, unknown> | null,
  pageId: string | null,
  isMultiPage: boolean
): PageLayout {
  const rawPanels = Array.isArray(parsed.panels) ? parsed.panels : [];
  // pageId 指定があればそのページのパネルへ絞る。複数ページファイルで pageId 省略の
  // パネルは全ページ共通ではなく「所属不明」なので、単ページ相当(先頭)だけに含める。
  const scopedPanels = pageId
    ? rawPanels.filter((panel) => isJsonObject(panel) && (panel.pageId === pageId || (!isMultiPage && panel.pageId === undefined)))
    : rawPanels;

  // 見開き左ページ等: pages[].bounds の x1/y1 をページローカル原点として平行移動する。
  const boundsRaw = page ? asBounds(page.bounds) : null;
  const offsetX = boundsRaw ? Math.min(boundsRaw[0], boundsRaw[2]) : 0;
  const offsetY = boundsRaw ? Math.min(boundsRaw[1], boundsRaw[3]) : 0;

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
    const panel: LayoutPanel = {
      id,
      order,
      shape: offsetX !== 0 || offsetY !== 0 ? translatePanelShape(shape, -offsetX, -offsetY) : shape,
      frame: normalizeFrame(raw.frame, defaultsFrame)
    };
    if (raw.role === "figure") {
      panel.role = "figure";
    }
    panels.push(panel);
  });

  if (panels.length === 0) {
    throw new Error(
      pageId
        ? `ページ「${pageId}」にパネル(コマ)が1つも見つかりませんでした。panels 配列を確認してください。`
        : "パネル(コマ)が1つも見つかりませんでした。panels 配列を確認してください。"
    );
  }

  panels.sort((a, b) => a.order - b.order);

  const aspectRatio = resolveAspectRatio(page);
  const height = resolveHeight(page, aspectRatio, panels);
  assertBleedOvershoot(parsed, panels, 1, height);

  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio, height },
    readingDirection: resolveReadingDirection(parsed),
    panels
  };

  const pageElementContext: PageElementContext = {
    pageId,
    isMultiPage,
    panelIds: new Set(panels.map((panel) => panel.id)),
    bounds: boundsRaw,
    offsetX,
    offsetY
  };
  const balloons = normalizeBalloons(parsed.balloons, pageElementContext);
  if (balloons.length > 0) {
    layout.balloons = balloons;
  }
  const texts = normalizeTexts(parsed.texts, pageElementContext, balloons);
  if (texts.length > 0) {
    layout.texts = texts;
  }

  layout.source = {
    format: "guruguru-layout",
    schemaVersion: typeof parsed.schemaVersion === "string" ? parsed.schemaVersion : undefined,
    title: readTitle(parsed)
  };

  return layout;
}

/** shape を平行移動する(見開き左ページのローカル座標化)。 */
function translatePanelShape(shape: PanelShape, dx: number, dy: number): PanelShape {
  if (shape.type === "polygon") {
    return { type: "polygon", points: shape.points.map(([x, y]) => [x + dx, y + dy]) };
  }
  if (shape.type === "rect") {
    const [x1, y1, x2, y2] = shape.bounds;
    const moved: PanelShape = { type: "rect", bounds: [x1 + dx, y1 + dy, x2 + dx, y2 + dy] };
    if (shape.cornerRadius !== undefined) moved.cornerRadius = shape.cornerRadius;
    return moved;
  }
  if (shape.type === "ellipse") {
    return { type: "ellipse", center: [shape.center[0] + dx, shape.center[1] + dy], radius: shape.radius };
  }
  return shape;
}

/**
 * `.guruguru-layout.json5` をパースしたオブジェクトを PageLayout へ正規化する(先頭ページ)。
 * 従来互換のラッパー。見開き分割取り込みは `normalizeGuruguruLayoutPages` を使う。
 */
export function normalizeGuruguruLayout(parsed: unknown): PageLayout {
  return normalizeGuruguruLayoutPages(parsed)[0]!.layout;
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

/** `PageLayout` のディープコピー(コマ形状編集 P5 の作業用ドラフト生成に使う。JSON 可搬なデータのみのため JSON 経由で十分)。 */
export function clonePageLayout(layout: PageLayout): PageLayout {
  return JSON.parse(JSON.stringify(layout)) as PageLayout;
}

/**
 * コマ形状編集(Docs/Feature-CGCollectionSuite.md P5)。編集済みの `PageLayout` を PATCH で受け取った時の
 * 軽量な再検証。`normalizeGuruguruLayout` は json5 取り込み専用(pageId 絞り込み・balloons/texts 抽出等の
 * 前処理込み)なので流用せず、既に `PageLayout` の形をしている入力の型・数値・panel id 一意性だけを
 * 検証する。balloons/texts/source は素通しで保持する(取り込み由来の予約フィールドを編集で消さないため)。
 * 不正(page 情報が壊れている/panels が1つも残らない等)なら null。
 */
export function normalizeEditedPageLayout(raw: unknown): PageLayout | null {
  if (!isJsonObject(raw)) {
    return null;
  }
  const pageRaw = isJsonObject(raw.page) ? raw.page : null;
  const aspectRatio = pageRaw ? asNumberPair(pageRaw.aspectRatio) : null;
  const height = pageRaw && isFiniteNumber(pageRaw.height) && pageRaw.height > EPSILON ? pageRaw.height : null;
  if (!aspectRatio || !(aspectRatio[0] > EPSILON) || !(aspectRatio[1] > EPSILON) || height === null) {
    return null;
  }

  const rawPanels = Array.isArray(raw.panels) ? raw.panels : [];
  const seenIds = new Set<string>();
  const panels: LayoutPanel[] = [];
  rawPanels.forEach((rawPanel, index) => {
    if (!isJsonObject(rawPanel)) {
      return;
    }
    const shape = normalizePanelShape(rawPanel.shape);
    if (!shape) {
      return;
    }
    const baseId = typeof rawPanel.id === "string" && rawPanel.id ? rawPanel.id : `panel_${index + 1}`;
    // 一意性: 衝突したら連番サフィックスで回避する(黙って破棄すると編集中のパネルが消えてしまう)。
    let id = baseId;
    let suffix = 1;
    while (seenIds.has(id)) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }
    seenIds.add(id);
    const order = isFiniteNumber(rawPanel.order) ? rawPanel.order : index + 1;
    const panel: LayoutPanel = { id, order, shape };
    if (rawPanel.frame !== undefined) {
      panel.frame = normalizeFrame(rawPanel.frame, DEFAULT_PANEL_FRAME);
    }
    // role は編集往復で消えるとぶち抜き立ち絵の描画/生成規約が壊れるため必ず保持する。
    if (rawPanel.role === "figure") {
      panel.role = "figure";
    }
    panels.push(panel);
  });
  if (panels.length === 0) {
    return null;
  }
  panels.sort((a, b) => a.order - b.order);

  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio, height },
    readingDirection: raw.readingDirection === "ltr" ? "ltr" : "rtl",
    panels
  };
  if (Array.isArray(raw.balloons) && raw.balloons.length > 0) {
    layout.balloons = raw.balloons as LayoutBalloon[];
  }
  if (Array.isArray(raw.texts) && raw.texts.length > 0) {
    layout.texts = raw.texts;
  }
  if (isJsonObject(raw.source)) {
    layout.source = raw.source as PageLayout["source"];
  }
  return layout;
}

interface PageElementContext {
  pageId: string | null;
  isMultiPage: boolean;
  panelIds: ReadonlySet<string>;
  bounds: [number, number, number, number] | null;
  offsetX: number;
  offsetY: number;
}

function elementBounds(entry: Record<string, unknown>): [number, number, number, number] | null {
  const shape = normalizePanelShape(entry.shape);
  if (shape) return panelBounds(shape);
  return asBounds(entry.box);
}

function elementFitsPage(entry: Record<string, unknown>, bounds: [number, number, number, number] | null): boolean {
  if (!bounds) return false;
  const element = elementBounds(entry);
  if (!element) return false;
  const pageX1 = Math.min(bounds[0], bounds[2]);
  const pageY1 = Math.min(bounds[1], bounds[3]);
  const pageX2 = Math.max(bounds[0], bounds[2]);
  const pageY2 = Math.max(bounds[1], bounds[3]);
  const elementX1 = Math.min(element[0], element[2]);
  const elementY1 = Math.min(element[1], element[3]);
  const elementX2 = Math.max(element[0], element[2]);
  const elementY2 = Math.max(element[1], element[3]);
  return elementX1 >= pageX1 - EPSILON && elementY1 >= pageY1 - EPSILON
    && elementX2 <= pageX2 + EPSILON && elementY2 <= pageY2 + EPSILON;
}

function balloonBelongsToPage(entry: Record<string, unknown>, context: PageElementContext): boolean {
  if (!context.isMultiPage) return true;
  if (typeof entry.pageId === "string") return entry.pageId === context.pageId;
  const scope = isJsonObject(entry.scope) ? entry.scope : null;
  if (scope?.type === "panel") return typeof scope.id === "string" && context.panelIds.has(scope.id);
  if (scope?.type === "page") return typeof scope.id === "string" && scope.id === context.pageId;
  if (scope?.type === "spread") return false;
  return elementFitsPage(entry, context.bounds);
}

function translatedCoordinate(value: number, delta: number): number {
  const translated = Number((value + delta).toPrecision(15));
  return Math.abs(translated) < EPSILON ? 0 : translated;
}

const SVG_PATH_PARAMETER_COUNTS: Readonly<Record<string, number>> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0
};

function translateSvgPathData(path: string, dx: number, dy: number): string {
  const tokenPattern = /[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/gu;
  const tokens = path.match(tokenPattern);
  const residue = path.replace(tokenPattern, "").replace(/[\s,]+/gu, "");
  if (!tokens || residue.length > 0) return path;
  const output: string[] = [];
  let index = 0;
  let command = "";
  let hasDrawnGroup = false;
  while (index < tokens.length) {
    if (/^[A-Za-z]$/u.test(tokens[index]!)) {
      command = tokens[index]!;
      output.push(command);
      index += 1;
      const count = SVG_PATH_PARAMETER_COUNTS[command.toUpperCase()];
      if (count === undefined) return path;
      if (count === 0) {
        command = "";
        hasDrawnGroup = true;
        continue;
      }
    }
    if (!command) return path;
    const count = SVG_PATH_PARAMETER_COUNTS[command.toUpperCase()]!;
    const group = tokens.slice(index, index + count);
    if (group.length !== count || group.some((token) => /^[A-Za-z]$/u.test(token))) return path;
    const values = group.map(Number);
    if (values.some((value) => !Number.isFinite(value))) return path;
    const upper = command.toUpperCase();
    const relative = command !== upper;
    if (!relative) {
      if (upper === "H") values[0] = translatedCoordinate(values[0]!, dx);
      else if (upper === "V") values[0] = translatedCoordinate(values[0]!, dy);
      else if (upper === "A") {
        values[5] = translatedCoordinate(values[5]!, dx);
        values[6] = translatedCoordinate(values[6]!, dy);
      } else {
        for (let coordinate = 0; coordinate < values.length; coordinate += 2) {
          values[coordinate] = translatedCoordinate(values[coordinate]!, dx);
          values[coordinate + 1] = translatedCoordinate(values[coordinate + 1]!, dy);
        }
      }
    } else if (!hasDrawnGroup && upper === "M") {
      values[0] = translatedCoordinate(values[0]!, dx);
      values[1] = translatedCoordinate(values[1]!, dy);
    }
    output.push(...values.map((value) => String(Number(value.toFixed(12)))));
    index += count;
    hasDrawnGroup = true;
  }
  return output.join(" ");
}

function translateGeometry(raw: unknown, dx: number, dy: number): unknown {
  if (!isJsonObject(raw)) return raw;
  const shape = normalizePanelShape(raw);
  if (!shape) return raw;
  if (shape.type === "path") return { ...raw, d: translateSvgPathData(shape.d, dx, dy) };
  return { ...raw, ...translatePanelShape(shape, dx, dy) };
}

function translateBalloon(entry: Record<string, unknown>, id: string, dx: number, dy: number): LayoutBalloon {
  if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) return { ...entry, id } as LayoutBalloon;
  const translated: Record<string, unknown> = { ...entry, id };
  translated.shape = translateGeometry(entry.shape, dx, dy);
  if (isJsonObject(entry.tail)) {
    const tail: Record<string, unknown> = { ...entry.tail };
    if (typeof tail.d === "string") tail.d = translateSvgPathData(tail.d, dx, dy);
    if (Array.isArray(tail.beads)) {
      tail.beads = tail.beads.map((bead) => {
        if (!isJsonObject(bead)) return bead;
        const center = asNumberPair(bead.center);
        return center
          ? { ...bead, center: [translatedCoordinate(center[0], dx), translatedCoordinate(center[1], dy)] }
          : bead;
      });
    }
    if (isJsonObject(tail.target)) {
      const position = asNumberPair(tail.target.position);
      if (position) {
        tail.target = {
          ...tail.target,
          position: [translatedCoordinate(position[0], dx), translatedCoordinate(position[1], dy)]
        };
      }
    }
    translated.tail = tail;
  }
  return translated as LayoutBalloon;
}

function normalizeBalloons(raw: unknown, context: PageElementContext): LayoutBalloon[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const balloons: LayoutBalloon[] = [];
  raw.forEach((entry, index) => {
    if (!isJsonObject(entry)) {
      return;
    }
    if (!balloonBelongsToPage(entry, context)) return;
    const id = typeof entry.id === "string" && entry.id ? entry.id : `balloon_${index + 1}`;
    balloons.push(translateBalloon(entry, id, -context.offsetX, -context.offsetY));
  });
  return balloons;
}

function balloonTextIds(balloons: readonly LayoutBalloon[]): Set<string> {
  const ids = new Set<string>();
  for (const balloon of balloons) {
    if (typeof balloon.textId === "string") ids.add(balloon.textId);
    if (!Array.isArray(balloon.parts)) continue;
    for (const part of balloon.parts) {
      if (isJsonObject(part) && typeof part.textId === "string") ids.add(part.textId);
    }
  }
  return ids;
}

function normalizeTexts(raw: unknown, context: PageElementContext, balloons: readonly LayoutBalloon[]): unknown[] {
  if (!Array.isArray(raw)) return [];
  const referencedTextIds = balloonTextIds(balloons);
  return raw.flatMap((entry) => {
    if (!isJsonObject(entry)) return [];
    const belongs = !context.isMultiPage
      || (typeof entry.pageId === "string"
        ? entry.pageId === context.pageId
        : (typeof entry.id === "string" && referencedTextIds.has(entry.id)) || elementFitsPage(entry, context.bounds));
    if (!belongs) return [];
    const box = asBounds(entry.box);
    return [{
      ...entry,
      ...(box ? {
        box: [
          translatedCoordinate(box[0], -context.offsetX),
          translatedCoordinate(box[1], -context.offsetY),
          translatedCoordinate(box[2], -context.offsetX),
          translatedCoordinate(box[3], -context.offsetY)
        ]
      } : {})
    }];
  });
}
