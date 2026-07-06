import type { ComfySettings, LlmSettings } from "../shared/types";
import type { ModelCheckResult, ProjectDetail, ProjectSummary } from "../shared/apiTypes";
import type { ConnectionState } from "./views/homeView";
import type { MaskPanelTab } from "./views/assetModal";
import type { WorkflowTemplate } from "./workflowTypes";
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

export type MessageAction = {
  label: string;
  action: string;
  id?: string;
};

export type ToastType = "info" | "error";

export type Toast = {
  id: string;
  text: string;
  type: ToastType;
  action?: MessageAction;
};

const TOAST_AUTO_CLEAR_MS = 15_000;
const MAX_TOASTS = 5;
let toastIdCounter = 0;
let toastsValue: Toast[] = [];
const toastTimers = new Map<string, number>();

function clearToastTimer(id: string) {
  const timer = toastTimers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    toastTimers.delete(id);
  }
}

function scheduleToastAutoClear(id: string) {
  clearToastTimer(id);
  const timer = window.setTimeout(() => {
    toastTimers.delete(id);
    dismissToast(id);
  }, TOAST_AUTO_CLEAR_MS);
  toastTimers.set(id, timer);
}

/**
 * 「見つからない場合の通知」を優先して間引く(action 付きトーストは undo/redo の
 * 対象なので残す)。全件 action 付きの場合のみ先頭(最古)を間引く。
 */
function evictExcessToasts() {
  if (toastsValue.length <= MAX_TOASTS) {
    return;
  }
  const evictIndex = toastsValue.findIndex((toast) => !toast.action);
  const [removed] = toastsValue.splice(evictIndex >= 0 ? evictIndex : 0, 1);
  clearToastTimer(removed.id);
}

/**
 * トーストを追加する。`type: "info"` は従来どおり 15 秒後に自動で消える。
 * `type: "error"` は自動で消えず、手動 dismiss(`dismissToast`)のみで消える。
 * 同一 text + type のトーストが既にあれば新規追加せず、そのタイマーだけ延長する
 * (auto-collect のポーリングエラー等が連投されてもスタックが埋まらないように)。
 */
export function pushToast(text: string, type: ToastType = "info", action?: MessageAction): string {
  const existing = toastsValue.find((toast) => toast.text === text && toast.type === type);
  if (existing) {
    existing.action = action;
    if (existing.type === "info") {
      scheduleToastAutoClear(existing.id);
    }
    requestRender();
    return existing.id;
  }

  const id = `toast-${++toastIdCounter}`;
  toastsValue = [...toastsValue, { id, text, type, action }];
  if (type === "info") {
    scheduleToastAutoClear(id);
  }
  evictExcessToasts();
  requestRender();
  return id;
}

export function dismissToast(id: string) {
  clearToastTimer(id);
  const next = toastsValue.filter((toast) => toast.id !== id);
  if (next.length === toastsValue.length) {
    return;
  }
  toastsValue = next;
  requestRender();
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
  /** @deprecated `info` トーストを追加する後方互換のシュガー。エラーや action 付きは `pushToast` を使う。 */
  message: string;
  toasts: Toast[];
  generationDraft: GenerationDraft | null;
  /**
   * Round ごとの編集内容(プロンプト等)の記憶。Round を切り替えても、その Round で
   * 最後に編集していたフォーム内容へ戻れる(ブランチングで親ノードの編集が消えない)。
   */
  generationDraftsByRound: Record<string, GenerationDraft>;
  inpaintDrafts: Record<string, InpaintDraft>;
  /** 次回 render 後に iteration tracker のスクロールを先頭へ戻す(プロジェクト切替時など)。 */
  iterationScrollReset: boolean;
  maskEditMode: boolean;
  maskToolbarMinimized: boolean;
  maskToolbarPos: { left: number; top: number } | null;
  maskPanelWidths: { left: number; right: number };
  copiedSeedAssetId: string | null;
  deletePreviewRoundId: string | null;
  activeWorkflowDiagramTemplateId: string | null;
  paintEditMode: boolean;
  paintDrafts: Record<string, PaintDraft>;
  maskPanelTab: MaskPanelTab;
  poseDrafts: Record<string, PoseDraft>;
  /** UX改善#5: ComfyUI の現在のサンプラー step。生成中の roundId のみキーを持つ。 */
  roundProgress: Record<string, { value: number; max: number }>;
  /** UX改善#6: `?` キーで開閉するショートカット一覧オーバーレイの表示状態。 */
  showShortcutsHelp: boolean;
  /** 「必要モデルインストール」モーダルで表示中のモデルファミリ。null=モーダル閉。 */
  modelInstallFamily: "chroma" | null;
  /** `GET /api/comfy/model-check` の結果と取得状態。 */
  modelCheck: {
    status: "idle" | "loading" | "ready" | "error";
    result: ModelCheckResult | null;
  };
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
  set message(value: string) {
    if (value) {
      pushToast(value, "info");
    }
  },
  get message() {
    return "";
  },
  get toasts() {
    return toastsValue;
  },
  generationDraft: null,
  generationDraftsByRound: {},
  inpaintDrafts: {},
  iterationScrollReset: false,
  maskEditMode: false,
  maskToolbarMinimized: false,
  maskToolbarPos: null,
  maskPanelWidths: { left: 300, right: 300 },
  copiedSeedAssetId: null,
  deletePreviewRoundId: null,
  activeWorkflowDiagramTemplateId: null,
  paintEditMode: false,
  paintDrafts: {},
  maskPanelTab: "mask",
  poseDrafts: {},
  roundProgress: {},
  showShortcutsHelp: false,
  modelInstallFamily: null,
  modelCheck: { status: "idle", result: null }
};
