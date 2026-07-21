import assert from "node:assert/strict";
import test from "node:test";
import { createDebouncedPersister, type PersistAttemptContext } from "./debouncedPersister.ts";

/** 手動発火のフェイクタイマー(debounce の張り直し/キャンセルを決定的に検証する)。 */
function createFakeTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimeoutFn: (callback: () => void, _ms: number): number => {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    clearTimeoutFn: (id: number): void => {
      pending.delete(id);
    },
    fire(): void {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    pendingCount(): number {
      return pending.size;
    }
  };
}

/** 手動 resolve のフェイク persist(発射回数と各発射の isStale を観測する)。 */
function createFakePersist() {
  const calls: Array<{ context: PersistAttemptContext; resolve: () => void }> = [];
  const persist = (context: PersistAttemptContext): Promise<void> =>
    new Promise<void>((resolve) => {
      calls.push({ context, resolve });
    });
  return { calls, persist };
}

/** マイクロタスクを流しきる(then チェーンの進行待ち)。 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function setup() {
  const timers = createFakeTimers();
  const fake = createFakePersist();
  const persister = createDebouncedPersister({
    persist: fake.persist,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });
  return { timers, fake, persister };
}

test("schedule を連打しても debounce 発火は1回にコアレスされる", async () => {
  const { timers, fake, persister } = setup();
  persister.schedule();
  persister.schedule();
  persister.schedule();
  assert.equal(timers.pendingCount(), 1);
  timers.fire();
  await drainMicrotasks();
  assert.equal(fake.calls.length, 1);
});

test("in-flight 中の保存要求は完了待ち後に最新 state で1回だけ発射される(直列化+コアレス)", async () => {
  const { timers, fake, persister } = setup();
  persister.schedule();
  timers.fire();
  await drainMicrotasks();
  assert.equal(fake.calls.length, 1);

  // in-flight 中に3回要求(debounce 発火2回相当+persistNow 1回)しても並走しない。
  persister.schedule();
  timers.fire();
  persister.schedule();
  timers.fire();
  const nowPromise = persister.persistNow();
  await drainMicrotasks();
  assert.equal(fake.calls.length, 1, "in-flight 完了前に新規発射してはならない");

  fake.calls[0]!.resolve();
  await drainMicrotasks();
  assert.equal(fake.calls.length, 2, "完了後にコアレス済みの1回だけ発射される");

  fake.calls[1]!.resolve();
  await nowPromise; // persistNow はコアレス発射の完了で resolve する
  await drainMicrotasks();
  assert.equal(fake.calls.length, 2);
});

test("古い発射の応答は isStale=true になり、最新発射のみ isStale=false", async () => {
  const { timers, fake, persister } = setup();
  persister.schedule();
  timers.fire();
  await drainMicrotasks();
  assert.equal(fake.calls[0]!.context.isStale(), false, "後続要求が無ければ最新");

  // in-flight 中に次の保存が予約された時点で1発目は stale になる。
  void persister.persistNow();
  await drainMicrotasks();
  assert.equal(fake.calls[0]!.context.isStale(), true, "コアレス待ちが居る間は stale");

  fake.calls[0]!.resolve();
  await drainMicrotasks();
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0]!.context.isStale(), true, "世代が進んだ後も stale のまま");
  assert.equal(fake.calls[1]!.context.isStale(), false);

  // debounce タイマーが張られている間も stale(旧実装の saveDebounceTimer === null ガード相当)。
  persister.schedule();
  assert.equal(fake.calls[1]!.context.isStale(), true);
  timers.fire();
  fake.calls[1]!.resolve();
  await drainMicrotasks();
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[2]!.context.isStale(), false);
});

test("flush は保留中の debounce を即時発射し、その完了で resolve する", async () => {
  const { timers, fake, persister } = setup();
  persister.schedule();
  assert.equal(timers.pendingCount(), 1);
  let flushed = false;
  const flushPromise = persister.flush().then(() => {
    flushed = true;
  });
  assert.equal(timers.pendingCount(), 0, "flush はタイマーをキャンセルする");
  await drainMicrotasks();
  assert.equal(fake.calls.length, 1, "flush で即時発射される");
  assert.equal(flushed, false, "PATCH 完了前に resolve してはならない");
  fake.calls[0]!.resolve();
  await flushPromise;
  assert.equal(flushed, true);
});

test("in-flight+保留 debounce の状態で flush すると、最終 state の発射完了まで待てる", async () => {
  const { timers, fake, persister } = setup();
  persister.schedule();
  timers.fire();
  await drainMicrotasks();
  persister.schedule(); // in-flight 中の追加編集

  let flushed = false;
  const flushPromise = persister.flush().then(() => {
    flushed = true;
  });
  await drainMicrotasks();
  assert.equal(fake.calls.length, 1, "in-flight 完了までは2発目を出さない");

  fake.calls[0]!.resolve();
  await drainMicrotasks();
  assert.equal(fake.calls.length, 2, "in-flight 完了後に最終 state で発射される");
  assert.equal(flushed, false);
  fake.calls[1]!.resolve();
  await flushPromise;
  assert.equal(flushed, true);
});

test("保留も in-flight も無い flush は発射せず即 resolve する", async () => {
  const { fake, persister } = setup();
  await persister.flush();
  assert.equal(fake.calls.length, 0);
});

test("persist が reject しても直列化チェーンは壊れず次の発射が出る", async () => {
  const timers = createFakeTimers();
  let callCount = 0;
  const persister = createDebouncedPersister({
    persist: () => {
      callCount += 1;
      return callCount === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });
  const first = persister.persistNow();
  const second = persister.persistNow(); // 1発目 in-flight 中に要求
  await assert.rejects(first);
  await second;
  assert.equal(callCount, 2);
});

test("dirty フラグ: markDirty/consumeDirtyFlag/reset", () => {
  const { persister } = setup();
  assert.equal(persister.consumeDirtyFlag(), false);
  persister.markDirty();
  assert.equal(persister.consumeDirtyFlag(), true);
  assert.equal(persister.consumeDirtyFlag(), false, "consume でリセットされる");
  persister.markDirty();
  persister.reset();
  assert.equal(persister.consumeDirtyFlag(), false, "reset で破棄される");
});

test("reset はタイマーとコアレス待ち発射を破棄する(旧セッションの PATCH を新セッションで出さない)", async () => {
  const { timers, fake, persister } = setup();
  persister.schedule();
  persister.reset();
  assert.equal(timers.pendingCount(), 0);
  timers.fire();
  await drainMicrotasks();
  assert.equal(fake.calls.length, 0, "reset 後にタイマー発火してはならない");

  // in-flight+コアレス待ちの状態で reset → in-flight 完了後もコアレス分は発射しない。
  void persister.persistNow();
  await drainMicrotasks();
  const queuedPromise = persister.persistNow();
  persister.reset();
  fake.calls[0]!.resolve();
  await queuedPromise;
  await drainMicrotasks();
  assert.equal(fake.calls.length, 1, "reset 済みセッションの待機発射は破棄される");
});
