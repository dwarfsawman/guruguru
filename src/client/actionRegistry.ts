/**
 * `data-action` の registry。各 controller が自分の action を `registerActions({...})` で登録し、
 * main.ts のクリックハンドラは登録済み action を registry 経由で dispatch する。
 * 未登録の action は main.ts 内の従来 if/else チェーンへフォールバックする(フェーズ B〜I で順次移行)。
 */
export type ActionHandler = (id: string, target: HTMLElement) => void | Promise<void>;

const actionHandlers = new Map<string, ActionHandler>();

export function registerActions(handlers: Record<string, ActionHandler>) {
  for (const [action, handler] of Object.entries(handlers)) {
    if (actionHandlers.has(action)) {
      throw new Error(`data-action "${action}" は既に登録されています。`);
    }
    actionHandlers.set(action, handler);
  }
}

export function actionHandlerFor(action: string): ActionHandler | undefined {
  return actionHandlers.get(action);
}

/**
 * イベント配線の registry。各 controller が `registerEventBinder(bindXxxEvents)` で登録し、
 * main.ts の `bindEvents` が boot 時に一括で呼び出す。
 */
export type EventBinder = (app: HTMLElement) => void;

const eventBinders: EventBinder[] = [];

export function registerEventBinder(binder: EventBinder) {
  eventBinders.push(binder);
}

export function bindRegisteredEvents(app: HTMLElement) {
  for (const binder of eventBinders) {
    binder(app);
  }
}
