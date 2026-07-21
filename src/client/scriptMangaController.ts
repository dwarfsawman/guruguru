import type {
  AdoptScriptMangaPlanCandidateFailure,
  AdoptScriptMangaPlanCandidateRequest,
  AdoptScriptMangaPlanCandidateResponse,
  CreateScriptMangaPlanCandidatesRequest,
  PrepareScriptMangaRunRequest,
  ScriptMangaPlanCandidateView,
  ScriptMangaPlanCandidatesResponse,
  ScriptMangaRunView,
  ScriptMangaUiSettings,
  VlmAuditServiceStatus
} from "../shared/scriptMangaApi";
import type { ProjectDetail } from "../shared/apiTypes";
import { DEFAULT_MAX_DIALOGUES_PER_PANEL } from "../shared/scriptMangaPlan";
import { api, ApiError } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";
import { DEFAULT_NAME_STUDIO_READER_OPTIONS } from "./nameStudioReader";
import { resetNameLayoutEditSession } from "./nameLayoutEditController";
import { resetNamePoseEditSession } from "./namePoseEditController";
import { resetNameStudioPanelDraft } from "./nameStudioController";
import { downloadBlob, filenameFromContentDisposition, responseErrorMessage } from "./downloadUtils";
import { refreshLayoutTemplates } from "./layoutTemplateController";
import { closeAssetDetail, openAssetDetail } from "./assetDetailController";
import { findAsset } from "./assetLookup";
import { inpaintDraftForAsset } from "./draftStore";
import {
  commitActiveMaskCanvas,
  effectiveMaskDataUrl,
  openMaskEditorForActiveAsset
} from "./maskEditorController";

type ScriptMangaSettingField = keyof ScriptMangaUiSettings;
type ScriptMangaExportFormat = "png" | "jpeg" | "pptx" | "ora";

const DEFAULT_SETTINGS: ScriptMangaUiSettings = {
  templateId: "",
  // V5 X5: planningMode select はUIから削除。既定はビート化N1(llm)。API値は残置。
  planningMode: "llm",
  panelsPerPage: 4,
  maxDialoguesPerPanel: DEFAULT_MAX_DIALOGUES_PER_PANEL,
  targetPageCount: 0,
  maxPanelCount: 0,
  dialoguePolicy: "preserve",
  auditMode: "vlm",
  poseControl: "off"
};

let operationSerial = 0;
let vlmStatusRequestSerial = 0;
let candidateOperationSerial = 0;

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
  if (field === "panelsPerPage") {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return current;
    return { ...current, panelsPerPage: Math.min(6, Math.max(1, Math.trunc(parsed))) };
  }
  if (field === "maxDialoguesPerPanel") {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return current;
    return { ...current, maxDialoguesPerPanel: Math.min(8, Math.max(1, Math.trunc(parsed))) };
  }
  if (field === "targetPageCount") {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return current;
    return { ...current, targetPageCount: Math.min(200, Math.max(0, Math.trunc(parsed))) };
  }
  if (field === "maxPanelCount") {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return current;
    return { ...current, maxPanelCount: Math.min(800, Math.max(0, Math.trunc(parsed))) };
  }
  if (field === "dialoguePolicy" && (rawValue === "preserve" || rawValue === "adapt" || rawValue === "fill")) {
    return { ...current, dialoguePolicy: rawValue, panelsPerPage: rawValue === "preserve" ? current.panelsPerPage : Math.min(current.panelsPerPage, 2) };
  }
  if (field === "auditMode" && (rawValue === "manual" || rawValue === "vlm")) {
    return { ...current, auditMode: rawValue };
  }
  if (field === "poseControl" && (rawValue === "off" || rawValue === "full" || rawValue === "upper" || rawValue === "face")) {
    return { ...current, poseControl: rawValue };
  }
  return current;
}

/** 準備操作が画像生成を開始せず、人間レビュー方式を固定するAPI payload。 */
export function scriptMangaPrepareRequest(
  scriptId: string,
  settings: ScriptMangaUiSettings,
  planCandidateId?: string,
  expectedCandidateVersion?: number
): PrepareScriptMangaRunRequest {
  return {
    scriptId,
    ...settings,
    generateImages: false,
    candidateSelectionPolicy: "review",
    requireReferenceSets: true,
    allowReferenceFallback: false,
    ...(planCandidateId ? { planCandidateId } : {}),
    ...(expectedCandidateVersion !== undefined ? { expectedCandidateVersion } : {})
  };
}

