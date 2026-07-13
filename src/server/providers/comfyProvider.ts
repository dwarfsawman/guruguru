import { createId, getRow } from "../db";
import {
  deleteQueuedPrompts,
  ensureDummyComfyImage,
  fetchViewImage,
  getComfyStatus,
  getHistory,
  getQueue,
  interruptComfy,
  openComfyWebSocket,
  queuePrompt,
  uploadImageToComfy
} from "../comfy";
import { isUnifiedSwitchWorkflow, patchWorkflow, type FeatureAvailabilityFlags } from "../workflow";
import { resolveFeatureAvailability } from "../modelCheck";
import { detectWorkflowModelFamily } from "../../shared/workflowModels";
import { requiresParentAsset } from "../../shared/generationMode";
import { isJsonObject } from "../validate";
import { nodeIdFromRolePath } from "../../shared/workflowRolePath";
import type { GenerationIntent } from "../../shared/generationIntent";
import type {
  GenerationProvider,
  ProviderCapabilities,
  ProviderCollectContext,
  ProviderCollectedImage,
  ProviderInterruptResult,
  ProviderJobStatus,
  ProviderSubmitContext,
  ProviderSubmittedJob,
  ProviderValidation,
  ProviderWatchContext
} from "./types";

export type HistoryImage = { nodeId: string; filename: string; subfolder?: string; type?: string };

/** comfy の providerOptions として許可されるキー(S1 v2: providerOptions の規律)。 */
interface ComfyProviderOptions {
  generationMode?: string;
  templateId?: string;
}

/**
 * `intent.providerOptions.comfy` を正規化する。汎用オーケストレータ(rounds.ts)はこの中身を
 * 一切読まないため、未知キーの除去や型の取り違えはここ(Provider 境界)だけの責務になる
 * (Docs/Feature-ScriptToManga.md S1「providerOptions の規律」)。
 */
export function normalizeComfyProviderOptions(raw: unknown): ComfyProviderOptions {
  if (!isJsonObject(raw)) {
    return {};
  }
  const normalized: ComfyProviderOptions = {};
  if (typeof raw.generationMode === "string") {
    normalized.generationMode = raw.generationMode;
  }
  if (typeof raw.templateId === "string") {
    normalized.templateId = raw.templateId;
  }
  return normalized;
}

/**
 * recipe(workflow_templates.id + version)単位で能力を解決する(S1 v2: `resolveCapabilities(recipe)`)。
 * テンプレートJSONからモデルファミリーを判定し、対応するidentity機能の可用性を返す。
 */
async function resolveCapabilities(recipe: { recipeId: string; revision?: string }): Promise<ProviderCapabilities> {
  const template = getRow<{ workflow_json: string }>(
    "SELECT workflow_json FROM workflow_templates WHERE id = ? AND deleted_at IS NULL",
    [recipe.recipeId]
  );
  let modelFamily: "chroma" | "anima" = "chroma";
  if (template) {
    try {
      modelFamily = detectWorkflowModelFamily(JSON.parse(template.workflow_json));
    } catch {
      // Invalid workflow JSON is reported by submit; capability resolution remains conservative.
    }
  }
  const checkedAt = new Date().toISOString();
  const status = await getComfyStatus();
  if (!status.ok) {
    return {
      providerId: "comfy",
      displayName: "ComfyUI",
      modelFamily,
      features: {
        transform: null,
        inpaint: null,
        controlPose: null,
        controlEdge: null,
        identityReference: null,
        styles: null,
        pageGeneration: false
      },
      alpha: "none",
      seed: "reproducible",
      checkedAt
    };
  }

  const availability = await resolveFeatureAvailability(modelFamily);
  return {
    providerId: "comfy",
    displayName: "ComfyUI",
    modelFamily,
    features: {
      transform: true,
      inpaint: true,
      controlPose: availability.controlnet,
      controlEdge: null,
      identityReference: modelFamily === "anima" ? availability.animaInContext : availability.pulid,
      styles: true,
      pageGeneration: false
    },
    alpha: "none",
    seed: "reproducible",
    checkedAt
  };
}

