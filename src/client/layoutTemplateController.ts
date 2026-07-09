/**
 * コマ割りテンプレート選択モーダルの controller。ピッカーの開閉、テンプレ一覧の取得、
 * `.guruguru-layout.json5` の取り込み(登録)と削除を扱う。テンプレからのページ追加自体は
 * ページ操作なので `bookController` の `add-page-from-template` が担当する。
 * data-action は `registerActions`、ファイル入力の change は main.ts の委譲から呼ばれる。
 */
import type { LayoutTemplateSummary, LayoutTemplatesResponse } from "../shared/apiTypes";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { confirmDialog } from "./confirmDialogController";

/** テンプレ一覧を取得して state に載せる。失敗時は layoutTemplates を null のままにして呼び出し側が通知する。 */
export async function refreshLayoutTemplates() {
  state.layoutTemplatesLoading = true;
  requestRender();
  try {
    const data = await api<LayoutTemplatesResponse>("/api/layout-templates");
    state.layoutTemplates = data.templates;
  } finally {
    // 失敗しても loading を必ず下げる(下げないと「読み込み中…」が残り続ける)。
    state.layoutTemplatesLoading = false;
    requestRender();
  }
}

/** ピッカーを開く。未取得なら取得する(取得中はローディング、失敗は再試行可能なエラー表示)。 */
export function openLayoutPicker() {
  if (!state.book) {
    return;
  }
  state.layoutPickerOpen = true;
  requestRender();
  if (state.layoutTemplates === null && !state.layoutTemplatesLoading) {
    void refreshLayoutTemplates().catch((error) => {
      pushToast(error instanceof Error ? error.message : String(error), "error");
    });
  }
}

export function closeLayoutPicker() {
  state.layoutPickerOpen = false;
  requestRender();
}

/** `.guruguru-layout.json5` を読み込んで登録する(main.ts の change 委譲から呼ばれる)。 */
export async function importLayoutFile(input: HTMLInputElement) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) {
    return;
  }
  const text = await file.text();
  const suggestedName = file.name.replace(/\.(guruguru-layout\.)?json5?$/i, "");
  const created = await api<{ template: LayoutTemplateSummary }>("/api/layout-templates", {
    method: "POST",
    body: JSON.stringify({ json5: text, name: suggestedName })
  });
  await refreshLayoutTemplates();
  pushToast(`テンプレート「${created.template.name}」を登録しました。`, "info");
}

/** 取り込みテンプレを削除する。 */
async function deleteLayoutTemplate(id: string) {
  const template = state.layoutTemplates?.find((item) => item.id === id);
  const label = template?.name?.trim() || "このテンプレート";
  const confirmed = await confirmDialog({
    title: "テンプレートを削除",
    message: `テンプレート「${label}」を削除しますか？`,
    confirmLabel: "削除",
    tone: "danger"
  });
  if (!confirmed) {
    return;
  }
  await api(`/api/layout-templates/${id}`, { method: "DELETE" });
  await refreshLayoutTemplates();
  pushToast("テンプレートを削除しました。", "info");
}

registerActions({
  "open-layout-picker": () => openLayoutPicker(),
  "close-layout-picker": () => closeLayoutPicker(),
  "delete-layout-template": (id) => deleteLayoutTemplate(id)
});
