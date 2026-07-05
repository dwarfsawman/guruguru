import { requestRender, state } from "./appState";
import { setAssetStatus, toggleFavorite, toggleSelect } from "./generationController";
import { findAsset } from "./assetLookup";
import { fillGenerationFormFromAsset } from "./generationDraft";
import { registerActions } from "./actionRegistry";
import { iconClose } from "./icons";
import { escapeHtml } from "./format";

/**
 * アセット詳細表示中のキーボードショートカット(r=却下 / f=お気に入り / space=選択 / Enter=img2imgへ)。
 * 呼び出し元(main.ts)で `state.activeAssetId` 有無・テキスト入力中でないことを確認済みの前提。
 */
export function handleAssetActionShortcuts(event: KeyboardEvent) {
  if (!state.activeAssetId) {
    return;
  }
  if (event.key === "r" || event.key === "R") {
    void setAssetStatus(state.activeAssetId, "rejected");
  }
  if (event.key === "f" || event.key === "F") {
    void toggleFavorite(state.activeAssetId);
  }
  if (event.key === " ") {
    event.preventDefault();
    void toggleSelect(state.activeAssetId);
  }
  if (event.key === "Enter") {
    const asset = findAsset(state.activeAssetId);
    if (asset) {
      fillGenerationFormFromAsset(asset, "img2img");
    }
  }
}

/** UX改善#6: キーボードショートカット一覧オーバーレイ。`?` キーまたはヘッダーのボタンで開閉する。 */
export function toggleShortcutsHelp() {
  state.showShortcutsHelp = !state.showShortcutsHelp;
  requestRender();
}

export function closeShortcutsHelp() {
  if (!state.showShortcutsHelp) {
    return;
  }
  state.showShortcutsHelp = false;
  requestRender();
}

type ShortcutGroup = {
  title: string;
  items: Array<{ keys: string; description: string }>;
};

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "全体",
    items: [
      { keys: "?", description: "このショートカット一覧を開閉" },
      { keys: "Esc", description: "モーダル/サイドバーを閉じる" },
      { keys: "Ctrl / Cmd + A", description: "現在のRoundの全アセットを選択" },
      { keys: "Ctrl / Cmd + Z", description: "Round削除を元に戻す" },
      { keys: "Ctrl / Cmd + Y (または Shift+Z)", description: "Round削除をやり直す" }
    ]
  },
  {
    title: "画像詳細",
    items: [
      { keys: "R", description: "却下としてマーク" },
      { keys: "F", description: "お気に入りを切り替え" },
      { keys: "Space", description: "選択を切り替え" },
      { keys: "Enter", description: "この画像からimg2imgへ" }
    ]
  },
  {
    title: "ペイント編集",
    items: [
      { keys: "Ctrl / Cmd + Z", description: "1手戻す(undo)" },
      { keys: "Alt(押している間)", description: "一時的にスポイトへ切り替え" }
    ]
  },
  {
    title: "ポーズ編集",
    items: [
      { keys: "Ctrl / Cmd + Z", description: "1手戻す(undo)" },
      { keys: "Delete / Backspace", description: "選択中のエッジを削除" }
    ]
  }
];

export function renderShortcutsHelpModal(open: boolean) {
  if (!open) {
    return "";
  }
  const groups = SHORTCUT_GROUPS.map((group) => `
    <section class="shortcuts-help-group">
      <h3>${escapeHtml(group.title)}</h3>
      <dl class="shortcuts-help-list">
        ${group.items.map((item) => `
          <div class="shortcuts-help-row">
            <dt><kbd>${escapeHtml(item.keys)}</kbd></dt>
            <dd>${escapeHtml(item.description)}</dd>
          </div>
        `).join("")}
      </dl>
    </section>
  `).join("");
  return `
    <div class="workflow-modal shortcuts-help-modal" role="dialog" aria-modal="true" aria-label="キーボードショートカット一覧">
      <section class="workflow-dialog shortcuts-help-dialog">
        <header class="workflow-dialog-header">
          <div>
            <p class="section-kicker">Help</p>
            <h2>キーボードショートカット</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-shortcuts-help" aria-label="閉じる" title="閉じる">${iconClose()}</button>
        </header>
        <div class="shortcuts-help-groups">
          ${groups}
        </div>
      </section>
    </div>
  `;
}

registerActions({
  "toggle-shortcuts-help": () => {
    toggleShortcutsHelp();
  },
  "close-shortcuts-help": () => {
    closeShortcutsHelp();
  }
});
