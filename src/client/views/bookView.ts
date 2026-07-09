/**
 * Book（複数ページ）のページ一覧グリッド。各ページタイルをクリックすると既存の1枚生成 UI へ移り、
 * ドラッグで並び替えできる。色・ボタン・トークンは既存 UI（Home の .panel / round-grid のタイル）に合わせる。
 * state は引数で受け取るため main.ts への逆依存を持たない。DnD は bookController が担当する。
 */
import type { BookPages, PageSummary } from "../../shared/apiTypes";
import { escapeAttr, escapeHtml } from "../format";
import { iconImage, iconPlus, iconSettings, iconTrash } from "../icons";

export function renderBookView(book: BookPages): string {
  const { project, pages } = book;
  return `
    <main class="book-layout">
      <section class="panel">
        <div class="panel-heading">
          <div>
            <p class="section-kicker">Book · ページ一覧</p>
            <h1>${escapeHtml(project.name)}</h1>
            <p class="book-subtitle">ページをクリックすると1枚生成画面へ移動します。ドラッグで並び替えできます。</p>
          </div>
          <div class="book-heading-actions">
            <span class="panel-count"><b>${pages.length}</b> pages</span>
            <button class="button-secondary compact" type="button" data-action="open-book-settings" title="新規ページの既定設定(LoRA/プロンプト/生成パラメータ)を設定">${iconSettings()}Book共通設定</button>
            <button class="button-secondary compact" type="button" data-action="add-page">${iconPlus()}ページ追加</button>
            <button class="button-primary" type="button" data-action="open-book-reader" title="漫画ビューアで読む" ${pages.length === 0 ? "disabled" : ""}>${iconImage()}読む</button>
          </div>
        </div>
        <div class="image-grid page-grid">
          ${pages.map((page, index) => renderPageCard(page, index)).join("")}
          ${renderAddPageCard()}
        </div>
      </section>
    </main>
  `;
}

function renderPageCard(page: PageSummary, index: number): string {
  const number = index + 1;
  const title = page.title.trim();
  const label = title || `ページ${number}`;
  return `
    <article class="page-card" data-key="page-${page.id}" data-page-id="${page.id}">
      <button class="page-card-open" type="button" data-action="open-page" data-id="${page.id}" aria-label="${escapeAttr(label)}を開く" title="${escapeAttr(label)}">
        <span class="page-card-thumb">
          ${page.representativeThumbnailUrl
            ? `<img class="page-thumb-img" src="${escapeAttr(page.representativeThumbnailUrl)}" alt="" loading="lazy" draggable="false" />`
            : ""}
        </span>
        <span class="page-card-index">${number}</span>
      </button>
      <div class="page-card-actions">
        <button class="page-card-icon" type="button" data-action="rename-page" data-id="${page.id}" aria-label="ページ名を変更" title="ページ名を変更">${iconSettings()}</button>
        <button class="page-card-icon danger" type="button" data-action="delete-page" data-id="${page.id}" aria-label="ページを削除" title="ページを削除">${iconTrash()}</button>
      </div>
    </article>
  `;
}

function renderAddPageCard(): string {
  return `
    <button class="page-add-card" type="button" data-action="add-page" aria-label="ページを追加">
      <span class="page-add-icon">${iconPlus()}</span>
    </button>
  `;
}