/**
 * 事前検証。実際の実行可否ゲート(featureAvailability によるフラグメント剪定等)は
 * submit() 側(patchWorkflow/patchUnifiedSwitchWorkflow)に既存のまま残る。ここでは
 * ComfyProvider が構造的にサポートしない Intent 形状と、providerOptions.comfy の形を検証する。
 */
async function validateIntent(intent: GenerationIntent): Promise<ProviderValidation> {
  const issues: string[] = [];
  if (intent.batchCount < 1 || intent.batchCount > 32) {
    issues.push("batchCount must be between 1 and 32");
  }
  if (intent.canvas.width <= 0 || intent.canvas.height <= 0) {
    issues.push("canvas dimensions must be positive");
  }
  if (intent.control?.some((control) => control.kind === "edge")) {
    issues.push("edge control is not supported by the comfy provider yet");
  }
  if (intent.output?.alpha === "required") {
    issues.push("alpha output is not supported by the comfy provider yet");
  }
  const providerOptions = isJsonObject(intent.providerOptions) ? intent.providerOptions : {};
  const normalizedComfyOptions = normalizeComfyProviderOptions(providerOptions.comfy);
  if (!normalizedComfyOptions.templateId) {
    issues.push("providerOptions.comfy.templateId is required");
  }
  return { ok: issues.length === 0, issues };
}

async function submit(ctx: ProviderSubmitContext): Promise<ProviderSubmittedJob[]> {
  if (ctx.jobs.length === 0) {
    return [];
  }

  const template = getRow<Record<string, unknown>>(
    "SELECT * FROM workflow_templates WHERE id = ? AND deleted_at IS NULL",
    [ctx.templateId]
  );
  if (!template) {
    throw new Error("WorkflowTemplate was not found");
  }
  const workflow = JSON.parse(String(template.workflow_json));
  const roleMap = JSON.parse(String(template.role_map_json));

  // 全ジョブは同じラウンドの添付(貼り付け合成/マスク/ポーズ/参照画像)を共有する
  // (requestForBatchJob は batchSize/seed のみを差し替える)。アップロードは 1 回で済ませ、
  // ジョブごとに再アップロードしない。
  const firstRequest = ctx.jobs[0]!.request;
  const uploaded = firstRequest.pasteComposite?.compositePath && requiresParentAsset(firstRequest.generationMode)
    ? await uploadImageToComfy(firstRequest.pasteComposite.compositePath)
    : ctx.parentAssetImagePath && requiresParentAsset(firstRequest.generationMode)
      ? await uploadImageToComfy(ctx.parentAssetImagePath)
      : null;
  const uploadedMask = firstRequest.inpaint?.maskPath
    ? await uploadImageToComfy(firstRequest.inpaint.maskPath)
    : null;
  const uploadedControlImage = firstRequest.controlnet?.poseImagePath
    ? await uploadImageToComfy(firstRequest.controlnet.poseImagePath)
    : null;
  const uploadedReferenceImage = firstRequest.reference?.imagePath
    ? await uploadImageToComfy(firstRequest.reference.imagePath)
    : null;

  // Unified-switch templates keep every branch's LoadImage nodes in the graph; unused image
  // inputs are pointed at a pre-uploaded 1px dummy so ComfyUI's graph-wide filename validation
  // passes (lazy evaluation never actually reads it).
  const isUnifiedSwitch = isUnifiedSwitchWorkflow(workflow);
  const dummyImageName = isUnifiedSwitch ? await ensureDummyComfyImage() : null;
  const featureAvailability: FeatureAvailabilityFlags | null = isUnifiedSwitch
    ? await resolveFeatureAvailability(detectWorkflowModelFamily(workflow))
    : null;

  const clientId = createId("comfy_client");
  const queuedPromptIds: string[] = [];
  const submitted: ProviderSubmittedJob[] = [];
  try {
    for (const job of ctx.jobs) {
      const patchedWorkflow = patchWorkflow(workflow, roleMap, {
        projectId: ctx.projectId,
        roundIndex: ctx.roundIndex,
        batchIndex: job.batchIndex,
        request: job.request,
        uploadedImageName: uploaded?.name ?? null,
        uploadedMaskName: uploadedMask?.name ?? null,
        uploadedControlImageName: uploadedControlImage?.name ?? null,
        uploadedReferenceImageName: uploadedReferenceImage?.name ?? null,
        featureAvailability,
        dummyImageName
      });

      const promptId = await queuePrompt(patchedWorkflow, clientId);
      queuedPromptIds.push(promptId);
      submitted.push({ jobRef: promptId, nativeSubmission: patchedWorkflow, seed: job.seed, watchRef: clientId });
    }
    return submitted;
  } catch (error) {
    try {
      await deleteQueuedPrompts(queuedPromptIds);
    } catch {
      // The original queuing error is more useful for the caller.
    }
    throw error;
  }
}

