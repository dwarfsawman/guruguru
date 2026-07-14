import type { DialoguePolicy, MangaPlanV2, MangaPlanValidationReport } from "./mangaPlanV2";
import type { ScriptMangaReferenceSnapshot } from "./referenceSets";
import type { ScriptMangaPlan } from "./scriptMangaPlan";

export type ScriptMangaPlanningMode = "heuristic" | "llm";
export type ScriptMangaAuditMode = "manual" | "vlm";
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
  dialoguePolicy: DialoguePolicy;
  auditMode: ScriptMangaAuditMode;
}

export interface PrepareScriptMangaRunRequest extends ScriptMangaUiSettings {
  scriptId: string;
  generateImages: false;
  candidateSelectionPolicy: "review";
  requireReferenceSets: true;
  allowReferenceFallback: false;
  /** ネームv4 D3: 採用するプラン候補。指定時は planningMode を無視して候補プランで run を作る。 */
  planCandidateId?: string;
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
  scores: unknown;
  lastError: unknown;
}

export interface ScriptMangaRunView {
  id: string;
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
