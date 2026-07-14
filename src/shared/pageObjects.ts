/**
 * ページオブジェクト(Docs/Feature-CGCollectionSuite.md フェーズ P1)。
 * テキスト/吹き出し/ボックスの共有モデル。座標系は `pageLayout.ts` と同じ
 * width-relative-top-left(x∈[0,1], y∈[0,page.height], 長さの単位=page-width)で、
 * `pages.objects_json` に配列全体を保存する(`asset_paste_attachments` と同じ「1行に配列」パターン)。
 * このモジュールは純ロジックのみ(DOM・db 非依存)。P1 で編集 UI を持つのは box のみだが、
 * 型は将来フェーズ(P2 テキスト・P3 吹き出し)分もここで定義しておく。
 */
import { isJsonObject } from "./json";
import { normalizeRotation } from "./pageLayout";

export interface PageVec {
  x: number;
  y: number;
}

export type TextDirection = "horizontal" | "vertical";
export type TextAlign = "start" | "center" | "end";

export interface TextStyle {
  /** フォント識別子(P2 で `GET /api/fonts` の id を解決)。P1 では常に "default"。 */
  fontId: string;
  /** page-width 比のフォントサイズ(例 0.03 = ページ幅の3%)。 */
  size: number;
  direction: TextDirection;
  /** #rrggbb */
  color: string;
  /** フチ色(白フチ等)。無しは省略。 */
  outlineColor?: string;
  /** フチ太さ(size 比)。 */
  outlineWidth?: number;
  /** 行送り倍率。 */
  lineSpacing?: number;
  /** 字送り倍率。 */
  letterSpacing?: number;
  align?: TextAlign;
}

export interface TextContent {
  text: string;
  style: TextStyle;
}

interface PageObjectBase {
  id: string;
  /** オブジェクト中心(page 座標)。 */
  position: PageVec;
  /** ラジアン (-π, π]。 */
  rotation: number;
  /**
   * 台詞⇄吹き出しの双方向リンク(Docs/Feature-ScriptToManga.md S3)。dialogue_placements.balloon_object_id
   * と対で使う `dialogue_lines.id`。セリフドロワーから生成したオブジェクトのみ持つ。
   * **normalizeBase で保持する**(正規化往復で消えるとリンクが壊れる -- 既知の罠1)。
   */
  sourceDialogueLineId?: string;
}

export interface TextObject extends PageObjectBase {
  kind: "text";
  content: TextContent;
  /** 折り返し幅(page 単位)。未指定は折り返しなし。 */
  maxWidth?: number;
}

export type BalloonShape = "ellipse" | "rounded" | "cloud" | "jagged" | "thought" | "compound" | "spike" | "roundRect" | "caption";

export interface BalloonTail {
  /**
   * しっぽの先端(オブジェクトローカル座標: 中心=原点、回転前)。
   * P3 実装時に「ページ座標(絶対)」から変更した -- 絶対座標のままだと、オブジェクトを移動/回転しても
   * しっぽだけ元の位置に取り残され、本体から千切れて見える(または回転で全く違う向きを指す)ため。
   * ローカル座標なら移動/回転に自動追従し、拡縮時も本体と同率でスケールすればよい。
   */
  tip: PageVec;
  width: number;
}

export interface BalloonObject extends PageObjectBase {
  kind: "balloon";
  shape: BalloonShape;
  /** 幅・高さ(page 単位)。 */
  size: PageVec;
  tail?: BalloonTail | null;
  fill: string;
  strokeColor: string;
  strokeWidth: number;
  content?: TextContent | null;
}

export interface BoxObject extends PageObjectBase {
  kind: "box";
  /** 幅・高さ(page 単位)。 */
  size: PageVec;
  cornerRadius?: number;
  fill: string;
  strokeColor: string;
  strokeWidth: number;
  content?: TextContent | null;
}

/**
 * レイヤー帯(Docs/Feature-ScriptToManga.md S2)。"back" = コマ枠より後ろ(コマ画像より前、
 * ぶち抜き立ち絵用)、"front" = コマ枠より前(既定、text/balloon/box と同じ帯)。
 * 帯内の重なりは配列順(先頭=背面)。任意の全体 zIndex は導入しない(枠・吹き出しの規則を壊さないため)。
 */
