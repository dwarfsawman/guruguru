import {
  defaultDenoiseForMode,
  normalizeDenoiseForMode
} from "../shared/generationMode";
import type { ComfySettings, LlmSettings } from "../shared/types";
import type {
  Asset,
  AssetParent,
  ComfyStatus,
  LlmStatus,
  ProjectDetail,
  ProjectRow,
  ProjectSummary,
  Round
} from "../shared/apiTypes";
import {
  iconClose,
  iconDiagram,
  iconMenu
} from "./icons";
import { escapeAttr, escapeHtml, formatCssNumber, formatNumber, formatSliderValue } from "./format";
import { type Json } from "./json";
import { api } from "./api";
import type { WorkflowImportDraft, WorkflowTemplate } from "./workflowTypes";
import {
  buildTemplateExportPayload,
  defaultWorkflowImportDraft,
  parseWorkflowFileContent,
  workflowExportFilename
} from "./workflowImport";
import {
  renderWorkflowDiagramCanvases,
  renderWorkflowDiagramModal,
  renderWorkflowImportModal,
  renderWorkflowImportPreview
} from "./workflowUi";
import { renderHome, type ConnectionState, type ConnectionSummary } from "./views/homeView";
import { renderIterationTracker } from "./views/iterationTree";
import { drawIterationEdges } from "./views/iterationTreeEdges";
import { renderProjectDetail, renderSourceUploadButton } from "./views/galleryView";
import { renderGenerationPanel } from "./views/generationPanel";
import { renderAssetModal, type MaskGenerationParams } from "./views/assetModal";
import {
  setRenderCallback,
  state,
  toggleSidebarCollapsed,
  type GenerationDraftField,
  type RenderOptions
} from "./appState";
import { actionHandlerFor, bindRegisteredEvents } from "./actionRegistry";
import {
  draftStorageKey,
  inpaintDraftForAsset,
  persistProjectDraft,
  restoreProjectDraft
} from "./draftStore";
import { assetDimension, findAsset } from "./assetLookup";
import {
  cancelPendingMaskStrokeFlush,
  clearActiveImagePan,
  closeMaskEditorSession,
  handleMaskEditorPointerCancel,
  handleMaskEditorPointerDown,
  handleMaskEditorPointerMove,
  handleMaskEditorPointerUp,
  handleMaskPointerDown,
  handleMaskStrokePointerCancel,
  handleMaskStrokePointerMove,
  handleMaskStrokePointerUp,
  handleMaskWheelZoom,
  invalidateMaskBrushCursorCache,
  syncAssetModalMaskCanvas,
  updateInpaintDraftFromControl
} from "./maskEditorController";
import {
  clearActiveWebSamBoxPrompt,
  destroyWebSamWorkerSession,
  handleWebSamPointerCancel,
  handleWebSamPointerMove,
  handleWebSamPointerUp,
  updateSmartMaskDraftFromControl
} from "./webSamController";
import { clampNumber, delay } from "./clientUtils";
import {
  clearSelectedPoseEdges,
  closePoseEditorSession,
  getSelectedPoseEdges,
  handlePoseEditorKeydown,
  handlePoseEditorPointerCancel,
  handlePoseEditorPointerDown,
  handlePoseEditorPointerMove,
  handlePoseEditorPointerUp,
  poseDraftForAsset,
  updatePoseDraftFromControl
} from "./poseEditorController";
import { defaultPaintDraft } from "./paintDraft";
import {
  closePaintEditorSession,
  handlePaintEditorBlur,
  handlePaintEditorKeydown,
  handlePaintEditorKeyup,
  handlePaintEditorPointerCancel,
  handlePaintEditorPointerDown,
  handlePaintEditorPointerMove,
  handlePaintEditorPointerUp,
  handlePaintWheelZoom,
  paintDraftForAsset,
  setPaintBrushSize,
  setPaintColor,
  syncAssetModalPaintCanvas
} from "./paintEditorController";
import { formValue, readForm, setFormValue } from "./formUtils";
import {
  applyAssetDimensionsToDraft,
  assetPassesFilter,
  captureGenerationDraft,
  currentBatchSizeValue,
  currentCfgValue,
  currentDenoiseValue,
  currentHeightValue,
  currentPositivePromptValue,
  currentSamplerValue,
  currentSchedulerValue,
  currentSeedModeValue,
  currentSeedValue,
  currentStepsValue,
  currentWidthValue,
  fillGenerationFormFromAsset,
  generationDraftFromForm,
  getActiveRound,
  getActiveRoundAssets,
  getPreferredParentAsset,
  setGenerationDraftValue,
  setGenerationSliderDraft,
  setPositivePromptDraft,
  syncPreviewPromptControl,
  updateDenoiseControlForMode
} from "./generationDraft";
import {
  isRoundActive,
  previewRoundDeletion,
  refreshProject,
  resumeAutoCollectForActiveRounds,
  selectAllActiveRound,
  selectRound,
  setAssetStatus,
  toggleFavorite,
  toggleSelect
} from "./generationController";

