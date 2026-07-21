/**
 * debounce 保存の共通ファクトリ。ページ編集 lightbox の「1s debounce PATCH + クローズ時 flush」
 * パターン(`pageObjectsController.ts` / `panelShapeController.ts` / `pageMosaicController.ts`)を
 * 一本化する。何を PATCH するか・応答をどう state へ反映するか・失敗時のトースト等は
 * `persist` コールバックとして各コントローラが注入する(**失敗時挙動はコールバック側の責務**。
 * このファクトリは persist の例外を握り潰さず、直列化チェーンだけ壊れないように防御する)。
 *
 * 旧実装からの修正(直列化バグ): 旧 `startPersist` は in-flight PATCH を待たずに新規発射していたため、
 * (a) debounce 保存と即時保存(`persistNow`)が並走してサーバ側で後着の古いボディが新しい保存を
 * 上書きし得る、(b) 古い応答が新しいドラフトを巻き戻し得る、という競合があった。本実装では
 * - in-flight 中に次の保存要求(schedule/persistNow)が来たら**完了を待ってから最新 state で
 *   1回だけ**発射する(コアレス)。
 * - 各発射に世代番号を振り、`context.isStale()` で「この応答はもう最新ではない」を判定できるようにする
 *   (persist コールバックは応答適用前に isStale を確認する。ドラッグ中スキップ等の追加条件は
 *   コールバック側で従来どおり併用する)。
 * - `flush` は「保留中の debounce・実行中/待機中の PATCH がすべて完了した後」に resolve するので、
 *   lightbox クローズ時に最後の状態が必ずサーバへ届く。
 *
 * 発射タイミングの不変条件(クローズ時の編集消失リグレッション対策 -- 2026-07-21):
 * - `persist` は launch を決めた**その同期実行内で**呼ぶ(マイクロタスクへ遅延しない)。
 *   persist コールバックは冒頭で state から pageId/送信ボディを同期確定する規約なので、
 *   遅延すると `closePagePanelLightbox` が state をクリアした後に走って early return
 *   → クローズ直前1秒以内の編集が失われる。
 * - `flush` は保留(debounce タイマー or コアレス待ち)があれば、in-flight の完了を**待たずに**
 *   その場で発射する(旧実装のクローズ時挙動と同じ並走を flush に限り許容する。並走した旧発射の
 *   応答は世代ガードで stale になり state を巻き戻さない)。schedule/persistNow の直列化は維持。
 */

export interface PersistAttemptContext {
  /**
   * この発射の応答を state へ反映すべきでない(=より新しい保存が予約/発射済み)なら true。
   * 「debounce タイマー再スケジュール済み」「コアレス待ちの次発射あり」「世代が古い」のいずれかで立つ。
   */
  isStale(): boolean;
}

export interface DebouncedPersisterOptions {
  /** debounce 時間(ms)。既定 1000(既存3実装と同じ)。 */
  debounceMs?: number;
  /** 実際の PATCH。エラー処理(トースト等)はこの中で完結させること(reject してもチェーンは壊れない)。 */
  persist(context: PersistAttemptContext): Promise<void>;
  /** テスト用フック(既定は window.setTimeout / window.clearTimeout)。 */
  setTimeoutFn?: (callback: () => void, ms: number) => number;
  clearTimeoutFn?: (id: number) => void;
}

export interface DebouncedPersister {
  /** 編集確定のたびに呼ぶ。debounce タイマーを張り直す。 */
  schedule(): void;
  /**
   * lightbox クローズ時に呼ぶ。保留中の debounce があれば即座に保存を実行し、
   * 実行中/待機中の保存も含めてすべて完了した時点で resolve する。
   */
  flush(): Promise<void>;
  /**
   * debounce を待たず即時保存する(コマ分割のような「サーバ保存完了が前提の後続処理」用)。
   * in-flight があれば完了を待ってから最新 state で発射し、その完了で resolve する。
   */
  persistNow(): Promise<void>;
  /** セッション開始(lightbox を開く直前)に呼ぶ。タイマー・dirty・待機中発射を破棄する。 */
  reset(): void;
  /** 保存成功(または外部 API 経由の保存)を記録する。persist コールバック内の成功時に呼ぶ。 */
  markDirty(): void;
  /** 未保存フラグを返しつつリセットする(lightbox クローズ判定用)。 */
  consumeDirtyFlag(): boolean;
}