export type ImageObjectBand = "back" | "front";

/**
 * 画像オブジェクト(Docs/Feature-ScriptToManga.md S2: コマぶち抜き立ち絵の土台)。`mediaId` は
 * `page_media.id` を参照する(`assetId` を直接参照しない -- Round/Asset 削除で ImageObject が
 * 壊れないよう、配置時に `page_media` へファイルをコピーする方式にしている)。
 */
export interface ImageObject extends PageObjectBase {
  kind: "image";
  /** page_media.id。 */
  mediaId: string;
  /** 幅・高さ(page 単位)。追加時はメディアのアスペクト比で初期化する(`defaultImageObjectSize`)。 */
  size: PageVec;
  /** 0..1、既定 1。 */
  opacity?: number;
  /** 既定 "front"(省略時は front として扱う)。 */
  band?: ImageObjectBand;
  /** コマ形状でクリップする対象パネル id。null/省略 = ぶち抜き(クリップしない)。 */
  clipPanelId?: string | null;
}

/** スクリーントーン種別(Docs/Feature-ScreenTones.md)。 */
export type ToneKind = "halftone" | "gradient" | "lines" | "speed" | "focus" | "flash";

/**
 * トーン種別ごとのパラメータ(Docs/Feature-ScreenTones.md データモデル節の表)。判別 union にせず
 * 「使うフィールドだけ埋まった単一のオプショナル集合」にしている -- 正規化・種別切替時の既定リセットが
 * 「その種別が使うキーだけ埋める」だけで済み、判別 union のナローイングをそこら中に書かずに済むため
 * (「正規化往復で seed/params/clipPanelId が消えると保存1秒後に編集が巻き戻る」既知の罠を踏まえ、
 * 保持ロジックを極力単純にする狙い)。角度は deg(UI の number 入力と一致させる)。
 */
export interface ToneParams {
  /** halftone/gradient/lines: ドット/線の間隔(page-width 単位、0.004–0.1)。 */
  pitch?: number;
  /** halftone/gradient: ドット濃度 0..1。 */
  dotRatio?: number;
  /** halftone/gradient/lines/speed: パターン角度(deg)。 */
  angle?: number;
  /** gradient: angle 方向の開始/終了濃度比率 0..1。 */
  startRatio?: number;
  endRatio?: number;
  /** lines: 線幅/間隔比 0..1。 */
  lineRatio?: number;
  /** speed/focus/flash: 本数(≤400)。 */
  count?: number;
  /** speed: 平均長 0..1(領域に対する比)。 */
  length?: number;
  /** speed/focus/flash: 線幅/外周側の基部太さ。 */
  lineWidth?: number;
  /** speed/focus/flash: ゆらぎ 0..1。 */
  jitter?: number;
  /** focus/flash: 中心(オブジェクトローカル座標。balloon の tail.tip と同方式、中心=原点・回転前)。 */
  center?: PageVec;
  /** focus/flash: 中心の空白半径。 */
  innerRadius?: number;
}

export interface ToneObject extends PageObjectBase {
  kind: "tone";
  /** 領域(外接矩形)。position=中心、box と同じ page 単位。 */
  size: PageVec;
  toneType: ToneKind;
  /** 描画色。既定 "#000000"。 */
  color: string;
  /** 0..1、既定 1。 */
  opacity?: number;
  /** コマ形状でクリップ(ImageObject.clipPanelId と同じ仕組み・同じ clipPath defs を再利用)。 */
  clipPanelId?: string | null;
  /** ゆらぎの決定的乱数 seed(整数)。作成時に採番、「シャッフル」で振り直し。 */
  seed: number;
  params: ToneParams;
}

export type PageObject = TextObject | BalloonObject | BoxObject | ImageObject | ToneObject;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_BOX_FILL = "#ffffff";
export const DEFAULT_BOX_STROKE_COLOR = "#000000";
export const DEFAULT_BOX_STROKE_WIDTH = 0.004;
export const DEFAULT_BOX_SIZE: PageVec = { x: 0.3, y: 0.15 };

