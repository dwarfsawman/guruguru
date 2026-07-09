import { requestRender, state, type ConfirmDialogState } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";

type ConfirmDialogOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogState["tone"];
};

let confirmDialogCounter = 0;
let pendingResolve: ((confirmed: boolean) => void) | null = null;

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (pendingResolve) {
    pendingResolve(false);
  }
  const id = `confirm-${++confirmDialogCounter}`;
  state.confirmDialog = {
    id,
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel ?? "実行",
    cancelLabel: options.cancelLabel ?? "キャンセル",
    tone: options.tone ?? "default"
  };
  requestRender();
  return new Promise<boolean>((resolve) => {
    pendingResolve = resolve;
  });
}

function resolveConfirmDialog(confirmed: boolean) {
  if (!state.confirmDialog && !pendingResolve) {
    return;
  }
  const resolve = pendingResolve;
  pendingResolve = null;
  state.confirmDialog = null;
  requestRender();
  resolve?.(confirmed);
}

function bindConfirmDialogEvents(app: HTMLElement) {
  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("confirm-dialog-modal")) {
      resolveConfirmDialog(false);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.confirmDialog) {
      return;
    }
    event.preventDefault();
    resolveConfirmDialog(false);
  });
}

registerActions({
  "confirm-dialog-confirm": () => resolveConfirmDialog(true),
  "confirm-dialog-cancel": () => resolveConfirmDialog(false)
});

registerEventBinder(bindConfirmDialogEvents);
