/**
 * ペイントツールパネル（アセット詳細モーダルの `state.paintEditMode` 用サイドバー）の render helper。
 * `assetModal.ts` と同様、state は引数で受け取るため main.ts への逆依存を持たない。
 */
import { escapeAttr } from "../format";
import { iconBrush, iconChevronDouble, iconEraser, iconExpand, iconImage, iconLoopArrows, iconReset, iconSave, iconZoom } from "../icons";
import { PAINT_BASE_PALETTE, type PaintDraft } from "../paintTypes";

export function renderPaintToggleButton(editing: boolean) {
  return `
    <button class="preview-mask-toggle ${editing ? "active" : ""}" type="button" data-action="toggle-paint-editor" aria-pressed="${editing}" title="${editing ? "ペイント編集を終了" : "ペイント編集を開始"}">
      ${iconBrush()}<span>ペイント編集 ${editing ? "ON" : "OFF"}</span>
    </button>
  `;
}

export function renderPaintToolPanel(draft: PaintDraft, sidebarCollapsed = false) {
  return `
    <aside class="mask-editor-panel paint-tool-panel ${sidebarCollapsed ? "collapsed" : ""}">
      <div class="mask-panel-header">
        <h2>ペイントツール</h2>
        <button class="sidebar-collapse-toggle" type="button" data-action="toggle-sidebar-collapse" aria-label="${sidebarCollapsed ? "パネルを展開" : "パネルを折りたたむ"}" title="${sidebarCollapsed ? "パネルを展開" : "パネルを折りたたむ"}" aria-pressed="${sidebarCollapsed}">${iconChevronDouble()}</button>
      </div>
      <div class="mask-toolbar-row">
        <button class="mask-tool-button ${draft.tool === "brush" ? "active" : ""}" type="button" data-action="paint-tool" data-tool="brush" aria-label="ブラシ" title="ブラシ">${iconBrush()}</button>
        <button class="mask-tool-button ${draft.tool === "eraser" ? "active" : ""}" type="button" data-action="paint-tool" data-tool="eraser" aria-label="消しゴム" title="消しゴム">${iconEraser()}</button>
        <button class="mask-tool-button ${draft.tool === "eyedropper" ? "active" : ""}" type="button" data-action="paint-tool" data-tool="eyedropper" aria-label="スポイト" title="スポイト（Altキーで一時使用）">${iconZoom()}</button>
        <button class="mask-tool-button ${draft.tool === "select" ? "active" : ""}" type="button" data-action="paint-tool" data-tool="select" aria-label="貼り付け画像の選択/変形" title="貼り付け画像の選択/変形（画像のダブルクリックでも選択）">${iconExpand()}</button>
        <button class="mask-tool-button" type="button" data-action="paint-clear" aria-label="ペイントをクリア" title="ペイントをクリア">${iconReset()}</button>
        <button class="mask-tool-button" type="button" data-action="paint-undo" aria-label="元に戻す" title="元に戻す (Ctrl+Z)">${iconLoopArrows()}</button>
      </div>
      <div class="paste-import-section">
        <button class="button-secondary compact" type="button" data-action="paste-pick-file" title="画像を貼り付け(ドラッグ&ドロップでも可)">${iconImage()}画像を貼り付け</button>
        <p class="paste-import-hint">画像はドラッグ&ドロップでも貼り付けできます</p>
      </div>
      ${renderPasteObjectSection(draft)}
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

/**
 * 選択中の貼り付けオブジェクトの情報セクション。
 * スケール%・回転角の読み出しはジェスチャ中に controller が id 経由で直接更新する。
 */
function renderPasteObjectSection(draft: PaintDraft) {
  const selected = draft.selectedPasteObjectId
    ? draft.pasteObjects.find((object) => object.id === draft.selectedPasteObjectId) ?? null
    : null;
  if (!selected) {
    return "";
  }
  const scalePercent = Math.round(selected.transform.scaleX * 100);
  const rotationDeg = Math.round(((selected.transform.rotation * 180) / Math.PI) % 360);
  return `
    <div class="paste-object-section">
      <div class="paste-object-readout">
        <span>選択中の貼り付け</span>
        <strong id="pasteScaleValue">${scalePercent}%</strong>
        <strong id="pasteRotationValue">${rotationDeg}°</strong>
      </div>
      <div class="paste-object-actions">
        <button class="button-secondary compact" type="button" data-action="paste-object-duplicate" title="複製">複製</button>
        <button class="button-secondary compact" type="button" data-action="paste-object-front" title="1段前面へ">前面へ</button>
        <button class="button-secondary compact" type="button" data-action="paste-object-back" title="1段背面へ">背面へ</button>
        <button class="button-danger compact" type="button" data-action="paste-object-delete" title="削除 (Delete)">削除</button>
      </div>
      <p class="paste-import-hint">ドラッグ=移動(Shift=軸固定) / 角=拡縮(Shift=縦横独立) / 上ハンドル=回転(Shift=15°) / 矢印=1px / Delete=削除 / Esc=選択解除</p>
    </div>
  `;
}