/** テキストオブジェクトの既定スタイル(P2: 「テキスト追加」ボタン)。 */
export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontId: "default",
  size: 0.04,
  direction: "vertical",
  color: "#000000"
};
export const DEFAULT_TEXT_STRING = "テキスト";

/** オブジェクトの幅・高さの取り得る範囲(page-width 単位)。ギズモの拡縮クランプにも使う。 */
export const PAGE_OBJECT_MIN_SIZE = 0.01;
export const PAGE_OBJECT_MAX_SIZE = 5;

/** テキストサイズ(size)の取り得る範囲。text ギズモの拡縮クランプに使う(normalizeTextStyle の clamp と同じ範囲)。 */
export const TEXT_SIZE_MIN = 0.005;
export const TEXT_SIZE_MAX = 1;

/** 1ページに保存できるオブジェクト数の上限(暴走 PATCH へのガード)。 */
export const PAGE_OBJECTS_MAX_COUNT = 300;

/** 吹き出しの既定サイズ・線・しっぽ幅(P3: 「吹き出し追加」ボタン)。 */
export const DEFAULT_BALLOON_SIZE: PageVec = { x: 0.35, y: 0.22 };
export const DEFAULT_BALLOON_TAIL_WIDTH = 0.05;
/** tail.tip(ローカル座標)の取り得る範囲(page-width 単位、± 両方向)。normalize と編集 UI の両方で使う。 */
export const BALLOON_TAIL_TIP_CLAMP = 2;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** unknown な数値を [min, max] へクランプする。非数は fallback。 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function asColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR_RE.test(value.trim()) ? value.trim() : fallback;
}

function asVec(value: unknown): PageVec | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const { x, y } = value;
  return isFiniteNumber(x) && isFiniteNumber(y) ? { x, y } : null;
}

function normalizeTextStyle(raw: unknown): TextStyle | null {
  if (!isJsonObject(raw)) {
    return null;
  }
  const fontId = typeof raw.fontId === "string" && raw.fontId.trim() ? raw.fontId.trim() : "default";
  const size = clampNumber(raw.size, 0.005, 1, 0.03);
  const direction: TextDirection = raw.direction === "vertical" ? "vertical" : "horizontal";
  const style: TextStyle = { fontId, size, direction, color: asColor(raw.color, "#000000") };
  if (raw.outlineColor !== undefined) {
    style.outlineColor = asColor(raw.outlineColor, "#ffffff");
  }
  if (raw.outlineWidth !== undefined) {
    style.outlineWidth = clampNumber(raw.outlineWidth, 0, 1, 0);
  }
  if (raw.lineSpacing !== undefined) {
    style.lineSpacing = clampNumber(raw.lineSpacing, 0.5, 4, 1.6);
  }
  if (raw.letterSpacing !== undefined) {
    style.letterSpacing = clampNumber(raw.letterSpacing, 0.2, 4, 1.0);
  }
  if (raw.align === "start" || raw.align === "center" || raw.align === "end") {
    style.align = raw.align;
  }
  return style;
}

/** テキストコンテンツの正規化(P2: text-layout API のリクエスト検証・box/balloon content 検証にも使う)。 */
export function normalizeTextContent(raw: unknown): TextContent | null {
  if (!isJsonObject(raw) || typeof raw.text !== "string") {
    return null;
  }
  const style = normalizeTextStyle(raw.style);
  if (!style) {
    return null;
  }
  return { text: raw.text, style };
}

/** content フィールド(optional かつ null 許容)の正規化。無効な値は省略(元オブジェクトに content を持たせない)。 */
function normalizeOptionalContent(raw: unknown): TextContent | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    return null;
  }
  const content = normalizeTextContent(raw);
  return content ?? undefined;
}

interface NormalizedBase {
  id: string;
  position: PageVec;
  rotation: number;
  sourceDialogueLineId?: string;
}

