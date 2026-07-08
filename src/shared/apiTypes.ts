/**
 * API レスポンス境界の共有型。
 * サーバの `toApiRow()` が返す行データ/レスポンスの形と、クライアントが
 * `api<T>()` で受け取る形を1か所で共有する。型定義のみで挙動変更なし。
 * shared モジュールなので src/client / src/server には依存しない。
 */
import type { Json } from "./json";
import type { GenerationRequest } from "./types";
import type { PastedObject } from "./pasteAttachments";
import type { FeatureKey, ModelKind } from "./workflowModels";

export interface ComfyStatus {
  ok: boolean;
  state: "connected" | "disconnected";
  baseUrl: string;
  checkedAt: string;
  error?: string;
}

/** `GET /api/comfy/model-check` の1モデル行。`available` は ComfyUI 未接続/照合不能時 null。 */
export interface ModelCheckEntry {
  kind: ModelKind;
  name: string;
  loaderClass: string;
  inputName: string;
  targetDir: string;
  feature: FeatureKey;
  available: boolean | null;
}

/**
 * `GET /api/comfy/model-check` の feature 単位の可用性。`available` は「必要ノードパックが
 * 全て導入済み AND 必要モデルファイルが全て配置済み」。ComfyUI 未接続時は null(未確認)。
 * `base`(常時必須の4モデル)は対象外 -- 任意にON/OFFできる機能だけを列挙する。
 */
export interface ModelCheckFeatureStatus {
  key: FeatureKey;
  label: string;
  available: boolean | null;
  /** そのfeatureが必要とする全ノードパック(順序は宣言順、0件=コアノードのみで完結)。 */
  requiredNodePacks: Array<{ label: string; representativeClass: string }>;
  /** `requiredNodePacks` のうち未導入のもの。ComfyUI未接続時は requiredNodePacks と同一。 */
  missingNodePacks: Array<{ label: string; representativeClass: string }>;
}

/** `GET /api/comfy/model-check` のレスポンス全体。 */
export interface ModelCheckResult {
  family: string;
  comfy: { ok: boolean; baseUrl: string; error?: string };
  nodes: Array<{ classType: string; available: boolean }>;
  models: ModelCheckEntry[];
  features: ModelCheckFeatureStatus[];
  checkedAt: string;
}

export interface LlmStatus {
  ok: boolean;
  state: "connected" | "disconnected";
  baseUrl: string;
  checkedAt: string;
  error?: string;
}

/** プロジェクトの種別。'single'=従来の1枚生成、'book'=複数ページ(Book モード)。 */
export type ProjectMode = "single" | "book";

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  mode: ProjectMode;
  updatedAt: string;
  defaultTemplateId?: string | null;
  representativeThumbnailUrl?: string;
}

/**
 * `listProjects()` の一覧行。`ProjectRow` に加えて round_count / asset_count
 * サブクエリで実際に付与される集計フィールドを持つ。`createProject()` /
 * `getProjectDetail()` が返す行にはこれらのフィールドは存在しない
 * (`ProjectRow` を使うこと)。`pageCount` は book のみ意味を持つ。
 */
export interface ProjectSummary extends ProjectRow {
  roundCount: number;
  assetCount: number;
  pageCount?: number;
}

/** Book のページ1件。`page_index` の昇順が読書順。 */
export interface PageRow {
  id: string;
  projectId: string;
  pageIndex: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * ページ一覧行。`PageRow` に代表サムネ(そのページの selected/favorite → 無ければ最新 generated)と
 * アセット枚数を付与する。グリッド表示用。
 */
export interface PageSummary extends PageRow {
  representativeThumbnailUrl?: string;
  assetCount: number;
}

/** `GET /api/projects/:id/pages` のレスポンス。 */
export interface BookPages {
  project: ProjectRow;
  pages: PageSummary[];
}

/**
 * 「最近使った画像」1件(顔スタイル参照ピッカー用)。過去に使った顔参照画像(内容で重複排除)と
 * 生成画像を新しい順で混在させる。クリックすると `url` の画像を顔参照に採用する。
 */
export interface RecentReferenceImage {
  kind: "reference" | "asset";
  /** クリックで顔参照に採用する画像 URL(フル画像)。 */
  url: string;
  /** 一覧表示用のサムネイル URL(参照画像は url と同一)。 */
  thumbnailUrl: string;
  createdAt: string;
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
  /**
   * assetId → 貼り付け添付。グリッドのプレビュー合成と PASTE バッジに使う。
   * `enabled` は次回生成へ添付するかの per-asset フラグ(PASTE バッジでトグル、
   * OFF でもオブジェクトのデータ自体は保持される)。添付が 1 件以上あるアセットのみキーを持つ。
   */
  pasteAttachments: Record<string, { objects: PastedObject[]; enabled: boolean }>;
}

/**
 * `GET /api/projects/:id/pages/:pageId` のレスポンス。`ProjectDetail` を当該ページの
 * rounds/assets に絞ったもの + ページのメタ情報 `page`。クライアントは `ProjectDetail` 部分を
 * そのまま `state.detail` に載せて既存の1枚生成 UI を再利用する。
 */
export interface PageDetail extends ProjectDetail {
  page: PageRow;
}

export interface CollectRoundResponse {
  round?: Round;
  assets?: Asset[];
  message?: string;
  jobStats?: Json;
  /** ComfyUI の現在のサンプラー step(UX改善#5)。生成中でない/未取得なら null。 */
  progress?: { value: number; max: number } | null;
}