async function collectImages(jobRef: string, ctx: ProviderCollectContext): Promise<ProviderCollectedImage[]> {
  let images: HistoryImage[];
  try {
    const history = await getHistory(jobRef);
    const entry = extractHistoryEntry(history, jobRef);
    images = selectFinalImages(extractImages(entry), ctx.roleMap, ctx.workflow);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      return [];
    }
    throw error;
  }

  const collected: ProviderCollectedImage[] = [];
  for (const image of images) {
    collected.push({
      bytes: await fetchViewImage(image),
      filename: image.filename,
      outputNodeId: image.nodeId
    });
  }
  return collected;
}

/**
 * ポーリングフォールバック(S1 v2 修正一覧 #7): history に完了エントリがあれば completed(status_str
 * が "error" なら failed)、無ければ queue と照合して running/pending、どちらの手がかりも得られなければ
 * unknown を返す薄い実装。watch(WebSocket)が張れない/切れた場合のみ呼ばれる想定。
 */
async function getStatus(jobRef: string): Promise<ProviderJobStatus> {
  try {
    const history = await getHistory(jobRef);
    const entry = extractHistoryEntry(history, jobRef);
    if (entry && typeof entry === "object") {
      const status = (entry as { status?: unknown }).status;
      const statusStr = isJsonObject(status) ? status.status_str : undefined;
      return statusStr === "error" ? "failed" : "completed";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("404")) {
      return "unknown";
    }
  }

  try {
    const queue = await getQueue();
    const jobRefSet = new Set([jobRef]);
    if (promptIdsInQueueSections(queue, ["queue_running", "currently_running", "running"], jobRefSet).length > 0) {
      return "running";
    }
    if (promptIdsInQueueSections(queue, ["queue_pending", "pending"], jobRefSet).length > 0) {
      return "pending";
    }
  } catch {
    // queue も取得できない: unknown へフォールスルー。
  }

  return "unknown";
}

async function interrupt(jobRefs: string[], hasLocallyRunningJob: boolean): Promise<ProviderInterruptResult> {
  if (jobRefs.length === 0) {
    return { interruptedRunning: false, runningJobRefs: [], queueError: null, deleteError: null, interruptError: null };
  }

  let queue: unknown = null;
  let queueError: string | null = null;
  try {
    queue = await getQueue();
  } catch (error) {
    queueError = error instanceof Error ? error.message : String(error);
  }

  const jobRefSet = new Set(jobRefs);
  const runningJobRefs = promptIdsInQueueSections(queue, ["queue_running", "currently_running", "running"], jobRefSet);
  const shouldInterruptRunning = runningJobRefs.length > 0 || hasLocallyRunningJob;

  let interruptError: string | null = null;
  let interruptedRunning = false;
  if (shouldInterruptRunning) {
    try {
      await interruptComfy();
      interruptedRunning = true;
    } catch (error) {
      interruptError = error instanceof Error ? error.message : String(error);
    }
  }

  let deleteError: string | null = null;
  try {
    await deleteQueuedPrompts(jobRefs);
  } catch (error) {
    deleteError = error instanceof Error ? error.message : String(error);
  }

  return { interruptedRunning, runningJobRefs, queueError, deleteError, interruptError };
}

