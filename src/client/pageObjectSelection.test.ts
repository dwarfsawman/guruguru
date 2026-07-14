import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyGroupId,
  applyGroupMoveDelta,
  clearGroupId,
  groupMembersOf,
  resolvePageObjectSelectionClick,
  sameSelection
} from "./pageObjectSelection.ts";
import type { BoxObject, PageObject } from "../shared/pageObjects.ts";

function box(id: string, x: number, groupId?: string): BoxObject {
  const object: BoxObject = {
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
  if (groupId) {
    object.groupId = groupId;
  }
  return object;
}

const NO_MODIFIERS = { shiftKey: false, altKey: false };
const SHIFT = { shiftKey: true, altKey: false };
const ALT = { shiftKey: false, altKey: true };

/** 浮動小数点誤差(0.2+0.1 !== 0.3 の類)を許容する座標比較。 */
function assertVecClose(actual: { x: number; y: number }, expected: { x: number; y: number }, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual.x - expected.x) < epsilon, `x: ${actual.x} は ${expected.x} に近似していない`);
  assert.ok(Math.abs(actual.y - expected.y) < epsilon, `y: ${actual.y} は ${expected.y} に近似していない`);
}

// --- groupMembersOf ---

test("groupMembersOf: グループ未所属なら自分自身だけ", () => {
  const objects: PageObject[] = [box("a", 0), box("b", 0.1)];
  assert.deepEqual(groupMembersOf(objects, "a"), ["a"]);
});

test("groupMembersOf: グループ所属なら本人を先頭にグループ全員", () => {
  const objects: PageObject[] = [box("a", 0, "g1"), box("b", 0.1, "g1"), box("c", 0.2, "g1"), box("d", 0.3)];
  assert.deepEqual(groupMembersOf(objects, "b"), ["b", "a", "c"]);
});

test("groupMembersOf: 対象 id が存在しなければ [id] のみ", () => {
  const objects: PageObject[] = [box("a", 0)];
  assert.deepEqual(groupMembersOf(objects, "missing"), ["missing"]);
});

// --- sameSelection ---

test("sameSelection: 内容・順序が同じ場合のみ true", () => {
  assert.equal(sameSelection(["a", "b"], ["a", "b"]), true);
  assert.equal(sameSelection(["a", "b"], ["b", "a"]), false, "順序違いは別扱い(先頭=primary が変わるため)");
  assert.equal(sameSelection(["a"], ["a", "b"]), false);
  assert.equal(sameSelection([], []), true);
});

// --- resolvePageObjectSelectionClick ---

test("resolvePageObjectSelectionClick: 通常クリック(ungrouped)は単独選択へ置き換える", () => {
  const objects: PageObject[] = [box("a", 0), box("b", 0.1)];
  const next = resolvePageObjectSelectionClick(objects, ["b"], "a", NO_MODIFIERS);
  assert.deepEqual(next, ["a"]);
});

test("resolvePageObjectSelectionClick: 通常クリック(grouped)はグループ全員を選択し、クリックした本人が先頭", () => {
  const objects: PageObject[] = [box("a", 0, "g1"), box("b", 0.1, "g1"), box("c", 0.2)];
  const next = resolvePageObjectSelectionClick(objects, [], "b", NO_MODIFIERS);
  assert.deepEqual(next, ["b", "a"]);
});

test("resolvePageObjectSelectionClick: Shift+クリックは未選択分だけ末尾へ追加し、既存の並び(primary)を保つ", () => {
  const objects: PageObject[] = [box("a", 0), box("b", 0.1), box("c", 0.2)];
  const next = resolvePageObjectSelectionClick(objects, ["a"], "b", SHIFT);
  assert.deepEqual(next, ["a", "b"]);
});

test("resolvePageObjectSelectionClick: Shift+クリックで対象グループが全員選択済みならグループごと除外する", () => {
  const objects: PageObject[] = [box("a", 0, "g1"), box("b", 0.1, "g1"), box("c", 0.2)];
  const next = resolvePageObjectSelectionClick(objects, ["c", "a", "b"], "a", SHIFT);
  assert.deepEqual(next, ["c"]);
});

