import { defaultDenoiseForMode, normalizeDenoiseForMode } from "../shared/generationMode";
import type { ComfySettings } from "../shared/types";
import type { Asset, LlmSettingsView, ProjectDetail, ProjectRow, ProjectSummary, Round } from "../shared/apiTypes";
import { api } from "./api";
import type { WorkflowTemplate } from "./workflowTypes";
import { pushToast, requestRender, state } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";
import { draftStorageKey, resetProjectDrafts, restoreOrResetProjectDrafts } from "./draftStore";
import { readForm } from "./formUtils";
import { applyAssetDimensionsToDraft, generationDraftFromForm } from "./generationDraft";
import { refreshProject, resumeAutoCollectForActiveRounds } from "./generationController";
import { beginNavigation, isCurrentNavigation, resetProjectWorkspaceState, stashActivePageFormDrafts } from "./workspaceSession";
import { refreshComfyStatus, refreshLlmStatus } from "./settingsController";
import { refreshModelCheckForTemplate } from "./modelCheckController";
import { refreshLoraChoices } from "./styleLoraController";
import { refreshRecentReferenceImages } from "./referenceController";
import { clearBookSession, openBook } from "./bookController";
import { confirmDialog } from "./confirmDialogController";
import { downloadBlob, filenameFromContentDisposition, responseErrorMessage } from "./downloadUtils";

export async function loadHome() {
  // フォーム編集の退避は state を触る前に(以前は rememberActiveRoundDraft が漏れており、
  // ページ内のフォーム編集が Home へ戻ると失われていた)。
  stashActivePageFormDrafts();
  state.currentProjectId = null;
  resetProjectWorkspaceState();
  resetProjectDrafts();
  clearBookSession();
  state.settings = await api<ComfySettings>("/api/settings/comfy");
  state.llmSettings = await api<LlmSettingsView>("/api/settings/llm");
  state.templates = (await api<{ templates: WorkflowTemplate[] }>("/api/templates")).templates;
  state.projects = (await api<{ projects: ProjectSummary[] }>("/api/projects")).projects;
  requestRender();
  void refreshComfyStatus();
  void refreshLlmStatus();
}

async function openProject(projectId: string) {
  const navigation = beginNavigation();
  stashActivePageFormDrafts();
  const detail = await api<ProjectDetail>(`/api/projects/${projectId}`);
  // 取得成功後に確定する(失敗時に中途半端な state を残さない)+遅延応答の旧遷移を捨てる。
  if (!isCurrentNavigation(navigation)) {
    return;
  }
  state.currentProjectId = projectId;
  // single プロジェクトは book 状態を持たない(book から戻ってきた場合の取り残しを防ぐ)。
  state.book = null;
  state.activePageId = null;
  resetProjectWorkspaceState();
  state.detail = detail;
  state.templates = detail.templates;
  state.activeRoundId = detail.rounds[0]?.id ?? null;
  restoreOrResetProjectDrafts(projectId);
  requestRender();
  resumeAutoCollectForActiveRounds();
  // 選択中workflow familyのidentity機能可用性を先取りする。
  refreshModelCheckForTemplate();
  void refreshLoraChoices();
  void refreshRecentReferenceImages();
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
    height: Number(draft.height || 1024),
    pageId: state.activePageId
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
const DEFAULT_CANVAS_WIDTH = 1024;
const DEFAULT_CANVAS_HEIGHT = 1446;
const CANVAS_ASPECT_PRESETS = new Map<string, [number, number]>([
  ["182:257", [182, 257]],
  ["364:257", [364, 257]],
  ["1:1", [1, 1]],
  ["16:9", [16, 9]],
  ["9:16", [9, 16]]
]);

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
  const mode = state.createProjectMode;
  const canvasWidth = projectCanvasDimension(form.canvasWidth, DEFAULT_CANVAS_WIDTH);
  const canvasHeight = projectCanvasDimension(form.canvasHeight, DEFAULT_CANVAS_HEIGHT);
  const result = await api<{ project: ProjectRow }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name,
      description: form.description,
      defaultTemplateId: form.defaultTemplateId || null,
      mode,
      canvasWidth,
      canvasHeight
    })
  });
  // NOTE: POST /api/projects は round_count / asset_count を含まない ProjectRow を
  // 返す (新規Projectは常に0件のため)。一覧表示用に roundCount / assetCount を
  // 0 で補って ProjectSummary 形にする。book は作成時に初期ページ1枚を持つ。
  state.projects = [
    { ...result.project, roundCount: 0, assetCount: 0, pageCount: result.project.mode === "book" ? 1 : 0 },
    ...state.projects
  ];
  if (result.project.mode === "book") {
    await openBook(result.project.id);
  } else {
    await openProject(result.project.id);
  }
}

