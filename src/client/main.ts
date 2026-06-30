import { inferRoleMap } from "../shared/workflowRoleMap";

type Json = Record<string, unknown>;

interface ComfySettings {
  baseUrl: string;
  websocketUrl: string;
  timeoutSeconds: number;
  imageFetchMode: "view";
  storageDir: string;
}

type ComfyConnectionState = "unknown" | "checking" | "connected" | "disconnected";

interface ComfyStatus {
  ok: boolean;
  state: "connected" | "disconnected";
  baseUrl: string;
  checkedAt: string;
  error?: string;
}

interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  roundCount: number;
  assetCount: number;
  defaultTemplateId?: string | null;
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

interface TemplateGenerationDefaults {
  prompt?: string;
  negativePrompt?: string;
  seed?: number;
  batchSize?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  denoise?: number;
  width?: number;
  height?: number;
  model: TemplateModelDefaults;
}

interface TemplateModelDefaults {
  checkpoint?: string;
  diffusionModel?: string;
  textEncoders: string[];
  vae?: string;
  loras: string[];
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
  filter: "all" | "selected" | "rejected" | "favorite" | "unmarked";
  gridCols: 2 | 3 | 4;
  sidebarOpen: boolean;
  comfyConnection: ComfyConnectionState;
  comfyStatusText: string;
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
  gridCols: 4,
  sidebarOpen: false,
  comfyConnection: "unknown",
  comfyStatusText: "未確認",
  busy: false,
  message: ""
};

const defaultPrompt =
  "masterpiece, best quality, 1girl, beautiful detailed eyes, flowing hair, fantasy landscape, dramatic lighting, ethereal atmosphere";
