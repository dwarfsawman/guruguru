import { defaultDenoiseForMode, normalizeDenoiseForMode } from "../shared/generationMode";
import type { ComfySettings, LlmSettings } from "../shared/types";
import type { Asset, ProjectDetail, ProjectRow, ProjectSummary, Round } from "../shared/apiTypes";
import { api } from "./api";
import type { WorkflowTemplate } from "./workflowTypes";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { draftStorageKey, resetProjectDrafts, restoreOrResetProjectDrafts } from "./draftStore";
import { clearPasteCaches } from "./pasteObjectController";
import { readForm } from "./formUtils";
import { applyAssetDimensionsToDraft, generationDraftFromForm } from "./generationDraft";
import { refreshProject, resetRoundDeletionHistory, resumeAutoCollectForActiveRounds } from "./generationController";
import { refreshComfyStatus, refreshLlmStatus } from "./settingsController";

export async function loadHome() {
  state.currentProjectId = null;
  state.detail = null;
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.sidebarOpen = false;
  resetProjectDrafts();
  clearPasteCaches();
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.deletePreviewRoundId = null;
  resetRoundDeletionHistory();
  state.roundProgress = {};
  state.iterationScrollReset = true;
  state.settings = await api<ComfySettings>("/api/settings/comfy");
  state.llmSettings = await api<LlmSettings>("/api/settings/llm");
  state.templates = (await api<{ templates: WorkflowTemplate[] }>("/api/templates")).templates;
  state.projects = (await api<{ projects: ProjectSummary[] }>("/api/projects")).projects;
  requestRender();
  void refreshComfyStatus();
  void refreshLlmStatus();
}

async function openProject(projectId: string) {
  state.currentProjectId = projectId;
  state.detail = await api<ProjectDetail>(`/api/projects/${projectId}`);
  state.templates = state.detail.templates;
  state.activeRoundId = state.detail.rounds[0]?.id ?? null;
  state.activeAssetId = null;
  state.sidebarOpen = false;
  restoreOrResetProjectDrafts(projectId);
  clearPasteCaches();
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.deletePreviewRoundId = null;
  resetRoundDeletionHistory();
  state.roundProgress = {};
  state.iterationScrollReset = true;
  requestRender();
  resumeAutoCollectForActiveRounds();
}

export function closeWorkflowModals() {
  state.modelInstallFamily = null;
  requestRender();
}

export async function uploadSourceAsset(input: HTMLInputElement) {
  const file = input.files?.[0];
  input.value = "";
  if (!file || !state.currentProjectId) {
    return;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    state.message = "source asset は PNG / JPEG / WebP 画像を選択してください。";
    requestRender();
    return;
  }

  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (!form) {
    throw new Error("生成フォームが見つかりません。Projectを開いてから画像をアップロードしてください。");
  }

  const draft = generationDraftFromForm(form);
  const templateId = draft.img2imgTemplateId || draft.templateId || "";
  if (!templateId) {
    throw new Error("WorkflowTemplateを選択してから画像をアップロードしてください。");
  }

  const denoise = normalizeDenoiseForMode(
    Number(draft.denoise || defaultDenoiseForMode("img2img")),
    "img2img"
  );
  const dataUrl = await fileToDataUrl(file);
  const requestBody = {
    filename: file.name,
    mimeType: file.type,
    dataUrl,
    templateId,
    prompt: draft.prompt ?? "",
    negativePrompt: draft.negativePrompt ?? "",
    seed: draft.seed ? Number(draft.seed) : null,
    seedMode: draft.seedMode ?? "random",
    batchSize: Number(draft.batchSize || 1),
    steps: Number(draft.steps || 20),
    cfg: Number(draft.cfg || 7),
    sampler: draft.sampler || "euler",
    scheduler: draft.scheduler || "normal",
    denoise,
    width: Number(draft.width || 1024),
    height: Number(draft.height || 1024)
  };

  state.busy = true;
  state.message = "source asset をアップロードしています。";
  requestRender();

  const response = await api<{ round: Round; asset: Asset }>(`/api/projects/${state.currentProjectId}/source-assets`, {
    method: "POST",
    body: JSON.stringify(requestBody)
  });

  state.busy = false;
  state.generationDraft = {
    ...draft,
    templateId: draft.templateId || templateId,
    img2imgTemplateId: templateId,
    denoise: String(denoise),
    generationMode: "img2img"
  };
  applyAssetDimensionsToDraft(response.asset);
  state.message = "画像を source asset として登録し、親画像に設定しました。";
  await refreshProject(response.round.id, null);
  requestRender();
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("画像ファイルを読み込めませんでした。")));
    reader.readAsDataURL(file);
  });
}

const DEFAULT_PROJECT_NAME = "New Project";

function nextDefaultProjectName(existingNames: string[]) {
  let maxIndex = 0;
  for (const name of existingNames) {
    if (name === DEFAULT_PROJECT_NAME) {
      maxIndex = Math.max(maxIndex, 1);
      continue;
    }
    const match = /^New Project\((\d+)\)$/.exec(name);
    if (match) {
      maxIndex = Math.max(maxIndex, Number(match[1]));
    }
  }
  return maxIndex === 0 ? DEFAULT_PROJECT_NAME : `${DEFAULT_PROJECT_NAME}(${maxIndex + 1})`;
}

async function createProject() {
  const form = readForm("project-form");
  const name = form.name.trim() || nextDefaultProjectName(state.projects.map((project) => project.name));
  const result = await api<{ project: ProjectRow }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name,
      description: form.description,
      defaultTemplateId: form.defaultTemplateId || null
    })
  });
  // NOTE: POST /api/projects は round_count / asset_count を含まない ProjectRow を
  // 返す (新規Projectは常に0件のため)。一覧表示用に roundCount / assetCount を
  // 0 で補って ProjectSummary 形にする。
  state.projects = [{ ...result.project, roundCount: 0, assetCount: 0 }, ...state.projects];
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
  try {
    window.localStorage.removeItem(draftStorageKey(projectId));
  } catch {
    // localStorage が使えない環境では無視する。
  }

  if (state.currentProjectId === projectId) {
    pushToast(
      result.storageError
        ? `Projectを削除しました。保存ディレクトリの削除に失敗しました: ${result.storageError}`
        : "Projectを削除しました。",
      result.storageError ? "error" : "info"
    );
    await loadHome();
    return;
  }

  state.projects = state.projects.filter((item) => item.id !== projectId);
  pushToast(
    result.storageError
      ? `Projectを削除しました。保存ディレクトリの削除に失敗しました: ${result.storageError}`
      : "Projectを削除しました。",
    result.storageError ? "error" : "info"
  );
  requestRender();
}

registerActions({
  "home": () => loadHome(),
  "create-project": () => createProject(),
  "open-project": (id) => openProject(id),
  "delete-project": (id) => deleteProject(id)
});