function projectCanvasDimension(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(16384, Math.max(64, Math.trunc(parsed)));
}

function applyProjectAspectRatio(form: HTMLFormElement) {
  const select = form.elements.namedItem("canvasAspectRatio") as HTMLSelectElement | null;
  const widthInput = form.elements.namedItem("canvasWidth") as HTMLInputElement | null;
  const heightInput = form.elements.namedItem("canvasHeight") as HTMLInputElement | null;
  if (!select || !widthInput || !heightInput || select.value === "custom") {
    return;
  }
  const ratio = CANVAS_ASPECT_PRESETS.get(select.value);
  if (!ratio) {
    return;
  }
  const width = projectCanvasDimension(widthInput.value, DEFAULT_CANVAS_WIDTH);
  widthInput.value = String(width);
  heightInput.value = String(Math.max(64, Math.min(16384, Math.round(width * ratio[1] / ratio[0]))));
}

function bindProjectCanvasEvents(app: HTMLElement) {
  app.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !target.dataset.projectAspectRatio) {
      return;
    }
    const form = target.closest<HTMLFormElement>("#project-form");
    if (form) {
      applyProjectAspectRatio(form);
    }
  });

  app.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const form = target.closest<HTMLFormElement>("#project-form");
    if (!form) {
      return;
    }
    if (target.dataset.projectCanvasWidth) {
      applyProjectAspectRatio(form);
      return;
    }
    if (target.dataset.projectCanvasHeight) {
      const select = form.elements.namedItem("canvasAspectRatio") as HTMLSelectElement | null;
      if (select) {
        select.value = "custom";
      }
    }
  });
}

/** 一覧カードの「開く」。Book はページグリッドへ、single は従来の1枚生成 UI へ。 */
async function openProjectByMode(projectId: string) {
  const summary = state.projects.find((project) => project.id === projectId);
  if (summary?.mode === "book") {
    await openBook(projectId);
    return;
  }
  await openProject(projectId);
}

/**
 * 大きな Book の一覧取得中もクリックが受理されたことを即座に見せる。
 * Home の再描画を待たず DOM だけを一時更新し、失敗時は元の状態へ戻す。
 */
function markProjectOpening(target: HTMLElement): (() => void) | null {
  const list = target.closest<HTMLElement>(".project-list");
  const card = target.closest<HTMLElement>(".project-card");
  if (!list || !card) {
    return () => {};
  }
  if (list.dataset.openingProject) {
    return null;
  }

  list.dataset.openingProject = target.dataset.id ?? "true";
  list.setAttribute("aria-busy", "true");
  card.classList.add("is-opening");

  const controls = Array.from(list.querySelectorAll<HTMLButtonElement>("button"));
  const disabledStates = controls.map((control) => control.disabled);
  for (const control of controls) {
    control.disabled = true;
  }

  const openButton = card.querySelector<HTMLButtonElement>('.project-actions [data-action="open-project"]');
  const originalHtml = openButton?.innerHTML ?? "";
  const originalAriaLabel = openButton?.getAttribute("aria-label") ?? null;
  if (openButton) {
    openButton.innerHTML = '<span class="project-opening-spinner" aria-hidden="true"></span><span>読み込み中…</span>';
    openButton.setAttribute("aria-label", "Projectを読み込み中");
  }

  return () => {
    delete list.dataset.openingProject;
    list.removeAttribute("aria-busy");
    card.classList.remove("is-opening");
    controls.forEach((control, index) => {
      control.disabled = disabledStates[index];
    });
    if (openButton) {
      openButton.innerHTML = originalHtml;
      if (originalAriaLabel === null) {
        openButton.removeAttribute("aria-label");
      } else {
        openButton.setAttribute("aria-label", originalAriaLabel);
      }
    }
  };
}

