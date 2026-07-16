import type { ComfySettings } from "../shared/types";
import type {
  Asset,
  BookPages,
  Character,
  CharacterBindingView,
  DialogueLine,
  DialogueProposal,
  FontSummary,
  LayoutTemplateSummary,
  LlmSettingsView,
  MangaScript,
  ModelCheckResult,
  PagePanelAssignment,
  ProjectDetail,
  ProjectSummary,
  RecentReferenceImage,
  ScriptRevision
} from "../shared/apiTypes";
import type {
  ChronicleBeat,
  ChronicleLineSummary,
  ChroniclePageSummary,
  DialogueLayoutPreview,
  ExistingPlacementPolicy
} from "../shared/chronicle";
import type { PageLayout, PanelCrop } from "../shared/pageLayout";
import type { PageObject } from "../shared/pageObjects";
import type { MosaicRegion } from "../shared/mosaicRegion";
import type { ConnectionState } from "./views/homeView";
import type { MaskPanelTab } from "./views/assetModal";
import type { WorkflowTemplate } from "./workflowTypes";
import type { InpaintDraft } from "./maskTypes";
import type { PaintDraft } from "./paintTypes";
import type { PoseDraft } from "./poseTypes";
import type { StyleLoraSelection } from "../shared/types";
import type { BookReaderSettings } from "./bookReader";
import { DEFAULT_BOOK_READER_SETTINGS } from "./bookReader";
import type {
  ScriptMangaPlanCandidateView,
  ScriptMangaRunView,
  ScriptMangaUiSettings,
  VlmAuditServiceStatus
} from "../shared/scriptMangaApi";
import type { CharacterReferenceSetView } from "../shared/referenceSets";

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
  /**
   * ページ編集モードタブ(Docs/Feature-CGCollectionSuite.md P1/P5/P6)。"panels" = 既存のコマ選択/クロップ編集、
   * "objects" = テキスト/吹き出し/ボックスの編集、"shapes" = コマ形状編集(P5: 頂点ドラッグ・分割)、
   * "mosaic" = モザイクリージョン編集(P6)。`page.layout` が無いページは "mosaic" 以外は常に "objects" 扱い
   * (モザイクはレイアウト無しページでも開ける。呼び出し側が open 時に決める)。
   */
  mode: "panels" | "objects" | "shapes" | "mosaic";
  selectedPanelId: string | null;
  /** クロップ編集モードの対象コマ id。null なら通常の選択モード。 */
  cropPanelId: string | null;
  /** クロップ編集中のドラッグ作業用コピー(pointerup で確定 PATCH、閉じると破棄)。 */
  cropDraft: PanelCrop | null;
  /**
   * ページ座標系の高さ(width=1 正規化)。`page.layout` があればその `page.height`、無ければ
   * 代表アセットのアスペクト比から求めた値(open 時に1回だけ解決してここへ保持する)。
   * オブジェクトモードの SVG viewBox / ギズモ計算に使う。
   */
  pageHeight: number;
}

/** コマ内生成: 「選択コマを生成」等で生成フォームが対象にしているコマ(次の生成 round が targetPanelId を持つ)。 */
export interface PanelGenerationTarget {
  pageId: string;
  panelId: string;
}

/**
 * Chronicle バー(Docs/Done/Feature-ChroniclePageFlow.md §4)。ページ編集 lightbox 下部の脚本タイムライン。
 * `status`/`collapsed`/`scriptId`/`revisionId`/`beats`/`selectedBeatIds`/`preview`/`busyAction` は
 * 設計書 §4 に明示された型のまま(`selectedBeatIds`/`preview`/`busyAction` はフェーズII以降で使う
 * フィールドで、フェーズIでは型だけ用意し初期値のみ)。`lines`/`pages`/`scripts`/`pageId`/`previewBeatId`/
 * `errorMessage` はフェーズIの表示(状態導出・複数脚本セレクタ・Beat クリック内容プレビュー・非同期完了
 * ガード)に必要なため実装上追加した(設計書からの逸脱)。
 */
