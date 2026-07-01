import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createId, dataRoot, dbPath, getRow, getRows, initializeDb, runSql, setSetting, toApiRow, toApiRows } from "./db";
import {
  deleteQueuedPrompts,
  fetchViewImage,
  getComfyStatus,
  getHistory,
  getQueue,
  interruptComfy,
  openComfyWebSocket,
  queuePrompt,
  testComfyConnection,
  uploadImageToComfy
} from "./comfy";
import { readImageSize, storeImage, storeMaskImage } from "./storage";
import { serveStatic } from "./files";
import { clampInteger, maxBatchSize, normalizeGenerationRequest } from "./generationRequest";
import { HttpError, readJson, sendJson } from "./http";
import { isJsonObject, nonEmptyStringOr, numberOr, stringOrNull, stringOr } from "./validate";
import { patchWorkflow, resolveSeed } from "./workflow";
import { createTemplate, deleteTemplate, listTemplates } from "./templates";
import { decorateAsset, serveAssetFile, updateAssetStatus } from "./assets";
import { createProject, deleteProject, getProjectDetail, listProjects } from "./projects";
import { branchAssignmentForRound, nextRoundIndex } from "./roundBranches";
import { createSourceAsset } from "./sourceAssets";
import { decodeMaskDataUrl } from "./uploadDataUrl";
import { DEFAULT_WEB_SAM_MODEL_BASE_URL, GITHUB_WEB_SAM_RELEASE_API_URL } from "../shared/constants";
import {
  relationForGenerationMode,
  requiresParentAsset
} from "../shared/generationMode";
import { nodeIdFromRolePath } from "../shared/workflowRolePath";
import type { ComfySettings, GenerationMode, GenerationRequest, InpaintOptions, MaskedContent } from "../shared/types";

const port = Number(process.env.PORT ?? 5177);
let isShuttingDown = false;

type HistoryImage = { nodeId: string; filename: string; subfolder?: string; type?: string };
type GenerationJobStatus = "pending" | "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
type GenerationJob = {
  id: string;
  project_id: string;
  round_id: string;
  batch_index: number;
  prompt_id?: string | null;
  client_id: string;
  seed?: number | null;
  status: GenerationJobStatus;
  last_error_json?: string | null;
};
type CollectRoundResult = { statusCode: number; body: Record<string, unknown> };
type JobStats = {
  total: number;
  pending: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  interrupted: number;
  cancelled: number;
  active: number;
  terminal: number;
};

const terminalJobStatuses = new Set<GenerationJobStatus>(["completed", "failed", "interrupted", "cancelled"]);
const activeJobStatuses = new Set<GenerationJobStatus>(["pending", "queued", "running"]);
const terminalRoundStatuses = new Set(["completed", "failed", "interrupted"]);
const activeRoundMonitors = new Map<string, { socket: WebSocket; clientId: string }>();
const roundCollectionLocks = new Map<string, Promise<CollectRoundResult>>();
const webSamReleaseAssetNames = new Set(["slimsam-77-encoder.onnx", "slimsam-77-decoder.onnx"]);

initializeDb();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, error instanceof HttpError ? error.statusCode : 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, () => {
  console.log(`GURUGURU listening on http://127.0.0.1:${port}`);
  console.log(`Data directory: ${dataRoot}`);
  console.log(`Database path: ${dbPath}`);
  if (process.stdin.isTTY) {
    console.log("Press q or Ctrl+C to stop GURUGURU.");
  }
});

setupShutdownHandlers();

