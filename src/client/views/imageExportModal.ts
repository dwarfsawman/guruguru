/**
 * 完成品のエクスポート(Docs/Feature-CGCollectionSuite.md P4)ダイアログ。Book のページ一覧
 * (見出し「Book全体をエクスポート」/ページカードのエクスポート/選択モードの「選択ページを
 * エクスポート」)から開く。既存の `.workflow-modal`/`.workflow-dialog`(レイアウトテンプレ
 * ピッカーの前例)を踏襲し、値は `#image-export-form` から `readForm`(FormData)で読む
 * (state との双方向同期は持たない)。JPEG 品質行・解像度行の表示切替とプリセット幅ボタンは
 * `imageExportController.ts` の `bindImageExportEvents`/`registerActions` が DOM 操作のみで完結させる。
 *
 * 形式は PNG/JPEG/ORA/PPTX(PPTX は Docs/Feature-PptxExport.md)。JPEG 品質行は format="jpeg"
 * のときだけ、解像度行は ORA 以外のときだけ表示する(ORA はレイヤー構造ごと元解像度で書き出す
 * ため解像度指定なし。`bindImageExportEvents` 側で判定)。
 */
import { escapeHtml } from "../format";
import { iconClose, iconDownload } from "../icons";

export function renderImageExportModal(
  pageIds: readonly string[] | null,
  totalPageCount: number,
  busy: boolean
): string {
  const targetCount = pageIds ? pageIds.length : totalPageCount;
  const targetLabel = pageIds ? `選択した${targetCount}ページ` : `全ページ（${targetCount}）`;
  return `
    <div class="workflow-modal image-export-modal" role="presentation">
      <section class="workflow-dialog image-export-dialog" role="dialog" aria-modal="true" aria-label="エクスポート">
        <header class="workflow-dialog-header">
          <div>
            <p class="section-kicker">Book · エクスポート</p>
            <h2>エクスポート</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-image-export" aria-label="閉じる" title="閉じる" ${busy ? "disabled" : ""}>${iconClose()}</button>
        </header>
        <form id="image-export-form" class="image-export-body">
          <p class="image-export-target">対象: <b>${escapeHtml(targetLabel)}</b></p>
          <fieldset class="image-export-field" ${busy ? "disabled" : ""}>
            <legend>形式</legend>
            <div class="image-export-format-options">
              <label class="image-export-radio"><input type="radio" name="format" value="png" checked /> PNG</label>
              <label class="image-export-radio"><input type="radio" name="format" value="jpeg" /> JPEG</label>
              <label class="image-export-radio"><input type="radio" name="format" value="ora" /> ORA</label>
              <label class="image-export-radio"><input type="radio" name="format" value="pptx" /> PPTX</label>
            </div>
          </fieldset>
          <div class="image-export-field range-control image-export-quality-row" data-image-export-quality-row hidden>
            <div class="range-label"><span>JPEG品質</span><strong id="image-export-quality-value">90</strong></div>
            <input type="range" name="quality" min="1" max="100" step="1" value="90" data-value-target="image-export-quality-value" ${busy ? "disabled" : ""} />
          </div>
          <fieldset class="image-export-field" data-image-export-width-row ${busy ? "disabled" : ""}>
            <legend>解像度（幅 px）</legend>
            <div class="image-export-width-row">
              <div class="image-export-width-presets">
                <button class="button-secondary compact" type="button" data-action="set-image-export-width" data-id="1280">1280</button>
                <button class="button-secondary compact" type="button" data-action="set-image-export-width" data-id="1600">1600</button>
                <button class="button-secondary compact" type="button" data-action="set-image-export-width" data-id="2048">2048</button>
              </div>
              <input type="number" name="pixelWidth" min="256" max="4096" step="1" value="1280" class="image-export-width-input" aria-label="解像度(幅px)" />
            </div>
          </fieldset>
          <p class="image-export-hint">PNG/JPEG/PPTXは「Paper → コマ画像 → 画像オブジェクト(背面帯) → コマ枠 → 画像オブジェクト/テキスト/吹き出し/ボックス(前面帯) → モザイク」の順に平坦化されます。フォントのライセンスは頒布前にご確認ください。</p>
          <p class="image-export-hint">ORAはレイヤー構造を保持した.ora(複数ページはzip)、PPTXは1ページ=1スライドで1つの.pptxになります。</p>
        </form>
        <footer class="image-export-footer">
          <button class="button-secondary compact" type="button" data-action="close-image-export" ${busy ? "disabled" : ""}>キャンセル</button>
          <button class="button-primary image-export-submit${busy ? " is-busy" : ""}" type="button" data-action="submit-image-export" ${busy ? "disabled" : ""}>
            ${busy ? `<span class="button-spinner" aria-hidden="true"></span>エクスポート中…` : `${iconDownload()}エクスポート`}
          </button>
        </footer>
      </section>
    </div>
  `;
}
