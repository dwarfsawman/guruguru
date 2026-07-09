/**
 * Book Reader（漫画ビューア）のビュー。Mihon / Komikku 系の閲覧 UI を既存トークン
 * （.panel / .button-primary / .segment-group / var(--...)）で組む。ページのペアリングと
 * ページ送りロジックは `bookReader.ts`（純関数）に、状態/操作は `bookReaderController.ts` に
 * 分離してある。ここは state を引数で受け取り HTML を返すだけで main.ts へ逆依存しない。
 *
 * 構成:
 * - topbar（半透明の暗いバー・常に可読）: 閉じる / 前へ・次へ / 設定トグル
 * - stage（背景色を切替可能・レターボックス）: 左右クリックゾーン + ページ画像 + ページ番号ピル
 * - settings（右ドロワー）: 方向 / レイアウト / 見開き開始 / フィット / 背景 / 番号表示
 * クリックゾーンは stage 全面を左右2分割。UI ボタン（topbar / settings）は stage の外なので
 * ページ送りは発火しない（クリックゾーンより上のレイヤ）。
 */
import type { BookPages, PageSummary } from "../../shared/apiTypes";
import { escapeAttr, escapeHtml } from "../format";
import { iconClose, iconSettings } from "../icons";
import {
  getVisibleReaderPages,
  readerPageLabel,
  type BookReaderSettings,
  type VisibleReaderPage
} from "../bookReader";

interface SegmentOption {
  id: string;
  label: string;
  title?: string;
}

export function renderBookReaderView(
  book: BookPages,
  pageIndex: number,
  settings: BookReaderSettings,
  settingsPanelOpen: boolean
): string {
  const pages = book.pages;
  const visible = getVisibleReaderPages(pages, pageIndex, settings);
  const label = readerPageLabel(visible, pages.length);

  return `
    <main class="book-reader" data-bg="${settings.background}">
      <div class="book-reader-topbar">
        <div class="book-reader-topbar-group">
          <button class="button-secondary compact" type="button" data-action="close-book-reader" title="閉じる (Esc)">
            ${iconClose()}閉じる
          </button>
          <span class="book-reader-title">${escapeHtml(book.project.name)}</span>
        </div>
        <div class="book-reader-topbar-group">
          <button class="button-secondary compact" type="button" data-action="book-reader-prev" title="前へ">前へ</button>
          <button class="button-secondary compact" type="button" data-action="book-reader-next" title="次へ">次へ</button>
          <button
            class="${settingsPanelOpen ? "button-primary" : "button-secondary"} compact"
            type="button"
            data-action="book-reader-toggle-settings"
            aria-pressed="${settingsPanelOpen ? "true" : "false"}"
            title="表示設定"
          >${iconSettings()}設定</button>
        </div>
      </div>

      <div class="book-reader-stage">
        <button class="book-reader-zone book-reader-zone-left" type="button" data-action="book-reader-prev" tabindex="-1" aria-label="前のページ"></button>
        <button class="book-reader-zone book-reader-zone-right" type="button" data-action="book-reader-next" tabindex="-1" aria-label="次のページ"></button>
        <div class="book-reader-canvas ${settings.layout} ${settings.fitMode}">
          ${renderCanvasInner(visible, settings)}
        </div>
        ${settings.showPageNumber && pages.length > 0
          ? `<div class="book-reader-page-label" aria-hidden="true">${escapeHtml(label)}</div>`
          : ""}
      </div>

      ${settingsPanelOpen ? renderReaderSettingsPanel(settings) : ""}
    </main>
  `;
}

/** stage 中央のページ本体。0ページは空状態、見開き2ページは間に細い gutter を挟む。 */
function renderCanvasInner(visible: VisibleReaderPage<PageSummary>[], settings: BookReaderSettings): string {
  if (visible.length === 0) {
    return `<div class="book-reader-empty">表示できるページがありません。</div>`;
  }
  const parts = visible.map((entry) => renderReaderPage(entry));
  if (settings.layout === "spread" && parts.length === 2) {
    return `${parts[0]}<div class="book-reader-gutter" aria-hidden="true"></div>${parts[1]}`;
  }
  return parts.join("");
}