/** Dedicated candidate endpoint takes identity from the URL and rejects successor fields. */
export function scriptMangaCandidateAdoptRequest(
  settings: ScriptMangaUiSettings,
  expectedCandidateVersion?: number
): AdoptScriptMangaPlanCandidateRequest {
  return {
    ...settings,
    generateImages: false,
    candidateSelectionPolicy: "review",
    requireReferenceSets: true,
    allowReferenceFallback: false,
    ...(expectedCandidateVersion !== undefined ? { expectedCandidateVersion } : {})
  };
}

/** ネーム候補へUIの密度指定を明示的に渡すAPI payload。 */
export function scriptMangaPlanCandidatesRequest(
  scriptId: string,
  count: number,
  settings: ScriptMangaUiSettings,
  groupId?: string
): CreateScriptMangaPlanCandidatesRequest {
  return {
    scriptId,
    count,
    targetPageCount: settings.targetPageCount,
    panelsPerPage: settings.panelsPerPage,
    maxDialoguesPerPanel: settings.maxDialoguesPerPanel,
    ...(groupId ? { groupId } : {})
  };
}

function applyCandidatesResponse(response: ScriptMangaPlanCandidatesResponse, replace: boolean): void {
  if (replace) {
    state.scriptMangaCandidates = response.candidates;
  } else {
    const known = new Set(state.scriptMangaCandidates.map((candidate) => candidate.id));
    state.scriptMangaCandidates = [
      ...state.scriptMangaCandidates,
      ...response.candidates.filter((candidate) => !known.has(candidate.id))
    ];
  }
  state.scriptMangaCandidateBeatKinds = { ...state.scriptMangaCandidateBeatKinds, ...response.beatKinds };
  if (response.dialogueCharsByOrderIndex.length > 0) {
    state.scriptMangaCandidateDialogueChars = response.dialogueCharsByOrderIndex;
  }
}

/** 最新revisionの候補一覧を読み直す(画面オープン・生成/破棄/採用後)。 */
export async function refreshScriptMangaCandidates(): Promise<void> {
  const projectId = state.currentProjectId;
  const scriptId = state.activeScriptId;
  if (!projectId || !scriptId) {
    state.scriptMangaCandidates = [];
    return;
  }
  const serial = ++candidateOperationSerial;
  try {
    const layoutRefresh = state.layoutTemplates === null && !state.layoutTemplatesLoading
      ? refreshLayoutTemplates().catch(() => undefined)
      : Promise.resolve();
    const response = await api<ScriptMangaPlanCandidatesResponse>(
      `/api/projects/${projectId}/script-manga-plan-candidates?scriptId=${encodeURIComponent(scriptId)}`
    );
    await layoutRefresh;
    if (serial !== candidateOperationSerial || !state.scriptScreenOpen || state.activeScriptId !== scriptId) return;
    state.scriptMangaCandidates = [];
    applyCandidatesResponse(response, true);
    requestRender();
  } catch {
    // 候補一覧は補助情報。失敗しても脚本画面自体は使える(生成時のエラーは別途toastされる)。
  }
}

async function generateCandidates(groupId?: string): Promise<void> {
  const projectId = state.currentProjectId;
  const scriptId = state.activeScriptId;
  if (!projectId || !scriptId || !state.activeScriptRevision) {
    pushToast("先にFountain脚本を取り込んでください。", "error");
    return;
  }
  if (state.scriptMangaCandidatesBusy) return;
  const serial = ++candidateOperationSerial;
  state.scriptMangaCandidatesBusy = true;
  requestRender();
  try {
    const response = await api<ScriptMangaPlanCandidatesResponse>(
      `/api/projects/${projectId}/script-manga-plan-candidates`,
      {
        method: "POST",
        body: JSON.stringify(scriptMangaPlanCandidatesRequest(
          scriptId,
          state.scriptMangaCandidateCount,
          state.scriptMangaSettings,
          groupId
        ))
      }
    );
    if (serial === candidateOperationSerial && state.scriptScreenOpen && state.activeScriptId === scriptId) {
      applyCandidatesResponse(response, false);
      pushToast(`プラン候補を${response.candidates.length}件生成しました。`, "info");
    }
  } catch (error) {
    if (serial === candidateOperationSerial) pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    if (serial === candidateOperationSerial) {
      state.scriptMangaCandidatesBusy = false;
      requestRender();
    }
  }
}

