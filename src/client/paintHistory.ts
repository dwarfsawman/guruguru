/**
 * ペイント編集の統合 undo 履歴。
 * ストローク/クリア/焼き込みは canvas スナップショット(`layer`)、
 * 貼り付けオブジェクト操作はメタデータ配列(`objects`、軽量)として
 * 1 本のスタックに時系列で積み、Ctrl+Z は kind で分岐して復元する。
 *
 * snapshot の型は generic(実運用は HTMLCanvasElement)にして DOM なしでテスト可能にする。
 * `paintTypes.ts` は「DOM 非依存の型のみ」規約のため、この module に分離している。
 */
import type { PastedObject } from "../shared/pasteAttachments";
import { clonePastedObjects } from "../shared/pasteAttachments";

export type PaintHistoryEntry<TSnapshot> =
  | { kind: "layer"; snapshot: TSnapshot }
  | { kind: "objects"; objects: PastedObject[]; selectedId: string | null };

/** layer(canvas スナップショット)エントリの上限。旧 PAINT_UNDO_STACK_LIMIT を継承(メモリ根拠は Feature-PaintTool.md)。 */
export const PAINT_UNDO_LAYER_LIMIT = 5;
/** objects エントリ込みの総数上限。 */
export const PAINT_UNDO_TOTAL_LIMIT = 30;

function layerEntryCount<T>(stack: ReadonlyArray<PaintHistoryEntry<T>>): number {
  let count = 0;
  for (const entry of stack) {
    if (entry.kind === "layer") {
      count += 1;
    }
  }
  return count;
}

/**
 * 履歴エントリを push し、上限を超えた分をスタック底から切り詰める(in-place)。
 * layer エントリ数が上限を超える間は底から shift(底が objects なら一緒に消えるだけで
 * 時系列整合は壊れない)。その後、総数上限でも底から切り詰める。
 */
export function pushPaintHistoryEntry<T>(
  stack: Array<PaintHistoryEntry<T>>,
  entry: PaintHistoryEntry<T>,
  layerLimit = PAINT_UNDO_LAYER_LIMIT,
  totalLimit = PAINT_UNDO_TOTAL_LIMIT
): void {
  stack.push(entry);
  while (layerEntryCount(stack) > layerLimit) {
    stack.shift();
  }
  while (stack.length > totalLimit) {
    stack.shift();
  }
}

/** objects エントリの生成(メタデータの deep copy)。 */
export function objectsHistoryEntry<T>(
  objects: ReadonlyArray<PastedObject>,
  selectedId: string | null
): PaintHistoryEntry<T> {
  return { kind: "objects", objects: clonePastedObjects(objects), selectedId };
}