const app = document.querySelector<HTMLDivElement>("#app")!;
let pendingAssetCardSelect: { assetId: string; timer: number } | null = null;
let pendingIterationDotSelect: { timer: number } | null = null;

interface ActiveWorkflowDiagramPan {
  pointerId: number;
  element: HTMLElement;
  startClient: { x: number; y: number };
  originPan: { x: number; y: number };
}

let activeWorkflowDiagramPan: ActiveWorkflowDiagramPan | null = null;

setRenderCallback(render);
void boot();

async function boot() {
  await loadHome();
  bindEvents();
}

function bindEvents() {
  app.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("preview-modal")) {
      captureGenerationDraft();
      closeAssetDetail();
      return;
    }
    if (target.classList.contains("workflow-modal")) {
      closeWorkflowModals();
      return;
    }

    const iterationDot = target.closest<HTMLElement>(".iteration-dot");
    if (iterationDot?.dataset.id && event.detail >= 2) {
      event.preventDefault();
      clearPendingIterationDotSelect();
      previewRoundDeletion(iterationDot.dataset.id);
      return;
    }
    if (iterationDot?.dataset.id) {
      event.preventDefault();
      scheduleIterationDotSelect(iterationDot.dataset.id);
      return;
    }

    const assetCardMain = target.closest<HTMLElement>(".asset-card-main");
    if (assetCardMain?.dataset.id) {
      if (event.detail >= 2) {
        event.preventDefault();
        clearPendingAssetCardSelect();
        return;
      }
      captureGenerationDraft();
      scheduleAssetCardSelect(assetCardMain.dataset.id);
      return;
    }

    const actionTarget = target.closest<HTMLElement>("[data-action]");
    if (!actionTarget) {
      return;
    }

    const action = actionTarget.dataset.action!;
    if (action !== "reset-generation-params") {
      captureGenerationDraft();
    }
    const id = actionTarget.dataset.id ?? "";
    void handleAction(action, id, actionTarget);
  });

  app.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement;
    const assetCardMain = target.closest<HTMLElement>(".asset-card-main");
    if (assetCardMain?.dataset.id) {
      event.preventDefault();
      clearPendingAssetCardSelect();
      captureGenerationDraft();
      openAssetDetail(assetCardMain.dataset.id);
      return;
    }

    const dot = target.closest<HTMLElement>(".iteration-dot");
    if (!dot?.dataset.id) {
      return;
    }
    event.preventDefault();
    clearPendingIterationDotSelect();
    previewRoundDeletion(dot.dataset.id);
  });

  app.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target instanceof HTMLInputElement && target.type === "file" && target.dataset.sourceUpload) {
      void uploadSourceAsset(target).catch((error) => {
        state.busy = false;
        state.message = error instanceof Error ? error.message : String(error);
        render();
      });
      return;
    }
    if (target instanceof HTMLInputElement && target.type === "file" && target.dataset.fileTarget) {
      void loadWorkflowFile(target);
      return;
    }
    if (target.closest("#template-form")) {
      captureWorkflowImportDraftFromElement(target);
      refreshWorkflowImportPreview();
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
    if (target.dataset.smartMaskField) {
      updateSmartMaskDraftFromControl(target);
      return;
    }
    if (target.dataset.poseField) {
      updatePoseDraftFromControl(target, { commit: true });
      return;
    }
    if (target.dataset.inpaintField) {
      updateInpaintDraftFromControl(target);
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.paintColorPicker) {
      setPaintColor(target.value);
      return;
    }
    if (target.dataset.generationField && target.dataset.generationField !== "prompt" && target.dataset.generationField !== "batchSize") {
      const field = target.dataset.generationField as GenerationDraftField;
      setGenerationDraftValue(field, target.value);
      const form = document.querySelector<HTMLFormElement>("#generation-form");
      if (form) {
        setFormValue(form, field, target.value);
      }
      return;
    }
    if (target.closest("#generation-form")) {
      captureGenerationDraft();
    }
  });

  app.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    const valueId = target instanceof HTMLInputElement ? target.dataset.valueTarget : undefined;
    if (target.dataset.generationField === "prompt") {
      setPositivePromptDraft(target.value);
      return;
    }
    if (
      target.dataset.generationField &&
      target.dataset.generationField !== "prompt" &&
      target instanceof HTMLInputElement
    ) {
      setGenerationSliderDraft(target.dataset.generationField as GenerationDraftField, target);
    }
    if (target.dataset.inpaintField) {
      updateInpaintDraftFromControl(target);
    }
    if (target.dataset.paintField === "brushSize" && target instanceof HTMLInputElement) {
      setPaintBrushSize(Number(target.value));
    }
    if (target.closest("#template-form")) {
      captureWorkflowImportDraftFromElement(target);
      refreshWorkflowImportPreview();
      return;
    }
    if (!valueId) {
      if (target.closest("#generation-form")) {
        captureGenerationDraft();
        if (target.name === "prompt") {
          syncPreviewPromptControl(target.value);
        }
      }
      return;
    }
    const valueTarget = document.getElementById(valueId);
    if (valueTarget && target instanceof HTMLInputElement) {
      const suffix =
        target.dataset.inpaintField === "onlyMaskedPadding" ||
        target.dataset.inpaintField === "featherRadius" ||
        target.dataset.inpaintField === "brushSize" ||
        target.dataset.paintField === "brushSize"
          ? "px"
          : "";
      valueTarget.textContent = `${formatSliderValue(target)}${suffix}`;
    }
    if (target.closest("#generation-form")) {
      captureGenerationDraft();
    }
    if (target.dataset.smartMaskField) {
      updateSmartMaskDraftFromControl(target);
      return;
    }
    if (target.dataset.poseField) {
      updatePoseDraftFromControl(target);
      return;
    }
  });

  app.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement;
    if (target.id === "maskCanvas") {
      event.preventDefault();
    }
  });

  app.addEventListener("auxclick", (event) => {
    const target = event.target as HTMLElement;
    if (event.button === 1 && target.closest(".preview-media")) {
      event.preventDefault();
    }
  });

  // イテレーションツリーのエッジ hover ポップアウトを、
  // トラッカーの overflow でクリップされないよう viewport 基準（position: fixed）で配置する。
  app.addEventListener("mouseover", (event) => {
    const edge = (event.target as HTMLElement | null)?.closest<HTMLElement>(".iteration-edge");
    if (edge) {
      positionIterationEdgePopout(edge);
    }
  });

  app.addEventListener("wheel", (event) => {
    const target = event.target as HTMLElement;
    // Workflow diagram zoom
    const wfCanvas = target.closest<HTMLElement>(".workflow-diagram-canvas");
    if (wfCanvas) {
      event.preventDefault();
      handleWorkflowDiagramWheelZoom(event, wfCanvas);
      return;
    }
    if (target.id !== "maskCanvas" && target.id !== "paintCanvas" && !target.closest(".preview-media")) {
      return;
    }
    if (!state.activeAssetId) {
      return;
    }
    event.preventDefault();
    if (state.paintEditMode) {
      handlePaintWheelZoom(event);
    } else {
      handleMaskWheelZoom(event);
    }
  }, { passive: false });

  window.addEventListener("keydown", (event) => {
    if (!state.detail) {
      if (event.key === "Escape" && state.sidebarOpen) {
        state.sidebarOpen = false;
        render();
      }
      return;
    }

    if (event.key === "Escape") {
      if (state.deletePreviewRoundId) {
        state.deletePreviewRoundId = null;
        render();
      } else if (state.activeAssetId) {
        captureGenerationDraft();
        closeAssetDetail();
      } else if (state.sidebarOpen) {
        captureGenerationDraft();
        state.sidebarOpen = false;
        render();
      }
      return;
    }

    if (isTextEntryTarget(event.target)) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      void selectAllActiveRound();
      return;
    }

    if (!state.activeAssetId) {
      return;
    }

    if (handlePaintEditorKeydown(event)) {
      return;
    }

    if (handlePoseEditorKeydown(event)) {
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

  window.addEventListener("keyup", (event) => {
    handlePaintEditorKeyup(event);
  });

  window.addEventListener("blur", () => {
    handlePaintEditorBlur();
  });

  app.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    closeOpenActionDropdowns(target);
    if (handlePoseEditorPointerDown(event)) {
      return;
    }
    if (handleMaskEditorPointerDown(event)) {
      return;
    }
    // Workflow diagram pan (left or middle button)
    const wfCanvas = target.closest<HTMLElement>(".workflow-diagram-canvas");
    if (wfCanvas && (event.button === 0 || event.button === 1)) {
      event.preventDefault();
      beginWorkflowDiagramPan(event, wfCanvas);
      return;
    }
    if (event.button !== 0 && event.button !== 2) {
      return;
    }
    if (handlePaintEditorPointerDown(event, target)) {
      return;
    }
    if (target.id !== "maskCanvas") {
      return;
    }
    if (!state.maskEditMode || state.maskPanelTab === "pose") {
      return;
    }
    event.preventDefault();
    handleMaskPointerDown(event, target as HTMLCanvasElement);
  });

  app.addEventListener("pointermove", (event) => {
    if (handleMaskEditorPointerMove(event)) {
      return;
    }
    if (activeWorkflowDiagramPan) {
      if (event.pointerId !== activeWorkflowDiagramPan.pointerId) {
        return;
      }
      event.preventDefault();
      continueWorkflowDiagramPan(event);
      return;
    }
    if (handleWebSamPointerMove(event)) {
      return;
    }
    if (handlePoseEditorPointerMove(event)) {
      return;
    }
    if (handlePaintEditorPointerMove(event)) {
      return;
    }
    handleMaskStrokePointerMove(event);
  });

  app.addEventListener("pointerup", (event) => {
    if (handleMaskEditorPointerUp(event)) {
      return;
    }
    if (activeWorkflowDiagramPan && event.pointerId === activeWorkflowDiagramPan.pointerId) {
      event.preventDefault();
      finishWorkflowDiagramPan();
      return;
    }
    if (handleWebSamPointerUp(event)) {
      return;
    }
    if (handlePoseEditorPointerUp(event)) {
      return;
    }
    if (handlePaintEditorPointerUp(event)) {
      return;
    }
    handleMaskStrokePointerUp(event);
  });

  app.addEventListener("pointercancel", (event) => {
    if (handleMaskEditorPointerCancel(event)) {
      return;
    }
    if (activeWorkflowDiagramPan && event.pointerId === activeWorkflowDiagramPan.pointerId) {
      activeWorkflowDiagramPan = null;
      return;
    }
    if (handleWebSamPointerCancel(event)) {
      return;
    }
    if (handlePoseEditorPointerCancel(event)) {
      return;
    }
    if (handlePaintEditorPointerCancel(event)) {
      return;
    }
    handleMaskStrokePointerCancel(event);
  });

  bindRegisteredEvents(app);
}

