/**
 * Asset detail モーダル（プレビュー・マスク編集・WebSAM UI）の render helper。
 * `src/client/main.ts` から抽出。state は引数で受け取るため main.ts への逆依存を持たない（circular import なし）。
 * UI 文言・HTML 構造・CSS class・data-action・selector は移動前と同一。
 */
import type { Asset } from "../../shared/apiTypes";
import { escapeHtml, formatCssNumber, formatNumber } from "../format";
import {
  iconBrush,
  iconCheck,
  iconClose,
  iconEraser,
  iconInvert,
  iconLoopArrows,
  iconMask,
  iconPlay,
  iconReset,
  iconTrash
} from "../icons";
import { formatModelBytes, modelForProvider, SMART_MASK_PROVIDERS } from "../websam/models";
import type { WebSamModelStatus } from "../websam/types";
import type { InpaintDraft } from "../maskTypes";
import { defaultInpaintDraft, hasActiveMaskData, maskedContentOptions } from "../maskDraft";
import { normalizePromptBox } from "../maskCanvas";
import type { PaintDraft } from "../paintTypes";
import { renderPaintToggleButton, renderPaintToolPanel } from "./paintPanel";
import type { PoseDraft } from "../poseTypes";
import { renderPoseOverlay, renderPosePanelSection } from "./posePanel";

export type MaskPanelTab = "mask" | "pose";

function clampNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function assetDimension(asset: Asset | null, key: "width" | "height") {
  const value = asset?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasWebSamPrompt(draft: InpaintDraft) {
  return draft.foregroundPoints.length > 0 || !!normalizePromptBox(draft.boxPrompt);
}

export function renderAssetModal(
  asset: Asset | null,
  inpaint: InpaintDraft | null,
  editing: boolean,
  promptValue: string,
  batchSizeValue: number,
  maskPanelWidths: { left: number; right: number } = { left: 300, right: 300 },
  paintEditing = false,
  paintDraft: PaintDraft | null = null,
  maskPanelTab: MaskPanelTab = "mask",
  poseDraft: PoseDraft | null = null
) {
  if (!asset) {
    return "";
  }
  const draft = inpaint ?? defaultInpaintDraft(asset.id);
  const anyEditing = editing || paintEditing;
  const zoomStyle = paintEditing && paintDraft
    ? ` style="--mask-zoom: ${formatCssNumber(paintDraft.zoomScale)}; --mask-pan-x: ${formatCssNumber(paintDraft.panOffset.x)}px; --mask-pan-y: ${formatCssNumber(paintDraft.panOffset.y)}px;"`
    : ` style="--mask-zoom: ${formatCssNumber(draft.zoomScale)}; --mask-pan-x: ${formatCssNumber(draft.panOffset.x)}px; --mask-pan-y: ${formatCssNumber(draft.panOffset.y)}px;"`;
  const info = `Seed: ${asset.seed ?? "-"} / Steps: ${asset.steps ?? "-"} / CFG: ${asset.cfg ?? "-"} / Sampler: ${asset.sampler}`;
  const media = renderPreviewMedia(asset, draft, editing, zoomStyle, paintEditing, maskPanelTab, poseDraft);
  const footer = renderPreviewFooter(asset, info);
  return `
    <div class="preview-modal ${anyEditing ? "mask-editor-open" : ""}" role="dialog" aria-modal="true">
      <div class="preview-content ${anyEditing ? "mask-mode" : ""}">
        <div class="preview-top-controls">
          ${renderMaskToggleButton(editing)}
          ${renderPaintToggleButton(paintEditing)}
          ${editing ? renderMaskModeIndicator(inpaint, asset.id) : ""}
        </div>
        ${editing ? `
          <div class="mask-editor-layout" style="--mask-left-panel: ${formatCssNumber(maskPanelWidths.left)}px; --mask-right-panel: ${formatCssNumber(maskPanelWidths.right)}px;">
            ${renderMaskPromptSidebar(draft, promptValue, batchSizeValue)}
            <div class="mask-panel-resizer" data-mask-panel-resizer="left" role="separator" aria-orientation="vertical" aria-label="左パネル幅を調整"></div>
            <main class="preview-center">
              ${media}
              ${footer}
            </main>
            <div class="mask-panel-resizer" data-mask-panel-resizer="right" role="separator" aria-orientation="vertical" aria-label="右パネル幅を調整"></div>
            ${renderSmartMaskSidebar(draft, maskPanelTab, poseDraft, asset.id)}
          </div>
        ` : paintEditing && paintDraft ? `
          <div class="mask-editor-layout paint-editor-layout">
            ${renderPaintToolPanel(paintDraft)}
            <main class="preview-center">
              ${media}
              ${footer}
            </main>
          </div>
        ` : `
          ${media}
          ${footer}
        `}
        <button class="preview-close" type="button" data-action="close-detail" aria-label="閉じる">${iconClose()}</button>
      </div>
    </div>
  `;
}

export function renderPreviewMedia(
  asset: Asset,
  draft: InpaintDraft,
  editing: boolean,
  zoomStyle: string,
  paintEditing = false,
  maskPanelTab: MaskPanelTab = "mask",
  poseDraft: PoseDraft | null = null
) {
  const poseTabActive = editing && maskPanelTab === "pose";
  return `
    <div class="preview-media${editing || paintEditing ? " mask-preview-media" : ""}${poseTabActive ? " pose-tab-active" : ""}"${zoomStyle}>
      <div class="mask-zoom-stage">
        <img id="previewImage" src="${asset.imageUrl}" alt="" draggable="false" />
        ${editing ? `<canvas id="maskCanvas" class="mask-canvas" data-asset-id="${asset.id}" aria-label="マスクキャンバス"></canvas>${renderWebSamPromptOverlay(draft, asset)}` : ""}
        ${poseTabActive && poseDraft ? renderPoseOverlay(poseDraft, asset) : ""}
        ${paintEditing ? `<canvas id="paintCanvas" class="mask-canvas paint-canvas" data-asset-id="${asset.id}" aria-label="ペイントキャンバス"></canvas>` : ""}
      </div>
    </div>
  `;
}

export function renderPreviewFooter(asset: Asset, info: string) {
  return `
    <div class="preview-footer">
      <div class="preview-info">
        <p>${escapeHtml(info)}</p>
        <small>${escapeHtml(asset.prompt)}</small>
      </div>
      <div class="preview-actions">
        <button class="button-secondary" type="button" data-action="toggle-select" data-id="${asset.id}">選択切替</button>
        <button class="button-primary" type="button" data-action="generate-from-preview" data-id="${asset.id}" data-mode="img2img">この画像からブランチング</button>
      </div>
    </div>
  `;
}

export function renderMaskToggleButton(editing: boolean) {
  return `
    <button class="preview-mask-toggle ${editing ? "active" : ""}" type="button" data-action="toggle-mask-editor" aria-pressed="${editing}" title="${editing ? "マスク編集を終了" : "マスク編集を開始"}">
      ${iconMask()}<span>マスク編集 ${editing ? "ON" : "OFF"}</span>
    </button>
  `;
}

export function renderMaskModeIndicator(inpaint: InpaintDraft | null, fallbackAssetId: string | null) {
  const draft = inpaint ?? (fallbackAssetId ? defaultInpaintDraft(fallbackAssetId) : null);
  const toolLabel = draft?.eraser ? "消しゴム" : "ブラシ";
  const sizeLabel = draft ? `${formatNumber(draft.brushSize)}px` : "-";
  return `
    <div class="mask-mode-indicator" aria-live="polite">
      <span>${iconMask()}マスク編集モード</span>
      <small>${escapeHtml(toolLabel)} / ${escapeHtml(sizeLabel)}</small>
    </div>
  `;
}

export function renderWebSamPromptOverlay(draft: InpaintDraft, asset: Asset) {
  const width = draft.imageWidth ?? assetDimension(asset, "width") ?? 1;
  const height = draft.imageHeight ?? assetDimension(asset, "height") ?? 1;
  const points = draft.foregroundPoints.map((point) => {
    const className = point.label === 0 ? "background" : point.source === "brush" ? "brush" : "foreground";
    return `<circle class="websam-point ${className}" cx="${formatCssNumber(point.x)}" cy="${formatCssNumber(point.y)}" r="${Math.max(5, Math.min(width, height) * 0.007)}"></circle>`;
  }).join("");
  const box = normalizePromptBox(draft.boxPrompt);
  const boxMarkup = box
    ? `<rect class="websam-box" x="${formatCssNumber(box.x1)}" y="${formatCssNumber(box.y1)}" width="${formatCssNumber(box.x2 - box.x1)}" height="${formatCssNumber(box.y2 - box.y1)}"></rect>`
    : "";
  return `
    <svg class="websam-prompt-overlay" viewBox="0 0 ${formatCssNumber(width)} ${formatCssNumber(height)}" aria-hidden="true">
      ${boxMarkup}
      ${points}
      <circle class="brush-cursor" cx="0" cy="0" r="0" data-brush-asset-id="${asset.id}"></circle>
    </svg>
  `;
}

export function renderSmartMaskSection(draft: InpaintDraft) {
  const isWebSam = draft.selectedSmartMaskProvider !== "manual";
  return `
    <div class="smart-mask-section">
      <label>Smart selection
        <select class="workflow-select" data-smart-mask-field="provider">
          ${SMART_MASK_PROVIDERS.map((provider) => `
            <option value="${provider.id}" ${draft.selectedSmartMaskProvider === provider.id ? "selected" : ""}>${escapeHtml(provider.label)}</option>
          `).join("")}
        </select>
      </label>
      ${isWebSam ? renderWebSamControls(draft) : ""}
    </div>
  `;
}

export function renderWebSamControls(draft: InpaintDraft) {
  const model = modelForProvider(draft.selectedSmartMaskProvider);
  const statusClass = draft.webSamModelStatus === "ready"
    ? "active"
    : draft.webSamModelStatus === "error" || draft.webSamModelStatus === "missing-url"
      ? "error"
      : "";
  const canDecode = draft.webSamModelStatus === "ready" && hasWebSamPrompt(draft);
  return `
    <div class="websam-panel">
      <div class="websam-model-card">
        <div>
          <strong>${escapeHtml(model?.label ?? draft.selectedWebSamModel)}</strong>
          <small>${escapeHtml(model ? `${model.description} / Encoder ${formatModelBytes(model.encoderSize)} / Decoder ${formatModelBytes(model.decoderSize)}` : "")}</small>
        </div>
        <span class="mask-status ${statusClass}">${escapeHtml(webSamStatusLabel(draft.webSamModelStatus))}</span>
      </div>
      <div class="websam-progress"><span style="width: ${formatCssNumber(clampNumber(draft.webSamDownloadProgress, 0, 1, 0) * 100)}%"></span></div>
      <div class="websam-status-line">
        <span>${escapeHtml(draft.webSamStatusText || webSamStatusLabel(draft.webSamModelStatus))}</span>
        <button class="button-secondary compact mini-button" type="button" data-action="${draft.webSamModelStatus === "error" || draft.webSamModelStatus === "missing-url" ? "websam-retry" : "websam-load-model"}">${iconLoopArrows()}再試行</button>
      </div>
      ${draft.webSamError ? `<p class="websam-error">${escapeHtml(draft.webSamError)}</p>` : ""}
      <label>Prompt mode
        <select class="workflow-select" data-smart-mask-field="promptMode">
          <option value="point" ${draft.webSamPromptMode === "point" ? "selected" : ""}>Point</option>
          <option value="box" ${draft.webSamPromptMode === "box" ? "selected" : ""}>Box</option>
          <option value="brush" ${draft.webSamPromptMode === "brush" ? "selected" : ""}>Brush prompt</option>
        </select>
      </label>
      ${renderSmartMaskRange("threshold", "Threshold", draft.threshold, -10, 10, 0.1, "webSamThresholdValue")}
      ${renderSmartMaskRange("smoothing", "Smoothing", draft.smoothing, 0, 4, 1, "webSamSmoothingValue")}
      ${renderSmartMaskRange("maskOpacity", "Mask opacity", draft.maskOpacity, 0, 1, 0.05, "webSamOpacityValue")}
      <div class="websam-actions">
        <button class="button-secondary compact" type="button" data-action="websam-decode" ${canDecode ? "" : "disabled"}>${iconPlay()}候補生成</button>
        <button class="button-secondary compact" type="button" data-action="websam-clear-prompts">${iconReset()}点クリア</button>
        <button class="button-secondary compact" type="button" data-action="websam-clear-result">${iconTrash()}SAM結果クリア</button>
      </div>
      ${renderSamCandidateButtons(draft)}
      <div class="websam-counts">
        <span>FG/BG ${draft.foregroundPoints.filter((point) => point.label === 1).length}/${draft.foregroundPoints.filter((point) => point.label === 0).length}</span>
        <span>Brush ${draft.foregroundPoints.filter((point) => point.source === "brush").length}</span>
        <span>Zoom ${Math.round(draft.zoomScale * 100)}%</span>
      </div>
    </div>
  `;
}

export function renderSmartMaskRange(field: string, label: string, value: number, min: number, max: number, step: number, valueId: string) {
  return `
    <div class="range-control smart-mask-range">
      <div class="range-label"><span>${escapeHtml(label)}</span><strong id="${valueId}">${formatNumber(value)}</strong></div>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${formatCssNumber(value)}" data-value-target="${valueId}" data-smart-mask-field="${field}" />
    </div>
  `;
}

export function renderSamCandidateButtons(draft: InpaintDraft) {
  if (draft.samCandidates.length === 0) {
    return `<div class="websam-candidates empty-candidates"><span>Mask 1</span><span>Mask 2</span><span>Mask 3</span></div>`;
  }
  return `
    <div class="websam-candidates">
      ${draft.samCandidates.map((candidate) => `
        <button class="websam-candidate ${candidate.index === draft.selectedSamCandidateIndex ? "active" : ""}" type="button" data-action="websam-candidate" data-index="${candidate.index}">
          <span>Mask ${candidate.index + 1}</span>
          <small>${candidate.score === null ? "-" : `${(candidate.score * 100).toFixed(1)}%`}</small>
        </button>
      `).join("")}
    </div>
  `;
}

export function webSamStatusLabel(status: WebSamModelStatus) {
  if (status === "idle") return "未取得";
  if (status === "missing-url") return "URL未設定";
  if (status === "not-cached") return "未取得";
  if (status === "downloading") return "ダウンロード中";
  if (status === "cached") return "キャッシュ済み";
  if (status === "initializing") return "初期化中";
  if (status === "encoding") return "Encoding";
  if (status === "ready") return "Ready";
  if (status === "decoding") return "Decoding";
  return "Error";
}

export function renderMaskPromptSidebar(draft: InpaintDraft, promptValue: string, batchSizeValue: number) {
  const active = hasActiveMaskData(draft);
  const canApplyCandidate = draft.samCandidates.length > 0 && !!draft.previewSamMaskDataUrl;
  const webSamProvider = SMART_MASK_PROVIDERS.find((provider) => provider.id !== "manual")?.id ?? "websam-slimsam-77";
  const smartActive = draft.selectedSmartMaskProvider !== "manual";
  return `
    <aside class="mask-editor-panel mask-prompt-panel">
      <div class="mask-panel-header">
        <h2>マスク・プロンプト</h2>
        <span class="mask-status ${active ? "active" : ""}">${active ? "mask active" : "no mask"}</span>
      </div>
      <div class="mask-panel-tabs">
        <button class="mask-tab ${smartActive ? "" : "active"}" type="button" data-action="set-smart-mask-provider" data-provider="manual">手動編集</button>
        <button class="mask-tab ${smartActive ? "active" : ""}" type="button" data-action="set-smart-mask-provider" data-provider="${webSamProvider}">${iconPlay()}候補生成</button>
        <button class="mask-tab" type="button" data-action="websam-clear-prompts">${iconReset()}点クリア</button>
      </div>
      <div class="mask-toolbar-row">
        <button class="mask-tool-button ${!smartActive && !draft.eraser ? "active" : ""}" type="button" data-action="mask-tool" data-tool="brush" aria-label="ブラシ" title="ブラシ">${iconBrush()}</button>
        <button class="mask-tool-button ${draft.eraser ? "active" : ""}" type="button" data-action="mask-tool" data-tool="eraser" aria-label="消しゴム" title="消しゴム">${iconEraser()}</button>
        <button class="mask-tool-button" type="button" data-action="invert-mask" aria-label="マスク領域を反転" title="マスク領域を反転">${iconInvert()}</button>
        <button class="mask-tool-button" type="button" data-action="clear-mask" aria-label="マスクをクリア" title="マスクをクリア">${iconReset()}</button>
      </div>
      <div class="range-control mask-brush-control">
        <div class="range-label"><span>ブラシサイズ</span><strong id="maskBrushValue">${formatNumber(draft.brushSize)}px</strong></div>
        <input type="range" min="1" max="256" step="1" value="${draft.brushSize}" data-value-target="maskBrushValue" data-inpaint-field="brushSize" />
      </div>
      <div class="mask-options-grid">
        <label class="mask-prompt-field">Positive prompt
          <textarea class="input-field mask-prompt-input" rows="4" data-generation-field="prompt" placeholder="プロンプトを入力...">${escapeHtml(promptValue)}</textarea>
        </label>
        <div class="range-control mask-batch-control">
          <div class="range-label"><span>バッチサイズ</span><strong id="modalBatchValue">${formatNumber(batchSizeValue)}</strong></div>
          <input type="range" min="1" max="32" step="1" value="${batchSizeValue}" data-value-target="modalBatchValue" data-generation-field="batchSize" />
          <div class="range-minmax"><span>1</span><span>32</span></div>
        </div>
        <label>Masked content
          <select class="workflow-select" data-inpaint-field="maskedContent">
            ${maskedContentOptions.map((option) => `
              <option value="${option.value}" ${draft.maskedContent === option.value ? "selected" : ""}>${escapeHtml(option.label)}</option>
            `).join("")}
          </select>
        </label>
        <label>Inpaint area
          <select class="workflow-select" data-inpaint-field="inpaintArea">
            <option value="only_masked" selected>Only masked</option>
          </select>
        </label>
        <div class="range-control mask-padding-control">
          <div class="range-label"><span>Only masked padding</span><strong id="modalMaskPaddingValue">${formatNumber(draft.onlyMaskedPadding)}px</strong></div>
          <input type="range" min="0" max="512" step="1" value="${draft.onlyMaskedPadding}" data-value-target="modalMaskPaddingValue" data-inpaint-field="onlyMaskedPadding" />
        </div>
        <div class="range-control mask-feather-control">
          <div class="range-label"><span>Mask feather</span><strong id="modalMaskFeatherValue">${formatNumber(draft.featherRadius)}px</strong></div>
          <input type="range" min="0" max="30" step="1" value="${draft.featherRadius}" data-value-target="modalMaskFeatherValue" data-inpaint-field="featherRadius" />
        </div>
      </div>
      <div class="mask-panel-actions">
        <button class="button-primary" type="button" data-action="apply-mask-editor">${iconCheck()}${canApplyCandidate ? "候補を適用" : "適用"}</button>
        <button class="button-secondary" type="button" data-action="websam-clear-manual">${iconEraser()}手動修正クリア</button>
      </div>
    </aside>
  `;
}

export function renderSmartMaskSidebar(
  draft: InpaintDraft,
  maskPanelTab: MaskPanelTab = "mask",
  poseDraft: PoseDraft | null = null,
  assetId: string | null = null
) {
  const poseActive = maskPanelTab === "pose";
  return `
    <aside class="mask-editor-panel smart-mask-panel">
      <div class="mask-panel-header">
        <h2>${poseActive ? "ポーズ" : "スマート選択"}</h2>
        <div class="mask-panel-tabs smart-panel-tabs">
          <button class="mask-tab ${poseActive ? "" : "active"}" type="button" data-action="set-mask-panel-tab" data-tab="mask">マスク</button>
          <button class="mask-tab ${poseActive ? "active" : ""}" type="button" data-action="set-mask-panel-tab" data-tab="pose">ポーズ</button>
        </div>
      </div>
      ${poseActive ? renderPosePanelSection(poseDraft ?? null, assetId) : renderSmartMaskSection(draft)}
    </aside>
  `;
}