test("resolvePageObjectSelectionClick: Shift+クリックで対象グループの一部だけ選択済みなら残りを追加する(トグルOFFにはしない)", () => {
  const objects: PageObject[] = [box("a", 0, "g1"), box("b", 0.1, "g1"), box("c", 0.2, "g1")];
  // a だけが選択済みの状態で、同じグループの b を shift+クリック → グループ全員が選択される。
  const next = resolvePageObjectSelectionClick(objects, ["a"], "b", SHIFT);
  assert.deepEqual(next, ["a", "b", "c"]);
});

test("resolvePageObjectSelectionClick: Alt+クリックはグループを無視して1個だけ選択する", () => {
  const objects: PageObject[] = [box("a", 0, "g1"), box("b", 0.1, "g1")];
  assert.deepEqual(resolvePageObjectSelectionClick(objects, ["b"], "a", ALT), ["a"]);
  // Shift+Alt 同時押下でも Alt が優先される。
  assert.deepEqual(resolvePageObjectSelectionClick(objects, ["b"], "a", { shiftKey: true, altKey: true }), ["a"]);
});

// --- applyGroupId / clearGroupId ---

test("applyGroupId: 選択中のオブジェクトだけへ新規 groupId を割り当てる(既存グループ混在は上書きで結合)", () => {
  const objects: PageObject[] = [box("a", 0, "old-group"), box("b", 0.1), box("c", 0.2)];
  const next = applyGroupId(objects, ["a", "b"], "new-group");
  assert.equal((next[0] as BoxObject).groupId, "new-group");
  assert.equal((next[1] as BoxObject).groupId, "new-group");
  assert.equal((next[2] as BoxObject).groupId, undefined, "選択外のオブジェクトは変更しない");
  assert.equal(next[2], objects[2], "選択外のオブジェクトは参照も維持する(無駄な再描画を避ける)");
});

test("clearGroupId: 選択中オブジェクトの groupId キー自体を外す", () => {
  const objects: PageObject[] = [box("a", 0, "g1"), box("b", 0.1, "g1"), box("c", 0.2)];
  const next = clearGroupId(objects, ["a"]);
  assert.ok(!("groupId" in (next[0] as object)), "空文字ではなくキー自体が無くなる");
  assert.equal((next[1] as BoxObject).groupId, "g1", "選択外は維持");
  assert.equal(next[2], objects[2], "groupId を元々持たないオブジェクトは参照も維持する");
});

// --- applyGroupMoveDelta ---

test("applyGroupMoveDelta: startObjects に含まれる id だけ、開始位置 + delta へ更新する", () => {
  const objects = [box("a", 0.5), box("b", 0.2), box("c", 0.9)];
  const startObjects = [box("a", 0.5), box("b", 0.2)]; // ドラッグ開始時点のコピー(a, b だけが選択中)
  const next = applyGroupMoveDelta(objects, startObjects, 0.1, -0.05);
  assertVecClose(next[0]!.position, { x: 0.6, y: 0.45 });
  assertVecClose(next[1]!.position, { x: 0.3, y: 0.45 });
  assert.equal(next[2], objects[2], "startObjects に無い c は変更されない(参照維持)");
});

test("applyGroupMoveDelta: 開始位置基準の絶対 delta なので、複数回適用しても誤差が蓄積しない", () => {
  const start = [box("a", 0.5)];
  const afterFirst = applyGroupMoveDelta([box("a", 0.5)], start, 0.1, 0);
  // 同じ start を基準に2回目の delta(0.05)を適用しても 0.5+0.05=0.55 になる(0.6+0.05 の積み上げにならない)。
  const afterSecond = applyGroupMoveDelta(afterFirst, start, 0.05, 0);
  assert.ok(Math.abs(afterSecond[0]!.position.x - 0.55) < 1e-9);
});

test("applyGroupMoveDelta: 単一選択(startObjects 1件)でも同じ経路で動く", () => {
  const objects = [box("solo", 0.4)];
  const next = applyGroupMoveDelta(objects, [box("solo", 0.4)], 0.2, 0.2);
  assertVecClose(next[0]!.position, { x: 0.6, y: 0.7 });
});