export interface ChronicleUiState {
  status: "idle" | "loading" | "ready" | "error";
  collapsed: boolean;
  scriptId: string | null;
  revisionId: string | null;
  beats: ChronicleBeat[];
  selectedBeatIds: string[];
  preview: DialogueLayoutPreview | null;
  busyAction: null | "assign" | "preview" | "apply" | "reflow";
  /** そのプロジェクトの脚本一覧(複数脚本セレクタ用)。表示条件判定(1件以上か)にも使う。 */
  scripts: MangaScript[];
  /** GET /chronicle が返した行の状態導出用サマリ(Beat の状態色分け・内容プレビューに使う)。 */
  lines: ChronicleLineSummary[];
  /** GET /chronicle が返したページ別の行 id 一覧(現在ページの割り当て範囲強調・自動スクロールに使う)。 */
  pages: ChroniclePageSummary[];
  /** このデータを取得した時点の lightbox.pageId(非同期完了後の state 書き込みガード。既知の罠6と同型)。 */
  pageId: string | null;
  /** Beat クリックで開いている内容プレビューの対象 Beat id。null=非表示。 */
  previewBeatId: string | null;
  /** status="error" 時のエラーメッセージ。 */
  errorMessage: string | null;
  /**
   * フェーズII: 選択範囲を割り当てる際の他ページ配置ポリシー(§3)。設計書に無いが、
   * 「move/copy の選択 UI は簡素でよい」(§6 フェーズII)を満たすため実装上追加した状態
   * (タブボタンで選択、既定 "skip")。
   */
  allocationPolicy: ExistingPlacementPolicy;
}