function normalizeBase(raw: Record<string, unknown>, fallbackId: string): NormalizedBase | null {
  const position = asVec(raw.position);
  if (!position) {
    return null;
  }
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : fallbackId;
  const base: NormalizedBase = { id, position, rotation: normalizeRotation(raw.rotation) };
  if (typeof raw.sourceDialogueLineId === "string" && raw.sourceDialogueLineId.trim()) {
    base.sourceDialogueLineId = raw.sourceDialogueLineId.trim();
  }
  return base;
}

/** base の共通フィールド(id/position/rotation/sourceDialogueLineId)を出力オブジェクトへ広げる。 */
function spreadBase(base: NormalizedBase): Pick<PageObjectBase, "id" | "position" | "rotation" | "sourceDialogueLineId"> {
  const out: Pick<PageObjectBase, "id" | "position" | "rotation" | "sourceDialogueLineId"> = {
    id: base.id,
    position: base.position,
    rotation: base.rotation
  };
  if (base.sourceDialogueLineId !== undefined) {
    out.sourceDialogueLineId = base.sourceDialogueLineId;
  }
  return out;
}

function normalizeSize(raw: unknown): PageVec | null {
  const size = asVec(raw);
  if (!size || !(size.x > 0) || !(size.y > 0)) {
    return null;
  }
  return {
    x: clampNumber(size.x, PAGE_OBJECT_MIN_SIZE, PAGE_OBJECT_MAX_SIZE, DEFAULT_BOX_SIZE.x),
    y: clampNumber(size.y, PAGE_OBJECT_MIN_SIZE, PAGE_OBJECT_MAX_SIZE, DEFAULT_BOX_SIZE.y)
  };
}

function normalizeTextObject(raw: Record<string, unknown>, fallbackId: string): TextObject | null {
  const base = normalizeBase(raw, fallbackId);
  const content = normalizeTextContent(raw.content);
  if (!base || !content) {
    return null;
  }
  const object: TextObject = { ...spreadBase(base), kind: "text", content };
  if (isFiniteNumber(raw.maxWidth) && raw.maxWidth > 0) {
    object.maxWidth = clampNumber(raw.maxWidth, 0.01, PAGE_OBJECT_MAX_SIZE, raw.maxWidth);
  }
  return object;
}

const BALLOON_SHAPES = new Set<BalloonShape>(["ellipse", "rounded", "cloud", "jagged", "thought", "compound", "spike", "roundRect", "caption"]);

function normalizeBalloonObject(raw: Record<string, unknown>, fallbackId: string): BalloonObject | null {
  const base = normalizeBase(raw, fallbackId);
  const size = normalizeSize(raw.size);
  if (!base || !size) {
    return null;
  }
  const shape: BalloonShape =
    typeof raw.shape === "string" && BALLOON_SHAPES.has(raw.shape as BalloonShape) ? (raw.shape as BalloonShape) : "ellipse";
  const object: BalloonObject = {
    ...spreadBase(base),
    kind: "balloon",
    shape,
    size,
    fill: asColor(raw.fill, DEFAULT_BOX_FILL),
    strokeColor: asColor(raw.strokeColor, DEFAULT_BOX_STROKE_COLOR),
    strokeWidth: clampNumber(raw.strokeWidth, 0, 0.2, DEFAULT_BOX_STROKE_WIDTH)
  };
  if (raw.tail === null) {
    object.tail = null;
  } else if (isJsonObject(raw.tail)) {
    const tip = asVec(raw.tail.tip);
    if (tip) {
      // tip はローカル座標(中心=原点、回転前)。絶対座標時代の名残の巨大値が来ても千切れないよう
      // ± BALLOON_TAIL_TIP_CLAMP へ収める(通常の使用範囲は ±1 未満)。
      object.tail = {
        tip: {
          x: clampNumber(tip.x, -BALLOON_TAIL_TIP_CLAMP, BALLOON_TAIL_TIP_CLAMP, 0),
          y: clampNumber(tip.y, -BALLOON_TAIL_TIP_CLAMP, BALLOON_TAIL_TIP_CLAMP, 0)
        },
        width: clampNumber(raw.tail.width, 0, PAGE_OBJECT_MAX_SIZE, DEFAULT_BALLOON_TAIL_WIDTH)
      };
    }
  }
  const content = normalizeOptionalContent(raw.content);
  if (content !== undefined) {
    object.content = content;
  }
  return object;
}