export function createDebouncedPersister(options: DebouncedPersisterOptions): DebouncedPersister {
  const debounceMs = options.debounceMs ?? 1000;
  const setTimeoutFn = options.setTimeoutFn ?? ((callback: () => void, ms: number) => window.setTimeout(callback, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((id: number) => window.clearTimeout(id));

  let debounceTimer: number | null = null;
  /** 実行中の PATCH。無ければ null。 */
  let inflight: Promise<void> | null = null;
  /** in-flight 完了後に発射する「次の1回」(コアレス済み)。無ければ null。 */
  let queued: Promise<void> | null = null;
  /** コアレス待ちがまだ launch していない(=保存すべき内容が未送信)間 true。 */
  let queuedPending = false;
  /** flush がコアレス待ちを先取りしたとき、待ち側を新発射の完了へ相乗りさせる。 */
  let queuedPreemptedBy: Promise<void> | null = null;
  /** 発射世代。応答適用は最新発射分のみ許可する。 */
  let generation = 0;
  /** reset で待機中発射を無効化するためのセッション番号。 */
  let session = 0;
  let dirty = false;

  function launch(): Promise<void> {
    generation += 1;
    const gen = generation;
    const context: PersistAttemptContext = {
      isStale: () => gen !== generation || debounceTimer !== null || queuedPending
    };
    // persist はこの同期実行内で呼ぶ(ファイルヘッダの不変条件)。同期 throw も
    // reject 済み Promise に変換してチェーンを壊さない。
    let promise: Promise<void>;
    try {
      promise = Promise.resolve(options.persist(context));
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise = promise.finally(() => {
      if (inflight === promise) {
        inflight = null;
      }
    });
    inflight = promise;
    return promise;
  }

  /** in-flight が無ければ即発射、あれば完了待ちの1回へコアレスする。 */
  function requestPersist(): Promise<void> {
    const current = inflight;
    if (!current) {
      return launch();
    }
    if (!queued) {
      const requestSession = session;
      queuedPending = true;
      queued = current
        .catch(() => {})
        .then(() => {
          queued = null;
          // flush が先取り発射済みなら、その完了を待つだけでよい(二重発射しない)。
          if (queuedPreemptedBy) {
            const preempted = queuedPreemptedBy;
            queuedPreemptedBy = null;
            return preempted.catch(() => {});
          }
          if (!queuedPending) {
            return;
          }
          queuedPending = false;
          // reset 済みセッションの待機発射は破棄する(タイマー破棄と同じ扱い)。
          if (requestSession !== session) {
            return;
          }
          return launch();
        });
    }
    return queued;
  }

  function cancelTimer(): void {
    if (debounceTimer !== null) {
      clearTimeoutFn(debounceTimer);
      debounceTimer = null;
    }
  }

  return {
    schedule(): void {
      cancelTimer();
      debounceTimer = setTimeoutFn(() => {
        debounceTimer = null;
        void requestPersist();
      }, debounceMs);
    },
    flush(): Promise<void> {
      // 未送信の内容(debounce タイマー or 未launchのコアレス待ち)があれば、in-flight を
      // 待たずにその場で発射する -- persist が state をクリアされる前に同期でボディを確定
      // できるようにするため(ファイルヘッダの不変条件)。並走した旧 in-flight の応答は
      // 世代ガードにより stale となり state へは反映されない。
      const hasUnsent = debounceTimer !== null || queuedPending;
      cancelTimer();
      if (hasUnsent) {
        queuedPending = false;
        const previous = inflight;
        const launched = launch();
        if (queued) {
          // コアレス待ちの Promise を持っている呼び出し元(persistNow 等)は新発射の完了へ相乗り。
          queuedPreemptedBy = launched;
        }
        return previous ? Promise.allSettled([previous, launched]).then(() => {}) : launched;
      }
      return queued ?? inflight ?? Promise.resolve();
    },
    persistNow(): Promise<void> {
      cancelTimer();
      return requestPersist();
    },
    reset(): void {
      cancelTimer();
      session += 1;
      queuedPending = false;
      dirty = false;
    },
    markDirty(): void {
      dirty = true;
    },
    consumeDirtyFlag(): boolean {
      const value = dirty;
      dirty = false;
      return value;
    }
  };
}
