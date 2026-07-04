/**
 * Mermaid / workflow diagram / template 周辺の UI renderer。
 * `src/client/main.ts` から HTML 文字列を返す renderer 群と Mermaid 初期化・描画を分離。
 * state は引数で受け取るため main.ts への逆依存を持たない（circular import なし）。
 * Mermaid 設定値・selector・data-action・HTML 構造・文言は維持。
 */
import mermaid from "mermaid";
import { createWorkflowMermaidDiagram, type WorkflowDiagram, type WorkflowDiagramStatus } from "../shared/workflowDiagram";
import { parseJsonObjectText } from "./json";
import { escapeAttr, escapeHtml } from "./format";
import { iconClose, iconDiagram, iconDownload, iconPlus, iconTrash } from "./icons";
import type { TemplateModelDefaults, WorkflowImportDraft, WorkflowTemplate } from "./workflowTypes";

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

export function renderWorkflowImportPanel() {
  return `
    <section class="workflow-import-collapsed">
      <button class="button-secondary workflow-import-trigger" type="button" data-action="open-template-import">
        ${iconPlus()}テンプレート登録
      </button>
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
              <details class="template-export-dropdown">
              <summary class="button-secondary compact template-action-button template-export-trigger" style="display:grid;place-items:center;line-height:0;" aria-label="export" title="export">${iconDownload()}</summary>
                <div class="template-export-menu">
                  <button class="button-secondary compact" type="button" data-action="export-workflow" data-template-id="${escapeAttr(template.id)}">${iconDownload()}raw export</button>
                  <button class="button-secondary compact" type="button" data-action="export-template" data-template-id="${escapeAttr(template.id)}">${iconDownload()}template export</button>
                </div>
              </details>
              <button class="button-danger compact template-action-button" type="button" data-action="delete-template" data-template-id="${escapeAttr(template.id)}" aria-label="削除" title="削除">${iconTrash()}</button>
            </div>
          </article>
        `).join("") || `<div class="empty">登録済みテンプレートはありません。</div>`}
      </div>
    </section>
  `;
}

export function renderWorkflowImportModal(open: boolean, draft: WorkflowImportDraft) {
  if (!open) {
    return "";
  }
  return `
    <div class="workflow-modal" role="dialog" aria-modal="true" aria-label="テンプレート登録">
      <section class="workflow-dialog workflow-import-dialog">
        <header class="workflow-dialog-header">
          <div>
            <p class="section-kicker">Workflow Import</p>
            <h2>テンプレート登録</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-template-import" aria-label="閉じる" title="閉じる">${iconClose()}</button>
        </header>
        <form id="template-form" class="workflow-import-modal-form">
          <div class="workflow-import-fields form-stack">
            <label>JSONファイル
              <input data-file-target="workflowJson" type="file" accept=".json,application/json" />
            </label>
            <label>名前<input name="name" placeholder="txt2img_16grid" value="${escapeAttr(draft.name)}" /></label>
            <label>説明<input name="description" value="${escapeAttr(draft.description)}" /></label>
            <label>種別
              <select name="type">
                ${renderWorkflowTypeOptions(draft.type)}
              </select>
            </label>
            <label>API形式workflow JSON<textarea class="workflow-json-textarea" name="workflowJson" rows="12" spellcheck="false">${escapeHtml(draft.workflowJson)}</textarea></label>
            <label>role map<textarea class="role-map-textarea" name="roleMap" rows="18" spellcheck="false">${escapeHtml(draft.roleMap)}</textarea></label>
          </div>
          <aside class="workflow-diagram-preview">
            <div class="workflow-diagram-heading">
              <div>
                <p class="section-kicker">Preview</p>
                <h3>diagram</h3>
              </div>
            </div>
            <div class="workflow-import-preview-slot">
              ${renderWorkflowImportPreview(draft)}
            </div>
          </aside>
          <div class="workflow-import-modal-actions">
            <button class="button-secondary" type="button" data-action="close-template-import">${iconClose()}閉じる</button>
            <button class="button-primary" type="button" data-action="create-template">${iconPlus()}テンプレート登録</button>
          </div>
        </form>
      </section>
    </div>
  `;
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

export function renderWorkflowImportPreview(draft: WorkflowImportDraft) {
  const workflowResult = parseJsonObjectText(draft.workflowJson, "API形式workflow JSON");
  if (!workflowResult.value) {
    return renderWorkflowDiagramNotice("invalid", workflowResult.error ?? "workflow JSONを入力してください。");
  }
  const roleMapResult = parseJsonObjectText(draft.roleMap, "role map", true);
  const diagram = createWorkflowMermaidDiagram(workflowResult.value, roleMapResult.value ?? {});
  const warning = roleMapResult.error ? `<div class="workflow-diagram-warning">${escapeHtml(roleMapResult.error)}</div>` : "";
  return `${warning}${renderWorkflowDiagramBlock(diagram)}`;
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
