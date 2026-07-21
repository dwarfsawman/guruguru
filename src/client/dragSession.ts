/**
 * ポインタドラッグ1種類ぶんの共通セッション管理。
 *
 * クライアントの各コントローラ(コマ形状/モザイク/ページオブジェクト/クロップ/貼り付け等)には
 * 「pointerdown で開始状態を保持 → pointermove を pointerId 照合して delta 適用 → pointerup で
 * 確定(差分検知+履歴+保存) → pointercancel でスナップショット復元」という同一骨格が反復していた。
 * ここはその配線部分(開始状態の保持・pointerId 照合・setPointerCapture/release・up/cancel での
 * 状態クリア)だけを一元化する。座標変換や差分検知・保存はコールバック側(各コントローラ)の責務。
 *
 * capture は既定で有効(`begin` 時に event.target へ setPointerCapture)。ウィンドウ外でボタンを
 * 離してもドラッグが張り付かないようにするための既存実装(pageObjects/crop/paste)の慣行を全ドラッグへ
 * 広げたもの。setPointerCapture 未対応・失敗時も #app への委譲で move/up は届くため try/catch で握る。
 *
 * ハンドラの返り値規約は main.ts の委譲チェーンと同じ「true = 消費(以降のハンドラを呼ばない)」。
 * `onMove` が明示的に `false` を返した場合はセッションを破棄した上で「未処理」として false を返す
 * (対象オブジェクトがドラッグ中に消えた等、従来 `drag = null; return false;` としていた経路の互換)。
 */

export interface DragSessionOptions<T> {
  /**
   * pointermove(pointerId 照合済み)。`false` を返すとセッションを破棄し、ハンドラは false を返す
   * (委譲チェーンの後続へ流す)。それ以外(void/true)は消費扱い。
   */
  onMove?: (event: PointerEvent, data: T) => boolean | void;
  /** pointerup(確定)。呼び出し時点でセッションはクリア済み(コールバック内から次のドラッグを開始できる)。 */
  onCommit?: (event: PointerEvent, data: T) => void;
  /** pointercancel(復元)。呼び出し時点でセッションはクリア済み。 */
  onCancel?: (event: PointerEvent, data: T) => void;
  /** begin 時に setPointerCapture するか(既定 true)。 */
  capture?: boolean;
}

export interface DragSession<T> {
  /** 進行中ドラッグの開始状態(なければ null)。持続保存ガード(「ドラッグ中は draft を上書きしない」)にも使う。 */
  readonly data: T | null;
  /**
   * ドラッグ開始。`captureTarget` 省略時は `event.target`(Element の場合)へ capture する。
   * 進行中セッションがあれば黙って置き換える(従来のモジュール変数上書きと同じ)。
   */
  begin(event: PointerEvent, data: T, captureTarget?: Element | null): void;
  /** 進行中セッションの pointerId と一致するか。 */
  matches(event: Pick<PointerEvent, "pointerId">): boolean;
  handleMove(event: PointerEvent): boolean;
  handleUp(event: PointerEvent): boolean;
  handleCancel(event: PointerEvent): boolean;
  /** コールバックを呼ばずに破棄(セッションリセット・モード離脱用)。capture は解放する。 */
  reset(): void;
}

interface ActiveDrag<T> {
  pointerId: number;
  data: T;
  captureElement: Element | null;
}

function releaseCapture(active: ActiveDrag<unknown> | null): void {
  if (!active?.captureElement || !("releasePointerCapture" in active.captureElement)) {
    return;
  }
  try {
    (active.captureElement as unknown as { releasePointerCapture(pointerId: number): void }).releasePointerCapture(
      active.pointerId
    );
  } catch {
    // すでに解放済み/未取得でも無視してよい。
  }
}

export function createDragSession<T>(options: DragSessionOptions<T> = {}): DragSession<T> {
  const capture = options.capture !== false;
  let active: ActiveDrag<T> | null = null;

  const takeIfMatches = (event: PointerEvent): T | null => {
    if (!active || event.pointerId !== active.pointerId) {
      return null;
    }
    const taken = active;
    active = null;
    releaseCapture(taken);
    return taken.data;
  };

  return {
    get data(): T | null {
      return active?.data ?? null;
    },
    begin(event, data, captureTarget) {
      releaseCapture(active);
      // instanceof Element は DOM の無いテスト環境で参照エラーになるため、機能で判定する。
      const fallback = event.target;
      const element =
        captureTarget !== undefined
          ? captureTarget
          : fallback && typeof (fallback as { setPointerCapture?: unknown }).setPointerCapture === "function"
            ? (fallback as Element)
            : null;
      active = { pointerId: event.pointerId, data, captureElement: capture ? element : null };
      if (capture && element && "setPointerCapture" in element) {
        try {
          (element as unknown as { setPointerCapture(pointerId: number): void }).setPointerCapture(event.pointerId);
        } catch {
          // capture に失敗しても pointermove/up は #app への委譲で届く。
        }
      }
    },
    matches(event) {
      return active !== null && event.pointerId === active.pointerId;
    },
    handleMove(event) {
      if (!active || event.pointerId !== active.pointerId) {
        return false;
      }
      if (options.onMove?.(event, active.data) === false) {
        // 対象消失等: セッションを破棄して「未処理」として後続チェーンへ流す(従来の drag=null; return false 互換)。
        const aborted = active;
        active = null;
        releaseCapture(aborted);
        return false;
      }
      return true;
    },
    handleUp(event) {
      const data = takeIfMatches(event);
      if (data === null) {
        return false;
      }
      options.onCommit?.(event, data);
      return true;
    },
    handleCancel(event) {
      const data = takeIfMatches(event);
      if (data === null) {
        return false;
      }
      options.onCancel?.(event, data);
      return true;
    },
    reset() {
      releaseCapture(active);
      active = null;
    }
  };
}