function scheduleAssetCardSelect(assetId: string) {
  clearPendingAssetCardSelect();
  pendingAssetCardSelect = {
    assetId,
    timer: window.setTimeout(() => {
      pendingAssetCardSelect = null;
      void toggleSelect(assetId);
    }, 220)
  };
}

function clearPendingAssetCardSelect() {
  if (!pendingAssetCardSelect) {
    return;
  }
  window.clearTimeout(pendingAssetCardSelect.timer);
  pendingAssetCardSelect = null;
}

function scheduleIterationDotSelect(roundId: string) {
  clearPendingIterationDotSelect();
  pendingIterationDotSelect = {
    timer: window.setTimeout(() => {
      pendingIterationDotSelect = null;
      captureGenerationDraft();
      selectRound(roundId);
    }, 220)
  };
}

function clearPendingIterationDotSelect() {
  if (!pendingIterationDotSelect) {
    return;
  }
  window.clearTimeout(pendingIterationDotSelect.timer);
  pendingIterationDotSelect = null;
}

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.isContentEditable || !!target.closest("[contenteditable=''], [contenteditable='true']");
}

function openAssetDetail(assetId: string) {
  state.activeAssetId = assetId;
  // 編集モード（マスク/ポーズ）は常に閉じた状態で開く。マスク/ポーズの「添付」状態は
  // それぞれの enabled で独立管理し、編集モードの開閉とは切り離す。
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.maskToolbarMinimized = false;
  state.maskToolbarPos = null;
  clearSelectedPoseEdges();
  clearActiveImagePan();
  render();
}

