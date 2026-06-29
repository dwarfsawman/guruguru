type Json = Record<string, unknown>;

interface ComfySettings {
  baseUrl: string;
  websocketUrl: string;
  timeoutSeconds: number;
  imageFetchMode: "view";
  storageDir: string;
}

interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  roundCount: number;
  assetCount: number;
  representativeThumbnailUrl?: string;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  type: string;
  version: number;
  workflowHash: string;
  workflowJson: Json;
  roleMap: Json;
}

interface Round {
  id: string;
  projectId: string;
  templateId: string;
  parentRoundId?: string | null;
  roundIndex: number;
  promptId?: string | null;
  status: string;
  generationMode: string;
  request: GenerationRequest;
  createdAt: string;
  completedAt?: string | null;
  assetCount?: number;
  selectedCount?: number;
  rejectedCount?: number;
}

interface Asset {
  id: string;
  projectId: string;
  roundId: string;
  promptId?: string | null;
  batchIndex: number;
  imagePath: string;
  thumbnailSmallPath: string;
  thumbnailMediumPath: string;
  width?: number | null;
  height?: number | null;
  prompt: string;
  negativePrompt: string;
  seed?: number | null;
  sampler: string;
  scheduler: string;
  steps?: number | null;
  cfg?: number | null;
  denoise?: number | null;
  workflowTemplateId: string;
  workflowTemplateVersion: number;
  workflowSnapshotHash: string;
  comfyOutputNodeId?: string | null;
  status: string;
  createdAt: string;
  imageUrl: string;
  thumbnailUrl: string;
  thumbnailMediumUrl: string;
}

interface AssetParent {
  id: string;
  parentAssetId: string;
  childAssetId: string;
  relationType: string;
  strength?: number | null;
  createdAt: string;
}

interface ProjectDetail {
  project: ProjectSummary;
  rounds: Round[];
  assets: Asset[];
  assetParents: AssetParent[];
  templates: WorkflowTemplate[];
}

interface GenerationRequest {
  templateId: string;
  prompt: string;
  negativePrompt: string;
  seed: number | null;
  seedMode: string;
  batchSize: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  denoise: number;
  width: number;
  height: number;
  generationMode: string;
  parentAssetId?: string | null;
  relationType?: string | null;
}

const app = document.querySelector<HTMLDivElement>("#app")!;

const state: {
  settings: ComfySettings | null;
  projects: ProjectSummary[];
  templates: WorkflowTemplate[];
  detail: ProjectDetail | null;
  currentProjectId: string | null;
  activeRoundId: string | null;
  activeAssetId: string | null;
  filter: "all" | "selected" | "rejected" | "unmarked";
  busy: boolean;
  message: string;
} = {
  settings: null,
  projects: [],
  templates: [],
  detail: null,
  currentProjectId: null,
  activeRoundId: null,
  activeAssetId: null,
  filter: "all",
  busy: false,
  message: ""
};

void boot();

async function boot() {
  await loadHome();
  bindEvents();
}

function bindEvents() {
  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const actionTarget = target.closest<HTMLElement>("[data-action]");
    if (!actionTarget) {
      return;
    }

    const action = actionTarget.dataset.action!;
    const id = actionTarget.dataset.id ?? "";
    void handleAction(action, id, actionTarget);
  });

  app.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target.id === "round-filter") {
      state.filter = target.value as typeof state.filter;
      render();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (!state.detail || !state.activeAssetId) {
      return;
    }
    if (event.key === "Escape") {
      state.activeAssetId = null;
      render();
    }
    if (event.key === "r" || event.key === "R") {
      void setAssetStatus(state.activeAssetId, "rejected");
    }
    if (event.key === " " && state.activeAssetId) {
      event.preventDefault();
      void setAssetStatus(state.activeAssetId, "selected");
    }
    if (event.key === "Enter") {
      const asset = findAsset(state.activeAssetId);
      if (asset) {
        fillGenerationFormFromAsset(asset, "img2img");
      }
    }
  });
}