async function archiveCandidate(candidateId: string): Promise<void> {
  if (!candidateId || state.scriptMangaCandidatesBusy) return;
  const serial = ++candidateOperationSerial;
  state.scriptMangaCandidatesBusy = true;
  requestRender();
  try {
    await api(`/api/script-manga-plan-candidates/${encodeURIComponent(candidateId)}/archive`, { method: "POST" });
    state.scriptMangaCandidates = state.scriptMangaCandidates.filter((candidate) => candidate.id !== candidateId);
    pushToast("候補を破棄しました。", "info");
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    if (serial === candidateOperationSerial) {
      state.scriptMangaCandidatesBusy = false;
      requestRender();
    }
  }
}

/** 候補採用: 専用APIが候補statusと準備済みrunを同じ応答で確定する。 */
async function adoptCandidate(candidateId: string): Promise<void> {
  const projectId = state.currentProjectId;
  const scriptId = state.activeScriptId;
  const settings = state.scriptMangaSettings;
  if (!projectId || !scriptId || !candidateId) return;
  if (!settings.templateId) {
    pushToast("画像生成workflow templateを選択してください。", "error");
    return;
  }
  const serial = beginOperation();
  if (serial === null) return;
  // V5 D5: 採用にも楽観ロックを掛ける(採用開始直前のフリップとの競合を検出)。
  const expectedVersion = state.scriptMangaCandidates.find((candidate) => candidate.id === candidateId)?.editVersion;
  try {
    const result = await api<AdoptScriptMangaPlanCandidateResponse>(
      `/api/script-manga-plan-candidates/${encodeURIComponent(candidateId)}/adopt`, {
      method: "POST",
      body: JSON.stringify(scriptMangaCandidateAdoptRequest(settings, expectedVersion))
    });
    const { run } = result;
    if (operationIsCurrent(serial) && state.scriptScreenOpen && state.activeScriptId === scriptId) {
      state.scriptMangaRun = run;
      state.scriptMangaCandidates = state.scriptMangaCandidates.map((candidate) =>
        candidate.id === candidateId ? result.candidate : candidate
      );
      pushToast("候補を採用してMangaPlanV2を準備しました。警告を確認して承認してください。", "info");
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) {
      const failure = error.body as Partial<AdoptScriptMangaPlanCandidateFailure>;
      const issues = failure.preflight?.issues ?? [];
      const detail = issues.slice(0, 3).map((issue) => issue.message).join(" / ");
      reportOperationError(
        serial,
        new Error(detail ? `候補プリフライト失敗: ${detail}` : error.message)
      );
    } else {
      reportOperationError(serial, error);
    }
    // 409(並行フリップ・採用中)は候補一覧を取り直して表示を合わせる。
    void refreshScriptMangaCandidates();
  } finally {
    finishOperation(serial);
  }
}

// --- script画面ライブ更新(V5 D7): pollCollectRound と同型の delay-loop ---

const SCRIPT_MANGA_POLL_INTERVAL_MS = 5000;
let pollGeneration = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** run を静かに(busy表示なしで)取り直す。ポーリング用。 */
async function refreshRunQuietly(runId: string): Promise<void> {
  // V5 D6: 編集ドラフト中は run の適用をskipする(ドラフトの根拠planが差し替わる巻き戻り防止)。
  // ポーズ編集セッション中も同様(Docs/Feature-NamePoseLayer.md)。
  if (state.nameStudioDraft || state.namePoseEdit || state.nameLayoutEdit) return;
  try {
    const run = await api<ScriptMangaRunView>(`/api/script-manga-runs/${encodeURIComponent(runId)}`);
    if (!state.scriptScreenOpen || state.scriptMangaBusy || state.nameStudioDraft || state.namePoseEdit || state.nameLayoutEdit) return;
    if (state.scriptMangaRun && state.scriptMangaRun.id !== runId) return;
    if (run.scriptId !== state.activeScriptId) return;
    state.scriptMangaRun = run;
    requestRender();
  } catch {
    // ポーリングは補助。失敗は次周期に任せる。
  }
}

/**
 * script画面が開いている間、候補と run を定期的に取り直す。エージェントがAPIで作った候補が
 * 開きっぱなしのブラウザへ自動で現れ、別ブラウザ/エージェントの採用で run もブートストラップされる。
 */
