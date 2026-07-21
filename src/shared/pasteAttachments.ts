/**
 * 画像貼り付け(Paste & Transform)の添付オブジェクト型と検証。
 * クライアント(draft 正規化)とサーバ(paste-attachments PUT の検証、
 * 生成リクエストの pasteComposite.objects 記録)で共用する。
 * DOM・state に依存しない純粋な型と関数のみを持つ。
 */
import { isFiniteNumber } from "./numbers";

/** 添付オブジェクトの変形。座標・寸法は元画像の natural px、回転はラジアン。アンカーはオブジェクト中心。 */
export interface PasteTransform {
  x: number;
  y: number;
  rotation: number;
  /** UI は当面 uniform スケールのみだが、将来の自由変形に備え分離して持つ。 */
  scaleX: number;
  scaleY: number;
}

/** アセットに紐づく貼り付けオブジェクト 1 件。配列内の位置が z順(先頭=最背面)。 */
export interface PastedObject {
  id: string;
  /** paste-sources のキー(サーバ永続のソース画像)。複製で共有可。 */
  sourceId: string;
  /** 取り込み後ソースビットマップの px(長辺 PASTE_MAX_SOURCE_DIMENSION キャップ後)。 */
  sourceWidth: number;
  sourceHeight: number;
  transform: PasteTransform;
}

/** 取り込み時にソース画像をダウンスケールする長辺キャップ(px)。 */
export const PASTE_MAX_SOURCE_DIMENSION = 4096;
/** Shift 押下中の回転スナップ刻み(度)。 */
export const PASTE_ROTATION_SNAP_DEG = 15;
/** 1 アセットに添付できるオブジェクト数の上限(暴走 PUT へのサーバ側ガードと共用)。 */
export const PASTE_MAX_OBJECTS = 64;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isValidTransform(value: unknown): value is PasteTransform {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const transform = value as Record<string, unknown>;
  return (
    isFiniteNumber(transform.x) &&
    isFiniteNumber(transform.y) &&
    isFiniteNumber(transform.rotation) &&
    isFiniteNumber(transform.scaleX) &&
    isFiniteNumber(transform.scaleY) &&
    (transform.scaleX as number) > 0 &&
    (transform.scaleY as number) > 0
  );
}

function isValidPastedObject(value: unknown): value is PastedObject {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.id) &&
    isNonEmptyString(record.sourceId) &&
    isFiniteNumber(record.sourceWidth) &&
    isFiniteNumber(record.sourceHeight) &&
    (record.sourceWidth as number) > 0 &&
    (record.sourceHeight as number) > 0 &&
    isValidTransform(record.transform)
  );
}

/**
 * 添付オブジェクト配列の寛容な正規化(クライアント draft 用)。
 * 不正なエントリは黙って除外し、余分なフィールドを落とした複製を返す。
 * 配列でない入力は空配列を返す。
 */
export function sanitizePastedObjects(input: unknown): PastedObject[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const sanitized: PastedObject[] = [];
  for (const entry of input) {
    if (!isValidPastedObject(entry)) {
      continue;
    }
    sanitized.push(clonePastedObject(entry));
    if (sanitized.length >= PASTE_MAX_OBJECTS) {
      break;
    }
  }
  return sanitized;
}

/**
 * 添付オブジェクト配列の厳格な検証(サーバ PUT 用)。
 * 問題があればユーザー向けエラーメッセージを、正常なら null を返す。
 */
export function pastedObjectsValidationError(input: unknown): string | null {
  if (!Array.isArray(input)) {
    return "objects must be an array.";
  }
  if (input.length > PASTE_MAX_OBJECTS) {
    return `objects must contain at most ${PASTE_MAX_OBJECTS} entries.`;
  }
  const seenIds = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    if (!isValidPastedObject(input[index])) {
      return `objects[${index}] is not a valid pasted object.`;
    }
    const id = (input[index] as PastedObject).id;
    if (seenIds.has(id)) {
      return `objects[${index}] has a duplicated id.`;
    }
    seenIds.add(id);
  }
  return null;
}

/** メタデータのみの deep copy(undo スナップショット・正規化で共用)。 */
export function clonePastedObject(object: PastedObject): PastedObject {
  return {
    id: object.id,
    sourceId: object.sourceId,
    sourceWidth: object.sourceWidth,
    sourceHeight: object.sourceHeight,
    transform: { ...object.transform }
  };
}

export function clonePastedObjects(objects: readonly PastedObject[]): PastedObject[] {
  return objects.map(clonePastedObject);
}
