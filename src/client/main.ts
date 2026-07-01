import mermaid from "mermaid";
import { createWorkflowMermaidDiagram, type WorkflowDiagram, type WorkflowDiagramStatus } from "../shared/workflowDiagram";
import { inferRoleMap } from "../shared/workflowRoleMap";
import { DEFAULT_WEB_SAM_MODEL_BASE_URL } from "../shared/constants";
import type { InpaintArea, InpaintOptions, MaskedContent } from "../shared/types";
import {
  iconBrush,
  iconCheck,
  iconChevron,
  iconClose,
  iconDiagram,
  iconDot,
  iconDownload,
  iconEraser,
  iconLoop,
  iconLoopArrows,
  iconMask,
  iconMenu,
  iconMinimize,
  iconPlay,
  iconPlus,
  iconPulse,
  iconReset,
  iconSave,
  iconSettings,
  iconShuffle,
  iconStar,
  iconStop,
  iconSwap,
  iconTrash,
  iconZoom
} from "./icons";
import { buildWebSamModelUrls, formatModelBytes, modelForProvider, SMART_MASK_PROVIDERS } from "./websam/models";
import type {
  WebSamBox,
  WebSamModelStatus,
  WebSamPoint,
  WebSamPromptMode,
  WebSamProviderId,
  WebSamWorkerCandidate,
  WebSamWorkerRequest,
  WebSamWorkerResponse
} from "./websam/types";

type Json = Record<string, unknown>;

interface ComfySettings {
  baseUrl: string;
  websocketUrl: string;
  timeoutSeconds: number;
  imageFetchMode: "view";
  storageDir: string;
  webSamModelBaseUrl: string;
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

interface WorkflowImportDraft {
  name: string;
  description: string;
  type: string;
  workflowJson: string;
  roleMap: string;
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
  branchColorIndex: number;
  branchReason?: string | null;
  branchKey?: string | null;
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

interface CollectRoundResponse {
  round?: Round;
  assets?: Asset[];
  message?: string;
  jobStats?: Json;
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
  inpaint?: InpaintOptions | null;
}

interface InpaintDraft {
  parentAssetId: string;
  maskDataUrl: string;
  enabled: boolean;
  maskedContent: MaskedContent;
  inpaintArea: InpaintArea;
  onlyMaskedPadding: number;
  brushSize: number;
  eraser: boolean;
  selectedSmartMaskProvider: WebSamProviderId;
  selectedWebSamModel: string;
  webSamModelStatus: WebSamModelStatus;
  webSamDownloadProgress: number;
  webSamStatusText: string;
  webSamError: string;
  webSamPromptMode: WebSamPromptMode;
  foregroundPoints: WebSamPoint[];
  boxPrompt: WebSamBox | null;
  brushPromptMaskDataUrl: string;
  samCandidates: SamMaskCandidate[];
  selectedSamCandidateIndex: number;
  samMaskDataUrl: string;
  previewSamMaskDataUrl: string;
  manualIncludeMaskDataUrl: string;
  manualEraseMaskDataUrl: string;
  threshold: number;
  smoothing: number;
  maskOpacity: number;
  zoomScale: number;
  panOffset: { x: number; y: number };
  imageWidth: number | null;
  imageHeight: number | null;
}

interface SamMaskCandidate {
  index: number;
  score: number | null;
  dataUrl: string;
}

type MaskStrokeKind = "manual-include" | "manual-erase" | "brush-prompt";

interface ActiveMaskStroke {
  pointerId: number;
  x: number;
  y: number;
  kind: MaskStrokeKind;
}

interface ActiveBoxPrompt {
  pointerId: number;
  start: { x: number; y: number };
  current: { x: number; y: number };
}

interface ActiveImagePan {
  pointerId: number;
  assetId: string;
  startClient: { x: number; y: number };
  originOffset: { x: number; y: number };
}

interface MaskLayerSet {
  assetId: string;
  width: number;
  height: number;
  samMask: HTMLCanvasElement;
  previewSamMask: HTMLCanvasElement;
  manualInclude: HTMLCanvasElement;
  manualErase: HTMLCanvasElement;
  brushPrompt: HTMLCanvasElement;
}

interface ScrollPosition {
  left: number;
  top: number;
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
let messageClearTimer: ReturnType<typeof window.setTimeout> | null = null;
let pendingAssetCardSelect: { assetId: string; timer: ReturnType<typeof window.setTimeout> } | null = null;
let pendingIterationDotSelect: { timer: ReturnType<typeof window.setTimeout> } | null = null;
let activeMaskStroke: ActiveMaskStroke | null = null;
let activeBoxPrompt: ActiveBoxPrompt | null = null;
let activeImagePan: ActiveImagePan | null = null;
let maskToolbarDrag: { pointerId: number; startX: number; startY: number; originLeft: number; originTop: number } | null = null;
const maskLayerCache = new Map<string, MaskLayerSet>();
let webSamWorker: Worker | null = null;
let webSamRequestId = 0;
let latestWebSamLoadRequestId = 0;
let latestWebSamEncodeRequestId = 0;
let latestWebSamDecodeRequestId = 0;
let workflowDiagramRenderRunId = 0;

const defaultWorkflowImportRoleMap = `{
  "positive_prompt_node": "6",
  "negative_prompt_node": "7",
  "ksampler_node": "3",
  "seed_input": "3.inputs.seed",
  "cfg_input": "3.inputs.cfg",
  "steps_input": "3.inputs.steps",
  "denoise_input": "3.inputs.denoise",
  "ksampler_latent_image_input": "3.inputs.latent_image",
  "batch_size_input": "5.inputs.batch_size",
  "load_image_node": "12",
  "load_image_input": "12.inputs.image",
  "vae_encode_node": "13",
  "vae_encode_image_input": "13.inputs.pixels",
  "save_image_node": "9"
}`;

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "dark",
  flowchart: {
    curve: "basis",
    htmlLabels: false,
    nodeSpacing: 42,
    rankSpacing: 60
  },
  themeVariables: {
    background: "#12121f",
    primaryColor: "#171729",
    primaryTextColor: "#f4f4f7",
    primaryBorderColor: "#4b5563",
    lineColor: "#8b8ba8",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
  }
});

function defaultWorkflowImportDraft(): WorkflowImportDraft {
  return {
    name: "",
    description: "",
    type: "txt2img",
    workflowJson: "{}",
    roleMap: defaultWorkflowImportRoleMap
  };
}

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
  deletePreviewRoundId: string | null;
  workflowImportModalOpen: boolean;
  workflowImportDraft: WorkflowImportDraft;
  activeWorkflowDiagramTemplateId: string | null;
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
  deletePreviewRoundId: null,
  workflowImportModalOpen: false,
  workflowImportDraft: defaultWorkflowImportDraft(),
  activeWorkflowDiagramTemplateId: null
};

const defaultPrompt =
  "masterpiece, best quality, 1girl, beautiful detailed eyes, flowing hair, fantasy landscape, dramatic lighting, ethereal atmosphere";
