import type { ComfySettings, LlmSettings } from "../shared/types";
import type {
  BookPages,
  LayoutTemplateSummary,
  ModelCheckResult,
  PagePanelAssignment,
  ProjectDetail,
  ProjectSummary,
  RecentReferenceImage
} from "../shared/apiTypes";
import type { PanelCrop } from "../shared/pageLayout";
import type { ConnectionState } from "./views/homeView";
import type { MaskPanelTab } from "./views/assetModal";
import type { WorkflowTemplate } from "./workflowTypes";
import type { InpaintDraft } from "./maskTypes";
import type { PaintDraft } from "./paintTypes";
import type { PoseDraft } from "./poseTypes";
import type { StyleLoraSelection } from "../shared/types";
import type { BookReaderSettings } from "./bookReader";
import { DEFAULT_BOOK_READER_SETTINGS } from "./bookReader";

/**
 * Consistent Character(Docs/Feature-ConsistentCharacter.md)の参照画像。フォームレベルの
 * ドラフト(per-asset ではない -- 親画像取り込みの直下に置く共有の1枚)。顔スタイル参照
 * (PuLID)の参照元。画像を取り込めば(PuLID 導入時に)顔参照が適用される -- 明示トグルは持たない。
 */
export interface ReferenceDraft {
  imageDataUrl: string | null;
}

/**
 * コマ内生成(Docs/Feature-PanelGeneration.md)。ページの lightbox で開いているコマ選択/クロップ編集の状態。
 * null = lightbox 閉。シングルクリックは `selectedPanelId` だけを更新し(通常の選択モード)、
 * `cropPanelId` が非 null の間だけドラッグでのクロップ編集を許す(誤操作防止のため常時ドラッグ有効にはしない)。
 */
export interface PagePanelLightboxState {
  pageId: string;
  selectedPanelId: string | null;
  /** クロップ編集モードの対象コマ id。null なら通常の選択モード。 */
  cropPanelId: string | null;
  /** クロップ編集中のドラッグ作業用コピー(pointerup で確定 PATCH、閉じると破棄)。 */
  cropDraft: PanelCrop | null;
}

/** コマ内生成: 「選択コマを生成」等で生成フォームが対象にしているコマ(次の生成 round が targetPanelId を持つ)。 */
export interface PanelGenerationTarget {
  pageId: string;
  panelId: string;
}

export interface ConfirmDialogState {
  id: string;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: "default" | "danger";
}

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

const SIDEBAR_WIDTH_STORAGE_KEY = "guruguru:sidebarWidth";
/** 生成サイドバーのドラッグ変更幅の範囲と既定値(既定はスタイル LoRA 欄が見切れない幅)。 */
export const SIDEBAR_MIN_WIDTH = 300;
export const SIDEBAR_MAX_WIDTH = 640;
export const SIDEBAR_DEFAULT_WIDTH = 360;

export function clampSidebarWidth(px: number) {
  if (!Number.isFinite(px)) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(px)));
}