async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && path === "/api/settings/comfy") {
    const settings = getSettingOrDefault();
    sendJson(res, 200, settings);
    return;
  }

  if (method === "PUT" && path === "/api/settings/comfy") {
    const body = await readJson<Partial<ComfySettings>>(req);
    const currentSettings = getSettingOrDefault();
    const settings: ComfySettings = {
      ...currentSettings,
      baseUrl: stringOr(body.baseUrl, "http://127.0.0.1:8188"),
      websocketUrl: stringOr(body.websocketUrl, "ws://127.0.0.1:8188/ws"),
      timeoutSeconds: numberOr(body.timeoutSeconds, 60),
      imageFetchMode: "view",
      storageDir: dataRoot,
      webSamModelBaseUrl: nonEmptyStringOr(body.webSamModelBaseUrl, currentSettings.webSamModelBaseUrl)
    };
    setSetting("comfy", settings);
    sendJson(res, 200, settings);
    return;
  }

  if (method === "POST" && path === "/api/comfy/test") {
    sendJson(res, 200, await testComfyConnection());
    return;
  }

  if (method === "GET" && path === "/api/comfy/status") {
    sendJson(res, 200, await getComfyStatus());
    return;
  }

  const webSamModelMatch = path.match(/^\/api\/websam-models\/([^/]+)$/);
  if (method === "GET" && webSamModelMatch) {
    await serveWebSamReleaseAsset(res, webSamModelMatch[1]!);
    return;
  }

  if (method === "GET" && path === "/api/templates") {
    sendJson(res, 200, { templates: listTemplates() });
    return;
  }

  if (method === "POST" && path === "/api/templates") {
    sendJson(res, 201, { template: createTemplate(await readJson(req)) });
    return;
  }

  const templateDeleteMatch = path.match(/^\/api\/templates\/([^/]+)$/);
  if (method === "DELETE" && templateDeleteMatch) {
    sendJson(res, 200, deleteTemplate(templateDeleteMatch[1]!));
    return;
  }

  if (method === "GET" && path === "/api/projects") {
    sendJson(res, 200, { projects: listProjects() });
    return;
  }

  if (method === "POST" && path === "/api/projects") {
    sendJson(res, 201, { project: createProject(await readJson(req)) });
    return;
  }

  const projectDetailMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (method === "GET" && projectDetailMatch) {
    sendJson(res, 200, getProjectDetail(projectDetailMatch[1]!, { ensureRoundMonitor }));
    return;
  }

  if (method === "DELETE" && projectDetailMatch) {
    sendJson(res, 200, await deleteProject(projectDetailMatch[1]!));
    return;
  }

  const generateMatch = path.match(/^\/api\/projects\/([^/]+)\/rounds$/);
  if (method === "POST" && generateMatch) {
    sendJson(res, 201, await createGenerationRound(generateMatch[1]!, await readJson<GenerationRequest>(req)));
    return;
  }

  const sourceAssetMatch = path.match(/^\/api\/projects\/([^/]+)\/source-assets$/);
  if (method === "POST" && sourceAssetMatch) {
    sendJson(res, 201, await createSourceAsset(sourceAssetMatch[1]!, await readJson(req)));
    return;
  }

  const collectMatch = path.match(/^\/api\/rounds\/([^/]+)\/collect$/);
  if (method === "POST" && collectMatch) {
    const result = await collectRound(collectMatch[1]!);
    sendJson(res, result.statusCode, result.body);
    return;
  }

  const roundInterruptMatch = path.match(/^\/api\/rounds\/([^/]+)\/interrupt$/);
  if (method === "POST" && roundInterruptMatch) {
    sendJson(res, 200, await interruptRound(roundInterruptMatch[1]!));
    return;
  }

  const roundDeleteMatch = path.match(/^\/api\/rounds\/([^/]+)$/);
  if (method === "DELETE" && roundDeleteMatch) {
    sendJson(res, 200, deleteRoundTree(roundDeleteMatch[1]!));
    return;
  }

  const assetStatusMatch = path.match(/^\/api\/assets\/([^/]+)\/status$/);
  if (method === "POST" && assetStatusMatch) {
    sendJson(res, 200, updateAssetStatus(assetStatusMatch[1]!, await readJson(req)));
    return;
  }

  const assetImageMatch = path.match(/^\/api\/assets\/([^/]+)\/(image|thumbnail)$/);
  if (method === "GET" && assetImageMatch) {
    await serveAssetFile(res, assetImageMatch[1]!, assetImageMatch[2]!, url);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function getRoundForApi(roundId: string) {
  return toApiRow(
    getRow(
      `SELECT r.*,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id) AS asset_count,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id AND a.status = 'selected') AS selected_count,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id AND a.status = 'rejected') AS rejected_count
       FROM generation_rounds r
       WHERE r.id = ?`,
      [roundId]
    )
  );
}

async function createGenerationRound(projectId: string, requestBody: GenerationRequest) {
  const project = getRow<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }

  const template = getRow<Record<string, unknown>>("SELECT * FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [requestBody.templateId]);
  if (!template) {
    throw new HttpError(400, "WorkflowTemplate was not found");
  }

  const generationMode = (requestBody.generationMode ?? "txt2img") as GenerationMode;
  const requestedParentAssetId = generationMode === "txt2img" ? null : stringOrNull(requestBody.parentAssetId);
  const parentAsset = requestedParentAssetId
    ? getRow<Record<string, unknown>>("SELECT * FROM assets WHERE id = ? AND project_id = ?", [requestedParentAssetId, projectId])
    : null;

  if (requestedParentAssetId && !parentAsset) {
    throw new HttpError(400, "Parent Asset was not found in this Project");
  }
  if (requiresParentAsset(generationMode) && !parentAsset) {
    throw new HttpError(400, `${generationMode} generation requires a parent Asset`);
  }

  const roundIndex = nextRoundIndex(projectId);
  const roundId = createId("round");
  const parentRoundId = typeof parentAsset?.round_id === "string" ? parentAsset.round_id : null;
  const seed = resolveSeed(requestBody, typeof parentAsset?.seed === "number" ? parentAsset.seed : null);
  let request: GenerationRequest = normalizeGenerationRequest({ ...requestBody, generationMode, parentAssetId: requestedParentAssetId, seed });
  request = await prepareInpaintRequest(projectId, roundId, parentAsset, requestBody, request);
  const branch = branchAssignmentForRound(projectId, parentAsset, roundId, "txt2img_root");

  runSql(
    `INSERT INTO generation_rounds
      (id, project_id, template_id, parent_round_id, round_index, status, generation_mode,
       branch_color_index, branch_reason, branch_key, request_json)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      roundId,
      projectId,
      request.templateId,
      parentRoundId,
      roundIndex,
      request.generationMode,
      branch.colorIndex,
      branch.reason,
      branch.key,
      JSON.stringify(request)
    ]
  );

  const queuedPromptIds: string[] = [];
  try {
    const workflow = JSON.parse(String(template.workflow_json));
    const roleMap = JSON.parse(String(template.role_map_json));
    const uploaded = parentAsset && requiresParentAsset(request.generationMode)
      ? await uploadImageToComfy(String(parentAsset.image_path))
      : null;
    const uploadedMask = request.inpaint?.maskPath
      ? await uploadImageToComfy(request.inpaint.maskPath)
      : null;
    const clientId = createId("comfy_client");
    const jobCount = clampInteger(request.batchSize, 1, maxBatchSize);
    const firstSeed = typeof request.seed === "number" ? request.seed : resolveSeed(request, typeof parentAsset?.seed === "number" ? parentAsset.seed : null);
    request = {
      ...request,
      batchSize: jobCount,
      seed: firstSeed
    };
    runSql("UPDATE generation_rounds SET request_json = ? WHERE id = ?", [JSON.stringify(request), roundId]);

    runSql(
      "UPDATE generation_rounds SET status = 'running' WHERE id = ?",
      [roundId]
    );

    let firstPromptId: string | null = null;
    let firstPatchedWorkflow: unknown = null;
    for (let batchIndex = 0; batchIndex < jobCount; batchIndex += 1) {
      const jobId = createId("job");
      const jobRequest = requestForBatchJob(request, batchIndex);
      const patchedWorkflow = patchWorkflow(workflow, roleMap, {
        projectId,
        roundIndex,
        batchIndex,
        request: jobRequest,
        uploadedImageName: uploaded?.name ?? null,
        uploadedMaskName: uploadedMask?.name ?? null
      });

      if (!firstPatchedWorkflow) {
        firstPatchedWorkflow = patchedWorkflow;
      }

      runSql(
        `INSERT INTO generation_jobs
          (id, project_id, round_id, batch_index, client_id, seed, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [jobId, projectId, roundId, batchIndex, clientId, jobRequest.seed]
      );

      const promptId = await queuePrompt(patchedWorkflow, clientId);
      queuedPromptIds.push(promptId);
      if (!firstPromptId) {
        firstPromptId = promptId;
      }
      runSql(
        "UPDATE generation_jobs SET prompt_id = ?, status = 'queued', queued_at = CURRENT_TIMESTAMP WHERE id = ?",
        [promptId, jobId]
      );
      if (batchIndex === 0) {
        ensureRoundMonitor(roundId);
      }
    }

    runSql(
      "UPDATE generation_rounds SET prompt_id = ?, patched_workflow_json = ?, status = 'running' WHERE id = ?",
      [firstPromptId, JSON.stringify(firstPatchedWorkflow), roundId]
    );
    ensureRoundMonitor(roundId);

    return {
      round: toApiRow(getRow("SELECT * FROM generation_rounds WHERE id = ?", [roundId])),
      promptId: firstPromptId
    };
  } catch (error) {
    runSql(
      "UPDATE generation_rounds SET status = 'failed', last_error_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [JSON.stringify(errorToJson(error)), roundId]
    );
    runSql(
      "UPDATE generation_jobs SET status = 'failed', last_error_json = ?, completed_at = CURRENT_TIMESTAMP WHERE round_id = ? AND status IN ('pending', 'queued', 'running')",
      [JSON.stringify(errorToJson(error)), roundId]
    );
    try {
      await deleteQueuedPrompts(queuedPromptIds);
    } catch {
      // The original queuing error is more useful for the caller.
    }
    throw error;
  }
}

