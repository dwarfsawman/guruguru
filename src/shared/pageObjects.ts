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
}

export interface TextObject extends PageObjectBase {
  kind: "text";
  content: TextContent;
  /** 折り返し幅(page 単位)。未指定は折り返しなし。 */
  maxWidth?: number;
}

export type BalloonShape = "ellipse" | "rounded" | "cloud" | "jagged" | "thought";

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

export type PageObject = TextObject | BalloonObject | BoxObject;

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
}

function normalizeBase(raw: Record<string, unknown>, fallbackId: string): NormalizedBase | null {
  const position = asVec(raw.position);
  if (!position) {
    return null;
  }
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : fallbackId;
  return { id, position, rotation: normalizeRotation(raw.rotation) };
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
  const object: TextObject = { id: base.id, kind: "text", position: base.position, rotation: base.rotation, content };
  if (isFiniteNumber(raw.maxWidth) && raw.maxWidth > 0) {
    object.maxWidth = clampNumber(raw.maxWidth, 0.01, PAGE_OBJECT_MAX_SIZE, raw.maxWidth);
  }
  return object;
}

const BALLOON_SHAPES = new Set<BalloonShape>(["ellipse", "rounded", "cloud", "jagged", "thought"]);

function normalizeBalloonObject(raw: Record<string, unknown>, fallbackId: string): BalloonObject | null {
  const base = normalizeBase(raw, fallbackId);
  const size = normalizeSize(raw.size);
  if (!base || !size) {
    return null;
  }
  const shape: BalloonShape =
    typeof raw.shape === "string" && BALLOON_SHAPES.has(raw.shape as BalloonShape) ? (raw.shape as BalloonShape) : "ellipse";
  const object: BalloonObject = {
    id: base.id,
    kind: "balloon",
    position: base.position,
    rotation: base.rotation,
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
    id: base.id,
    kind: "box",
    position: base.position,
    rotation: base.rotation,
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

/** しっぽトグル ON 時の既定しっぽ(下向き、ローカル座標)。size は toggle 時点のオブジェクトの size。 */
export function defaultBalloonTail(size: PageVec): BalloonTail {
  return {
    tip: { x: 0, y: size.y / 2 + Math.max(0.05, size.y * 0.4) },
    width: DEFAULT_BALLOON_TAIL_WIDTH
  };
}

/** box/balloon 内包テキストの折り返し幅(page 単位)。パディング分だけ形状のサイズより小さくする。 */
const CONTENT_PADDING_RATIO = 0.12;

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