// roundId -> 監視中の WebSocket。ensureRoundMonitor の重複起動防止 + stopWatch での close 用
// (以前は rounds.ts の activeRoundMonitors がこれを担っていた)。
const activeSockets = new Map<string, WebSocket>();

function watchProgress(ctx: ProviderWatchContext): void {
  if (activeSockets.has(ctx.roundId)) {
    return;
  }
  const job = getRow<{ client_id: string }>(
    `SELECT client_id
     FROM generation_jobs
     WHERE round_id = ? AND prompt_id IS NOT NULL AND status IN ('pending', 'queued', 'running')
     ORDER BY batch_index ASC
     LIMIT 1`,
    [ctx.roundId]
  );
  if (!job?.client_id) {
    return;
  }

  let socket: WebSocket;
  try {
    socket = openComfyWebSocket(job.client_id);
  } catch (error) {
    console.warn(`Failed to open ComfyUI WebSocket for round ${ctx.roundId}:`, error);
    return;
  }

  activeSockets.set(ctx.roundId, socket);
  socket.addEventListener("message", (event) => {
    void handleSocketMessage(ctx, event.data);
  });
  socket.addEventListener("close", () => {
    if (activeSockets.get(ctx.roundId) === socket) {
      activeSockets.delete(ctx.roundId);
    }
  });
  socket.addEventListener("error", (event) => {
    console.warn(`ComfyUI WebSocket error for round ${ctx.roundId}:`, event);
  });
}

function stopWatch(roundId: string): void {
  const socket = activeSockets.get(roundId);
  if (!socket) {
    return;
  }
  activeSockets.delete(roundId);
  try {
    socket.close();
  } catch {
    // Ignore close failures; polling collection remains the fallback.
  }
}

async function handleSocketMessage(ctx: ProviderWatchContext, rawData: unknown) {
  if (typeof rawData !== "string") {
    return;
  }

  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawData);
    if (!isJsonObject(parsed)) {
      return;
    }
    message = parsed;
  } catch {
    return;
  }

  const type = typeof message.type === "string" ? message.type : "";
  const data = isJsonObject(message.data) ? message.data : {};
  const promptId = typeof data.prompt_id === "string" ? data.prompt_id : null;
  if (!promptId) {
    return;
  }

  if (type === "execution_start" || (type === "executing" && data.node !== null)) {
    ctx.onJobUpdate(promptId, "running");
    return;
  }

  if (type === "progress") {
    const value = Number(data.value);
    const max = Number(data.max);
    if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
      ctx.onProgress(value, max);
    }
    return;
  }

  if (type === "executed" || type === "execution_success" || (type === "executing" && data.node === null)) {
    ctx.onJobUpdate(promptId, "collectable");
    return;
  }

  if (type === "execution_interrupted") {
    ctx.onJobUpdate(promptId, "interrupted");
    return;
  }

  if (type === "execution_error") {
    ctx.onJobUpdate(promptId, "failed", data);
  }
}

function promptIdsInQueueSections(queue: unknown, sectionNames: string[], promptIds: Set<string>) {
  const found = new Set<string>();
  if (!queue || typeof queue !== "object") {
    return [];
  }
  for (const [key, value] of Object.entries(queue as Record<string, unknown>)) {
    if (sectionNames.includes(key)) {
      collectPromptIds(value, promptIds, found);
    }
  }
  return [...found];
}

function collectPromptIds(value: unknown, promptIds: Set<string>, found: Set<string>) {
  if (typeof value === "string") {
    if (promptIds.has(value)) {
      found.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPromptIds(item, promptIds, found);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectPromptIds(item, promptIds, found);
    }
  }
}