/** ネームスタジオ(V5 D5)の表示状態。takeId=選択中候補(null=先頭)、pageIndex=表示ページ。 */
export interface NameStudioState {
  takeId: string | null;
  pageIndex: number;
  selectedPanelId: string | null;
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

const CHRONICLE_COLLAPSED_STORAGE_KEY = "guruguru:chronicleCollapsed";

/** Chronicle バーの折り畳み状態(localStorage 記憶、設計書 §2.1)。既定は展開(false)。 */
function loadChronicleCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(CHRONICLE_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setChronicleCollapsed(collapsed: boolean) {
  state.chronicle.collapsed = collapsed;
  try {
    window.localStorage.setItem(CHRONICLE_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
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
  referenceSets: CharacterReferenceSetView[];
  referenceCornerOpen: boolean;
  referenceCornerCharacterId: string | null;
  referenceSetBusyId: string | null;
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
  llmSettings: LlmSettingsView | null;
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
  /** 画像書き出し(Docs/Feature-CGCollectionSuite.md P4): ダイアログを開いているか(book grid の上に重ねて表示)。 */
  imageExportOpen: boolean;
  /** 画像書き出し: 対象ページ id。null=全ページ、配列=選択ページ(選択モードから開いた場合)。 */
  imageExportPageIds: string[] | null;
  /** 画像書き出し: 書き出しリクエスト送信中か(ボタン disabled + スピナー表示に使う)。 */
  imageExportBusy: boolean;
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
  /**
   * ページオブジェクト編集(Docs/Feature-CGCollectionSuite.md P1): 開いている lightbox のページの
   * オブジェクト配列ドラフト。全ての編集操作(追加/移動/拡縮/回転/削除/z順/プロパティ変更)は
   * これを直接書き換え、`pageObjectsController.ts` が 1s debounce で PATCH する。lightbox 非開時は空配列。
   */
  pageObjectsDraft: PageObject[];
  /**
   * ページオブジェクト編集: 選択中オブジェクト id の集合(Docs/Feature-PageEditSidebarUx.md 課題C-2)。
   * 先頭=primary(SETTINGS パネルの単一選択表示・画像差し替え対象等はこれを使う)。空配列=未選択。
   * 通常クリック=単独選択(グループ所属ならグループ全員)/ Shift+クリック=対象をトグル追加・除去/
   * Alt+クリック=グループを無視して1個だけ選択。解決ロジックは `pageObjectSelection.ts` の純関数。
   */
  selectedPageObjectIds: string[];
  /** レイヤ UI: 編集キャンバス上だけで一時非表示にしている PageObject id。書き出しには影響しない。 */
  pageLayerHiddenObjectIds: string[];
  /** レイヤ UI: 編集キャンバス上だけで一時非表示にしているコマ画像の panel id。 */
  pageLayerHiddenPanelIds: string[];
  /** レイヤ UI: コマ画像と画像オブジェクト以外を編集キャンバス上で一括非表示にする。 */
  pageLayerHideNonImage: boolean;
  /**
   * テキストオブジェクト編集(Docs/Feature-CGCollectionSuite.md P2): `GET /api/fonts` の取得状態+結果。
   * 初回オブジェクトモード表示時に取得しキャッシュする(`ensureFontsLoaded`)。
   */
  pageObjectFonts: { status: "idle" | "loading" | "ready" | "error"; fonts: FontSummary[] };
  /**
   * 画像オブジェクト(Docs/Feature-ScriptToManga.md S2): 開いている lightbox のページに属する Asset 一覧
   * (「画像追加」ピッカーの候補)。`openPagePanelLightbox` が取得する PageDetail.assets から都度セットする
   * (state.detail は別ページのものである可能性があるため専用に持つ)。lightbox 非開時は空配列。
   */
  pagePanelLightboxAssets: Asset[];
  /**
   * 画像オブジェクト: そのページの ImageObject が参照する mediaId のうち page_media 行/ファイルが
   * 欠損しているものの id(PageDetail.missingPageMediaIds)。編集画面のプレースホルダ表示に使う。
   */
  pagePanelLightboxMissingMediaIds: string[];
  /**
   * 画像オブジェクト: 「画像追加」/「メディア差し替え」ピッカーの開閉状態。"add" は新規オブジェクト追加、
   * "replace" は選択中オブジェクトの mediaId 差し替え。null=閉。
   */
  pageObjectImagePicker: { mode: "add" | "replace" } | null;
  /**
   * コマ形状編集(Docs/Feature-CGCollectionSuite.md P5): 開いている lightbox のページのレイアウト・ドラフト。
   * lightbox を開いた時に `page.layout` のディープコピーを持ち、頂点編集/分割はこれを直接書き換えて
   * `panelShapeController.ts` が 1s debounce(分割は即時)で PATCH する。レイアウト無しページは null。
   */
  pageLayoutDraft: PageLayout | null;
  /** コマ形状編集: 選択中パネル id。null=未選択。 */
  shapeSelectedPanelId: string | null;
  /** コマ形状編集: 選択中頂点 index(Delete キーでの削除用)。null=頂点未選択。 */
  shapeSelectedVertexIndex: number | null;
  /** コマ形状編集: 分割モード(コマ上ドラッグで直線を引いて2分割)が有効か。 */
  shapeSplitMode: boolean;
  /** コマ形状編集: 分割モードでドラッグ中の直線(pointerdown〜pointerup の作業用プレビュー)。null=非ドラッグ中。 */
  shapeSplitDraft: { start: [number, number]; current: [number, number] } | null;
  /** コマ形状編集: 分割時のガター幅(page 単位、既定はページ幅の1.5%)。 */
  shapeSplitGutter: number;
  /**
   * モザイク編集(Docs/Feature-CGCollectionSuite.md P6): 開いている lightbox のページのモザイクリージョン
   * ドラフト。追加/頂点編集/削除/granularity 変更はこれを直接書き換え、`pageMosaicController.ts` が
   * 1s debounce で PATCH する。lightbox 非開時は空配列。
   */
  pageMosaicDraft: MosaicRegion[];
  /** モザイク編集: 選択中リージョン id。null=未選択。 */
  mosaicSelectedRegionId: string | null;
  /** モザイク編集: 選択中頂点 index(polygon の頂点削除/矩形の辺・角 index にも使う)。null=未選択。 */
  mosaicSelectedVertexIndex: number | null;
  /** モザイク編集: 新規リージョン追加モード。null=通常(選択/編集)、"rect"=矩形をドラッグで追加、"polygon"=クリックで頂点を置いていく。 */
  mosaicAddMode: "rect" | "polygon" | null;
  /** モザイク編集: 矩形追加ドラッグ中の作業用プレビュー(pointerdown〜pointerup)。null=非ドラッグ中。 */
  mosaicRectDraft: { start: [number, number]; current: [number, number] } | null;
  /** モザイク編集: 多角形追加でこれまでにクリックした頂点列。追加モードでない時/開始前は null。 */
  mosaicPolygonDraft: [number, number][] | null;
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
  modelInstallFamily: "chroma" | "anima" | null;
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

  // --- 脚本ドメイン(Docs/Feature-ScriptToManga.md S3) ---

  /** 脚本画面(Book レベルの新スクリーン)を開いているか(book grid の上に重ねて表示、bookSettingsOpen と同型)。 */
  scriptScreenOpen: boolean;
  /** そのプロジェクトの脚本一覧(通常は0〜1件)。脚本画面を開いた時に取得する。 */
  scripts: MangaScript[];
  /** 脚本画面で選択中の脚本 id。null=未取り込み(脚本ゼロ件)。 */
  activeScriptId: string | null;
  /** 選択中脚本の最新 revision(パース結果+警告表示用)。未取得/脚本なしは null。 */
  activeScriptRevision: ScriptRevision | null;
  /** 選択中脚本のセリフ行一覧(シーン/セリフ一覧・ページ割当 UI に使う)。 */
  scriptDialogueLines: DialogueLine[];
  /** Fountain テキストエリアの編集ドラフト(取り込み/再取り込みの送信元)。 */
  scriptFountainDraft: string;
  /** 取り込み/再取り込みの送信中フラグ(ボタン disabled + スピナー表示に使う)。 */
  scriptImportBusy: boolean;
  /** MangaPlanV2 一括生成で選択可能な workflow template。脚本画面を開くたび現在の一覧へ同期する。 */
  scriptMangaTemplates: WorkflowTemplate[];
  /** MangaPlanV2 の準備時に送る編集可能な設定。 */
  scriptMangaSettings: ScriptMangaUiSettings;
  /** 準備済み、または実行中の現在run。脚本切替・再取り込み・画面closeで破棄する。 */
  scriptMangaRun: ScriptMangaRunView | null;
  /** run準備・状態遷移・候補採用の多重送信を防ぐ専用busy。 */
  scriptMangaBusy: boolean;
  /** VLM監査サービスの非ブロッキング接続状態。脚本画面を開いた時に取得する。 */
  scriptMangaVlmStatus: VlmAuditServiceStatus | null;
  /** プラン候補(ネームv4 D3)。最新revisionの非archived一覧。脚本画面を開いた時に取得する。 */
  scriptMangaCandidates: ScriptMangaPlanCandidateView[];
  /** 注釈ビート id → kind(候補ワイヤーフレームのアイコン用)。 */
  scriptMangaCandidateBeatKinds: Record<string, string>;
  /** dialogueOrderIndex → 台詞文字数(候補ワイヤーフレームの台詞量バー用)。 */
  scriptMangaCandidateDialogueChars: number[];
  /** 候補生成・破棄の多重送信を防ぐ専用busy(run系のscriptMangaBusyとは独立)。 */
  scriptMangaCandidatesBusy: boolean;
  /** 「候補を生成」で一度に走らせるN1回数(1..6)。 */
  scriptMangaCandidateCount: number;
  /** ネームスタジオ(V5 D5)の表示状態: 選択中テイク・ページ・コマ。 */
  nameStudio: NameStudioState;
  /** そのプロジェクトのキャラクタ一覧。脚本画面を開いた時に取得する。 */
  characters: Character[];
  /** キャラクタ一覧で選択中(編集対象)の id。null=未選択。 */
  selectedCharacterId: string | null;
  /** 選択中キャラクタの comfy binding(顔参照/LoRA)。未取得/キャラ未選択は null。 */
  selectedCharacterBinding: CharacterBindingView | null;
  /** キャラクタ編集: LoRA 名ドラフト(保存前の一時値)。 */
  characterLoraNameDraft: string;
  /** キャラクタ編集: LoRA 強度ドラフト。 */
  characterLoraStrengthDraft: number;
  /** キャラクタ編集: 「最近使った画像」ピッカーを開いているか(顔参照の選択用)。 */
  characterFacePickerOpen: boolean;
  /**
   * 配置ドロワー(lightbox objects モードの「セリフ」ドロワー、S3 UI 2)。開閉状態。
   * true の間、`pagePanelLightboxDialogueLines` を一覧表示し、クリックで `dialogue_placements`
   * 作成+吹き出し生成を行う(1行を複数回クリックすれば分割配置になる)。
   */
  dialogueDrawerOpen: boolean;
  /** 配置ドロワー: そのプロジェクトの active なセリフ行(ドロワーを開いた時に取得)。lightbox 非開時は空配列。 */
  pagePanelLightboxDialogueLines: DialogueLine[];

  // --- 構造化 LLM セリフ提案(Docs/Feature-ScriptToManga.md S4) ---

  /** 配置ドロワー: 「AIセリフ提案」でこのページ向けに取得済みの提案一覧(新しい順)。lightbox 非開時は空配列。 */
  dialogueProposals: DialogueProposal[];
  /**
   * 配置ドロワー: LLM 提案リクエスト送信中フラグ(ボタン disabled + スピナー表示、llmImproving 同型)。
   * 「LLM 待ち中のページ移動ガード」はこのフラグ+リクエスト発行時に捕捉した pageId で行う
   * (dialogueProposalRequestPageId が現在の lightbox.pageId と一致する時だけ結果を state へ反映する)。
   */
  dialogueProposalBusy: boolean;
  /** 直近の提案リクエストを発行した pageId(非同期完了後の state 書き込みガード。既知の罠6)。 */
  dialogueProposalRequestPageId: string | null;

  // --- Chronicle Page Flow(Docs/Done/Feature-ChroniclePageFlow.md S5) ---

  /** Chronicle バー(ページ編集 lightbox 下部の脚本タイムライン)。 */
  chronicle: ChronicleUiState;
}

export const state: AppState = {
  settings: null,
  projects: [],
  templates: [],
  detail: null,
  currentProjectId: null,
  book: null,
  referenceSets: [],
  referenceCornerOpen: false,
  referenceCornerCharacterId: null,
  referenceSetBusyId: null,
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
  imageExportOpen: false,
  imageExportPageIds: null,
  imageExportBusy: false,
  bookReaderOpen: false,
  bookReaderPageIndex: 0,
  bookReaderSettings: DEFAULT_BOOK_READER_SETTINGS,
  bookReaderSettingsOpen: false,
  recentReferenceImages: [],
  pagePanelLightbox: null,
  pagePanelAssignments: [],
  pageObjectsDraft: [],
  selectedPageObjectIds: [],
  pageLayerHiddenObjectIds: [],
  pageLayerHiddenPanelIds: [],
  pageLayerHideNonImage: false,
  pageObjectFonts: { status: "idle", fonts: [] },
  pagePanelLightboxAssets: [],
  pagePanelLightboxMissingMediaIds: [],
  pageObjectImagePicker: null,
  pageLayoutDraft: null,
  shapeSelectedPanelId: null,
  shapeSelectedVertexIndex: null,
  shapeSplitMode: false,
  shapeSplitDraft: null,
  shapeSplitGutter: 0.015,
  pageMosaicDraft: [],
  mosaicSelectedRegionId: null,
  mosaicSelectedVertexIndex: null,
  mosaicAddMode: null,
  mosaicRectDraft: null,
  mosaicPolygonDraft: null,
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
  loraChoices: { status: "idle", names: [] },
  scriptScreenOpen: false,
  scripts: [],
  activeScriptId: null,
  activeScriptRevision: null,
  scriptDialogueLines: [],
  scriptFountainDraft: "",
  scriptImportBusy: false,
  scriptMangaTemplates: [],
  scriptMangaSettings: {
    templateId: "",
    planningMode: "heuristic",
    panelsPerPage: 4,
    maxDialoguesPerPanel: 4,
    targetPageCount: 0,
    maxPanelCount: 0,
    dialoguePolicy: "preserve",
    auditMode: "vlm",
    poseControl: "off"
  },
  scriptMangaRun: null,
  scriptMangaBusy: false,
  scriptMangaVlmStatus: null,
  scriptMangaCandidates: [],
  scriptMangaCandidateBeatKinds: {},
  scriptMangaCandidateDialogueChars: [],
  scriptMangaCandidatesBusy: false,
  scriptMangaCandidateCount: 3,
  nameStudio: { takeId: null, pageIndex: 0, selectedPanelId: null },
  characters: [],
  selectedCharacterId: null,
  selectedCharacterBinding: null,
  characterLoraNameDraft: "",
  characterLoraStrengthDraft: 1,
  characterFacePickerOpen: false,
  dialogueDrawerOpen: false,
  pagePanelLightboxDialogueLines: [],
  dialogueProposals: [],
  dialogueProposalBusy: false,
  dialogueProposalRequestPageId: null,
  chronicle: {
    status: "idle",
    collapsed: loadChronicleCollapsedPreference(),
    scriptId: null,
    revisionId: null,
    beats: [],
    selectedBeatIds: [],
    preview: null,
    busyAction: null,
    scripts: [],
    lines: [],
    pages: [],
    pageId: null,
    previewBeatId: null,
    errorMessage: null,
    allocationPolicy: "skip"
  }
};