async function prepareInpaintRequest(
  projectId: string,
  roundId: string,
  parentAsset: Record<string, unknown> | null,
  rawRequest: GenerationRequest,
  normalizedRequest: GenerationRequest
): Promise<GenerationRequest> {
  const rawInpaint = isJsonObject((rawRequest as Record<string, unknown>).inpaint)
    ? (rawRequest as Record<string, unknown>).inpaint as Record<string, unknown>
    : null;
  const hasMaskDataUrl = typeof rawInpaint?.maskDataUrl === "string" && rawInpaint.maskDataUrl.trim() !== "";

  if (!hasMaskDataUrl) {
    return {
      ...normalizedRequest,
      inpaint: null
    };
  }

  if (normalizedRequest.generationMode !== "img2img") {
    throw new HttpError(400, "Inpaint masks are supported only for img2img generation.");
  }
  if (!parentAsset) {
    throw new HttpError(400, "Inpaint generation requires a parent Asset.");
  }

  const mask = decodeMaskDataUrl(rawInpaint.maskDataUrl);
  const maskSize = readImageSize(mask.bytes);
  if (!maskSize) {
    throw new HttpError(400, "Mask PNG dimensions could not be read.");
  }

  const parentSize = await parentAssetDimensions(parentAsset);
  if (!parentSize) {
    throw new HttpError(400, "Parent Asset dimensions could not be read.");
  }
  if (maskSize.width !== parentSize.width || maskSize.height !== parentSize.height) {
    throw new HttpError(
      400,
      `Mask size ${maskSize.width}x${maskSize.height} does not match parent image size ${parentSize.width}x${parentSize.height}.`
    );
  }

  const options = normalizeInpaintOptions(rawInpaint);
  const storedMask = await storeMaskImage(projectId, roundId, mask.bytes);

  return {
    ...normalizedRequest,
    inpaint: {
      ...options,
      maskPath: storedMask.maskPath,
      maskWidth: storedMask.width,
      maskHeight: storedMask.height
    }
  };
}