export function startScriptMangaPolling(): void {
  if (typeof window === "undefined") return;
  const generation = ++pollGeneration;
  void (async () => {
    let cycle = 0;
    while (generation === pollGeneration && state.scriptScreenOpen) {
      await delay(SCRIPT_MANGA_POLL_INTERVAL_MS);
      cycle += 1;
      if (generation !== pollGeneration || !state.scriptScreenOpen) break;
      // 共有ページは「バックグラウンドで開きっぱなし」が主用途なので、hidden でも
      // 完全には止めず低頻度(4周期=20秒毎)で回す。
      if (document.hidden && cycle % 4 !== 0) continue;
      // コマ割り修正セッション中(nameLayoutEdit)は候補一覧の差し替えをskipする
      // (編集根拠の candidate が5秒毎に置き換わり、楽観ロックの意味が失われるため)。
      if (state.scriptMangaBusy || state.scriptMangaCandidatesBusy || state.nameLayoutEdit) continue;
      await refreshScriptMangaCandidates();
      if (generation !== pollGeneration || !state.scriptScreenOpen) break;
      if (state.scriptMangaRun) {
        await refreshRunQuietly(state.scriptMangaRun.id);
      } else {
        // 眺めているだけのブラウザでも、採用済み候補から run カードを立ち上げる。
        const adopted = state.scriptMangaCandidates.find(
          (candidate) => candidate.status === "adopted" && candidate.adoptedRunId
        );
        if (adopted?.adoptedRunId) await refreshRunQuietly(adopted.adoptedRunId);
      }
    }
  })();
}

export function stopScriptMangaPolling(): void {
  pollGeneration += 1;
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
  state.scriptMangaCandidates = [];
  state.scriptMangaCandidateBeatKinds = {};
  state.scriptMangaCandidateDialogueChars = [];
  state.scriptMangaCandidatesBusy = false;
  state.nameStudio = {
    takeId: null,
    pageIndex: 0,
    selectedPanelId: null,
    fullscreen: false,
    ...DEFAULT_NAME_STUDIO_READER_OPTIONS
  };
  if (typeof window !== "undefined") {
    void refreshScriptMangaVlmStatus(statusRequestSerial);
    void refreshScriptMangaCandidates();
    startScriptMangaPolling();
  }
}

/**
 * 脚本切替・revision再取り込み時に、旧revisionへ固定されたrun/候補だけを破棄する。
 * 候補の再取得は行わない(呼び出し側が activeScriptId を設定した後に
 * `refreshScriptMangaCandidates()` を呼ぶ — 設定前に取得すると空振りするため)。
 */
export function clearScriptMangaRunState(): void {
  operationSerial += 1;
  candidateOperationSerial += 1;
  state.scriptMangaRun = null;
  state.scriptMangaBusy = false;
  state.scriptMangaCandidates = [];
  state.scriptMangaCandidateBeatKinds = {};
  state.scriptMangaCandidateDialogueChars = [];
  state.scriptMangaCandidatesBusy = false;
  state.nameStudio = {
    takeId: null,
    pageIndex: 0,
    selectedPanelId: null,
    fullscreen: false,
    ...DEFAULT_NAME_STUDIO_READER_OPTIONS
  };
  resetNameEditSessions();
}

/**
 * ネーム編集系3セッション(コマ割り修正/ポーズ編集/演出ドラフト)を破棄する。
 * 以前は `nameLayoutEdit` しか消しておらず、`namePoseEdit`/`nameStudioDraft` が残留すると
 * keydown ハンドラの Escape/Ctrl+Z 横取り+run ポーリング永久 skip が起きていた(監査 C9)。
 */
function resetNameEditSessions(): void {
  resetNameLayoutEditSession();
  resetNamePoseEditSession();
  resetNameStudioPanelDraft();
}