function closeAssetDetail() {
  closeMaskEditorSession();
  closePaintEditorSession();
  clearActiveWebSamBoxPrompt();
  void destroyWebSamWorkerSession();
  closePoseEditorSession();
  state.activeAssetId = null;
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.maskToolbarMinimized = false;
  state.maskToolbarPos = null;
  render();
}

function openWorkflowImportModal() {
  state.workflowImportModalOpen = true;
  state.activeWorkflowDiagramTemplateId = null;
  render();
}

function closeWorkflowImportModal() {
  state.workflowImportModalOpen = false;
  render();
}

function openWorkflowDiagram(target: HTMLElement) {
  const template = findTemplateFromActionTarget(target);
  if (!template) {
    state.message = "diagramを表示するWorkflowTemplateがありません。";
    render();
    return;
  }
  state.activeWorkflowDiagramTemplateId = template.id;
  state.workflowImportModalOpen = false;
  render();
}

function closeWorkflowDiagram() {
  state.activeWorkflowDiagramTemplateId = null;
  render();
}

function closeWorkflowModals() {
  state.workflowImportModalOpen = false;
  state.activeWorkflowDiagramTemplateId = null;
  render();
}

function closeOpenActionDropdowns(exceptTarget?: EventTarget | null) {
  const exceptNode = exceptTarget instanceof Node ? exceptTarget : null;
  document.querySelectorAll<HTMLDetailsElement>(".template-export-dropdown[open], .workflow-dropdown[open]").forEach((dropdown) => {
    if (exceptNode && dropdown.contains(exceptNode)) {
      return;
    }
    dropdown.open = false;
  });
}

