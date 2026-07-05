/**
 * API レスポンス境界の共有型。
 * サーバの `toApiRow()` が返す行データ/レスポンスの形と、クライアントが
 * `api<T>()` で受け取る形を1か所で共有する。型定義のみで挙動変更なし。
 * shared モジュールなので src/client / src/server には依存しない。
 */
import type { Json } from "./json";
import type { GenerationRequest } from "./types";

export interface ComfyStatus {
  ok: boolean;
  state: "connected" | "disconnected";
  baseUrl: string;
  checkedAt: string;
  error?: string;
}

export interface LlmStatus {
  ok: boolean;
  state: "connected" | "disconnected";
  baseUrl: string;
  checkedAt: string;
  error?: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  defaultTemplateId?: string | null;
  representativeThumbnailUrl?: string;
}

/**
 * `listProjects()` の一覧行。`ProjectRow` に加えて round_count / asset_count
 * サブクエリで実際に付与される集計フィールドを持つ。`createProject()` /
 * `getProjectDetail()` が返す行にはこれらのフィールドは存在しない
 * (`ProjectRow` を使うこと)。
 */
export interface ProjectSummary extends ProjectRow {
  roundCount: number;
  assetCount: number;
}

export interface Round {
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

export interface Asset {
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

export interface AssetParent {
  id: string;
  parentAssetId: string;
  childAssetId: string;
  relationType: string;
  strength?: number | null;
  createdAt: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  type: string;
  version: number;
  workflowHash: string;
  workflowJson: Json;
  roleMap: Json;
}

export interface ProjectDetail {
  project: ProjectRow;
  rounds: Round[];
  assets: Asset[];
  assetParents: AssetParent[];
  templates: WorkflowTemplate[];
}

export interface CollectRoundResponse {
  round?: Round;
  assets?: Asset[];
  message?: string;
  jobStats?: Json;
  /** ComfyUI の現在のサンプラー step(UX改善#5)。生成中でない/未取得なら null。 */
  progress?: { value: number; max: number } | null;
}
