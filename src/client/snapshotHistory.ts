/**
 * 汎用スナップショット undo/redo(pageObjectHistory.ts と同型の2スタック方式を任意の型へ一般化)。
 * コマ割りジオメトリ編集(ページ編集コマ枠モード/ネームスタジオ)の履歴に使う。
 * 純ロジックのみ(DOM・state 非依存)。スナップショットの deep copy は呼び出し側の責務。
 */

export interface SnapshotHistory<T> {
  undoStack: T[];
  redoStack: T[];
}

export const SNAPSHOT_HISTORY_LIMIT = 50;

export function createSnapshotHistory<T>(): SnapshotHistory<T> {
  return { undoStack: [], redoStack: [] };
}

/** 確定操作の直前状態を undo スタックへ積む。新しい変更が分岐したら redo チェーンは破棄する。 */
export function pushSnapshot<T>(history: SnapshotHistory<T>, snapshot: T, limit = SNAPSHOT_HISTORY_LIMIT): void {
  history.undoStack.push(snapshot);
  while (history.undoStack.length > limit) {
    history.undoStack.shift();
  }
  history.redoStack.length = 0;
}

/** undo: 現在状態を redo へ積み、直近スナップショットを返す(空なら null)。 */
export function undoSnapshot<T>(history: SnapshotHistory<T>, current: T, limit = SNAPSHOT_HISTORY_LIMIT): T | null {
  const previous = history.undoStack.pop();
  if (previous === undefined) return null;
  history.redoStack.push(current);
  while (history.redoStack.length > limit) {
    history.redoStack.shift();
  }
  return previous;
}

/** redo: undo の逆(空なら null)。 */
export function redoSnapshot<T>(history: SnapshotHistory<T>, current: T, limit = SNAPSHOT_HISTORY_LIMIT): T | null {
  const next = history.redoStack.pop();
  if (next === undefined) return null;
  history.undoStack.push(current);
  while (history.undoStack.length > limit) {
    history.undoStack.shift();
  }
  return next;
}

export function clearSnapshotHistory<T>(history: SnapshotHistory<T>): void {
  history.undoStack.length = 0;
  history.redoStack.length = 0;
}
