/**
 * 生成パラメータサイドバー（generation panel）の render helper。
 * `src/client/main.ts` から抽出。state は引数で受け取るため main.ts への逆依存を持たない（circular import なし）。
 * UI 文言・HTML 構造・CSS class・data-action・selector は移動前と同一。
 */
import {
  defaultDenoiseForMode,
  normalizeDenoiseForMode,
  requiresFullDenoise
} from "../../shared/generationMode";
import type { Asset, ProjectDetail, Round } from "../../shared/apiTypes";
import type { StyleLoraSelection } from "../../shared/types";
import { escapeAttr, escapeHtml, formatNumber } from "../format";
import {
  iconChevron,
  iconClose,
  iconDownload,
  iconMinimize,
  iconPlus,
  iconReset,
  iconSettings,
  iconShuffle,
  iconSparkle,
  iconSwap,
  iconTrash
} from "../icons";
import type { InpaintDraft } from "../maskTypes";
import { hasActiveMaskData, maskedContentOptions } from "../maskDraft";
import { defaultModeForTemplate, templateGenerationDefaults } from "../workflowDefaults";
import { renderModelReadout, renderTemplateOption } from "../workflowUi";
import { renderSourceUploadButton } from "./galleryView";
import type { ReferenceDraft } from "../appState";
import { iconImage } from "../icons";

export const defaultPrompt =
  "masterpiece, best quality, 1girl, beautiful detailed eyes, flowing hair, fantasy landscape, dramatic lighting, ethereal atmosphere";
export const defaultNegativePrompt = "low quality, worst quality, blurry, deformed";

export const samplerOptions = [
  "euler",
  "euler_ancestral",
  "heun",
  "dpm_2",
  "dpm_2_ancestral",
  "lms",
  "dpm_fast",
  "dpm_adaptive",
  "dpmpp_2s_ancestral",
  "dpmpp_sde",
  "dpmpp_sde_gpu",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_2m_sde_gpu",
  "dpmpp_3m_sde",
  "dpmpp_3m_sde_gpu",
  "ddim",
  "uni_pc",
  "uni_pc_bh2"
];
export const schedulerOptions = ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta"];

interface GenerationDraftLike {
  templateId?: string;
  img2imgTemplateId?: string;
  parentAssetId?: string;
  prompt?: string;
  negativePrompt?: string;
  seed?: string;
  seedMode?: string;
  batchSize?: string;
  steps?: string;
  cfg?: string;
  sampler?: string;
  scheduler?: string;
  denoise?: string;
  width?: string;
  height?: string;
  generationMode?: string;
}

