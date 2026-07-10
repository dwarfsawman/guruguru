/**
 * API レスポンス境界の共有型。
 * サーバの `toApiRow()` が返す行データ/レスポンスの形と、クライアントが
 * `api<T>()` で受け取る形を1か所で共有する。型定義のみで挙動変更なし。
 * shared モジュールなので src/client / src/server には依存しない。
 */
import type { Json } from "./json";
import type { GenerationRequest } from "./types";
import type { GenerationIntent } from "./generationIntent";
import type { PastedObject } from "./pasteAttachments";
import type { PageLayout, PanelCrop } from "./pageLayout";
import type { PageObject, TextContent } from "./pageObjects";
import type { MosaicRegion } from "./mosaicRegion";
import type { TextLayoutResult } from "./textLayout";
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
  requiredNodePacks: Array<{ label: string; representativeClass: string; installUrl?: string }>;
  /**
   * `requiredNodePacks` のうち未導入のもの。ComfyUI未接続時は requiredNodePacks と同一。
   * 「クラス名は在るが必須入力を欠く(=同名の別フォーク取り違え)」もここに含まれる。
   */
  missingNodePacks: Array<{ label: string; representativeClass: string; installUrl?: string }>;
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
  /** OpenRaster export / Book pages の基準キャンバス幅(px)。 */
  canvasWidth: number;
  /** OpenRaster export / Book pages の基準キャンバス高さ(px)。 */
  canvasHeight: number;
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
  /**
   * コマ割りレイアウト(テンプレから追加した場合)。通常ページ/画像取り込みページは null。
   * 将来のコマ内生成・形状編集・吹き出しはこの構造を土台にする(今回は描画のみ)。
   */
  layout?: PageLayout | null;
  /**
   * ページオブジェクト(Docs/Feature-CGCollectionSuite.md P1): テキスト/吹き出し/ボックスの配列。
   * 未設定(objects_json が NULL)は null。クライアントは `normalizePageObjects(page.objects)` を通して使う。
   */
  objects?: PageObject[] | null;
  /**
   * モザイクリージョン(Docs/Feature-CGCollectionSuite.md P6): 非破壊で保存するモザイク領域の配列。
   * 未設定(mosaic_json が NULL)は null。クライアントは `normalizeMosaicRegions(page.mosaic)` を通して使う。
   */
  mosaic?: MosaicRegion[] | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * ページ一覧行。`PageRow` に代表アセット(そのページの selected/favorite → 無ければ最新 generated)の
 * サムネ/フル画像 URL と id、アセット枚数を付与する。グリッドはサムネ、Book Reader はフル画像を使う。
 */
export interface PageSummary extends PageRow {
  representativeThumbnailUrl?: string;
  /** 代表アセットのフル画像 URL(Book Reader の高解像度表示用)。代表アセットが無ければ未設定。 */
  representativeImageUrl?: string;
  /** 代表アセットの id(代表アセットが無ければ未設定)。 */
  representativeAssetId?: string;
  assetCount: number;
}

/** `GET /api/projects/:id/pages` のレスポンス。 */
export interface BookPages {
  project: ProjectRow;
  pages: PageSummary[];
}

/**
 * コマ内生成(Docs/Feature-PanelGeneration.md)。1コマ(`PageLayout.panels[].id`)への画像割り当て。
 * コマにつき現在の割り当ては1件(`page_id`+`panel_id` ユニーク)。`crop` は割り当て済み asset 画像の
 * うちコマへ表示する範囲(asset 画像座標系で正規化)。
 */
export interface PagePanelAssignment {
  id: string;
  pageId: string;
  panelId: string;
  assetId: string;
  crop: PanelCrop;
  createdAt: string;
  updatedAt: string;
  /** 割り当て済み asset のフル画像 URL(lightbox のクリップ表示に使う)。 */
  assetImageUrl: string;
  /** 割り当て済み asset の元画像サイズ(取得できなければ null)。 */
  assetWidth?: number | null;
  assetHeight?: number | null;
}

/**
 * コマ割りテンプレート1件。`source: 'builtin'` はコード側の内蔵プリセット、`'imported'` は
 * ユーザーが取り込んで登録した `.guruguru-layout.json5`。`layout` は正規化済みの `PageLayout`。
 */
export interface LayoutTemplateSummary {
  id: string;
  name: string;
  source: "builtin" | "imported";
  layout: PageLayout;
  createdAt?: string;
}

/** `GET /api/layout-templates` のレスポンス(内蔵 + 取り込みをマージ)。 */
export interface LayoutTemplatesResponse {
  templates: LayoutTemplateSummary[];
}

/**
 * フォント一覧1件(Docs/Feature-CGCollectionSuite.md P2)。`id` はサーバがパス+TTC内インデックスから
 * 安定生成する不透明な文字列(`TextStyle.fontId` にそのまま入る)。
 */
export interface FontSummary {
  id: string;
  familyName: string;
  subfamilyName: string;
  source: "system" | "user";
}

/** `GET /api/fonts` のレスポンス。 */
export interface FontsResponse {
  fonts: FontSummary[];
}

/** `POST /api/text-layout` のリクエストボディ。 */
export interface TextLayoutRequest {
  content: TextContent;
  /** 折り返し幅(page 単位)。横書き=行の最大幅、縦書き=列の最大高さ。省略/0以下は折り返し無し。 */
  maxWidth?: number;
}

/**
 * `POST /api/text-layout` のレスポンス。`resolvedFontId` は `content.style.fontId` が解決できなかった時に
 * フォールバック先の実際の fontId を返す(未解決のまま "default" 等を使い続けないよう、クライアントは
 * これを次回以降の fontId として採用できる)。
 */
export interface TextLayoutResponse extends TextLayoutResult {
  resolvedFontId: string;
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
  /** コマ内生成(Docs/Feature-PanelGeneration.md): この Round が対象とするコマ id。対象外は null。 */
  targetPanelId?: string | null;
  request: GenerationRequest;
  /** この Round を実行した GenerationProvider の id(Docs/Feature-ScriptToManga.md S1)。旧行/manual アップロードも含め常に非 NULL。 */
  providerId?: string;
  /** 導出済みの GenerationIntent(モデル中立の生成意図)。旧行は null。 */
  intent?: GenerationIntent | null;
  /** submit() 時点の ProviderCapabilities スナップショット(recipe 単位)。server 専用型のため緩く保持する。旧行は null。 */
  providerSnapshot?: Record<string, unknown> | null;
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
  /** そのページのコマ割り当て一覧(`page.layout` が無ければ常に空配列)。 */
  panelAssignments: PagePanelAssignment[];
  /**
   * ImageObject が参照する mediaId のうち、page_media 行/ファイルが欠損しているものの id
   * (Docs/Feature-ScriptToManga.md S2)。編集画面はこれを見てプレースホルダ(破線枠+media id)を表示する。
   */
  missingPageMediaIds: string[];
}

export interface CollectRoundResponse {
  round?: Round;
  assets?: Asset[];
  message?: string;
  jobStats?: Json;
  /** ComfyUI の現在のサンプラー step(UX改善#5)。生成中でない/未取得なら null。 */
  progress?: { value: number; max: number } | null;
}
