import type { GenerationIntent } from "../../shared/generationIntent";
import type { GenerationRequest } from "../../shared/types";

/** Provider 単位で確認できる機能の可用性。`null` は未確認(ComfyUI 未接続等)。 */
export interface ProviderFeatureFlags {
  img2img: boolean | null;
  inpaint: boolean | null;
  controlPose: boolean | null;
  controlEdge: boolean | null;
  /** 顔参照(現行は PuLID)。 */
  identityReference: boolean | null;
  /** LoRA 等の絵柄スタイル。 */
  styles: boolean | null;
  transparentOutput: boolean | null;
  /** ページ一発生成(将来)。 */
  pageGeneration: boolean | null;
}

export interface ProviderCapabilities {
  providerId: string;
  displayName: string;
  modelFamily: string;
  features: ProviderFeatureFlags;
  checkedAt: string;
}

export interface ProviderValidation {
  ok: boolean;
  issues: string[];
}

/** submit() に渡す、ラウンド内 1 ジョブぶんの投入内容。 */
export interface ProviderJobSubmission {
  batchIndex: number;
  /** モデル中立の Intent(再現性・将来 provider 用。intent_json に相当する形)。 */
  intent: GenerationIntent;
  /**
   * この Provider が実際の生成に使う、正規化済み GenerationRequest 本体(batchSize=1、seed 確定済み)。
   * GenerationRequest は当面クライアント wire 型として維持されるため(Docs/Feature-ScriptToManga.md S1)、
   * Comfy 実行時の完全な忠実性(maskWidth/maskHeight 等 Intent に写像されない詳細を含む)はこちらを直接使う。
   */
  request: GenerationRequest;
  seed: number | null;
}

export interface ProviderSubmitContext {
  projectId: string;
  roundId: string;
  roundIndex: number;
  templateId: string;
  /** requiresParentAsset なモードで pasteComposite が無い場合に使う親アセットの画像パス。 */
  parentAssetImagePath: string | null;
  jobs: ProviderJobSubmission[];
}

/** submit() が返す、投入 1 ジョブぶんの結果。 */
export interface ProviderSubmittedJob {
  /** 不透明なジョブ参照(Comfy: prompt_id)。`generation_jobs.prompt_id` へ保存する。 */
  jobRef: string;
  /** provider ネイティブの送信内容(Comfy: パッチ済み workflow)。先頭ジョブ分を
   *  `generation_rounds.patched_workflow_json` へ保存する。 */
  nativeSubmission: unknown;
  seed: number | null;
  /** 進捗監視のための不透明な購読識別子(Comfy: WebSocket clientId)。
   *  `generation_jobs.client_id`(既存列、リネームなし)へそのまま保存する。省略時は jobRef を使う。 */
  watchRef?: string | null;
}

export interface ProviderCollectContext {
  projectId: string;
  roundId: string;
  /** テンプレートの role_map(selectFinalImages 相当の出力ノード選定に使う)。 */
  roleMap: Record<string, unknown> | null;
  /** 出力ノード選定に使うワークフロー(patched_workflow_json があればそれ、無ければテンプレの workflow_json)。 */
  workflow: Record<string, unknown> | null;
}

export interface ProviderCollectedImage {
  bytes: Buffer;
  filename: string;
  /** provider ネイティブの出力ノード/生成元参照(Comfy: history 上の nodeId)。
   *  `assets.comfy_output_node_id` へそのまま保存する。 */
  outputNodeId: string | null;
}

export interface ProviderInterruptResult {
  /** 現在実行中のジョブへの中断要求(provider 全体で 1 回、ジョブ非特定)を送れたか。 */
  interruptedRunning: boolean;
  /** provider 側で「現在実行中」と確認できた jobRef(queue 照合結果)。 */
  runningJobRefs: string[];
  /** 実行中ジョブの確認(queue 取得)に失敗した場合のエラーメッセージ。 */
  queueError: string | null;
  /** 未実行ジョブのキューからの削除(取消)に失敗した場合のエラーメッセージ。 */
  deleteError: string | null;
  /** 中断要求自体が失敗した場合のエラーメッセージ。 */
  interruptError: string | null;
}

/** watchProgress が rounds.ts へ返せるジョブ状態(DB へ直接書くもの/collect を促すだけのものが混在)。 */
export type ProviderJobEventStatus = "running" | "collectable" | "interrupted" | "failed";

export interface ProviderWatchContext {
  roundId: string;
  /** ジョブの状態変化通知。"collectable" は DB を書かず、rounds.ts 側に collect の実行だけを促す
   *  (Comfy の `executed`/`execution_success` 相当: 出力が揃ったが assets へはまだ保存していない)。 */
  onJobUpdate(jobRef: string, status: ProviderJobEventStatus, error?: unknown): void;
  onProgress(value: number, max: number): void;
}

export interface GenerationProvider {
  readonly id: string;
  getCapabilities(): Promise<ProviderCapabilities>;
  /** Intent がこの provider で実行可能かの事前検証(不足 capability を issues で返す)。 */
  validateIntent(intent: GenerationIntent): Promise<ProviderValidation>;
  /** ラウンド内の全ジョブをまとめて投入。戻り値は `ctx.jobs` と同じ順序(呼び出し側は index で対応付ける)。 */
  submit(ctx: ProviderSubmitContext): Promise<ProviderSubmittedJob[]>;
  /** jobRef の成果画像を取得(未完なら空配列)。Comfy: /history → /view。 */
  collectImages(jobRef: string, ctx: ProviderCollectContext): Promise<ProviderCollectedImage[]>;
  /**
   * 実行中/待機中ジョブの中断。`hasLocallyRunningJob` は呼び出し側(rounds.ts)が DB 上の
   * ジョブ状態から把握している「実行中と思われるジョブがある」ヒント(provider 側の queue 照合と
   * 食い違う場合に安全側へ倒すため)。
   */
  interrupt(jobRefs: string[], hasLocallyRunningJob: boolean): Promise<ProviderInterruptResult>;
  /** 進捗監視の開始(任意実装。Comfy: WebSocket)。同一 roundId への重複呼び出しは no-op。 */
  watchProgress?(ctx: ProviderWatchContext): void;
  /** 進捗監視の停止(任意実装)。 */
  stopWatch?(roundId: string): void;
}
