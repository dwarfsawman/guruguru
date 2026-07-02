/**
 * ペイントツールパネル（アセット詳細モーダルの `state.paintEditMode` 用サイドバー）の render helper。
 * `assetModal.ts` と同様、state は引数で受け取るため main.ts への逆依存を持たない。
 */
import { escapeAttr } from "../format";
import { iconBrush, iconEraser, iconLoopArrows, iconReset, iconSave, iconZoom } from "../icons";
import { PAINT_BASE_PALETTE, type PaintDraft } from "../paintTypes";

export function renderPaintToggleButton(editing: boolean) {
  return `
    <button class="preview-mask-toggle ${editing ? "active" : ""}" type="button" data-action="toggle-paint-editor" aria-pressed="${editing}" title="${editing ? "ペイント編集を終了" : "ペイント編集を開始"}">
      ${iconBrush()}<span>ペイント編集 ${editing ? "ON" : "OFF"}</span>
    </button>
  `;
}

export function renderPaintToolPanel(draft: PaintDraft) {
  return `
    <aside class="mask-editor-panel paint-tool-panel">
      <div class="mask-panel-header">
        <h2>ペイントツール</h2>
      </div>
      <div class="mask-toolbar-row">
        <button class="mask-tool-button ${draft.tool === "brush" ? "active" : ""}" type="button" data-action="paint-tool" data-tool="brush" aria-label="ブラシ" title="ブラシ">${iconBrush()}</button>
        <button class="mask-tool-button ${draft.tool === "eraser" ? "active" : ""}" type="button" data-action="paint-tool" data-tool="eraser" aria-label="消しゴム" title="消しゴム">${iconEraser()}</button>
        <button class="mask-tool-button ${draft.tool === "eyedropper" ? "active" : ""}" type="button" data-action="paint-tool" data-tool="eyedropper" aria-label="スポイト" title="スポイト（Altキーで一時使用）">${iconZoom()}</button>
        <button class="mask-tool-button" type="button" data-action="paint-clear" aria-label="ペイントをクリア" title="ペイントをクリア">${iconReset()}</button>
        <button class="mask-tool-button" type="button" data-action="paint-undo" aria-label="元に戻す" title="元に戻す (Ctrl+Z)">${iconLoopArrows()}</button>
      </div>
      <div class="range-control mask-brush-control">
        <div class="range-label"><span>ブラシサイズ</span><strong id="paintBrushValue">${draft.brushSize}px</strong></div>
        <input type="range" min="1" max="256" step="1" value="${draft.brushSize}" data-value-target="paintBrushValue" data-paint-field="brushSize" />
      </div>
      <div class="paint-color-section">
        <label class="paint-color-picker-label">
          カラー
          <input type="color" class="paint-color-picker" value="${escapeAttr(draft.color)}" data-paint-color-picker="true" />
        </label>
        <div class="paint-palette">
          ${PAINT_BASE_PALETTE.map((color) => `
            <button class="paint-swatch ${sameColor(color, draft.color) ? "active" : ""}" type="button" data-action="paint-color" data-color="${escapeAttr(color)}" style="--swatch-color: ${escapeAttr(color)};" title="${escapeAttr(color)}" aria-label="${escapeAttr(color)}"></button>
          `).join("")}
        </div>
        ${draft.recentColors.length > 0 ? `
          <div class="paint-recent-colors">
            <span class="paint-recent-label">最近使った色</span>
            <div class="paint-palette">
              ${draft.recentColors.map((color) => `
                <button class="paint-swatch ${sameColor(color, draft.color) ? "active" : ""}" type="button" data-action="paint-color" data-color="${escapeAttr(color)}" style="--swatch-color: ${escapeAttr(color)};" title="${escapeAttr(color)}" aria-label="${escapeAttr(color)}"></button>
              `).join("")}
            </div>
          </div>
        ` : ""}
      </div>
      <div class="mask-panel-actions">
        <button class="button-primary" type="button" data-action="paint-save">${iconSave()}新規アセットとして保存</button>
      </div>
    </aside>
  `;
}

function sameColor(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}