async function openProjectFromCard(projectId: string, target: HTMLElement) {
  const restoreOpeningState = markProjectOpening(target);
  if (!restoreOpeningState) {
    return;
  }
  try {
    await openProjectByMode(projectId);
  } finally {
    restoreOpeningState();
  }
}

async function deleteProject(projectId: string) {
  const project = state.projects.find((item) => item.id === projectId) ?? state.detail?.project ?? null;
  const projectName = project?.name ?? "このProject";
  const confirmed = await confirmDialog({
    title: "Projectを削除",
    message: `Project "${projectName}" を削除します。生成画像とイテレーションも削除しますか？`,
    confirmLabel: "削除",
    tone: "danger"
  });
  if (!confirmed) {
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

/**
 * Docs/Feature-ProjectImportExport.md §6: プロジェクトカードの「エクスポート」。
 * `GET /api/projects/:id/export` の .guruzip バイト列を `<a download>` 経由で保存する
 * (imageExportController.ts と同じ fetch → blob → downloadBlob の導線)。
 */
async function exportProject(projectId: string) {
  const project = state.projects.find((item) => item.id === projectId) ?? state.detail?.project ?? null;
  try {
    const response = await fetch(`/api/projects/${projectId}/export`);
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response));
    }
    const blob = await response.blob();
    const fallbackName = `${project?.name || "guruguru-project"}.guruzip`;
    const filename = filenameFromContentDisposition(response.headers.get("content-disposition")) ?? fallbackName;
    downloadBlob(blob, filename);
    pushToast("Projectをエクスポートしました。", "info");
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  }
}

/**
 * Docs/Feature-ProjectImportExport.md §6: 一覧ヘッダの「インポート」。選択された .guruzip を
 * `POST /api/projects/import` へ生バイトのまま送る(base64 化しない。multipart でもない)。
 * 成功した新規Projectを一覧の先頭へ差し込み、warnings があればそれぞれトーストで表示する。
 */
export async function importProjectFile(input: HTMLInputElement) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) {
    return;
  }
  state.busy = true;
  state.message = "Projectをインポートしています。";
  requestRender();
  try {
    const response = await fetch("/api/projects/import", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: file
    });
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response));
    }
    const result = (await response.json()) as { project: ProjectRow; warnings?: string[] };
    // 手組みのカウント(0/1)はリロードまで虚偽表示になるため、一覧を取り直して実カウントを反映する。
    try {
      state.projects = (await api<{ projects: ProjectSummary[] }>("/api/projects")).projects;
    } catch {
      state.projects = [
        { ...result.project, roundCount: 0, assetCount: 0, pageCount: result.project.mode === "book" ? 1 : 0 },
        ...state.projects
      ];
    }
    for (const warning of result.warnings ?? []) {
      pushToast(warning, "error");
    }
    pushToast("Projectをインポートしました。", "info");
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    state.busy = false;
    state.message = "";
    requestRender();
  }
}

registerActions({
  "home": () => loadHome(),
  "create-project": () => createProject(),
  "open-project": (id, target) => openProjectFromCard(id, target),
  "delete-project": (id) => deleteProject(id),
  "export-project": (id) => exportProject(id),
  "set-create-mode": (_id, target) => {
    state.createProjectMode = target.dataset.mode === "book" ? "book" : "single";
    requestRender();
  }
});

registerEventBinder(bindProjectCanvasEvents);
