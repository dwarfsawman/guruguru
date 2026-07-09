import type { ConfirmDialogState } from "../appState";
import { escapeAttr, escapeHtml } from "../format";
import { iconClose, iconTrash } from "../icons";

export function renderConfirmDialog(dialog: ConfirmDialogState | null): string {
  if (!dialog) {
    return "";
  }
  const confirmClass = dialog.tone === "danger" ? "button-danger" : "button-primary";
  return `
    <div class="confirm-dialog-modal" role="presentation">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title-${escapeAttr(dialog.id)}">
        <header class="confirm-dialog-header">
          <div>
            <p class="section-kicker">${dialog.tone === "danger" ? "Confirm delete" : "Confirm"}</p>
            <h2 id="confirm-dialog-title-${escapeAttr(dialog.id)}">${escapeHtml(dialog.title)}</h2>
          </div>
          <button class="icon-button" type="button" data-action="confirm-dialog-cancel" aria-label="閉じる" title="閉じる">${iconClose()}</button>
        </header>
        <p class="confirm-dialog-message">${escapeHtml(dialog.message)}</p>
        <footer class="confirm-dialog-actions">
          <button class="button-secondary" type="button" data-action="confirm-dialog-cancel">${escapeHtml(dialog.cancelLabel)}</button>
          <button class="${confirmClass}" type="button" data-action="confirm-dialog-confirm">
            ${dialog.tone === "danger" ? iconTrash() : ""}
            ${escapeHtml(dialog.confirmLabel)}
          </button>
        </footer>
      </section>
    </div>
  `;
}