// history パース(collectImages と、rounds.ts の legacy 経路 collectLegacyRound の双方から使う。
// TODO(S1 フォローアップ): legacy 経路も provider.collectImages に統一できるが、404 時の挙動
// (legacy は投げっぱなし、collectImages は空配列で握りつぶす)が異なるため挙動保持を優先して
// 今回はここから re-export するだけに留める。Docs/Feature-ScriptToManga.md S1 参照)。

export function extractHistoryEntry(history: unknown, promptId: string) {
  if (history && typeof history === "object" && promptId in history) {
    return (history as Record<string, unknown>)[promptId];
  }
  return history;
}

export function extractImages(entry: unknown): HistoryImage[] {
  const output = entry && typeof entry === "object" ? (entry as Record<string, unknown>).outputs : null;
  if (!output || typeof output !== "object") {
    return [];
  }

  const images: HistoryImage[] = [];
  for (const [nodeId, nodeOutput] of Object.entries(output as Record<string, unknown>)) {
    if (!nodeOutput || typeof nodeOutput !== "object") {
      continue;
    }
    const rawImages = (nodeOutput as { images?: unknown }).images;
    if (!Array.isArray(rawImages)) {
      continue;
    }

    for (const raw of rawImages) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const image = raw as Record<string, unknown>;
      if (typeof image.filename !== "string") {
        continue;
      }
      images.push({
        nodeId,
        filename: image.filename,
        subfolder: typeof image.subfolder === "string" ? image.subfolder : undefined,
        type: typeof image.type === "string" ? image.type : "output"
      });
    }
  }

  return images;
}

export function selectFinalImages(
  images: HistoryImage[],
  roleMap: Record<string, unknown> | null,
  workflow: Record<string, unknown> | null
): HistoryImage[] {
  if (images.length <= 1) {
    return images;
  }

  const finalNodeIds = finalImageNodeIds(roleMap, workflow);
  const finalNodeImages = images.filter((image) => finalNodeIds.has(image.nodeId));
  if (finalNodeImages.length > 0) {
    return finalNodeImages;
  }

  const outputImages = images.filter((image) => (image.type ?? "output") === "output");
  if (outputImages.length > 0) {
    return outputImages;
  }

  const nonTempImages = images.filter((image) => image.type !== "temp");
  return nonTempImages.length > 0 ? nonTempImages : images;
}

function finalImageNodeIds(roleMap: Record<string, unknown> | null, workflow: Record<string, unknown> | null): Set<string> {
  const nodeIds = new Set<string>();
  addRoleNodeId(nodeIds, roleMap?.save_image_node);
  addRoleNodeId(nodeIds, nodeIdFromRolePath(roleMap?.save_prefix_input));

  if (!workflow) {
    return nodeIds;
  }

  for (const [nodeId, rawNode] of Object.entries(workflow)) {
    if (!isJsonObject(rawNode)) {
      continue;
    }
    const classType = typeof rawNode.class_type === "string" ? rawNode.class_type : "";
    if (isFinalImageOutputClass(classType)) {
      nodeIds.add(nodeId);
    }
  }

  return nodeIds;
}

function isFinalImageOutputClass(classType: string): boolean {
  const normalized = classType.replace(/[\s_-]+/g, "").toLowerCase();
  if (normalized.includes("preview")) {
    return false;
  }
  return normalized.includes("saveimage") || (normalized.includes("image") && normalized.includes("save"));
}

function addRoleNodeId(nodeIds: Set<string>, rawNodeId: unknown) {
  if (typeof rawNodeId === "string" && rawNodeId.trim()) {
    nodeIds.add(rawNodeId.trim());
  }
}

export const comfyProvider: GenerationProvider = {
  id: "comfy",
  resolveCapabilities,
  validateIntent,
  submit,
  getStatus,
  collectImages,
  interrupt,
  watchProgress,
  stopWatch
};
