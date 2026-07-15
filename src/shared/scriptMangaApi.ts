import type { DialoguePolicy, MangaPlanV2, MangaPlanValidationReport } from "./mangaPlanV2";
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

export interface ScriptMangaUiSettings {
  templateId: string;
  planningMode: ScriptMangaPlanningMode;
  panelsPerPage: number;
  /** 1コマへ割り当てる台詞要素数の上限(1..8、既定4)。最終可否は文字preflightで判定する。 */
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
  /** 変更前の採用済みコマを完全一致時だけ再利用する predecessor run。 */
  predecessorRunId?: string;
  /** predecessor の固定revisionを引き継いで編集した完全な MangaPlanV2。 */
  successorPlan?: MangaPlanV2;
}

// --- プラン候補(ネームv4 D3) ---

export type ScriptMangaPlanCandidateStatus = "active" | "adopted" | "archived";

/** 候補一覧・生成応答で返す軽量ビュー(rawOutput 等の重い provenance は含めない)。 */
export interface ScriptMangaPlanCandidateView {
  id: string;
  projectId: string;
  scriptId: string;
  scriptRevisionId: string;
  groupId: string;
  profile: string | null;
  temperature: number | null;
  status: ScriptMangaPlanCandidateStatus;
  adoptedRunId: string | null;
  plan: ScriptMangaPlan;
  pageNaming: {
    mode: "beats" | "panels" | "deterministic";
    fallback: boolean;
    beatAnnotatorFallback?: boolean;
  } | null;
  createdAt: string;
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
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}
