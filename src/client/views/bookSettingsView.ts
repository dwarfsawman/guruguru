/**
 * Book共通設定画面。ページ一覧(bookView)の「Book共通設定」から開き、生成サイドバー(設定モード)で
 * 新規ページの既定値(LoRA/プロンプト/生成パラメータ)を編集する。サイドバー shell(折りたたみ・
 * 幅ドラッグ)は ProjectDetail と共有(galleryView.renderStudioSidebar)。生成パネルの HTML は
 * main.ts が bookSettingsMode で事前 render して渡す(親画像/顔参照セクションは非表示)。
 */
import { escapeHtml } from "../format";
import { iconSettings, iconTrash } from "../icons";
import { renderStudioSidebar } from "./galleryView";

export function renderBookSettingsView(
  projectName: string,
  generationPanelHtml: string,
  sidebarCollapsed: boolean,
  sidebarWidth: number,
  hasCommonSettings: boolean
): string {
  return `
    <div class="studio-shell">
      ${renderStudioSidebar(generationPanelHtml, false, sidebarCollapsed, sidebarWidth)}
      <main class="studio-main">
        <div class="round-toolbar">
          <div>
            <div class="book-breadcrumb">
              <button class="button-secondary compact book-back-button" type="button" data-action="back-from-book-settings">← ページ一覧</button>
              <span class="book-page-label">${escapeHtml(projectName)}</span>
            </div>
            <h1>Book共通設定<span class="tag">${iconSettings()}defaults</span></h1>
            <p>左のサイドバーの内容が<b>新規ページの初期値</b>になります。顔参照画像とseed値は引き継がれません。</p>
          </div>
          <div class="toolbar-actions">
            <button class="button-secondary compact" type="button" data-action="clear-book-settings" ${hasCommonSettings ? "" : "disabled"} title="共通設定をクリアして直前ページ引き継ぎに戻す">${iconTrash()}クリア</button>
            <button class="button-primary compact" type="button" data-action="save-book-settings">保存</button>
          </div>
        </div>
        <div class="book-settings-body">
          <div class="book-settings-card">
            <p class="book-settings-status">${hasCommonSettings ? "共通設定: 設定済み" : "共通設定: 未設定(新規ページは直前ページから引き継ぎ)"}</p>
            <ul class="book-settings-notes">
              <li>「保存」以降に<b>追加した</b>ページへ反映されます(既存ページは変わりません)。</li>
              <li>共通設定を「クリア」すると、新規ページは<b>直前ページ</b>の設定を引き継ぎます。</li>
              <li>顔スタイル参照画像は各ページで空スタート(「最近使った画像」から選べます)。</li>
            </ul>
          </div>
        </div>
      </main>
    </div>
  `;
}