function normalizeInpaintOptions(rawInpaint: Record<string, unknown>): InpaintOptions {
  const maskedContent = normalizeMaskedContent(rawInpaint.maskedContent ?? rawInpaint.masked_content);
  const inpaintArea = stringOr(rawInpaint.inpaintArea ?? rawInpaint.inpaint_area, "only_masked");
  if (inpaintArea !== "only_masked") {
    throw new HttpError(400, "Only inpaintArea='only_masked' is supported.");
  }

  return {
    maskedContent,
    inpaintArea: "only_masked",
    onlyMaskedPadding: clampInteger(numberOr(rawInpaint.onlyMaskedPadding ?? rawInpaint.only_masked_padding, 32), 0, 512),
    maskDataUrl: null
  };
}

function normalizeMaskedContent(value: unknown): MaskedContent {
  const maskedContent = stringOr(value, "original");
  if (maskedContent === "fill" || maskedContent === "original" || maskedContent === "latent_noise" || maskedContent === "latent_nothing") {
    return maskedContent;
  }
  throw new HttpError(400, "Unsupported maskedContent value.");
}

async function parentAssetDimensions(parentAsset: Record<string, unknown>): Promise<{ width: number; height: number } | null> {
  const width = typeof parentAsset.width === "number" && Number.isFinite(parentAsset.width) ? Math.trunc(parentAsset.width) : null;
  const height = typeof parentAsset.height === "number" && Number.isFinite(parentAsset.height) ? Math.trunc(parentAsset.height) : null;
  if (width && height) {
    return { width, height };
  }

  const imagePath = typeof parentAsset.image_path === "string" ? parentAsset.image_path : "";
  if (!imagePath) {
    return null;
  }
  const size = readImageSize(await readFile(imagePath));
  return size ? { width: size.width, height: size.height } : null;
}

async function collectRound(roundId: string): Promise<CollectRoundResult> {
  const existingLock = roundCollectionLocks.get(roundId);
  if (existingLock) {
    return existingLock;
  }

  const lock = collectRoundUnlocked(roundId).finally(() => {
    roundCollectionLocks.delete(roundId);
  });
  roundCollectionLocks.set(roundId, lock);
  return lock;
}

async function collectRoundUnlocked(roundId: string): Promise<CollectRoundResult> {
  const round = getRow<Record<string, unknown>>("SELECT * FROM generation_rounds WHERE id = ?", [roundId]);
  if (!round) {
    throw new HttpError(404, "Round was not found");
  }

  const jobs = getGenerationJobs(roundId);
  if (jobs.length === 0) {
    return collectLegacyRound(round);
  }

  const template = getRow<Record<string, unknown>>("SELECT * FROM workflow_templates WHERE id = ?", [round.template_id]);
  if (!template) {
    throw new HttpError(500, "Round template was not found");
  }

  const request = JSON.parse(String(round.request_json)) as GenerationRequest;
  const roleMap = parseStoredJsonObject(template.role_map_json);
  const workflowForOutputSelection =
    parseStoredJsonObject(round.patched_workflow_json) ?? parseStoredJsonObject(template.workflow_json);
  const createdAssets: Record<string, unknown>[] = [];

  for (const job of jobs) {
    if (!job.prompt_id || job.status === "cancelled" || job.status === "failed") {
      continue;
    }
    if (hasAssetsForPrompt(roundId, job.prompt_id)) {
      if (job.status !== "completed") {
        runSql(
          "UPDATE generation_jobs SET status = 'completed', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ?",
          [job.id]
        );
      }
      continue;
    }

    const images = await historyImagesForPrompt(job.prompt_id, roleMap, workflowForOutputSelection);
    if (images.length === 0) {
      continue;
    }

    for (const image of images) {
      const asset = await storeGeneratedAsset({
        round,
        template,
        request,
        image,
        promptId: job.prompt_id ?? null,
        seed: typeof job.seed === "number" ? job.seed : request.seed
      });
      createdAssets.push(asset);
    }
    runSql(
      "UPDATE generation_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [job.id]
    );
  }

  const updatedRound = updateRoundStatusFromJobs(roundId);
  const stats = jobStats(roundId);
  const isTerminal = typeof updatedRound.status === "string" && terminalRoundStatuses.has(updatedRound.status);
  if (!isTerminal && stats.active > 0) {
    ensureRoundMonitor(roundId);
  }

  if (createdAssets.length > 0) {
    runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [round.project_id]);
  }

  return {
    statusCode: isTerminal ? 200 : 202,
    body: {
      round: getRoundForApi(String(updatedRound.id)),
      assets: createdAssets,
      jobStats: stats,
      message: createdAssets.length > 0
        ? `${createdAssets.length} generated image(s) were collected.`
        : "No new generated images are available yet."
    }
  };
}