const defaultNegativePrompt = "low quality, worst quality, blurry, deformed";
const pendingAutoCollectRoundIds = new Set<string>();
const samplerOptions = [
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
const schedulerOptions = ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta"];
void boot();

async function boot() {
  await loadHome();
  bindEvents();
}

function bindEvents() {
  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("preview-modal")) {
      state.activeAssetId = null;
      render();
      return;
    }

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
    if (target instanceof HTMLInputElement && target.type === "file" && target.dataset.fileTarget) {
      void loadWorkflowFile(target);
      return;
    }
    if (target.id === "round-filter") {
      state.filter = target.value as typeof state.filter;
      render();
      return;
    }
    if (target.id === "grid-cols") {
      state.gridCols = Number(target.value) as typeof state.gridCols;
      render();
      return;
    }
    if (target.name === "generationMode") {
      updateDenoiseControlForMode(target.value);
    }
  });

  app.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    const valueId = target.dataset.valueTarget;
    if (!valueId) {
      return;
    }
    const valueTarget = document.getElementById(valueId);
    if (valueTarget) {
      valueTarget.textContent = formatSliderValue(target);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (!state.detail) {
      if (event.key === "Escape" && state.sidebarOpen) {
        state.sidebarOpen = false;
        render();
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      void selectAllActiveRound();
      return;
    }

    if (event.key === "Escape") {
      if (state.activeAssetId) {
        state.activeAssetId = null;
        render();
      } else if (state.sidebarOpen) {
        state.sidebarOpen = false;
        render();
      }
      return;
    }

    if (!state.activeAssetId) {
      return;
    }

    if (event.key === "r" || event.key === "R") {
      void setAssetStatus(state.activeAssetId, "rejected");
    }
    if (event.key === "f" || event.key === "F") {
      void toggleFavorite(state.activeAssetId);
    }
    if (event.key === " ") {
      event.preventDefault();
      void toggleSelect(state.activeAssetId);
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
    } else if (action === "toggle-sidebar") {
      state.sidebarOpen = !state.sidebarOpen;
      render();
    } else if (action === "save-settings") {
      await saveSettings();
    } else if (action === "test-comfy") {
      await testComfy();
    } else if (action === "create-template") {
      await createTemplate();
    } else if (action === "export-template") {
      exportWorkflowTemplate(target, "template");
    } else if (action === "export-workflow") {
      exportWorkflowTemplate(target, "workflow");
    } else if (action === "delete-template") {
      await deleteWorkflowTemplate(target);
    } else if (action === "create-project") {
      await createProject();
    } else if (action === "open-project") {
      await openProject(id);
    } else if (action === "delete-project") {
      await deleteProject(id);
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
    } else if (action === "generate-from-preview") {
      const asset = findAsset(id);
      if (asset) {
        await generateRound(asset, target.dataset.mode ?? "img2img");
      }
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
    } else if (action === "toggle-select") {
      await toggleSelect(id);
    } else if (action === "toggle-favorite") {
      await toggleFavorite(id);
    } else if (action === "select-all") {
      await selectAllActiveRound();
    } else if (action === "clear-selection") {
      await clearSelectionActiveRound();
    } else if (action === "invert-selection") {
      await invertSelectionActiveRound();
    } else if (action === "export-selected") {
      exportSelected();
    } else if (action === "reset-session") {
      await resetActiveRoundMarks();
    } else if (action === "random-seed") {
      randomSeed();
    } else if (action === "swap-resolution") {
      swapResolution();
    } else if (action === "use-parent") {
      const asset = findAsset(id);
      if (asset) {
        fillGenerationFormFromAsset(asset, target.dataset.mode ?? "img2img");
      }
    }
  } catch (error) {
    state.busy = false;
    state.message = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function loadHome() {
  state.currentProjectId = null;
  state.detail = null;
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.sidebarOpen = false;
  state.settings = await api<ComfySettings>("/api/settings/comfy");
  state.templates = (await api<{ templates: WorkflowTemplate[] }>("/api/templates")).templates;
  state.projects = (await api<{ projects: ProjectSummary[] }>("/api/projects")).projects;
  render();
  void refreshComfyStatus();
}

async function openProject(projectId: string) {
  state.currentProjectId = projectId;
  state.detail = await api<ProjectDetail>(`/api/projects/${projectId}`);
  state.templates = state.detail.templates;
  state.activeRoundId = state.detail.rounds[0]?.id ?? null;
  state.activeAssetId = null;
  state.sidebarOpen = false;
  render();
}

async function refreshProject(keepRoundId = state.activeRoundId, keepAssetId = state.activeAssetId) {
  if (!state.currentProjectId) {
    return;
  }
  state.detail = await api<ProjectDetail>(`/api/projects/${state.currentProjectId}`);
  state.templates = state.detail.templates;
  state.activeRoundId = state.detail.rounds.some((round) => round.id === keepRoundId)
    ? keepRoundId
    : state.detail.rounds[0]?.id ?? null;
  state.activeAssetId = state.detail.assets.some((asset) => asset.id === keepAssetId) ? keepAssetId : null;
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
  await refreshComfyStatus(true);
}

async function testComfy() {
  state.comfyConnection = "checking";
  state.comfyStatusText = "接続確認中";
  render();
  const result = await api<Json>("/api/comfy/test", { method: "POST", body: "{}" });
  state.comfyConnection = isComfyTestSuccessful(result) ? "connected" : "disconnected";
  state.comfyStatusText = state.comfyConnection === "connected" ? "ComfyUI 接続済み" : "ComfyUI 未接続";
  state.message = JSON.stringify(result, null, 2);
  render();
}

async function refreshComfyStatus(showMessage = false) {
  state.comfyConnection = "checking";
  state.comfyStatusText = "接続確認中";
  render();
  try {
    const status = await api<ComfyStatus>("/api/comfy/status");
    state.comfyConnection = status.ok ? "connected" : "disconnected";
    state.comfyStatusText = status.ok ? "ComfyUI 接続済み" : `ComfyUI 未接続: ${status.error ?? status.baseUrl}`;
    if (showMessage) {
      state.message = state.comfyStatusText;
    }
  } catch (error) {
    state.comfyConnection = "disconnected";
    state.comfyStatusText = error instanceof Error ? error.message : String(error);
    if (showMessage) {
      state.message = state.comfyStatusText;
    }
  }
  render();
}

function isComfyTestSuccessful(result: Json) {
  const objectInfo = result.objectInfo as { ok?: unknown } | undefined;
  const queue = result.queue as { ok?: unknown } | undefined;
  const websocket = result.websocket as { ok?: unknown } | undefined;
  return objectInfo?.ok === true && queue?.ok === true && websocket?.ok === true;
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
  if (state.detail) {
    state.detail.templates = state.templates;
  }
  state.message = `WorkflowTemplate "${result.template.name}" v${result.template.version} を登録しました。`;
  render();
}

async function loadWorkflowFile(input: HTMLInputElement) {
  const file = input.files?.[0];
  const form = input.closest<HTMLFormElement>("form");
  if (!file || !form) {
    return;
  }

  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    state.message = "workflow JSONファイルを読み込めませんでした。JSON形式を確認してください。";
    render();
    return;
  }

  if (!isJsonObject(parsed)) {
    state.message = "workflow JSONファイルのルートはJSON objectである必要があります。";
    render();
    return;
  }

  const workflowJson = pickJsonObject(parsed, "workflowJson") ?? pickJsonObject(parsed, "workflow_json") ?? parsed;
  const importedRoleMap =
    pickJsonObject(parsed, "roleMap") ??
    pickJsonObject(parsed, "role_map") ??
    pickJsonObject(parsed, "role_map_json");
  const roleMap =
    importedRoleMap ??
    inferRoleMap(workflowJson);

  setFormValue(form, "workflowJson", JSON.stringify(workflowJson, null, 2));
  if (Object.keys(roleMap).length > 0) {
    setFormValue(form, "roleMap", JSON.stringify(roleMap, null, 2));
  }
  state.message = importedRoleMap
    ? "workflow JSONとrole mapを読み込みました。"
    : "workflow JSONを読み込み、role mapを自動設定しました。必要に応じて内容を確認してください。";
  if (typeof parsed.name === "string") {
    setFormValue(form, "name", parsed.name);
  } else if (!((form.elements.namedItem("name") as HTMLInputElement | null)?.value)) {
    setFormValue(form, "name", file.name.replace(/\.json$/i, ""));
  }
  if (typeof parsed.description === "string") {
    setFormValue(form, "description", parsed.description);
  }
  if (typeof parsed.type === "string") {
    setFormValue(form, "type", parsed.type);
  }
}

function exportWorkflowTemplate(target: HTMLElement, kind: "template" | "workflow") {
  const template = findTemplateFromActionTarget(target);
  if (!template) {
    state.message = "エクスポートするWorkflowTemplateがありません。";
    render();
    return;
  }

  if (kind === "workflow") {
    downloadJson(`${slugify(template.name)}.workflow.json`, template.workflowJson);
    state.message = `WorkflowTemplate "${template.name}" のraw workflow JSONを書き出しました。`;
  } else {
    downloadJson(`${slugify(template.name)}.guruguru-template.json`, {
      guruguruTemplateVersion: 1,
      exportedAt: new Date().toISOString(),
      name: template.name,
      description: template.description,
      type: template.type,
      version: template.version,
      workflowJson: template.workflowJson,
      roleMap: template.roleMap
    });
    state.message = `WorkflowTemplate "${template.name}" をGURUGURU template形式で書き出しました。`;
  }
  render();
}

function findTemplateFromActionTarget(target: HTMLElement) {
  const directId = target.dataset.templateId;
  const sourceId = target.dataset.templateSource;
  const source = sourceId ? document.getElementById(sourceId) as HTMLSelectElement | null : null;
  const templateId = directId ?? source?.value ?? "";
  return state.templates.find((template) => template.id === templateId) ?? null;
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function slugify(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "workflow-template";
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

async function deleteProject(projectId: string) {
  const project = state.projects.find((item) => item.id === projectId) ?? state.detail?.project ?? null;
  const projectName = project?.name ?? "このProject";
  if (!window.confirm(`Project "${projectName}" を削除します。生成画像とイテレーションも削除しますか？`)) {
    return;
  }

  const result = await api<{ deleted: boolean; storageDeleted: boolean; storageError?: string }>(`/api/projects/${projectId}`, {
    method: "DELETE"
  });

  if (state.currentProjectId === projectId) {
    state.message = result.storageError
      ? `Projectを削除しました。保存ディレクトリの削除に失敗しました: ${result.storageError}`
      : "Projectを削除しました。";
    await loadHome();
    return;
  }

  state.projects = state.projects.filter((item) => item.id !== projectId);
  state.message = result.storageError
    ? `Projectを削除しました。保存ディレクトリの削除に失敗しました: ${result.storageError}`
    : "Projectを削除しました。";
  render();
}

async function deleteWorkflowTemplate(target: HTMLElement) {
  const template = findTemplateFromActionTarget(target);
  if (!template) {
    state.message = "削除するWorkflowTemplateがありません。";
    render();
    return;
  }
  if (!window.confirm(`WorkflowTemplate "${template.name}" v${template.version} を削除しますか？既存の生成履歴は残ります。`)) {
    return;
  }

  await api(`/api/templates/${template.id}`, { method: "DELETE" });
  state.templates = state.templates.filter((item) => item.id !== template.id);
  if (state.detail) {
    await refreshProject(state.activeRoundId, state.activeAssetId);
  }
  state.message = `WorkflowTemplate "${template.name}" を削除しました。`;
  render();
}

async function generateRound(parentAsset: Asset | null, overrideMode?: string) {
  if (!state.currentProjectId) {
    return;
  }

  const form = readForm("generation-form");
  const generationMode = overrideMode ?? form.generationMode ?? "txt2img";
  const parentAssetId = parentAsset?.id ?? form.parentAssetId ?? null;
  const denoise = normalizeDenoiseForMode(
    Number(form.denoise || defaultDenoiseForMode(generationMode)),
    generationMode
  );
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
    denoise,
    width: Number(form.width || 1024),
    height: Number(form.height || 1024),
    generationMode,
    parentAssetId,
    relationType: parentAsset ? relationForMode(generationMode) : null
  };

  state.busy = true;
  render();
  const response = await api<{ promptId: string; round: Round }>(`/api/projects/${state.currentProjectId}/rounds`, {
    method: "POST",
    body: JSON.stringify(request)
  });
  const roundId = response.round.id;
  state.message = `ComfyUIに送信しました。prompt_id: ${response.promptId}`;
  state.busy = false;
  await refreshProject(roundId, null);
  render();
  if (roundId) {
    void pollCollectRound(roundId, state.currentProjectId);
  }
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
  await refreshProject(roundId, state.activeAssetId);
  render();
}

async function pollCollectRound(roundId: string, projectId: string | null) {
  if (!projectId || pendingAutoCollectRoundIds.has(roundId)) {
    return;
  }
  pendingAutoCollectRoundIds.add(roundId);

  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await delay(1500);
      if (state.currentProjectId !== projectId) {
        return;
      }

      const result = await api<Json>(`/api/rounds/${roundId}/collect`, {
        method: "POST",
        body: "{}"
      });

      if ("assets" in result) {
        const count = (result.assets as unknown[]).length;
        state.message = `生成画像を自動で取り込みました。${count}件`;
        await refreshProject(roundId, state.activeAssetId);
        render();
        return;
      }
    }

    if (state.currentProjectId === projectId) {
      state.message = "生成結果の自動取得が時間内に完了しませんでした。「生成結果取得」を押して再取得できます。";
      await refreshProject(roundId, state.activeAssetId);
      render();
    }
  } catch (error) {
    if (state.currentProjectId === projectId) {
      state.message = error instanceof Error ? error.message : String(error);
      render();
    }
  } finally {
    pendingAutoCollectRoundIds.delete(roundId);
  }
}

