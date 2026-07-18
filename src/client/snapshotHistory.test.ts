import assert from "node:assert/strict";
import test from "node:test";
import {
  createSnapshotHistory,
  pushSnapshot,
  redoSnapshot,
  undoSnapshot
} from "./snapshotHistory.ts";

test("snapshotHistory: push/undo/redo と分岐時の redo 破棄", () => {
  const history = createSnapshotHistory<string>();
  assert.equal(undoSnapshot(history, "s0"), null);

  pushSnapshot(history, "s0"); // 操作1の直前
  pushSnapshot(history, "s1"); // 操作2の直前
  // 現在 s2。undo → s1、redo スタックへ s2。
  assert.equal(undoSnapshot(history, "s2"), "s1");
  assert.equal(redoSnapshot(history, "s1"), "s2");
  assert.equal(undoSnapshot(history, "s2"), "s1");
  assert.equal(undoSnapshot(history, "s1"), "s0");
  assert.equal(undoSnapshot(history, "s0"), null);
  assert.equal(redoSnapshot(history, "s0"), "s1");

  // 分岐: 新しい確定操作で redo チェーンは破棄される。
  pushSnapshot(history, "s1b");
  assert.equal(redoSnapshot(history, "s2b"), null);
  assert.equal(undoSnapshot(history, "s2b"), "s1b");
});

test("snapshotHistory: 上限を超えた古いスナップショットは捨てられる", () => {
  const history = createSnapshotHistory<number>();
  for (let i = 0; i < 10; i += 1) pushSnapshot(history, i, 3);
  assert.equal(history.undoStack.length, 3);
  assert.deepEqual(history.undoStack, [7, 8, 9]);
});
