/**
 * Workflow / template 周辺の UI renderer。
 * `src/client/main.ts` から HTML 文字列を返す renderer 群を分離。
 * state は引数で受け取るため main.ts への逆依存を持たない（circular import なし）。
 * selector・data-action・HTML 構造・文言は維持。
 */
import type { ModelCheckResult } from "../shared/apiTypes";
import type { ModelKind } from "../shared/workflowModels";
import { escapeAttr, escapeHtml } from "./format";
import { iconClose } from "./icons";
import type { TemplateModelDefaults, WorkflowTemplate } from "./workflowTypes";

export function renderModelSelectPanel() {
  return `
    <section class="panel model-select-panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">Models</p>
          <h2>モデル選択</h2>
        </div>
      </div>
      <div class="model-select-buttons">
        <button class="button-secondary" type="button" data-action="open-model-install" data-family="chroma">Chroma</button>
      </div>
    </section>
  `;
}

const MODEL_KIND_LABELS: Record<ModelKind, string> = {
  checkpoint: "Checkpoint",
  diffusionModel: "Diffusion Model",
  textEncoder: "Text Encoder",
  vae: "VAE",
  controlnet: "ControlNet",
  lora: "LoRA",
  pulid: "PuLID",
  ipadapterFlux: "IP-Adapter",
  clipVision: "CLIP Vision"
};

export interface ModelCheckState {
  status: "idle" | "loading" | "ready" | "error";
  result: ModelCheckResult | null;
}

export function renderModelInstallModal(family: "chroma" | null, modelCheck: ModelCheckState) {
  if (!family) {
    return "";
  }
  const result = modelCheck.result;
  return `
    <div class="workflow-modal" role="dialog" aria-modal="true" aria-label="必要モデルインストール">
      <section class="workflow-dialog model-install-dialog">
        <header class="workflow-dialog-header">
          <div>
            <p class="section-kicker">Model Install</p>
            <h2>必要モデル(${escapeHtml(family)})</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-model-install" aria-label="閉じる" title="閉じる">${iconClose()}</button>
        </header>
        ${renderModelInstallComfyStatus(modelCheck)}
        ${renderModelInstallNodeWarning(result)}
        ${renderModelInstallTable(result)}
        <div class="workflow-import-modal-actions">
          <button class="button-secondary" type="button" data-action="recheck-models">再チェック</button>
          <button class="button-primary" type="button" data-action="close-model-install">${iconClose()}閉じる</button>
        </div>
      </section>
    </div>
  `;
}

function renderModelInstallComfyStatus(modelCheck: ModelCheckState) {
  if (modelCheck.status === "loading" && !modelCheck.result) {
    return `<div class="model-install-comfy-status">ComfyUI接続を確認中...</div>`;
  }
  const comfy = modelCheck.result?.comfy;
  if (!comfy) {
    return `<div class="model-install-comfy-status">未確認</div>`;
  }
  if (comfy.ok) {
    return `<div class="model-install-comfy-status model-check-ok">ComfyUI 接続済み(${escapeHtml(comfy.baseUrl)})</div>`;
  }
  return `<div class="model-install-comfy-status model-check-missing">ComfyUI 未接続(${escapeHtml(comfy.baseUrl)})${comfy.error ? `: ${escapeHtml(comfy.error)}` : ""}</div>`;
}

function renderModelInstallNodeWarning(result: ModelCheckResult | null) {
  if (!result) {
    return "";
  }
  const hasMissingNode = result.nodes.some((node) => !node.available);
  if (!hasMissingNode) {
    return "";
  }
  return `
    <div class="workflow-diagram-warning">
      必須ノード ComfySwitchNode / PrimitiveBoolean が見つかりません(ComfyUI のバージョン確認)
    </div>
  `;
}

function renderModelInstallTable(result: ModelCheckResult | null) {
  const models = result?.models ?? [];
  if (models.length === 0) {
    return `<div class="empty">モデル一覧を取得できませんでした。</div>`;
  }
  return `
    <table class="model-check-table">
      <thead>
        <tr>
          <th>種別</th>
          <th>ファイル名</th>
          <th>配置先</th>
          <th>状態</th>
        </tr>
      </thead>
      <tbody>
        ${models.map((model) => `
          <tr>
            <td>${escapeHtml(MODEL_KIND_LABELS[model.kind] ?? model.kind)}</td>
            <td>${escapeHtml(model.name)}</td>
            <td><code>ComfyUI/${escapeHtml(model.targetDir)}</code></td>
            <td>${renderModelCheckBadge(model.available)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderModelCheckBadge(available: boolean | null) {
  if (available === true) {
    return `<span class="model-check-badge model-check-ok">✓</span>`;
  }
  if (available === false) {
    return `<span class="model-check-badge model-check-missing">✗</span>`;
  }
  return `<span class="model-check-badge model-check-unknown">未確認</span>`;
}

export function renderTemplateOption(template: WorkflowTemplate, selectedTemplateId: string) {
  const selected = selectedTemplateId === template.id ? "selected" : "";
  return `<option value="${escapeAttr(template.id)}" ${selected}>${escapeHtml(template.name)} v${template.version} (${escapeHtml(template.type)})</option>`;
}

export function renderModelReadout(model: TemplateModelDefaults) {
  const rows: Array<[string, string]> = [];
  if (model.checkpoint) {
    rows.push(["checkpoint", model.checkpoint]);
  }
  if (model.diffusionModel) {
    rows.push(["diffusion model", model.diffusionModel]);
  }
  model.textEncoders.forEach((value, index) => rows.push([`text encoder ${index + 1}`, value]));
  if (model.vae) {
    rows.push(["VAE", model.vae]);
  }
  model.loras.forEach((value, index) => rows.push([`LoRA ${index + 1}`, value]));

  if (rows.length === 0) {
    rows.push(["workflow", "-"]);
  }

  return `
    <div class="model-readout">
      ${rows.map(([label, value]) => `
        <div class="model-readout-row">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}
