/**
 * ページオブジェクト編集(Docs/Feature-CGCollectionSuite.md P1)の undo/redo 履歴。
 * `paintHistory.ts` と同型のスナップショット方式(`{ objects, selectedIds }`)。paintHistory は
 * layer(canvas)エントリと混在する統合スタックで redo を持たないが、ページオブジェクトには
 * canvas レイヤが無く Ctrl+Z / Ctrl+Shift+Z(redo)双方が要件のため、ここでは undo/redo 2本のスタックを持つ。
 * 純ロジックのみ(DOM・state 非依存)。
 * 複数選択(Docs/Feature-PageEditSidebarUx.md 課題C-2)対応: `selectedId: string | null` から
 * `selectedIds: string[]`(先頭=primary)へ拡張した。
 */
import type { PageObject } from "../shared/pageObjects";
import { clonePageObjects } from "../shared/pageObjects";

export interface PageObjectHistorySnapshot {
  objects: PageObject[];
  selectedIds: string[];
}

export interface PageObjectHistoryState {
  undoStack: PageObjectHistorySnapshot[];
  redoStack: PageObjectHistorySnapshot[];
}

/** スタック(undo/redo それぞれ)の総数上限。 */
export const PAGE_OBJECT_HISTORY_LIMIT = 50;

export function createPageObjectHistory(): PageObjectHistoryState {
  return { undoStack: [], redoStack: [] };
}

/** 現在の objects/selectedIds から deep copy スナップショットを作る。 */
export function snapshotPageObjects(objects: readonly PageObject[], selectedIds: readonly string[]): PageObjectHistorySnapshot {
  return { objects: clonePageObjects(objects), selectedIds: [...selectedIds] };
}

/**
 * 確定操作(pointerup・プロパティ変更・追加・削除・z順)の直前状態を undo スタックへ積む。
 * 新しい変更が分岐したら redo チェーンは破棄する(一般的な undo/redo の慣習)。
 */
export function pushPageObjectHistory(
  history: PageObjectHistoryState,
  snapshot: PageObjectHistorySnapshot,
  limit = PAGE_OBJECT_HISTORY_LIMIT
): void {
  history.undoStack.push(snapshot);
  while (history.undoStack.length > limit) {
    history.undoStack.shift();
  }
  history.redoStack.length = 0;
}

/**
 * undo: 現在の状態(`current`)を redo スタックへ積み、undo スタックの直近スナップショットを取り出して返す。
 * undo スタックが空なら null(呼び出し側は何もしない)。
 */
export function undoPageObjects(
  history: PageObjectHistoryState,
  current: PageObjectHistorySnapshot,
  limit = PAGE_OBJECT_HISTORY_LIMIT
): PageObjectHistorySnapshot | null {
  const previous = history.undoStack.pop();
  if (!previous) {
    return null;
  }
  history.redoStack.push(current);
  while (history.redoStack.length > limit) {
    history.redoStack.shift();
  }
  return previous;
}

/** redo: undo の逆。redo スタックが空なら null。 */
export function redoPageObjects(
  history: PageObjectHistoryState,
  current: PageObjectHistorySnapshot,
  limit = PAGE_OBJECT_HISTORY_LIMIT
): PageObjectHistorySnapshot | null {
  const next = history.redoStack.pop();
  if (!next) {
    return null;
  }
  history.undoStack.push(current);
  while (history.undoStack.length > limit) {
    history.undoStack.shift();
  }
  return next;
}