async function handleAction(action: string, id: string, target: HTMLElement) {
  try {
    if (action === "home") {
      await loadHome();
    } else if (action === "save-settings") {
      await saveSettings();
    } else if (action === "test-comfy") {
      await testComfy();
    } else if (action === "create-template") {
      await createTemplate();
    } else if (action === "create-project") {
      await createProject();
    } else if (action === "open-project") {
      await openProject(id);
    } else if (action === "select-round") {
      state.activeRoundId = id;
      state.activeAssetId = null;
      render();
    } else if (action === "collect-round") {
      await collectRound(id);
    } else if (action === "generate-round") {
      await generateRound(null);
    } else if (action === "img2img-next") {
      await generateFromSelected("img2img");
    } else if (action === "asset-detail") {
      state.activeAssetId = id;
      render();
    } else if (action === "close-detail") {
      state.activeAssetId = null;
      render();
    } else if (action === "asset-selected") {
      await setAssetStatus(id, "selected");
    } else if (action === "asset-rejected") {
      await setAssetStatus(id, "rejected");
    } else if (action === "asset-unmarked") {
      await setAssetStatus(id, "generated");
    } else if (action === "use-parent") {
      const asset = findAsset(id);
      if (asset) {
        fillGenerationFormFromAsset(asset, target.dataset.mode ?? "img2img");
      }
    }
  } catch (error) {
    state.message = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function loadHome() {
  state.currentProjectId = null;
  state.detail = null;
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.settings = await api<ComfySettings>("/api/settings/comfy");
  state.templates = (await api<{ templates: WorkflowTemplate[] }>("/api/templates")).templates;
  state.projects = (await api<{ projects: ProjectSummary[] }>("/api/projects")).projects;
  render();
}

async function openProject(projectId: string) {
  state.currentProjectId = projectId;
  state.detail = await api<ProjectDetail>(`/api/projects/${projectId}`);
  state.templates = state.detail.templates;
  state.activeRoundId = state.detail.rounds[0]?.id ?? null;
  state.activeAssetId = null;
  render();
}

async function saveSettings() {
  const form = readForm("settings-form");
  state.settings = await api<ComfySettings>("/api/settings/comfy", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: form.baseUrl,
      websocketUrl: form.websocketUrl,
      timeoutSeconds: Number(form.timeoutSeconds),
      storageDir: form.storageDir
    })
  });
  state.message = "ComfyUI接続設定を保存しました。";
  render();
}

async function testComfy() {
  const result = await api<Json>("/api/comfy/test", { method: "POST", body: "{}" });
  state.message = JSON.stringify(result, null, 2);
  render();
}

async function createTemplate() {
  const form = readForm("template-form");
  const result = await api<{ template: WorkflowTemplate }>("/api/templates", {
    method: "POST",
    body: JSON.stringify({
      name: form.name,
      description: form.description,
      type: form.type,
      workflowJson: form.workflowJson,
      roleMap: form.roleMap
    })
  });
  state.templates = [result.template, ...state.templates];
  state.message = `WorkflowTemplate "${result.template.name}" v${result.template.version} を登録しました。`;
  render();
}

async function createProject() {
  const form = readForm("project-form");
  const result = await api<{ project: ProjectSummary }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: form.name,
      description: form.description,
      defaultTemplateId: form.defaultTemplateId || null
    })
  });
  state.projects = [result.project, ...state.projects];
  await openProject(result.project.id);
}

async function generateRound(parentAsset: Asset | null, overrideMode?: string) {
  if (!state.currentProjectId) {
    return;
  }

  const form = readForm("generation-form");
  const request: GenerationRequest = {
    templateId: form.templateId,
    prompt: form.prompt,
    negativePrompt: form.negativePrompt,
    seed: form.seed ? Number(form.seed) : null,
    seedMode: form.seedMode,
    batchSize: Number(form.batchSize || 16),
    steps: Number(form.steps || 20),
    cfg: Number(form.cfg || 6),
    sampler: form.sampler || "euler",
    scheduler: form.scheduler || "normal",
    denoise: Number(form.denoise || 0.45),
    width: Number(form.width || 1024),
    height: Number(form.height || 1024),
    generationMode: overrideMode ?? form.generationMode,
    parentAssetId: parentAsset?.id ?? form.parentAssetId ?? null,
    relationType: parentAsset ? relationForMode(overrideMode ?? form.generationMode) : null
  };

  state.busy = true;
  render();
  const response = await api<{ promptId: string }>(`/api/projects/${state.currentProjectId}/rounds`, {
    method: "POST",
    body: JSON.stringify(request)
  });
  state.message = `ComfyUIに送信しました。prompt_id: ${response.promptId}`;
  state.busy = false;
  await openProject(state.currentProjectId);
}

