import type { ComfySettings, LlmSettings } from "../shared/types";
import type { ProjectDetail, ProjectSummary } from "../shared/apiTypes";
import type { ConnectionState } from "./views/homeView";
import type { MaskPanelTab } from "./views/assetModal";
import type { WorkflowImportDraft, WorkflowTemplate } from "./workflowTypes";
import { defaultWorkflowImportDraft } from "./workflowImport";
import type { InpaintDraft } from "./maskTypes";
import type { PaintDraft } from "./paintTypes";
import type { PoseDraft } from "./poseTypes";

export const generationDraftFields = [
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
export type GenerationDraftField = typeof generationDraftFields[number];
export type GenerationDraft = Partial<Record<GenerationDraftField, string>> & {
  inpaint?: InpaintDraft | null;
};

export type RenderOptions = Record<never, never>;

/**
 * 再描画コールバック。main.ts(composition root)が boot 時に `render` を登録し、
 * 各 controller は `requestRender()` 経由で再描画を要求する(main.ts への循環 import を断つ)。
 */
let renderCallback: (options?: RenderOptions) => void = () => {};

export function setRenderCallback(callback: (options?: RenderOptions) => void) {
  renderCallback = callback;
}

export function requestRender(options?: RenderOptions) {
  renderCallback(options);
}

const messageAutoClearMs = 15_000;
let messageValue = "";
let messageClearTimer: number | null = null;

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
      requestRender();
    }
  }, messageAutoClearMs);
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "guruguru:sidebarCollapsed";

function loadSidebarCollapsedPreference() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function toggleSidebarCollapsed() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, state.sidebarCollapsed ? "1" : "0");
  } catch {
    // localStorage が使えない環境では次回起動時に既定値へ戻る。
  }
}

export interface AppState {
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
  sidebarCollapsed: boolean;
  comfyConnection: ConnectionState;
  comfyStatusText: string;
  llmSettings: LlmSettings | null;
  llmConnection: ConnectionState;
  llmStatusText: string;
  llmImproving: boolean;
  busy: boolean;
  message: string;
  generationDraft: GenerationDraft | null;
  inpaintDrafts: Record<string, InpaintDraft>;
  /** 次回 render 後に iteration tracker のスクロールを先頭へ戻す(プロジェクト切替時など)。 */
  iterationScrollReset: boolean;
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
}

export const state: AppState = {
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
  sidebarCollapsed: loadSidebarCollapsedPreference(),
  comfyConnection: "unknown",
  comfyStatusText: "未確認",
  llmSettings: null,
  llmConnection: "unknown",
  llmStatusText: "未確認",
  llmImproving: false,
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
  iterationScrollReset: false,
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