const defaultNegativePrompt = "low quality, worst quality, blurry, deformed";
const pendingAutoCollectRoundIds = new Set<string>();
const autoCollectIntervalMs = 3_000;
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
const maskedContentOptions: Array<{ value: MaskedContent; label: string }> = [
  { value: "original", label: "original（元画像を維持・低デノイズで灰色になりにくい）" },
  { value: "fill", label: "fill（マスク部を灰色で埋める・低デノイズで灰色が残る）" },
  { value: "latent_noise", label: "latent noise（空の潜在にノイズマスク）" },
  { value: "latent_nothing", label: "latent nothing（空の潜在）" }
];

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
    if (target.dataset.inpaintField) {
      updateInpaintDraftFromControl(target);
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
    if (valueTarget) {
      const suffix = target.dataset.inpaintField === "onlyMaskedPadding" || target.dataset.inpaintField === "brushSize" ? "px" : "";
      valueTarget.textContent = `${formatSliderValue(target)}${suffix}`;
    }
    if (target.closest("#generation-form")) {
      captureGenerationDraft();
    }
    if (target.dataset.smartMaskField) {
      updateSmartMaskDraftFromControl(target);
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
    if (target.id !== "maskCanvas" && !target.closest(".preview-media")) {
      return;
    }
    if (!state.activeAssetId) {
      return;
    }
    event.preventDefault();
    handleMaskWheelZoom(event);
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

  app.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    closeOpenActionDropdowns(target);
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
    const previewMedia = target.closest<HTMLElement>(".preview-media");
    const shouldPanImage =
      !!previewMedia &&
      !!state.activeAssetId &&
      (event.button === 1 || (!state.maskEditMode && event.button === 0));
    if (shouldPanImage) {
      event.preventDefault();
      beginImagePan(event, previewMedia, state.activeAssetId);
      return;
    }
    if (event.button !== 0 && event.button !== 2) {
      return;
    }
    if (target.id !== "maskCanvas") {
      return;
    }
    if (!state.maskEditMode) {
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
    if (maskToolbarDrag && event.pointerId === maskToolbarDrag.pointerId) {
      maskToolbarDrag = null;
      return;
    }
    if (activeBoxPrompt && event.pointerId === activeBoxPrompt.pointerId) {
      activeBoxPrompt = null;
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
  state.maskEditMode = false;
  state.maskToolbarMinimized = false;
  state.maskToolbarPos = null;
  activeImagePan = null;
  render();
}

function closeAssetDetail() {
  commitActiveMaskCanvas();
  activeMaskStroke = null;
  activeBoxPrompt = null;
  activeImagePan = null;
  void destroyWebSamWorkerSession();
  state.activeAssetId = null;
  state.maskEditMode = false;
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

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("画像ファイルを読み込めませんでした。")));
    reader.readAsDataURL(file);
  });
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
    relationType: resolvedParentAsset ? relationForMode(generationMode) : null
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
    ${state.detail ? renderProjectDetail(state.detail) : renderHome()}
    ${renderAssetModal()}
    ${renderWorkflowImportModal()}
    ${renderWorkflowDiagramModal()}
  `;
  restoreIterationScrollPosition();
  if (preserveIterationScroll) {
    requestAnimationFrame(() => {
      restoreIterationScrollPosition();
    });
  }
  syncAssetModalMaskCanvas();
  void renderWorkflowDiagramCanvases();
}

async function renderWorkflowDiagramCanvases() {
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-mermaid-diagram]"));
  if (targets.length === 0) {
    return;
  }

  const runId = ++workflowDiagramRenderRunId;
  for (const [index, target] of targets.entries()) {
    const source = target.querySelector<HTMLElement>(".workflow-diagram-source")?.textContent ?? "";
    if (!source.trim()) {
      continue;
    }
    target.dataset.state = "loading";
    try {
      const result = await mermaid.render(`workflow-diagram-${runId}-${index}`, source);
      if (runId !== workflowDiagramRenderRunId || !target.isConnected) {
        return;
      }
      target.innerHTML = result.svg;
      target.dataset.state = "ready";
    } catch (error) {
      if (runId !== workflowDiagramRenderRunId || !target.isConnected) {
        return;
      }
      target.dataset.state = "error";
      target.innerHTML = `
        <div class="workflow-diagram-error">Mermaid diagramを描画できませんでした。</div>
        <pre class="workflow-diagram-fallback">${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>
        <pre class="workflow-diagram-fallback">${escapeHtml(source)}</pre>
      `;
    }
  }
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

type MaskBrushCursorKind = "pen" | "eraser" | "brush-prompt";

function resolveMaskBrushCursorKind(draft: InpaintDraft): MaskBrushCursorKind | null {
  if (draft.selectedSmartMaskProvider !== "manual") {
    return draft.webSamPromptMode === "brush" ? "brush-prompt" : null;
  }
  return draft.eraser ? "eraser" : "pen";
}

function updateMaskBrushCursor(event: PointerEvent) {
  const canvas = event.currentTarget as HTMLCanvasElement | null;
  if (!canvas || !state.maskEditMode) {
    return;
  }
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!draft) {
    hideMaskBrushCursor();
    return;
  }
  const kind = resolveMaskBrushCursorKind(draft);
  const cursor = document.querySelector<SVGCircleElement>(".brush-cursor");
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
  const cursor = document.querySelector<SVGCircleElement>(".brush-cursor");
  if (!cursor) {
    return;
  }
  cursor.removeAttribute("r");
  cursor.setAttribute("r", "0");
  cursor.classList.remove("visible", "pen", "eraser", "brush-prompt");
}

function createLayerCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function ensureMaskLayerSet(draft: InpaintDraft, width: number, height: number): Promise<MaskLayerSet> {
  let layers = maskLayerCache.get(draft.parentAssetId);
  if (layers && layers.width === width && layers.height === height) {
    return layers;
  }

  layers = {
    assetId: draft.parentAssetId,
    width,
    height,
    samMask: createLayerCanvas(width, height),
    previewSamMask: createLayerCanvas(width, height),
    manualInclude: createLayerCanvas(width, height),
    manualErase: createLayerCanvas(width, height),
    brushPrompt: createLayerCanvas(width, height)
  };
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

function clearCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  context?.clearRect(0, 0, canvas.width, canvas.height);
}

function drawDataUrlIntoCanvas(canvas: HTMLCanvasElement, dataUrl: string) {
  if (!dataUrl) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const context = canvas.getContext("2d");
      if (context) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      }
      resolve();
    }, { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
    image.src = dataUrl;
  });
}

function renderFinalMaskToCanvas(canvas: HTMLCanvasElement, layers: MaskLayerSet, draft: InpaintDraft, includePreview: boolean) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  const samSource = includePreview && draft.previewSamMaskDataUrl ? layers.previewSamMask : layers.samMask;
  context.globalCompositeOperation = "source-over";
  context.drawImage(samSource, 0, 0, canvas.width, canvas.height);
  context.drawImage(layers.manualInclude, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "destination-out";
  context.drawImage(layers.manualErase, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "source-over";
}

function composeFinalMaskDataUrl(layers: MaskLayerSet, includeSamPreview = false) {
  const canvas = createLayerCanvas(layers.width, layers.height);
  const context = canvas.getContext("2d");
  if (!context) {
    return "";
  }
  context.drawImage(includeSamPreview ? layers.previewSamMask : layers.samMask, 0, 0);
  context.drawImage(layers.manualInclude, 0, 0);
  context.globalCompositeOperation = "destination-out";
  context.drawImage(layers.manualErase, 0, 0);
  context.globalCompositeOperation = "source-over";
  return canvasHasMaskPixels(canvas) ? canvas.toDataURL("image/png") : "";
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
  layers = {
    assetId,
    width,
    height,
    samMask: createLayerCanvas(width, height),
    previewSamMask: createLayerCanvas(width, height),
    manualInclude: createLayerCanvas(width, height),
    manualErase: createLayerCanvas(width, height),
    brushPrompt: createLayerCanvas(width, height)
  };
  maskLayerCache.set(assetId, layers);
  return layers;
}

function maskLayerForStroke(layers: MaskLayerSet, kind: MaskStrokeKind) {
  if (kind === "manual-erase") {
    return layers.manualErase;
  }
  if (kind === "brush-prompt") {
    return layers.brushPrompt;
  }
  return layers.manualInclude;
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

function normalizePromptBox(box: WebSamBox | null): WebSamBox | null {
  if (!box) {
    return null;
  }
  const x1 = Math.min(box.x1, box.x2);
  const x2 = Math.max(box.x1, box.x2);
  const y1 = Math.min(box.y1, box.y2);
  const y2 = Math.max(box.y1, box.y2);
  if (Math.abs(x2 - x1) < 2 || Math.abs(y2 - y1) < 2) {
    return null;
  }
  return { x1, y1, x2, y2 };
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

function sampleBrushPromptPoints(canvas: HTMLCanvasElement, spacing: number, maxPoints: number): WebSamPoint[] {
  const context = canvas.getContext("2d");
  if (!context || canvas.width <= 0 || canvas.height <= 0) {
    return [];
  }
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const points: WebSamPoint[] = [];
  for (let y = Math.floor(spacing / 2); y < canvas.height; y += spacing) {
    for (let x = Math.floor(spacing / 2); x < canvas.width; x += spacing) {
      if (pixels[(y * canvas.width + x) * 4 + 3]! <= 0) {
        continue;
      }
      points.push({ x, y, label: 1, source: "brush" });
      if (points.length >= maxPoints) {
        return points;
      }
    }
  }
  return points;
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

function distanceToSegmentSq(point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    return (point.x - from.x) ** 2 + (point.y - from.y) ** 2;
  }
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy)));
  const projectedX = from.x + t * dx;
  const projectedY = from.y + t * dy;
  return (point.x - projectedX) ** 2 + (point.y - projectedY) ** 2;
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
    kind
  };
  drawMaskSegment(canvas, point, point, kind);
  if (kind === "manual-include" || kind === "manual-erase") {
    commitMaskCanvas(canvas);
  }
}

function continueMaskStroke(event: PointerEvent, canvas: HTMLCanvasElement) {
  if (!activeMaskStroke) {
    return;
  }
  const point = pointerToMaskCanvasPoint(canvas, event);
  drawMaskSegment(canvas, activeMaskStroke, point, activeMaskStroke.kind);
  activeMaskStroke = {
    pointerId: event.pointerId,
    x: point.x,
    y: point.y,
    kind: activeMaskStroke.kind
  };
}

function finishMaskStroke(canvas: HTMLCanvasElement) {
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

function pointerToMaskCanvasPoint(canvas: HTMLCanvasElement, event: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
  const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

function drawMaskSegment(canvas: HTMLCanvasElement, from: { x: number; y: number }, to: { x: number; y: number }, kind: MaskStrokeKind) {
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  const draft = inpaintDraftForAsset(assetId) ?? (assetId ? ensureInpaintDraft(assetId) : null);
  if (!draft || !assetId) {
    return;
  }
  const layers = getOrCreateMaskLayerSet(assetId, canvas.width, canvas.height);
  const brushSize = draft.brushSize;

  if (kind === "manual-include") {
    // Add to the include layer, and lift any prior erase strokes in the same area so
    // a previously erased region can be re-masked by drawing over it with the pen.
    paintStroke(layers.manualInclude, from, to, brushSize, "source-over");
    paintStroke(layers.manualErase, from, to, brushSize, "destination-out");
  } else if (kind === "manual-erase") {
    paintStroke(layers.manualErase, from, to, brushSize, "source-over");
    removeBrushPromptPointsNearSegment(assetId, from, to, brushSize / 2);
  } else {
    paintStroke(maskLayerForStroke(layers, kind), from, to, brushSize, "source-over");
  }
  renderFinalMaskToCanvas(canvas, layers, draft, true);
}

function paintStroke(canvas: HTMLCanvasElement, from: { x: number; y: number }, to: { x: number; y: number }, brushSize: number, compositeOperation: GlobalCompositeOperation) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.save();
  context.globalCompositeOperation = compositeOperation;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = brushSize;
  context.strokeStyle = "rgba(255, 255, 255, 1)";
  context.fillStyle = "rgba(255, 255, 255, 1)";
  if (from.x === to.x && from.y === to.y) {
    context.beginPath();
    context.arc(to.x, to.y, brushSize / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }
  context.restore();
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

function canvasHasMaskPixels(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context || canvas.width <= 0 || canvas.height <= 0) {
    return false;
  }

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index]! > 0) {
      return true;
    }
  }
  return false;
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

function renderIterationTracker(detail: ProjectDetail) {
  const rounds = sortRoundsAsc(detail.rounds);
  if (!rounds.length) {
    return `<div class="iteration-tracker empty-tracker"><span class="iteration-empty">No iterations</span></div>`;
  }
  const forest = buildRoundForest(rounds);
  const deleteTargetIds = state.deletePreviewRoundId
    ? collectRoundSubtreeIds(state.deletePreviewRoundId, forest.children)
    : new Set<string>();
  return `
    <div class="iteration-tracker" aria-label="イテレーション">
      <div class="iteration-forest">
        ${forest.roots.map((round) => renderRoundTreeNode(round, forest.children, deleteTargetIds)).join("")}
      </div>
    </div>
  `;
}

function buildRoundForest(rounds: Round[]) {
  const byId = new Map(rounds.map((round) => [round.id, round]));
  const children = new Map<string, Round[]>();
  const roots: Round[] = [];

  for (const round of rounds) {
    const parentId = round.parentRoundId && byId.has(round.parentRoundId) ? round.parentRoundId : null;
    if (!parentId) {
      roots.push(round);
      continue;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(round);
    children.set(parentId, siblings);
  }

  return { roots, children };
}

function collectRoundSubtreeIds(rootRoundId: string, children: Map<string, Round[]>) {
  const ids = new Set<string>();
  const visit = (roundId: string) => {
    ids.add(roundId);
    for (const child of children.get(roundId) ?? []) {
      visit(child.id);
    }
  };
  visit(rootRoundId);
  return ids;
}

function renderRoundTreeNode(round: Round, children: Map<string, Round[]>, deleteTargetIds: Set<string>) {
  const childRounds = children.get(round.id) ?? [];
  const active = round.id === state.activeRoundId;
  const completed = round.status === "completed";
  const dotClass = active ? "active" : completed ? "completed" : "pending";
  const hue = branchHue(round);
  const isDeleteRoot = state.deletePreviewRoundId === round.id;
  const isDeleteTarget = deleteTargetIds.has(round.id);
  return `
    <div class="iteration-node ${childRounds.length ? "has-children" : ""} ${isDeleteRoot ? "delete-preview-root" : ""} ${isDeleteTarget ? "delete-preview-target" : ""}" style="--branch-hue: ${hue}">
      <button class="iteration-dot ${dotClass}" data-action="select-round" data-id="${round.id}" type="button" title="${escapeAttr(iterationTitle(round))}">
        <span>${round.roundIndex}</span>
      </button>
      ${isDeleteTarget ? `
        <button class="iteration-delete-mark" type="button" data-action="delete-round" data-id="${state.deletePreviewRoundId ?? round.id}" title="削除">
          ${iconClose()}
        </button>
      ` : ""}
      ${childRounds.length ? `
        <div class="iteration-children ${childRounds.length > 1 ? "has-siblings" : "single-child"}">
          ${childRounds.map((child, index) => `
            <div class="iteration-child ${index === 0 ? "first" : ""} ${index === childRounds.length - 1 ? "last" : ""}">
              ${renderRoundTreeNode(child, children, deleteTargetIds)}
            </div>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function branchHue(round: Round) {
  return ((round.branchColorIndex ?? 0) * 57) % 360;
}

function iterationTitle(round: Round) {
  const parent = round.parentRoundId ? ` / parent ${round.parentRoundId}` : " / root";
  return `Round ${round.roundIndex} / ${generationModeLabel(round.generationMode)} / ${round.status}${parent}`;
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
        ${renderWorkflowImportPanel()}
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
        <label>WebSAM model base URL<input name="webSamModelBaseUrl" value="${escapeAttr(settings?.webSamModelBaseUrl ?? DEFAULT_WEB_SAM_MODEL_BASE_URL)}" placeholder="${escapeAttr(DEFAULT_WEB_SAM_MODEL_BASE_URL)}" /></label>
        <div class="button-row">
          <button class="button-secondary" type="button" data-action="save-settings">${iconSave()}保存</button>
          <button class="button-secondary" type="button" data-action="test-comfy">${iconPulse()}接続テスト</button>
        </div>
      </form>
    </section>
  `;
}

function renderWorkflowImportPanel() {
  return `
    <section class="panel workflow-import-collapsed">
      <button class="button-primary workflow-import-trigger" type="button" data-action="open-template-import">
        ${iconPlus()}テンプレート登録
      </button>
    </section>
  `;
}

function renderTemplatePanel() {
  return `
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">Workflow</p>
          <h2>WorkflowTemplate</h2>
        </div>
      </div>
      <div class="template-list">
        ${state.templates.map((template) => `
          <article class="template-row">
            <div class="template-row-main">
              <strong>${escapeHtml(template.name)} v${template.version}</strong>
              <span>${escapeHtml(template.type)}</span>
              ${template.description ? `<small>${escapeHtml(template.description)}</small>` : ""}
            </div>
            <div class="template-row-actions">
              <button class="button-secondary compact template-action-button" type="button" data-action="open-template-diagram" data-template-id="${escapeAttr(template.id)}" aria-label="diagram" title="diagram">${iconDiagram()}</button>
              <details class="template-export-dropdown">
              <summary class="button-secondary compact template-action-button template-export-trigger" style="display:grid;place-items:center;line-height:0;" aria-label="export" title="export">${iconDownload(true)}</summary>
                <div class="template-export-menu">
                  <button class="button-secondary compact" type="button" data-action="export-workflow" data-template-id="${escapeAttr(template.id)}">${iconDownload()}raw export</button>
                  <button class="button-secondary compact" type="button" data-action="export-template" data-template-id="${escapeAttr(template.id)}">${iconDownload()}template export</button>
                </div>
              </details>
              <button class="button-danger compact template-action-button" type="button" data-action="delete-template" data-template-id="${escapeAttr(template.id)}" aria-label="削除" title="削除">${iconTrash()}</button>
            </div>
          </article>
        `).join("") || `<div class="empty">登録済みテンプレートはありません。</div>`}
      </div>
    </section>
  `;
}

function renderWorkflowImportModal() {
  if (!state.workflowImportModalOpen) {
    return "";
  }
  const draft = state.workflowImportDraft;
  return `
    <div class="workflow-modal" role="dialog" aria-modal="true" aria-label="テンプレート登録">
      <section class="workflow-dialog workflow-import-dialog">
        <header class="workflow-dialog-header">
          <div>
            <p class="section-kicker">Workflow Import</p>
            <h2>テンプレート登録</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-template-import" aria-label="閉じる" title="閉じる">${iconClose()}</button>
        </header>
        <form id="template-form" class="workflow-import-modal-form">
          <div class="workflow-import-fields form-stack">
            <label>JSONファイル
              <input data-file-target="workflowJson" type="file" accept=".json,application/json" />
            </label>
            <label>名前<input name="name" placeholder="txt2img_16grid" value="${escapeAttr(draft.name)}" /></label>
            <label>説明<input name="description" value="${escapeAttr(draft.description)}" /></label>
            <label>種別
              <select name="type">
                ${renderWorkflowTypeOptions(draft.type)}
              </select>
            </label>
            <label>API形式workflow JSON<textarea class="workflow-json-textarea" name="workflowJson" rows="12" spellcheck="false">${escapeHtml(draft.workflowJson)}</textarea></label>
            <label>role map<textarea class="role-map-textarea" name="roleMap" rows="18" spellcheck="false">${escapeHtml(draft.roleMap)}</textarea></label>
          </div>
          <aside class="workflow-diagram-preview">
            <div class="workflow-diagram-heading">
              <div>
                <p class="section-kicker">Preview</p>
                <h3>diagram</h3>
              </div>
            </div>
            <div class="workflow-import-preview-slot">
              ${renderWorkflowImportPreview()}
            </div>
          </aside>
          <div class="workflow-import-modal-actions">
            <button class="button-secondary" type="button" data-action="close-template-import">${iconClose()}閉じる</button>
            <button class="button-primary" type="button" data-action="create-template">${iconPlus()}テンプレート登録</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderWorkflowDiagramModal() {
  const templateId = state.activeWorkflowDiagramTemplateId;
  if (!templateId) {
    return "";
  }
  const template = state.templates.find((item) => item.id === templateId) ?? null;
  if (!template) {
    return "";
  }
  const diagram = createWorkflowMermaidDiagram(template.workflowJson, template.roleMap);
  return `
    <div class="workflow-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(template.name)} diagram">
      <section class="workflow-dialog workflow-diagram-dialog">
        <header class="workflow-dialog-header">
          <div>
            <p class="section-kicker">Workflow Diagram</p>
            <h2>${escapeHtml(template.name)} v${template.version}</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-template-diagram" aria-label="閉じる" title="閉じる">${iconClose()}</button>
        </header>
        ${renderWorkflowDiagramBlock(diagram)}
      </section>
    </div>
  `;
}

function renderWorkflowImportPreview() {
  const workflowResult = parseJsonObjectText(state.workflowImportDraft.workflowJson, "API形式workflow JSON");
  if (!workflowResult.value) {
    return renderWorkflowDiagramNotice("invalid", workflowResult.error ?? "workflow JSONを入力してください。");
  }
  const roleMapResult = parseJsonObjectText(state.workflowImportDraft.roleMap, "role map", true);
  const diagram = createWorkflowMermaidDiagram(workflowResult.value, roleMapResult.value ?? {});
  const warning = roleMapResult.error ? `<div class="workflow-diagram-warning">${escapeHtml(roleMapResult.error)}</div>` : "";
  return `${warning}${renderWorkflowDiagramBlock(diagram)}`;
}

function renderWorkflowDiagramBlock(diagram: WorkflowDiagram) {
  if (diagram.status !== "ready") {
    return renderWorkflowDiagramNotice(diagram.status, diagram.message);
  }
  return `
    <div class="workflow-diagram-block">
      <div class="workflow-diagram-meta">
        <span>${diagram.nodeCount} nodes</span>
        <span>${diagram.edgeCount} edges</span>
      </div>
      <div class="workflow-diagram-canvas" data-mermaid-diagram>
        <pre class="workflow-diagram-source">${escapeHtml(diagram.source)}</pre>
        <div class="workflow-diagram-loading">diagramを描画中...</div>
      </div>
    </div>
  `;
}

function renderWorkflowDiagramNotice(status: WorkflowDiagramStatus, message: string) {
  return `
    <div class="workflow-diagram-notice ${status}">
      <strong>${status === "empty" ? "Empty workflow" : "Preview unavailable"}</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function renderWorkflowTypeOptions(selectedType: string) {
  const types = [
    ["txt2img", "txt2img"],
    ["img2img", "img2img"],
    ["ipadapter", "IP-Adapter"],
    ["controlnet", "ControlNet"],
    ["hybrid", "Hybrid"]
  ];
  return types
    .map(([value, label]) => `<option value="${value}" ${selectedType === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function renderProjectDetail(detail: ProjectDetail) {
  const activeRound = getActiveRound(detail);
  const assets = getActiveRoundAssets().filter(assetPassesFilter);
  const selectedAssets = getActiveRoundAssets().filter((asset) => asset.status === "selected");
  const activeAsset = state.activeAssetId ? findAsset(state.activeAssetId) : null;
  const mode = activeRound?.generationMode ?? "txt2img";
  const roundActive = isRoundActive(activeRound);

  return `
    <div class="studio-shell">
      <div class="sidebar-overlay ${state.sidebarOpen ? "active" : ""}" data-action="toggle-sidebar"></div>
      <aside class="studio-sidebar ${state.sidebarOpen ? "open" : ""}">
        ${renderGenerationPanel(detail, activeAsset)}
      </aside>
      <main class="studio-main">
        <div class="round-toolbar">
          <div>
            <h1>イテレーション ${activeRound ? `#${activeRound.roundIndex}` : ""}<span class="tag">${iconDot()}${escapeHtml(generationModeLabel(mode))}</span></h1>
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
            ${roundActive ? `<button class="button-danger compact" type="button" data-action="interrupt-round" data-id="${activeRound!.id}">${iconStop()}停止</button>` : ""}
            ${activeRound ? `<button class="button-secondary compact" type="button" data-action="collect-round" data-id="${activeRound.id}">${iconDownload()}生成結果取得</button>` : ""}
          </div>
        </div>
        <div class="gallery-scroll">
          <div class="image-grid cols-${state.gridCols}">
            ${assets.length ? assets.map(renderAssetTile).join("") : renderEmptyGallery(activeRound)}
          </div>
        </div>
        ${renderIterationTracker(detail)}
        ${renderBottomActionBar(selectedAssets, activeRound)}
      </main>
    </div>
  `;
}

function renderEmptyGallery(activeRound: Round | null) {
  if (!activeRound) {
    return renderSourceUploadEmptyState();
  }
  if (activeRound.status === "running" || activeRound.status === "pending") {
    return `<div class="empty wide">生成中です。画像ができた順にここへ表示されます。</div>`;
  }
  if (activeRound.status === "failed") {
    return `<div class="empty wide">このイテレーションは失敗しました。接続設定とworkflowを確認してブランチングしてください。</div>`;
  }
  if (activeRound.status === "interrupted") {
    return `<div class="empty wide">停止済みです。保存済みの画像があればここに表示されます。</div>`;
  }
  return `<div class="empty wide">取り込み済みの画像はありません。「生成結果取得」を押すと、完了済み画像だけをグリッド表示します。</div>`;
}

function renderSourceUploadEmptyState() {
  return `
    <div class="empty wide source-upload-empty">
      <div>
        <strong>画像をアップロードして親画像にする</strong>
        <p>初回生成前でも source asset を登録して、img2img のブランチングを開始できます。</p>
      </div>
      ${renderSourceUploadButton("画像を選択")}
    </div>
  `;
}

function renderSourceUploadButton(label: string) {
  return `
    <label class="button-secondary source-upload-button">
      ${iconPlus()}${escapeHtml(label)}
      <input data-source-upload="1" type="file" accept="image/png,image/jpeg,image/webp" />
    </label>
  `;
}

function renderAssetTile(asset: Asset) {
  const selected = asset.status === "selected";
  const favorite = asset.status === "favorite";
  const rejected = asset.status === "rejected";
  const masked = assetHasMaskIndicator(asset);
  return `
    <article class="image-card ${selected ? "selected" : ""} ${favorite ? "favorite" : ""} ${rejected ? "rejected" : ""} ${masked ? "masked" : ""}">
      <button class="asset-card-main" data-id="${asset.id}" type="button" aria-label="Asset #${asset.batchIndex + 1}">
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
      ${masked ? `<span class="mask-badge">${iconMask()}MASK</span>` : ""}
      <span class="seed-chip">seed ${asset.seed ?? "-"}</span>
    </article>
  `;
}

function assetHasMaskIndicator(asset: Asset) {
  return hasActiveMaskData(inpaintDraftForAsset(asset.id));
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
          <span class="selected-label">${selectedAssets.length}枚の画像を次のブランチングに使用</span>
        `}
      </div>
      <div class="bottom-actions">
        <button class="button-danger" type="button" data-action="reset-session">${iconTrash()}リセット</button>
        <button class="button-secondary" type="button" data-action="export-selected">${iconDownload()}保存</button>
        <button class="button-primary" type="button" data-action="generate-round">${iconPlay()}${activeRound ? "画像無しで生成" : "初回生成"}</button>
        <button class="button-primary" type="button" data-action="img2img-next" ${selectedAssets.length === 0 ? "disabled" : ""}>
          ${iconLoopArrows()}選択画像でブランチング <span class="button-count">${selectedAssets.length}</span>
        </button>
      </div>
    </div>
  `;
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

function defaultInpaintDraft(assetId: string): InpaintDraft {
  return {
    parentAssetId: assetId,
    maskDataUrl: "",
    enabled: false,
    maskedContent: "original",
    inpaintArea: "only_masked",
    onlyMaskedPadding: 32,
    brushSize: 48,
    eraser: false,
    selectedSmartMaskProvider: "manual",
    selectedWebSamModel: "slimsam-77",
    webSamModelStatus: "idle",
    webSamDownloadProgress: 0,
    webSamStatusText: "未取得",
    webSamError: "",
    webSamPromptMode: "point",
    foregroundPoints: [],
    boxPrompt: null,
    brushPromptMaskDataUrl: "",
    samCandidates: [],
    selectedSamCandidateIndex: 0,
    samMaskDataUrl: "",
    previewSamMaskDataUrl: "",
    manualIncludeMaskDataUrl: "",
    manualEraseMaskDataUrl: "",
    threshold: 0,
    smoothing: 0,
    maskOpacity: 0.58,
    zoomScale: 1,
    panOffset: { x: 0, y: 0 },
    imageWidth: null,
    imageHeight: null
  };
}

function normalizeInpaintDraft(draft: InpaintDraft): InpaintDraft {
  const defaults = defaultInpaintDraft(draft.parentAssetId);
  const normalized = {
    ...defaults,
    ...draft,
    panOffset: draft.panOffset ?? defaults.panOffset,
    foregroundPoints: draft.foregroundPoints ?? [],
    samCandidates: draft.samCandidates ?? []
  };
  if (
    !normalized.samMaskDataUrl &&
    !normalized.previewSamMaskDataUrl &&
    !normalized.manualIncludeMaskDataUrl &&
    !normalized.manualEraseMaskDataUrl &&
    !normalized.brushPromptMaskDataUrl &&
    normalized.maskDataUrl
  ) {
    normalized.manualIncludeMaskDataUrl = normalized.maskDataUrl;
  }
  return normalized;
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

function hasMaskData(draft: InpaintDraft | null | undefined) {
  return !!draft?.maskDataUrl && draft.maskDataUrl.startsWith("data:image/png;base64,");
}

function hasActiveMaskData(draft: InpaintDraft | null | undefined) {
  return draft?.enabled === true && hasMaskData(draft);
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

function handleMaskWheelZoom(event: WheelEvent) {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  if (!assetId) {
    return;
  }
  const draft = ensureInpaintDraft(assetId);
  const direction = event.deltaY < 0 ? 1 : -1;
  const nextScale = clampNumber(draft.zoomScale + direction * 0.12, 0.25, 4, 1);
  setInpaintDraft({
    ...draft,
    zoomScale: nextScale
  });
  render();
}

async function destroyWebSamWorkerSession() {
  if (!webSamWorker) {
    return;
  }
  const requestId = nextWebSamRequestId();
  postWebSamMessage({ type: "destroy", requestId });
}

function inpaintRequestForParent(parentAssetId: string | null, generationMode: string): InpaintOptions | null {
  if (generationMode !== "img2img" || !parentAssetId) {
    return null;
  }
  const draft = inpaintDraftForAsset(parentAssetId);
  if (!hasActiveMaskData(draft)) {
    return null;
  }
  return {
    maskDataUrl: draft.maskDataUrl,
    maskedContent: draft.maskedContent,
    inpaintArea: draft.inpaintArea,
    onlyMaskedPadding: draft.onlyMaskedPadding
  };
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
  }
  state.maskToolbarPos = null;
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
  activeMaskStroke = null;
  activeBoxPrompt = null;
  if (state.activeAssetId) {
    maskLayerCache.delete(state.activeAssetId);
  }
  setInpaintDraft(null);
  render();
}

function isMaskedContent(value: string): value is MaskedContent {
  return maskedContentOptions.some((option) => option.value === value);
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

function renderGenerationPanel(detail: ProjectDetail, activeAsset: Asset | null) {
  const activeRound = getActiveRound(detail);
  const request = activeRound?.request;
  const requestMode = request?.generationMode === "manual_upload" ? "img2img" : request?.generationMode;
  const draft = state.generationDraft;
  const draftParent = findAsset(draft?.parentAssetId ?? "");
  const previous = activeAsset ?? draftParent ?? getPreferredParentAsset();
  const selectedTemplateId = draft?.templateId ?? request?.templateId ?? detail.project.defaultTemplateId ?? detail.templates[0]?.id ?? "";
  const selectedImg2ImgTemplateId =
    draft?.img2imgTemplateId ??
    (request?.generationMode === "img2img" ? request.templateId : selectedTemplateId);
  const selectedTemplate = detail.templates.find((template) => template.id === selectedTemplateId) ?? null;
  const selectedMode = draft?.generationMode ?? requestMode ?? defaultModeForTemplate(selectedTemplate);
  const selectedImg2ImgTemplate =
    detail.templates.find((template) => template.id === selectedImg2ImgTemplateId) ??
    selectedTemplate;
  const activeTemplateForMode = selectedMode === "img2img" ? selectedImg2ImgTemplate : selectedTemplate;
  const defaults = templateGenerationDefaults(activeTemplateForMode);
  const promptValue = draft?.prompt ?? request?.prompt ?? previous?.prompt ?? defaults.prompt ?? defaultPrompt;
  const negativePromptValue = draft?.negativePrompt ?? request?.negativePrompt ?? previous?.negativePrompt ?? defaults.negativePrompt ?? defaultNegativePrompt;
  const batchSizeValue = draftNumber(draft, "batchSize") ?? request?.batchSize ?? defaults.batchSize ?? 16;
  const stepsValue = draftNumber(draft, "steps") ?? request?.steps ?? defaults.steps ?? 20;
  const cfgValue = draftNumber(draft, "cfg") ?? request?.cfg ?? defaults.cfg ?? 7;
  const denoiseValue =
    draftNumber(draft, "denoise") ??
    request?.denoise ??
    normalizeDenoiseForMode(defaults.denoise ?? defaultDenoiseForMode(selectedMode), selectedMode);
  const normalizedDenoiseValue = normalizeDenoiseForMode(denoiseValue, selectedMode);
  const widthValue = draftNumber(draft, "width") ?? assetDimension(previous, "width") ?? request?.width ?? defaults.width ?? 512;
  const heightValue = draftNumber(draft, "height") ?? assetDimension(previous, "height") ?? request?.height ?? defaults.height ?? 768;
  const seedValue = draft?.seed ?? String(request?.seed ?? previous?.seed ?? defaults.seed ?? -1);
  const seedModeValue = draft?.seedMode ?? request?.seedMode ?? "random";
  const samplerValue = draft?.sampler ?? request?.sampler ?? defaults.sampler ?? "euler";
  const schedulerValue = draft?.scheduler ?? request?.scheduler ?? defaults.scheduler ?? "normal";
  const activeInpaint = previous?.id ? inpaintDraftForAsset(previous.id) : null;
  const templateOptions = detail.templates.length
    ? detail.templates
      .map((template) => renderTemplateOption(template, selectedTemplateId))
      .join("")
    : `<option value="">未登録</option>`;
  const img2imgTemplateOptions = detail.templates.length
    ? detail.templates
      .map((template) => renderTemplateOption(template, selectedImg2ImgTemplateId))
      .join("")
    : `<option value="">未登録</option>`;

  return `
    <form id="generation-form" class="sidebar-form">
      <input type="hidden" name="parentAssetId" value="${previous?.id ?? ""}" />
      <section class="sidebar-section">
        <p class="section-kicker">ワークフロー</p>
        <label>txt2img WorkflowTemplate
          <select id="generation-template-select" class="workflow-select" name="templateId">${templateOptions}</select>
        </label>
        <label>img2img WorkflowTemplate
          <select id="generation-img2img-template-select" class="workflow-select" name="img2imgTemplateId">${img2imgTemplateOptions}</select>
        </label>
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
        <p class="section-kicker">親画像</p>
        ${renderSourceUploadButton("source asset をアップロード")}
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
        <div class="section-header-row">
          <p class="section-kicker">生成パラメータ</p>
          <button class="button-secondary compact mini-button" type="button" data-action="reset-generation-params">${iconReset()}JSON初期値</button>
        </div>
        ${renderRangeControl("batchSize", "バッチサイズ", batchSizeValue, 1, 32, 1, "batchValue")}
        ${renderRangeControl("steps", "ステップ数", stepsValue, 1, 50, 1, "stepsValue")}
        ${renderRangeControl("cfg", "CFGスケール", cfgValue, 1, 20, 0.5, "cfgValue")}
        ${renderRangeControl("denoise", "デノイズ強度", normalizedDenoiseValue, 0, 1, 0.05, "denoiseValue")}

        <div class="resolution-row">
          <label>幅<input class="input-field center" name="width" type="number" step="64" value="${widthValue}" /></label>
          <button class="icon-button swap-button" data-action="swap-resolution" type="button" aria-label="幅と高さを入れ替え">${iconSwap()}</button>
          <label>高さ<input class="input-field center" name="height" type="number" step="64" value="${heightValue}" /></label>
        </div>
        <div class="resolution-scale-row">
          <button class="icon-button resolution-scale-button" data-action="scale-resolution" data-scale-direction="down" type="button" aria-label="縦横比を保って縮小" title="縦横比を保って縮小">${iconMinimize()}</button>
          <button class="icon-button resolution-scale-button" data-action="scale-resolution" data-scale-direction="up" type="button" aria-label="縦横比を保って拡大" title="縦横比を保って拡大">${iconPlus()}</button>
        </div>

        <label>シード
          <div class="seed-row">
            <input class="input-field mono" name="seed" type="number" value="${seedValue}" />
            <button class="icon-button" data-action="random-seed" type="button" aria-label="ランダムseed">${iconShuffle()}</button>
          </div>
        </label>

        <label>seed mode
          <select class="workflow-select" name="seedMode">
            ${["random", "fixed", "increment", "reuse_parent_seed"].map((mode) => `<option value="${mode}" ${seedModeValue === mode ? "selected" : ""}>${mode}</option>`).join("")}
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

      ${hasActiveMaskData(activeInpaint) ? renderInpaintSidebarSection(activeInpaint) : ""}

      <details class="sidebar-section collapsible">
        <summary><span class="section-kicker">モデル</span>${iconChevron()}</summary>
        ${renderModelReadout(defaults.model)}
      </details>
    </form>
  `;
}

function renderInpaintSidebarSection(inpaint: InpaintDraft) {
  return `
    <section class="sidebar-section mask-sidebar-section">
      <div class="section-header-row">
        <p class="section-kicker">マスク処理</p>
        <span class="mask-status">有効</span>
      </div>
      <label>Masked content
        <select class="workflow-select" data-inpaint-field="maskedContent">
          ${maskedContentOptions.map((option) => `
            <option value="${option.value}" ${inpaint.maskedContent === option.value ? "selected" : ""}>${escapeHtml(option.label)}</option>
          `).join("")}
        </select>
      </label>
      <label>Inpaint area
        <select class="workflow-select" data-inpaint-field="inpaintArea">
          <option value="only_masked" selected>Only masked</option>
        </select>
      </label>
      <div class="range-control">
        <div class="range-label"><span>Only masked padding</span><strong id="sidebarMaskPaddingValue">${formatNumber(inpaint.onlyMaskedPadding)}px</strong></div>
        <input type="range" min="0" max="512" step="1" value="${inpaint.onlyMaskedPadding}" data-value-target="sidebarMaskPaddingValue" data-inpaint-field="onlyMaskedPadding" />
        <div class="range-minmax"><span>0px</span><span>512px</span></div>
      </div>
      <button class="button-danger compact" type="button" data-action="clear-inpaint">${iconTrash()}マスクを解除</button>
    </section>
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

function renderTemplateOption(template: WorkflowTemplate, selectedTemplateId: string) {
  const selected = selectedTemplateId === template.id ? "selected" : "";
  return `<option value="${escapeAttr(template.id)}" ${selected}>${escapeHtml(template.name)} v${template.version} (${escapeHtml(template.type)})</option>`;
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

  const current = Number(control.value);
  const value = requiresFullDenoise(mode)
    ? 1
    : !Number.isFinite(current) || current >= 1
      ? defaultDenoiseForMode(mode)
      : current;
  setFormValue(form, "denoise", String(value));
}

function defaultModeForTemplate(template: WorkflowTemplate | null) {
  if (template && ["txt2img", "img2img", "ipadapter", "controlnet"].includes(template.type)) {
    return template.type;
  }
  return "txt2img";
}

function generationModeLabel(mode: string) {
  return mode === "manual_upload" ? "source" : mode;
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

function requiresParentAsset(mode: string) {
  return mode === "img2img" || mode === "ipadapter" || mode === "controlnet";
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
    batchSize:
      numberFromPath(workflow, roleMap.batch_size_input ?? roleMap.repeat_latent_batch_amount_input) ??
      numberFromNodeInput(workflow, roleMap.empty_latent_node, ["batch_size"]) ??
      numberFromNodeInput(workflow, roleMap.repeat_latent_batch_node, ["amount"]),
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
  const inpaint = inpaintDraftForAsset(asset.id);
  const editing = state.maskEditMode;
  const draft = inpaint ?? defaultInpaintDraft(asset.id);
  const zoomStyle = ` style="--mask-zoom: ${formatCssNumber(draft.zoomScale)}; --mask-pan-x: ${formatCssNumber(draft.panOffset.x)}px; --mask-pan-y: ${formatCssNumber(draft.panOffset.y)}px;"`;
  const promptValue = currentPositivePromptValue(asset);
  const info = `Seed: ${asset.seed ?? "-"} / Steps: ${asset.steps ?? "-"} / CFG: ${asset.cfg ?? "-"} / Sampler: ${asset.sampler}`;
  const media = renderPreviewMedia(asset, draft, editing, zoomStyle);
  const footer = renderPreviewFooter(asset, info);
  return `
    <div class="preview-modal ${editing ? "mask-editor-open" : ""}" role="dialog" aria-modal="true">
      <div class="preview-content ${editing ? "mask-mode" : ""}">
        <div class="preview-top-controls">
          ${renderMaskToggleButton(editing)}
          ${editing ? renderMaskModeIndicator(inpaint) : ""}
        </div>
        ${editing ? `
          <div class="mask-editor-layout">
            ${renderMaskPromptSidebar(draft, promptValue)}
            <main class="preview-center">
              ${media}
              ${footer}
            </main>
            ${renderSmartMaskSidebar(draft)}
          </div>
        ` : `
          ${media}
          ${footer}
        `}
        <button class="preview-close" type="button" data-action="close-detail" aria-label="閉じる">${iconClose()}</button>
      </div>
    </div>
  `;
}

function renderPreviewMedia(asset: Asset, draft: InpaintDraft, editing: boolean, zoomStyle: string) {
  return `
    <div class="preview-media${editing ? " mask-preview-media" : ""}"${zoomStyle}>
      <div class="mask-zoom-stage">
        <img id="previewImage" src="${asset.imageUrl}" alt="" draggable="false" />
        ${editing ? `<canvas id="maskCanvas" class="mask-canvas" data-asset-id="${asset.id}" aria-label="マスクキャンバス"></canvas>${renderWebSamPromptOverlay(draft, asset)}` : ""}
      </div>
    </div>
  `;
}

function renderPreviewFooter(asset: Asset, info: string) {
  return `
    <div class="preview-footer">
      <div class="preview-info">
        <p>${escapeHtml(info)}</p>
        <small>${escapeHtml(asset.prompt)}</small>
      </div>
      <div class="preview-actions">
        <button class="button-secondary" type="button" data-action="toggle-select" data-id="${asset.id}">選択切替</button>
        <button class="button-primary" type="button" data-action="generate-from-preview" data-id="${asset.id}" data-mode="img2img">この画像からブランチング</button>
      </div>
    </div>
  `;
}

function renderMaskToggleButton(editing: boolean) {
  return `
    <button class="preview-mask-toggle ${editing ? "active" : ""}" type="button" data-action="toggle-mask-editor" aria-pressed="${editing}" title="${editing ? "マスク編集を終了" : "マスク編集を開始"}">
      ${iconMask()}<span>マスク編集 ${editing ? "ON" : "OFF"}</span>
    </button>
  `;
}

function renderMaskModeIndicator(inpaint: InpaintDraft | null) {
  const draft = inpaint ?? (state.activeAssetId ? defaultInpaintDraft(state.activeAssetId) : null);
  const toolLabel = draft?.eraser ? "消しゴム" : "ブラシ";
  const sizeLabel = draft ? `${formatNumber(draft.brushSize)}px` : "-";
  return `
    <div class="mask-mode-indicator" aria-live="polite">
      <span>${iconMask()}マスク編集モード</span>
      <small>${escapeHtml(toolLabel)} / ${escapeHtml(sizeLabel)}</small>
    </div>
  `;
}

function renderWebSamPromptOverlay(draft: InpaintDraft, asset: Asset) {
  const width = draft.imageWidth ?? assetDimension(asset, "width") ?? 1;
  const height = draft.imageHeight ?? assetDimension(asset, "height") ?? 1;
  const points = draft.foregroundPoints.map((point) => {
    const className = point.label === 0 ? "background" : point.source === "brush" ? "brush" : "foreground";
    return `<circle class="websam-point ${className}" cx="${formatCssNumber(point.x)}" cy="${formatCssNumber(point.y)}" r="${Math.max(5, Math.min(width, height) * 0.007)}"></circle>`;
  }).join("");
  const box = normalizePromptBox(draft.boxPrompt);
  const boxMarkup = box
    ? `<rect class="websam-box" x="${formatCssNumber(box.x1)}" y="${formatCssNumber(box.y1)}" width="${formatCssNumber(box.x2 - box.x1)}" height="${formatCssNumber(box.y2 - box.y1)}"></rect>`
    : "";
  return `
    <svg class="websam-prompt-overlay" viewBox="0 0 ${formatCssNumber(width)} ${formatCssNumber(height)}" aria-hidden="true">
      ${boxMarkup}
      ${points}
      <circle class="brush-cursor" cx="0" cy="0" r="0" data-brush-asset-id="${asset.id}"></circle>
    </svg>
  `;
}

function renderSmartMaskSection(draft: InpaintDraft) {
  const isWebSam = draft.selectedSmartMaskProvider !== "manual";
  return `
    <div class="smart-mask-section">
      <label>Smart selection
        <select class="workflow-select" data-smart-mask-field="provider">
          ${SMART_MASK_PROVIDERS.map((provider) => `
            <option value="${provider.id}" ${draft.selectedSmartMaskProvider === provider.id ? "selected" : ""}>${escapeHtml(provider.label)}</option>
          `).join("")}
        </select>
      </label>
      ${isWebSam ? renderWebSamControls(draft) : ""}
    </div>
  `;
}

function renderWebSamControls(draft: InpaintDraft) {
  const model = modelForProvider(draft.selectedSmartMaskProvider);
  const statusClass = draft.webSamModelStatus === "ready"
    ? "active"
    : draft.webSamModelStatus === "error" || draft.webSamModelStatus === "missing-url"
      ? "error"
      : "";
  const canDecode = draft.webSamModelStatus === "ready" && hasWebSamPrompt(draft);
  return `
    <div class="websam-panel">
      <div class="websam-model-card">
        <div>
          <strong>${escapeHtml(model?.label ?? draft.selectedWebSamModel)}</strong>
          <small>${escapeHtml(model ? `${model.description} / Encoder ${formatModelBytes(model.encoderSize)} / Decoder ${formatModelBytes(model.decoderSize)}` : "")}</small>
        </div>
        <span class="mask-status ${statusClass}">${escapeHtml(webSamStatusLabel(draft.webSamModelStatus))}</span>
      </div>
      <div class="websam-progress"><span style="width: ${formatCssNumber(clampNumber(draft.webSamDownloadProgress, 0, 1, 0) * 100)}%"></span></div>
      <div class="websam-status-line">
        <span>${escapeHtml(draft.webSamStatusText || webSamStatusLabel(draft.webSamModelStatus))}</span>
        <button class="button-secondary compact mini-button" type="button" data-action="${draft.webSamModelStatus === "error" || draft.webSamModelStatus === "missing-url" ? "websam-retry" : "websam-load-model"}">${iconLoopArrows()}再試行</button>
      </div>
      ${draft.webSamError ? `<p class="websam-error">${escapeHtml(draft.webSamError)}</p>` : ""}
      <label>Prompt mode
        <select class="workflow-select" data-smart-mask-field="promptMode">
          <option value="point" ${draft.webSamPromptMode === "point" ? "selected" : ""}>Point</option>
          <option value="box" ${draft.webSamPromptMode === "box" ? "selected" : ""}>Box</option>
          <option value="brush" ${draft.webSamPromptMode === "brush" ? "selected" : ""}>Brush prompt</option>
        </select>
      </label>
      ${renderSmartMaskRange("threshold", "Threshold", draft.threshold, -10, 10, 0.1, "webSamThresholdValue")}
      ${renderSmartMaskRange("smoothing", "Smoothing", draft.smoothing, 0, 4, 1, "webSamSmoothingValue")}
      ${renderSmartMaskRange("maskOpacity", "Mask opacity", draft.maskOpacity, 0, 1, 0.05, "webSamOpacityValue")}
      <div class="websam-actions">
        <button class="button-secondary compact" type="button" data-action="websam-decode" ${canDecode ? "" : "disabled"}>${iconPlay()}候補生成</button>
        <button class="button-secondary compact" type="button" data-action="websam-clear-prompts">${iconReset()}点クリア</button>
        <button class="button-secondary compact" type="button" data-action="websam-clear-result">${iconTrash()}SAM結果クリア</button>
      </div>
      ${renderSamCandidateButtons(draft)}
      <div class="websam-counts">
        <span>FG/BG ${draft.foregroundPoints.filter((point) => point.label === 1).length}/${draft.foregroundPoints.filter((point) => point.label === 0).length}</span>
        <span>Brush ${draft.foregroundPoints.filter((point) => point.source === "brush").length}</span>
        <span>Zoom ${Math.round(draft.zoomScale * 100)}%</span>
      </div>
    </div>
  `;
}

function renderSmartMaskRange(field: string, label: string, value: number, min: number, max: number, step: number, valueId: string) {
  return `
    <div class="range-control smart-mask-range">
      <div class="range-label"><span>${escapeHtml(label)}</span><strong id="${valueId}">${formatNumber(value)}</strong></div>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${formatCssNumber(value)}" data-value-target="${valueId}" data-smart-mask-field="${field}" />
    </div>
  `;
}

function renderSamCandidateButtons(draft: InpaintDraft) {
  if (draft.samCandidates.length === 0) {
    return `<div class="websam-candidates empty-candidates"><span>Mask 1</span><span>Mask 2</span><span>Mask 3</span></div>`;
  }
  return `
    <div class="websam-candidates">
      ${draft.samCandidates.map((candidate) => `
        <button class="websam-candidate ${candidate.index === draft.selectedSamCandidateIndex ? "active" : ""}" type="button" data-action="websam-candidate" data-index="${candidate.index}">
          <span>Mask ${candidate.index + 1}</span>
          <small>${candidate.score === null ? "-" : `${(candidate.score * 100).toFixed(1)}%`}</small>
        </button>
      `).join("")}
    </div>
  `;
}

function webSamStatusLabel(status: WebSamModelStatus) {
  if (status === "idle") return "未取得";
  if (status === "missing-url") return "URL未設定";
  if (status === "not-cached") return "未取得";
  if (status === "downloading") return "ダウンロード中";
  if (status === "cached") return "キャッシュ済み";
  if (status === "initializing") return "初期化中";
  if (status === "encoding") return "Encoding";
  if (status === "ready") return "Ready";
  if (status === "decoding") return "Decoding";
  return "Error";
}

function currentPositivePromptValue(asset: Asset) {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return state.generationDraft?.prompt ?? activeRound?.request?.prompt ?? asset.prompt ?? defaultPrompt;
}

function currentBatchSizeValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return draftNumber(state.generationDraft, "batchSize") ?? activeRound?.request?.batchSize ?? 16;
}

function renderMaskPromptSidebar(draft: InpaintDraft, promptValue: string) {
  const batchSizeValue = currentBatchSizeValue();
  const active = hasActiveMaskData(draft);
  const canApplyCandidate = draft.samCandidates.length > 0 && !!draft.previewSamMaskDataUrl;
  const webSamProvider = SMART_MASK_PROVIDERS.find((provider) => provider.id !== "manual")?.id ?? "websam-slimsam-77";
  const smartActive = draft.selectedSmartMaskProvider !== "manual";
  return `
    <aside class="mask-editor-panel mask-prompt-panel">
      <div class="mask-panel-header">
        <h2>マスク・プロンプト</h2>
        <span class="mask-status ${active ? "active" : ""}">${active ? "mask active" : "no mask"}</span>
      </div>
      <div class="mask-panel-tabs">
        <button class="mask-tab ${smartActive ? "" : "active"}" type="button" data-action="set-smart-mask-provider" data-provider="manual">手動編集</button>
        <button class="mask-tab ${smartActive ? "active" : ""}" type="button" data-action="set-smart-mask-provider" data-provider="${webSamProvider}">${iconPlay()}候補生成</button>
        <button class="mask-tab" type="button" data-action="websam-clear-prompts">${iconReset()}点クリア</button>
      </div>
      <div class="mask-toolbar-row">
        <button class="mask-tool-button ${!smartActive && !draft.eraser ? "active" : ""}" type="button" data-action="mask-tool" data-tool="brush" aria-label="ブラシ" title="ブラシ">${iconBrush()}</button>
        <button class="mask-tool-button ${draft.eraser ? "active" : ""}" type="button" data-action="mask-tool" data-tool="eraser" aria-label="消しゴム" title="消しゴム">${iconEraser()}</button>
        <button class="mask-tool-button" type="button" data-action="clear-mask" aria-label="マスクをクリア" title="マスクをクリア">${iconReset()}</button>
      </div>
      <div class="range-control mask-brush-control">
        <div class="range-label"><span>ブラシサイズ</span><strong id="maskBrushValue">${formatNumber(draft.brushSize)}px</strong></div>
        <input type="range" min="1" max="256" step="1" value="${draft.brushSize}" data-value-target="maskBrushValue" data-inpaint-field="brushSize" />
      </div>
      <div class="mask-options-grid">
        <label class="mask-prompt-field">Positive prompt
          <textarea class="input-field mask-prompt-input" rows="4" data-generation-field="prompt" placeholder="プロンプトを入力...">${escapeHtml(promptValue)}</textarea>
        </label>
        <div class="range-control mask-batch-control">
          <div class="range-label"><span>バッチサイズ</span><strong id="modalBatchValue">${formatNumber(batchSizeValue)}</strong></div>
          <input type="range" min="1" max="32" step="1" value="${batchSizeValue}" data-value-target="modalBatchValue" data-generation-field="batchSize" />
          <div class="range-minmax"><span>1</span><span>32</span></div>
        </div>
        <label>Masked content
          <select class="workflow-select" data-inpaint-field="maskedContent">
            ${maskedContentOptions.map((option) => `
              <option value="${option.value}" ${draft.maskedContent === option.value ? "selected" : ""}>${escapeHtml(option.label)}</option>
            `).join("")}
          </select>
        </label>
        <label>Inpaint area
          <select class="workflow-select" data-inpaint-field="inpaintArea">
            <option value="only_masked" selected>Only masked</option>
          </select>
        </label>
        <div class="range-control mask-padding-control">
          <div class="range-label"><span>Only masked padding</span><strong id="modalMaskPaddingValue">${formatNumber(draft.onlyMaskedPadding)}px</strong></div>
          <input type="range" min="0" max="512" step="1" value="${draft.onlyMaskedPadding}" data-value-target="modalMaskPaddingValue" data-inpaint-field="onlyMaskedPadding" />
        </div>
      </div>
      <div class="mask-panel-actions">
        <button class="button-primary" type="button" data-action="apply-mask-editor">${iconCheck()}${canApplyCandidate ? "候補を適用" : "適用"}</button>
        <button class="button-secondary" type="button" data-action="websam-clear-manual">${iconEraser()}手動修正クリア</button>
      </div>
    </aside>
  `;
}

function renderSmartMaskSidebar(draft: InpaintDraft) {
  return `
    <aside class="mask-editor-panel smart-mask-panel">
      <div class="mask-panel-header">
        <h2>スマート選択</h2>
      </div>
      ${renderSmartMaskSection(draft)}
    </aside>
  `;
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
  preview.innerHTML = renderWorkflowImportPreview();
  void renderWorkflowDiagramCanvases();
}

function formValue(form: HTMLFormElement, name: string) {
  const control = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return control?.value ?? "";
}

function parseJsonObjectText(text: string, label: string, allowEmpty = false): { value: Json | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed && allowEmpty) {
    return { value: {}, error: null };
  }
  if (!trimmed) {
    return { value: null, error: `${label}を入力してください。` };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!isJsonObject(parsed)) {
      return { value: null, error: `${label}のルートはJSON objectである必要があります。` };
    }
    return { value: parsed, error: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { value: null, error: `${label}をJSONとして読めません: ${detail}` };
  }
}

function isJsonObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickJsonObject(source: Json, key: string) {
  const value = source[key];
  return isJsonObject(value) ? value : null;
}

function resolveTemplateForGeneration(templateId: string, mode: string) {
  const current = state.templates.find((template) => template.id === templateId) ?? null;
  if (!current) {
    throw new Error(`${mode}用WorkflowTemplateが選択されていません。`);
  }
  return current;
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

function formatCssNumber(value: number) {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0";
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