function normalizeBoxObject(raw: Record<string, unknown>, fallbackId: string): BoxObject | null {
  const base = normalizeBase(raw, fallbackId);
  const size = normalizeSize(raw.size);
  if (!base || !size) {
    return null;
  }
  const object: BoxObject = {
    ...spreadBase(base),
    kind: "box",
    size,
    fill: asColor(raw.fill, DEFAULT_BOX_FILL),
    strokeColor: asColor(raw.strokeColor, DEFAULT_BOX_STROKE_COLOR),
    strokeWidth: clampNumber(raw.strokeWidth, 0, 0.2, DEFAULT_BOX_STROKE_WIDTH)
  };
  if (isFiniteNumber(raw.cornerRadius)) {
    object.cornerRadius = clampNumber(raw.cornerRadius, 0, PAGE_OBJECT_MAX_SIZE, 0);
  }
  const content = normalizeOptionalContent(raw.content);
  if (content !== undefined) {
    object.content = content;
  }
  return object;
}

const IMAGE_BANDS = new Set<ImageObjectBand>(["back", "front"]);

/**
 * 画像オブジェクトの正規化。**全フィールドを保持する**(正規化往復で opacity/band/clipPanelId が
 * 消えると保存 1 秒後に編集が巻き戻るため -- Docs/Feature-ScriptToManga.md S2 既知の罠1)。
 */
function normalizeImageObject(raw: Record<string, unknown>, fallbackId: string): ImageObject | null {
  const base = normalizeBase(raw, fallbackId);
  const size = normalizeSize(raw.size);
  const mediaId = typeof raw.mediaId === "string" ? raw.mediaId.trim() : "";
  if (!base || !size || !mediaId) {
    return null;
  }
  const object: ImageObject = { ...spreadBase(base), kind: "image", mediaId, size };
  if (isFiniteNumber(raw.opacity)) {
    object.opacity = clampNumber(raw.opacity, 0, 1, 1);
  }
  if (typeof raw.band === "string" && IMAGE_BANDS.has(raw.band as ImageObjectBand)) {
    object.band = raw.band as ImageObjectBand;
  }
  if (raw.clipPanelId === null) {
    object.clipPanelId = null;
  } else if (typeof raw.clipPanelId === "string" && raw.clipPanelId.trim()) {
    object.clipPanelId = raw.clipPanelId.trim();
  }
  return object;
}

export const TONE_KINDS: readonly ToneKind[] = ["halftone", "gradient", "lines", "speed", "focus", "flash"];
const TONE_KIND_SET = new Set<ToneKind>(TONE_KINDS);

/** pitch(ドット/線間隔)の可動域。下限 0.004 は要素数爆発防止の安全弁(Docs/Feature-ScreenTones.md)。 */
export const TONE_PITCH_MIN = 0.004;
export const TONE_PITCH_MAX = 0.1;
/** speed/focus/flash の本数上限。 */
export const TONE_COUNT_MAX = 400;
/** focus/flash の center(ローカル座標)の可動域(± 両方向。BALLOON_TAIL_TIP_CLAMP と同じ考え方)。 */
export const TONE_CENTER_CLAMP = 2;
/** 既定色(黒)。 */
export const DEFAULT_TONE_COLOR = "#000000";
/** 「+ トーン」未選択時の既定サイズ(page 単位)。 */
export const DEFAULT_TONE_SIZE: PageVec = { x: 0.35, y: 0.35 };

/** トーン種別ごとの既定パラメータ(Docs/Feature-ScreenTones.md データモデル節の表)。種別切替時のリセットにも使う。 */
export function defaultToneParams(toneType: ToneKind): ToneParams {
  switch (toneType) {
    case "halftone":
      return { pitch: 0.015, dotRatio: 0.45, angle: 45 };
    case "gradient":
      return { pitch: 0.015, dotRatio: 0.45, angle: 45, startRatio: 0.7, endRatio: 0.05 };
    case "lines":
      return { pitch: 0.012, lineRatio: 0.35, angle: 0 };
    case "speed":
      return { angle: 45, count: 90, length: 0.7, lineWidth: 0.004, jitter: 0.5 };
    case "focus":
      return { center: { x: 0, y: 0 }, innerRadius: 0.12, count: 72, lineWidth: 0.012, jitter: 0.5 };
    case "flash":
      return { center: { x: 0, y: 0 }, innerRadius: 0.18, count: 72, lineWidth: 0.012, jitter: 0.5 };
    default:
      return {};
  }
}