async function handleAction(action: string, id: string, target: HTMLElement) {
  const closesActionDropdowns = target.closest(".template-export-dropdown, .workflow-dropdown") !== null;
  try {
    const registered = actionHandlerFor(action);
    if (registered) {
      await registered(id, target);
    } else if (action === "home") {
      await loadHome();
    } else if (action === "toggle-sidebar") {
      state.sidebarOpen = !state.sidebarOpen;
      render();
    } else if (action === "toggle-sidebar-collapse") {
      toggleSidebarCollapsed();
      render();
    } else if (action === "save-settings") {
      await saveSettings();
    } else if (action === "test-comfy") {
      await testComfy();
    } else if (action === "connect-comfy") {
      await connectComfy();
    } else if (action === "check-comfy-connection") {
      if (state.comfyConnection !== "checking") {
        await refreshComfyStatus(true);
      }
    } else if (action === "connect-llm") {
      await connectLlm();
    } else if (action === "improve-prompt") {
      await improvePrompt();
    } else if (action === "cancel-improve-prompt") {
      cancelImprovePrompt();
    } else if (action === "open-template-import") {
      openWorkflowImportModal();
    } else if (action === "close-template-import") {
      closeWorkflowImportModal();
    } else if (action === "create-template") {
      await createTemplate();
    } else if (action === "open-template-diagram") {
      openWorkflowDiagram(target);
    } else if (action === "close-template-diagram") {
      closeWorkflowDiagram();
    } else if (action === "dismiss-message") {
      state.message = "";
      render();
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
    } else if (action === "asset-detail") {
      openAssetDetail(id);
    } else if (action === "close-detail") {
      closeAssetDetail();
    } else if (action === "toggle-mask-grid-tag") {
      state.showMaskGridTag = !state.showMaskGridTag;
      render();
    } else if (action === "copy-seed") {
      const seedText = target.dataset.seed ?? "";
      if (seedText) {
        try {
          await navigator.clipboard.writeText(seedText);
        } catch {
          state.message = "クリップボードへのコピーに失敗しました。";
          render();
          return;
        }
        state.copiedSeedAssetId = id;
        render();
        await delay(1500);
        if (state.copiedSeedAssetId === id) {
          state.copiedSeedAssetId = null;
          render();
        }
      }
    }
  } catch (error) {
    state.busy = false;
    state.message = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    if (closesActionDropdowns) {
      closeOpenActionDropdowns();
    }
  }
}

async function loadHome() {
  state.currentProjectId = null;
  state.detail = null;
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.sidebarOpen = false;
  state.generationDraft = null;
  state.inpaintDrafts = {};
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.paintDrafts = {};
  state.maskPanelTab = "mask";
  state.poseDrafts = {};
  state.deletePreviewRoundId = null;
  state.iterationScroll = null;
  state.workflowImportModalOpen = false;
  state.activeWorkflowDiagramTemplateId = null;
  state.settings = await api<ComfySettings>("/api/settings/comfy");
  state.llmSettings = await api<LlmSettings>("/api/settings/llm");
  state.templates = (await api<{ templates: WorkflowTemplate[] }>("/api/templates")).templates;
  state.projects = (await api<{ projects: ProjectSummary[] }>("/api/projects")).projects;
  render();
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
  const restoredDraft = restoreProjectDraft(projectId);
  state.generationDraft = restoredDraft?.generationDraft ?? null;
  state.inpaintDrafts = restoredDraft?.inpaintDrafts ?? {};
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.paintDrafts = {};
  state.maskPanelTab = "mask";
  state.poseDrafts = restoredDraft?.poseDrafts ?? {};
  state.deletePreviewRoundId = null;
  state.iterationScroll = null;
  state.workflowImportModalOpen = false;
  state.activeWorkflowDiagramTemplateId = null;
  render();
  resumeAutoCollectForActiveRounds();
}

