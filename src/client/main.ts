import {
  defaultDenoiseForMode,
  normalizeDenoiseForMode,
  relationForGenerationMode,
  requiresFullDenoise,
  requiresParentAsset
} from "../shared/generationMode";
import { DEFAULT_POSE_MODEL_BASE_URL, DEFAULT_WEB_SAM_MODEL_BASE_URL } from "../shared/constants";
import type { ComfySettings, GenerationMode, GenerationRequest, InpaintOptions } from "../shared/types";
import type {
  Asset,
  AssetParent,
  CollectRoundResponse,
  ComfyStatus,
  ProjectDetail,
  ProjectRow,
  ProjectSummary,
  Round
} from "../shared/apiTypes";
import {
  iconClose,
  iconDiagram,
  iconLoop,
  iconMenu
} from "./icons";
import { buildWebSamModelUrls, formatModelBytes, modelForProvider, SMART_MASK_PROVIDERS } from "./websam/models";
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
import { defaultModeForTemplate, templateGenerationDefaults } from "./workflowDefaults";
import {
  renderWorkflowDiagramCanvases,
  renderWorkflowDiagramModal,
  renderWorkflowImportModal,
  renderWorkflowImportPreview
} from "./workflowUi";
import { renderHome } from "./views/homeView";
import { renderIterationTracker } from "./views/iterationTree";
import { renderProjectDetail, renderSourceUploadButton } from "./views/galleryView";
import { defaultPrompt, defaultNegativePrompt, renderGenerationPanel } from "./views/generationPanel";
import { renderAssetModal, type MaskPanelTab } from "./views/assetModal";
import type {
  WebSamModelStatus,
  WebSamPromptMode,
  WebSamProviderId,
  WebSamWorkerCandidate,
  WebSamWorkerRequest,
  WebSamWorkerResponse
} from "./websam/types";
import type {
  ActiveBoxPrompt,
  ActiveImagePan,
  ActiveMaskStroke,
  InpaintDraft,
  MaskBrushCursorKind,
  MaskLayerSet,
  MaskStrokeKind,
  SamMaskCandidate
} from "./maskTypes";
import {
  defaultInpaintDraft,
  hasMaskData,
  isMaskedContent,
  normalizeInpaintDraft
} from "./maskDraft";
import {
  canvasHasMaskPixels,
  clearCanvas,
  composeFinalMaskDataUrl,
  createMaskLayerSet,
  dirtyRectForSegments,
  distanceToSegmentSq,
  drawDataUrlIntoCanvas,
  invertMaskLayers,
  maskLayerForStroke,
  normalizePromptBox,
  paintStroke,
  pointerToMaskCanvasPoint,
  pointerToSvgViewBoxPoint,
  renderFinalMaskToCanvas,
  sampleBrushPromptPoints
} from "./maskCanvas";
import type { PaintDraft, PaintToolKind } from "./paintTypes";
import { PAINT_BASE_PALETTE, PAINT_UNDO_STACK_LIMIT } from "./paintTypes";
import { defaultPaintDraft, normalizePaintDraft, pushRecentColor } from "./paintDraft";
import {
  composePaintResultCanvas,
  createPaintLayerCanvas,
  renderPaintLayerToCanvas,
  restorePaintLayerFromSnapshot,
  sampleColorAt,
  snapshotPaintLayer
} from "./paintCanvas";
import { renderPaintToolPanel } from "./views/paintPanel";
import { buildPoseModelUrls, defaultPoseModel } from "./pose/models";
import type { PoseWorkerProgress, PoseWorkerRequest, PoseWorkerResponse } from "./pose/types";
import type { PoseDraft } from "./poseTypes";
import { defaultPoseDraft, mediapipeToOpenPose, normalizePoseDraft } from "./poseDraft";

type ComfyConnectionState = "unknown" | "checking" | "connected" | "disconnected";

interface ScrollPosition {
  left: number;
  top: number;
}

const generationDraftFields = [
  "templateId",
  "img2imgTemplateId",
  "parentAssetId",
  "prompt",
  "negativePrompt",
  "seed",
  "seedMode",
  "batchSize",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "denoise",
  "width",
  "height",
  "generationMode"
] as const;
type GenerationDraftField = typeof generationDraftFields[number];
type GenerationDraft = Partial<Record<GenerationDraftField, string>> & {
  inpaint?: InpaintDraft | null;
};

const app = document.querySelector<HTMLDivElement>("#app")!;
const messageAutoClearMs = 15_000;
let messageValue = "";
let messageClearTimer: number | null = null;
let pendingAssetCardSelect: { assetId: string; timer: number } | null = null;
let pendingIterationDotSelect: { timer: number } | null = null;
let activeMaskStroke: ActiveMaskStroke | null = null;
let activeBoxPrompt: ActiveBoxPrompt | null = null;
let activeImagePan: ActiveImagePan | null = null;

interface ActivePoseJointDrag {
  pointerId: number;
  assetId: string;
  jointIndex: number;
  start: { x: number; y: number };
  current: { x: number; y: number };
  /** 閾値を超えて動いたら true。click（visible トグル）と drag（移動）の判定に使う。 */
  moved: boolean;
}

const POSE_JOINT_DRAG_THRESHOLD = 3;
let activePoseJointDrag: ActivePoseJointDrag | null = null;

interface ActiveWorkflowDiagramPan {
  pointerId: number;
  element: HTMLElement;
  startClient: { x: number; y: number };
  originPan: { x: number; y: number };
}

let activeWorkflowDiagramPan: ActiveWorkflowDiagramPan | null = null;
let maskToolbarDrag: { pointerId: number; startX: number; startY: number; originLeft: number; originTop: number } | null = null;
let maskPanelResize: { pointerId: number; side: "left" | "right"; startX: number; startWidth: number; pendingWidth: number } | null = null;
const maskLayerCache = new Map<string, MaskLayerSet>();
const paintLayerCache = new Map<string, HTMLCanvasElement>();
const paintUndoStacks = new Map<string, HTMLCanvasElement[]>();
let activePaintStroke: { pointerId: number; x: number; y: number; pendingSegments: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> } | null = null;
let paintStrokeRafHandle: number | null = null;
let paintAltEyedropperActive = false;
let webSamWorker: Worker | null = null;
let webSamRequestId = 0;
let latestWebSamLoadRequestId = 0;
let latestWebSamEncodeRequestId = 0;
let latestWebSamDecodeRequestId = 0;
let poseWorker: Worker | null = null;
let poseRequestId = 0;
let latestPoseLoadRequestId = 0;
let latestPoseDetectRequestId = 0;
let posePendingDetect = false;

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
  generationDraft: GenerationDraft | null;
  inpaintDrafts: Record<string, InpaintDraft>;
  iterationScroll: ScrollPosition | null;
  maskEditMode: boolean;
  maskToolbarMinimized: boolean;
  maskToolbarPos: { left: number; top: number } | null;
  maskPanelWidths: { left: number; right: number };
  showMaskGridTag: boolean;
  copiedSeedAssetId: string | null;
  deletePreviewRoundId: string | null;
  workflowImportModalOpen: boolean;
  workflowImportDraft: WorkflowImportDraft;
  activeWorkflowDiagramTemplateId: string | null;
  paintEditMode: boolean;
  paintDrafts: Record<string, PaintDraft>;
  maskPanelTab: MaskPanelTab;
  poseDrafts: Record<string, PoseDraft>;
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
  get message() {
    return messageValue;
  },
  set message(value: string) {
    messageValue = value;
    scheduleMessageClear(value);
  },
  generationDraft: null,
  inpaintDrafts: {},
  iterationScroll: null,
  maskEditMode: false,
  maskToolbarMinimized: false,
  maskToolbarPos: null,
  maskPanelWidths: { left: 300, right: 300 },
  showMaskGridTag: true,
  copiedSeedAssetId: null,
  deletePreviewRoundId: null,
  workflowImportModalOpen: false,
  workflowImportDraft: defaultWorkflowImportDraft(),
  activeWorkflowDiagramTemplateId: null,
  paintEditMode: false,
  paintDrafts: {},
  maskPanelTab: "mask",
  poseDrafts: {}
};

const pendingAutoCollectRoundIds = new Set<string>();
const autoCollectIntervalMs = 3_000;
void boot();