function draftNumber(draft: GenerationDraftLike | null, field: keyof GenerationDraftLike) {
  const value = draft?.[field];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function assetDimension(asset: Asset | null, key: "width" | "height") {
  const value = asset?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function renderGenerationPanel(
  detail: ProjectDetail,
  activeRound: Round | null,
  previous: Asset | null,
  draft: GenerationDraftLike | null,
  activeInpaint: InpaintDraft | null,
  llmConfigured = false,
  llmImproving = false,
  referenceDraft: ReferenceDraft | null = null,
  referenceAvailability: { pulid: boolean } = { pulid: false },
  loraDraft: StyleLoraSelection[] = [],
  loraChoices: { status: "idle" | "loading" | "ready" | "error"; names: string[] } = { status: "idle", names: [] }
) {
  const request = activeRound?.request;
  const requestMode = request?.generationMode === "manual_upload" ? "img2img" : request?.generationMode;
  const selectedTemplateId = draft?.templateId ?? request?.templateId ?? detail.project.defaultTemplateId ?? detail.templates[0]?.id ?? "";
  const selectedImg2ImgTemplateId =
    draft?.img2imgTemplateId ??
    (request?.generationMode === "img2img" ? request.templateId : selectedTemplateId);
  const selectedTemplate = detail.templates.find((template) => template.id === selectedTemplateId) ?? null;
  const selectedMode = draft?.generationMode ?? requestMode ?? defaultModeForTemplate(selectedTemplate);
  const selectedImg2ImgTemplate =
    detail.templates.find((template) => template.id === selectedImg2ImgTemplateId) ??
    selectedTemplate;
  const activeTemplateForMode = selectedMode === "img2img" ? selectedImg2ImgTemplate : selectedTemplate;
  const defaults = templateGenerationDefaults(activeTemplateForMode);
  const promptValue = draft?.prompt ?? request?.prompt ?? previous?.prompt ?? defaults.prompt ?? defaultPrompt;
  const negativePromptValue = draft?.negativePrompt ?? request?.negativePrompt ?? previous?.negativePrompt ?? defaults.negativePrompt ?? defaultNegativePrompt;
  const batchSizeValue = draftNumber(draft, "batchSize") ?? request?.batchSize ?? defaults.batchSize ?? 16;
  const stepsValue = draftNumber(draft, "steps") ?? request?.steps ?? defaults.steps ?? 20;
  const cfgValue = draftNumber(draft, "cfg") ?? request?.cfg ?? defaults.cfg ?? 7;
  const denoiseValue =
    draftNumber(draft, "denoise") ??
    request?.denoise ??
    normalizeDenoiseForMode(defaults.denoise ?? defaultDenoiseForMode(selectedMode), selectedMode);
  const normalizedDenoiseValue = normalizeDenoiseForMode(denoiseValue, selectedMode);
  const widthValue = draftNumber(draft, "width") ?? assetDimension(previous, "width") ?? request?.width ?? defaults.width ?? 512;
  const heightValue = draftNumber(draft, "height") ?? assetDimension(previous, "height") ?? request?.height ?? defaults.height ?? 768;
  const seedValue = draft?.seed ?? String(request?.seed ?? previous?.seed ?? defaults.seed ?? -1);
  const seedModeValue = draft?.seedMode ?? request?.seedMode ?? "random";
  const samplerValue = draft?.sampler ?? request?.sampler ?? defaults.sampler ?? "euler";
  const schedulerValue = draft?.scheduler ?? request?.scheduler ?? defaults.scheduler ?? "normal";
  const templateOptions = detail.templates.length
    ? detail.templates
      .map((template) => renderTemplateOption(template, selectedTemplateId))
      .join("")
    : `<option value="">未登録</option>`;
  const img2imgTemplateOptions = detail.templates.length
    ? detail.templates
      .map((template) => renderTemplateOption(template, selectedImg2ImgTemplateId))
      .join("")
    : `<option value="">未登録</option>`;

  return `
    <form id="generation-form" class="sidebar-form">
      <input type="hidden" name="parentAssetId" value="${previous?.id ?? ""}" />
      <section class="sidebar-section">
        <p class="section-kicker">ワークフロー</p>
        <label>txt2img WorkflowTemplate
          <select id="generation-template-select" class="workflow-select" name="templateId">${templateOptions}</select>
        </label>
        <label>img2img WorkflowTemplate
          <select id="generation-img2img-template-select" class="workflow-select" name="img2imgTemplateId">${img2imgTemplateOptions}</select>
        </label>
        <div class="workflow-dropdown compact-dropdown">
          <button class="workflow-dropdown-trigger" type="button" popovertarget="workflow-actions-menu"><span>${iconPlus()}Workflow操作</span>${iconChevron()}</button>
          <div class="workflow-export-menu" id="workflow-actions-menu" popover>
            <button class="button-secondary compact" type="button" data-action="export-workflow" data-template-source="generation-template-select" popovertarget="workflow-actions-menu" popovertargetaction="hide">${iconDownload()}raw workflow export</button>
            <button class="button-secondary compact" type="button" data-action="export-template" data-template-source="generation-template-select" popovertarget="workflow-actions-menu" popovertargetaction="hide">${iconDownload()}template export</button>
            <button class="button-danger compact" type="button" data-action="delete-template" data-template-source="generation-template-select" popovertarget="workflow-actions-menu" popovertargetaction="hide" ${detail.templates.length ? "" : "disabled"}>${iconTrash()}workflow削除</button>
            <button class="button-secondary compact" type="button" data-action="home" popovertarget="workflow-actions-menu" popovertargetaction="hide">${iconSettings()}Workflow管理を開く</button>
          </div>
        </div>
      </section>

      <section class="sidebar-section">
        <p class="section-kicker">親画像</p>
        ${renderSourceUploadButton("source asset をアップロード")}
      </section>

      ${renderReferenceImageSection(referenceDraft, referenceAvailability)}

      ${renderStyleLoraSection(loraDraft, loraChoices)}

      <section class="sidebar-section">
        <p class="section-kicker">プロンプト</p>
        ${llmConfigured && llmImproving ? `<p class="prompt-thinking">thinking…</p>` : ""}
        <div class="prompt-input-wrap">
          <textarea class="input-field prompt-input" name="prompt" placeholder="プロンプトを入力...">${escapeHtml(promptValue)}</textarea>
          ${llmConfigured
            ? llmImproving
              ? `<button class="prompt-improve-button is-cancel" type="button" data-action="cancel-improve-prompt" title="改善をキャンセル" aria-label="改善をキャンセル">${iconClose()}</button>`
              : `<button class="prompt-improve-button" type="button" data-action="improve-prompt" title="LLMでプロンプトを改善" aria-label="LLMでプロンプトを改善">${iconSparkle()}</button>`
            : ""}
        </div>
      </section>

      <details class="sidebar-section collapsible" open>
        <summary><span class="section-kicker">ネガティブプロンプト</span>${iconChevron()}</summary>
        <textarea class="input-field" name="negativePrompt" rows="3" placeholder="ネガティブプロンプト...">${escapeHtml(negativePromptValue)}</textarea>
      </details>

      <section class="sidebar-section">
        <div class="section-header-row">
          <p class="section-kicker">生成パラメータ</p>
          <button class="button-secondary compact mini-button" type="button" data-action="reset-generation-params" title="編集内容をこのノード開始時点の値に戻す">${iconReset()}ノード元値</button>
        </div>
        ${renderRangeControl("batchSize", "バッチサイズ", batchSizeValue, 1, 32, 1, "batchValue")}
        ${renderRangeControl("steps", "ステップ数", stepsValue, 1, 50, 1, "stepsValue")}
        ${renderRangeControl("cfg", "CFGスケール", cfgValue, 1, 20, 0.5, "cfgValue")}
        ${renderRangeControl("denoise", "デノイズ強度", normalizedDenoiseValue, 0, 1, 0.05, "denoiseValue")}

        <div class="resolution-row">
          <label>幅<input class="input-field center" name="width" type="number" step="64" value="${widthValue}" /></label>
          <button class="icon-button swap-button" data-action="swap-resolution" type="button" aria-label="幅と高さを入れ替え">${iconSwap()}</button>
          <label>高さ<input class="input-field center" name="height" type="number" step="64" value="${heightValue}" /></label>
        </div>
        <div class="resolution-scale-row">
          <button class="icon-button resolution-scale-button" data-action="scale-resolution" data-scale-direction="down" type="button" aria-label="縦横比を保って縮小" title="縦横比を保って縮小">${iconMinimize()}</button>
          <button class="icon-button resolution-scale-button" data-action="scale-resolution" data-scale-direction="up" type="button" aria-label="縦横比を保って拡大" title="縦横比を保って拡大">${iconPlus()}</button>
        </div>

        <label>シード
          <div class="seed-row">
            <input class="input-field mono" name="seed" type="number" value="${seedValue}" />
            <button class="icon-button" data-action="random-seed" type="button" aria-label="ランダムseed">${iconShuffle()}</button>
          </div>
        </label>

        <label>seed mode
          <select class="workflow-select" name="seedMode">
            ${["random", "fixed", "increment", "reuse_parent_seed"].map((mode) => `<option value="${mode}" ${seedModeValue === mode ? "selected" : ""}>${mode}</option>`).join("")}
          </select>
        </label>

        <label>サンプラー
          <select class="workflow-select" name="sampler">
            ${renderOptions(samplerOptions, samplerValue)}
          </select>
        </label>

        <label>scheduler
          <select class="workflow-select" name="scheduler">
            ${renderOptions(schedulerOptions, schedulerValue)}
          </select>
        </label>

        <label>mode
          <select class="workflow-select" name="generationMode">
            ${["txt2img", "img2img", "ipadapter", "controlnet", "seed_reuse", "prompt_reuse"].map((mode) => `<option value="${mode}" ${selectedMode === mode ? "selected" : ""}>${mode}</option>`).join("")}
          </select>
        </label>
      </section>

      ${hasActiveMaskData(activeInpaint) ? renderInpaintSidebarSection(activeInpaint) : ""}

      <details class="sidebar-section collapsible">
        <summary><span class="section-kicker">モデル</span>${iconChevron()}</summary>
        ${renderModelReadout(defaults.model)}
      </details>
    </form>
  `;
}

/**
 * Consistent Character(Docs/Feature-ConsistentCharacter.md)の参照画像枠。親画像の直下に
 * 置き、取り込んだ1枚の画像に対して顔スタイル参照(PuLID)をトグルできる。対応するモデル/
 * ノードパックが未導入のときはトグルを disabled にし、「モデル選択→Chroma」で確認するよう促す。
 */
function renderReferenceImageSection(
  draft: ReferenceDraft | null,
  availability: { pulid: boolean }
) {
  const imageDataUrl = draft?.imageDataUrl ?? null;
  return `
    <section class="sidebar-section reference-image-section">
      <p class="section-kicker">参照画像</p>
      ${imageDataUrl
        ? `
          <div class="reference-image-preview">
            <img src="${imageDataUrl}" alt="参照画像プレビュー" />
            <button class="icon-button" type="button" data-action="clear-reference-image" aria-label="参照画像を削除" title="参照画像を削除">${iconTrash()}</button>
          </div>
        `
        : `<label class="button-secondary compact source-upload-button">
            ${iconImage()}参照画像をアップロード
            <input data-reference-upload="1" type="file" accept="image/png,image/jpeg,image/webp" />
          </label>`}
      ${renderReferenceToggle("toggle-reference-face", "顔スタイル参照(PuLID)", Boolean(draft?.faceEnabled), availability.pulid)}
    </section>
  `;
}

function renderReferenceToggle(action: string, label: string, checked: boolean, available: boolean) {
  const title = available ? "" : `title="モデル未導入。モデル選択→Chroma で確認してください"`;
  return `
    <label class="reference-toggle" ${title}>
      <input type="checkbox" data-action="${action}" ${checked && available ? "checked" : ""} ${available ? "" : "disabled"} />
      ${escapeHtml(label)}
    </label>
  `;
}

/**
 * Consistent Character(Docs/Feature-ConsistentCharacter.md)の「スタイル LoRA」枠。絵柄コントロール用に
 * models/loras の LoRA を複数選択・強度指定して MODEL チェーンへ適用する。候補は ComfyUI の
 * LoraLoaderModelOnly choices(サブフォルダ込みの実ファイル名)。行の追加/削除/変更は styleLoraController。
 */
function renderStyleLoraSection(
  draft: StyleLoraSelection[],
  choices: { status: "idle" | "loading" | "ready" | "error"; names: string[] }
) {
  const maxLoras = 4;
  const rows = draft.map((row, index) => renderStyleLoraRow(row, index, choices.names)).join("");
  const hint =
    choices.status === "ready" && choices.names.length === 0
      ? `<p class="section-hint">models/loras に LoRA がありません(ComfyUI に配置してください)。</p>`
      : choices.status === "error"
        ? `<p class="section-hint">LoRA 一覧を取得できませんでした(ComfyUI 未接続)。</p>`
        : "";
  return `
    <section class="sidebar-section style-lora-section">
      <p class="section-kicker">スタイル LoRA</p>
      ${rows}
      ${hint}
      ${draft.length < maxLoras
        ? `<button class="button-secondary compact" type="button" data-action="add-style-lora">${iconPlus()}LoRA を追加</button>`
        : `<p class="section-hint">LoRA は最大 ${maxLoras} 本までです。</p>`}
    </section>
  `;
}

function renderStyleLoraRow(row: StyleLoraSelection, index: number, names: string[]) {
  const valueId = `styleLoraStrength${index}`;
  // 現在の選択が候補一覧に無い場合(LoRA を後から消した等)でも「選択済み」を保てるよう option に含める。
  const options = names.includes(row.name) || row.name === "" ? names : [row.name, ...names];
  const optionHtml = [
    `<option value="" ${row.name === "" ? "selected" : ""}>(選択)</option>`,
    ...options.map(
      (name) =>
        `<option value="${escapeAttr(name)}" ${name === row.name ? "selected" : ""}>${escapeHtml(loraBasename(name))}</option>`
    )
  ].join("");
  return `
    <div class="style-lora-row" data-lora-index="${index}">
      <div class="style-lora-head">
        <select class="style-lora-select" data-lora-field="name" data-lora-index="${index}">${optionHtml}</select>
        <button class="icon-button" type="button" data-action="remove-style-lora" data-lora-index="${index}" aria-label="この LoRA を削除" title="削除">${iconTrash()}</button>
      </div>
      <div class="range-control">
        <div class="range-label"><span>強度</span><strong id="${valueId}">${formatNumber(row.strength)}</strong></div>
        <input type="range" min="0" max="2" step="0.05" value="${row.strength}" data-value-target="${valueId}" data-lora-field="strength" data-lora-index="${index}" />
        <div class="range-minmax"><span>0</span><span>2</span></div>
      </div>
    </div>
  `;
}

function loraBasename(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

export function renderInpaintSidebarSection(inpaint: InpaintDraft) {
  return `
    <section class="sidebar-section mask-sidebar-section">
      <div class="section-header-row">
        <p class="section-kicker">マスク処理</p>
        <span class="mask-status">有効</span>
      </div>
      <label>Masked content
        <select class="workflow-select" data-inpaint-field="maskedContent">
          ${maskedContentOptions.map((option) => `
            <option value="${option.value}" ${inpaint.maskedContent === option.value ? "selected" : ""}>${escapeHtml(option.label)}</option>
          `).join("")}
        </select>
      </label>
      <label>Inpaint area
        <select class="workflow-select" data-inpaint-field="inpaintArea">
          <option value="only_masked" selected>Only masked</option>
        </select>
      </label>
      <div class="range-control">
        <div class="range-label"><span>Only masked padding</span><strong id="sidebarMaskPaddingValue">${formatNumber(inpaint.onlyMaskedPadding)}px</strong></div>
        <input type="range" min="0" max="512" step="1" value="${inpaint.onlyMaskedPadding}" data-value-target="sidebarMaskPaddingValue" data-inpaint-field="onlyMaskedPadding" />
        <div class="range-minmax"><span>0px</span><span>512px</span></div>
      </div>
      <div class="range-control">
        <div class="range-label"><span>Mask feather</span><strong id="sidebarMaskFeatherValue">${formatNumber(inpaint.featherRadius)}px</strong></div>
        <input type="range" min="0" max="30" step="1" value="${inpaint.featherRadius}" data-value-target="sidebarMaskFeatherValue" data-inpaint-field="featherRadius" />
        <div class="range-minmax"><span>0px</span><span>30px</span></div>
      </div>
      <button class="button-danger compact" type="button" data-action="clear-inpaint">${iconTrash()}マスクを解除</button>
    </section>
  `;
}

export function renderRangeControl(
  name: string,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  valueId: string,
  includeName = true
) {
  return `
    <div class="range-control">
      <div class="range-label"><span>${label}</span><strong id="${valueId}">${formatNumber(value)}</strong></div>
      <input type="range" ${includeName ? `name="${name}"` : ""} min="${min}" max="${max}" step="${step}" value="${value}" data-value-target="${valueId}" />
      <div class="range-minmax"><span>${min}</span><span>${max}</span></div>
    </div>
  `;
}

export function renderOptions(options: string[], selectedValue: string) {
  const values = options.includes(selectedValue) ? options : [selectedValue, ...options];
  return values
    .map((value) => `<option value="${escapeAttr(value)}" ${selectedValue === value ? "selected" : ""}>${escapeHtml(value)}</option>`)
    .join("");
}

export function generationModeLabel(mode: string) {
  return mode === "manual_upload" ? "source" : mode;
}
