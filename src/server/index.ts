import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createId, dataRoot, dbPath, getRow, getRows, initializeDb, runSql, setSetting, toApiRow, toApiRows } from "./db";
import { fetchViewImage, getComfyStatus, getHistory, queuePrompt, testComfyConnection, uploadImageToComfy } from "./comfy";
import { ensureProjectStorage, safeFileStream, storeImage } from "./storage";
import { ensureWorkflowObject, hashJson, normalizeRoleMap, patchWorkflow, resolveSeed } from "./workflow";
import type { AssetStatus, ComfySettings, GenerationMode, GenerationRequest, ParentRelation, SelectionAction } from "../shared/types";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "..", "public");
const port = Number(process.env.PORT ?? 5177);

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
});

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

  const generateMatch = path.match(/^\/api\/projects\/([^/]+)\/rounds$/);
  if (method === "POST" && generateMatch) {
    sendJson(res, 201, await createGenerationRound(generateMatch[1]!, await readJson<GenerationRequest>(req)));
    return;
  }

  const collectMatch = path.match(/^\/api\/rounds\/([^/]+)\/collect$/);
  if (method === "POST" && collectMatch) {
    const result = await collectRound(collectMatch[1]!);
    sendJson(res, result.statusCode, result.body);
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

  ensureWorkflowObject(workflow);
  normalizeRoleMap(roleMap);

  const version =
    (getRow<{ version: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM workflow_templates WHERE name = ?", [name])?.version ?? 1);
  const id = createId("template");
  const workflowHash = hashJson(workflow);

  runSql(
    `INSERT INTO workflow_templates
      (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description, type, version, JSON.stringify(workflow), JSON.stringify(roleMap), workflowHash]
  );

  return toApiRow(getRow("SELECT * FROM workflow_templates WHERE id = ?", [id]));
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
  const storage = ensureProjectStorage(id);

  runSql(
    `INSERT INTO projects (id, name, description, default_template_id, storage_dir)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, description, defaultTemplateId, storage.projectRoot]
  );

  return toApiRow(getRow("SELECT * FROM projects WHERE id = ?", [id]));
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

  const template = getRow<Record<string, unknown>>("SELECT * FROM workflow_templates WHERE id = ?", [requestBody.templateId]);
  if (!template) {
    throw new HttpError(400, "WorkflowTemplate was not found");
  }

  const parentAsset = requestBody.parentAssetId
    ? getRow<Record<string, unknown>>("SELECT * FROM assets WHERE id = ? AND project_id = ?", [requestBody.parentAssetId, projectId])
    : null;

  if (requestBody.parentAssetId && !parentAsset) {
    throw new HttpError(400, "Parent Asset was not found in this Project");
  }

  const roundIndex =
    (getRow<{ next_index: number }>("SELECT COALESCE(MAX(round_index), 0) + 1 AS next_index FROM generation_rounds WHERE project_id = ?", [
      projectId
    ])?.next_index ?? 1);
  const roundId = createId("round");
  const parentRoundId = typeof parentAsset?.round_id === "string" ? parentAsset.round_id : null;
  const seed = resolveSeed(requestBody, typeof parentAsset?.seed === "number" ? parentAsset.seed : null);
  const request: GenerationRequest = normalizeGenerationRequest({ ...requestBody, seed });

  runSql(
    `INSERT INTO generation_rounds
      (id, project_id, template_id, parent_round_id, round_index, status, generation_mode, request_json)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [roundId, projectId, request.templateId, parentRoundId, roundIndex, request.generationMode, JSON.stringify(request)]
  );

  try {
    const workflow = JSON.parse(String(template.workflow_json));
    const roleMap = JSON.parse(String(template.role_map_json));
    const uploaded = parentAsset && shouldUploadParent(request.generationMode)
      ? await uploadImageToComfy(String(parentAsset.image_path))
      : null;
    const patchedWorkflow = patchWorkflow(workflow, roleMap, {
      projectId,
      roundIndex,
      request,
      uploadedImageName: uploaded?.name ?? null
    });

    runSql(
      "UPDATE generation_rounds SET patched_workflow_json = ?, status = 'running' WHERE id = ?",
      [JSON.stringify(patchedWorkflow), roundId]
    );

    const promptId = await queuePrompt(patchedWorkflow);
    runSql("UPDATE generation_rounds SET prompt_id = ?, status = 'running' WHERE id = ?", [promptId, roundId]);

    return {
      round: toApiRow(getRow("SELECT * FROM generation_rounds WHERE id = ?", [roundId])),
      promptId
    };
  } catch (error) {
    runSql(
      "UPDATE generation_rounds SET status = 'failed', last_error_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [JSON.stringify(errorToJson(error)), roundId]
    );
    throw error;
  }
}

async function collectRound(roundId: string) {
  const round = getRow<Record<string, unknown>>("SELECT * FROM generation_rounds WHERE id = ?", [roundId]);
  if (!round) {
    throw new HttpError(404, "Round was not found");
  }

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

  const history = await getHistory(round.prompt_id);
  const entry = extractHistoryEntry(history, round.prompt_id);
  const images = extractImages(entry);

  if (images.length === 0) {
    return {
      statusCode: 202,
      body: {
        round: toApiRow(round),
        message: "ComfyUI history is reachable, but no output images are available yet."
      }
    };
  }

  const template = getRow<Record<string, unknown>>("SELECT * FROM workflow_templates WHERE id = ?", [round.template_id]);
  if (!template) {
    throw new HttpError(500, "Round template was not found");
  }

  const request = JSON.parse(String(round.request_json)) as GenerationRequest;
  const createdAssets: Record<string, unknown>[] = [];
  const startingIndex =
    getRow<{ next_index: number }>("SELECT COALESCE(MAX(batch_index), -1) + 1 AS next_index FROM assets WHERE round_id = ?", [roundId])
      ?.next_index ?? 0;

  let batchIndex = startingIndex;
  for (const image of images) {
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
        round.prompt_id,
        batchIndex,
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

    createdAssets.push(decorateAsset(toApiRow(getRow("SELECT * FROM assets WHERE id = ?", [assetId]))!));
    batchIndex += 1;
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

function extractImages(entry: unknown): Array<{ nodeId: string; filename: string; subfolder?: string; type?: string }> {
  const output = entry && typeof entry === "object" ? (entry as Record<string, unknown>).outputs : null;
  if (!output || typeof output !== "object") {
    return [];
  }

  const images: Array<{ nodeId: string; filename: string; subfolder?: string; type?: string }> = [];
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

function normalizeGenerationRequest(input: GenerationRequest): GenerationRequest {
  return {
    templateId: requiredString(input.templateId, "templateId"),
    prompt: stringOr(input.prompt, ""),
    negativePrompt: stringOr(input.negativePrompt, ""),
    seed: typeof input.seed === "number" ? input.seed : null,
    seedMode: input.seedMode ?? "random",
    batchSize: numberOr(input.batchSize, 16),
    steps: numberOr(input.steps, 20),
    cfg: numberOr(input.cfg, 6),
    sampler: stringOr(input.sampler, "euler"),
    scheduler: stringOr(input.scheduler, "normal"),
    denoise: numberOr(input.denoise, 0.45),
    width: numberOr(input.width, 1024),
    height: numberOr(input.height, 1024),
    generationMode: (input.generationMode ?? "txt2img") as GenerationMode,
    parentAssetId: stringOrNull(input.parentAssetId),
    relationType: (stringOrNull(input.relationType) as ParentRelation | null) ?? relationFromMode(input.generationMode ?? "txt2img")
  };
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
