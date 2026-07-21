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
 * - in-flight 中に次の保存要求が来たら**完了を待ってから最新 state で1回だけ**発射する(コアレス)。
 * - 各発射に世代番号を振り、`context.isStale()` で「この応答はもう最新ではない」を判定できるようにする
 *   (persist コールバックは応答適用前に isStale を確認する。ドラッグ中スキップ等の追加条件は
 *   コールバック側で従来どおり併用する)。
 * - `flush` は「保留中の debounce・実行中/待機中の PATCH がすべて完了した後」に resolve するので、
 *   lightbox クローズ時に最後の状態が必ずサーバへ届く。
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
  /** 発射世代。応答適用は最新発射分のみ許可する。 */
  let generation = 0;
  /** reset で待機中発射を無効化するためのセッション番号。 */
  let session = 0;
  let dirty = false;

  function launch(): Promise<void> {
    generation += 1;
    const gen = generation;
    const context: PersistAttemptContext = {
      isStale: () => gen !== generation || debounceTimer !== null || queued !== null
    };
    const promise = Promise.resolve()
      .then(() => options.persist(context))
      .finally(() => {
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
      queued = current
        .catch(() => {})
        .then(() => {
          queued = null;
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
      if (debounceTimer !== null) {
        cancelTimer();
        return requestPersist();
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