function loadSidebarWidthPreference() {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    return raw === null ? SIDEBAR_DEFAULT_WIDTH : clampSidebarWidth(Number(raw));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function setSidebarWidth(px: number) {
  state.sidebarWidth = clampSidebarWidth(px);
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(state.sidebarWidth));
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
  /** Book: 開いている book のプロジェクト+ページ一覧(page grid 表示用)。single/home では null。 */
  book: BookPages | null;
  /** Book: 開いているページ id。null=page grid 表示中(または single)。set=そのページの1枚生成 UI。 */
  activePageId: string | null;
  /** Book: ページ一覧で複数ページを選ぶモード。 */
  bookSelectionMode: boolean;
  /** Book: ページ一覧の選択モードで選択中の page id。 */
  selectedBookPageIds: string[];
  activeRoundId: string | null;
  activeAssetId: string | null;
  filter: "all" | "selected" | "rejected" | "favorite" | "unmarked";
  gridCols: 2 | 3 | 4;
  /** Home の新規作成フォームで選択中のモード(Single/Book セグメントトグル)。 */
  createProjectMode: "single" | "book";
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  /** 生成サイドバーのドラッグ変更後の幅(px)。localStorage に永続化。 */
  sidebarWidth: number;
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
  referenceDraft: ReferenceDraft | null;
  /** Book: ページ別の顔スタイル参照画像ドラフト(page id → draft)。single では未使用。 */
  referenceDraftsByPage: Record<string, ReferenceDraft>;
  /** Book: ページ別のスタイル LoRA 選択(page id → list)。single では未使用。 */
  loraDraftsByPage: Record<string, StyleLoraSelection[]>;
  /**
   * Book: ページ別の引き継ぎ用生成設定スナップショット(page id → 生成パラメータ。顔参照/seed値は除く)。
   * ページ離脱時に現ページ分を書き戻し、新規ページ追加時の初期値ソースにする。
   */
  pageSettingsByPage: Record<string, GenerationDraft>;
  /** Book: 「Book共通設定」画面を開いているか(book grid の上に重ねて表示)。 */
  bookSettingsOpen: boolean;
  /** コマ割りテンプレート選択モーダルを開いているか(book grid の上に重ねて表示)。 */
  layoutPickerOpen: boolean;
  /** コマ割りテンプレート一覧(内蔵+取り込み)。未取得は null。ピッカーを開くときに取得する。 */
  layoutTemplates: LayoutTemplateSummary[] | null;
  /** テンプレート一覧を取得中か。null(未取得/失敗)とローディングを区別してピッカー表示を出し分ける。 */
  layoutTemplatesLoading: boolean;
  /** Book: 新規ページの既定にする Book 共通の生成設定。未設定(null)なら直前ページから引き継ぐ。 */
  bookCommonSettings: GenerationDraft | null;
  /** Book: Book 共通のスタイル LoRA(bookCommonSettings とセットで使う)。 */
  bookCommonLora: StyleLoraSelection[] | null;
  /** Book Reader(漫画ビューア): ページ一覧の上に重ねて開いているか。state.detail とは独立。 */
  bookReaderOpen: boolean;
  /** Book Reader: 現在表示中の論理ページ index(0-based。見開き時は表示の先頭ページ index)。 */
  bookReaderPageIndex: number;
  /** Book Reader: 表示設定(方向/レイアウト/見開き開始/フィット/背景/番号表示)。プロジェクト別に永続化。 */
  bookReaderSettings: BookReaderSettings;
  /** Book Reader: ビューア内の設定パネルを開いているか。 */
  bookReaderSettingsOpen: boolean;
  /** 「最近使った参照画像」ピッカーの候補(現在のプロジェクトのラウンドから収集)。 */
  recentReferenceImages: RecentReferenceImage[];
  /** コマ内生成: 開いているページのコマ選択/クロップ編集 lightbox。null=閉。 */
  pagePanelLightbox: PagePanelLightboxState | null;
  /** コマ内生成: 現在開いているページのコマ割り当て一覧(PageDetail 取得のたびに更新)。single/未取得時は空配列。 */
  pagePanelAssignments: PagePanelAssignment[];
  /** コマ内生成: 生成フォームが対象にしているコマ。null なら通常の(コマ非対象)生成。 */
  activePanelTarget: PanelGenerationTarget | null;
  /** 独自確認ダイアログ。null=閉。 */
  confirmDialog: ConfirmDialogState | null;
  /** 次回 render 後に iteration tracker のスクロールを先頭へ戻す(プロジェクト切替時など)。 */
  iterationScrollReset: boolean;
  maskEditMode: boolean;
  maskToolbarMinimized: boolean;
  maskToolbarPos: { left: number; top: number } | null;
  maskPanelWidths: { left: number; right: number };
  copiedSeedAssetId: string | null;
  deletePreviewRoundId: string | null;
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
  /** Consistent Character: 生成フォームの「スタイル LoRA」枠(絵柄制御)。フォームレベルの共有リスト。 */
  loraDraft: StyleLoraSelection[];
  /** `GET /api/comfy/loras`(選択候補の LoRA 一覧)の取得状態。 */
  loraChoices: {
    status: "idle" | "loading" | "ready" | "error";
    names: string[];
  };
}

export const state: AppState = {
  settings: null,
  projects: [],
  templates: [],
  detail: null,
  currentProjectId: null,
  book: null,
  activePageId: null,
  bookSelectionMode: false,
  selectedBookPageIds: [],
  activeRoundId: null,
  activeAssetId: null,
  filter: "all",
  gridCols: 4,
  createProjectMode: "single",
  sidebarOpen: false,
  sidebarCollapsed: loadSidebarCollapsedPreference(),
  sidebarWidth: loadSidebarWidthPreference(),
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
  referenceDraft: null,
  referenceDraftsByPage: {},
  loraDraftsByPage: {},
  pageSettingsByPage: {},
  bookSettingsOpen: false,
  layoutPickerOpen: false,
  layoutTemplates: null,
  layoutTemplatesLoading: false,
  bookCommonSettings: null,
  bookCommonLora: null,
  bookReaderOpen: false,
  bookReaderPageIndex: 0,
  bookReaderSettings: DEFAULT_BOOK_READER_SETTINGS,
  bookReaderSettingsOpen: false,
  recentReferenceImages: [],
  pagePanelLightbox: null,
  pagePanelAssignments: [],
  activePanelTarget: null,
  confirmDialog: null,
  iterationScrollReset: false,
  maskEditMode: false,
  maskToolbarMinimized: false,
  maskToolbarPos: null,
  maskPanelWidths: { left: 300, right: 300 },
  copiedSeedAssetId: null,
  deletePreviewRoundId: null,
  paintEditMode: false,
  paintDrafts: {},
  maskPanelTab: "mask",
  poseDrafts: {},
  roundProgress: {},
  showShortcutsHelp: false,
  modelInstallFamily: null,
  modelCheck: { status: "idle", result: null },
  loraDraft: [],
  loraChoices: { status: "idle", names: [] }
};