async function persistComfySettings() {
  const form = readForm("settings-form");
  state.settings = await api<ComfySettings>("/api/settings/comfy", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: form.baseUrl,
      websocketUrl: form.websocketUrl,
      timeoutSeconds: Number(form.timeoutSeconds),
      storageDir: form.storageDir,
      webSamModelBaseUrl: form.webSamModelBaseUrl
    })
  });
}

async function saveSettings() {
  await persistComfySettings();
  state.message = "ComfyUI接続設定を保存しました。";
  render();
  await refreshComfyStatus(true);
}

/** 「接続」ボタン: 設定の保存と接続テストを1操作にまとめる */
async function connectComfy() {
  await persistComfySettings();
  await testComfy();
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

async function persistLlmSettings() {
  const form = readForm("llm-settings-form");
  state.llmSettings = await api<LlmSettings>("/api/settings/llm", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: form.baseUrl,
      model: form.model,
      systemPrompt: form.systemPrompt,
      temperature: Number(form.temperature)
    })
  });
}

/** 「接続」ボタン: LLM設定の保存と接続テストを1操作にまとめる（ComfyUI側と同じ挙動） */
async function connectLlm() {
  await persistLlmSettings();
  await testLlm();
}

async function testLlm() {
  state.llmConnection = "checking";
  state.llmStatusText = "接続確認中";
  render();
  const result = await api<Json>("/api/llm/test", { method: "POST", body: "{}" });
  state.llmConnection = result.ok === true ? "connected" : "disconnected";
  state.llmStatusText = state.llmConnection === "connected" ? "OpenAI互換 接続済み" : `OpenAI互換 未接続: ${result.error ?? ""}`;
  state.message = JSON.stringify(result, null, 2);
  render();
}

async function refreshLlmStatus() {
  if (!state.llmSettings?.baseUrl.trim() || !state.llmSettings?.model.trim()) {
    state.llmConnection = "unknown";
    state.llmStatusText = "未設定";
    render();
    return;
  }
  state.llmConnection = "checking";
  render();
  try {
    const status = await api<LlmStatus>("/api/llm/status");
    state.llmConnection = status.ok ? "connected" : "disconnected";
    state.llmStatusText = status.ok ? "OpenAI互換 接続済み" : `OpenAI互換 未接続: ${status.error ?? status.baseUrl}`;
  } catch (error) {
    state.llmConnection = "disconnected";
    state.llmStatusText = error instanceof Error ? error.message : String(error);
  }
  render();
}

let improveController: AbortController | null = null;

function cancelImprovePrompt() {
  improveController?.abort();
}

async function improvePrompt() {
  if (state.llmImproving) {
    return;
  }
  const promptValue = state.generationDraft?.prompt ?? "";
  const negativePromptValue = state.generationDraft?.negativePrompt ?? "";
  const controller = new AbortController();
  improveController = controller;
  state.llmImproving = true;
  render();
  try {
    const result = await api<{ prompt: string }>("/api/llm/improve-prompt", {
      method: "POST",
      body: JSON.stringify({ prompt: promptValue, negativePrompt: negativePromptValue }),
      signal: controller.signal
    });
    setPositivePromptDraft(result.prompt);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      throw error;
    }
  } finally {
    if (improveController === controller) {
      improveController = null;
    }
    state.llmImproving = false;
    render();
  }
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
  render();
}

