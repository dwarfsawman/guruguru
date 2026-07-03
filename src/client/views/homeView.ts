/**
 * Home画面（Project一覧・接続設定）の render helper。
 * `src/client/main.ts` から抽出。state は引数で受け取るため main.ts への逆依存を持たない（circular import なし）。
 * UI 文言・HTML 構造・CSS class・data-action・selector は移動前と同一。
 */
import type { ComfySettings } from "../../shared/types";
import type { ProjectSummary, WorkflowTemplate } from "../../shared/apiTypes";
import { DEFAULT_WEB_SAM_MODEL_BASE_URL } from "../../shared/constants";
import { escapeAttr, escapeHtml, formatDate } from "../format";
import { iconPlus, iconPulse, iconSave, iconTrash } from "../icons";
import { renderTemplatePanel, renderWorkflowImportPanel } from "../workflowUi";

export function renderHome(projects: ProjectSummary[], settings: ComfySettings | null, templates: WorkflowTemplate[]) {
  return `
    <main class="home-layout">
      <section class="panel">
        <div class="panel-heading">
          <div>
            <p class="section-kicker">Projects</p>
            <h1>Project一覧</h1>
          </div>
        </div>
        <form id="project-form" class="form-stack">
          <label>Project名<input name="name" placeholder="未入力の場合は自動採番されます" /></label>
          <label>説明<textarea name="description" rows="3"></textarea></label>
          <label>デフォルトWorkflowTemplate
            <select name="defaultTemplateId">
              <option value="">未指定</option>
              ${templates.map((template) => `<option value="${template.id}">${escapeHtml(template.name)} v${template.version}</option>`).join("")}
            </select>
          </label>
          <button class="button-primary" type="button" data-action="create-project">${iconPlus()}新規Project作成</button>
        </form>
        <div class="project-list">
          ${projects.length ? projects.map(renderProjectCard).join("") : `<div class="empty">Projectはまだありません。</div>`}
        </div>
      </section>
      <div class="home-side">
        ${renderSettingsPanel(settings)}
        ${renderWorkflowImportPanel()}
        ${renderTemplatePanel(templates)}
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
        <p>${escapeHtml(project.description || "説明なし")}</p>
        <div class="meta-line">Rounds ${project.roundCount ?? 0} / Assets ${project.assetCount ?? 0} / Updated ${formatDate(project.updatedAt)}</div>
      </div>
      <div class="project-actions">
        <button class="button-secondary" type="button" data-action="open-project" data-id="${project.id}">開く</button>
        <button class="button-danger" type="button" data-action="delete-project" data-id="${project.id}">${iconTrash()}削除</button>
      </div>
    </article>
  `;
}

export function renderSettingsPanel(settings: ComfySettings | null) {
  return `
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">Connection</p>
          <h2>ComfyUI接続</h2>
        </div>
      </div>
      <form id="settings-form" class="form-stack">
        <label>Base URL<input name="baseUrl" value="${escapeAttr(settings?.baseUrl ?? "http://127.0.0.1:8188")}" /></label>
        <label>WebSocket URL<input name="websocketUrl" value="${escapeAttr(settings?.websocketUrl ?? "ws://127.0.0.1:8188/ws")}" /></label>
        <label>Timeout秒<input name="timeoutSeconds" type="number" min="1" value="${settings?.timeoutSeconds ?? 60}" /></label>
        <label>保存先<input name="storageDir" value="${escapeAttr(settings?.storageDir ?? "")}" /></label>
        <label>WebSAM model base URL<input name="webSamModelBaseUrl" value="${escapeAttr(settings?.webSamModelBaseUrl ?? DEFAULT_WEB_SAM_MODEL_BASE_URL)}" placeholder="${escapeAttr(DEFAULT_WEB_SAM_MODEL_BASE_URL)}" /></label>
        <div class="button-row">
          <button class="button-secondary" type="button" data-action="save-settings">${iconSave()}保存</button>
          <button class="button-secondary" type="button" data-action="test-comfy">${iconPulse()}接続テスト</button>
        </div>
      </form>
    </section>
  `;
}
