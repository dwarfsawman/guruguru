/**
 * Book（複数ページ）のページ一覧グリッド。各ページタイルをクリックすると既存の1枚生成 UI へ移り、
 * ドラッグで並び替えできる。色・ボタン・トークンは既存 UI（Home の .panel / round-grid のタイル）に合わせる。
 * state は引数で受け取るため main.ts への逆依存を持たない。DnD は bookController が担当する。
 */
import type { BookPages, PageSummary } from "../../shared/apiTypes";
import { escapeAttr, escapeHtml } from "../format";
import { iconImage, iconMangaPanelImport, iconOpenBook, iconPlus, iconSettings, iconSparkle, iconTrash } from "../icons";
import { renderPageLayoutSvg } from "./pageLayoutSvg";

export function renderBookView(book: BookPages): string {
  const { project, pages } = book;
  return `
    <main class="book-layout">
      <section class="panel">
        <div class="panel-heading">
          <div class="book-heading-copy">
            <p class="section-kicker">Book · ページ一覧</p>
            <h1>${escapeHtml(project.name)}</h1>
            <p class="book-subtitle">画像をクリックすると拡大表示します。拡大画面の「画像生成」またはカード右上の✨から1枚生成画面へ移動できます。ドラッグで並び替えできます。</p>
          </div>
          <div class="book-heading-actions-shell">
            <div class="book-heading-actions">
              <span class="panel-count"><b>${pages.length}</b> pages</span>
              <button class="button-secondary compact book-action-button" type="button" data-action="open-book-settings" aria-label="Book共通設定" title="新規ページの既定設定(LoRA/プロンプト/生成パラメータ)を設定">${iconSettings()}${renderBookActionLabel("Book共通", "設定")}</button>
              <button class="button-secondary compact book-action-button" type="button" data-action="open-layout-picker" aria-label="テンプレから追加" title="コマ割りテンプレートを選んでページ追加">${iconMangaPanelImport()}${renderBookActionLabel("テンプレから", "追加")}</button>
              <label class="button-secondary compact source-upload-button book-action-button" aria-label="画像をインポート" title="画像を新規ページとして取り込む(複数選択可)">
                ${iconImage()}${renderBookActionLabel("画像を", "インポート")}
                <input data-image-import="1" type="file" accept="image/png,image/jpeg,image/webp" multiple />
              </label>
              <button class="button-secondary compact book-action-button" type="button" data-action="add-page" aria-label="ページを追加" title="空のページを追加">${iconPlus()}${renderBookActionLabel("ページを", "追加")}</button>
              <button class="button-primary book-action-button book-reader-button" type="button" data-action="open-book-reader" aria-label="読む" title="漫画ビューアで読む" ${pages.length === 0 ? "disabled" : ""}>${iconOpenBook()}<span class="book-action-text book-action-text-single">読む</span></button>
            </div>
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

function renderBookActionLabel(line1: string, line2: string): string {
  return `<span class="book-action-text"><span>${escapeHtml(line1)}</span><span>${escapeHtml(line2)}</span></span>`;
}

function renderPageCard(page: PageSummary, index: number): string {
  const number = index + 1;
  const title = page.title.trim();
  const label = title || `ページ${number}`;
  // 代表画像があればクリックで lightbox 拡大(フル画像優先、無ければサムネ)。無ければズーム不可。
  // lightbox 内の「画像生成」ボタンから生成画面へ遷移する(data-image-zoom-action=open-page)。
  // 将来はこの拡大表示上で漫画のコマを選んで生成する想定。カード右上の✨は同遷移の直行ショートカット。
  const zoomSrc = page.representativeImageUrl || page.representativeThumbnailUrl;
  const zoomAttrs = zoomSrc
    ? ` data-image-zoom-src="${escapeAttr(zoomSrc)}" data-image-zoom-label="${escapeAttr(label)}"` +
      ` data-image-zoom-action="open-page" data-image-zoom-action-id="${page.id}" data-image-zoom-action-label="画像生成"` +
      ` title="クリックで拡大"`
    : "";
  return `
    <article class="page-card" data-key="page-${page.id}" data-page-id="${page.id}">
      <div class="page-card-body">
        <span class="page-card-thumb${zoomSrc ? " is-zoomable" : ""}"${zoomAttrs}>
          ${renderPageThumb(page, label)}
        </span>
        <span class="page-card-index">${number}</span>
      </div>
      <div class="page-card-actions">
        <button class="page-card-icon generate" type="button" data-action="open-page" data-id="${page.id}" aria-label="${escapeAttr(label)}の生成画面を開く" title="画像生成画面へ">${iconSparkle()}</button>
        <button class="page-card-icon danger" type="button" data-action="delete-page" data-id="${page.id}" aria-label="ページを削除" title="ページを削除">${iconTrash()}</button>
      </div>
    </article>
  `;
}

/**
 * ページのサムネ。代表画像があれば画像、無ければコマ割りレイアウトの枠サムネ、
 * どちらも無ければ空。レイアウト枠サムネにより一覧がコマ割り表示になる。
 */
function renderPageThumb(page: PageSummary, label: string): string {
  if (page.representativeThumbnailUrl) {
    return `<img class="page-thumb-img" src="${escapeAttr(page.representativeThumbnailUrl)}" alt="${escapeAttr(label)}" loading="lazy" draggable="false" />`;
  }
  if (page.layout) {
    return `<span class="page-thumb-layout">${renderPageLayoutSvg(page.layout, { ariaLabel: "コマ割りプレビュー" })}</span>`;
  }
  return "";
}

function renderAddPageCard(): string {
  return `
    <button class="page-add-card" type="button" data-action="add-page" aria-label="ページを追加">
      <span class="page-add-icon">${iconPlus()}</span>
    </button>
  `;
}
