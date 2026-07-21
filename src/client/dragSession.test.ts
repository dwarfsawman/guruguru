import assert from "node:assert/strict";
import test from "node:test";
import { createDragSession } from "./dragSession.ts";

/** setPointerCapture/releasePointerCapture の呼び出しを記録するフェイク要素。 */
function createFakeElement(options: { throwOnCapture?: boolean } = {}) {
  const captured: number[] = [];
  const released: number[] = [];
  return {
    captured,
    released,
    setPointerCapture(pointerId: number): void {
      if (options.throwOnCapture) {
        throw new Error("capture failed");
      }
      captured.push(pointerId);
    },
    releasePointerCapture(pointerId: number): void {
      released.push(pointerId);
    }
  };
}

/** PointerEvent 相当(dragSession が参照するのは pointerId と target だけ)。 */
function fakePointerEvent(pointerId: number, target: unknown = null): PointerEvent {
  return { pointerId, target } as unknown as PointerEvent;
}

test("pointerId が一致する move/up だけを処理し、他ポインタは素通しする", () => {
  const moves: number[] = [];
  const commits: number[] = [];
  const session = createDragSession<{ id: number }>({
    onMove: (event, data) => {
      moves.push(data.id * 1000 + event.pointerId);
    },
    onCommit: (event, data) => {
      commits.push(data.id * 1000 + event.pointerId);
    }
  });
  session.begin(fakePointerEvent(7), { id: 1 }, null);
  assert.equal(session.handleMove(fakePointerEvent(8)), false);
  assert.equal(session.handleMove(fakePointerEvent(7)), true);
  assert.equal(session.handleUp(fakePointerEvent(8)), false);
  assert.deepEqual(session.data, { id: 1 });
  assert.equal(session.handleUp(fakePointerEvent(7)), true);
  assert.equal(session.data, null);
  // up 後は同じ pointerId でも未処理。
  assert.equal(session.handleMove(fakePointerEvent(7)), false);
  assert.equal(session.handleUp(fakePointerEvent(7)), false);
  assert.deepEqual(moves, [1007]);
  assert.deepEqual(commits, [1007]);
});

test("cancel は onCancel(復元)を呼び、onCommit は呼ばない", () => {
  let committed = 0;
  let cancelled = 0;
  const session = createDragSession<Record<string, never>>({
    onCommit: () => {
      committed += 1;
    },
    onCancel: () => {
      cancelled += 1;
    }
  });
  session.begin(fakePointerEvent(3), {}, null);
  assert.equal(session.handleCancel(fakePointerEvent(4)), false);
  assert.equal(session.handleCancel(fakePointerEvent(3)), true);
  assert.equal(committed, 0);
  assert.equal(cancelled, 1);
  assert.equal(session.data, null);
});

test("begin は capture 対象へ setPointerCapture し、up/cancel/reset で release する", () => {
  const element = createFakeElement();
  const session = createDragSession<{ n: number }>({});
  session.begin(fakePointerEvent(11, element), { n: 1 });
  assert.deepEqual(element.captured, [11]);
  session.handleUp(fakePointerEvent(11));
  assert.deepEqual(element.released, [11]);

  session.begin(fakePointerEvent(12, element), { n: 2 });
  session.handleCancel(fakePointerEvent(12));
  assert.deepEqual(element.released, [11, 12]);

  session.begin(fakePointerEvent(13, element), { n: 3 });
  session.reset();
  assert.deepEqual(element.released, [11, 12, 13]);
  assert.equal(session.data, null);
});

test("captureTarget 明示指定は event.target より優先され、null 指定なら capture しない", () => {
  const target = createFakeElement();
  const explicit = createFakeElement();
  const session = createDragSession<{ n: number }>({});
  session.begin(fakePointerEvent(1, target), { n: 1 }, explicit as unknown as Element);
  assert.deepEqual(target.captured, []);
  assert.deepEqual(explicit.captured, [1]);
  session.reset();

  session.begin(fakePointerEvent(2, target), { n: 2 }, null);
  assert.deepEqual(target.captured, []);
  session.reset();
});

test("capture: false なら setPointerCapture を呼ばない", () => {
  const element = createFakeElement();
  const session = createDragSession<{ n: number }>({ capture: false });
  session.begin(fakePointerEvent(5, element), { n: 1 });
  assert.deepEqual(element.captured, []);
  session.handleUp(fakePointerEvent(5));
  assert.deepEqual(element.released, []);
});

test("setPointerCapture が throw してもセッションは開始される", () => {
  const element = createFakeElement({ throwOnCapture: true });
  const session = createDragSession<{ n: number }>({});
  session.begin(fakePointerEvent(6, element), { n: 9 });
  assert.deepEqual(session.data, { n: 9 });
  assert.equal(session.handleMove(fakePointerEvent(6)), true);
});

test("onMove が false を返すとセッションを破棄して未処理として返す(対象消失の互換経路)", () => {
  const element = createFakeElement();
  let cancelled = 0;
  const session = createDragSession<{ alive: boolean }>({
    onMove: (_event, data) => (data.alive ? undefined : false),
    onCancel: () => {
      cancelled += 1;
    }
  });
  session.begin(fakePointerEvent(9, element), { alive: false });
  assert.equal(session.handleMove(fakePointerEvent(9)), false);
  assert.equal(session.data, null);
  assert.deepEqual(element.released, [9]);
  // 破棄後の up/cancel も未処理(onCancel は呼ばれない)。
  assert.equal(session.handleUp(fakePointerEvent(9)), false);
  assert.equal(cancelled, 0);
});

test("begin の上書きは前セッションの capture を解放する", () => {
  const first = createFakeElement();
  const second = createFakeElement();
  const session = createDragSession<{ n: number }>({});
  session.begin(fakePointerEvent(1, first), { n: 1 });
  session.begin(fakePointerEvent(2, second), { n: 2 });
  assert.deepEqual(first.released, [1]);
  assert.deepEqual(second.captured, [2]);
  assert.equal(session.handleUp(fakePointerEvent(1)), false);
  assert.equal(session.handleUp(fakePointerEvent(2)), true);
});
