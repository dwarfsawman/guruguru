import type { DialoguePolicy, MangaPlanV2, MangaPlanValidationReport, MangaShotSize } from "./mangaPlanV2";
import type { PageLayout } from "./pageLayout";
import type { ScriptMangaReferenceSnapshot } from "./referenceSets";
import type { ScriptMangaPlan } from "./scriptMangaPlan";
import type { InpaintArea, MaskedContent } from "./types";

export type ScriptMangaPlanningMode = "heuristic" | "llm" | "provided";
export type ScriptMangaAuditMode = "manual" | "vlm";
/** 棒人間ControlNet(ネームv4 D4)。off=無効(既定)、それ以外は部分モード。 */
export type ScriptMangaPoseControlMode = "off" | "full" | "upper" | "face";
export type ScriptMangaVlmAuditState = "queued" | "deferred" | "completed" | "unavailable";

export interface ScriptMangaVlmAuditReport {
  assetId: string;
  score: number;
  passed: boolean;
  checks: Record<string, "pass" | "fail">;
  violations: string[];
  model: string;
}

export interface ScriptMangaVlmAuditView {
  state: ScriptMangaVlmAuditState;
  reports: ScriptMangaVlmAuditReport[];
  error: string | null;
}

export interface RecordExternalScriptMangaTaskAuditRequest {
  assetId: string;
  passed: boolean;
  score?: number;
  checks?: Record<string, "pass" | "fail">;
  violations?: string[];
  reviewer: string;
  model: string;
  notes?: string;
}

export interface ScriptMangaExternalAuditReport {
  assetId: string;
  passed: boolean;
  score?: number;
  checks: Record<string, "pass" | "fail">;
  violations: string[];
  reviewer: string;
  model: string;
  notes: string;
  evaluatedAt: string;
}

export interface ScriptMangaExternalAuditView {
  state: "completed";
  reports: ScriptMangaExternalAuditReport[];
  updatedAt: string;
}

export interface RecordExternalScriptMangaTaskAuditResponse {
  report: ScriptMangaExternalAuditReport;
  run: ScriptMangaRunView;
}

export interface ScriptMangaUiSettings {
  templateId: string;
  planningMode: ScriptMangaPlanningMode;
  panelsPerPage: number;
  /** 1コマへ割り当てる台詞要素数の上限(1..8、既定3)。最終可否は文字preflightで判定する。 */
  maxDialoguesPerPanel: number;
  /** 希望ページ数(1..200)。0は脚本量から自動決定。 */
  targetPageCount: number;
  /** plan全体のコマ数上限(1..800)。0は上限なし。 */
  maxPanelCount: number;
  dialoguePolicy: DialoguePolicy;
  auditMode: ScriptMangaAuditMode;
  /** 棒人間骨格のControlNet条件付け(実験的、既定 off)。 */
  poseControl: ScriptMangaPoseControlMode;
}

export interface PrepareScriptMangaRunRequest extends ScriptMangaUiSettings {
  scriptId: string;
  generateImages: false;
  candidateSelectionPolicy: "review";
  requireReferenceSets: true;
  allowReferenceFallback: false;
  /** ネームv4 D3: 採用するプラン候補。指定時は planningMode を無視して候補プランで run を作る。 */
  planCandidateId?: string;
  /** V5 D5: 採用時の楽観ロック(候補の editVersion)。フリップとの競合を採用開始時に検出する。 */
  expectedCandidateVersion?: number;
  /** 変更前の採用済みコマを完全一致時だけ再利用する predecessor run。 */
  predecessorRunId?: string;
  /** predecessor の固定revisionを引き継いで編集した完全な MangaPlanV2。 */
  successorPlan?: MangaPlanV2;
}

// --- プラン候補(ネームv4 D3 / V5 D5) ---

/** adopting = 採用処理中(監督LLM実行を挟むため数分かかる)。この間の set-layout は 409。 */
export type ScriptMangaPlanCandidateStatus = "active" | "adopting" | "adopted" | "archived";
export type ScriptMangaPlanCandidateOrigin = "embedded" | "external";
export type ScriptMangaPlanCandidateDirectorMode = "embedded" | "provided";

