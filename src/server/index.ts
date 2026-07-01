import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { deleteProjectStorage, ensureProjectStorage, readImageSize, safeFileStream, storeImage, storeMaskImage } from "./storage";
import { ensureWorkflowObject, hashJson, normalizeRoleMap, patchWorkflow, resolveSeed } from "./workflow";
import { validateRoleMapReferences } from "../shared/workflowRoleMap";
import type { AssetStatus, ComfySettings, GenerationMode, GenerationRequest, InpaintOptions, MaskedContent, ParentRelation, SelectionAction } from "../shared/types";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "..", "public");
const port = Number(process.env.PORT ?? 5177);
let isShuttingDown = false;

type HistoryImage = { nodeId: string; filename: string; subfolder?: string; type?: string };
type BranchAssignment = { colorIndex: number; reason: string; key: string };
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

const maxSourceImageBytes = 16 * 1024 * 1024;
const maxMaskImageBytes = 8 * 1024 * 1024;
const maxBatchSize = 32;
const terminalJobStatuses = new Set<GenerationJobStatus>(["completed", "failed", "interrupted", "cancelled"]);
const activeJobStatuses = new Set<GenerationJobStatus>(["pending", "queued", "running"]);
const terminalRoundStatuses = new Set(["completed", "failed", "interrupted"]);
const activeRoundMonitors = new Map<string, { socket: WebSocket; clientId: string }>();
const roundCollectionLocks = new Map<string, Promise<CollectRoundResult>>();

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
    const settings: ComfySettings = {
      ...getSettingOrDefault(),
      baseUrl: stringOr(body.baseUrl, "http://127.0.0.1:8188"),
      websocketUrl: stringOr(body.websocketUrl, "ws://127.0.0.1:8188/ws"),
      timeoutSeconds: numberOr(body.timeoutSeconds, 60),
      imageFetchMode: "view",
      storageDir: dataRoot
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
    sendJson(res, 200, getProjectDetail(projectDetailMatch[1]!));
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

function listTemplates() {
  return toApiRows(
    getRows(
      `SELECT *
       FROM workflow_templates
       WHERE deleted_at IS NULL
       ORDER BY updated_at DESC, name ASC`
    )
  );
}

function createTemplate(body: unknown) {
  const input = objectBody(body);
  const name = requiredString(input.name, "name");
  const description = stringOr(input.description, "");
  const type = stringOr(input.type, "txt2img");
  const workflow = parseJsonInput(input.workflowJson ?? input.workflow_json, "workflowJson");
  const roleMap = parseJsonInput(input.roleMap ?? input.role_map_json, "roleMap");

  let normalizedRoleMap: Record<string, unknown>;
  try {
    ensureWorkflowObject(workflow);
    normalizedRoleMap = normalizeRoleMap(roleMap);
    validateRoleMapReferences(workflow, normalizedRoleMap);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }

  const version =
    (getRow<{ version: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM workflow_templates WHERE name = ?", [name])?.version ?? 1);
  const id = createId("template");
  const workflowHash = hashJson(workflow);

  runSql(
    `INSERT INTO workflow_templates
      (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description, type, version, JSON.stringify(workflow), JSON.stringify(normalizedRoleMap), workflowHash]
  );

  return toApiRow(getRow("SELECT * FROM workflow_templates WHERE id = ?", [id]));
}

function deleteTemplate(templateId: string) {
  const template = getRow<Record<string, unknown>>("SELECT * FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [templateId]);
  if (!template) {
    throw new HttpError(404, "WorkflowTemplate was not found");
  }

  runSql(
    "UPDATE workflow_templates SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [templateId]
  );
  runSql(
    "UPDATE projects SET default_template_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE default_template_id = ?",
    [templateId]
  );

  return {
    template: toApiRow(getRow("SELECT * FROM workflow_templates WHERE id = ?", [templateId]))
  };
}

function listProjects() {
  const rows = getRows<Record<string, unknown>>(
    `SELECT
       p.*,
       (SELECT COUNT(*) FROM generation_rounds r WHERE r.project_id = p.id) AS round_count,
       (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id) AS asset_count,
       (SELECT a.id FROM assets a WHERE a.project_id = p.id AND a.status IN ('selected', 'favorite') ORDER BY a.created_at DESC LIMIT 1) AS representative_asset_id
     FROM projects p
     ORDER BY p.updated_at DESC`
  );

  return rows.map((row) => {
    const item = toApiRow(row)!;
    if (typeof item.representativeAssetId === "string") {
      item.representativeThumbnailUrl = `/api/assets/${item.representativeAssetId}/thumbnail?size=small`;
    }
    return item;
  });
}

function createProject(body: unknown) {
  const input = objectBody(body);
  const id = createId("project");
  const name = requiredString(input.name, "name");
  const description = stringOr(input.description, "");
  const defaultTemplateId = stringOrNull(input.defaultTemplateId ?? input.default_template_id);
  if (defaultTemplateId) {
    const template = getRow("SELECT id FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [defaultTemplateId]);
    if (!template) {
      throw new HttpError(400, "Default WorkflowTemplate was not found");
    }
  }
  const storage = ensureProjectStorage(id);

  runSql(
    `INSERT INTO projects (id, name, description, default_template_id, storage_dir)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, description, defaultTemplateId, storage.projectRoot]
  );

  return toApiRow(getRow("SELECT * FROM projects WHERE id = ?", [id]));
}

async function deleteProject(projectId: string) {
  const project = getRow<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }

  runSql("UPDATE generation_rounds SET parent_round_id = NULL WHERE project_id = ?", [projectId]);
  runSql("DELETE FROM projects WHERE id = ?", [projectId]);

  let storageDeleted = false;
  let storageError: string | undefined;
  if (typeof project.storage_dir === "string" && project.storage_dir.trim()) {
    try {
      await deleteProjectStorage(project.storage_dir);
      storageDeleted = true;
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    deleted: true,
    projectId,
    storageDeleted,
    storageError
  };
}

function getProjectDetail(projectId: string) {
  const project = toApiRow(getRow("SELECT * FROM projects WHERE id = ?", [projectId]));
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }

  const rounds = toApiRows(
    getRows(
      `SELECT r.*,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id) AS asset_count,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id AND a.status = 'selected') AS selected_count,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id AND a.status = 'rejected') AS rejected_count
       FROM generation_rounds r
       WHERE r.project_id = ?
       ORDER BY r.round_index DESC`,
      [projectId]
    )
  );

  const assets = toApiRows(
    getRows("SELECT * FROM assets WHERE project_id = ? ORDER BY round_id ASC, batch_index ASC", [projectId])
  ).map(decorateAsset);

  const parents = toApiRows(
    getRows(
      `SELECT ap.*
       FROM asset_parents ap
       JOIN assets child ON child.id = ap.child_asset_id
       WHERE child.project_id = ?
       ORDER BY ap.created_at ASC`,
      [projectId]
    )
  );

  for (const round of rounds) {
    if ((round.status === "running" || round.status === "pending") && typeof round.id === "string") {
      ensureRoundMonitor(round.id);
    }
  }

  return {
    project,
    rounds,
    assets,
    assetParents: parents,
    templates: listTemplates()
  };
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
  if (shouldUploadParent(generationMode) && !parentAsset) {
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
    const uploaded = parentAsset && shouldUploadParent(request.generationMode)
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

async function createSourceAsset(projectId: string, body: unknown) {
  const project = getRow<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }

  const input = objectBody(body);
  const templateId = requiredString(input.templateId ?? input.template_id, "templateId");
  const template = getRow<Record<string, unknown>>("SELECT * FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [templateId]);
  if (!template) {
    throw new HttpError(400, "WorkflowTemplate was not found. Select a template before uploading a source image.");
  }

  const image = decodeImageDataUrl(input.dataUrl ?? input.data_url);
  const filename = normalizedUploadFileName(stringOr(input.filename, "source"), image.mimeType);
  const roundIndex = nextRoundIndex(projectId);
  const roundId = createId("round");
  const assetId = createId("asset");
  const branch = branchAssignmentForRound(projectId, null, roundId, "manual_upload");
  const request: GenerationRequest = normalizeGenerationRequest({
    templateId,
    prompt: stringOr(input.prompt, ""),
    negativePrompt: stringOr(input.negativePrompt ?? input.negative_prompt, ""),
    seed: typeof input.seed === "number" ? input.seed : null,
    seedMode: stringOr(input.seedMode ?? input.seed_mode, "random") as GenerationRequest["seedMode"],
    batchSize: numberOr(input.batchSize ?? input.batch_size, 1),
    steps: numberOr(input.steps, 20),
    cfg: numberOr(input.cfg, 7),
    sampler: stringOr(input.sampler, "euler"),
    scheduler: stringOr(input.scheduler, "normal"),
    denoise: numberOr(input.denoise, 0.35),
    width: numberOr(input.width, 1024),
    height: numberOr(input.height, 1024),
    generationMode: "manual_upload",
    parentAssetId: null,
    relationType: "manual"
  });
  const stored = await storeImage(projectId, roundId, 0, filename, image.bytes);

  runSql(
    `INSERT INTO generation_rounds
      (id, project_id, template_id, parent_round_id, round_index, status, generation_mode,
       branch_color_index, branch_reason, branch_key, request_json, completed_at)
     VALUES (?, ?, ?, NULL, ?, 'completed', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      roundId,
      projectId,
      templateId,
      roundIndex,
      request.generationMode,
      branch.colorIndex,
      branch.reason,
      `asset:${assetId}`,
      JSON.stringify(request)
    ]
  );

  runSql(
    `INSERT INTO assets
      (id, project_id, round_id, prompt_id, batch_index, image_path, thumbnail_small_path, thumbnail_medium_path,
       width, height, prompt, negative_prompt, seed, sampler, scheduler, steps, cfg, denoise,
       workflow_template_id, workflow_template_version, workflow_snapshot_hash, comfy_output_node_id, status)
     VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'selected')`,
    [
      assetId,
      projectId,
      roundId,
      stored.imagePath,
      stored.thumbnailSmallPath,
      stored.thumbnailMediumPath,
      stored.width,
      stored.height,
      request.prompt,
      request.negativePrompt,
      request.seed,
      request.sampler,
      request.scheduler,
      request.steps,
      request.cfg,
      request.denoise,
      template.id,
      template.version,
      template.workflow_hash
    ]
  );

  runSql(
    `INSERT INTO selection_events (id, project_id, round_id, asset_id, action, note)
     VALUES (?, ?, ?, ?, 'select', ?)`,
    [createId("selection"), projectId, roundId, assetId, "uploaded source asset"]
  );
  runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [projectId]);

  return {
    round: toApiRow(getRow("SELECT * FROM generation_rounds WHERE id = ?", [roundId])),
    asset: decorateAsset(toApiRow(getRow("SELECT * FROM assets WHERE id = ?", [assetId]))!)
  };
}

function nextRoundIndex(projectId: string) {
  return getRow<{ next_index: number }>(
    "SELECT COALESCE(MAX(round_index), 0) + 1 AS next_index FROM generation_rounds WHERE project_id = ?",
    [projectId]
  )?.next_index ?? 1;
}

function branchAssignmentForRound(
  projectId: string,
  parentAsset: Record<string, unknown> | null,
  roundId: string,
  rootReason: string
): BranchAssignment {
  if (parentAsset) {
    const key = `asset:${parentAsset.id}`;
    const existing = getRow<{ branch_color_index: number }>(
      `SELECT branch_color_index
       FROM generation_rounds
       WHERE project_id = ? AND branch_key = ?
       ORDER BY round_index ASC
       LIMIT 1`,
      [projectId, key]
    );
    if (existing) {
      return {
        colorIndex: Number(existing.branch_color_index) || 0,
        reason: "parent_asset",
        key
      };
    }
    return {
      colorIndex: nextBranchColorIndex(projectId),
      reason: "parent_asset",
      key
    };
  }

  return {
    colorIndex: nextBranchColorIndex(projectId),
    reason: rootReason,
    key: `root:${roundId}`
  };
}

function nextBranchColorIndex(projectId: string) {
  return getRow<{ next_index: number }>(
    "SELECT COALESCE(MAX(branch_color_index), -1) + 1 AS next_index FROM generation_rounds WHERE project_id = ?",
    [projectId]
  )?.next_index ?? 0;
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
    width: parentSize.width,
    height: parentSize.height,
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
  const maskedContent = stringOr(value, "fill");
  if (maskedContent === "fill" || maskedContent === "original" || maskedContent === "latent_noise" || maskedContent === "latent_nothing") {
    return maskedContent;
  }
  throw new HttpError(400, "Unsupported maskedContent value.");
}

function decodeMaskDataUrl(rawValue: unknown): { bytes: Buffer } {
  const dataUrl = requiredString(rawValue, "inpaint.maskDataUrl");
  if (dataUrl.length > Math.ceil(maxMaskImageBytes * 1.4) + 128) {
    throw new HttpError(413, `Mask image is too large. The maximum upload size is ${formatBytes(maxMaskImageBytes)}.`);
  }

  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) {
    throw new HttpError(400, "inpaint.maskDataUrl must be a base64 PNG data URL.");
  }

  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.length === 0) {
    throw new HttpError(400, "Mask image is empty.");
  }
  if (bytes.length > maxMaskImageBytes) {
    throw new HttpError(413, `Mask image is too large. The maximum upload size is ${formatBytes(maxMaskImageBytes)}.`);
  }
  if (!bytesMatchMimeType(bytes, "image/png")) {
    throw new HttpError(400, "Mask data URL content is not a PNG image.");
  }

  return { bytes };
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

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function decodeImageDataUrl(rawValue: unknown): { mimeType: string; bytes: Buffer } {
  const dataUrl = requiredString(rawValue, "dataUrl");
  if (dataUrl.length > Math.ceil(maxSourceImageBytes * 1.4) + 128) {
    throw new HttpError(413, `Source image is too large. The maximum upload size is ${formatBytes(maxSourceImageBytes)}.`);
  }

  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) {
    throw new HttpError(400, "dataUrl must be a base64 data URL for image/png, image/jpeg, or image/webp.");
  }

  const mimeType = match[1]!.toLowerCase();
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0) {
    throw new HttpError(400, "Source image is empty.");
  }
  if (bytes.length > maxSourceImageBytes) {
    throw new HttpError(413, `Source image is too large. The maximum upload size is ${formatBytes(maxSourceImageBytes)}.`);
  }
  if (!bytesMatchMimeType(bytes, mimeType)) {
    throw new HttpError(400, "dataUrl content does not match the declared image MIME type.");
  }

  return { mimeType, bytes };
}

function bytesMatchMimeType(bytes: Buffer, mimeType: string) {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.toString("ascii", 1, 4) === "PNG";
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

function normalizedUploadFileName(filename: string, mimeType: string) {
  const trimmed = filename.trim() || "source";
  if (/\.(png|jpe?g|webp)$/i.test(trimmed)) {
    return trimmed;
  }
  const ext = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
  return `${trimmed}${ext}`;
}

function formatBytes(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
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
      round: toApiRow(updatedRound),
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
        round: toApiRow(round),
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
        round: toApiRow(round),
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
      round: toApiRow(getRow("SELECT * FROM generation_rounds WHERE id = ?", [roundId])),
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
        request.relationType ?? relationFromMode(request.generationMode),
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

function updateAssetStatus(assetId: string, body: unknown) {
  const input = objectBody(body);
  const status = requiredString(input.status, "status") as AssetStatus;
  if (!["generated", "selected", "rejected", "favorite", "archived"].includes(status)) {
    throw new HttpError(400, "Unsupported Asset status");
  }

  const asset = getRow<Record<string, unknown>>("SELECT * FROM assets WHERE id = ?", [assetId]);
  if (!asset) {
    throw new HttpError(404, "Asset was not found");
  }

  runSql("UPDATE assets SET status = ? WHERE id = ?", [status, assetId]);
  runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [asset.project_id]);

  const action = selectionActionFor(status, String(asset.status));
  if (action) {
    runSql(
      `INSERT INTO selection_events (id, project_id, round_id, asset_id, action, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [createId("selection"), asset.project_id, asset.round_id, assetId, action, stringOrNull(input.note)]
    );
  }

  return {
    asset: decorateAsset(toApiRow(getRow("SELECT * FROM assets WHERE id = ?", [assetId]))!)
  };
}

async function serveAssetFile(res: ServerResponse, assetId: string, kind: string, url: URL) {
  const asset = getRow<Record<string, unknown>>("SELECT * FROM assets WHERE id = ?", [assetId]);
  if (!asset) {
    sendJson(res, 404, { error: "Asset was not found" });
    return;
  }

  const size = url.searchParams.get("size") === "medium" ? "medium" : "small";
  const path = kind === "image"
    ? String(asset.image_path)
    : size === "medium"
      ? String(asset.thumbnail_medium_path)
      : String(asset.thumbnail_small_path);

  streamFile(res, path);
}

function decorateAsset(asset: Record<string, unknown>) {
  return {
    ...asset,
    imageUrl: `/api/assets/${asset.id}/image`,
    thumbnailUrl: `/api/assets/${asset.id}/thumbnail?size=small`,
    thumbnailMediumUrl: `/api/assets/${asset.id}/thumbnail?size=medium`
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

function nodeIdFromRolePath(rawPath: unknown): string | null {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return null;
  }
  return rawPath.split(".").filter(Boolean)[0] ?? null;
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

function normalizeGenerationRequest(input: GenerationRequest): GenerationRequest {
  const sampling = normalizeSampling(input.sampler, input.scheduler);
  const generationMode = (input.generationMode ?? "txt2img") as GenerationMode;

  return {
    templateId: requiredString(input.templateId, "templateId"),
    prompt: stringOr(input.prompt, ""),
    negativePrompt: stringOr(input.negativePrompt, ""),
    seed: typeof input.seed === "number" && Number.isFinite(input.seed) ? input.seed : null,
    seedMode: input.seedMode ?? "random",
    batchSize: clampInteger(numberOr(input.batchSize, 16), 1, maxBatchSize),
    steps: numberOr(input.steps, 20),
    cfg: numberOr(input.cfg, 6),
    sampler: sampling.sampler,
    scheduler: sampling.scheduler,
    denoise: normalizeDenoise(input.denoise, generationMode),
    width: numberOr(input.width, 1024),
    height: numberOr(input.height, 1024),
    generationMode,
    parentAssetId: stringOrNull(input.parentAssetId),
    relationType: (stringOrNull(input.relationType) as ParentRelation | null) ?? relationFromMode(generationMode)
  };
}

function normalizeSampling(rawSampler: unknown, rawScheduler: unknown) {
  const sampler = stringOr(rawSampler, "euler");
  const scheduler = stringOr(rawScheduler, "normal");

  if (sampler.endsWith("_karras")) {
    return {
      sampler: sampler.slice(0, -"_karras".length),
      scheduler: scheduler === "normal" ? "karras" : scheduler
    };
  }

  return { sampler, scheduler };
}

function normalizeDenoise(rawDenoise: unknown, mode: GenerationMode) {
  if (requiresFullDenoise(mode)) {
    return 1;
  }
  const value = numberOr(rawDenoise, defaultDenoiseForMode(mode));
  return Math.min(1, Math.max(0, value));
}

function defaultDenoiseForMode(mode: GenerationMode) {
  return mode === "img2img" ? 0.35 : 0.45;
}

function requiresFullDenoise(mode: GenerationMode) {
  return mode === "txt2img" || mode === "seed_reuse" || mode === "prompt_reuse";
}

function shouldUploadParent(mode: GenerationMode) {
  return mode === "img2img" || mode === "ipadapter" || mode === "controlnet";
}

function relationFromMode(mode: GenerationMode): ParentRelation {
  if (mode === "ipadapter") {
    return "ipadapter_reference";
  }
  if (mode === "controlnet") {
    return "controlnet_reference";
  }
  if (mode === "seed_reuse") {
    return "seed_reuse";
  }
  if (mode === "prompt_reuse") {
    return "prompt_reuse";
  }
  if (mode === "upscale") {
    return "upscale";
  }
  if (mode === "detail") {
    return "detailer";
  }
  return "img2img";
}

function selectionActionFor(newStatus: string, previousStatus: string): SelectionAction | null {
  if (newStatus === "selected") {
    return "select";
  }
  if (newStatus === "rejected") {
    return "reject";
  }
  if (newStatus === "favorite") {
    return "favorite";
  }
  if (previousStatus === "selected") {
    return "unselect";
  }
  if (previousStatus === "rejected") {
    return "unreject";
  }
  if (previousStatus === "favorite") {
    return "unfavorite";
  }
  return null;
}

function parseJsonInput(value: unknown, name: string): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new HttpError(400, `${name} is not valid JSON`);
    }
  }
  if (typeof value === "object" && value !== null) {
    return value;
  }
  throw new HttpError(400, `${name} is required`);
}

async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${name} is required`);
  }
  return value.trim();
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function getSettingOrDefault(): ComfySettings {
  const row = getRow<{ value_json: string }>("SELECT value_json FROM app_settings WHERE key = 'comfy'");
  if (!row) {
    throw new HttpError(500, "Comfy settings were not initialized");
  }
  return JSON.parse(row.value_json) as ComfySettings;
}

function errorToJson(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
}

async function serveStatic(res: ServerResponse, pathname: string) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(join(publicDir, normalizedPath));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    const indexHtml = await readFile(join(publicDir, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(indexHtml);
    return;
  }
  streamFile(res, filePath);
}

function streamFile(res: ServerResponse, filePath: string) {
  const stream = filePath.startsWith(resolve(dataRoot)) ? safeFileStream(filePath) : createReadStream(filePath);
  stream.on("error", () => sendJson(res, 404, { error: "File was not found" }));
  res.writeHead(200, { "content-type": contentTypeFor(filePath) });
  stream.pipe(res);
}

function contentTypeFor(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }
  if (ext === ".js") {
    return "text/javascript; charset=utf-8";
  }
  if (ext === ".css") {
    return "text/css; charset=utf-8";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  return "application/octet-stream";
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
  }
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