async function loadWorkflowFile(input: HTMLInputElement) {
  const file = input.files?.[0];
  const form = input.closest<HTMLFormElement>("form");
  if (!file || !form) {
    return;
  }

  const text = await file.text();
  const parsed = parseWorkflowFileContent(text);
  if (!parsed.ok) {
    state.message = parsed.error;
    render();
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
  render();
}

async function uploadSourceAsset(input: HTMLInputElement) {
  const file = input.files?.[0];
  input.value = "";
  if (!file || !state.currentProjectId) {
    return;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    state.message = "source asset は PNG / JPEG / WebP 画像を選択してください。";
    render();
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
  render();

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
  render();
}

function exportWorkflowTemplate(target: HTMLElement, kind: "template" | "workflow") {
  const template = findTemplateFromActionTarget(target);
  if (!template) {
    state.message = "エクスポートするWorkflowTemplateがありません。";
    render();
    return;
  }

  if (kind === "workflow") {
    downloadJson(workflowExportFilename(template.name, "workflow"), template.workflowJson);
    state.message = `WorkflowTemplate "${template.name}" のraw workflow JSONを書き出しました。`;
  } else {
    downloadJson(workflowExportFilename(template.name, "template"), buildTemplateExportPayload(template));
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

function render(options: RenderOptions = {}) {
  const preserveIterationScroll = options.preserveIterationScroll ?? true;
  if (preserveIterationScroll) {
    captureIterationScrollPosition();
  } else {
    state.iterationScroll = null;
  }
  if (state.currentProjectId) {
    persistProjectDraft(state.currentProjectId);
  }
  app.innerHTML = `
    ${renderHeader()}
    ${state.message ? `<div class="message"><pre class="message-text">${escapeHtml(state.message)}</pre><button class="message-close" type="button" data-action="dismiss-message" aria-label="メッセージを閉じる" title="閉じる">${iconClose()}</button></div>` : ""}
    ${state.detail ? renderProjectDetailView(state.detail) : renderHome(
      state.projects,
      state.settings,
      state.templates,
      state.llmSettings,
      { state: state.comfyConnection, text: state.comfyStatusText } satisfies ConnectionSummary,
      { state: state.llmConnection, text: state.llmStatusText } satisfies ConnectionSummary
    )}
    ${renderAssetModalView()}
    ${renderWorkflowImportModal(state.workflowImportModalOpen, state.workflowImportDraft)}
    ${renderWorkflowDiagramModal(state.templates, state.activeWorkflowDiagramTemplateId)}
  `;
  invalidateMaskBrushCursorCache();
  restoreIterationScrollPosition();
  if (preserveIterationScroll) {
    requestAnimationFrame(() => {
      restoreIterationScrollPosition();
    });
  }
  refreshIterationEdges();
  syncAssetModalMaskCanvas();
  syncAssetModalPaintCanvas();
  void renderWorkflowDiagramCanvases();
}

function positionIterationEdgePopout(edge: HTMLElement) {
  const popout = edge.querySelector<HTMLElement>(".iteration-edge-popout");
  if (!popout) {
    return;
  }
  const margin = 8;
  const edgeRect = edge.getBoundingClientRect();
  // visibility:hidden 要素でもレイアウトは行われるため offsetWidth/Height は有効。
  const width = popout.offsetWidth;
  const height = popout.offsetHeight;
  let left = edgeRect.left + edgeRect.width / 2 - width / 2;
  left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));
  // 既定はエッジの下、下側に収まらなければ上に反転する。
  let top = edgeRect.bottom + margin;
  if (top + height + margin > window.innerHeight) {
    top = edgeRect.top - height - margin;
  }
  top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));
  popout.style.left = `${Math.round(left)}px`;
  popout.style.top = `${Math.round(top)}px`;
}

function captureIterationScrollPosition() {
  const tracker = document.querySelector<HTMLElement>(".iteration-tracker");
  if (!tracker) {
    return;
  }
  state.iterationScroll = {
    left: tracker.scrollLeft,
    top: tracker.scrollTop
  };
}

function restoreIterationScrollPosition() {
  const tracker = document.querySelector<HTMLElement>(".iteration-tracker");
  if (!tracker || !state.iterationScroll) {
    return;
  }
  tracker.scrollLeft = state.iterationScroll.left;
  tracker.scrollTop = state.iterationScroll.top;
}

let iterationEdgeObserver: ResizeObserver | null = null;

/**
 * イテレーションツリーのエッジ（SVG オーバーレイ）を、現在描画されている
 * `.iteration-forest` に合わせて引き直す。レイアウト確定後に測定したいので rAF 経由。
 * ノードのリフロー（container query での行/列切替やウィンドウリサイズ）に追従するよう
 * ResizeObserver でも再描画する。
 */
function refreshIterationEdges() {
  requestAnimationFrame(() => {
    const forest = document.querySelector<HTMLElement>(".iteration-forest");
    if (!forest) {
      iterationEdgeObserver?.disconnect();
      return;
    }
    drawIterationEdges(forest);
    if (!iterationEdgeObserver) {
      iterationEdgeObserver = new ResizeObserver(() => {
        const current = document.querySelector<HTMLElement>(".iteration-forest");
        if (current) {
          drawIterationEdges(current);
        }
      });
    }
    // render() ごとに forest 要素は作り直されるため、観測対象を貼り直す。
    iterationEdgeObserver.disconnect();
    iterationEdgeObserver.observe(forest);
    const tracker = forest.closest(".iteration-tracker");
    if (tracker) {
      iterationEdgeObserver.observe(tracker);
    }
  });
}

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

