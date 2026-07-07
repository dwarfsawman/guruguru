/**
 * Home画面（Project一覧・接続設定）の render helper。
 * `src/client/main.ts` から抽出。state は引数で受け取るため main.ts への逆依存を持たない（circular import なし）。
 * UI 文言・HTML 構造・CSS class・data-action・selector は移動前と同一。
 */
import type { ComfySettings, LlmSettings } from "../../shared/types";
import type { ProjectSummary, WorkflowTemplate } from "../../shared/apiTypes";
import { DEFAULT_WEB_SAM_MODEL_BASE_URL } from "../../shared/constants";
import { escapeAttr, escapeHtml, formatDate } from "../format";
import { iconChevron, iconPlus, iconTrash } from "../icons";
import { renderModelSelectPanel } from "../workflowUi";
import { renderRangeControl } from "./generationPanel";

export type ConnectionState = "unknown" | "checking" | "connected" | "disconnected";

export interface ConnectionSummary {
  state: ConnectionState;
  text: string;
}

const unknownConnectionSummary: ConnectionSummary = { state: "unknown", text: "未確認" };

export function renderHome(
  projects: ProjectSummary[],
  settings: ComfySettings | null,
  templates: WorkflowTemplate[],
  llmSettings: LlmSettings | null = null,
  comfyStatus: ConnectionSummary = unknownConnectionSummary,
  llmStatus: ConnectionSummary = unknownConnectionSummary
) {
  const totalAssets = projects.reduce((sum, project) => sum + (project.assetCount ?? 0), 0);
  return `
    <main class="home-layout">
      <section class="panel">
        <div class="panel-heading">
          <div>
            <p class="section-kicker">Projects</p>
            <h1>Project一覧</h1>
          </div>
          <span class="panel-count"><b>${projects.length}</b> projects · <b>${totalAssets}</b> assets</span>
        </div>
        <form id="project-form" class="form-stack">
          <label>Project名<input name="name" placeholder="未入力の場合は自動採番されます" /></label>
          <label>デフォルトWorkflowTemplate
            <select name="defaultTemplateId">
              <option value="">未指定</option>
              ${templates.map((template) => `<option value="${template.id}">${escapeHtml(template.name)} v${template.version}</option>`).join("")}
            </select>
          </label>
          <label class="form-span">説明<textarea name="description" rows="2"></textarea></label>
          <div class="form-submit-row">
            <button class="button-primary" type="button" data-action="create-project">${iconPlus()}新規Project作成</button>
          </div>
        </form>
        <div class="project-list">
          ${projects.length ? projects.map(renderProjectCard).join("") : `<div class="empty">Projectはまだありません。</div>`}
        </div>
      </section>
      <div class="home-side">
        ${renderSettingsPanel(settings, llmSettings, comfyStatus, llmStatus)}
        ${renderModelSelectPanel()}
      </div>
    </main>
  `;
}

export function renderProjectCard(project: ProjectSummary) {
  return `
    <article class="project-card">
      <button class="project-thumb" data-action="open-project" data-id="${project.id}" type="button" aria-label="${escapeAttr(project.name)}を開く">
        ${project.representativeThumbnailUrl ? `<img src="${project.representativeThumbnailUrl}" alt="" />` : `<span>No image</span>`}
      </button>
      <div class="project-copy">
        <h2>${escapeHtml(project.name)}</h2>
        <p class="${project.description ? "" : "desc-empty"}">${escapeHtml(project.description || "説明なし")}</p>
        <div class="meta-line">Rounds <b>${project.roundCount ?? 0}</b> · Assets <b>${project.assetCount ?? 0}</b> · Updated <b>${formatDate(project.updatedAt)}</b></div>
      </div>
      <div class="project-actions">
        <button class="button-secondary" type="button" data-action="open-project" data-id="${project.id}">開く</button>
        <button class="button-danger" type="button" data-action="delete-project" data-id="${project.id}">${iconTrash()}削除</button>
      </div>
    </article>
  `;
}

export function renderSettingsPanel(
  settings: ComfySettings | null,
  llmSettings: LlmSettings | null = null,
  comfyStatus: ConnectionSummary = unknownConnectionSummary,
  llmStatus: ConnectionSummary = unknownConnectionSummary
) {
  return `
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">Connection</p>
        </div>
      </div>
      <details class="collapsible connection-block" open>
        <summary>
          <span class="connection-block-title">ComfyUI接続</span>
          <span class="connection-block-right">${renderConnectionBadge(comfyStatus)}${iconChevron()}</span>
        </summary>
        <div class="connection-block-body">
          <form id="settings-form" class="form-stack">
            <label>Base URL<input name="baseUrl" value="${escapeAttr(settings?.baseUrl ?? "http://127.0.0.1:8188")}" /></label>
            <label>WebSocket URL<input name="websocketUrl" value="${escapeAttr(settings?.websocketUrl ?? "ws://127.0.0.1:8188/ws")}" /></label>
            <label>Timeout秒<input name="timeoutSeconds" type="number" min="1" value="${settings?.timeoutSeconds ?? 60}" /></label>
            <label>保存先<input name="storageDir" value="${escapeAttr(settings?.storageDir ?? "")}" /></label>
            <label>WebSAM model base URL<input name="webSamModelBaseUrl" value="${escapeAttr(settings?.webSamModelBaseUrl ?? DEFAULT_WEB_SAM_MODEL_BASE_URL)}" placeholder="${escapeAttr(DEFAULT_WEB_SAM_MODEL_BASE_URL)}" /></label>
            <button class="button-primary" type="button" data-action="connect-comfy">接続</button>
          </form>
        </div>
      </details>
      <details class="collapsible connection-block">
        <summary>
          <span class="connection-block-title">OpenAI互換プロンプト接続</span>
          <span class="connection-block-right">${renderConnectionBadge(llmStatus)}${iconChevron()}</span>
        </summary>
        <div class="connection-block-body">
          <form id="llm-settings-form" class="form-stack">
            <label>Base URL<input name="baseUrl" value="${escapeAttr(llmSettings?.baseUrl ?? "")}" placeholder="http://127.0.0.1:1234/v1" /></label>
            <label>Model<input name="model" value="${escapeAttr(llmSettings?.model ?? "")}" placeholder="qwen3-14b-instruct" /></label>
            <label>System Prompt<textarea name="systemPrompt" rows="3" placeholder="ComfyUIのプロンプト作成を支援する指示を入力...">${escapeHtml(llmSettings?.systemPrompt ?? "")}</textarea></label>
            ${renderRangeControl("temperature", "Temperature", llmSettings?.temperature ?? 0.4, 0, 2, 0.1, "llmTemperatureValue")}
            <button class="button-primary" type="button" data-action="connect-llm">接続</button>
          </form>
        </div>
      </details>
    </section>
  `;
}

function renderConnectionBadge(status: ConnectionSummary) {
  return `<span class="connection-block-status" title="${escapeAttr(status.text)}"><span class="status-dot ${status.state}"></span><span>${escapeHtml(connectionBadgeLabel(status.state))}</span></span>`;
}

function connectionBadgeLabel(state: ConnectionState) {
  if (state === "connected") {
    return "接続済み";
  }
  if (state === "checking") {
    return "確認中";
  }
  if (state === "disconnected") {
    return "未接続";
  }
  return "未確認";
}
