import { defaultDenoiseForMode, normalizeDenoiseForMode } from "../shared/generationMode";
import type { ComfySettings, LlmSettings } from "../shared/types";
import type { Asset, ProjectDetail, ProjectRow, ProjectSummary, Round } from "../shared/apiTypes";
import { api } from "./api";
import type { WorkflowTemplate } from "./workflowTypes";
import {
  buildTemplateExportPayload,
  defaultWorkflowImportDraft,
  parseWorkflowFileContent,
  workflowExportFilename
} from "./workflowImport";
import { renderWorkflowDiagramCanvases, renderWorkflowImportPreview } from "./workflowUi";
import { requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { draftStorageKey, resetProjectDrafts, restoreOrResetProjectDrafts } from "./draftStore";
import { clampNumber } from "./clientUtils";
import { formatCssNumber } from "./format";
import { formValue, readForm, setFormValue } from "./formUtils";
import { applyAssetDimensionsToDraft, generationDraftFromForm } from "./generationDraft";
import { refreshProject, resumeAutoCollectForActiveRounds } from "./generationController";
import { refreshComfyStatus, refreshLlmStatus } from "./settingsController";

export async function loadHome() {
  state.currentProjectId = null;
  state.detail = null;
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.sidebarOpen = false;
  resetProjectDrafts();
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.deletePreviewRoundId = null;
  state.iterationScroll = null;
  state.workflowImportModalOpen = false;
  state.activeWorkflowDiagramTemplateId = null;
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
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.deletePreviewRoundId = null;
  state.iterationScroll = null;
  state.workflowImportModalOpen = false;
  state.activeWorkflowDiagramTemplateId = null;
  requestRender();
  resumeAutoCollectForActiveRounds();
}

function openWorkflowImportModal() {
  state.workflowImportModalOpen = true;
  state.activeWorkflowDiagramTemplateId = null;
  requestRender();
}

function closeWorkflowImportModal() {
  state.workflowImportModalOpen = false;
  requestRender();
}

function openWorkflowDiagram(target: HTMLElement) {
  const template = findTemplateFromActionTarget(target);
  if (!template) {
    state.message = "diagramを表示するWorkflowTemplateがありません。";
    requestRender();
    return;
  }
  state.activeWorkflowDiagramTemplateId = template.id;
  state.workflowImportModalOpen = false;
  requestRender();
}

function closeWorkflowDiagram() {
  state.activeWorkflowDiagramTemplateId = null;
  requestRender();
}

export function closeWorkflowModals() {
  state.workflowImportModalOpen = false;
  state.activeWorkflowDiagramTemplateId = null;
  requestRender();
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
  state.workflowImportModalOpen = false;
  state.workflowImportDraft = defaultWorkflowImportDraft();
  state.message = `WorkflowTemplate "${result.template.name}" v${result.template.version} を登録しました。`;
  requestRender();
}

export async function loadWorkflowFile(input: HTMLInputElement) {
  const file = input.files?.[0];
  const form = input.closest<HTMLFormElement>("form");
  if (!file || !form) {
    return;
  }

  const text = await file.text();
  const parsed = parseWorkflowFileContent(text);
  if (!parsed.ok) {
    state.message = parsed.error;
    requestRender();
    return;
  }

  const { workflowJson, roleMap, name, description, type } = parsed.result;
  setFormValue(form, "workflowJson", JSON.stringify(workflowJson, null, 2));
  if (Object.keys(roleMap).length > 0) {
    setFormValue(form, "roleMap", JSON.stringify(roleMap, null, 2));
  }
  state.message = parsed.message;
  if (name !== undefined) {
    setFormValue(form, "name", name);
  } else if (!((form.elements.namedItem("name") as HTMLInputElement | null)?.value)) {
    setFormValue(form, "name", file.name.replace(/\.json$/i, ""));
  }
  if (description !== undefined) {
    setFormValue(form, "description", description);
  }
  if (type !== undefined) {
    setFormValue(form, "type", type);
  }
  captureWorkflowImportDraft(form);
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

function exportWorkflowTemplate(target: HTMLElement, kind: "template" | "workflow") {
  const template = findTemplateFromActionTarget(target);
  if (!template) {
    state.message = "エクスポートするWorkflowTemplateがありません。";
    requestRender();
    return;
  }

  if (kind === "workflow") {
    downloadJson(workflowExportFilename(template.name, "workflow"), template.workflowJson);
    state.message = `WorkflowTemplate "${template.name}" のraw workflow JSONを書き出しました。`;
  } else {
    downloadJson(workflowExportFilename(template.name, "template"), buildTemplateExportPayload(template));
    state.message = `WorkflowTemplate "${template.name}" をGURUGURU template形式で書き出しました。`;
  }
  requestRender();
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
  requestRender();
}

async function deleteWorkflowTemplate(target: HTMLElement) {
  const template = findTemplateFromActionTarget(target);
  if (!template) {
    state.message = "削除するWorkflowTemplateがありません。";
    requestRender();
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
  requestRender();
}

export function captureWorkflowImportDraftFromElement(target: Element) {
  const form = target.closest<HTMLFormElement>("#template-form");
  if (form) {
    captureWorkflowImportDraft(form);
  }
}

function captureWorkflowImportDraft(form: HTMLFormElement) {
  state.workflowImportDraft = {
    name: formValue(form, "name"),
    description: formValue(form, "description"),
    type: formValue(form, "type") || "txt2img",
    workflowJson: formValue(form, "workflowJson") || "{}",
    roleMap: formValue(form, "roleMap") || "{}"
  };
}

export function refreshWorkflowImportPreview() {
  const preview = document.querySelector<HTMLElement>(".workflow-import-preview-slot");
  if (!preview) {
    return;
  }
  preview.innerHTML = renderWorkflowImportPreview(state.workflowImportDraft);
  void renderWorkflowDiagramCanvases();
}

interface ActiveWorkflowDiagramPan {
  pointerId: number;
  element: HTMLElement;
  startClient: { x: number; y: number };
  originPan: { x: number; y: number };
}

let activeWorkflowDiagramPan: ActiveWorkflowDiagramPan | null = null;

function beginWorkflowDiagramPan(event: PointerEvent, canvas: HTMLElement) {
  const panX = parseFloat(canvas.dataset.wfPanX ?? "0");
  const panY = parseFloat(canvas.dataset.wfPanY ?? "0");
  activeWorkflowDiagramPan = {
    pointerId: event.pointerId,
    element: canvas,
    startClient: { x: event.clientX, y: event.clientY },
    originPan: { x: panX, y: panY }
  };
  canvas.classList.add("panning");
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture may fail
  }
}

function continueWorkflowDiagramPan(event: PointerEvent) {
  if (!activeWorkflowDiagramPan) {
    return;
  }
  const dx = event.clientX - activeWorkflowDiagramPan.startClient.x;
  const dy = event.clientY - activeWorkflowDiagramPan.startClient.y;
  applyWorkflowDiagramTransform(
    activeWorkflowDiagramPan.element,
    undefined,
    activeWorkflowDiagramPan.originPan.x + dx,
    activeWorkflowDiagramPan.originPan.y + dy
  );
}

function finishWorkflowDiagramPan() {
  if (!activeWorkflowDiagramPan) {
    return;
  }
  const canvas = activeWorkflowDiagramPan.element;
  canvas.classList.remove("panning");
  try {
    canvas.releasePointerCapture(activeWorkflowDiagramPan.pointerId);
  } catch {
    // Capture may already be released
  }
  // Persist final pan values
  canvas.dataset.wfPanX = formatCssNumber(
    parseFloat(canvas.style.getPropertyValue("--wf-pan-x")) || 0
  );
  canvas.dataset.wfPanY = formatCssNumber(
    parseFloat(canvas.style.getPropertyValue("--wf-pan-y")) || 0
  );
  activeWorkflowDiagramPan = null;
}

function handleWorkflowDiagramWheelZoom(event: WheelEvent, canvas: HTMLElement) {
  const zoom = parseFloat(canvas.dataset.wfZoom ?? "1");
  const direction = event.deltaY < 0 ? 1 : -1;
  const nextZoom = clampNumber(zoom + direction * 0.12, 0.25, 4, 1);
  canvas.dataset.wfZoom = String(nextZoom);
  applyWorkflowDiagramTransform(canvas, nextZoom);
}

function applyWorkflowDiagramTransform(canvas: HTMLElement, zoom?: number, panX?: number, panY?: number) {
  const z = zoom ?? parseFloat(canvas.dataset.wfZoom ?? "1");
  const px = panX ?? parseFloat(canvas.dataset.wfPanX ?? "0");
  const py = panY ?? parseFloat(canvas.dataset.wfPanY ?? "0");
  canvas.style.setProperty("--wf-zoom", String(z));
  canvas.style.setProperty("--wf-pan-x", `${formatCssNumber(px)}px`);
  canvas.style.setProperty("--wf-pan-y", `${formatCssNumber(py)}px`);
}

/** main.ts の pointerdown ハンドラから同じ優先順位で呼ばれる。workflow diagram のパン開始のみ扱う。 */
export function handleWorkflowDiagramPointerDown(event: PointerEvent): boolean {
  const target = event.target as HTMLElement;
  const wfCanvas = target.closest<HTMLElement>(".workflow-diagram-canvas");
  if (wfCanvas && (event.button === 0 || event.button === 1)) {
    event.preventDefault();
    beginWorkflowDiagramPan(event, wfCanvas);
    return true;
  }
  return false;
}

/**
 * pan 中は pointerId が一致しなくても後続ハンドラをブロックする（従来の
 * `if (activeWorkflowDiagramPan) { ...; return; }` と同じ挙動）。
 */
export function handleWorkflowDiagramPointerMove(event: PointerEvent): boolean {
  if (!activeWorkflowDiagramPan) {
    return false;
  }
  if (event.pointerId !== activeWorkflowDiagramPan.pointerId) {
    return true;
  }
  event.preventDefault();
  continueWorkflowDiagramPan(event);
  return true;
}

export function handleWorkflowDiagramPointerUp(event: PointerEvent): boolean {
  if (activeWorkflowDiagramPan && event.pointerId === activeWorkflowDiagramPan.pointerId) {
    event.preventDefault();
    finishWorkflowDiagramPan();
    return true;
  }
  return false;
}

export function handleWorkflowDiagramPointerCancel(event: PointerEvent): boolean {
  if (activeWorkflowDiagramPan && event.pointerId === activeWorkflowDiagramPan.pointerId) {
    activeWorkflowDiagramPan = null;
    return true;
  }
  return false;
}

export function handleWorkflowDiagramWheel(event: WheelEvent): boolean {
  const target = event.target as HTMLElement;
  const wfCanvas = target.closest<HTMLElement>(".workflow-diagram-canvas");
  if (wfCanvas) {
    event.preventDefault();
    handleWorkflowDiagramWheelZoom(event, wfCanvas);
    return true;
  }
  return false;
}

registerActions({
  "home": () => loadHome(),
  "open-template-import": () => openWorkflowImportModal(),
  "close-template-import": () => closeWorkflowImportModal(),
  "create-template": () => createTemplate(),
  "open-template-diagram": (_id, target) => openWorkflowDiagram(target),
  "close-template-diagram": () => closeWorkflowDiagram(),
  "export-template": (_id, target) => exportWorkflowTemplate(target, "template"),
  "export-workflow": (_id, target) => exportWorkflowTemplate(target, "workflow"),
  "delete-template": (_id, target) => deleteWorkflowTemplate(target),
  "create-project": () => createProject(),
  "open-project": (id) => openProject(id),
  "delete-project": (id) => deleteProject(id)
});