function scheduleMessageClear(value: string) {
  if (messageClearTimer) {
    window.clearTimeout(messageClearTimer);
    messageClearTimer = null;
  }
  if (!value) {
    return;
  }

  messageClearTimer = window.setTimeout(() => {
    if (messageValue === value) {
      messageValue = "";
      render();
    }
  }, messageAutoClearMs);
}

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
      updatePoseDraftFromControl(target);
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
    if (target.dataset.generationField === "batchSize" && target instanceof HTMLInputElement) {
      setGenerationSliderDraft("batchSize", target);
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

    if (state.paintEditMode) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoPaintStroke();
        return;
      }
      if (event.key === "Alt" && !event.repeat) {
        beginAltEyedropper();
      }
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
    if (event.key === "Alt") {
      endAltEyedropper();
    }
  });

  window.addEventListener("blur", () => {
    endAltEyedropper();
  });

  app.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    closeOpenActionDropdowns(target);
    if (state.maskEditMode && state.maskPanelTab === "pose" && (event.button === 0 || event.button === 2)) {
      const joint = (target as Element).closest<SVGCircleElement>(".pose-joint");
      if (joint) {
        event.preventDefault();
        beginPoseJointDrag(event, joint);
        return;
      }
    }
    const handle = target.closest<HTMLElement>("[data-mask-toolbar-handle]");
    if (handle) {
      if (target.closest("button")) {
        return;
      }
      const toolbar = handle.closest<HTMLElement>(".mask-toolbar");
      if (toolbar) {
        if (toolbar.classList.contains("minimized")) {
          return;
        }
        event.preventDefault();
        beginMaskToolbarDrag(event, toolbar);
      }
      return;
    }
    const panelResizer = target.closest<HTMLElement>("[data-mask-panel-resizer]");
    if (panelResizer) {
      const side = panelResizer.dataset.maskPanelResizer === "right" ? "right" : "left";
      event.preventDefault();
      panelResizer.classList.add("resizing");
      maskPanelResize = {
        pointerId: event.pointerId,
        side,
        startX: event.clientX,
        startWidth: state.maskPanelWidths[side],
        pendingWidth: state.maskPanelWidths[side]
      };
      return;
    }
    const previewMedia = target.closest<HTMLElement>(".preview-media");
    const activeAssetId = state.activeAssetId;
    const shouldPanImage =
      !!previewMedia &&
      !!activeAssetId &&
      (event.button === 1 || (!state.maskEditMode && !state.paintEditMode && event.button === 0));
    if (shouldPanImage) {
      event.preventDefault();
      beginImagePan(event, previewMedia, activeAssetId);
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
    if (target.id === "paintCanvas") {
      if (!state.paintEditMode) {
        return;
      }
      event.preventDefault();
      beginPaintStroke(event, target as HTMLCanvasElement);
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
    if (activeImagePan) {
      if (event.pointerId !== activeImagePan.pointerId) {
        return;
      }
      event.preventDefault();
      continueImagePan(event);
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
    if (maskPanelResize) {
      if (event.pointerId !== maskPanelResize.pointerId) {
        return;
      }
      event.preventDefault();
      continueMaskPanelResize(event);
      return;
    }
    if (maskToolbarDrag) {
      if (event.pointerId !== maskToolbarDrag.pointerId) {
        return;
      }
      const toolbar = document.querySelector<HTMLElement>(".mask-toolbar");
      if (toolbar) {
        event.preventDefault();
        moveMaskToolbarDrag(event, toolbar);
      }
      return;
    }
    if (activeBoxPrompt) {
      if (event.pointerId !== activeBoxPrompt.pointerId) {
        return;
      }
      const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
      if (!canvas) {
        return;
      }
      event.preventDefault();
      continueWebSamBoxPrompt(event, canvas);
      return;
    }
    if (activePoseJointDrag) {
      if (event.pointerId !== activePoseJointDrag.pointerId) {
        return;
      }
      const svg = document.querySelector<SVGSVGElement>(".pose-overlay");
      if (!svg) {
        return;
      }
      event.preventDefault();
      continuePoseJointDrag(event, svg);
      return;
    }
    if (activePaintStroke) {
      if (event.pointerId !== activePaintStroke.pointerId) {
        return;
      }
      const paintCanvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
      if (!paintCanvas) {
        return;
      }
      event.preventDefault();
      continuePaintStroke(event, paintCanvas);
      return;
    }
    if (!activeMaskStroke) {
      return;
    }
    const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
    if (!canvas || event.pointerId !== activeMaskStroke.pointerId) {
      return;
    }
    event.preventDefault();
    continueMaskStroke(event, canvas);
  });

  app.addEventListener("pointerup", (event) => {
    if (activeImagePan && event.pointerId === activeImagePan.pointerId) {
      event.preventDefault();
      finishImagePan();
      return;
    }
    if (activeWorkflowDiagramPan && event.pointerId === activeWorkflowDiagramPan.pointerId) {
      event.preventDefault();
      finishWorkflowDiagramPan();
      return;
    }
    if (maskPanelResize && event.pointerId === maskPanelResize.pointerId) {
      finishMaskPanelResize();
      return;
    }
    if (maskToolbarDrag && event.pointerId === maskToolbarDrag.pointerId) {
      finishMaskToolbarDrag();
      return;
    }
    if (activeBoxPrompt && event.pointerId === activeBoxPrompt.pointerId) {
      const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
      if (canvas) {
        event.preventDefault();
        finishWebSamBoxPrompt(canvas);
      }
      return;
    }
    if (activePoseJointDrag && event.pointerId === activePoseJointDrag.pointerId) {
      event.preventDefault();
      finishPoseJointDrag();
      return;
    }
    if (activePaintStroke && event.pointerId === activePaintStroke.pointerId) {
      const paintCanvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
      if (paintCanvas) {
        event.preventDefault();
        finishPaintStroke(paintCanvas);
      }
      return;
    }
    if (!activeMaskStroke || event.pointerId !== activeMaskStroke.pointerId) {
      return;
    }
    const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
    if (canvas) {
      event.preventDefault();
      finishMaskStroke(canvas);
    }
  });

  app.addEventListener("pointercancel", (event) => {
    if (activeImagePan && event.pointerId === activeImagePan.pointerId) {
      activeImagePan = null;
      return;
    }
    if (activeWorkflowDiagramPan && event.pointerId === activeWorkflowDiagramPan.pointerId) {
      activeWorkflowDiagramPan = null;
      return;
    }
    if (maskPanelResize && event.pointerId === maskPanelResize.pointerId) {
      finishMaskPanelResize();
      return;
    }
    if (maskToolbarDrag && event.pointerId === maskToolbarDrag.pointerId) {
      maskToolbarDrag = null;
      return;
    }
    if (activeBoxPrompt && event.pointerId === activeBoxPrompt.pointerId) {
      activeBoxPrompt = null;
      return;
    }
    if (activePoseJointDrag && event.pointerId === activePoseJointDrag.pointerId) {
      activePoseJointDrag = null;
      return;
    }
    if (activePaintStroke && event.pointerId === activePaintStroke.pointerId) {
      const paintCanvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
      if (paintCanvas) {
        finishPaintStroke(paintCanvas);
      }
      return;
    }
    if (!activeMaskStroke || event.pointerId !== activeMaskStroke.pointerId) {
      return;
    }
    const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
    if (canvas) {
      finishMaskStroke(canvas);
    }
  });
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

function previewRoundDeletion(roundId: string) {
  state.deletePreviewRoundId = roundId;
  render();
}

function selectRound(roundId: string) {
  preserveGenerationDenoise();
  state.activeRoundId = roundId;
  state.activeAssetId = null;
  state.deletePreviewRoundId = null;
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  activeImagePan = null;
  render();
}

function preserveGenerationDenoise() {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  const denoiseControl = form?.elements.namedItem("denoise") as HTMLInputElement | null;
  const denoiseValue = denoiseControl?.value ?? state.generationDraft?.denoise;
  state.generationDraft = denoiseValue ? { denoise: denoiseValue } : null;
}

function openAssetDetail(assetId: string) {
  state.activeAssetId = assetId;
  const draft = inpaintDraftForAsset(assetId);
  state.maskEditMode = draft?.enabled === true;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.maskToolbarMinimized = false;
  state.maskToolbarPos = null;
  activeImagePan = null;
  render();
}

function closeAssetDetail() {
  commitActiveMaskCanvas();
  cancelPendingMaskStrokeFlush();
  flushPendingMaskWheelZoom();
  cancelPendingPaintStrokeFlush();
  activeMaskStroke = null;
  activeBoxPrompt = null;
  activePaintStroke = null;
  activeImagePan = null;
  void destroyWebSamWorkerSession();
  void destroyPoseWorkerSession();
  posePendingDetect = false;
  state.activeAssetId = null;
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  state.maskToolbarMinimized = false;
  state.maskToolbarPos = null;
  maskToolbarDrag = null;
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
    if (action === "home") {
      await loadHome();
    } else if (action === "toggle-sidebar") {
      state.sidebarOpen = !state.sidebarOpen;
      render();
    } else if (action === "save-settings") {
      await saveSettings();
    } else if (action === "test-comfy") {
      await testComfy();
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
    } else if (action === "select-round") {
      selectRound(id);
    } else if (action === "collect-round") {
      await collectRound(id);
    } else if (action === "interrupt-round") {
      await interruptRound(id);
    } else if (action === "delete-round") {
      await deleteRoundTree(id);
    } else if (action === "cancel-delete-round") {
      state.deletePreviewRoundId = null;
      render();
    } else if (action === "generate-round") {
      await generateRound(null);
    } else if (action === "img2img-next") {
      await generateFromSelected("img2img");
    } else if (action === "generate-from-preview") {
      commitActiveMaskCanvas();
      const asset = findAsset(id);
      if (asset) {
        await generateRound(asset, target.dataset.mode ?? "img2img");
      }
    } else if (action === "asset-detail") {
      openAssetDetail(id);
    } else if (action === "close-detail") {
      closeAssetDetail();
    } else if (action === "toggle-mask-editor") {
      toggleMaskEditor();
    } else if (action === "toggle-paint-editor") {
      togglePaintEditor();
    } else if (action === "paint-tool") {
      setPaintTool(target.dataset.tool as PaintToolKind);
    } else if (action === "paint-color") {
      setPaintColor(target.dataset.color ?? "#ffffff");
    } else if (action === "paint-clear") {
      clearActivePaintCanvas();
    } else if (action === "paint-undo") {
      undoPaintStroke();
    } else if (action === "paint-save") {
      await savePaintResultAsSourceAsset();
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
    } else if (action === "apply-mask-editor") {
      await applyMaskEditor();
    } else if (action === "set-smart-mask-provider") {
      const provider = target.dataset.provider ?? "";
      if (isSmartMaskProvider(provider)) {
        setSmartMaskProvider(provider);
      }
    } else if (action === "minimize-mask-toolbar") {
      state.maskToolbarMinimized = true;
      render();
    } else if (action === "restore-mask-toolbar") {
      state.maskToolbarMinimized = false;
      render();
    } else if (action === "mask-tool") {
      setMaskTool(target.dataset.tool === "eraser");
    } else if (action === "clear-mask") {
      clearActiveMaskCanvas();
    } else if (action === "invert-mask") {
      await invertActiveMask();
    } else if (action === "set-mask-panel-tab") {
      setMaskPanelTab(target.dataset.tab === "pose" ? "pose" : "mask");
    } else if (action === "pose-load-model") {
      await loadActivePoseModel();
    } else if (action === "pose-detect") {
      await requestPoseDetect();
    } else if (action === "pose-reset") {
      await resetPoseDetection();
    } else if (action === "websam-load-model" || action === "websam-retry") {
      await loadActiveWebSamModel();
    } else if (action === "websam-decode") {
      await requestWebSamDecode();
    } else if (action === "websam-candidate") {
      selectSamCandidate(Number(target.dataset.index ?? 0));
    } else if (action === "websam-apply-candidate") {
      await applySelectedSamCandidate();
    } else if (action === "websam-clear-prompts") {
      clearWebSamPrompts();
    } else if (action === "websam-clear-result") {
      clearWebSamResult();
    } else if (action === "websam-clear-manual") {
      clearManualMaskLayers();
    } else if (action === "clear-inpaint") {
      clearInpaintDraft();
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
    } else if (action === "reset-generation-params") {
      resetGenerationParamsToTemplateDefaults();
    } else if (action === "random-seed") {
      randomSeed();
    } else if (action === "swap-resolution") {
      swapResolution();
    } else if (action === "scale-resolution") {
      scaleResolution(target.dataset.scaleDirection === "down" ? -1 : 1);
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
  render();
  resumeAutoCollectForActiveRounds();
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
  if (!state.activeAssetId) {
    state.maskEditMode = false;
    state.paintEditMode = false;
  }
  resumeAutoCollectForActiveRounds();
}

function resumeAutoCollectForActiveRounds() {
  if (!state.currentProjectId || !state.detail) {
    return;
  }
  for (const round of state.detail.rounds) {
    if (isRoundActive(round)) {
      void pollCollectRound(round.id, state.currentProjectId);
    }
  }
}

function isRoundActive(round: Round | null | undefined) {
  return !!round && isRoundActiveStatus(round.status);
}

function isRoundActiveStatus(status: string) {
  return status === "pending" || status === "running";
}

function terminalRoundMessage(status: string) {
  if (status === "completed") {
    return "生成が完了しました。";
  }
  if (status === "interrupted") {
    return "生成は停止済みです。保存済みの画像はこのままブランチングに使えます。";
  }
  if (status === "failed") {
    return "生成に失敗しました。保存済みの画像があればこのままブランチングに使えます。";
  }
  return `生成状態: ${status}`;
}

async function saveSettings() {
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

async function createProject() {
  const form = readForm("project-form");
  const result = await api<{ project: ProjectRow }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name: form.name,
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
  const resolvedParentAsset = resolveParentAssetForGeneration(parentAsset, generationMode, form.parentAssetId);
  const parentAssetId = resolvedParentAsset?.id ?? null;
  const requestedTemplateId = generationMode === "img2img"
    ? form.img2imgTemplateId || form.templateId
    : form.templateId;
  const template = resolveTemplateForGeneration(requestedTemplateId, generationMode);
  const denoise = normalizeDenoiseForMode(
    Number(form.denoise || defaultDenoiseForMode(generationMode)),
    generationMode
  );
  const inpaint = inpaintRequestForParent(parentAssetId, generationMode);
  const request: GenerationRequest = {
    templateId: template.id,
    prompt: form.prompt,
    negativePrompt: form.negativePrompt,
    seed: form.seed ? Number(form.seed) : null,
    seedMode: form.seedMode as GenerationRequest["seedMode"],
    batchSize: Number(form.batchSize || 16),
    steps: Number(form.steps || 20),
    cfg: Number(form.cfg || 6),
    sampler: form.sampler || "euler",
    scheduler: form.scheduler || "normal",
    denoise,
    width: Number(form.width || 1024),
    height: Number(form.height || 1024),
    generationMode: generationMode as GenerationMode,
    parentAssetId,
    relationType: resolvedParentAsset ? relationForGenerationMode(generationMode) : null
  };
  if (inpaint) {
    request.inpaint = inpaint;
  }
  setGenerationDraftValue(generationMode === "img2img" ? "img2imgTemplateId" : "templateId", template.id);
  setGenerationDraftValue("generationMode", generationMode);

  state.busy = true;
  render();
  const response = await api<{ promptId: string; round: Round }>(`/api/projects/${state.currentProjectId}/rounds`, {
    method: "POST",
    body: JSON.stringify(request)
  });
  const roundId = response.round.id;
  const previousInpaint = parentAssetId ? inpaintDraftForAsset(parentAssetId) : null;
  state.generationDraft = generationDraftFromRequest(response.round.request);
  if (previousInpaint && inpaint && previousInpaint.parentAssetId === parentAssetId) {
    state.generationDraft.inpaint = previousInpaint;
  }
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
  prepareGenerationFormForParent(asset, mode);
  await generateRound(asset, mode);
}

function resolveParentAssetForGeneration(parentAsset: Asset | null, generationMode: string, formParentAssetId: string | null | undefined) {
  if (parentAsset) {
    return parentAsset;
  }
  if (!requiresParentAsset(generationMode)) {
    return null;
  }
  return findAsset(formParentAssetId ?? "");
}

async function collectRound(roundId: string) {
  const result = await api<CollectRoundResponse>(`/api/rounds/${roundId}/collect`, {
    method: "POST",
    body: "{}"
  });
  const count = result.assets?.length ?? 0;
  state.message = count > 0
    ? `生成画像を取り込みました。${count}件`
    : String(result.message ?? "まだ出力画像はありません。");
  await refreshProject(roundId, state.activeAssetId);
  render();
}

async function interruptRound(roundId: string) {
  const result = await api<Json>(`/api/rounds/${roundId}/interrupt`, {
    method: "POST",
    body: "{}"
  });
  pendingAutoCollectRoundIds.delete(roundId);
  if (result.deleteError || result.interruptError) {
    state.message = `停止要求を完了できませんでした: ${String(result.deleteError ?? result.interruptError)}`;
  } else {
    state.message = result.interrupted
    ? "生成を停止しました。保存済みの画像はこのままブランチングに使えます。"
    : "未実行の生成を停止しました。保存済みの画像はこのままブランチングに使えます。";
  }
  await refreshProject(roundId, state.activeAssetId);
  render();
}

async function deleteRoundTree(roundId: string) {
  if (!state.currentProjectId) {
    return;
  }

  const result = await api<{ deleted: boolean; roundIds: string[]; deletedCount: number }>(`/api/rounds/${roundId}`, {
    method: "DELETE"
  });
  const deletedRoundIds = new Set(result.roundIds);
  for (const deletedRoundId of deletedRoundIds) {
    pendingAutoCollectRoundIds.delete(deletedRoundId);
  }

  const keepRoundId = state.activeRoundId && !deletedRoundIds.has(state.activeRoundId) ? state.activeRoundId : null;
  state.activeAssetId = null;
  state.deletePreviewRoundId = null;
  await refreshProject(keepRoundId, null);
  state.message = `${result.deletedCount}件のイテレーションを削除しました。`;
  render();
}

async function pollCollectRound(roundId: string, projectId: string | null) {
  if (!projectId || pendingAutoCollectRoundIds.has(roundId)) {
    return;
  }
  pendingAutoCollectRoundIds.add(roundId);

  try {
    while (true) {
      await delay(autoCollectIntervalMs);
      if (state.currentProjectId !== projectId) {
        return;
      }

      const knownAssetCount = knownRoundAssetCount(roundId);
      const result = await api<CollectRoundResponse>(`/api/rounds/${roundId}/collect`, {
        method: "POST",
        body: "{}"
      });

      const count = result.assets?.length ?? 0;
      const status = result.round?.status;
      const responseAssetCount = responseRoundAssetCount(result.round);
      const displayedAssetCountChanged = responseAssetCount !== null && responseAssetCount !== knownAssetCount;
      if (count > 0 || displayedAssetCountChanged) {
        const collectedCount = responseAssetCount !== null
          ? Math.max(0, responseAssetCount - knownAssetCount)
          : count;
        state.message = collectedCount > 0
          ? `生成画像を自動で取り込みました。${collectedCount}件`
          : "生成画像を自動で更新しました。";
        await refreshProject(roundId, state.activeAssetId);
        render();
      } else if (status && !isRoundActiveStatus(status)) {
        state.message = terminalRoundMessage(status);
        await refreshProject(roundId, state.activeAssetId);
        render();
        return;
      }

      if (status && !isRoundActiveStatus(status)) {
        return;
      }
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

function knownRoundAssetCount(roundId: string) {
  const round = findRound(roundId);
  if (typeof round?.assetCount === "number") {
    return round.assetCount;
  }
  return state.detail?.assets.filter((asset) => asset.roundId === roundId).length ?? 0;
}

function responseRoundAssetCount(round: Round | null | undefined) {
  return typeof round?.assetCount === "number" ? round.assetCount : null;
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
  captureGenerationDraft();
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
  captureGenerationDraft();
}

function scaleResolution(direction: -1 | 1) {
  const widthInput = document.querySelector<HTMLInputElement>('input[name="width"]');
  const heightInput = document.querySelector<HTMLInputElement>('input[name="height"]');
  if (!widthInput || !heightInput) {
    return;
  }

  const width = resolutionValue(widthInput, 1024);
  const height = resolutionValue(heightInput, 1024);
  if (width <= 0 || height <= 0) {
    return;
  }

  const step = 64;
  const latentStep = 8;
  let nextWidth = width;
  let nextHeight = height;
  if (width <= height) {
    nextWidth = Math.max(step, width + step * direction);
    nextHeight = roundToStep((nextWidth * height) / width, latentStep);
  } else {
    nextHeight = Math.max(step, height + step * direction);
    nextWidth = roundToStep((nextHeight * width) / height, latentStep);
  }

  widthInput.value = String(Math.max(latentStep, nextWidth));
  heightInput.value = String(Math.max(latentStep, nextHeight));
  captureGenerationDraft();
}

function resolutionValue(input: HTMLInputElement, fallback: number) {
  const value = Number(input.value);
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;
}

function roundToStep(value: number, step: number) {
  return Math.max(step, Math.round(value / step) * step);
}

type RenderOptions = {
  preserveIterationScroll?: boolean;
};

function render(options: RenderOptions = {}) {
  const preserveIterationScroll = options.preserveIterationScroll ?? true;
  if (preserveIterationScroll) {
    captureIterationScrollPosition();
  } else {
    state.iterationScroll = null;
  }
  app.innerHTML = `
    ${renderHeader()}
    ${state.message ? `<pre class="message"><button class="message-close" type="button" data-action="dismiss-message" aria-label="メッセージを閉じる" title="閉じる">${iconClose()}</button>${escapeHtml(state.message)}</pre>` : ""}
    ${state.detail ? renderProjectDetailView(state.detail) : renderHome(state.projects, state.settings, state.templates)}
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
  syncAssetModalMaskCanvas();
  syncAssetModalPaintCanvas();
  void renderWorkflowDiagramCanvases();
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

function syncAssetModalMaskCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  if (!canvas || !image) {
    return;
  }

  const sync = () => {
    const asset = findAsset(canvas.dataset.assetId ?? "");
    const width = image.naturalWidth || assetDimension(asset, "width") || Math.max(1, Math.round(image.clientWidth));
    const height = image.naturalHeight || assetDimension(asset, "height") || Math.max(1, Math.round(image.clientHeight));
    if (!width || !height) {
      return;
    }

    canvas.width = width;
    canvas.height = height;
    const draft = inpaintDraftForAsset(canvas.dataset.assetId);
    if (!draft) {
      const context = canvas.getContext("2d");
      context?.clearRect(0, 0, width, height);
      return;
    }
    if (draft.imageWidth !== width || draft.imageHeight !== height) {
      setInpaintDraft({ ...draft, imageWidth: width, imageHeight: height });
    }
    canvas.style.opacity = String(clampNumber(draft.maskOpacity, 0, 1, 0.58));
    void ensureMaskLayerSet(draft, width, height).then((layers) => {
      if (!canvas.isConnected || canvas.dataset.assetId !== draft.parentAssetId) {
        return;
      }
      renderFinalMaskToCanvas(canvas, layers, draft, true);
    });
  };

  if (image.complete && image.naturalWidth > 0) {
    sync();
  } else {
    image.addEventListener("load", sync, { once: true });
  }

  canvas.addEventListener("pointermove", updateMaskBrushCursor);
  canvas.addEventListener("pointerdown", updateMaskBrushCursor);
  canvas.addEventListener("pointerenter", updateMaskBrushCursor);
  canvas.addEventListener("pointerleave", hideMaskBrushCursor);
  canvas.addEventListener("pointercancel", hideMaskBrushCursor);
}

function resolveMaskBrushCursorKind(draft: InpaintDraft): MaskBrushCursorKind | null {
  if (draft.selectedSmartMaskProvider !== "manual") {
    return draft.webSamPromptMode === "brush" ? "brush-prompt" : null;
  }
  return draft.eraser ? "eraser" : "pen";
}

// Cached `.brush-cursor` element reference, avoiding a `document.querySelector` on every
// pointermove. `undefined` means "not resolved for the current render cycle yet"; `null` means
// "resolved, and the element does not currently exist". Invalidated by `invalidateMaskBrushCursorCache`,
// which `render()` calls after rebuilding `app.innerHTML` (the old element is detached each render).
let cachedMaskBrushCursor: SVGCircleElement | null | undefined;

function invalidateMaskBrushCursorCache() {
  cachedMaskBrushCursor = undefined;
}

function getMaskBrushCursorElement(): SVGCircleElement | null {
  if (cachedMaskBrushCursor === undefined || cachedMaskBrushCursor === null || !cachedMaskBrushCursor.isConnected) {
    cachedMaskBrushCursor = document.querySelector<SVGCircleElement>(".brush-cursor");
  }
  return cachedMaskBrushCursor;
}

function updateMaskBrushCursor(event: PointerEvent) {
  const canvas = event.currentTarget as HTMLCanvasElement | null;
  if (!canvas || !state.maskEditMode || state.maskPanelTab === "pose") {
    return;
  }
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!draft) {
    hideMaskBrushCursor();
    return;
  }
  const kind = resolveMaskBrushCursorKind(draft);
  const cursor = getMaskBrushCursorElement();
  if (!cursor || !kind) {
    hideMaskBrushCursor();
    return;
  }
  const point = pointerToMaskCanvasPoint(canvas, event);
  const withinBounds =
    point.x >= 0 && point.x <= canvas.width && point.y >= 0 && point.y <= canvas.height;
  if (!withinBounds) {
    hideMaskBrushCursor();
    return;
  }
  cursor.setAttribute("cx", formatCssNumber(point.x));
  cursor.setAttribute("cy", formatCssNumber(point.y));
  cursor.setAttribute("r", formatCssNumber(draft.brushSize / 2));
  cursor.classList.remove("pen", "eraser", "brush-prompt");
  cursor.classList.add(kind);
  cursor.classList.add("visible");
}

function hideMaskBrushCursor() {
  const cursor = getMaskBrushCursorElement();
  if (!cursor) {
    return;
  }
  cursor.removeAttribute("r");
  cursor.setAttribute("r", "0");
  cursor.classList.remove("visible", "pen", "eraser", "brush-prompt");
}

async function ensureMaskLayerSet(draft: InpaintDraft, width: number, height: number): Promise<MaskLayerSet> {
  let layers = maskLayerCache.get(draft.parentAssetId);
  if (layers && layers.width === width && layers.height === height) {
    return layers;
  }

  layers = createMaskLayerSet(draft.parentAssetId, width, height);
  maskLayerCache.set(draft.parentAssetId, layers);
  await syncMaskLayerSetFromDraft(layers, draft);
  return layers;
}

async function syncMaskLayerSetFromDraft(layers: MaskLayerSet, draft: InpaintDraft) {
  clearCanvas(layers.samMask);
  clearCanvas(layers.previewSamMask);
  clearCanvas(layers.manualInclude);
  clearCanvas(layers.manualErase);
  clearCanvas(layers.brushPrompt);
  await Promise.all([
    drawDataUrlIntoCanvas(layers.samMask, draft.samMaskDataUrl),
    drawDataUrlIntoCanvas(layers.previewSamMask, draft.previewSamMaskDataUrl),
    drawDataUrlIntoCanvas(layers.manualInclude, draft.manualIncludeMaskDataUrl || draft.maskDataUrl),
    drawDataUrlIntoCanvas(layers.manualErase, draft.manualEraseMaskDataUrl),
    drawDataUrlIntoCanvas(layers.brushPrompt, draft.brushPromptMaskDataUrl)
  ]);
}

function commitMaskLayers(assetId: string) {
  const draft = inpaintDraftForAsset(assetId);
  const layers = draft ? maskLayerCache.get(assetId) : null;
  if (!draft || !layers) {
    return;
  }
  setInpaintDraft({
    ...draft,
    samMaskDataUrl: canvasHasMaskPixels(layers.samMask) ? layers.samMask.toDataURL("image/png") : "",
    previewSamMaskDataUrl: draft.previewSamMaskDataUrl,
    manualIncludeMaskDataUrl: canvasHasMaskPixels(layers.manualInclude) ? layers.manualInclude.toDataURL("image/png") : "",
    manualEraseMaskDataUrl: canvasHasMaskPixels(layers.manualErase) ? layers.manualErase.toDataURL("image/png") : "",
    brushPromptMaskDataUrl: canvasHasMaskPixels(layers.brushPrompt) ? layers.brushPrompt.toDataURL("image/png") : "",
    maskDataUrl: composeFinalMaskDataUrl(layers, false)
  });
}

function getOrCreateMaskLayerSet(assetId: string, width: number, height: number): MaskLayerSet {
  let layers = maskLayerCache.get(assetId);
  if (layers && layers.width === width && layers.height === height) {
    return layers;
  }
  layers = createMaskLayerSet(assetId, width, height);
  maskLayerCache.set(assetId, layers);
  return layers;
}

function addWebSamPointPrompt(event: PointerEvent, canvas: HTMLCanvasElement) {
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensureInpaintDraft(assetId);
  const point = pointerToMaskCanvasPoint(canvas, event);
  const label: 0 | 1 = event.button === 2 || event.altKey || event.shiftKey ? 0 : 1;
  setInpaintDraft({
    ...draft,
    foregroundPoints: [...draft.foregroundPoints, { x: point.x, y: point.y, label, source: "point" }],
    webSamError: "",
    samCandidates: [],
    previewSamMaskDataUrl: ""
  });
  render();
  void requestWebSamDecode();
}

function beginWebSamBoxPrompt(event: PointerEvent, canvas: HTMLCanvasElement) {
  const point = pointerToMaskCanvasPoint(canvas, event);
  activeBoxPrompt = {
    pointerId: event.pointerId,
    start: point,
    current: point
  };
  canvas.setPointerCapture(event.pointerId);
}

function continueWebSamBoxPrompt(event: PointerEvent, canvas: HTMLCanvasElement) {
  if (!activeBoxPrompt) {
    return;
  }
  activeBoxPrompt.current = pointerToMaskCanvasPoint(canvas, event);
}

function finishWebSamBoxPrompt(canvas: HTMLCanvasElement) {
  if (!activeBoxPrompt) {
    return;
  }
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    activeBoxPrompt = null;
    return;
  }
  try {
    canvas.releasePointerCapture(activeBoxPrompt.pointerId);
  } catch {
    // Capture may already be released.
  }
  const box = normalizePromptBox({
    x1: activeBoxPrompt.start.x,
    y1: activeBoxPrompt.start.y,
    x2: activeBoxPrompt.current.x,
    y2: activeBoxPrompt.current.y
  });
  activeBoxPrompt = null;
  if (!box) {
    return;
  }
  const draft = ensureInpaintDraft(assetId);
  setInpaintDraft({
    ...draft,
    boxPrompt: box,
    webSamError: "",
    samCandidates: [],
    previewSamMaskDataUrl: ""
  });
  render();
  void requestWebSamDecode();
}

const BRUSH_PROMPT_POINT_SPACING = 48;
const BRUSH_PROMPT_MAX_POINTS = 48;

function finishBrushPromptStroke(canvas: HTMLCanvasElement) {
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  const draft = assetId ? ensureInpaintDraft(assetId) : null;
  const layers = assetId ? maskLayerCache.get(assetId) : null;
  if (!assetId || !draft || !layers) {
    return;
  }
  const manualPoints = draft.foregroundPoints.filter((point) => point.source !== "brush");
  const sampledPoints = sampleBrushPromptPoints(layers.brushPrompt, BRUSH_PROMPT_POINT_SPACING, BRUSH_PROMPT_MAX_POINTS);
  // TODO: also pass the brushPromptMask bounding box as a SAM box prompt when decoder quality needs the extra constraint.
  setInpaintDraft({
    ...draft,
    foregroundPoints: [...manualPoints, ...sampledPoints],
    brushPromptMaskDataUrl: canvasHasMaskPixels(layers.brushPrompt) ? layers.brushPrompt.toDataURL("image/png") : "",
    samCandidates: [],
    previewSamMaskDataUrl: "",
    maskDataUrl: composeFinalMaskDataUrl(layers, false)
  });
  render();
  void requestWebSamDecode();
}

function removeBrushPromptPointsNearSegment(assetId: string, from: { x: number; y: number }, to: { x: number; y: number }, radius: number) {
  const draft = inpaintDraftForAsset(assetId);
  if (!draft || draft.foregroundPoints.length === 0) {
    return;
  }
  const radiusSq = radius * radius;
  const filtered = draft.foregroundPoints.filter((point) => {
    if (point.source !== "brush") {
      return true;
    }
    return distanceToSegmentSq(point, from, to) > radiusSq;
  });
  if (filtered.length !== draft.foregroundPoints.length) {
    setInpaintDraft({
      ...draft,
      foregroundPoints: filtered,
      samCandidates: [],
      previewSamMaskDataUrl: ""
    });
  }
}

const MASK_PANEL_MIN_WIDTH = 220;
const MASK_PANEL_MAX_WIDTH = 460;

/**
 * ドラッグ中は CSS 変数（`--mask-left-panel` / `--mask-right-panel`）だけを直接更新し、
 * pointerup 時に state へ確定する（wheel zoom / pan と同じ「操作中は render() しない」パターン）。
 */
function continueMaskPanelResize(event: PointerEvent) {
  if (!maskPanelResize) {
    return;
  }
  const delta = event.clientX - maskPanelResize.startX;
  const raw = maskPanelResize.side === "left"
    ? maskPanelResize.startWidth + delta
    : maskPanelResize.startWidth - delta;
  const width = clampNumber(raw, MASK_PANEL_MIN_WIDTH, MASK_PANEL_MAX_WIDTH, maskPanelResize.startWidth);
  maskPanelResize.pendingWidth = width;
  const layout = document.querySelector<HTMLElement>(".mask-editor-layout");
  layout?.style.setProperty(maskPanelResize.side === "left" ? "--mask-left-panel" : "--mask-right-panel", `${width}px`);
}

function finishMaskPanelResize() {
  if (!maskPanelResize) {
    return;
  }
  state.maskPanelWidths = {
    ...state.maskPanelWidths,
    [maskPanelResize.side]: maskPanelResize.pendingWidth
  };
  maskPanelResize = null;
  document.querySelector<HTMLElement>(".mask-panel-resizer.resizing")?.classList.remove("resizing");
}

function beginMaskToolbarDrag(event: PointerEvent, toolbar: HTMLElement) {
  const rect = toolbar.getBoundingClientRect();
  maskToolbarDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originLeft: rect.left,
    originTop: rect.top
  };
  try {
    toolbar.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture may fail if the element is not focusable; drag still works via app-level listeners.
  }
  toolbar.style.position = "fixed";
  toolbar.style.left = `${rect.left}px`;
  toolbar.style.top = `${rect.top}px`;
  toolbar.style.right = "auto";
}

function moveMaskToolbarDrag(event: PointerEvent, toolbar: HTMLElement) {
  if (!maskToolbarDrag) {
    return;
  }
  const dx = event.clientX - maskToolbarDrag.startX;
  const dy = event.clientY - maskToolbarDrag.startY;
  let left = maskToolbarDrag.originLeft + dx;
  let top = maskToolbarDrag.originTop + dy;
  const maxLeft = Math.max(0, window.innerWidth - toolbar.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - toolbar.offsetHeight);
  left = Math.max(0, Math.min(maxLeft, left));
  top = Math.max(0, Math.min(maxTop, top));
  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
}

function finishMaskToolbarDrag() {
  const toolbar = document.querySelector<HTMLElement>(".mask-toolbar");
  if (toolbar) {
    if (maskToolbarDrag) {
      try {
        toolbar.releasePointerCapture(maskToolbarDrag.pointerId);
      } catch {
        // Capture may already be released.
      }
    }
    const left = parseFloat(toolbar.style.left) || 0;
    const top = parseFloat(toolbar.style.top) || 0;
    state.maskToolbarPos = { left, top };
  }
  maskToolbarDrag = null;
}

function beginImagePan(event: PointerEvent, element: HTMLElement, assetId: string) {
  const draft = ensureInpaintDraft(assetId);
  activeImagePan = {
    pointerId: event.pointerId,
    assetId,
    startClient: { x: event.clientX, y: event.clientY },
    originOffset: draft.panOffset
  };
  element.classList.add("panning");
  try {
    element.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture may fail if the pointer started on a child; document-level listeners still finish the pan.
  }
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

function continueImagePan(event: PointerEvent) {
  if (!activeImagePan) {
    return;
  }
  const nextOffset = {
    x: activeImagePan.originOffset.x + event.clientX - activeImagePan.startClient.x,
    y: activeImagePan.originOffset.y + event.clientY - activeImagePan.startClient.y
  };
  const media = document.querySelector<HTMLElement>(".preview-media");
  if (media) {
    media.style.setProperty("--mask-pan-x", `${formatCssNumber(nextOffset.x)}px`);
    media.style.setProperty("--mask-pan-y", `${formatCssNumber(nextOffset.y)}px`);
  }
}

function finishImagePan() {
  if (!activeImagePan) {
    return;
  }
  const media = document.querySelector<HTMLElement>(".preview-media");
  const draft = inpaintDraftForAsset(activeImagePan.assetId);
  const left = media ? parseFloat(media.style.getPropertyValue("--mask-pan-x")) : activeImagePan.originOffset.x;
  const top = media ? parseFloat(media.style.getPropertyValue("--mask-pan-y")) : activeImagePan.originOffset.y;
  if (media) {
    media.classList.remove("panning");
    try {
      media.releasePointerCapture(activeImagePan.pointerId);
    } catch {
      // Capture may already be released.
    }
  }
  if (draft) {
    setInpaintDraft({
      ...draft,
      panOffset: {
        x: Number.isFinite(left) ? left : activeImagePan.originOffset.x,
        y: Number.isFinite(top) ? top : activeImagePan.originOffset.y
      }
    });
  }
  activeImagePan = null;
  render();
}

function handleMaskPointerDown(event: PointerEvent, canvas: HTMLCanvasElement) {
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensureInpaintDraft(assetId);
  if (draft.selectedSmartMaskProvider !== "manual" && !draft.eraser) {
    if (draft.webSamPromptMode === "point") {
      addWebSamPointPrompt(event, canvas);
      return;
    }
    if (draft.webSamPromptMode === "box") {
      beginWebSamBoxPrompt(event, canvas);
      return;
    }
    beginMaskStroke(event, canvas, "brush-prompt");
    return;
  }
  beginMaskStroke(event, canvas, draft.eraser ? "manual-erase" : "manual-include");
}

let maskStrokeRafHandle: number | null = null;

function beginMaskStroke(event: PointerEvent, canvas: HTMLCanvasElement, kind: MaskStrokeKind) {
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  ensureInpaintDraft(assetId);
  canvas.setPointerCapture(event.pointerId);
  const point = pointerToMaskCanvasPoint(canvas, event);
  activeMaskStroke = {
    pointerId: event.pointerId,
    x: point.x,
    y: point.y,
    kind,
    pendingSegments: []
  };
  // The initial dab paints immediately (no pointermove/coalesced events exist yet for pointerdown),
  // so a single click without any drag still shows a mark right away.
  paintMaskSegments(canvas, [{ from: point, to: point }], kind);
}

function continueMaskStroke(event: PointerEvent, canvas: HTMLCanvasElement) {
  if (!activeMaskStroke) {
    return;
  }
  const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const pointerEvents = coalesced.length > 0 ? coalesced : [event];
  let cursor = { x: activeMaskStroke.x, y: activeMaskStroke.y };
  for (const pointerEvent of pointerEvents) {
    const point = pointerToMaskCanvasPoint(canvas, pointerEvent);
    activeMaskStroke.pendingSegments.push({ from: cursor, to: point });
    cursor = point;
  }
  activeMaskStroke.x = cursor.x;
  activeMaskStroke.y = cursor.y;
  scheduleMaskStrokeFlush(canvas);
}

function scheduleMaskStrokeFlush(canvas: HTMLCanvasElement) {
  if (maskStrokeRafHandle !== null) {
    return;
  }
  maskStrokeRafHandle = requestAnimationFrame(() => {
    maskStrokeRafHandle = null;
    flushMaskStrokeQueue(canvas);
  });
}

function cancelPendingMaskStrokeFlush() {
  if (maskStrokeRafHandle !== null) {
    cancelAnimationFrame(maskStrokeRafHandle);
    maskStrokeRafHandle = null;
  }
}

/**
 * Persists any pending wheel-zoom scale immediately (without waiting for the idle timer) and
 * clears the timer. Used when the mask editor closes mid-zoom so the last scale the user saw
 * is not silently lost, matching the pre-batching behavior where every tick persisted.
 */
function flushPendingMaskWheelZoom() {
  if (maskWheelZoomIdleTimer !== null) {
    window.clearTimeout(maskWheelZoomIdleTimer);
    maskWheelZoomIdleTimer = null;
  }
  const pendingScale = maskWheelZoomPendingScale;
  maskWheelZoomPendingScale = null;
  if (pendingScale === null) {
    return;
  }
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!draft) {
    return;
  }
  setInpaintDraft({
    ...draft,
    zoomScale: pendingScale
  });
}

/** Paints and drains any queued pending segments for the active stroke, then re-composites once. */
function flushMaskStrokeQueue(canvas: HTMLCanvasElement) {
  if (!activeMaskStroke || activeMaskStroke.pendingSegments.length === 0) {
    return;
  }
  const segments = activeMaskStroke.pendingSegments;
  activeMaskStroke.pendingSegments = [];
  paintMaskSegments(canvas, segments, activeMaskStroke.kind);
}

function finishMaskStroke(canvas: HTMLCanvasElement) {
  cancelPendingMaskStrokeFlush();
  // Flush any segments queued for the next rAF so the final commit sees the full stroke.
  flushMaskStrokeQueue(canvas);
  if (activeMaskStroke) {
    try {
      canvas.releasePointerCapture(activeMaskStroke.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }
  const finishedKind = activeMaskStroke?.kind ?? "manual-include";
  activeMaskStroke = null;
  if (finishedKind === "brush-prompt") {
    finishBrushPromptStroke(canvas);
  } else {
    commitActiveMaskCanvas();
  }
}

const MASK_DIRTY_RECT_MARGIN = 2;

/**
 * Paints a batch of line segments (1 rAF frame's worth, or a single pointerdown dab) into the
 * appropriate layer canvas(es), then re-composites the visible mask canvas exactly once for the
 * whole batch, limited to the dirty rect covering all segments (plus brush radius + margin).
 * Per-segment side effects (brush-prompt point removal near erase strokes) still run once per
 * segment so their distance-based logic is unaffected by batching.
 */
function paintMaskSegments(canvas: HTMLCanvasElement, segments: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>, kind: MaskStrokeKind) {
  if (segments.length === 0) {
    return;
  }
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  const draft = inpaintDraftForAsset(assetId) ?? (assetId ? ensureInpaintDraft(assetId) : null);
  if (!draft || !assetId) {
    return;
  }
  const layers = getOrCreateMaskLayerSet(assetId, canvas.width, canvas.height);
  const brushSize = draft.brushSize;

  for (const segment of segments) {
    if (kind === "manual-include") {
      // Add to the include layer, and lift any prior erase strokes in the same area so
      // a previously erased region can be re-masked by drawing over it with the pen.
      paintStroke(layers.manualInclude, segment.from, segment.to, brushSize, "source-over");
      paintStroke(layers.manualErase, segment.from, segment.to, brushSize, "destination-out");
    } else if (kind === "manual-erase") {
      paintStroke(layers.manualErase, segment.from, segment.to, brushSize, "source-over");
      removeBrushPromptPointsNearSegment(assetId, segment.from, segment.to, brushSize / 2);
    } else {
      paintStroke(maskLayerForStroke(layers, kind), segment.from, segment.to, brushSize, "source-over");
    }
  }
  const dirtyRect = dirtyRectForSegments(segments, brushSize, MASK_DIRTY_RECT_MARGIN) ?? undefined;
  renderFinalMaskToCanvas(canvas, layers, draft, true, dirtyRect);
}

function commitActiveMaskCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  if (canvas) {
    commitMaskCanvas(canvas);
  }
}

function commitMaskCanvas(canvas: HTMLCanvasElement) {
  const assetId = canvas?.dataset.assetId ?? state.activeAssetId;
  if (!canvas || !assetId) {
    return;
  }

  commitMaskLayers(assetId);
}

function renderHeader() {
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
    state.showMaskGridTag,
    state.copiedSeedAssetId
  );
}

function captureGenerationDraft() {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (!form) {
    return;
  }
  state.generationDraft = generationDraftFromForm(form);
}

function generationDraftFromForm(form: HTMLFormElement): GenerationDraft {
  const draft: GenerationDraft = {
    inpaint: null
  };
  for (const field of generationDraftFields) {
    const control = form.elements.namedItem(field) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (control) {
      draft[field] = control.value;
    }
  }
  draft.inpaint = inpaintDraftForAsset(draft.parentAssetId) ?? null;
  return draft;
}

function generationDraftFromRequest(request: GenerationRequest): GenerationDraft {
  return {
    templateId: request.templateId,
    img2imgTemplateId: request.generationMode === "img2img" ? request.templateId : "",
    parentAssetId: request.parentAssetId ?? "",
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    seed: request.seed === null ? "" : String(request.seed),
    seedMode: request.seedMode,
    batchSize: String(request.batchSize),
    steps: String(request.steps),
    cfg: String(request.cfg),
    sampler: request.sampler,
    scheduler: request.scheduler,
    denoise: String(request.denoise),
    width: String(request.width),
    height: String(request.height),
    generationMode: request.generationMode,
    inpaint: null
  };
}

function setGenerationDraftValue(field: GenerationDraftField, value: string) {
  state.generationDraft = {
    ...(state.generationDraft ?? {}),
    [field]: value
  };
}

function draftNumber(draft: GenerationDraft | null, field: GenerationDraftField) {
  const value = draft?.[field];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function inpaintDraftForAsset(assetId: string | null | undefined) {
  const stored = assetId ? state.inpaintDrafts[assetId] : null;
  if (stored) {
    const normalized = normalizeInpaintDraft(stored);
    state.inpaintDrafts[normalized.parentAssetId] = normalized;
    return normalized;
  }
  const draft = state.generationDraft?.inpaint;
  if (!assetId || !draft || draft.parentAssetId !== assetId) {
    return null;
  }
  const normalized = normalizeInpaintDraft(draft);
  state.inpaintDrafts[assetId] = normalized;
  return normalized;
}

function setInpaintDraft(draft: InpaintDraft | null) {
  const previousAssetId =
    state.generationDraft?.inpaint?.parentAssetId ??
    state.generationDraft?.parentAssetId ??
    state.activeAssetId;
  const normalized = draft ? normalizeInpaintDraft(draft) : null;
  if (normalized) {
    state.inpaintDrafts[normalized.parentAssetId] = normalized;
  } else if (previousAssetId) {
    delete state.inpaintDrafts[previousAssetId];
  }
  state.generationDraft = {
    ...(state.generationDraft ?? {}),
    inpaint: normalized
  };
}

function ensureInpaintDraft(assetId: string) {
  const draft = normalizeInpaintDraft(inpaintDraftForAsset(assetId) ?? defaultInpaintDraft(assetId));
  state.inpaintDrafts[assetId] = draft;
  state.generationDraft = {
    ...(state.generationDraft ?? {}),
    parentAssetId: assetId,
    generationMode: "img2img",
    inpaint: draft
  };
  return draft;
}

function setPositivePromptDraft(value: string) {
  setGenerationDraftValue("prompt", value);
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (form) {
    setFormValue(form, "prompt", value);
  }
  syncPreviewPromptControl(value);
}

function setGenerationSliderDraft(field: GenerationDraftField, control: HTMLInputElement) {
  setGenerationDraftValue(field, control.value);
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (form) {
    setFormValue(form, field, control.value);
  }
}

function syncPreviewPromptControl(value: string) {
  const control = document.querySelector<HTMLTextAreaElement>("[data-generation-field='prompt']");
  if (control && control.value !== value) {
    control.value = value;
  }
}

function updateInpaintDraftFromControl(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const field = control.dataset.inpaintField;
  if (!field) {
    return;
  }

  const assetId = state.generationDraft?.inpaint?.parentAssetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }

  const current = ensureInpaintDraft(assetId);
  const next: InpaintDraft = { ...current };
  if (field === "maskedContent" && isMaskedContent(control.value)) {
    next.maskedContent = control.value;
  } else if (field === "inpaintArea") {
    next.inpaintArea = "only_masked";
  } else if (field === "onlyMaskedPadding") {
    next.onlyMaskedPadding = clampNumber(Number(control.value), 0, 512, 32);
  } else if (field === "featherRadius") {
    next.featherRadius = clampNumber(Number(control.value), 0, 30, 0);
  } else if (field === "brushSize") {
    next.brushSize = clampNumber(Number(control.value), 1, 256, 48);
  }
  setInpaintDraft(next);
}

function updateSmartMaskDraftFromControl(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const field = control.dataset.smartMaskField;
  const assetId = state.generationDraft?.inpaint?.parentAssetId ?? state.activeAssetId;
  if (!field || !assetId) {
    return;
  }
  if (field === "provider" && isSmartMaskProvider(control.value)) {
    setSmartMaskProvider(control.value);
    return;
  }
  const current = ensureInpaintDraft(assetId);
  const next: InpaintDraft = { ...current };
  if (field === "promptMode" && isWebSamPromptMode(control.value)) {
    next.webSamPromptMode = control.value;
    next.eraser = false;
  } else if (field === "threshold") {
    next.threshold = clampNumber(Number(control.value), -10, 10, 0);
  } else if (field === "smoothing") {
    next.smoothing = clampNumber(Number(control.value), 0, 4, 0);
  } else if (field === "maskOpacity") {
    next.maskOpacity = clampNumber(Number(control.value), 0, 1, 0.58);
  }
  setInpaintDraft(next);

  if (field === "threshold" || field === "smoothing") {
    void requestWebSamReprocess();
    return;
  }
  if (field === "maskOpacity") {
    const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
    if (canvas) {
      canvas.style.opacity = String(next.maskOpacity);
    }
  }
  render();
}

function setSmartMaskProvider(provider: WebSamProviderId) {
  const assetId = state.generationDraft?.inpaint?.parentAssetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  const current = ensureInpaintDraft(assetId);
  const next: InpaintDraft = {
    ...current,
    selectedSmartMaskProvider: provider,
    eraser: false
  };
  if (provider === "manual") {
    next.webSamStatusText = "Manual";
  } else {
    next.webSamError = "";
    next.webSamModelStatus = state.settings?.webSamModelBaseUrl?.trim() ? "not-cached" : "missing-url";
    next.webSamStatusText = state.settings?.webSamModelBaseUrl?.trim() ? "未取得" : "モデルURL未設定";
  }
  setInpaintDraft(next);
  render();
  if (provider !== "manual") {
    void loadActiveWebSamModel();
  }
}

function isSmartMaskProvider(value: string): value is WebSamProviderId {
  return SMART_MASK_PROVIDERS.some((provider) => provider.id === value);
}

function isWebSamPromptMode(value: string): value is WebSamPromptMode {
  return value === "point" || value === "box" || value === "brush";
}

function ensureWebSamWorker() {
  if (webSamWorker) {
    return webSamWorker;
  }
  webSamWorker = new Worker("/websam-worker.js", { type: "module" });
  webSamWorker.addEventListener("message", (event: MessageEvent<WebSamWorkerResponse>) => {
    void handleWebSamWorkerResponse(event.data);
  });
  webSamWorker.addEventListener("error", (event) => {
    updateActiveWebSamDraft({
      webSamModelStatus: "error",
      webSamError: event.message || "WebSAM Worker initialization failed.",
      webSamStatusText: "Error"
    });
  });
  return webSamWorker;
}

function postWebSamMessage(message: WebSamWorkerRequest) {
  ensureWebSamWorker().postMessage(message);
}

function nextWebSamRequestId() {
  webSamRequestId += 1;
  return webSamRequestId;
}

function updateActiveWebSamDraft(patch: Partial<InpaintDraft>) {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!draft) {
    return;
  }
  setInpaintDraft({ ...draft, ...patch });
  render();
}

async function handleWebSamWorkerResponse(message: WebSamWorkerResponse) {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!assetId || !draft) {
    return;
  }

  if (message.type === "progress") {
    if (message.requestId < latestWebSamLoadRequestId && message.progress.status !== "encoding" && message.progress.status !== "decoding") {
      return;
    }
    setInpaintDraft({
      ...draft,
      webSamModelStatus: message.progress.status,
      webSamDownloadProgress: message.progress.totalBytes > 0 ? message.progress.bytesDownloaded / message.progress.totalBytes : 0,
      webSamStatusText: webSamProgressText(message.progress),
      webSamError: ""
    });
    render();
    return;
  }

  if (message.type === "model-ready") {
    if (message.requestId !== latestWebSamLoadRequestId) {
      return;
    }
    setInpaintDraft({
      ...draft,
      webSamModelStatus: "initializing",
      webSamDownloadProgress: 1,
      webSamStatusText: message.fallback ? "WebGPU不可のためWASMで初期化" : `${message.backend.toUpperCase()} 初期化済み`,
      webSamError: ""
    });
    render();
    await encodeActiveImageForWebSam();
    return;
  }

  if (message.type === "encoded") {
    if (message.requestId !== latestWebSamEncodeRequestId) {
      return;
    }
    const current = inpaintDraftForAsset(assetId);
    if (!current) {
      return;
    }
    setInpaintDraft({
      ...current,
      webSamModelStatus: "ready",
      webSamStatusText: "Ready",
      imageWidth: message.width,
      imageHeight: message.height,
      webSamError: ""
    });
    render();
    if (hasWebSamPrompt(current)) {
      await requestWebSamDecode();
    }
    return;
  }

  if (message.type === "decoded") {
    if (message.requestId !== latestWebSamDecodeRequestId) {
      return;
    }
    const candidates = await Promise.all(message.candidates.map(candidateFromWorker));
    const selectedIndex = candidates.some((candidate) => candidate.index === message.selectedIndex)
      ? message.selectedIndex
      : candidates[0]?.index ?? 0;
    const selected = candidates.find((candidate) => candidate.index === selectedIndex) ?? candidates[0] ?? null;
    const current = inpaintDraftForAsset(assetId);
    if (!current) {
      return;
    }
    if (selected) {
      await drawCandidatePreview(assetId, selected.dataUrl);
    }
    setInpaintDraft({
      ...current,
      webSamModelStatus: "ready",
      webSamStatusText: "Ready",
      webSamError: "",
      samCandidates: candidates,
      selectedSamCandidateIndex: selectedIndex,
      previewSamMaskDataUrl: selected?.dataUrl ?? ""
    });
    render();
    return;
  }

  if (message.type === "error") {
    if (message.requestId < Math.max(latestWebSamLoadRequestId, latestWebSamEncodeRequestId, latestWebSamDecodeRequestId)) {
      return;
    }
    setInpaintDraft({
      ...draft,
      webSamModelStatus: "error",
      webSamError: message.message,
      webSamStatusText: "Error"
    });
    render();
  }
}

function webSamProgressText(progress: { status: WebSamModelStatus; bytesDownloaded: number; totalBytes: number; cached: boolean; detail?: string }) {
  if (progress.status === "cached") {
    return "キャッシュ済み";
  }
  if (progress.status === "downloading") {
    return `ダウンロード中 ${formatModelBytes(progress.bytesDownloaded)} / ${formatModelBytes(progress.totalBytes)}`;
  }
  if (progress.status === "initializing") {
    return "初期化中";
  }
  if (progress.status === "encoding") {
    return progress.detail === "encoder" ? "画像encode中" : "画像準備中";
  }
  if (progress.status === "decoding") {
    return "マスク候補生成中";
  }
  if (progress.status === "not-cached") {
    return "未取得";
  }
  return progress.status;
}

async function loadActiveWebSamModel() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? ensureInpaintDraft(assetId) : null;
  const model = draft ? modelForProvider(draft.selectedSmartMaskProvider) : null;
  if (!assetId || !draft || !model) {
    return;
  }
  const urls = buildWebSamModelUrls(state.settings?.webSamModelBaseUrl ?? DEFAULT_WEB_SAM_MODEL_BASE_URL, model);
  if (!urls) {
    setInpaintDraft({
      ...draft,
      webSamModelStatus: "missing-url",
      webSamError: "webSamModelBaseUrl が未設定です。",
      webSamStatusText: "モデルURL未設定"
    });
    render();
    return;
  }
  const requestId = nextWebSamRequestId();
  latestWebSamLoadRequestId = requestId;
  setInpaintDraft({
    ...draft,
    webSamModelStatus: "downloading",
    webSamDownloadProgress: 0,
    webSamError: "",
    webSamStatusText: "モデル確認中"
  });
  render();
  postWebSamMessage({ type: "load-model", requestId, model, urls });
}

async function encodeActiveImageForWebSam() {
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!image || !assetId || !draft) {
    return;
  }
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error("画像を読み込めませんでした。")), { once: true });
    });
  }
  const raw = imageToRawData(image);
  const requestId = nextWebSamRequestId();
  latestWebSamEncodeRequestId = requestId;
  setInpaintDraft({
    ...draft,
    webSamModelStatus: "encoding",
    webSamStatusText: "画像encode中",
    webSamError: ""
  });
  render();
  postWebSamMessage({ type: "encode-image", requestId, imageData: raw });
}

function imageToRawData(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("画像処理Canvasを初期化できません。");
  }
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    data: imageData.data,
    width: canvas.width,
    height: canvas.height
  };
}

async function requestWebSamDecode() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!assetId || !draft || draft.selectedSmartMaskProvider === "manual") {
    return;
  }
  if (!hasWebSamPrompt(draft)) {
    setInpaintDraft({
      ...draft,
      webSamError: "Point、Box、Brush prompt のいずれかを指定してください。",
      webSamStatusText: "プロンプト未指定"
    });
    render();
    return;
  }
  if (draft.webSamModelStatus !== "ready") {
    if (draft.webSamModelStatus === "idle" || draft.webSamModelStatus === "not-cached" || draft.webSamModelStatus === "missing-url" || draft.webSamModelStatus === "error") {
      await loadActiveWebSamModel();
    }
    return;
  }
  const width = draft.imageWidth ?? document.querySelector<HTMLCanvasElement>("#maskCanvas")?.width ?? 0;
  const height = draft.imageHeight ?? document.querySelector<HTMLCanvasElement>("#maskCanvas")?.height ?? 0;
  if (width <= 0 || height <= 0) {
    return;
  }
  const requestId = nextWebSamRequestId();
  latestWebSamDecodeRequestId = requestId;
  setInpaintDraft({
    ...draft,
    webSamModelStatus: "decoding",
    webSamStatusText: "マスク候補生成中",
    webSamError: ""
  });
  render();
  postWebSamMessage({
    type: "decode",
    requestId,
    prompt: {
      points: draft.foregroundPoints,
      box: draft.boxPrompt
    },
    outputWidth: width,
    outputHeight: height,
    threshold: draft.threshold,
    smoothing: draft.smoothing
  });
}

async function requestWebSamReprocess() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!assetId || !draft || draft.selectedSmartMaskProvider === "manual" || draft.samCandidates.length === 0) {
    return;
  }
  const width = draft.imageWidth ?? document.querySelector<HTMLCanvasElement>("#maskCanvas")?.width ?? 0;
  const height = draft.imageHeight ?? document.querySelector<HTMLCanvasElement>("#maskCanvas")?.height ?? 0;
  if (width <= 0 || height <= 0) {
    return;
  }
  const requestId = nextWebSamRequestId();
  latestWebSamDecodeRequestId = requestId;
  postWebSamMessage({
    type: "reprocess",
    requestId,
    outputWidth: width,
    outputHeight: height,
    threshold: draft.threshold,
    smoothing: draft.smoothing
  });
}

function hasWebSamPrompt(draft: InpaintDraft) {
  return draft.foregroundPoints.length > 0 || !!normalizePromptBox(draft.boxPrompt);
}

function candidateFromWorker(candidate: WebSamWorkerCandidate): Promise<SamMaskCandidate> {
  return imageDataToDataUrl(candidate.mask).then((dataUrl) => ({
    index: candidate.index,
    score: candidate.score,
    dataUrl
  }));
}

function imageDataToDataUrl(imageData: ImageData) {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return Promise.resolve("");
  }
  context.putImageData(imageData, 0, 0);
  return Promise.resolve(canvas.toDataURL("image/png"));
}

async function drawCandidatePreview(assetId: string, dataUrl: string) {
  const draft = inpaintDraftForAsset(assetId);
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  if (!draft || !canvas) {
    return;
  }
  const layers = await ensureMaskLayerSet(draft, canvas.width, canvas.height);
  clearCanvas(layers.previewSamMask);
  await drawDataUrlIntoCanvas(layers.previewSamMask, dataUrl);
  renderFinalMaskToCanvas(canvas, layers, { ...draft, previewSamMaskDataUrl: dataUrl }, true);
}

function selectSamCandidate(index: number) {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  const candidate = draft?.samCandidates.find((item) => item.index === index) ?? null;
  if (!assetId || !draft || !candidate) {
    return;
  }
  setInpaintDraft({
    ...draft,
    selectedSamCandidateIndex: candidate.index,
    previewSamMaskDataUrl: candidate.dataUrl
  });
  void drawCandidatePreview(assetId, candidate.dataUrl);
  render();
}

async function applySelectedSamCandidate() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  const candidate = draft?.samCandidates.find((item) => item.index === draft.selectedSamCandidateIndex) ?? null;
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  if (!assetId || !draft || !candidate || !canvas) {
    return;
  }
  const layers = await ensureMaskLayerSet(draft, canvas.width, canvas.height);
  clearCanvas(layers.samMask);
  clearCanvas(layers.previewSamMask);
  await drawDataUrlIntoCanvas(layers.samMask, candidate.dataUrl);
  setInpaintDraft({
    ...draft,
    samMaskDataUrl: candidate.dataUrl,
    previewSamMaskDataUrl: "",
    maskDataUrl: composeFinalMaskDataUrl(layers, false),
    webSamStatusText: "SAM結果を適用"
  });
  renderFinalMaskToCanvas(canvas, layers, { ...draft, previewSamMaskDataUrl: "" }, false);
  render();
}

function clearWebSamPrompts() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  const layers = assetId ? maskLayerCache.get(assetId) : null;
  if (!assetId || !draft) {
    return;
  }
  if (layers) {
    clearCanvas(layers.brushPrompt);
  }
  setInpaintDraft({
    ...draft,
    foregroundPoints: [],
    boxPrompt: null,
    brushPromptMaskDataUrl: "",
    samCandidates: [],
    selectedSamCandidateIndex: 0,
    previewSamMaskDataUrl: "",
    webSamError: ""
  });
  render();
}

function clearWebSamResult() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  const layers = assetId ? maskLayerCache.get(assetId) : null;
  if (!assetId || !draft) {
    return;
  }
  if (layers) {
    clearCanvas(layers.samMask);
    clearCanvas(layers.previewSamMask);
    setInpaintDraft({
      ...draft,
      samMaskDataUrl: "",
      previewSamMaskDataUrl: "",
      samCandidates: [],
      selectedSamCandidateIndex: 0,
      maskDataUrl: composeFinalMaskDataUrl(layers, false)
    });
  } else {
    setInpaintDraft({ ...draft, samMaskDataUrl: "", previewSamMaskDataUrl: "", samCandidates: [], selectedSamCandidateIndex: 0, maskDataUrl: "" });
  }
  render();
}

function clearManualMaskLayers() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  const layers = assetId ? maskLayerCache.get(assetId) : null;
  if (!assetId || !draft) {
    return;
  }
  if (layers) {
    clearCanvas(layers.manualInclude);
    clearCanvas(layers.manualErase);
    setInpaintDraft({
      ...draft,
      manualIncludeMaskDataUrl: "",
      manualEraseMaskDataUrl: "",
      maskDataUrl: composeFinalMaskDataUrl(layers, false)
    });
  } else {
    setInpaintDraft({ ...draft, manualIncludeMaskDataUrl: "", manualEraseMaskDataUrl: "" });
  }
  render();
}

const MASK_WHEEL_ZOOM_IDLE_MS = 150;
let maskWheelZoomIdleTimer: number | null = null;
let maskWheelZoomPendingScale: number | null = null;

/**
 * Wheel zoom ticks update `--mask-zoom` directly on `.preview-media` (same element/mechanism
 * `continueImagePan` uses for `--mask-pan-x`/`--mask-pan-y`), skipping the full `render()` per tick.
 * Once wheel input goes idle (~150ms), the final scale is persisted to the draft and `render()`
 * runs once, mirroring `finishImagePan`'s persist-on-release pattern.
 */
function handleMaskWheelZoom(event: WheelEvent) {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  if (!assetId) {
    return;
  }
  const draft = ensureInpaintDraft(assetId);
  const currentScale = maskWheelZoomPendingScale ?? draft.zoomScale;
  const direction = event.deltaY < 0 ? 1 : -1;
  const nextScale = clampNumber(currentScale + direction * 0.12, 0.25, 4, 1);
  maskWheelZoomPendingScale = nextScale;

  const media = document.querySelector<HTMLElement>(".preview-media");
  media?.style.setProperty("--mask-zoom", formatCssNumber(nextScale));

  if (maskWheelZoomIdleTimer !== null) {
    window.clearTimeout(maskWheelZoomIdleTimer);
  }
  maskWheelZoomIdleTimer = window.setTimeout(() => {
    maskWheelZoomIdleTimer = null;
    const pendingScale = maskWheelZoomPendingScale;
    maskWheelZoomPendingScale = null;
    if (pendingScale === null) {
      return;
    }
    const latestDraft = inpaintDraftForAsset(assetId) ?? draft;
    setInpaintDraft({
      ...latestDraft,
      zoomScale: pendingScale
    });
    render();
  }, MASK_WHEEL_ZOOM_IDLE_MS);
}

const PAINT_WHEEL_ZOOM_IDLE_MS = 150;
let paintWheelZoomIdleTimer: number | null = null;
let paintWheelZoomPendingScale: number | null = null;

/** Paint-mode analogue of `handleMaskWheelZoom`, persisting to `PaintDraft.zoomScale` instead. */
function handlePaintWheelZoom(event: WheelEvent) {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensurePaintDraft(assetId);
  const currentScale = paintWheelZoomPendingScale ?? draft.zoomScale;
  const direction = event.deltaY < 0 ? 1 : -1;
  const nextScale = clampNumber(currentScale + direction * 0.12, 0.25, 4, 1);
  paintWheelZoomPendingScale = nextScale;

  const media = document.querySelector<HTMLElement>(".preview-media");
  media?.style.setProperty("--mask-zoom", formatCssNumber(nextScale));

  if (paintWheelZoomIdleTimer !== null) {
    window.clearTimeout(paintWheelZoomIdleTimer);
  }
  paintWheelZoomIdleTimer = window.setTimeout(() => {
    paintWheelZoomIdleTimer = null;
    const pendingScale = paintWheelZoomPendingScale;
    paintWheelZoomPendingScale = null;
    if (pendingScale === null) {
      return;
    }
    const latestDraft = paintDraftForAsset(assetId) ?? draft;
    setPaintDraft({
      ...latestDraft,
      zoomScale: pendingScale
    });
    render();
  }, PAINT_WHEEL_ZOOM_IDLE_MS);
}

async function destroyWebSamWorkerSession() {
  if (!webSamWorker) {
    return;
  }
  const requestId = nextWebSamRequestId();
  postWebSamMessage({ type: "destroy", requestId });
}

// ---- Pose（MediaPipe Pose Landmarker）worker 統合 ----
// WebSAM worker 統合（ensureWebSamWorker / handleWebSamWorkerResponse）と同型。
// pose-worker.js は IIFE bundle のクラシック worker（MediaPipe の wasm グルーが
// module worker 非対応のため `{ type: "module" }` を付けない）。

function ensurePoseWorker() {
  if (poseWorker) {
    return poseWorker;
  }
  poseWorker = new Worker("/pose-worker.js");
  poseWorker.addEventListener("message", (event: MessageEvent<PoseWorkerResponse>) => {
    void handlePoseWorkerResponse(event.data);
  });
  poseWorker.addEventListener("error", (event) => {
    updateActivePoseDraft({
      modelStatus: "error",
      modelError: event.message || "Pose Worker initialization failed.",
      modelStatusText: "Error"
    });
  });
  return poseWorker;
}

function postPoseMessage(message: PoseWorkerRequest) {
  ensurePoseWorker().postMessage(message);
}

function nextPoseRequestId() {
  poseRequestId += 1;
  return poseRequestId;
}

function poseDraftForAsset(assetId: string | null | undefined) {
  const stored = assetId ? state.poseDrafts[assetId] : null;
  if (!stored) {
    return null;
  }
  const normalized = normalizePoseDraft(stored);
  state.poseDrafts[normalized.parentAssetId] = normalized;
  return normalized;
}

function setPoseDraft(draft: PoseDraft) {
  const normalized = normalizePoseDraft(draft);
  state.poseDrafts[normalized.parentAssetId] = normalized;
}

function ensurePoseDraft(assetId: string) {
  const draft = poseDraftForAsset(assetId) ?? defaultPoseDraft(assetId);
  state.poseDrafts[assetId] = draft;
  return draft;
}

function updateActivePoseDraft(patch: Partial<PoseDraft>) {
  const assetId = state.activeAssetId;
  const draft = assetId ? poseDraftForAsset(assetId) : null;
  if (!assetId || !draft) {
    return;
  }
  setPoseDraft({ ...draft, ...patch });
  render();
}

function setMaskPanelTab(tab: MaskPanelTab) {
  if (state.maskPanelTab === tab) {
    return;
  }
  if (tab === "pose") {
    // マスクタブを離れる前に描画途中のストロークを確定しておく
    commitActiveMaskCanvas();
    if (state.activeAssetId) {
      ensurePoseDraft(state.activeAssetId);
    }
  }
  state.maskPanelTab = tab;
  render();
}

async function loadActivePoseModel() {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensurePoseDraft(assetId);
  const model = defaultPoseModel();
  const urls = buildPoseModelUrls(DEFAULT_POSE_MODEL_BASE_URL, model);
  if (!urls) {
    setPoseDraft({
      ...draft,
      modelStatus: "missing-url",
      modelError: "ポーズモデルURLが未設定です。",
      modelStatusText: "モデルURL未設定"
    });
    render();
    return;
  }
  const requestId = nextPoseRequestId();
  latestPoseLoadRequestId = requestId;
  setPoseDraft({
    ...draft,
    modelStatus: "downloading",
    modelDownloadProgress: 0,
    modelError: "",
    modelStatusText: "モデル確認中"
  });
  render();
  postPoseMessage({ type: "load-model", requestId, model, urls });
}

async function requestPoseDetect() {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensurePoseDraft(assetId);
  if (draft.modelStatus !== "ready") {
    posePendingDetect = true;
    if (
      draft.modelStatus === "idle" ||
      draft.modelStatus === "not-cached" ||
      draft.modelStatus === "cached" ||
      draft.modelStatus === "missing-url" ||
      draft.modelStatus === "error"
    ) {
      await loadActivePoseModel();
    }
    return;
  }
  await sendPoseDetect(assetId);
}

async function sendPoseDetect(assetId: string) {
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  const draft = poseDraftForAsset(assetId);
  if (!image || !draft) {
    return;
  }
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error("画像を読み込めませんでした。")), { once: true });
    });
  }
  const raw = imageToRawData(image);
  const requestId = nextPoseRequestId();
  latestPoseDetectRequestId = requestId;
  setPoseDraft({
    ...draft,
    modelStatus: "detecting",
    modelStatusText: "ポーズ検出中",
    modelError: "",
    imageWidth: raw.width,
    imageHeight: raw.height
  });
  render();
  postPoseMessage({ type: "detect", requestId, imageData: raw });
}

async function resetPoseDetection() {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  const current = ensurePoseDraft(assetId);
  setPoseDraft({ ...current, points: null, source: "detected", enabled: false });
  render();
  await requestPoseDetect();
}

async function handlePoseWorkerResponse(message: PoseWorkerResponse) {
  const assetId = state.activeAssetId;
  const draft = assetId ? poseDraftForAsset(assetId) : null;
  if (!assetId || !draft) {
    return;
  }

  if (message.type === "progress") {
    if (message.requestId < latestPoseLoadRequestId && message.progress.status !== "detecting") {
      return;
    }
    setPoseDraft({
      ...draft,
      modelStatus: message.progress.status,
      modelDownloadProgress: message.progress.totalBytes > 0 ? message.progress.bytesDownloaded / message.progress.totalBytes : 0,
      modelStatusText: poseProgressText(message.progress),
      modelError: ""
    });
    render();
    return;
  }

  if (message.type === "model-ready") {
    if (message.requestId !== latestPoseLoadRequestId) {
      return;
    }
    setPoseDraft({
      ...draft,
      modelStatus: "ready",
      modelDownloadProgress: 1,
      modelStatusText: message.fallback ? "GPU不可のためCPUで初期化" : `${message.backend} 初期化済み`,
      modelError: ""
    });
    render();
    if (posePendingDetect) {
      posePendingDetect = false;
      await sendPoseDetect(assetId);
    }
    return;
  }

  if (message.type === "detected") {
    if (message.requestId !== latestPoseDetectRequestId) {
      return;
    }
    const current = poseDraftForAsset(assetId);
    if (!current) {
      return;
    }
    const width = current.imageWidth ?? 0;
    const height = current.imageHeight ?? 0;
    const landmarks = message.landmarks[0] ?? null;
    if (!landmarks || landmarks.length === 0 || width <= 0 || height <= 0) {
      setPoseDraft({
        ...current,
        modelStatus: "ready",
        modelStatusText: "人物ポーズを検出できませんでした",
        modelError: "",
        points: null
      });
      render();
      return;
    }
    setPoseDraft({
      ...current,
      modelStatus: "ready",
      modelStatusText: "検出完了",
      modelError: "",
      points: mediapipeToOpenPose(landmarks, width, height),
      source: "detected",
      enabled: true
    });
    render();
    return;
  }

  if (message.type === "error") {
    if (message.requestId < Math.max(latestPoseLoadRequestId, latestPoseDetectRequestId)) {
      return;
    }
    posePendingDetect = false;
    setPoseDraft({
      ...draft,
      modelStatus: "error",
      modelError: message.message,
      modelStatusText: "Error"
    });
    render();
  }
}

function poseProgressText(progress: PoseWorkerProgress) {
  if (progress.status === "cached") {
    return "キャッシュ済み";
  }
  if (progress.status === "downloading") {
    return `ダウンロード中 ${formatModelBytes(progress.bytesDownloaded)} / ${formatModelBytes(progress.totalBytes)}`;
  }
  if (progress.status === "initializing") {
    return "初期化中";
  }
  if (progress.status === "detecting") {
    return "ポーズ検出中";
  }
  if (progress.status === "not-cached") {
    return "未取得";
  }
  return progress.status;
}

function updatePoseDraftFromControl(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const field = control.dataset.poseField;
  const assetId = state.activeAssetId;
  if (!field || !assetId) {
    return;
  }
  const current = ensurePoseDraft(assetId);
  const next: PoseDraft = { ...current };
  if (field === "enabled" && control instanceof HTMLInputElement) {
    next.enabled = control.checked;
  } else if (field === "strength") {
    next.strength = clampNumber(Number(control.value), 0, 2, 1);
  } else if (field === "startPercent") {
    next.startPercent = clampNumber(Number(control.value), 0, 1, 0);
  } else if (field === "endPercent") {
    next.endPercent = clampNumber(Number(control.value), 0, 1, 1);
  }
  setPoseDraft(next);
  if (field === "enabled") {
    render();
  }
}

/**
 * ポーズタブの関節ドラッグ編集（`Docs/Feature-PoseControlNet.md` §4）。
 * pointerdown で最近傍関節（`.pose-joint` circle 自体）を掴み、pointermove では
 * `render()` を呼ばずに SVG 属性（joint circle の cx/cy + 接続する bone line の該当端点）を
 * 直接書き換える（`updateMaskBrushCursor` と同じ「操作中は再描画しない」パターン）。
 * pointerup で移動量が閾値以下なら「クリック」とみなし visible をトグルし、
 * 閾値を超えていれば座標を `PoseDraft.points` へコミットする。どちらも `source: "edited"` にして render()。
 */
function beginPoseJointDrag(event: PointerEvent, joint: SVGCircleElement) {
  const assetId = state.activeAssetId;
  const svg = joint.closest<SVGSVGElement>(".pose-overlay");
  if (!assetId || !svg) {
    return;
  }
  const jointIndex = Number(joint.dataset.jointIndex ?? "-1");
  const draft = poseDraftForAsset(assetId);
  if (!draft || !draft.points || jointIndex < 0 || jointIndex >= draft.points.length) {
    return;
  }
  const point = pointerToSvgViewBoxPoint(svg, event);
  activePoseJointDrag = {
    pointerId: event.pointerId,
    assetId,
    jointIndex,
    start: point,
    current: point,
    moved: false
  };
  try {
    joint.setPointerCapture(event.pointerId);
  } catch {
    // Capture may not be supported in test environments; dragging still works via document-level events.
  }
  joint.classList.add("dragging");
}

function continuePoseJointDrag(event: PointerEvent, svg: SVGSVGElement) {
  if (!activePoseJointDrag) {
    return;
  }
  const point = pointerToSvgViewBoxPoint(svg, event);
  activePoseJointDrag.current = point;
  const dx = point.x - activePoseJointDrag.start.x;
  const dy = point.y - activePoseJointDrag.start.y;
  if (!activePoseJointDrag.moved && Math.hypot(dx, dy) > POSE_JOINT_DRAG_THRESHOLD) {
    activePoseJointDrag.moved = true;
  }
  if (!activePoseJointDrag.moved) {
    return;
  }
  const clamped = clampPointToPoseBounds(point, svg);
  const jointEl = svg.querySelector<SVGCircleElement>(`.pose-joint[data-joint-index="${activePoseJointDrag.jointIndex}"]`);
  if (jointEl) {
    jointEl.setAttribute("cx", formatCssNumber(clamped.x));
    jointEl.setAttribute("cy", formatCssNumber(clamped.y));
  }
  const bones = svg.querySelectorAll<SVGLineElement>(".pose-bone");
  bones.forEach((bone) => {
    const from = Number(bone.dataset.boneFrom ?? "-1");
    const to = Number(bone.dataset.boneTo ?? "-1");
    if (from === activePoseJointDrag!.jointIndex) {
      bone.setAttribute("x1", formatCssNumber(clamped.x));
      bone.setAttribute("y1", formatCssNumber(clamped.y));
    }
    if (to === activePoseJointDrag!.jointIndex) {
      bone.setAttribute("x2", formatCssNumber(clamped.x));
      bone.setAttribute("y2", formatCssNumber(clamped.y));
    }
  });
}

function clampPointToPoseBounds(point: { x: number; y: number }, svg: SVGSVGElement) {
  const viewBox = svg.viewBox.baseVal;
  const width = viewBox && viewBox.width > 0 ? viewBox.width : Number.POSITIVE_INFINITY;
  const height = viewBox && viewBox.height > 0 ? viewBox.height : Number.POSITIVE_INFINITY;
  return {
    x: Math.min(Math.max(point.x, 0), width),
    y: Math.min(Math.max(point.y, 0), height)
  };
}

function finishPoseJointDrag() {
  const drag = activePoseJointDrag;
  activePoseJointDrag = null;
  if (!drag) {
    return;
  }
  const jointEl = document.querySelector<SVGCircleElement>(`.pose-joint[data-joint-index="${drag.jointIndex}"]`);
  jointEl?.classList.remove("dragging");
  try {
    jointEl?.releasePointerCapture(drag.pointerId);
  } catch {
    // Capture may already be released.
  }
  const draft = poseDraftForAsset(drag.assetId);
  if (!draft || !draft.points) {
    return;
  }
  const currentPoint = draft.points[drag.jointIndex];
  if (!currentPoint) {
    return;
  }
  const svg = document.querySelector<SVGSVGElement>(".pose-overlay");
  const nextPoints = draft.points.slice();
  if (!drag.moved) {
    // クリック（ドラッグなし）: visible トグル
    nextPoints[drag.jointIndex] = { ...currentPoint, visible: !currentPoint.visible };
  } else {
    const clamped = svg ? clampPointToPoseBounds(drag.current, svg) : drag.current;
    nextPoints[drag.jointIndex] = { ...currentPoint, x: clamped.x, y: clamped.y };
  }
  setPoseDraft({ ...draft, points: nextPoints, source: "edited" });
  render();
}

async function destroyPoseWorkerSession() {
  if (!poseWorker) {
    return;
  }
  const requestId = nextPoseRequestId();
  postPoseMessage({ type: "destroy", requestId });
}

function inpaintRequestForParent(parentAssetId: string | null, generationMode: string): InpaintOptions | null {
  if (generationMode !== "img2img" || !parentAssetId) {
    return null;
  }
  const draft = inpaintDraftForAsset(parentAssetId);
  if (!draft || draft.enabled !== true) {
    return null;
  }
  const maskDataUrl = effectiveMaskDataUrl(draft);
  if (!maskDataUrl.startsWith("data:image/png;base64,")) {
    return null;
  }
  return {
    maskDataUrl,
    maskedContent: draft.maskedContent,
    inpaintArea: draft.inpaintArea,
    onlyMaskedPadding: draft.onlyMaskedPadding,
    featherRadius: draft.featherRadius
  };
}

/**
 * 生成リクエストへ渡す最終マスクを解決する。
 * 未適用の SAM 候補 preview が表示されている場合は、キャンバス表示と同じ意味論
 * （preview SAM OR manualInclude、AND NOT manualErase）で合成し直す。
 * これにより「SAM候補を適用せず手動マスクと併用して生成すると手動領域だけが
 * inpaintされる」不整合を防ぐ。layer cache が無い場合は commit 済みの
 * `maskDataUrl` にフォールバックする（その場合 preview も画面に出ていない）。
 */
function effectiveMaskDataUrl(draft: InpaintDraft): string {
  if (draft.previewSamMaskDataUrl) {
    const layers = maskLayerCache.get(draft.parentAssetId);
    if (layers) {
      return composeFinalMaskDataUrl(layers, true);
    }
  }
  return draft.maskDataUrl;
}

function toggleMaskEditor() {
  if (state.maskEditMode) {
    commitActiveMaskCanvas();
    const draft = inpaintDraftForAsset(state.activeAssetId);
    if (draft) {
      setInpaintDraft({
        ...draft,
        enabled: false
      });
    }
    state.maskEditMode = false;
    state.maskToolbarMinimized = false;
  } else if (state.activeAssetId) {
    const draft = ensureInpaintDraft(state.activeAssetId);
    setInpaintDraft({
      ...draft,
      enabled: true
    });
    state.maskEditMode = true;
    state.maskToolbarMinimized = false;
    state.paintEditMode = false;
  }
  state.maskToolbarPos = null;
  render();
}

function togglePaintEditor() {
  if (state.paintEditMode) {
    commitActivePaintCanvas();
    state.paintEditMode = false;
  } else if (state.activeAssetId) {
    ensurePaintDraft(state.activeAssetId);
    state.paintEditMode = true;
    state.maskEditMode = false;
  }
  render();
}

async function applyMaskEditor() {
  commitActiveMaskCanvas();
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!assetId || !draft) {
    return;
  }
  if (draft.samCandidates.length > 0 && draft.previewSamMaskDataUrl) {
    await applySelectedSamCandidate();
    return;
  }
  setInpaintDraft({
    ...draft,
    enabled: true
  });
  state.message = hasMaskData(draft) ? "マスクを適用しました。" : "マスクがありません。";
  render();
}

function setMaskTool(eraser: boolean) {
  if (!state.activeAssetId) {
    return;
  }
  const draft = ensureInpaintDraft(state.activeAssetId);
  const next: InpaintDraft = {
    ...draft,
    eraser
  };
  if (!eraser && draft.selectedSmartMaskProvider !== "manual") {
    next.selectedSmartMaskProvider = "manual";
    next.webSamStatusText = "Manual";
  }
  setInpaintDraft({
    ...next
  });
  render();
}

/**
 * 表示中の最終マスク（未適用の SAM 候補 preview を含む）を反転し、
 * 反転結果を単一の手動 include 層として commit する。
 */
async function invertActiveMask() {
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  const assetId = canvas?.dataset.assetId ?? state.activeAssetId;
  if (!canvas || !assetId || canvas.width <= 0 || canvas.height <= 0) {
    return;
  }
  const draft = ensureInpaintDraft(assetId);
  const layers = await ensureMaskLayerSet(draft, canvas.width, canvas.height);
  invertMaskLayers(layers, !!draft.previewSamMaskDataUrl);
  const nextDraft: InpaintDraft = {
    ...draft,
    samMaskDataUrl: "",
    previewSamMaskDataUrl: "",
    samCandidates: [],
    selectedSamCandidateIndex: 0,
    manualIncludeMaskDataUrl: canvasHasMaskPixels(layers.manualInclude) ? layers.manualInclude.toDataURL("image/png") : "",
    manualEraseMaskDataUrl: "",
    maskDataUrl: composeFinalMaskDataUrl(layers, false)
  };
  setInpaintDraft(nextDraft);
  renderFinalMaskToCanvas(canvas, layers, nextDraft, false);
  state.message = "マスク領域を反転しました。";
  render();
}

function clearActiveMaskCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  const assetId = canvas?.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  maskLayerCache.delete(assetId);
  const draft = ensureInpaintDraft(assetId);
  setInpaintDraft({
    ...draft,
    maskDataUrl: "",
    samMaskDataUrl: "",
    previewSamMaskDataUrl: "",
    manualIncludeMaskDataUrl: "",
    manualEraseMaskDataUrl: "",
    brushPromptMaskDataUrl: "",
    foregroundPoints: [],
    boxPrompt: null,
    samCandidates: [],
    selectedSamCandidateIndex: 0,
    webSamError: "",
    webSamStatusText: draft.selectedSmartMaskProvider === "manual" ? draft.webSamStatusText : "Ready"
  });
  render();
}

function clearInpaintDraft() {
  cancelPendingMaskStrokeFlush();
  activeMaskStroke = null;
  activeBoxPrompt = null;
  if (state.activeAssetId) {
    maskLayerCache.delete(state.activeAssetId);
  }
  setInpaintDraft(null);
  render();
}

// --- Paint tool -----------------------------------------------------------

function paintDraftForAsset(assetId: string | null | undefined): PaintDraft | null {
  const stored = assetId ? state.paintDrafts[assetId] : null;
  if (!stored) {
    return null;
  }
  const normalized = normalizePaintDraft(stored);
  state.paintDrafts[normalized.assetId] = normalized;
  return normalized;
}

function ensurePaintDraft(assetId: string): PaintDraft {
  const draft = normalizePaintDraft(paintDraftForAsset(assetId) ?? defaultPaintDraft(assetId));
  state.paintDrafts[assetId] = draft;
  return draft;
}

function setPaintDraft(draft: PaintDraft) {
  state.paintDrafts[draft.assetId] = normalizePaintDraft(draft);
}

function getOrCreatePaintLayer(assetId: string, width: number, height: number): HTMLCanvasElement {
  let layer = paintLayerCache.get(assetId);
  if (layer && layer.width === width && layer.height === height) {
    return layer;
  }
  layer = createPaintLayerCanvas(width, height);
  paintLayerCache.set(assetId, layer);
  return layer;
}

function activePaintCanvasAndAsset(): { canvas: HTMLCanvasElement; assetId: string } | null {
  const canvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
  const assetId = canvas?.dataset.assetId ?? state.activeAssetId;
  if (!canvas || !assetId) {
    return null;
  }
  return { canvas, assetId };
}

function syncAssetModalPaintCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  if (!canvas || !image) {
    return;
  }

  const sync = () => {
    const asset = findAsset(canvas.dataset.assetId ?? "");
    const width = image.naturalWidth || assetDimension(asset, "width") || Math.max(1, Math.round(image.clientWidth));
    const height = image.naturalHeight || assetDimension(asset, "height") || Math.max(1, Math.round(image.clientHeight));
    if (!width || !height) {
      return;
    }
    canvas.width = width;
    canvas.height = height;
    const assetId = canvas.dataset.assetId;
    if (!assetId) {
      return;
    }
    const draft = ensurePaintDraft(assetId);
    if (draft.imageWidth !== width || draft.imageHeight !== height) {
      setPaintDraft({ ...draft, imageWidth: width, imageHeight: height });
    }
    const layer = getOrCreatePaintLayer(assetId, width, height);
    renderPaintLayerToCanvas(canvas, layer);
  };

  if (image.complete && image.naturalWidth > 0) {
    sync();
  } else {
    image.addEventListener("load", sync, { once: true });
  }
}

function beginPaintStroke(event: PointerEvent, canvas: HTMLCanvasElement) {
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensurePaintDraft(assetId);
  if (draft.tool === "eyedropper") {
    pickPaintColorAt(event, canvas, assetId);
    return;
  }
  pushPaintUndoSnapshot(assetId);
  canvas.setPointerCapture(event.pointerId);
  const point = pointerToMaskCanvasPoint(canvas, event);
  activePaintStroke = {
    pointerId: event.pointerId,
    x: point.x,
    y: point.y,
    pendingSegments: []
  };
  paintCanvasSegments(canvas, [{ from: point, to: point }]);
}

function continuePaintStroke(event: PointerEvent, canvas: HTMLCanvasElement) {
  if (!activePaintStroke) {
    return;
  }
  const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const pointerEvents = coalesced.length > 0 ? coalesced : [event];
  let cursor = { x: activePaintStroke.x, y: activePaintStroke.y };
  for (const pointerEvent of pointerEvents) {
    const point = pointerToMaskCanvasPoint(canvas, pointerEvent);
    activePaintStroke.pendingSegments.push({ from: cursor, to: point });
    cursor = point;
  }
  activePaintStroke.x = cursor.x;
  activePaintStroke.y = cursor.y;
  schedulePaintStrokeFlush(canvas);
}

function schedulePaintStrokeFlush(canvas: HTMLCanvasElement) {
  if (paintStrokeRafHandle !== null) {
    return;
  }
  paintStrokeRafHandle = requestAnimationFrame(() => {
    paintStrokeRafHandle = null;
    flushPaintStrokeQueue(canvas);
  });
}

function cancelPendingPaintStrokeFlush() {
  if (paintStrokeRafHandle !== null) {
    cancelAnimationFrame(paintStrokeRafHandle);
    paintStrokeRafHandle = null;
  }
}

function flushPaintStrokeQueue(canvas: HTMLCanvasElement) {
  if (!activePaintStroke || activePaintStroke.pendingSegments.length === 0) {
    return;
  }
  const segments = activePaintStroke.pendingSegments;
  activePaintStroke.pendingSegments = [];
  paintCanvasSegments(canvas, segments);
}

function finishPaintStroke(canvas: HTMLCanvasElement) {
  cancelPendingPaintStrokeFlush();
  flushPaintStrokeQueue(canvas);
  if (activePaintStroke) {
    try {
      canvas.releasePointerCapture(activePaintStroke.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }
  activePaintStroke = null;
}

const PAINT_DIRTY_RECT_MARGIN = 2;

function paintCanvasSegments(canvas: HTMLCanvasElement, segments: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>) {
  if (segments.length === 0) {
    return;
  }
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensurePaintDraft(assetId);
  const layer = getOrCreatePaintLayer(assetId, canvas.width, canvas.height);
  const brushSize = draft.brushSize;
  const compositeOperation: GlobalCompositeOperation = draft.tool === "eraser" ? "destination-out" : "source-over";
  for (const segment of segments) {
    paintStroke(layer, segment.from, segment.to, brushSize, compositeOperation, draft.color);
  }
  const dirtyRect = dirtyRectForSegments(segments, brushSize, PAINT_DIRTY_RECT_MARGIN) ?? undefined;
  renderPaintLayerToCanvas(canvas, layer, dirtyRect);
}

function commitActivePaintCanvas() {
  cancelPendingPaintStrokeFlush();
  const canvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
  if (canvas) {
    finishPaintStroke(canvas);
  }
}

function pushPaintUndoSnapshot(assetId: string) {
  const layer = paintLayerCache.get(assetId);
  if (!layer) {
    return;
  }
  const stack = paintUndoStacks.get(assetId) ?? [];
  stack.push(snapshotPaintLayer(layer));
  while (stack.length > PAINT_UNDO_STACK_LIMIT) {
    stack.shift();
  }
  paintUndoStacks.set(assetId, stack);
}

function undoPaintStroke() {
  const active = activePaintCanvasAndAsset();
  if (!active) {
    return;
  }
  const { canvas, assetId } = active;
  const stack = paintUndoStacks.get(assetId);
  const snapshot = stack?.pop();
  if (!snapshot) {
    return;
  }
  const layer = getOrCreatePaintLayer(assetId, canvas.width, canvas.height);
  restorePaintLayerFromSnapshot(layer, snapshot);
  renderPaintLayerToCanvas(canvas, layer);
}

function setPaintTool(tool: PaintToolKind | undefined) {
  if (!tool || !state.activeAssetId) {
    return;
  }
  const draft = ensurePaintDraft(state.activeAssetId);
  setPaintDraft({ ...draft, tool });
  render();
}

function setPaintColor(color: string) {
  if (!state.activeAssetId) {
    return;
  }
  const draft = ensurePaintDraft(state.activeAssetId);
  setPaintDraft({
    ...draft,
    color,
    recentColors: pushRecentColor(draft.recentColors, color)
  });
  render();
}

function setPaintBrushSize(size: number) {
  if (!state.activeAssetId) {
    return;
  }
  const draft = ensurePaintDraft(state.activeAssetId);
  setPaintDraft({ ...draft, brushSize: clampNumber(size, 1, 256, 24) });
}

function pickPaintColorAt(event: PointerEvent, canvas: HTMLCanvasElement, assetId: string) {
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  if (!image) {
    return;
  }
  const point = pointerToMaskCanvasPoint(canvas, event);
  const layer = getOrCreatePaintLayer(assetId, canvas.width, canvas.height);
  const composed = composePaintResultCanvas(image, layer, canvas.width, canvas.height);
  const color = sampleColorAt(composed, point.x, point.y);
  if (!color) {
    return;
  }
  const draft = ensurePaintDraft(assetId);
  if (paintAltEyedropperActive && draft.previousTool) {
    setPaintDraft({
      ...draft,
      color,
      recentColors: pushRecentColor(draft.recentColors, color),
      tool: draft.previousTool,
      previousTool: null
    });
    paintAltEyedropperActive = false;
  } else {
    setPaintDraft({
      ...draft,
      color,
      recentColors: pushRecentColor(draft.recentColors, color)
    });
  }
  render();
}

function beginAltEyedropper() {
  if (!state.paintEditMode || !state.activeAssetId) {
    return;
  }
  const draft = ensurePaintDraft(state.activeAssetId);
  if (draft.tool === "eyedropper" || draft.previousTool) {
    return;
  }
  paintAltEyedropperActive = true;
  setPaintDraft({ ...draft, previousTool: draft.tool, tool: "eyedropper" });
  render();
}

function endAltEyedropper() {
  if (!paintAltEyedropperActive || !state.activeAssetId) {
    return;
  }
  const draft = paintDraftForAsset(state.activeAssetId);
  if (draft?.previousTool) {
    setPaintDraft({ ...draft, tool: draft.previousTool, previousTool: null });
  }
  paintAltEyedropperActive = false;
  render();
}

function clearActivePaintCanvas() {
  const active = activePaintCanvasAndAsset();
  if (!active) {
    return;
  }
  const { canvas, assetId } = active;
  pushPaintUndoSnapshot(assetId);
  const layer = getOrCreatePaintLayer(assetId, canvas.width, canvas.height);
  clearCanvas(layer);
  renderPaintLayerToCanvas(canvas, layer);
}

async function savePaintResultAsSourceAsset() {
  const active = activePaintCanvasAndAsset();
  const asset = state.activeAssetId ? findAsset(state.activeAssetId) : null;
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  if (!active || !asset || !image || !state.currentProjectId) {
    return;
  }
  commitActivePaintCanvas();
  const { canvas, assetId } = active;
  const layer = getOrCreatePaintLayer(assetId, canvas.width, canvas.height);
  const composed = composePaintResultCanvas(image, layer, canvas.width, canvas.height);
  const dataUrl = composed.toDataURL("image/png");

  const form = document.querySelector<HTMLFormElement>("#generation-form");
  const draft = form ? generationDraftFromForm(form) : null;
  const templateId = draft?.img2imgTemplateId || draft?.templateId || asset.workflowTemplateId || "";
  if (!templateId) {
    state.message = "WorkflowTemplateを選択してから保存してください。";
    render();
    return;
  }

  const denoise = normalizeDenoiseForMode(
    Number(draft?.denoise || defaultDenoiseForMode("img2img")),
    "img2img"
  );

  state.busy = true;
  state.message = "ペイント結果を新規アセットとして保存しています。";
  render();

  const response = await api<{ round: Round; asset: Asset }>(`/api/projects/${state.currentProjectId}/source-assets`, {
    method: "POST",
    body: JSON.stringify({
      filename: `paint_${assetId}_${Date.now()}.png`,
      mimeType: "image/png",
      dataUrl,
      templateId,
      prompt: draft?.prompt ?? "",
      negativePrompt: draft?.negativePrompt ?? "",
      seed: draft?.seed ? Number(draft.seed) : null,
      seedMode: draft?.seedMode ?? "random",
      batchSize: Number(draft?.batchSize || 1),
      steps: Number(draft?.steps || 20),
      cfg: Number(draft?.cfg || 7),
      sampler: draft?.sampler || "euler",
      scheduler: draft?.scheduler || "normal",
      denoise,
      width: canvas.width,
      height: canvas.height
    })
  });

  state.busy = false;
  state.generationDraft = {
    ...(draft ?? {}),
    templateId: draft?.templateId || templateId,
    img2imgTemplateId: templateId,
    denoise: String(denoise),
    generationMode: "img2img"
  };
  applyAssetDimensionsToDraft(response.asset);
  paintLayerCache.delete(assetId);
  paintUndoStacks.delete(assetId);
  delete state.paintDrafts[assetId];
  state.paintEditMode = false;
  state.message = "ペイント結果を新規アセットとして保存し、親画像に設定しました。";
  await refreshProject(response.round.id, null);
  render();
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function assetDimension(asset: Asset | null, key: "width" | "height") {
  const value = asset?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resetGenerationParamsToTemplateDefaults() {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (!form) {
    return;
  }

  const templateId = (form.elements.namedItem("templateId") as HTMLSelectElement | null)?.value ?? "";
  const template = state.templates.find((item) => item.id === templateId) ?? null;
  const defaults = templateGenerationDefaults(template);
  const mode = defaultModeForTemplate(template);

  setFormValue(form, "batchSize", String(defaults.batchSize ?? 16));
  setFormValue(form, "steps", String(defaults.steps ?? 20));
  setFormValue(form, "cfg", String(defaults.cfg ?? 7));
  setFormValue(form, "denoise", String(normalizeDenoiseForMode(defaults.denoise ?? defaultDenoiseForMode(mode), mode)));
  setFormValue(form, "width", String(defaults.width ?? 512));
  setFormValue(form, "height", String(defaults.height ?? 768));
  setFormValue(form, "seed", String(defaults.seed ?? -1));
  setFormValue(form, "seedMode", "random");
  setFormValue(form, "sampler", defaults.sampler ?? "euler");
  setFormValue(form, "scheduler", defaults.scheduler ?? "normal");
  setFormValue(form, "generationMode", mode);

  captureGenerationDraft();
  state.message = "生成パラメータをWorkflow JSONの初期値に戻しました。";
  render();
}

function renderGenerationPanelView(detail: ProjectDetail, activeAsset: Asset | null) {
  const activeRound = getActiveRound(detail);
  const draft = state.generationDraft;
  const draftParent = findAsset(draft?.parentAssetId ?? "");
  const previous = activeAsset ?? draftParent ?? getPreferredParentAsset();
  const activeInpaint = previous?.id ? inpaintDraftForAsset(previous.id) : null;
  return renderGenerationPanel(detail, activeRound, previous, draft, activeInpaint);
}

function updateDenoiseControlForMode(mode: string) {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  const control = form?.elements.namedItem("denoise") as HTMLInputElement | null;
  if (!form || !control) {
    return;
  }

  const current = Number(control.value);
  const value = requiresFullDenoise(mode)
    ? 1
    : !Number.isFinite(current) || current >= 1
      ? defaultDenoiseForMode(mode)
      : current;
  setFormValue(form, "denoise", String(value));
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
    poseDraft
  );
}

function currentPositivePromptValue(asset: Asset) {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return state.generationDraft?.prompt ?? activeRound?.request?.prompt ?? asset.prompt ?? defaultPrompt;
}

function currentBatchSizeValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return draftNumber(state.generationDraft, "batchSize") ?? activeRound?.request?.batchSize ?? 16;
}

function getActiveRound(detail: ProjectDetail) {
  return detail.rounds.find((round) => round.id === state.activeRoundId) ?? detail.rounds[0] ?? null;
}

function findRound(roundId: string | null) {
  if (!roundId || !state.detail) {
    return null;
  }
  return state.detail.rounds.find((round) => round.id === roundId) ?? null;
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
  applyAssetDimensionsToForm(form, asset);
  preserveDenoiseOnAssetFill(form, mode);
  captureGenerationDraft();
}

function preserveDenoiseOnAssetFill(form: HTMLFormElement, mode: string) {
  const denoise = form.elements.namedItem("denoise") as HTMLInputElement | null;
  if (!denoise) {
    return;
  }
  if (requiresFullDenoise(mode)) {
    setFormValue(form, "denoise", "1");
    return;
  }
  const current = Number(denoise.value);
  if (!Number.isFinite(current) || current <= 0 || current >= 1) {
    setFormValue(form, "denoise", String(defaultDenoiseForMode(mode)));
  }
}

function prepareGenerationFormForParent(asset: Asset, mode: string) {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (!form) {
    return;
  }

  const previousMode = (form.elements.namedItem("generationMode") as HTMLSelectElement | null)?.value ?? "txt2img";
  const previousParentAssetId = (form.elements.namedItem("parentAssetId") as HTMLInputElement | null)?.value ?? "";
  const denoise = form.elements.namedItem("denoise") as HTMLInputElement | null;
  setFormValue(form, "parentAssetId", asset.id);
  setFormValue(form, "generationMode", mode);
  if (previousParentAssetId !== asset.id) {
    applyAssetDimensionsToForm(form, asset);
  }

  if (denoise && requiresFullDenoise(previousMode) && Number(denoise.value) >= 1 && !requiresFullDenoise(mode)) {
    setFormValue(form, "denoise", String(defaultDenoiseForMode(mode)));
  }

  captureGenerationDraft();
}

function applyAssetDimensionsToForm(form: HTMLFormElement, asset: Asset) {
  if (typeof asset.width === "number" && Number.isFinite(asset.width)) {
    setFormValue(form, "width", String(asset.width));
  }
  if (typeof asset.height === "number" && Number.isFinite(asset.height)) {
    setFormValue(form, "height", String(asset.height));
  }
}

function applyAssetDimensionsToDraft(asset: Asset) {
  if (typeof asset.width === "number" && Number.isFinite(asset.width)) {
    setGenerationDraftValue("width", String(asset.width));
  }
  if (typeof asset.height === "number" && Number.isFinite(asset.height)) {
    setGenerationDraftValue("height", String(asset.height));
  }
}

function setFormValue(form: HTMLFormElement, name: string, value: string) {
  const control = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (control) {
    control.value = value;
    const valueTargetId = (control as HTMLElement).dataset.valueTarget;
    if (valueTargetId && control instanceof HTMLInputElement) {
      const valueTarget = document.getElementById(valueTargetId);
      if (valueTarget) {
        valueTarget.textContent = formatSliderValue(control);
      }
    }
  }
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

function formValue(form: HTMLFormElement, name: string) {
  const control = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return control?.value ?? "";
}

function resolveTemplateForGeneration(templateId: string, mode: string) {
  const current = state.templates.find((template) => template.id === templateId) ?? null;
  if (!current) {
    throw new Error(`${mode}用WorkflowTemplateが選択されていません。`);
  }
  return current;
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

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
