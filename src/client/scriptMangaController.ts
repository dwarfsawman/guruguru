import type {
  PrepareScriptMangaRunRequest,
  ScriptMangaRunView,
  ScriptMangaUiSettings,
  VlmAuditServiceStatus
} from "../shared/scriptMangaApi";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";
import { downloadBlob, filenameFromContentDisposition, responseErrorMessage } from "./downloadUtils";

type ScriptMangaSettingField = keyof ScriptMangaUiSettings;
type ScriptMangaExportFormat = "png" | "pptx" | "ora";

const DEFAULT_SETTINGS: ScriptMangaUiSettings = {
  templateId: "",
  planningMode: "heuristic",
  panelsPerPage: 4,
  dialoguePolicy: "preserve",
  auditMode: "vlm"
};

let operationSerial = 0;
let vlmStatusRequestSerial = 0;

async function refreshScriptMangaVlmStatus(requestSerial: number): Promise<void> {
  let status: VlmAuditServiceStatus;
  try {
    status = await api<VlmAuditServiceStatus>("/api/vlm-audit/status");
  } catch (error) {
    status = {
      ok: false,
      state: "server-unreachable",
      baseUrl: "",
      model: "",
      checkedAt: new Date().toISOString(),
      loadedModelIds: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
  if (requestSerial !== vlmStatusRequestSerial || !state.scriptScreenOpen) return;
  state.scriptMangaVlmStatus = status;
  requestRender();
}

/** selectの文字列値を安全なUI設定へ変換する純関数。 */
export function nextScriptMangaSettings(
  current: ScriptMangaUiSettings,
  field: string,
  rawValue: string
): ScriptMangaUiSettings {
  if (field === "templateId") return { ...current, templateId: rawValue };
  if (field === "planningMode" && (rawValue === "heuristic" || rawValue === "llm")) {
    return { ...current, planningMode: rawValue };
  }
  if (field === "panelsPerPage") {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return current;
    return { ...current, panelsPerPage: Math.min(6, Math.max(1, Math.trunc(parsed))) };
  }
  if (field === "dialoguePolicy" && (rawValue === "preserve" || rawValue === "adapt" || rawValue === "fill")) {
    return { ...current, dialoguePolicy: rawValue, panelsPerPage: rawValue === "preserve" ? current.panelsPerPage : Math.min(current.panelsPerPage, 2) };
  }
  if (field === "auditMode" && (rawValue === "manual" || rawValue === "vlm")) {
    return { ...current, auditMode: rawValue };
  }
  return current;
}

/** 準備操作が画像生成を開始せず、人間レビュー方式を固定するAPI payload。 */
export function scriptMangaPrepareRequest(
  scriptId: string,
  settings: ScriptMangaUiSettings
): PrepareScriptMangaRunRequest {
  return {
    scriptId,
    ...settings,
    generateImages: false,
    candidateSelectionPolicy: "review"
  };
}

/** 脚本画面を開いた時、利用可能テンプレートと既定選択を同期する。 */
export function initializeScriptMangaUiState(): void {
  operationSerial += 1;
  const statusRequestSerial = ++vlmStatusRequestSerial;
  state.scriptMangaTemplates = [...state.templates];
  const currentTemplateExists = state.scriptMangaTemplates.some(
    (template) => template.id === state.scriptMangaSettings.templateId
  );
  state.scriptMangaSettings = {
    ...state.scriptMangaSettings,
    templateId: currentTemplateExists
      ? state.scriptMangaSettings.templateId
      : state.scriptMangaTemplates[0]?.id ?? ""
  };
  state.scriptMangaRun = null;
  state.scriptMangaBusy = false;
  state.scriptMangaVlmStatus = null;
  if (typeof window !== "undefined") {
    void refreshScriptMangaVlmStatus(statusRequestSerial);
  }
}

/** 脚本切替・revision再取り込み時に、旧revisionへ固定されたrunだけを破棄する。 */
export function clearScriptMangaRunState(): void {
  operationSerial += 1;
  state.scriptMangaRun = null;
  state.scriptMangaBusy = false;
}

/** 脚本画面を閉じる時はプロジェクト固有のテンプレートと設定も破棄する。 */
export function clearScriptMangaUiState(): void {
  operationSerial += 1;
  vlmStatusRequestSerial += 1;
  state.scriptMangaTemplates = [];
  state.scriptMangaSettings = { ...DEFAULT_SETTINGS };
  state.scriptMangaRun = null;
  state.scriptMangaBusy = false;
  state.scriptMangaVlmStatus = null;
}

function beginOperation(): number | null {
  if (state.scriptMangaBusy) return null;
  const serial = ++operationSerial;
  state.scriptMangaBusy = true;
  requestRender();
  return serial;
}

function operationIsCurrent(serial: number): boolean {
  return serial === operationSerial;
}

function finishOperation(serial: number): void {
  if (!operationIsCurrent(serial)) return;
  state.scriptMangaBusy = false;
  requestRender();
}

function reportOperationError(serial: number, error: unknown): void {
  if (!operationIsCurrent(serial)) return;
  pushToast(error instanceof Error ? error.message : String(error), "error");
}

async function prepareRun(): Promise<void> {
  const projectId = state.currentProjectId;
  const scriptId = state.activeScriptId;
  const settings = state.scriptMangaSettings;
  if (!projectId || !scriptId || !state.activeScriptRevision) {
    pushToast("先にFountain脚本を取り込んでください。", "error");
    return;
  }
  if (!settings.templateId) {
    pushToast("画像生成workflow templateを選択してください。", "error");
    return;
  }
  const serial = beginOperation();
  if (serial === null) return;
  const request = scriptMangaPrepareRequest(scriptId, settings);
  try {
    const run = await api<ScriptMangaRunView>(`/api/projects/${projectId}/script-manga-runs`, {
      method: "POST",
      body: JSON.stringify(request)
    });
    if (
      operationIsCurrent(serial) &&
      state.scriptScreenOpen &&
      state.currentProjectId === projectId &&
      state.activeScriptId === scriptId
    ) {
      state.scriptMangaRun = run;
      pushToast("MangaPlanV2を準備しました。警告を確認して承認してください。", "info");
    }
  } catch (error) {
    reportOperationError(serial, error);
  } finally {
    finishOperation(serial);
  }
}

async function updateRun(action: "approve" | "start" | "resume" | "cancel" | "refresh"): Promise<void> {
  const runId = state.scriptMangaRun?.id;
  if (!runId) return;
  const serial = beginOperation();
  if (serial === null) return;
  try {
    const run = await api<ScriptMangaRunView>(
      action === "refresh" ? `/api/script-manga-runs/${runId}` : `/api/script-manga-runs/${runId}/${action}`,
      action === "refresh" ? undefined : { method: "POST" }
    );
    if (operationIsCurrent(serial) && state.scriptMangaRun?.id === runId) {
      state.scriptMangaRun = run;
      if (action !== "refresh") {
        const labels = { approve: "承認", start: "生成開始", resume: "再開", cancel: "キャンセル" } as const;
        pushToast(`runを${labels[action]}しました。`, "info");
      }
    }
  } catch (error) {
    reportOperationError(serial, error);
  } finally {
    finishOperation(serial);
  }
}

async function selectCandidate(taskId: string, target: HTMLElement): Promise<void> {
  const runId = state.scriptMangaRun?.id;
  const assetId = target.dataset.assetId;
  if (!runId || !taskId || !assetId) return;
  const serial = beginOperation();
  if (serial === null) return;
  try {
    const run = await api<ScriptMangaRunView>(`/api/script-manga-tasks/${taskId}/select`, {
      method: "POST",
      body: JSON.stringify({ assetId })
    });
    if (operationIsCurrent(serial) && state.scriptMangaRun?.id === runId) {
      state.scriptMangaRun = run;
      pushToast(`候補 ${assetId} を採用しました。`, "info");
    }
  } catch (error) {
    reportOperationError(serial, error);
  } finally {
    finishOperation(serial);
  }
}

async function retryTask(taskId: string): Promise<void> {
  const runId = state.scriptMangaRun?.id;
  const panelId = state.scriptMangaRun?.tasks.find((task) => task.id === taskId)?.panelId;
  if (!runId || !taskId) return;
  const serial = beginOperation();
  if (serial === null) return;
  try {
    const run = await api<ScriptMangaRunView>(`/api/script-manga-tasks/${taskId}/retry`, { method: "POST" });
    if (operationIsCurrent(serial) && state.scriptMangaRun?.id === runId) {
      state.scriptMangaRun = run;
      pushToast(`${panelId ? `panel ${panelId}` : "このコマ"}を再生成します。`, "info");
    }
  } catch (error) {
    reportOperationError(serial, error);
  } finally {
    finishOperation(serial);
  }
}

function scriptMangaExportFormat(value: unknown): ScriptMangaExportFormat | null {
  return value === "png" || value === "pptx" || value === "ora" ? value : null;
}

async function exportRun(rawFormat: unknown): Promise<void> {
  const runId = state.scriptMangaRun?.id;
  const format = scriptMangaExportFormat(rawFormat);
  if (!runId || !format || state.scriptMangaRun?.status !== "completed") return;
  const serial = beginOperation();
  if (serial === null) return;
  try {
    const response = await fetch(`/api/script-manga-runs/${encodeURIComponent(runId)}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format })
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response));
    const blob = await response.blob();
    if (!operationIsCurrent(serial) || state.scriptMangaRun?.id !== runId) return;
    const fallbackName = format === "ora" && blob.type === "application/zip"
      ? "guruguru-manga-openraster.zip"
      : `guruguru-manga.${format}`;
    const filename = filenameFromContentDisposition(response.headers.get("content-disposition")) ?? fallbackName;
    downloadBlob(blob, filename);
    const labels: Record<ScriptMangaExportFormat, string> = { png: "PNG", pptx: "PPTX", ora: "OpenRaster" };
    pushToast(`${labels[format]}を書き出しました。`, "info");
  } catch (error) {
    reportOperationError(serial, error);
  } finally {
    finishOperation(serial);
  }
}

function bindScriptMangaEvents(app: HTMLElement): void {
  app.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const field = target.dataset.scriptMangaSetting as ScriptMangaSettingField | undefined;
    if (!field) return;
    state.scriptMangaSettings = nextScriptMangaSettings(state.scriptMangaSettings, field, target.value);
    requestRender();
  });
}

registerActions({
  "prepare-script-manga-run": () => void prepareRun(),
  "approve-script-manga-run": () => void updateRun("approve"),
  "start-script-manga-run": () => void updateRun("start"),
  "resume-script-manga-run": () => void updateRun("resume"),
  "refresh-script-manga-run": () => void updateRun("refresh"),
  "cancel-script-manga-run": () => void updateRun("cancel"),
  "select-script-manga-candidate": (taskId, target) => void selectCandidate(taskId, target),
  "retry-script-manga-task": (taskId) => void retryTask(taskId),
  "export-script-manga-run": (_id, target) => void exportRun(target.dataset.format)
});

registerEventBinder(bindScriptMangaEvents);
