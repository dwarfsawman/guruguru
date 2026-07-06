/**
 * Mermaid / workflow diagram / template 周辺の UI renderer。
 * `src/client/main.ts` から HTML 文字列を返す renderer 群と Mermaid 初期化・描画を分離。
 * state は引数で受け取るため main.ts への逆依存を持たない（circular import なし）。
 * Mermaid 設定値・selector・data-action・HTML 構造・文言は維持。
 */
import mermaid from "mermaid";
import { createWorkflowMermaidDiagram, type WorkflowDiagram, type WorkflowDiagramStatus } from "../shared/workflowDiagram";
import type { ModelCheckResult } from "../shared/apiTypes";
import type { ModelKind } from "../shared/workflowModels";
import { escapeAttr, escapeHtml } from "./format";
import { iconClose, iconDiagram, iconDownload, iconTrash } from "./icons";
import type { TemplateModelDefaults, WorkflowTemplate } from "./workflowTypes";

let workflowDiagramRenderRunId = 0;

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "dark",
  flowchart: {
    curve: "basis",
    htmlLabels: false,
    nodeSpacing: 42,
    rankSpacing: 60
  },
  themeVariables: {
    background: "#12121f",
    primaryColor: "#171729",
    primaryTextColor: "#f4f4f7",
    primaryBorderColor: "#4b5563",
    lineColor: "#8b8ba8",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
  }
});

export async function renderWorkflowDiagramCanvases() {
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-mermaid-diagram]"));
  if (targets.length === 0) {
    return;
  }

  const runId = ++workflowDiagramRenderRunId;
  for (const [index, target] of targets.entries()) {
    const source = target.querySelector<HTMLElement>(".workflow-diagram-source")?.textContent ?? "";
    if (!source.trim()) {
      continue;
    }
    target.dataset.state = "loading";
    try {
      const result = await mermaid.render(`workflow-diagram-${runId}-${index}`, source);
      if (runId !== workflowDiagramRenderRunId || !target.isConnected) {
        return;
      }
      target.innerHTML = result.svg;
      target.dataset.state = "ready";
      // Initialize zoom/pan state
      if (!target.dataset.wfZoom) {
        target.dataset.wfZoom = "1";
        target.dataset.wfPanX = "0";
        target.dataset.wfPanY = "0";
      }
      target.style.setProperty("--wf-zoom", target.dataset.wfZoom);
      target.style.setProperty("--wf-pan-x", `${target.dataset.wfPanX}px`);
      target.style.setProperty("--wf-pan-y", `${target.dataset.wfPanY}px`);
    } catch (error) {
      if (runId !== workflowDiagramRenderRunId || !target.isConnected) {
        return;
      }
      target.dataset.state = "error";
      target.innerHTML = `
        <div class="workflow-diagram-error">Mermaid diagramを描画できませんでした。</div>
        <pre class="workflow-diagram-fallback">${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>
        <pre class="workflow-diagram-fallback">${escapeHtml(source)}</pre>
      `;
    }
  }
}

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

export function renderTemplatePanel(templates: WorkflowTemplate[]) {
  return `
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">Workflow</p>
          <h2>WorkflowTemplate</h2>
        </div>
        <span class="panel-count"><b>${templates.length}</b> 件</span>
      </div>
      <div class="template-list">
        ${templates.map((template) => `
          <article class="template-row">
            <div class="template-row-main">
              <strong>${escapeHtml(template.name)} v${template.version}</strong>
              <span>${escapeHtml(template.type)}</span>
              ${template.description ? `<small>${escapeHtml(template.description)}</small>` : ""}
            </div>
            <div class="template-row-actions">
              <button class="button-secondary compact template-action-button" type="button" data-action="open-template-diagram" data-template-id="${escapeAttr(template.id)}" aria-label="diagram" title="diagram">${iconDiagram()}</button>
              <span class="template-export-dropdown">
                <button class="button-secondary compact template-action-button template-export-trigger" type="button" popovertarget="template-export-menu-${escapeAttr(template.id)}" style="display:grid;place-items:center;line-height:0;" aria-label="export" title="export">${iconDownload()}</button>
                <div class="template-export-menu" id="template-export-menu-${escapeAttr(template.id)}" popover>
                  <button class="button-secondary compact" type="button" data-action="export-workflow" data-template-id="${escapeAttr(template.id)}" popovertarget="template-export-menu-${escapeAttr(template.id)}" popovertargetaction="hide">${iconDownload()}raw export</button>
                  <button class="button-secondary compact" type="button" data-action="export-template" data-template-id="${escapeAttr(template.id)}" popovertarget="template-export-menu-${escapeAttr(template.id)}" popovertargetaction="hide">${iconDownload()}template export</button>
                </div>
              </span>
              <button class="button-danger compact template-action-button" type="button" data-action="delete-template" data-template-id="${escapeAttr(template.id)}" aria-label="削除" title="削除">${iconTrash()}</button>
            </div>
          </article>
        `).join("") || `<div class="empty">登録済みテンプレートはありません。</div>`}
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
  lora: "LoRA"
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

export function renderWorkflowDiagramModal(templates: WorkflowTemplate[], activeTemplateId: string | null) {
  if (!activeTemplateId) {
    return "";
  }
  const template = templates.find((item) => item.id === activeTemplateId) ?? null;
  if (!template) {
    return "";
  }
  const diagram = createWorkflowMermaidDiagram(template.workflowJson, template.roleMap);
  return `
    <div class="workflow-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(template.name)} diagram">
      <section class="workflow-dialog workflow-diagram-dialog">
        <header class="workflow-dialog-header">
          <div>
            <p class="section-kicker">Workflow Diagram</p>
            <h2>${escapeHtml(template.name)} v${template.version}</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-template-diagram" aria-label="閉じる" title="閉じる">${iconClose()}</button>
        </header>
        ${renderWorkflowDiagramBlock(diagram)}
      </section>
    </div>
  `;
}

export function renderWorkflowDiagramBlock(diagram: WorkflowDiagram) {
  if (diagram.status !== "ready") {
    return renderWorkflowDiagramNotice(diagram.status, diagram.message);
  }
  return `
    <div class="workflow-diagram-block">
      <div class="workflow-diagram-meta">
        <span>${diagram.nodeCount} nodes</span>
        <span>${diagram.edgeCount} edges</span>
      </div>
      <div class="workflow-diagram-canvas" data-mermaid-diagram>
        <pre class="workflow-diagram-source">${escapeHtml(diagram.source)}</pre>
        <div class="workflow-diagram-loading">diagramを描画中...</div>
      </div>
    </div>
  `;
}

export function renderWorkflowDiagramNotice(status: WorkflowDiagramStatus, message: string) {
  return `
    <div class="workflow-diagram-notice ${status}">
      <strong>${status === "empty" ? "Empty workflow" : "Preview unavailable"}</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

export function renderWorkflowTypeOptions(selectedType: string) {
  const types = [
    ["txt2img", "txt2img"],
    ["img2img", "img2img"],
    ["ipadapter", "IP-Adapter"],
    ["controlnet", "ControlNet"],
    ["hybrid", "Hybrid"]
  ];
  return types
    .map(([value, label]) => `<option value="${value}" ${selectedType === value ? "selected" : ""}>${label}</option>`)
    .join("");
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
