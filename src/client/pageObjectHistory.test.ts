import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAGE_OBJECT_HISTORY_LIMIT,
  createPageObjectHistory,
  pushPageObjectHistory,
  redoPageObjects,
  snapshotPageObjects,
  undoPageObjects,
  type PageObjectHistorySnapshot
} from "./pageObjectHistory.ts";
import type { BoxObject } from "../shared/pageObjects.ts";

function box(id: string, x: number): BoxObject {
  return {
    id,
    kind: "box",
    position: { x, y: 0.5 },
    rotation: 0,
    size: { x: 0.1, y: 0.1 },
    cornerRadius: 0,
    fill: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 0.004
  };
}

function snapshot(id: string, x: number, selectedId: string | null = null): PageObjectHistorySnapshot {
  return snapshotPageObjects([box(id, x)], selectedId);
}

test("pushPageObjectHistory: 上限を超えたら底から切り詰める", () => {
  const history = createPageObjectHistory();
  for (let i = 0; i < PAGE_OBJECT_HISTORY_LIMIT + 5; i += 1) {
    pushPageObjectHistory(history, snapshot("a", i));
  }
  assert.equal(history.undoStack.length, PAGE_OBJECT_HISTORY_LIMIT);
  assert.equal(history.undoStack[0]!.objects[0]!.position.x, 5);
  assert.equal(history.undoStack[history.undoStack.length - 1]!.objects[0]!.position.x, PAGE_OBJECT_HISTORY_LIMIT + 4);
});

test("pushPageObjectHistory: push すると redo スタックは破棄される", () => {
  const history = createPageObjectHistory();
  history.redoStack.push(snapshot("stale", 0));
  pushPageObjectHistory(history, snapshot("a", 1));
  assert.equal(history.redoStack.length, 0);
});

test("undoPageObjects: 空スタックは null(current は変更しない)", () => {
  const history = createPageObjectHistory();
  const current = snapshot("a", 1);
  const result = undoPageObjects(history, current);
  assert.equal(result, null);
  assert.equal(history.redoStack.length, 0);
});

test("undoPageObjects/redoPageObjects: 往復して元に戻る", () => {
  const history = createPageObjectHistory();
  const state0 = snapshot("a", 0);
  const state1 = snapshot("a", 1);
  const state2 = snapshot("a", 2);

  // state0 -> state1 -> state2 の順に確定操作した(push は各操作の直前状態)。
  pushPageObjectHistory(history, state0);
  pushPageObjectHistory(history, state1);

  // 現在は state2。undo すると state1 が返り、state2 は redo スタックへ積まれる。
  const afterUndo1 = undoPageObjects(history, state2);
  assert.equal(afterUndo1?.objects[0]!.position.x, 1);

  const afterUndo2 = undoPageObjects(history, afterUndo1!);
  assert.equal(afterUndo2?.objects[0]!.position.x, 0);

  // undo スタックが空になったら次の undo は null。
  assert.equal(undoPageObjects(history, afterUndo2!), null);

  // redo で state1, state2 の順に戻ってくる。
  const afterRedo1 = redoPageObjects(history, afterUndo2!);
  assert.equal(afterRedo1?.objects[0]!.position.x, 1);
  const afterRedo2 = redoPageObjects(history, afterRedo1!);
  assert.equal(afterRedo2?.objects[0]!.position.x, 2);
  assert.equal(redoPageObjects(history, afterRedo2!), null);
});

test("snapshotPageObjects: deep copy(元配列を書き換えても影響しない)", () => {
  const objects = [box("a", 0.5)];
  const snap = snapshotPageObjects(objects, "a");
  objects[0]!.position.x = 0.9;
  assert.equal(snap.objects[0]!.position.x, 0.5);
  assert.equal(snap.selectedId, "a");
});

test("undoPageObjects/redoPageObjects: selectedId も往復する", () => {
  const history = createPageObjectHistory();
  const withSelection = snapshot("a", 0, "a");
  const withoutSelection = snapshot("a", 1, null);
  pushPageObjectHistory(history, withSelection);
  const undone = undoPageObjects(history, withoutSelection);
  assert.equal(undone?.selectedId, "a");
  const redone = redoPageObjects(history, undone!);
  assert.equal(redone?.selectedId, null);
});
