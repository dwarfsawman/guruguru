/**
 * コマ割りテンプレート選択モーダル。Book のページ一覧から「テンプレから追加」で開く。
 * 内蔵プリセット + 取り込み済みテンプレをギャラリー表示し、選ぶとそのレイアウトでページを追加する。
 * `.guruguru-layout.json5` の取り込み(登録)もここから行う。既存の model-install モーダル
 * (`.workflow-modal`/`.workflow-dialog`)に倣った文字列 render + backdrop クリック解除。
 */
import type { LayoutTemplateSummary } from "../../shared/apiTypes";
import { escapeAttr, escapeHtml } from "../format";
import { iconClose, iconMangaPanelImport, iconPlus, iconTrash } from "../icons";
import { renderPageLayoutSvg } from "./pageLayoutSvg";

export function renderLayoutTemplatePicker(templates: LayoutTemplateSummary[] | null, loading: boolean): string {
  return `
    <div class="workflow-modal layout-template-modal" role="dialog" aria-modal="true" aria-label="コマ割りテンプレート">
      <section class="workflow-dialog layout-template-dialog">
        <header class="workflow-dialog-header">
          <div>
            <p class="section-kicker">Book · コマ割りテンプレート</p>
            <h2>テンプレートからページを追加</h2>
          </div>
          <div class="layout-template-header-actions">
            <label class="button-secondary compact source-upload-button" title=".guruguru-layout.json5 を取り込んで登録">
              ${iconMangaPanelImport()}レイアウトを読み込む
              <input data-layout-import="1" type="file" accept=".json5,.json,application/json,text/plain" />
            </label>
            <button class="icon-button" type="button" data-action="close-layout-picker" aria-label="閉じる" title="閉じる">${iconClose()}</button>
          </div>
        </header>
        <div class="layout-template-body">
          ${renderTemplateGallery(templates, loading)}
        </div>
      </section>
    </div>
  `;
}

function renderTemplateGallery(templates: LayoutTemplateSummary[] | null, loading: boolean): string {
  if (templates === null) {
    // null は「取得中」と「取得失敗」の両方を表すので loading で出し分ける(失敗時は再試行を出す)。
    if (loading) {
      return `<p class="layout-template-empty">読み込み中…</p>`;
    }
    return `
      <div class="layout-template-empty">
        <p>テンプレートを読み込めませんでした。</p>
        <button class="button-secondary compact" type="button" data-action="open-layout-picker">再試行</button>
      </div>
    `;
  }
  if (templates.length === 0) {
    return `<p class="layout-template-empty">テンプレートがありません。右上から .json5 を読み込んでください。</p>`;
  }
  return `<div class="layout-template-grid">${templates.map(renderTemplateCard).join("")}</div>`;
}

function renderTemplateCard(template: LayoutTemplateSummary): string {
  const preview = renderPageLayoutSvg(template.layout, {
    className: "layout-template-preview-svg",
    ariaLabel: `${template.name} のコマ割り`
  });
  const panelCount = template.layout.panels.length;
  const badge =
    template.source === "imported"
      ? `<span class="tag layout-template-tag">取り込み</span>`
      : `<span class="tag layout-template-tag builtin">内蔵</span>`;
  const removeButton =
    template.source === "imported"
      ? `<button class="page-card-icon danger" type="button" data-action="delete-layout-template" data-id="${escapeAttr(template.id)}" aria-label="テンプレートを削除" title="テンプレートを削除">${iconTrash()}</button>`
      : "";
  return `
    <article class="layout-template-card" data-key="layout-template-${escapeAttr(template.id)}">
      <button class="layout-template-preview" type="button" data-action="add-page-from-template" data-id="${escapeAttr(template.id)}" title="${escapeAttr(template.name)} でページを追加">
        ${preview}
      </button>
      <div class="layout-template-meta">
        <div class="layout-template-name">${badge}<span title="${escapeAttr(template.name)}">${escapeHtml(template.name)}</span></div>
        <div class="layout-template-card-actions">
          <span class="layout-template-count">${panelCount}コマ</span>
          ${removeButton}
        </div>
      </div>
      <button class="button-primary compact layout-template-add" type="button" data-action="add-page-from-template" data-id="${escapeAttr(template.id)}">${iconPlus()}このテンプレで追加</button>
    </article>
  `;
}