function renderHeader() {
  const connection = getConnectionView();
  return `
    <header class="app-header">
      <div class="header-left">
        <button class="icon-button menu-button" data-action="toggle-sidebar" type="button" aria-label="設定を開く">${iconMenu()}</button>
        <button class="brand" data-action="home" type="button">
          <span class="brand-mark"><img src="/spiral.svg" alt="" draggable="false" /></span>
          <span>
            <strong>GURUGURU</strong>
            <small>Iterative Generation Studio</small>
          </span>
        </button>
      </div>
      <div class="header-right">
        <button class="connection" type="button" data-action="check-comfy-connection" title="クリックして接続状態を再確認" ${state.comfyConnection === "checking" ? "disabled" : ""}>
          <span class="status-dot ${connection.className}"></span>
          <span title="${escapeAttr(state.comfyStatusText)}">${escapeHtml(connection.label)}</span>
        </button>
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

function renderProjectDetailView(detail: ProjectDetail) {
  const activeRound = getActiveRound(detail);
  const assets = getActiveRoundAssets().filter(assetPassesFilter);
  const selectedAssets = getActiveRoundAssets().filter((asset) => asset.status === "selected");
  const activeAsset = state.activeAssetId ? findAsset(state.activeAssetId) : null;
  const roundActive = isRoundActive(activeRound);

  return renderProjectDetail(
    detail,
    activeRound,
    assets,
    selectedAssets,
    state.sidebarOpen,
    state.gridCols,
    roundActive,
    state.activeRoundId,
    state.deletePreviewRoundId,
    state.busy,
    renderGenerationPanelView(detail, activeAsset),
    (assetId: string) => inpaintDraftForAsset(assetId),
    (assetId: string) => poseDraftForAsset(assetId),
    state.showMaskGridTag,
    state.copiedSeedAssetId,
    state.sidebarCollapsed
  );
}

function renderGenerationPanelView(detail: ProjectDetail, activeAsset: Asset | null) {
  const activeRound = getActiveRound(detail);
  const draft = state.generationDraft;
  const draftParent = findAsset(draft?.parentAssetId ?? "");
  const previous = activeAsset ?? draftParent ?? getPreferredParentAsset();
  const activeInpaint = previous?.id ? inpaintDraftForAsset(previous.id) : null;
  const llmConfigured = Boolean(state.llmSettings?.baseUrl.trim() && state.llmSettings?.model.trim());
  return renderGenerationPanel(detail, activeRound, previous, draft, activeInpaint, llmConfigured, state.llmImproving);
}

function renderAssetModalView() {
  const asset = state.activeAssetId ? findAsset(state.activeAssetId) : null;
  if (!asset) {
    return "";
  }
  const inpaint = inpaintDraftForAsset(asset.id);
  const editing = state.maskEditMode;
  const promptValue = currentPositivePromptValue(asset);
  const batchSizeValue = currentBatchSizeValue();
  const paintDraft = state.paintEditMode ? paintDraftForAsset(asset.id) ?? defaultPaintDraft(asset.id) : null;
  const poseDraft = poseDraftForAsset(asset.id);
  const generationParams: MaskGenerationParams = {
    steps: currentStepsValue(),
    cfg: currentCfgValue(),
    denoise: currentDenoiseValue(),
    width: currentWidthValue(),
    height: currentHeightValue(),
    seed: currentSeedValue(),
    seedMode: currentSeedModeValue(),
    sampler: currentSamplerValue(),
    scheduler: currentSchedulerValue()
  };
  return renderAssetModal(
    asset,
    inpaint,
    editing,
    promptValue,
    batchSizeValue,
    state.maskPanelWidths,
    state.paintEditMode,
    paintDraft,
    state.maskPanelTab,
    poseDraft,
    generationParams,
    state.sidebarCollapsed,
    getSelectedPoseEdges()
  );
}

function captureWorkflowImportDraftFromElement(target: Element) {
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

function refreshWorkflowImportPreview() {
  const preview = document.querySelector<HTMLElement>(".workflow-import-preview-slot");
  if (!preview) {
    return;
  }
  preview.innerHTML = renderWorkflowImportPreview(state.workflowImportDraft);
  void renderWorkflowDiagramCanvases();
}