async function collectLegacyRound(round: Record<string, unknown>): Promise<CollectRoundResult> {
  const roundId = String(round.id);
  const existingCount =
    getRow<{ count: number }>("SELECT COUNT(*) AS count FROM assets WHERE round_id = ?", [roundId])?.count ?? 0;
  if (existingCount > 0 && round.status === "completed") {
    return {
      statusCode: 200,
      body: {
        round: getRoundForApi(roundId),
        assets: toApiRows(getRows("SELECT * FROM assets WHERE round_id = ? ORDER BY batch_index ASC", [roundId])).map(decorateAsset)
      }
    };
  }

  if (typeof round.prompt_id !== "string" || round.prompt_id.length === 0) {
    throw new HttpError(400, "Round does not have a ComfyUI prompt_id yet");
  }

  const template = getRow<Record<string, unknown>>("SELECT * FROM workflow_templates WHERE id = ?", [round.template_id]);
  if (!template) {
    throw new HttpError(500, "Round template was not found");
  }

  const history = await getHistory(round.prompt_id);
  const entry = extractHistoryEntry(history, round.prompt_id);
  const roleMap = parseStoredJsonObject(template.role_map_json);
  const workflowForOutputSelection =
    parseStoredJsonObject(round.patched_workflow_json) ?? parseStoredJsonObject(template.workflow_json);
  const images = selectFinalImages(extractImages(entry), roleMap, workflowForOutputSelection);

  if (images.length === 0) {
    return {
      statusCode: 202,
      body: {
        round: getRoundForApi(roundId),
        message: "ComfyUI history is reachable, but no final output images are available yet."
      }
    };
  }

  const request = JSON.parse(String(round.request_json)) as GenerationRequest;
  const createdAssets: Record<string, unknown>[] = [];

  for (const image of images) {
    const asset = await storeGeneratedAsset({
      round,
      template,
      request,
      image,
      promptId: typeof round.prompt_id === "string" ? round.prompt_id : null,
      seed: request.seed
    });
    createdAssets.push(asset);
  }

  runSql(
    "UPDATE generation_rounds SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
    [roundId]
  );
  runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [round.project_id]);

  return {
    statusCode: 200,
    body: {
      round: getRoundForApi(roundId),
      assets: createdAssets
    }
  };
}

async function historyImagesForPrompt(
  promptId: string,
  roleMap: Record<string, unknown> | null,
  workflow: Record<string, unknown> | null
) {
  try {
    const history = await getHistory(promptId);
    const entry = extractHistoryEntry(history, promptId);
    return selectFinalImages(extractImages(entry), roleMap, workflow);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      return [];
    }
    throw error;
  }
}

async function storeGeneratedAsset({
  round,
  template,
  request,
  image,
  promptId,
  seed
}: {
  round: Record<string, unknown>;
  template: Record<string, unknown>;
  request: GenerationRequest;
  image: HistoryImage;
  promptId: string | null;
  seed: number | null;
}) {
  const roundId = String(round.id);
  const batchIndex = nextAssetBatchIndex(roundId);
  const bytes = await fetchViewImage(image);
  const stored = await storeImage(String(round.project_id), roundId, batchIndex, image.filename, bytes);
  const assetId = createId("asset");

  runSql(
    `INSERT INTO assets
      (id, project_id, round_id, prompt_id, batch_index, image_path, thumbnail_small_path, thumbnail_medium_path,
       width, height, prompt, negative_prompt, seed, sampler, scheduler, steps, cfg, denoise,
       workflow_template_id, workflow_template_version, workflow_snapshot_hash, comfy_output_node_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generated')`,
    [
      assetId,
      round.project_id,
      roundId,
      promptId,
      batchIndex,
      stored.imagePath,
      stored.thumbnailSmallPath,
      stored.thumbnailMediumPath,
      stored.width,
      stored.height,
      request.prompt,
      request.negativePrompt,
      seed,
      request.sampler,
      request.scheduler,
      request.steps,
      request.cfg,
      request.denoise,
      template.id,
      template.version,
      template.workflow_hash,
      image.nodeId
    ]
  );

  if (request.parentAssetId) {
    runSql(
      `INSERT INTO asset_parents (id, parent_asset_id, child_asset_id, relation_type, strength)
       VALUES (?, ?, ?, ?, ?)`,
      [
        createId("parent"),
        request.parentAssetId,
        assetId,
        request.relationType ?? relationForGenerationMode(request.generationMode),
        request.denoise
      ]
    );
  }

  return decorateAsset(toApiRow(getRow("SELECT * FROM assets WHERE id = ?", [assetId]))!);
}