function normalizeToneCenter(raw: unknown, fallback: PageVec): PageVec {
  const vec = asVec(raw);
  if (!vec) {
    return { ...fallback };
  }
  return {
    x: clampNumber(vec.x, -TONE_CENTER_CLAMP, TONE_CENTER_CLAMP, fallback.x),
    y: clampNumber(vec.y, -TONE_CENTER_CLAMP, TONE_CENTER_CLAMP, fallback.y)
  };
}

/**
 * トーン種別ごとに使うフィールドだけを検証・clamp する(未知/欠損値は defaultToneParams のフォールバックへ)。
 * angle は周期量なので範囲 clamp はせず、有限数であることだけ保証する。
 */
function normalizeToneParams(toneType: ToneKind, raw: unknown): ToneParams {
  const source = isJsonObject(raw) ? raw : {};
  const fallback = defaultToneParams(toneType);
  const params: ToneParams = {};
  if (toneType === "halftone" || toneType === "gradient" || toneType === "lines") {
    params.pitch = clampNumber(source.pitch, TONE_PITCH_MIN, TONE_PITCH_MAX, fallback.pitch!);
    params.angle = clampNumber(source.angle, -360000, 360000, fallback.angle!);
  }
  if (toneType === "halftone" || toneType === "gradient") {
    params.dotRatio = clampNumber(source.dotRatio, 0, 1, fallback.dotRatio!);
  }
  if (toneType === "gradient") {
    params.startRatio = clampNumber(source.startRatio, 0, 1, fallback.startRatio!);
    params.endRatio = clampNumber(source.endRatio, 0, 1, fallback.endRatio!);
  }
  if (toneType === "lines") {
    params.lineRatio = clampNumber(source.lineRatio, 0, 1, fallback.lineRatio!);
  }
  if (toneType === "speed") {
    params.angle = clampNumber(source.angle, -360000, 360000, fallback.angle!);
    params.count = clampNumber(source.count, 1, TONE_COUNT_MAX, fallback.count!);
    params.length = clampNumber(source.length, 0, 1, fallback.length!);
    params.lineWidth = clampNumber(source.lineWidth, 0, 1, fallback.lineWidth!);
    params.jitter = clampNumber(source.jitter, 0, 1, fallback.jitter!);
  }
  if (toneType === "focus" || toneType === "flash") {
    params.center = normalizeToneCenter(source.center, fallback.center!);
    params.innerRadius = clampNumber(source.innerRadius, 0, PAGE_OBJECT_MAX_SIZE, fallback.innerRadius!);
    params.count = clampNumber(source.count, 1, TONE_COUNT_MAX, fallback.count!);
    params.lineWidth = clampNumber(source.lineWidth, 0, 1, fallback.lineWidth!);
    params.jitter = clampNumber(source.jitter, 0, 1, fallback.jitter!);
  }
  return params;
}

/** 不正/欠損 seed のフォールバック値。決定的にするため Math.random は使わない(正規化は純関数に保つ)。 */
const DEFAULT_TONE_SEED = 1;

/**
 * トーンオブジェクトの正規化。**全フィールドを保持する**(image と同じく、正規化往復で
 * seed/params/clipPanelId が消えると保存1秒後に編集が巻き戻るため -- Docs/Feature-ScreenTones.md 既知の罠)。
 * toneType が候補外なら balloon.shape と同じ扱いで既定値(halftone)へフォールバックする(オブジェクト
 * 自体は捨てない -- position/size さえ有効ならユーザーの配置・サイズ調整は保持する)。
 */
