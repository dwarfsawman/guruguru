import type { DialoguePolicy, MangaPlanV2, MangaPlanValidationReport } from "./mangaPlanV2";

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