/** 候補一覧・生成応答で返す軽量ビュー(rawOutput 等の重い provenance は含めない)。 */
export interface ScriptMangaPlanCandidateView {
  id: string;
  projectId: string;
  scriptId: string;
  scriptRevisionId: string;
  groupId: string;
  profile: string | null;
  temperature: number | null;
  /** 旧server応答には無いためoptional。現行serverは常に embedded / external を返す。 */
  origin?: ScriptMangaPlanCandidateOrigin;
  /** provided は演出を固定済みで、originを問わず採用時に組み込み監督LLMを再実行しない候補。 */
  directorMode?: ScriptMangaPlanCandidateDirectorMode;
  status: ScriptMangaPlanCandidateStatus;
  adoptedRunId: string | null;
  /** 不変の基礎プラン(LLM/パッカーの生成結果)。表示は applyLayoutOverrides(plan, layoutOverrides) を使う。 */
  plan: ScriptMangaPlan;
  /** 人間のページ別レイアウト選択(pageIndex → layoutTemplateId)。基礎プランは書き換えない。 */
  layoutOverrides: Record<number, string>;
  /**
   * 人間ゲートのコマ割り修正(pageIndex → 編集済み PageLayout)。テンプレ選択より優先される。
   * 旧server応答には無いため optional。
   */
  customLayouts?: Record<number, PageLayout>;
  /** 吹き出し位置ヒント(pageIndex → dialogue orderIndex → page 座標)。旧server応答には無い。 */
  balloonHints?: Record<number, Record<number, { x: number; y: number }>>;
  /** 楽観的ロック用。set-layout/採用の expectedVersion に渡す。 */
  editVersion: number;
  pageNaming: {
    mode: "beats" | "deterministic";
    fallback: boolean;
    beatAnnotatorFallback?: boolean;
  } | null;
  createdAt: string;
}

/** V5 D5: ページ別レイアウトフリップ(本計画唯一の新エンドポイント)。 */
export interface SetCandidateLayoutRequest {
  pageIndex: number;
  layoutTemplateId: string;
  expectedVersion: number;
}

export interface SetCandidateLayoutResponse {
  version: number;
  candidate: ScriptMangaPlanCandidateView;
}

/**
 * 人間ゲートのコマ割り修正の保存(set-custom-layout)。`layout`/`balloonHints` は
 * 「undefined = 変更しない / null = 削除(リセット) / 値 = 置き換え」の三値。
 */
export interface SetCandidateCustomLayoutRequest {
  pageIndex: number;
  expectedVersion: number;
  layout?: PageLayout | null;
  balloonHints?: Record<number, { x: number; y: number }> | null;
}

export interface SetCandidateCustomLayoutResponse {
  version: number;
  candidate: ScriptMangaPlanCandidateView;
}

// --- 演出ネームの差分編集(V5 D6) ---

/**
 * スタジオ用のホワイトリスト差分編集。完全なV2を送り返さない(ライブ更新+エージェント併走で
 * dialogueSnapshots/provenance まで lost update するため)。完全V2の PATCH は successor/provided
 * 系ツール向けにそのまま残る。
 */
export type NamePlanEdit =
  | { kind: "page"; pageIndex: number; pageIntent: string }
  | { kind: "panel"; panelId: string; shotSize?: MangaShotSize; shotAngle?: string; compositionIntent?: string; promptBase?: string }
  | { kind: "cast"; panelId: string; characterId: string; expression?: string; action?: string };

export interface NamePlanEditRequest {
  /** 楽観ロック(plan の editVersion。plan_json への全書き込みで加算される内容バージョン)。 */
  expectedVersion: number;
  edits: NamePlanEdit[];
}

export interface ScriptMangaPlanCandidatesResponse {
  candidates: ScriptMangaPlanCandidateView[];
  /** 注釈ビート id → kind(キャッシュ済み注釈がある場合のみ)。ワイヤーフレームのアイコン用。 */
  beatKinds: Record<string, string>;
  /** dialogueOrderIndex → 台詞本文の文字数。コマの台詞量バー用(全候補共通)。 */
  dialogueCharsByOrderIndex: number[];
}

export interface CreateScriptMangaPlanCandidatesRequest {
  scriptId: string;
  /** 生成する候補数(1..6、既定3)。 */
  count?: number;
  /** 既存グループへの追加生成。省略時は新しいグループを作る。 */
  groupId?: string;
  /** 候補毎の演出プロファイル(readability / cinematic / tempo)。省略時は順繰り。 */
  profiles?: string[];
  targetPageCount?: number;
  panelsPerPage?: number;
  maxDialoguesPerPanel?: number;
}

export interface ImportScriptMangaPlanCandidateRequest {
  scriptId: string;
  /** raceを避けるため必須。latest revisionと一致しないimportは409。 */
  scriptRevisionId: string;
  /** 外部agentが固定revisionに対して作った、全コマ演出済みのplan。 */
  plan: ScriptMangaPlan;
  /** 既存比較groupへupsertする。省略時は新しいgroupを作る。 */
  groupId?: string;
  /** Name Studio上の案名/方針(readability / cinematic / tempo等)。 */
  profile?: string;
  /** provenance表示・監査用。候補plan本体へは混ぜない。 */
  agent?: string;
  model?: string;
  notes?: string;
}