function normalizeToneObject(raw: Record<string, unknown>, fallbackId: string): ToneObject | null {
  const base = normalizeBase(raw, fallbackId);
  const size = normalizeSize(raw.size);
  if (!base || !size) {
    return null;
  }
  const toneType: ToneKind = typeof raw.toneType === "string" && TONE_KIND_SET.has(raw.toneType as ToneKind) ? (raw.toneType as ToneKind) : "halftone";
  const seed = Number.isInteger(raw.seed) ? (raw.seed as number) : DEFAULT_TONE_SEED;
  const object: ToneObject = {
    ...spreadBase(base),
    kind: "tone",
    size,
    toneType,
    color: asColor(raw.color, DEFAULT_TONE_COLOR),
    seed,
    params: normalizeToneParams(toneType, raw.params)
  };
  if (isFiniteNumber(raw.opacity)) {
    object.opacity = clampNumber(raw.opacity, 0, 1, 1);
  }
  if (raw.clipPanelId === null) {
    object.clipPanelId = null;
  } else if (typeof raw.clipPanelId === "string" && raw.clipPanelId.trim()) {
    object.clipPanelId = raw.clipPanelId.trim();
  }
  return object;
}

function normalizeOne(raw: unknown, fallbackId: string): PageObject | null {
  if (!isJsonObject(raw)) {
    return null;
  }
  switch (raw.kind) {
    case "text":
      return normalizeTextObject(raw, fallbackId);
    case "balloon":
      return normalizeBalloonObject(raw, fallbackId);
    case "box":
      return normalizeBoxObject(raw, fallbackId);
    case "image":
      return normalizeImageObject(raw, fallbackId);
    case "tone":
      return normalizeToneObject(raw, fallbackId);
    default:
      // 未知 kind は捨てる(将来フェーズや壊れたデータに対して寛容に無視する)。
      return null;
  }
}

/**
 * ページオブジェクト配列の正規化(`normalizePanelCrop` と同じ役割)。サーバ入力検証・クライアント
 * 読込の両方で使う。配列でない入力は空配列。未知 kind・必須フィールド欠損の要素は黙って捨て、
 * 数値は妥当な範囲へ clamp する。id 重複は末尾へ `_dup` を足して一意化する。
 */
export function normalizePageObjects(raw: unknown): PageObject[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const objects: PageObject[] = [];
  const seenIds = new Set<string>();
  raw.forEach((entry, index) => {
    if (objects.length >= PAGE_OBJECTS_MAX_COUNT) {
      return;
    }
    const normalized = normalizeOne(entry, `obj_${index + 1}`);
    if (!normalized) {
      return;
    }
    let id = normalized.id;
    while (seenIds.has(id)) {
      id = `${id}_dup`;
    }
    seenIds.add(id);
    objects.push({ ...normalized, id });
  });
  return objects;
}

/** 新規ボックスオブジェクトを作る(既定スタイル)。位置・サイズは呼び出し側(page 座標)が決める。 */
export function createBoxObject(id: string, center: PageVec, size: PageVec = DEFAULT_BOX_SIZE): BoxObject {
  return {
    id,
    kind: "box",
    position: { ...center },
    rotation: 0,
    size: { ...size },
    cornerRadius: 0,
    fill: DEFAULT_BOX_FILL,
    strokeColor: DEFAULT_BOX_STROKE_COLOR,
    strokeWidth: DEFAULT_BOX_STROKE_WIDTH
  };
}

/** 新規テキストオブジェクトを作る(既定スタイル)。位置は呼び出し側(page 座標)が決める。 */
export function createTextObject(id: string, center: PageVec, text: string = DEFAULT_TEXT_STRING): TextObject {
  return {
    id,
    kind: "text",
    position: { ...center },
    rotation: 0,
    content: { text, style: { ...DEFAULT_TEXT_STYLE } }
  };
}

/** 新規吹き出しオブジェクトを作る(既定: 楕円・fill 白・stroke 黒・しっぽ無し・content は空テキスト縦書き)。 */
export function createBalloonObject(id: string, center: PageVec, size: PageVec = DEFAULT_BALLOON_SIZE): BalloonObject {
  return {
    id,
    kind: "balloon",
    position: { ...center },
    rotation: 0,
    shape: "ellipse",
    size: { ...size },
    tail: null,
    fill: DEFAULT_BOX_FILL,
    strokeColor: DEFAULT_BOX_STROKE_COLOR,
    strokeWidth: DEFAULT_BOX_STROKE_WIDTH,
    content: { text: "", style: { ...DEFAULT_TEXT_STYLE } }
  };
}