/** 脚本画面を閉じる時はプロジェクト固有のテンプレートと設定も破棄する。 */
export function clearScriptMangaUiState(): void {
  operationSerial += 1;
  vlmStatusRequestSerial += 1;
  candidateOperationSerial += 1;
  stopScriptMangaPolling();
  state.nameStudio = {
    takeId: null,
    pageIndex: 0,
    selectedPanelId: null,
    fullscreen: false,
    ...DEFAULT_NAME_STUDIO_READER_OPTIONS
  };
  state.scriptMangaTemplates = [];
  state.scriptMangaSettings = { ...DEFAULT_SETTINGS };
  state.scriptMangaRun = null;
  state.scriptMangaBusy = false;
  state.scriptMangaVlmStatus = null;
  state.scriptMangaCandidates = [];
  state.scriptMangaCandidateBeatKinds = {};
  state.scriptMangaCandidateDialogueChars = [];
  state.scriptMangaCandidatesBusy = false;
  resetNameEditSessions();
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

async function editCandidateMask(taskId: string, target: HTMLElement): Promise<void> {
  const projectId = state.currentProjectId;
  const runId = state.scriptMangaRun?.id;
  const assetId = target.dataset.assetId;
  const task = state.scriptMangaRun?.tasks.find((candidate) => candidate.id === taskId);
  if (
    !projectId ||
    !runId ||
    !assetId ||
    task?.status !== "awaiting_review" ||
    !task.candidateAssetIds.includes(assetId)
  ) return;
  const serial = beginOperation();
  if (serial === null) return;
  try {
    if (!findAsset(assetId)) {
      const detail = await api<ProjectDetail>(`/api/projects/${projectId}`);
      if (!operationIsCurrent(serial) || state.scriptMangaRun?.id !== runId) return;
      state.detail = detail;
    }
    if (!findAsset(assetId)) throw new Error("候補assetの詳細を取得できませんでした。");
    openAssetDetail(assetId);
    openMaskEditorForActiveAsset();
  } catch (error) {
    reportOperationError(serial, error);
  } finally {
    finishOperation(serial);
  }
}

async function repairCandidate(taskId: string, target: HTMLElement): Promise<void> {
  const runId = state.scriptMangaRun?.id;
  const assetId = target.dataset.assetId;
  const task = state.scriptMangaRun?.tasks.find((candidate) => candidate.id === taskId);
  if (
    !runId ||
    !assetId ||
    task?.status !== "awaiting_review" ||
    !task.candidateAssetIds.includes(assetId)
  ) return;
  commitActiveMaskCanvas();
  const draft = inpaintDraftForAsset(assetId);
  const maskDataUrl = draft ? effectiveMaskDataUrl(draft) : "";
  if (!draft || !maskDataUrl.startsWith("data:image/png;base64,")) {
    pushToast("白い修復範囲をマスクで描き、適用してから実行してください。", "error");
    return;
  }
  const serial = beginOperation();
  if (serial === null) return;
  try {
    const run = await api<ScriptMangaRunView>(`/api/script-manga-tasks/${taskId}/repair`, {
      method: "POST",
      body: JSON.stringify({
        assetId,
        inpaint: {
          maskDataUrl,
          maskedContent: draft.maskedContent,
          inpaintArea: draft.inpaintArea,
          onlyMaskedPadding: draft.onlyMaskedPadding,
          featherRadius: draft.featherRadius
        }
      })
    });
    if (operationIsCurrent(serial) && state.scriptMangaRun?.id === runId) {
      state.scriptMangaRun = run;
      closeAssetDetail();
      pushToast("マスク範囲だけを修復する候補を生成します。旧候補は保持されます。", "info");
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
  return value === "png" || value === "jpeg" || value === "pptx" || value === "ora" ? value : null;
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
      : format === "jpeg"
        ? "guruguru-manga.jpg"
        : `guruguru-manga.${format}`;
    const filename = filenameFromContentDisposition(response.headers.get("content-disposition")) ?? fallbackName;
    downloadBlob(blob, filename);
    const labels: Record<ScriptMangaExportFormat, string> = {
      png: "PNG",
      jpeg: "JPEG",
      pptx: "PPTX",
      ora: "OpenRaster"
    };
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
    if (target.dataset.scriptMangaCandidateCount !== undefined) {
      const parsed = Number(target.value);
      if (Number.isFinite(parsed)) {
        state.scriptMangaCandidateCount = Math.min(6, Math.max(1, Math.trunc(parsed)));
        requestRender();
      }
      return;
    }
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
  "edit-script-manga-candidate-mask": (taskId, target) => void editCandidateMask(taskId, target),
  "repair-script-manga-candidate": (taskId, target) => void repairCandidate(taskId, target),
  "retry-script-manga-task": (taskId) => void retryTask(taskId),
  "export-script-manga-run": (_id, target) => void exportRun(target.dataset.format),
  "generate-script-manga-plan-candidates": () => void generateCandidates(),
  "extend-script-manga-plan-candidates": (_id, target) => void generateCandidates(target.dataset.groupId),
  "adopt-script-manga-plan-candidate": (candidateId) => void adoptCandidate(candidateId),
  "archive-script-manga-plan-candidate": (candidateId) => void archiveCandidate(candidateId)
});

registerEventBinder(bindScriptMangaEvents);