function nextAssetBatchIndex(roundId: string) {
  return getRow<{ next_index: number }>(
    "SELECT COALESCE(MAX(batch_index), -1) + 1 AS next_index FROM assets WHERE round_id = ?",
    [roundId]
  )?.next_index ?? 0;
}

function hasAssetsForPrompt(roundId: string, promptId: string) {
  return (getRow<{ count: number }>(
    "SELECT COUNT(*) AS count FROM assets WHERE round_id = ? AND prompt_id = ?",
    [roundId, promptId]
  )?.count ?? 0) > 0;
}

function getGenerationJobs(roundId: string) {
  return getRows<GenerationJob>(
    "SELECT * FROM generation_jobs WHERE round_id = ? ORDER BY batch_index ASC",
    [roundId]
  );
}

function requestForBatchJob(request: GenerationRequest, batchIndex: number): GenerationRequest {
  return {
    ...request,
    batchSize: 1,
    seed: seedForBatchIndex(request.seed, batchIndex)
  };
}

function seedForBatchIndex(seed: number | null, batchIndex: number) {
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    return null;
  }
  const maxSeed = 2 ** 31 - 1;
  const normalized = Math.abs(Math.trunc(seed)) % maxSeed;
  return (normalized + batchIndex) % maxSeed;
}

function jobStats(roundId: string): JobStats {
  const stats: JobStats = {
    total: 0,
    pending: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    cancelled: 0,
    active: 0,
    terminal: 0
  };

  for (const row of getRows<{ status: GenerationJobStatus; count: number }>(
    "SELECT status, COUNT(*) AS count FROM generation_jobs WHERE round_id = ? GROUP BY status",
    [roundId]
  )) {
    const count = Number(row.count) || 0;
    stats.total += count;
    if (row.status in stats) {
      stats[row.status] = count;
    }
    if (activeJobStatuses.has(row.status)) {
      stats.active += count;
    }
    if (terminalJobStatuses.has(row.status)) {
      stats.terminal += count;
    }
  }

  return stats;
}

function updateRoundStatusFromJobs(roundId: string) {
  const round = getRow<Record<string, unknown>>("SELECT * FROM generation_rounds WHERE id = ?", [roundId]);
  if (!round) {
    throw new HttpError(404, "Round was not found");
  }

  const stats = jobStats(roundId);
  if (stats.total === 0) {
    return round;
  }

  let nextStatus = "running";
  if (stats.completed === stats.total) {
    nextStatus = "completed";
  } else if (stats.active === 0 && (stats.interrupted > 0 || stats.cancelled > 0)) {
    nextStatus = "interrupted";
  } else if (stats.active === 0 && stats.failed > 0) {
    nextStatus = "failed";
  } else if (round.status === "interrupted") {
    nextStatus = "interrupted";
  }

  const completedAtSql = terminalRoundStatuses.has(nextStatus)
    ? "completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)"
    : "completed_at = completed_at";
  runSql(
    `UPDATE generation_rounds SET status = ?, ${completedAtSql} WHERE id = ?`,
    [nextStatus, roundId]
  );
  if (terminalRoundStatuses.has(nextStatus)) {
    stopRoundMonitor(roundId);
  }
  return getRow<Record<string, unknown>>("SELECT * FROM generation_rounds WHERE id = ?", [roundId])!;
}

