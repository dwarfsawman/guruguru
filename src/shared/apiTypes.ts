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
import type { FeatureKey, ModelFamily, ModelKind } from "./workflowModels";
import type { FountainDoc } from "./fountain";

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
  family: ModelFamily;
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
 * `listProjects()` の一覧行。`ProjectRow` に加えて生成集計と最新script-manga活動を
 * サブクエリで実際に付与する。`createProject()` /
 * `getProjectDetail()` が返す行にはこれらのフィールドは存在しない
 * (`ProjectRow` を使うこと)。`pageCount` は book のみ意味を持つ。
 */
export interface ProjectSummary extends ProjectRow {
  roundCount: number;
  assetCount: number;
  pageCount?: number;
  /** 最新revisionに残るactive/adoptingネーム候補。run作成前の人間ゲートを一覧へ出す。 */
  scriptMangaCandidateCount?: number;
  latestScriptMangaCandidateId?: string | null;
  latestScriptMangaCandidateScriptId?: string | null;
  latestScriptMangaCandidateRevisionId?: string | null;
  latestScriptMangaCandidateCreatedAt?: string | null;
  /** projectの最新Manga run。Project一覧のCLI/GUI進捗同期用の軽量フィールド。 */
  latestScriptMangaRunId?: string | null;
  latestScriptMangaRunScriptId?: string | null;
  latestScriptMangaRunRevisionId?: string | null;
  latestScriptMangaRunPlanId?: string | null;
  latestScriptMangaRunStatus?: string | null;
  latestScriptMangaRunPhase?: string | null;
  latestScriptMangaRunApprovalStatus?: string | null;
  latestScriptMangaRunPanelCount?: number | null;
  latestScriptMangaRunCompletedCount?: number | null;
  latestScriptMangaRunFailedCount?: number | null;
  latestScriptMangaRunCreatedAt?: string | null;
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
  /** Explicit interactive fallback warnings (for example, optional identity adapter unavailable). */
  warning?: string[] | null;
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
  promptDialect?: "natural" | "tags";
  qualityTags?: string;
  negativeBase?: string;
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

// --- 脚本ドメイン(Docs/Feature-ScriptToManga.md S3) ---

/** Character 本体(Provider 中立: name/aliases/notes/color)。 */
export interface Character {
  id: string;
  projectId: string;
  name: string;
  aliases: string[] | null;
  notes: string;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET/PUT /api/characters/:id/bindings/:providerId` の応答。`binding_json.faceImagePath` は
 * サーバ内部のローカル絶対パスであり API では返さない -- 存在フラグ + 配信 URL に変換して返す
 * (Docs/Feature-ScriptToManga.md 既知の罠11)。
 */
export interface CharacterBindingView {
  providerId: string;
  hasFaceImage: boolean;
  faceImageUrl: string | null;
  loraName: string | null;
  loraStrength: number | null;
  updatedAt: string;
}

export interface MangaScript {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** 脚本原文と parse 結果は不変保存。revision は 1 始まり連番。 */
export interface ScriptRevision {
  id: string;
  scriptId: string;
  revision: number;
  fountainSource: string;
  parsed: FountainDoc;
  warnings: string[] | null;
  createdAt: string;
}

export type DialogueSemanticKind = "dialogue" | "monologue" | "narration" | "sfx";
export type DialogueBalloonStyle = "normal" | "telecom" | "machine" | "vo" | "thought" | "caption" | "monitor" | "sfx";
export type DialogueLineStatus = "active" | "orphaned";
export type DialogueLineSource = "fountain" | "manual" | "llm";

/** DialogueLine(物語上の台詞)。DialoguePlacement(ページ上の配置)とは1対多。 */
export interface DialogueLine {
  id: string;
  projectId: string;
  scriptId: string | null;
  characterId: string | null;
  speakerLabel: string;
  text: string;
  semanticKind: DialogueSemanticKind;
  balloonStyle: DialogueBalloonStyle;
  emotion: string | null;
  orderIndex: number;
  sceneIndex: number | null;
  sourceHash: string | null;
  status: DialogueLineStatus;
  source: DialogueLineSource;
  proposalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DialogueRenderKind = "balloon" | "caption" | "freeText";

/** DialoguePlacement(ページ上の配置)。1 DialogueLine を複数吹き出しへ分割配置できる(part_index)。 */
export interface DialoguePlacement {
  id: string;
  lineId: string;
  pageId: string;
  panelId: string | null;
  partIndex: number;
  renderKind: DialogueRenderKind;
  balloonObjectId: string | null;
  /**
   * Chronicle Page Flow(Docs/Done/Feature-ChroniclePageFlow.md §2.4・§2.6 フェーズIII)。
   * autoLayoutLocked=true は手動編集済みで再配置対象外(フェーズIVで使う)。
   * autoLayoutSeed/autoLayoutVersion は apply 時の再現用(未配置/手動配置は null)。
   */
  autoLayoutLocked: boolean;
  autoLayoutSeed: number | null;
  autoLayoutVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

/** `POST /api/projects/:id/scripts` / `POST /api/scripts/:id/revisions` の応答。 */
export interface ScriptImportResult {
  script: MangaScript;
  revision: ScriptRevision;
  lines: DialogueLine[];
}

/** `POST /api/dialogue-lines/:id/placements` の応答(吹き出し生成と対で作成)。 */
export interface CreatePlacementResult {
  placement: DialoguePlacement;
  objects: PageObject[];
}

// --- 構造化 LLM セリフ提案(Docs/Feature-ScriptToManga.md S4) ---

/**
 * `GET/PUT /api/settings/llm` の応答。`apiKey` 本体は API へ露出しない(既知の罠11)。
 * `hasApiKey` は設定済みかどうかのフラグのみ。PUT はフィールド単位の部分更新
 * (未指定 `apiKey` は現在値を維持、`clearApiKey: true` で削除 -- character binding の
 * faceImage と同型)。
 */
export interface LlmSettingsView {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  hasApiKey: boolean;
}

export type DialogueProposalStatus = "proposed" | "resolved" | "failed";
export type DialogueProposalItemStatus = "proposed" | "adopted" | "rejected" | "replaced";

/** LLM 提案の1項目(項目別の採用履歴を保持)。 */
export interface DialogueProposalItem {
  panelId: string | null;
  speakerName: string;
  text: string;
  semanticKind: DialogueSemanticKind;
  emotion?: string;
  itemStatus: DialogueProposalItemStatus;
  /** 採用で作られた dialogue_lines.id。 */
  adoptedLineId?: string;
  /** 手修正して採用した場合の最終文言。 */
  editedText?: string;
}

/**
 * `dialogue_proposals` 行。`rawOutput`(LLM 生出力 verbatim)と `request`(送信 messages)は
 * 再現性のため永続化する。`isStale` はサーバが `scriptRevisionId` と当該脚本の最新 revision を
 * 比較して都度計算する(既知の罠2並みの単純な派生値だが、テーブル自体には持たない)。
 */
export interface DialogueProposal {
  id: string;
  projectId: string;
  scriptId: string | null;
  scriptRevisionId: string | null;
  pageId: string | null;
  model: string;
  request: unknown;
  rawOutput: string | null;
  items: DialogueProposalItem[] | null;
  status: DialogueProposalStatus;
  error: string | null;
  createdAt: string;
  /** `scriptRevisionId` が当該脚本の最新 revision と一致しない(脚本が再取り込みされた)場合 true。 */
  isStale: boolean;
}

/** `POST /api/projects/:id/pages/:pageId/dialogue-proposals` の応答。 */
export interface CreateDialogueProposalResult {
  proposal: DialogueProposal;
}

/** `POST /api/dialogue-proposals/:id/adopt` の応答。採用項目から作られた DialogueLine を含む。 */
export interface AdoptDialogueProposalResult {
  proposal: DialogueProposal;
  lines: DialogueLine[];
}

export interface CollectRoundResponse {
  round?: Round;
  assets?: Asset[];
  message?: string;
  jobStats?: Json;
  /** ComfyUI の現在のサンプラー step(UX改善#5)。生成中でない/未取得なら null。 */
  progress?: { value: number; max: number } | null;
}