async function generateFromSelected(mode: string) {
  const asset = getPreferredParentAsset();
  if (!asset) {
    throw new Error("selected画像、または詳細表示中の画像がありません。");
  }
  fillGenerationFormFromAsset(asset, mode);
  await generateRound(asset, mode);
}

async function collectRound(roundId: string) {
  const result = await api<Json>(`/api/rounds/${roundId}/collect`, {
    method: "POST",
    body: "{}"
  });
  state.message = "assets" in result
    ? `生成画像を取り込みました。${(result.assets as unknown[]).length}件`
    : String(result.message ?? "まだ出力画像はありません。");
  if (state.currentProjectId) {
    await openProject(state.currentProjectId);
  }
}

async function setAssetStatus(assetId: string, status: string) {
  await api(`/api/assets/${assetId}/status`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
  if (state.currentProjectId) {
    const keepAsset = state.activeAssetId;
    await openProject(state.currentProjectId);
    state.activeAssetId = keepAsset;
    render();
  }
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <button class="brand" data-action="home" type="button">GURUGURU</button>
      <div class="topbar-meta">${state.currentProjectId && state.detail ? escapeHtml(state.detail.project.name) : "Projects"}</div>
      <div class="status ${state.busy ? "busy" : ""}">${state.busy ? "running" : "ready"}</div>
    </header>
    ${state.message ? `<pre class="message">${escapeHtml(state.message)}</pre>` : ""}
    ${state.detail ? renderProjectDetail(state.detail) : renderHome()}
    ${renderAssetModal()}
  `;
}

function renderHome() {
  return `
    <main class="home-layout">
      <section class="section">
        <h1>Project一覧</h1>
        <form id="project-form" class="stack">
          <label>Project名<input name="name" placeholder="Daily Scene Character Exploration" required /></label>
          <label>説明<textarea name="description" rows="3"></textarea></label>
          <label>デフォルトWorkflowTemplate
            <select name="defaultTemplateId">
              <option value="">未指定</option>
              ${state.templates.map((template) => `<option value="${template.id}">${escapeHtml(template.name)} v${template.version}</option>`).join("")}
            </select>
          </label>
          <button type="button" data-action="create-project">新規Project作成</button>
        </form>
        <div class="project-list">
          ${state.projects.length ? state.projects.map(renderProjectCard).join("") : `<div class="empty">Projectはまだありません。</div>`}
        </div>
      </section>
      <aside class="side-stack">
        ${renderSettingsPanel()}
        ${renderTemplatePanel()}
      </aside>
    </main>
  `;
}

function renderProjectCard(project: ProjectSummary) {
  return `
    <article class="project-row">
      <button class="project-thumb" data-action="open-project" data-id="${project.id}" type="button">
        ${project.representativeThumbnailUrl ? `<img src="${project.representativeThumbnailUrl}" alt="" />` : `<span>No image</span>`}
      </button>
      <div>
        <h2>${escapeHtml(project.name)}</h2>
        <p>${escapeHtml(project.description || "説明なし")}</p>
        <div class="meta-line">Rounds ${project.roundCount ?? 0} / Assets ${project.assetCount ?? 0} / Updated ${formatDate(project.updatedAt)}</div>
      </div>
      <button type="button" data-action="open-project" data-id="${project.id}">開く</button>
    </article>
  `;
}

function renderSettingsPanel() {
  const settings = state.settings;
  return `
    <section class="section compact">
      <h2>ComfyUI接続</h2>
      <form id="settings-form" class="stack">
        <label>Base URL<input name="baseUrl" value="${escapeAttr(settings?.baseUrl ?? "http://127.0.0.1:8188")}" /></label>
        <label>WebSocket URL<input name="websocketUrl" value="${escapeAttr(settings?.websocketUrl ?? "ws://127.0.0.1:8188/ws")}" /></label>
        <label>Timeout秒<input name="timeoutSeconds" type="number" min="1" value="${settings?.timeoutSeconds ?? 60}" /></label>
        <label>保存先<input name="storageDir" value="${escapeAttr(settings?.storageDir ?? "")}" /></label>
        <div class="button-row">
          <button type="button" data-action="save-settings">保存</button>
          <button type="button" data-action="test-comfy">接続テスト</button>
        </div>
      </form>
    </section>
  `;
}

function renderTemplatePanel() {
  const roleMapExample = `{
  "positive_prompt_node": "6",
  "negative_prompt_node": "7",
  "ksampler_node": "3",
  "seed_input": "3.inputs.seed",
  "cfg_input": "3.inputs.cfg",
  "steps_input": "3.inputs.steps",
  "denoise_input": "3.inputs.denoise",
  "batch_size_input": "5.inputs.batch_size",
  "load_image_node": "12",
  "save_image_node": "9"
}`;
  return `
    <section class="section compact">
      <h2>WorkflowTemplate</h2>
      <form id="template-form" class="stack">
        <label>名前<input name="name" placeholder="txt2img_16grid" /></label>
        <label>説明<input name="description" /></label>
        <label>種別
          <select name="type">
            <option value="txt2img">txt2img</option>
            <option value="img2img">img2img</option>
            <option value="ipadapter">IP-Adapter</option>
            <option value="controlnet">ControlNet</option>
            <option value="hybrid">Hybrid</option>
          </select>
        </label>
        <label>API形式workflow JSON<textarea name="workflowJson" rows="8" spellcheck="false">{}</textarea></label>
        <label>role map<textarea name="roleMap" rows="8" spellcheck="false">${escapeHtml(roleMapExample)}</textarea></label>
        <button type="button" data-action="create-template">テンプレート登録</button>
      </form>
      <div class="template-list">
        ${state.templates.map((template) => `<div>${escapeHtml(template.name)} v${template.version} <span>${escapeHtml(template.type)}</span></div>`).join("") || "登録済みテンプレートはありません。"}
      </div>
    </section>
  `;
}

function renderProjectDetail(detail: ProjectDetail) {
  const activeRound = getActiveRound(detail);
  const assets = activeRound
    ? detail.assets.filter((asset) => asset.roundId === activeRound.id).filter(assetPassesFilter)
    : [];
  const selectedCount = detail.assets.filter((asset) => asset.status === "selected").length;
  const activeAsset = state.activeAssetId ? findAsset(state.activeAssetId) : null;

  return `
    <main class="project-layout">
      <aside class="rounds-pane">
        <div class="pane-head">
          <h1>${escapeHtml(detail.project.name)}</h1>
          <button type="button" data-action="home">Project一覧</button>
        </div>
        <div class="round-list">
          ${detail.rounds.length ? detail.rounds.map(renderRoundRow).join("") : `<div class="empty">Roundはまだありません。</div>`}
        </div>
      </aside>
      <section class="gallery-pane">
        <div class="gallery-toolbar">
          <div>
            <h2>${activeRound ? `Round ${activeRound.roundIndex}` : "Gallery"}</h2>
            <div class="meta-line">${activeRound ? `${activeRound.status} / ${activeRound.generationMode} / prompt_id ${activeRound.promptId ?? "-"}` : "新規Roundを生成してください。"}</div>
          </div>
          <div class="toolbar-actions">
            <select id="round-filter">
              <option value="all" ${state.filter === "all" ? "selected" : ""}>all</option>
              <option value="selected" ${state.filter === "selected" ? "selected" : ""}>selected</option>
              <option value="rejected" ${state.filter === "rejected" ? "selected" : ""}>rejected</option>
              <option value="unmarked" ${state.filter === "unmarked" ? "selected" : ""}>unmarked</option>
            </select>
            ${activeRound ? `<button type="button" data-action="collect-round" data-id="${activeRound.id}">生成結果取得</button>` : ""}
          </div>
        </div>
        <div class="gallery-grid">
          ${assets.length ? assets.map(renderAssetTile).join("") : `<div class="empty wide">このRoundには表示できる画像がありません。</div>`}
        </div>
        ${renderGenealogy(detail, activeAsset)}
      </section>
      <aside class="settings-pane">
        ${renderGenerationPanel(detail, activeAsset, selectedCount)}
      </aside>
    </main>
  `;
}

function renderRoundRow(round: Round) {
  const active = round.id === state.activeRoundId ? "active" : "";
  return `
    <button class="round-row ${active}" data-action="select-round" data-id="${round.id}" type="button">
      <span>Round ${round.roundIndex}</span>
      <strong>${escapeHtml(round.status)}</strong>
      <small>${escapeHtml(round.generationMode)} / ${round.assetCount ?? 0} images / selected ${round.selectedCount ?? 0}</small>
    </button>
  `;
}

function renderAssetTile(asset: Asset) {
  const statusClass = asset.status === "selected" ? "selected" : asset.status === "rejected" ? "rejected" : "";
  return `
    <article class="asset-tile ${statusClass}">
      <button class="asset-image" data-action="asset-detail" data-id="${asset.id}" type="button">
        <img src="${asset.thumbnailUrl}" alt="batch ${asset.batchIndex}" loading="lazy" />
      </button>
      <div class="asset-meta">
        <span>#${asset.batchIndex + 1}</span>
        <span>${escapeHtml(asset.status)}</span>
      </div>
      <div class="asset-actions">
        <button type="button" data-action="asset-selected" data-id="${asset.id}">selected</button>
        <button type="button" data-action="asset-rejected" data-id="${asset.id}">rejected</button>
        <button type="button" data-action="asset-unmarked" data-id="${asset.id}">clear</button>
      </div>
    </article>
  `;
}

function renderGenerationPanel(detail: ProjectDetail, activeAsset: Asset | null, selectedCount: number) {
  const activeRound = getActiveRound(detail);
  const previous = activeAsset ?? getPreferredParentAsset();
  const request = activeRound?.request;
  const templateOptions = detail.templates
    .map((template) => `<option value="${template.id}" ${request?.templateId === template.id ? "selected" : ""}>${escapeHtml(template.name)} v${template.version}</option>`)
    .join("");

  return `
    <section class="section compact">
      <h2>生成設定</h2>
      <div class="meta-line">selected ${selectedCount} / parent ${previous ? `#${previous.batchIndex + 1}` : "-"}</div>
      <form id="generation-form" class="stack">
        <input type="hidden" name="parentAssetId" value="${previous?.id ?? ""}" />
        <label>template<select name="templateId">${templateOptions}</select></label>
        <label>mode
          <select name="generationMode">
            ${["txt2img", "img2img", "ipadapter", "controlnet", "seed_reuse", "prompt_reuse"].map((mode) => `<option value="${mode}" ${request?.generationMode === mode ? "selected" : ""}>${mode}</option>`).join("")}
          </select>
        </label>
        <label>prompt<textarea name="prompt" rows="5">${escapeHtml(request?.prompt ?? previous?.prompt ?? "")}</textarea></label>
        <label>negative prompt<textarea name="negativePrompt" rows="3">${escapeHtml(request?.negativePrompt ?? previous?.negativePrompt ?? "")}</textarea></label>
        <div class="two-col">
          <label>batch<input name="batchSize" type="number" min="1" max="64" value="${request?.batchSize ?? 16}" /></label>
          <label>seed mode<select name="seedMode">
            ${["random", "fixed", "increment", "reuse_parent_seed"].map((mode) => `<option value="${mode}" ${request?.seedMode === mode ? "selected" : ""}>${mode}</option>`).join("")}
          </select></label>
          <label>seed<input name="seed" type="number" value="${request?.seed ?? previous?.seed ?? ""}" /></label>
          <label>steps<input name="steps" type="number" min="1" value="${request?.steps ?? 20}" /></label>
          <label>CFG<input name="cfg" type="number" step="0.1" value="${request?.cfg ?? 6}" /></label>
          <label>denoise<input name="denoise" type="number" step="0.01" min="0" max="1" value="${request?.denoise ?? 0.45}" /></label>
          <label>width<input name="width" type="number" step="64" value="${request?.width ?? 1024}" /></label>
          <label>height<input name="height" type="number" step="64" value="${request?.height ?? 1024}" /></label>
          <label>sampler<input name="sampler" value="${escapeAttr(request?.sampler ?? "euler")}" /></label>
          <label>scheduler<input name="scheduler" value="${escapeAttr(request?.scheduler ?? "normal")}" /></label>
        </div>
        <button type="button" data-action="generate-round">新規Round生成</button>
        <button type="button" data-action="img2img-next">選択画像からimg2img Round</button>
      </form>
    </section>
  `;
}

function renderGenealogy(detail: ProjectDetail, activeAsset: Asset | null) {
  if (!activeAsset) {
    const edges = detail.assetParents.slice(0, 10);
    return `
      <section class="genealogy">
        <h2>親子関係</h2>
        ${edges.length ? edges.map(renderEdge).join("") : `<div class="empty">親子関係はまだありません。</div>`}
      </section>
    `;
  }

  const parents = detail.assetParents.filter((edge) => edge.childAssetId === activeAsset.id);
  const children = detail.assetParents.filter((edge) => edge.parentAssetId === activeAsset.id);
  return `
    <section class="genealogy">
      <h2>親子関係</h2>
      <div class="genealogy-focus">
        <div>
          <h3>Parents</h3>
          ${parents.length ? parents.map(renderEdge).join("") : `<div class="empty">親Assetなし</div>`}
        </div>
        <div>
          <h3>Focus</h3>
          ${renderMiniAsset(activeAsset)}
        </div>
        <div>
          <h3>Children</h3>
          ${children.length ? children.map(renderEdge).join("") : `<div class="empty">子Assetなし</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderEdge(edge: AssetParent) {
  const parent = findAsset(edge.parentAssetId);
  const child = findAsset(edge.childAssetId);
  return `
    <div class="edge">
      ${parent ? renderMiniAsset(parent) : `<span>${escapeHtml(edge.parentAssetId)}</span>`}
      <span>${escapeHtml(edge.relationType)}</span>
      ${child ? renderMiniAsset(child) : `<span>${escapeHtml(edge.childAssetId)}</span>`}
    </div>
  `;
}

function renderMiniAsset(asset: Asset) {
  return `
    <button class="mini-asset" data-action="asset-detail" data-id="${asset.id}" type="button">
      <img src="${asset.thumbnailUrl}" alt="" />
      <span>R${roundIndexFor(asset.roundId)} #${asset.batchIndex + 1}</span>
    </button>
  `;
}

function renderAssetModal() {
  if (!state.activeAssetId) {
    return "";
  }
  const asset = findAsset(state.activeAssetId);
  if (!asset) {
    return "";
  }

  const parents = state.detail?.assetParents.filter((edge) => edge.childAssetId === asset.id) ?? [];
  const children = state.detail?.assetParents.filter((edge) => edge.parentAssetId === asset.id) ?? [];

  return `
    <div class="modal-backdrop">
      <section class="asset-modal">
        <div class="modal-image">
          <img src="${asset.imageUrl}" alt="" />
        </div>
        <aside class="modal-info">
          <div class="pane-head">
            <h2>Asset #${asset.batchIndex + 1}</h2>
            <button type="button" data-action="close-detail">閉じる</button>
          </div>
          <div class="button-row">
            <button type="button" data-action="asset-selected" data-id="${asset.id}">selected</button>
            <button type="button" data-action="asset-rejected" data-id="${asset.id}">rejected</button>
            <button type="button" data-action="asset-unmarked" data-id="${asset.id}">clear</button>
          </div>
          <button type="button" data-action="use-parent" data-id="${asset.id}" data-mode="img2img">img2img設定へ読み込み</button>
          <dl class="kv">
            <dt>status</dt><dd>${escapeHtml(asset.status)}</dd>
            <dt>seed</dt><dd>${asset.seed ?? "-"}</dd>
            <dt>CFG</dt><dd>${asset.cfg ?? "-"}</dd>
            <dt>steps</dt><dd>${asset.steps ?? "-"}</dd>
            <dt>denoise</dt><dd>${asset.denoise ?? "-"}</dd>
            <dt>sampler</dt><dd>${escapeHtml(asset.sampler)}</dd>
            <dt>scheduler</dt><dd>${escapeHtml(asset.scheduler)}</dd>
            <dt>workflow</dt><dd>${escapeHtml(asset.workflowTemplateId)} v${asset.workflowTemplateVersion}</dd>
            <dt>prompt_id</dt><dd>${escapeHtml(asset.promptId ?? "-")}</dd>
            <dt>file</dt><dd>${escapeHtml(asset.imagePath)}</dd>
          </dl>
          <h3>prompt</h3>
          <p class="prompt-text">${escapeHtml(asset.prompt)}</p>
          <h3>negative</h3>
          <p class="prompt-text">${escapeHtml(asset.negativePrompt)}</p>
          <h3>parents</h3>
          ${parents.length ? parents.map(renderEdge).join("") : `<div class="empty">なし</div>`}
          <h3>children</h3>
          ${children.length ? children.map(renderEdge).join("") : `<div class="empty">なし</div>`}
        </aside>
      </section>
    </div>
  `;
}

function getActiveRound(detail: ProjectDetail) {
  return detail.rounds.find((round) => round.id === state.activeRoundId) ?? detail.rounds[0] ?? null;
}

function findAsset(assetId: string | null) {
  if (!assetId || !state.detail) {
    return null;
  }
  return state.detail.assets.find((asset) => asset.id === assetId) ?? null;
}

function getPreferredParentAsset() {
  const active = findAsset(state.activeAssetId);
  if (active) {
    return active;
  }
  return state.detail?.assets.find((asset) => asset.status === "selected") ?? null;
}

function assetPassesFilter(asset: Asset) {
  if (state.filter === "all") {
    return true;
  }
  if (state.filter === "unmarked") {
    return asset.status === "generated";
  }
  return asset.status === state.filter;
}

function fillGenerationFormFromAsset(asset: Asset, mode: string) {
  state.activeAssetId = asset.id;
  render();
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (!form) {
    return;
  }
  setFormValue(form, "parentAssetId", asset.id);
  setFormValue(form, "generationMode", mode);
  setFormValue(form, "prompt", asset.prompt);
  setFormValue(form, "negativePrompt", asset.negativePrompt);
  setFormValue(form, "seed", String(asset.seed ?? ""));
  setFormValue(form, "seedMode", "random");
  setFormValue(form, "denoise", mode === "img2img" ? "0.35" : "0.45");
}

function setFormValue(form: HTMLFormElement, name: string, value: string) {
  const control = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (control) {
    control.value = value;
  }
}

function roundIndexFor(roundId: string) {
  return state.detail?.rounds.find((round) => round.id === roundId)?.roundIndex ?? "?";
}

function relationForMode(mode: string) {
  if (mode === "ipadapter") {
    return "ipadapter_reference";
  }
  if (mode === "controlnet") {
    return "controlnet_reference";
  }
  if (mode === "seed_reuse") {
    return "seed_reuse";
  }
  if (mode === "prompt_reuse") {
    return "prompt_reuse";
  }
  return "img2img";
}

function readForm(formId: string): Record<string, string> {
  const form = document.querySelector<HTMLFormElement>(`#${formId}`);
  if (!form) {
    throw new Error(`Form was not found: ${formId}`);
  }
  const values: Record<string, string> = {};
  for (const [key, value] of new FormData(form).entries()) {
    values[key] = String(value);
  }
  return values;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    },
    ...init
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with ${response.status}`);
  }
  return body as T;
}

function formatDate(value: string) {
  return value ? new Date(value).toLocaleString() : "-";
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value: unknown) {
  return escapeHtml(value).replaceAll("'", "&#039;");
}