async function interruptRound(roundId: string) {
  const round = getRow<Record<string, unknown>>("SELECT * FROM generation_rounds WHERE id = ?", [roundId]);
  if (!round) {
    throw new HttpError(404, "Round was not found");
  }

  const jobs = getGenerationJobs(roundId);
  if (jobs.length === 0) {
    return interruptLegacyRound(round);
  }

  const activeJobs = jobs.filter((job) => activeJobStatuses.has(job.status));
  const activePromptIds = activeJobs
    .map((job) => job.prompt_id)
    .filter((promptId): promptId is string => typeof promptId === "string" && promptId.length > 0);
  if (activeJobs.length === 0) {
    return {
      round: toApiRow(updateRoundStatusFromJobs(roundId)),
      interrupted: false,
      deletedPromptIds: []
    };
  }

  let queue: unknown = null;
  let queueError: string | null = null;
  try {
    queue = await getQueue();
  } catch (error) {
    queueError = error instanceof Error ? error.message : String(error);
  }

  const activePromptSet = new Set(activePromptIds);
  const runningPromptIds = promptIdsInQueueSections(queue, ["queue_running", "currently_running", "running"], activePromptSet);
  const shouldInterruptRunning = runningPromptIds.length > 0 || activeJobs.some((job) => job.status === "running");
  let interruptError: string | null = null;
  let interrupted = false;
  if (shouldInterruptRunning) {
    try {
      await interruptComfy();
      interrupted = true;
    } catch (error) {
      interruptError = error instanceof Error ? error.message : String(error);
    }
  }

  let deleteError: string | null = null;
  try {
    await deleteQueuedPrompts(activePromptIds);
  } catch (error) {
    deleteError = error instanceof Error ? error.message : String(error);
  }

  const runningSet = new Set(runningPromptIds);
  for (const job of activeJobs) {
    const promptId = typeof job.prompt_id === "string" ? job.prompt_id : null;
    if (job.status === "running" && !interrupted) {
      continue;
    }
    if (job.status !== "running" && deleteError && promptId) {
      continue;
    }
    const status: GenerationJobStatus = interrupted && (job.status === "running" || (promptId && runningSet.has(promptId)))
      ? "interrupted"
      : "cancelled";
    runSql(
      "UPDATE generation_jobs SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [status, job.id]
    );
  }

  const updatedRound = updateRoundStatusFromJobs(roundId);

  return {
    round: toApiRow(updatedRound),
    interrupted,
    deletedPromptIds: activePromptIds,
    queueError,
    deleteError,
    interruptError,
    jobStats: jobStats(roundId)
  };
}

async function interruptLegacyRound(round: Record<string, unknown>) {
  const promptId = typeof round.prompt_id === "string" ? round.prompt_id : null;
  let interrupted = false;
  let deleteError: string | null = null;
  let interruptError: string | null = null;
  if (promptId) {
    try {
      await deleteQueuedPrompts([promptId]);
    } catch (error) {
      deleteError = error instanceof Error ? error.message : String(error);
    }
    try {
      await interruptComfy();
      interrupted = true;
    } catch (error) {
      interruptError = error instanceof Error ? error.message : String(error);
    }
  }
  runSql(
    "UPDATE generation_rounds SET status = 'interrupted', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ?",
    [round.id]
  );
  return {
    round: toApiRow(getRow("SELECT * FROM generation_rounds WHERE id = ?", [round.id])),
    interrupted,
    deletedPromptIds: promptId ? [promptId] : [],
    deleteError,
    interruptError
  };
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

function ensureRoundMonitor(roundId: string) {
  if (activeRoundMonitors.has(roundId)) {
    return;
  }
  const job = getRow<{ client_id: string }>(
    `SELECT client_id
     FROM generation_jobs
     WHERE round_id = ? AND prompt_id IS NOT NULL AND status IN ('pending', 'queued', 'running')
     ORDER BY batch_index ASC
     LIMIT 1`,
    [roundId]
  );
  if (!job?.client_id) {
    return;
  }

  let socket: WebSocket;
  try {
    socket = openComfyWebSocket(job.client_id);
  } catch (error) {
    console.warn(`Failed to open ComfyUI WebSocket for round ${roundId}:`, error);
    return;
  }

  activeRoundMonitors.set(roundId, { socket, clientId: job.client_id });
  socket.addEventListener("message", (event) => {
    void handleComfySocketMessage(roundId, event.data);
  });
  socket.addEventListener("close", () => {
    const current = activeRoundMonitors.get(roundId);
    if (current?.socket === socket) {
      activeRoundMonitors.delete(roundId);
    }
  });
  socket.addEventListener("error", (event) => {
    console.warn(`ComfyUI WebSocket error for round ${roundId}:`, event);
  });
}

async function handleComfySocketMessage(roundId: string, rawData: unknown) {
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

  const job = getRow<GenerationJob>(
    "SELECT * FROM generation_jobs WHERE round_id = ? AND prompt_id = ?",
    [roundId, promptId]
  );
  if (!job) {
    return;
  }

  if (type === "execution_start" || (type === "executing" && data.node !== null)) {
    runSql(
      "UPDATE generation_jobs SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ? AND status IN ('pending', 'queued')",
      [job.id]
    );
    runSql("UPDATE generation_rounds SET status = 'running' WHERE id = ?", [roundId]);
    return;
  }

  if (type === "executed" || type === "execution_success" || (type === "executing" && data.node === null)) {
    await collectRound(roundId);
    return;
  }

  if (type === "execution_interrupted") {
    runSql(
      "UPDATE generation_jobs SET status = 'interrupted', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'completed'",
      [job.id]
    );
    updateRoundStatusFromJobs(roundId);
    await collectRound(roundId);
    return;
  }

  if (type === "execution_error") {
    runSql(
      "UPDATE generation_jobs SET status = 'failed', last_error_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'completed'",
      [JSON.stringify(data), job.id]
    );
    updateRoundStatusFromJobs(roundId);
    await collectRound(roundId);
  }
}

function stopRoundMonitor(roundId: string) {
  const monitor = activeRoundMonitors.get(roundId);
  if (!monitor) {
    return;
  }
  activeRoundMonitors.delete(roundId);
  try {
    monitor.socket.close();
  } catch {
    // Ignore close failures; polling collection remains the fallback.
  }
}

function deleteRoundTree(roundId: string) {
  const round = getRow<Record<string, unknown>>("SELECT * FROM generation_rounds WHERE id = ?", [roundId]);
  if (!round) {
    throw new HttpError(404, "Round was not found");
  }

  const rows = getRows<{ id: string; depth: number }>(
    `WITH RECURSIVE round_tree(id, depth) AS (
       SELECT id, 0 FROM generation_rounds WHERE id = ?
       UNION ALL
       SELECT child.id, round_tree.depth + 1
       FROM generation_rounds child
       JOIN round_tree ON child.parent_round_id = round_tree.id
     )
     SELECT id, depth FROM round_tree ORDER BY depth DESC`,
    [roundId]
  );

  runSql("BEGIN");
  try {
    for (const row of rows) {
      stopRoundMonitor(row.id);
      runSql("DELETE FROM generation_rounds WHERE id = ?", [row.id]);
    }
    runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [round.project_id]);
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    throw error;
  }

  return {
    deleted: true,
    roundIds: rows.map((row) => row.id),
    deletedCount: rows.length
  };
}