export interface ImportScriptMangaPlanCandidateResponse {
  candidate: ScriptMangaPlanCandidateView;
  /** true=新規INSERT、false=同一groupの構造重複行を更新したupsert。 */
  imported: boolean;
  /** 構造重複をupsertした既存candidate id。新規INSERT時はnull。 */
  duplicateOf: string | null;
}

export type ScriptMangaCandidatePreflightRequest = Pick<PrepareScriptMangaRunRequest, "templateId"> &
  Partial<Omit<
    PrepareScriptMangaRunRequest,
    "scriptId" | "planCandidateId" | "templateId" | "predecessorRunId" | "successorPlan"
  >> & {
    providerId?: string;
    characterBible?: string;
    stylePrompt?: string;
    maxElementsPerPanel?: number;
  };

export interface ScriptMangaCandidatePreflightIssueView {
  stage: string;
  code: string;
  severity: "error" | "warning";
  message: string;
  taskId?: string;
  pageId?: string;
  pageIndex?: number;
  panelId?: string;
  dialogueLineId?: string;
  characterCount?: number;
}

export interface ScriptMangaCandidatePreflightReportView {
  ok: boolean;
  candidateId: string;
  projectId: string;
  scriptId: string;
  scriptRevisionId: string;
  candidateEditVersion: number;
  candidateDirectionFixed: boolean;
  candidateDirectionFrozen: boolean;
  candidateDirectionInputHash: string | null;
  candidateDirectionModel: string | null;
  skippedChecks: Array<"reference-sets" | "image-generation" | "image-audit">;
  materializationIdsEphemeral: true;
  checkedPanelTaskCount: number;
  failedPanelTaskCount: number;
  panelReports: unknown[];
  issues: ScriptMangaCandidatePreflightIssueView[];
  failure: { kind: string; code: string; message: string; statusCode: number | null } | null;
}

export type AdoptScriptMangaPlanCandidateRequest = ScriptMangaCandidatePreflightRequest;

export interface AdoptScriptMangaPlanCandidateResponse {
  candidate: ScriptMangaPlanCandidateView;
  run: ScriptMangaRunView;
  /** Present on a fresh adoption; omitted on an idempotent replay. */
  preflight?: ScriptMangaCandidatePreflightReportView;
}

export interface AdoptScriptMangaPlanCandidateFailure {
  error: string;
  preflight: ScriptMangaCandidatePreflightReportView;
}

export interface ScriptMangaTaskView {
  id: string;
  pageId: string;
  panelId: string;
  roundId: string | null;
  status: string;
  attemptCount: number;
  candidateAssetIds: string[];
  selectedAssetId: string | null;
  inheritedFromTaskId: string | null;
  reuseFingerprint: string | null;
  scores: unknown;
  lastError: unknown;
}

/**
 * 既存の漫画候補を親画像にした局所 inpaint。生成の物語条件・workflow・参照設定は
 * サーバーが親候補の round から固定継承し、クライアントは修復範囲だけを指定する。
 */
export interface RepairScriptMangaTaskRequest {
  assetId: string;
  /** 親候補をどの程度描き直すか。省略時 0.45。 */
  denoise?: number;
  inpaint: {
    /** 親候補と同じ寸法の、更新領域を白で示した PNG data URL。 */
    maskDataUrl: string;
    maskedContent?: MaskedContent;
    inpaintArea?: InpaintArea;
    onlyMaskedPadding?: number;
    featherRadius?: number;
  };
}

export interface ScriptMangaRunView {
  id: string;
  predecessorRunId: string | null;
  projectId: string;
  scriptId: string;
  scriptRevisionId: string | null;
  planId: string | null;
  planVersion: number;
  status: string;
  phase: string;
  approvalStatus: string;
  pageCount: number;
  panelCount: number;
  completedCount: number;
  failedCount: number;
  evaluation: unknown;
  exportManifest: unknown;
  generationBudget: unknown;
  referenceSnapshot: ScriptMangaReferenceSnapshot | null;
  auditMode: ScriptMangaAuditMode;
  lastError: unknown;
  plan: MangaPlanV2 | null;
  /** V5 D6: plan の editVersion(差分編集の expectedVersion に渡す)。 */
  planEditVersion: number | null;
  validation: MangaPlanValidationReport | null;
  tasks: ScriptMangaTaskView[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface VlmAuditServiceStatus {
  ok: boolean;
  state: "ready" | "unconfigured" | "server-unreachable" | "model-not-loaded";
  baseUrl: string;
  model: string;
  checkedAt: string;
  loadedModelIds: string[];
  error?: string;
}

export interface ScriptMangaPlanView {
  id: string;
  projectId: string;
  scriptId: string;
  scriptRevisionId: string;
  status: string;
  plan: MangaPlanV2;
  validation: MangaPlanValidationReport;
  /** V5 D6: 差分編集の楽観ロック用(plan_json への全書き込みで加算)。 */
  editVersion: number;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}