async function setAssetStatus(assetId: string, status: string, refresh = true) {
  await api(`/api/assets/${assetId}/status`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
  if (refresh) {
    await refreshProject(state.activeRoundId, state.activeAssetId);
    render();
  }
}

async function toggleSelect(assetId: string) {
  const asset = findAsset(assetId);
  if (!asset) {
    return;
  }
  await setAssetStatus(assetId, asset.status === "selected" ? "generated" : "selected");
}

async function toggleFavorite(assetId: string) {
  const asset = findAsset(assetId);
  if (!asset) {
    return;
  }
  await setAssetStatus(assetId, asset.status === "favorite" ? "generated" : "favorite");
}

async function selectAllActiveRound() {
  const assets = getActiveRoundAssets().filter((asset) => !["archived", "failed"].includes(asset.status));
  for (const asset of assets) {
    if (asset.status !== "selected") {
      await setAssetStatus(asset.id, "selected", false);
    }
  }
  await refreshProject(state.activeRoundId, state.activeAssetId);
  render();
}

async function clearSelectionActiveRound() {
  const assets = getActiveRoundAssets().filter((asset) => asset.status === "selected");
  for (const asset of assets) {
    await setAssetStatus(asset.id, "generated", false);
  }
  await refreshProject(state.activeRoundId, state.activeAssetId);
  render();
}

async function invertSelectionActiveRound() {
  const assets = getActiveRoundAssets().filter((asset) => !["archived", "failed", "rejected"].includes(asset.status));
  for (const asset of assets) {
    await setAssetStatus(asset.id, asset.status === "selected" ? "generated" : "selected", false);
  }
  await refreshProject(state.activeRoundId, state.activeAssetId);
  render();
}

async function resetActiveRoundMarks() {
  const assets = getActiveRoundAssets().filter((asset) => ["selected", "rejected", "favorite"].includes(asset.status));
  for (const asset of assets) {
    await setAssetStatus(asset.id, "generated", false);
  }
  state.message = "現在のイテレーションの選択状態をクリアしました。";
  await refreshProject(state.activeRoundId, null);
  render();
}

function exportSelected() {
  const count = getActiveRoundAssets().filter((asset) => asset.status === "selected").length;
  state.message = count > 0
    ? `${count}枚の選択画像を保存対象にしました。保存先はComfyUI接続設定の保存先です。`
    : "保存対象の選択画像がありません。";
  render();
}

function randomSeed() {
  const input = document.querySelector<HTMLInputElement>('input[name="seed"]');
  const seedMode = document.querySelector<HTMLSelectElement>('select[name="seedMode"]');
  if (input) {
    input.value = String(Math.floor(Math.random() * 2147483647));
  }
  if (seedMode) {
    seedMode.value = "fixed";
  }
}

function swapResolution() {
  const width = document.querySelector<HTMLInputElement>('input[name="width"]');
  const height = document.querySelector<HTMLInputElement>('input[name="height"]');
  if (!width || !height) {
    return;
  }
  const nextWidth = height.value;
  height.value = width.value;
  width.value = nextWidth;
}

function render() {
  app.innerHTML = `
    ${renderHeader()}
    ${state.message ? `<pre class="message">${escapeHtml(state.message)}</pre>` : ""}
    ${state.detail ? renderProjectDetail(state.detail) : renderHome()}
    ${renderAssetModal()}
  `;
}

function renderHeader() {
  const detail = state.detail;
  const connection = getConnectionView();
  return `
    <header class="app-header">
      <div class="header-left">
        <button class="icon-button menu-button" data-action="toggle-sidebar" type="button" aria-label="設定を開く">${iconMenu()}</button>
        <button class="brand" data-action="home" type="button">
          <span class="brand-mark">${iconLoop()}</span>
          <span>
            <strong>GURUGURU</strong>
            <small>Iterative Generation Studio</small>
          </span>
        </button>
      </div>
      ${detail ? renderIterationTracker(detail) : renderStarterIterationTracker()}
      <div class="header-right">
        <div class="connection">
          <span class="status-dot ${connection.className}"></span>
          <span title="${escapeAttr(state.comfyStatusText)}">${escapeHtml(connection.label)}</span>
        </div>
      </div>
    </header>
  `;
}

function getConnectionView() {
  if (state.busy) {
    return { className: "generating", label: "生成送信中..." };
  }
  if (state.comfyConnection === "connected") {
    return { className: "connected", label: "ComfyUI 接続済み" };
  }
  if (state.comfyConnection === "checking") {
    return { className: "checking", label: "接続確認中" };
  }
  if (state.comfyConnection === "disconnected") {
    return { className: "disconnected", label: "ComfyUI 未接続" };
  }
  return { className: "unknown", label: "ComfyUI 未確認" };
}

function renderIterationTracker(detail: ProjectDetail) {
  const rounds = sortRoundsAsc(detail.rounds);
  if (!rounds.length) {
    return `<div class="iteration-tracker"><span class="iteration-empty">No iterations</span></div>`;
  }
  return `
    <div class="iteration-tracker" aria-label="イテレーション">
      ${rounds.map((round, index) => {
        const active = round.id === state.activeRoundId;
        const completed = round.status === "completed";
        const dotClass = active ? "active" : completed ? "completed" : "pending";
        return `
          <button class="iteration-dot ${dotClass}" data-action="select-round" data-id="${round.id}" type="button" title="Iteration ${round.roundIndex}">${round.roundIndex}</button>
          ${index < rounds.length - 1 ? `<span class="iteration-connector ${completed ? "completed" : ""}"></span>` : ""}
        `;
      }).join("")}
    </div>
  `;
}

function renderStarterIterationTracker() {
  return `<div class="iteration-tracker"><span class="iteration-empty">Project未選択</span></div>`;
}

function renderHome() {
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
          <label>Project名<input name="name" placeholder="Daily Scene Character Exploration" required /></label>
          <label>説明<textarea name="description" rows="3"></textarea></label>
          <label>デフォルトWorkflowTemplate
            <select name="defaultTemplateId">
              <option value="">未指定</option>
              ${state.templates.map((template) => `<option value="${template.id}">${escapeHtml(template.name)} v${template.version}</option>`).join("")}
            </select>
          </label>
          <button class="button-primary" type="button" data-action="create-project">${iconPlus()}新規Project作成</button>
        </form>
        <div class="project-list">
          ${state.projects.length ? state.projects.map(renderProjectCard).join("") : `<div class="empty">Projectはまだありません。</div>`}
        </div>
      </section>
      <div class="home-side">
        ${renderSettingsPanel()}
        ${renderTemplatePanel()}
      </div>
    </main>
  `;
}

function renderProjectCard(project: ProjectSummary) {
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

function renderSettingsPanel() {
  const settings = state.settings;
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
        <div class="button-row">
          <button class="button-secondary" type="button" data-action="save-settings">${iconSave()}保存</button>
          <button class="button-secondary" type="button" data-action="test-comfy">${iconPulse()}接続テスト</button>
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
  const selectedTemplateId = state.templates[0]?.id ?? "";
  const templateOptions = state.templates.length
    ? state.templates
      .map((template) => `<option value="${template.id}" ${selectedTemplateId === template.id ? "selected" : ""}>${escapeHtml(template.name)} v${template.version}</option>`)
      .join("")
    : `<option value="">登録済みテンプレートなし</option>`;
  return `
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">Workflow</p>
          <h2>WorkflowTemplate</h2>
        </div>
      </div>
      <div class="workflow-toolbar">
        <select id="workflow-template-select" class="workflow-select">${templateOptions}</select>
        <div class="button-row">
          <button class="button-secondary compact" type="button" data-action="export-workflow" data-template-source="workflow-template-select">${iconDownload()}raw export</button>
          <button class="button-secondary compact" type="button" data-action="export-template" data-template-source="workflow-template-select">${iconDownload()}template export</button>
          <button class="button-danger compact" type="button" data-action="delete-template" data-template-source="workflow-template-select" ${state.templates.length ? "" : "disabled"}>${iconTrash()}削除</button>
        </div>
      </div>
      <details class="workflow-dropdown">
        <summary><span>${iconPlus()}インポート / エクスポート</span>${iconChevron()}</summary>
        <form id="template-form" class="form-stack workflow-import-form">
          <label>JSONファイル
            <input data-file-target="workflowJson" type="file" accept=".json,application/json" />
          </label>
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
          <button class="button-primary" type="button" data-action="create-template">${iconPlus()}テンプレート登録</button>
        </form>
      </details>
      <div class="template-list">
        ${state.templates.map((template) => `<div><strong>${escapeHtml(template.name)} v${template.version}</strong><span>${escapeHtml(template.type)}</span></div>`).join("") || "登録済みテンプレートはありません。"}
      </div>
    </section>
  `;
}

function renderProjectDetail(detail: ProjectDetail) {
  const activeRound = getActiveRound(detail);
  const assets = getActiveRoundAssets().filter(assetPassesFilter);
  const selectedAssets = getActiveRoundAssets().filter((asset) => asset.status === "selected");
  const activeAsset = state.activeAssetId ? findAsset(state.activeAssetId) : null;
  const mode = activeRound?.generationMode ?? "txt2img";

  return `
    <div class="studio-shell">
      <div class="sidebar-overlay ${state.sidebarOpen ? "active" : ""}" data-action="toggle-sidebar"></div>
      <aside class="studio-sidebar ${state.sidebarOpen ? "open" : ""}">
        ${renderGenerationPanel(detail, activeAsset, selectedAssets.length)}
      </aside>
      <main class="studio-main">
        <div class="round-toolbar">
          <div>
            <h1>イテレーション ${activeRound ? `#${activeRound.roundIndex}` : ""}<span class="tag">${iconDot()}${escapeHtml(mode)}</span></h1>
            <p>${activeRound ? `${activeRound.assetCount ?? 0}枚生成・${selectedAssets.length}枚選択中・${escapeHtml(activeRound.status)}` : "新規Roundを生成してください。"}</p>
          </div>
          <div class="toolbar-actions">
            <button class="button-secondary compact" type="button" data-action="select-all">全選択</button>
            <button class="button-secondary compact" type="button" data-action="clear-selection">選択解除</button>
            <button class="button-secondary compact" type="button" data-action="invert-selection">選択反転</button>
            <span class="toolbar-divider"></span>
            <select id="grid-cols" class="compact-select" aria-label="グリッド列数">
              <option value="4" ${state.gridCols === 4 ? "selected" : ""}>4x4</option>
              <option value="3" ${state.gridCols === 3 ? "selected" : ""}>3列</option>
              <option value="2" ${state.gridCols === 2 ? "selected" : ""}>2列</option>
            </select>
            ${activeRound ? `<button class="button-secondary compact" type="button" data-action="collect-round" data-id="${activeRound.id}">${iconDownload()}生成結果取得</button>` : ""}
          </div>
        </div>
        <div class="gallery-scroll">
          <div class="image-grid cols-${state.gridCols}">
            ${assets.length ? assets.map(renderAssetTile).join("") : renderEmptyGallery(activeRound)}
          </div>
        </div>
        ${renderBottomActionBar(selectedAssets, activeRound)}
      </main>
    </div>
  `;
}

function renderEmptyGallery(activeRound: Round | null) {
  if (!activeRound) {
    return `<div class="empty wide">Projectを作成し、WorkflowTemplateを選んで初回生成してください。</div>`;
  }
  if (activeRound.status === "running" || activeRound.status === "pending") {
    return `<div class="empty wide">生成結果はまだありません。ComfyUIで生成完了後に「生成結果取得」を押すとグリッドを作成します。</div>`;
  }
  if (activeRound.status === "failed") {
    return `<div class="empty wide">このイテレーションは失敗しました。接続設定とworkflowを確認して再生成してください。</div>`;
  }
  return `<div class="empty wide">取り込み済みの画像はありません。「生成結果取得」を押すと、完了済み画像だけをグリッド表示します。</div>`;
}

function renderAssetTile(asset: Asset) {
  const selected = asset.status === "selected";
  const favorite = asset.status === "favorite";
  const rejected = asset.status === "rejected";
  return `
    <article class="image-card ${selected ? "selected" : ""} ${favorite ? "favorite" : ""} ${rejected ? "rejected" : ""}">
      <button class="asset-card-main" data-action="asset-detail" data-id="${asset.id}" type="button" aria-label="Asset #${asset.batchIndex + 1}">
        <img class="gen-image" src="${asset.thumbnailMediumUrl || asset.thumbnailUrl}" alt="" loading="lazy" />
      </button>
      <button class="select-badge" data-action="toggle-select" data-id="${asset.id}" type="button" aria-label="選択切替">
        ${iconCheck(selected)}
      </button>
      <button class="star-badge ${favorite ? "starred" : ""}" data-action="toggle-favorite" data-id="${asset.id}" type="button" aria-label="favorite切替">
        ${iconStar(favorite)}
      </button>
      <button class="zoom-btn" data-action="asset-detail" data-id="${asset.id}" type="button" aria-label="拡大">
        ${iconZoom()}
      </button>
      <span class="card-number">#${asset.batchIndex + 1}</span>
      <span class="seed-chip">seed ${asset.seed ?? "-"}</span>
    </article>
  `;
}

function renderBottomActionBar(selectedAssets: Asset[], activeRound: Round | null) {
  return `
    <div class="bottom-action-bar">
      <div class="bottom-left">
        ${state.busy ? `
          <div class="progress-wrap">
            <div class="progress-bar"><span style="width: 45%"></span></div>
            <span>生成中...</span>
          </div>
        ` : `
          <div class="selected-thumbs">
            ${selectedAssets.slice(0, 5).map((asset) => `<img src="${asset.thumbnailUrl}" alt="" />`).join("")}
            ${selectedAssets.length > 5 ? `<span>+${selectedAssets.length - 5}</span>` : ""}
          </div>
          <span class="selected-label">${selectedAssets.length}枚の画像を次のイテレーションに使用</span>
        `}
      </div>
      <div class="bottom-actions">
        <button class="button-danger" type="button" data-action="reset-session">${iconTrash()}リセット</button>
        <button class="button-secondary" type="button" data-action="export-selected">${iconDownload()}保存</button>
        <button class="button-primary" type="button" data-action="generate-round">${iconPlay()}${activeRound ? "再生成" : "初回生成"}</button>
        <button class="button-primary" type="button" data-action="img2img-next" ${selectedAssets.length === 0 ? "disabled" : ""}>
          ${iconLoopArrows()}選択してループ実行 <span class="button-count">${selectedAssets.length}</span>
        </button>
      </div>
    </div>
  `;
}

function renderGenerationPanel(detail: ProjectDetail, activeAsset: Asset | null, selectedCount: number) {
  const activeRound = getActiveRound(detail);
  const previous = activeAsset ?? getPreferredParentAsset();
  const request = activeRound?.request;
  const selectedTemplateId = request?.templateId ?? detail.project.defaultTemplateId ?? detail.templates[0]?.id ?? "";
  const selectedTemplate = detail.templates.find((template) => template.id === selectedTemplateId) ?? null;
  const selectedMode = request?.generationMode ?? defaultModeForTemplate(selectedTemplate);
  const defaults = templateGenerationDefaults(selectedTemplate);
  const canGenerate = selectedTemplateId !== "";
  const promptValue = request?.prompt ?? previous?.prompt ?? defaults.prompt ?? defaultPrompt;
  const negativePromptValue = request?.negativePrompt ?? previous?.negativePrompt ?? defaults.negativePrompt ?? defaultNegativePrompt;
  const batchSizeValue = request?.batchSize ?? defaults.batchSize ?? 16;
  const stepsValue = request?.steps ?? defaults.steps ?? 20;
  const cfgValue = request?.cfg ?? defaults.cfg ?? 7;
  const denoiseValue = request?.denoise ?? normalizeDenoiseForMode(defaults.denoise ?? defaultDenoiseForMode(selectedMode), selectedMode);
  const widthValue = request?.width ?? defaults.width ?? 512;
  const heightValue = request?.height ?? defaults.height ?? 768;
  const seedValue = request?.seed ?? previous?.seed ?? defaults.seed ?? -1;
  const samplerValue = request?.sampler ?? defaults.sampler ?? "euler";
  const schedulerValue = request?.scheduler ?? defaults.scheduler ?? "normal";
  const templateOptions = detail.templates.length
    ? detail.templates
      .map((template) => `<option value="${template.id}" ${selectedTemplateId === template.id ? "selected" : ""}>${escapeHtml(template.name)} v${template.version}</option>`)
      .join("")
    : `<option value="">未登録</option>`;

  return `
    <form id="generation-form" class="sidebar-form">
      <input type="hidden" name="parentAssetId" value="${previous?.id ?? ""}" />
      <section class="sidebar-section">
        <p class="section-kicker">ワークフロー</p>
        <select id="generation-template-select" class="workflow-select" name="templateId">${templateOptions}</select>
        <details class="workflow-dropdown compact-dropdown">
          <summary><span>${iconPlus()}Workflow操作</span>${iconChevron()}</summary>
          <div class="workflow-export-menu">
            <button class="button-secondary compact" type="button" data-action="export-workflow" data-template-source="generation-template-select">${iconDownload()}raw workflow export</button>
            <button class="button-secondary compact" type="button" data-action="export-template" data-template-source="generation-template-select">${iconDownload()}template export</button>
            <button class="button-danger compact" type="button" data-action="delete-template" data-template-source="generation-template-select" ${detail.templates.length ? "" : "disabled"}>${iconTrash()}workflow削除</button>
            <button class="button-secondary compact" type="button" data-action="home">${iconSettings()}Workflow管理を開く</button>
          </div>
        </details>
      </section>

      <section class="sidebar-section">
        <p class="section-kicker">プロンプト</p>
        <textarea class="input-field prompt-input" name="prompt" placeholder="プロンプトを入力...">${escapeHtml(promptValue)}</textarea>
      </section>

      <details class="sidebar-section collapsible" open>
        <summary><span class="section-kicker">ネガティブプロンプト</span>${iconChevron()}</summary>
        <textarea class="input-field" name="negativePrompt" rows="3" placeholder="ネガティブプロンプト...">${escapeHtml(negativePromptValue)}</textarea>
      </details>

      <section class="sidebar-section">
        <p class="section-kicker">生成パラメータ</p>
        ${renderRangeControl("batchSize", "バッチサイズ", batchSizeValue, 1, 32, 1, "batchValue")}
        ${renderRangeControl("steps", "ステップ数", stepsValue, 1, 50, 1, "stepsValue")}
        ${renderRangeControl("cfg", "CFGスケール", cfgValue, 1, 20, 0.5, "cfgValue")}
        ${renderRangeControl("denoise", "デノイズ強度", denoiseValue, 0, 1, 0.05, "denoiseValue")}

        <div class="resolution-row">
          <label>幅<input class="input-field center" name="width" type="number" step="64" value="${widthValue}" /></label>
          <button class="icon-button swap-button" data-action="swap-resolution" type="button" aria-label="幅と高さを入れ替え">${iconSwap()}</button>
          <label>高さ<input class="input-field center" name="height" type="number" step="64" value="${heightValue}" /></label>
        </div>

        <label>シード
          <div class="seed-row">
            <input class="input-field mono" name="seed" type="number" value="${seedValue}" />
            <button class="icon-button" data-action="random-seed" type="button" aria-label="ランダムseed">${iconShuffle()}</button>
          </div>
        </label>

        <label>seed mode
          <select class="workflow-select" name="seedMode">
            ${["random", "fixed", "increment", "reuse_parent_seed"].map((mode) => `<option value="${mode}" ${request?.seedMode === mode ? "selected" : ""}>${mode}</option>`).join("")}
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

      <section class="sidebar-section">
        <p class="section-kicker">ループ設定</p>
        <label class="toggle-row"><span>選択画像をimg2imgで再生成</span><input type="checkbox" checked /></label>
        <label class="toggle-row"><span>シードバリエーション使用</span><input type="checkbox" /></label>
        <label class="toggle-row"><span>プロンプト自動調整</span><input type="checkbox" /></label>
        ${renderRangeControl("maxLoop", "ループ上限回数", 10, 1, 20, 1, "maxLoopValue", false)}
      </section>

      <details class="sidebar-section collapsible">
        <summary><span class="section-kicker">モデル</span>${iconChevron()}</summary>
        ${renderModelReadout(defaults.model)}
      </details>

      <div class="sidebar-actions">
        <button class="button-primary" type="button" data-action="generate-round" ${canGenerate ? "" : "disabled"}>${iconPlay()}生成開始</button>
        <button class="button-secondary" type="button" data-action="img2img-next" ${selectedCount === 0 && !previous ? "disabled" : ""}>${iconLoopArrows()}次へ</button>
      </div>
    </form>
  `;
}

function renderRangeControl(
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

function renderOptions(options: string[], selectedValue: string) {
  const values = options.includes(selectedValue) ? options : [selectedValue, ...options];
  return values
    .map((value) => `<option value="${escapeAttr(value)}" ${selectedValue === value ? "selected" : ""}>${escapeHtml(value)}</option>`)
    .join("");
}

function renderModelReadout(model: TemplateModelDefaults) {
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

function updateDenoiseControlForMode(mode: string) {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  const control = form?.elements.namedItem("denoise") as HTMLInputElement | null;
  if (!control) {
    return;
  }

  const value = defaultDenoiseForMode(mode);
  control.value = String(value);
  if (control.dataset.valueTarget) {
    const valueTarget = document.getElementById(control.dataset.valueTarget);
    if (valueTarget) {
      valueTarget.textContent = formatNumber(value);
    }
  }
}

function defaultModeForTemplate(template: WorkflowTemplate | null) {
  if (template && ["txt2img", "img2img", "ipadapter", "controlnet"].includes(template.type)) {
    return template.type;
  }
  return "txt2img";
}

function defaultDenoiseForMode(mode: string) {
  if (requiresFullDenoise(mode)) {
    return 1;
  }
  return mode === "img2img" ? 0.35 : 0.45;
}

function normalizeDenoiseForMode(value: number, mode: string) {
  if (requiresFullDenoise(mode)) {
    return 1;
  }
  if (!Number.isFinite(value)) {
    return defaultDenoiseForMode(mode);
  }
  return Math.min(1, Math.max(0, value));
}

function requiresFullDenoise(mode: string) {
  return mode === "txt2img" || mode === "seed_reuse" || mode === "prompt_reuse";
}

function templateGenerationDefaults(template: WorkflowTemplate | null): TemplateGenerationDefaults {
  if (!template) {
    return { model: emptyModelDefaults() };
  }

  const workflow = template.workflowJson;
  const roleMap = template.roleMap;
  return {
    prompt: stringFromNodeInput(workflow, roleMap.positive_prompt_node, ["text", "prompt", "positive"]),
    negativePrompt: stringFromNodeInput(workflow, roleMap.negative_prompt_node, ["text", "prompt", "negative"]),
    seed: numberFromPath(workflow, roleMap.seed_input) ?? numberFromNodeInput(workflow, roleMap.ksampler_node, ["seed"]),
    batchSize: numberFromPath(workflow, roleMap.batch_size_input) ?? numberFromNodeInput(workflow, roleMap.empty_latent_node, ["batch_size"]),
    steps: numberFromPath(workflow, roleMap.steps_input) ?? numberFromNodeInput(workflow, roleMap.ksampler_node, ["steps"]),
    cfg: numberFromPath(workflow, roleMap.cfg_input) ?? numberFromNodeInput(workflow, roleMap.ksampler_node, ["cfg"]),
    sampler:
      stringFromPath(workflow, roleMap.sampler_input ?? roleMap.sampler_name_input) ??
      stringFromNodeInput(workflow, roleMap.ksampler_node, ["sampler_name", "sampler"]),
    scheduler:
      stringFromPath(workflow, roleMap.scheduler_input) ??
      stringFromNodeInput(workflow, roleMap.ksampler_node, ["scheduler"]),
    denoise: numberFromPath(workflow, roleMap.denoise_input) ?? numberFromNodeInput(workflow, roleMap.ksampler_node, ["denoise"]),
    width: numberFromPath(workflow, roleMap.width_input) ?? numberFromNodeInput(workflow, roleMap.empty_latent_node, ["width"]),
    height: numberFromPath(workflow, roleMap.height_input) ?? numberFromNodeInput(workflow, roleMap.empty_latent_node, ["height"]),
    model: modelDefaultsFromWorkflow(workflow)
  };
}

function emptyModelDefaults(): TemplateModelDefaults {
  return {
    textEncoders: [],
    loras: []
  };
}

function modelDefaultsFromWorkflow(workflow: Json): TemplateModelDefaults {
  const model = emptyModelDefaults();

  for (const rawNode of Object.values(workflow)) {
    if (!isJsonObject(rawNode) || !isJsonObject(rawNode.inputs)) {
      continue;
    }

    const classType = typeof rawNode.class_type === "string" ? rawNode.class_type : "";
    const inputs = rawNode.inputs;

    model.checkpoint ??= firstStringInput(inputs, ["ckpt_name", "checkpoint_name"]);
    model.diffusionModel ??= firstStringInput(inputs, ["unet_name", "diffusion_model_name", "model_name"]);

    if (classType.includes("CLIP") || hasAnyInput(inputs, ["clip_name", "clip_name1", "clip_name2", "clip_name3"])) {
      appendUnique(model.textEncoders, firstStringInput(inputs, ["clip_name"]));
      appendUnique(model.textEncoders, firstStringInput(inputs, ["clip_name1"]));
      appendUnique(model.textEncoders, firstStringInput(inputs, ["clip_name2"]));
      appendUnique(model.textEncoders, firstStringInput(inputs, ["clip_name3"]));
    }

    if (classType.includes("VAE") || "vae_name" in inputs) {
      model.vae ??= firstStringInput(inputs, ["vae_name"]);
    }

    appendUnique(model.loras, firstStringInput(inputs, ["lora_name"]));
  }

  return model;
}

function firstStringInput(inputs: Json, names: string[]) {
  for (const name of names) {
    const value = inputs[name];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function hasAnyInput(inputs: Json, names: string[]) {
  return names.some((name) => name in inputs);
}

function appendUnique(values: string[], value: string | undefined) {
  if (value && !values.includes(value)) {
    values.push(value);
  }
}

function stringFromPath(source: Json, rawPath: unknown) {
  const value = valueFromPath(source, rawPath);
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberFromPath(source: Json, rawPath: unknown) {
  const value = valueFromPath(source, rawPath);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringFromNodeInput(source: Json, rawNodeId: unknown, inputNames: string[]) {
  const value = valueFromNodeInput(source, rawNodeId, inputNames);
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberFromNodeInput(source: Json, rawNodeId: unknown, inputNames: string[]) {
  const value = valueFromNodeInput(source, rawNodeId, inputNames);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function valueFromNodeInput(source: Json, rawNodeId: unknown, inputNames: string[]) {
  if (typeof rawNodeId !== "string") {
    return undefined;
  }

  const node = source[rawNodeId];
  if (!isJsonObject(node) || !isJsonObject(node.inputs)) {
    return undefined;
  }

  for (const inputName of inputNames) {
    if (inputName in node.inputs) {
      return node.inputs[inputName];
    }
  }
  return undefined;
}

function valueFromPath(source: Json, rawPath: unknown) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return undefined;
  }

  let cursor: unknown = source;
  for (const part of rawPath.split(".").filter(Boolean)) {
    if (!isJsonObject(cursor) || !(part in cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function renderAssetModal() {
  if (!state.activeAssetId) {
    return "";
  }
  const asset = findAsset(state.activeAssetId);
  if (!asset) {
    return "";
  }
  const info = `Seed: ${asset.seed ?? "-"} / Steps: ${asset.steps ?? "-"} / CFG: ${asset.cfg ?? "-"} / Sampler: ${asset.sampler}`;
  return `
    <div class="preview-modal" role="dialog" aria-modal="true">
      <div class="preview-content">
        <img id="previewImage" src="${asset.imageUrl}" alt="" />
        <button class="preview-close" type="button" data-action="close-detail" aria-label="閉じる">${iconClose()}</button>
        <div class="preview-footer">
          <div class="preview-info">
            <p>${escapeHtml(info)}</p>
            <small>${escapeHtml(asset.prompt)}</small>
          </div>
          <div class="preview-actions">
            <button class="button-secondary" type="button" data-action="toggle-select" data-id="${asset.id}">選択切替</button>
            <button class="button-primary" type="button" data-action="generate-from-preview" data-id="${asset.id}" data-mode="img2img">この画像で再生成</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function getActiveRound(detail: ProjectDetail) {
  return detail.rounds.find((round) => round.id === state.activeRoundId) ?? detail.rounds[0] ?? null;
}

function getActiveRoundAssets() {
  if (!state.detail) {
    return [];
  }
  const activeRound = getActiveRound(state.detail);
  if (!activeRound) {
    return [];
  }
  return state.detail.assets.filter((asset) => asset.roundId === activeRound.id);
}

function sortRoundsAsc(rounds: Round[]) {
  return [...rounds].sort((a, b) => a.roundIndex - b.roundIndex);
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
  return getActiveRoundAssets().find((asset) => asset.status === "selected") ?? null;
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
  setFormValue(form, "denoise", String(defaultDenoiseForMode(mode)));
  updateDenoiseControlForMode(mode);
}

function setFormValue(form: HTMLFormElement, name: string, value: string) {
  const control = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (control) {
    control.value = value;
  }
}

function isJsonObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickJsonObject(source: Json, key: string) {
  const value = source[key];
  return isJsonObject(value) ? value : null;
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

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatDate(value: string) {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

function formatSliderValue(input: HTMLInputElement) {
  const step = Number(input.step || 1);
  const value = Number(input.value);
  return step < 1 ? value.toFixed(2).replace(/0$/, "") : String(value);
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

function iconLoop() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="7" r="1.8"></circle><circle cx="8" cy="14" r="1.8"></circle><circle cx="16" cy="14" r="1.8"></circle></svg>`;
}

function iconMenu() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>`;
}

function iconSettings() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"></path><path d="M19 13.5v-3l-2.1-.4a7.3 7.3 0 0 0-.8-1.8l1.2-1.8-2.1-2.1-1.8 1.2a7.3 7.3 0 0 0-1.8-.8L11.2 2h-3l-.4 2.1a7.3 7.3 0 0 0-1.8.8L4.2 3.7 2.1 5.8l1.2 1.8a7.3 7.3 0 0 0-.8 1.8L.4 9.8v3l2.1.4c.2.6.5 1.2.8 1.8l-1.2 1.8 2.1 2.1 1.8-1.2c.6.3 1.2.6 1.8.8l.4 2.1h3l.4-2.1c.6-.2 1.2-.5 1.8-.8l1.8 1.2 2.1-2.1-1.2-1.8c.3-.6.6-1.2.8-1.8l2.1-.4Z"></path></svg>`;
}

function iconCheck(filled = false) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="${filled ? "filled" : ""}"><path d="m5 12 4 4L19 6"></path></svg>`;
}

function iconStar(filled = false) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="${filled ? "filled" : ""}"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"></path></svg>`;
}

function iconZoom() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4.2-4.2"></path></svg>`;
}

function iconClose() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
}

function iconPlus() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
}

function iconSave() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"></path><path d="M7 21v-8h10v8M7 3v5h8"></path></svg>`;
}

function iconPulse() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-7 4 14 2-7h6"></path></svg>`;
}

function iconDownload() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"></path></svg>`;
}

function iconPlay() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7Z"></path></svg>`;
}

function iconLoopArrows() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 1 4 4-4 4"></path><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><path d="m7 23-4-4 4-4"></path><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`;
}

function iconTrash() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5"></path></svg>`;
}

function iconShuffle() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"></path></svg>`;
}

function iconSwap() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16M7 4 3 8M7 4l4 4M17 20V4M17 20l4-4M17 20l-4-4"></path></svg>`;
}

function iconChevron() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>`;
}

function iconDot() {
  return `<svg viewBox="0 0 16 16" aria-hidden="true" class="tag-dot"><circle cx="8" cy="8" r="6"></circle></svg>`;
}