function extractHistoryEntry(history: unknown, promptId: string) {
  if (history && typeof history === "object" && promptId in history) {
    return (history as Record<string, unknown>)[promptId];
  }
  return history;
}

function extractImages(entry: unknown): HistoryImage[] {
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

function selectFinalImages(images: HistoryImage[], roleMap: Record<string, unknown> | null, workflow: Record<string, unknown> | null): HistoryImage[] {
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

function parseStoredJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getSettingOrDefault(): ComfySettings {
  const row = getRow<{ value_json: string }>("SELECT value_json FROM app_settings WHERE key = 'comfy'");
  if (!row) {
    throw new HttpError(500, "Comfy settings were not initialized");
  }
  const parsed = JSON.parse(row.value_json) as Partial<ComfySettings>;
  return {
    ...parsed,
    webSamModelBaseUrl: parsed.webSamModelBaseUrl?.trim() || DEFAULT_WEB_SAM_MODEL_BASE_URL
  } as ComfySettings;
}

async function serveWebSamReleaseAsset(res: ServerResponse, filename: string) {
  if (!webSamReleaseAssetNames.has(filename)) {
    sendJson(res, 404, { error: "WebSAM model asset was not found" });
    return;
  }

  const token = githubToken();
  if (!token) {
    sendJson(res, 503, {
      error: "GitHub token is required to download WebSAM models from this private repository release.",
      env: "Set GURUGURU_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN before starting GURUGURU."
    });
    return;
  }

  const release = await fetchGithubJson<{ assets?: Array<{ name?: string; url?: string; size?: number; content_type?: string }> }>(
    GITHUB_WEB_SAM_RELEASE_API_URL,
    token
  );
  const asset = release.assets?.find((item) => item.name === filename);
  if (!asset?.url) {
    sendJson(res, 404, { error: "WebSAM model asset was not found in the GitHub release" });
    return;
  }

  const response = await fetch(asset.url, {
    headers: githubHeaders(token, "application/octet-stream")
  });
  if (!response.ok || !response.body) {
    sendJson(res, response.status || 502, {
      error: `GitHub model download failed: ${response.status} ${response.statusText}`.trim()
    });
    return;
  }

  res.writeHead(200, {
    "content-type": asset.content_type || "application/octet-stream",
    "content-length": String(asset.size ?? response.headers.get("content-length") ?? ""),
    "cache-control": "private, max-age=86400"
  });

  for await (const chunk of response.body) {
    res.write(chunk);
  }
  res.end();
}

async function fetchGithubJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: githubHeaders(token, "application/vnd.github+json")
  });
  if (!response.ok) {
    throw new HttpError(response.status || 502, `GitHub API request failed: ${response.status} ${response.statusText}`.trim());
  }
  return response.json() as Promise<T>;
}

function githubHeaders(token: string, accept: string) {
  return {
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": "guruguru-websam-model-loader"
  };
}

function githubToken() {
  return process.env.GURUGURU_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || "";
}

function errorToJson(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
}

function setupShutdownHandlers() {
  process.on("SIGINT", () => shutdownServer("SIGINT"));
  process.on("SIGTERM", () => shutdownServer("SIGTERM"));

  if (!process.stdin.isTTY) {
    return;
  }

  process.stdin.setEncoding("utf8");
  if (typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    const command = chunk.trim().toLowerCase();
    if (chunk === "\u0003" || command === "q" || command === "quit" || command === "exit") {
      shutdownServer("terminal command");
    }
  });
}

function shutdownServer(reason: string) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`Stopping GURUGURU (${reason})...`);
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(0);
  }, 3000).unref();
}