function renderReaderPage(entry: VisibleReaderPage<PageSummary>): string {
  const page = entry.page;
  const numberText = String(entry.pageNumber).padStart(2, "0");
  const title = page.title.trim() || `ページ${entry.pageNumber}`;
  if (page.representativeImageUrl) {
    return `
      <figure class="book-reader-page" data-key="reader-page-${escapeAttr(page.id)}">
        <img class="book-reader-image" src="${escapeAttr(page.representativeImageUrl)}" alt="${escapeAttr(title)}" draggable="false" />
      </figure>
    `;
  }
  return `
    <figure class="book-reader-page book-reader-page-empty" data-key="reader-page-${escapeAttr(page.id)}">
      <div class="book-reader-placeholder">
        <span class="book-reader-placeholder-num">Page ${numberText}</span>
        <span class="book-reader-placeholder-text">このページにはまだ代表画像がありません</span>
      </div>
    </figure>
  `;
}

function renderReaderSettingsPanel(settings: BookReaderSettings): string {
  const directionOptions: SegmentOption[] = [
    { id: "rtl", label: "右→左", title: "日本漫画向け（右から左へ読む）" },
    { id: "ltr", label: "左→右", title: "コミック向け（左から右へ読む）" }
  ];
  const layoutOptions: SegmentOption[] = [
    { id: "single", label: "1ページ" },
    { id: "spread", label: "見開き" }
  ];
  const fitOptions: SegmentOption[] = [
    { id: "fit-screen", label: "画面" },
    { id: "fit-width", label: "幅" },
    { id: "fit-height", label: "高さ" }
  ];
  const bgOptions: SegmentOption[] = [
    { id: "black", label: "黒" },
    { id: "gray", label: "グレー" },
    { id: "white", label: "白" }
  ];

  return `
    <aside class="book-reader-settings panel">
      <div class="book-reader-settings-head">
        <span class="section-kicker">Reader 設定</span>
        <button class="book-reader-settings-close" type="button" data-action="book-reader-toggle-settings" aria-label="設定を閉じる" title="閉じる">${iconClose()}</button>
      </div>
      ${renderSegmentRow("方向", "book-reader-set-direction", directionOptions, settings.direction)}
      ${renderSegmentRow("表示", "book-reader-set-layout", layoutOptions, settings.layout)}
      ${renderSpreadStartRow(settings)}
      ${renderSegmentRow("フィット", "book-reader-set-fit", fitOptions, settings.fitMode)}
      ${renderSegmentRow("背景", "book-reader-set-bg", bgOptions, settings.background)}
      ${renderPageNumberRow(settings)}
    </aside>
  `;
}

function renderSegmentRow(labelText: string, action: string, options: SegmentOption[], current: string): string {
  const buttons = options
    .map((option) => {
      const active = option.id === current;
      return `<button
        class="${active ? "button-primary" : "button-secondary"} compact"
        type="button"
        data-action="${action}"
        data-id="${escapeAttr(option.id)}"
        aria-pressed="${active ? "true" : "false"}"
        ${option.title ? `title="${escapeAttr(option.title)}"` : ""}
      >${escapeHtml(option.label)}</button>`;
    })
    .join("");
  return `
    <div class="book-reader-setting">
      <span class="book-reader-setting-label">${escapeHtml(labelText)}</span>
      <div class="segment-group">${buttons}</div>
    </div>
  `;
}

/** 見開き開始ページ（1-based）のステッパー。単ページ表示時も設定は保持できる。 */
function renderSpreadStartRow(settings: BookReaderSettings): string {
  const disabledDec = settings.spreadStartIndex <= 1 ? "disabled" : "";
  return `
    <div class="book-reader-setting">
      <span class="book-reader-setting-label">見開き開始</span>
      <div class="book-reader-stepper">
        <button class="button-secondary compact" type="button" data-action="book-reader-spread-dec" ${disabledDec} aria-label="見開き開始を前へ">−</button>
        <span class="book-reader-stepper-value"><b>${settings.spreadStartIndex}</b> ページ目〜</span>
        <button class="button-secondary compact" type="button" data-action="book-reader-spread-inc" aria-label="見開き開始を後へ">＋</button>
      </div>
    </div>
  `;
}

function renderPageNumberRow(settings: BookReaderSettings): string {
  const on = settings.showPageNumber;
  return `
    <div class="book-reader-setting">
      <span class="book-reader-setting-label">ページ番号</span>
      <button
        class="${on ? "button-primary" : "button-secondary"} compact"
        type="button"
        data-action="book-reader-toggle-page-number"
        aria-pressed="${on ? "true" : "false"}"
      >${on ? "表示" : "非表示"}</button>
    </div>
  `;
}