/** 画像オブジェクト追加時の既定高さ(page 単位)。幅はメディアのアスペクト比から決める。 */
export const DEFAULT_IMAGE_OBJECT_HEIGHT = 0.4;

/**
 * 画像オブジェクト追加時の既定サイズ(page 単位)。メディアの width/height が取れれば
 * そのアスペクト比で高さ `DEFAULT_IMAGE_OBJECT_HEIGHT` の外接矩形を作り、取れなければ正方形にする。
 */
export function defaultImageObjectSize(mediaWidth: number | null | undefined, mediaHeight: number | null | undefined): PageVec {
  const aspect = mediaWidth && mediaHeight && mediaWidth > 0 && mediaHeight > 0 ? mediaWidth / mediaHeight : 1;
  const y = DEFAULT_IMAGE_OBJECT_HEIGHT;
  const x = clampNumber(y * aspect, PAGE_OBJECT_MIN_SIZE, PAGE_OBJECT_MAX_SIZE, y);
  return { x, y };
}

/** 新規画像オブジェクトを作る(既定: front 帯・不透明度1・クリップなし)。位置・サイズは呼び出し側が決める。 */
export function createImageObject(id: string, center: PageVec, mediaId: string, size: PageVec): ImageObject {
  return {
    id,
    kind: "image",
    position: { ...center },
    rotation: 0,
    mediaId,
    size: { ...size },
    opacity: 1,
    band: "front",
    clipPanelId: null
  };
}

/**
 * 新規トーンオブジェクトを作る(既定: halftone・黒・不透明度1・クリップなし)。id と同じく、seed も
 * 「新規生成時の乱数割り当ては呼び出し側の責務」という既存の createXxxObject 群の規約に合わせ、
 * 呼び出し側(乱数)が決めた値を受け取る(このモジュール自身は Math.random を使わず純粋に保つ)。
 */
export function createToneObject(
  id: string,
  center: PageVec,
  seed: number,
  size: PageVec = DEFAULT_TONE_SIZE,
  toneType: ToneKind = "halftone",
  clipPanelId: string | null = null
): ToneObject {
  return {
    id,
    kind: "tone",
    position: { ...center },
    rotation: 0,
    size: { ...size },
    toneType,
    color: DEFAULT_TONE_COLOR,
    opacity: 1,
    clipPanelId,
    seed,
    params: defaultToneParams(toneType)
  };
}

/** しっぽトグル ON 時の既定しっぽ(下向き、ローカル座標)。size は toggle 時点のオブジェクトの size。 */
export function defaultBalloonTail(size: PageVec): BalloonTail {
  return {
    tip: { x: 0, y: size.y / 2 + Math.max(0.05, size.y * 0.4) },
    width: DEFAULT_BALLOON_TAIL_WIDTH
  };
}

/**
 * box/balloon 内包テキストの折り返し幅(page 単位)。パディング分だけ形状のサイズより小さくする。
 * export しているのは Chronicle Page Flow の自動配置サイズ計算(`dialogueAutoLayoutApi.ts`)が
 * 「必要な折返し幅から逆算して形状サイズを出す」ために同じ比率を使うため(§2.5)。
 */
export const CONTENT_PADDING_RATIO = 0.12;

export function contentMaxWidth(size: PageVec, direction: TextDirection): number {
  const extent = direction === "vertical" ? size.y : size.x;
  return Math.max(PAGE_OBJECT_MIN_SIZE, extent * (1 - CONTENT_PADDING_RATIO));
}

/** メタデータの deep copy(undo スナップショット・複製で使う)。プレーンな JSON データのみなので JSON 往復で十分。 */
export function clonePageObject(object: PageObject): PageObject {
  return JSON.parse(JSON.stringify(object)) as PageObject;
}

export function clonePageObjects(objects: readonly PageObject[]): PageObject[] {
  return objects.map(clonePageObject);
}
