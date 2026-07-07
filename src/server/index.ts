import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dataRoot, dbPath, getRow, initializeDb, setSetting } from "./db";
import { discardRoundTrashSnapshot, purgeAllRoundTrash } from "./roundTrash";
import { getComfyStatus, testComfyConnection } from "./comfy";
import { checkModels } from "./modelCheck";
import { getLlmSettings, getLlmStatus, improvePromptWithLlm, testLlmConnection } from "./llm";
import { serveStatic } from "./files";
import { HttpError, readJson, sendJson } from "./http";
import { nonEmptyStringOr, numberOr, stringOr } from "./validate";
import { createTemplate, deleteTemplate, listTemplates } from "./templates";
import { serveAssetFile, updateAssetStatus } from "./assets";
import { createProject, deleteProject, getProjectDetail, listProjects } from "./projects";
import { createSourceAsset } from "./sourceAssets";
import { createPasteSource, getPasteAttachments, purgeOrphanPasteSources, putPasteAttachments, servePasteSource } from "./pasteAttachments";
import {
  collectRound,
  createGenerationRound,
  deleteRoundTree,
  restoreRounds,
  ensureRoundMonitor,
  interruptRound,
  serveRoundAttachment
} from "./rounds";
import {
  DEFAULT_WEB_SAM_MODEL_BASE_URL,
  GITHUB_POSE_CIGPOSE_RELEASE_API_URL,
  GITHUB_POSE_RELEASE_API_URL,
  GITHUB_WEB_SAM_RELEASE_API_URL
} from "../shared/constants";
import type { ComfySettings, GenerationRequest, LlmSettings } from "../shared/types";

const port = Number(process.env.PORT ?? 5177);
let isShuttingDown = false;

const releaseAssetRegistry = new Map<string, string>([
  ["slimsam-77-encoder.onnx", GITHUB_WEB_SAM_RELEASE_API_URL],
  ["slimsam-77-decoder.onnx", GITHUB_WEB_SAM_RELEASE_API_URL],
  ["pose_landmarker_full.task", GITHUB_POSE_RELEASE_API_URL],
  ["pose_landmarker_heavy.task", GITHUB_POSE_RELEASE_API_URL],
  ["yolox_nano.onnx", GITHUB_POSE_CIGPOSE_RELEASE_API_URL],
  ["cigpose-l_coco_384x288.onnx", GITHUB_POSE_CIGPOSE_RELEASE_API_URL],
  ["cigpose-x_coco-wholebody_384x288.onnx", GITHUB_POSE_CIGPOSE_RELEASE_API_URL]
]);

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
  const purgedTrash = purgeAllRoundTrash();
  if (purgedTrash > 0) {
    console.log(`Purged ${purgedTrash} leftover round trash snapshot(s).`);
  }
  const purgedPasteSources = purgeOrphanPasteSources();
  if (purgedPasteSources > 0) {
    console.log(`Purged ${purgedPasteSources} orphan paste source image(s).`);
  }
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

  if (method === "GET" && path === "/api/comfy/model-check") {
    const family = url.searchParams.get("family");
    if (family !== "chroma") {
      sendJson(res, 404, { error: `Unknown model family: ${family}` });
      return;
    }
    sendJson(res, 200, await checkModels(family));
    return;
  }

  if (method === "GET" && path === "/api/settings/llm") {
    sendJson(res, 200, getLlmSettings());
    return;
  }

  if (method === "PUT" && path === "/api/settings/llm") {
    const body = await readJson<Partial<LlmSettings>>(req);
    const currentSettings = getLlmSettings();
    const settings: LlmSettings = {
      baseUrl: stringOr(body.baseUrl, currentSettings.baseUrl).trim().replace(/\/+$/, ""),
      model: stringOr(body.model, currentSettings.model).trim(),
      systemPrompt: stringOr(body.systemPrompt, currentSettings.systemPrompt),
      temperature: Math.min(2, Math.max(0, numberOr(body.temperature, currentSettings.temperature)))
    };
    setSetting("llm", settings);
    sendJson(res, 200, settings);
    return;
  }

  if (method === "POST" && path === "/api/llm/test") {
    sendJson(res, 200, await testLlmConnection());
    return;
  }

  if (method === "GET" && path === "/api/llm/status") {
    sendJson(res, 200, await getLlmStatus());
    return;
  }

  if (method === "POST" && path === "/api/llm/improve-prompt") {
    const body = await readJson<{ prompt?: string; negativePrompt?: string }>(req);
    const improved = await improvePromptWithLlm(
      stringOr(body.prompt, ""),
      typeof body.negativePrompt === "string" ? body.negativePrompt : undefined
    );
    sendJson(res, 200, { prompt: improved });
    return;
  }

  const webSamModelMatch = path.match(/^\/api\/websam-models\/([^/]+)$/);
  if (method === "GET" && webSamModelMatch) {
    await serveReleaseAsset(res, webSamModelMatch[1]!, "WebSAM");
    return;
  }

  const poseModelMatch = path.match(/^\/api\/pose-models\/([^/]+)$/);
  if (method === "GET" && poseModelMatch) {
    await serveReleaseAsset(res, poseModelMatch[1]!, "pose");
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

  const pasteSourceCreateMatch = path.match(/^\/api\/projects\/([^/]+)\/paste-sources$/);
  if (method === "POST" && pasteSourceCreateMatch) {
    sendJson(res, 201, await createPasteSource(pasteSourceCreateMatch[1]!, await readJson(req)));
    return;
  }

  const pasteSourceServeMatch = path.match(/^\/api\/projects\/([^/]+)\/paste-sources\/([^/]+)$/);
  if (method === "GET" && pasteSourceServeMatch) {
    servePasteSource(res, pasteSourceServeMatch[1]!, pasteSourceServeMatch[2]!);
    return;
  }

  const pasteAttachmentsMatch = path.match(/^\/api\/assets\/([^/]+)\/paste-attachments$/);
  if (method === "GET" && pasteAttachmentsMatch) {
    sendJson(res, 200, getPasteAttachments(pasteAttachmentsMatch[1]!));
    return;
  }
  if (method === "PUT" && pasteAttachmentsMatch) {
    sendJson(res, 200, putPasteAttachments(pasteAttachmentsMatch[1]!, await readJson(req)));
    return;
  }

  const roundAttachmentMatch = path.match(/^\/api\/rounds\/([^/]+)\/attachments\/(mask|pose)$/);
  if (method === "GET" && roundAttachmentMatch) {
    serveRoundAttachment(res, roundAttachmentMatch[1]!, roundAttachmentMatch[2]! as "mask" | "pose");
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

  if (method === "POST" && path === "/api/rounds/restore") {
    sendJson(res, 200, restoreRounds(await readJson(req)));
    return;
  }

  // プロジェクトを離れる時に呼ばれ、そのセッションの削除を確定(復元不能に)する。
  if (method === "POST" && path === "/api/rounds/trash/discard") {
    const body = await readJson(req);
    const rootIds = Array.isArray((body as Record<string, unknown>)?.rootIds)
      ? ((body as Record<string, unknown>).rootIds as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
    let discarded = 0;
    for (const rootId of rootIds) {
      try {
        discardRoundTrashSnapshot(rootId);
        discarded += 1;
      } catch {
        // 不正な id は無視する(パストラバーサル対策の検証エラー)。
      }
    }
    sendJson(res, 200, { discarded });
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

async function serveReleaseAsset(res: ServerResponse, filename: string, label: string) {
  const releaseApiUrl = releaseAssetRegistry.get(filename);
  if (!releaseApiUrl) {
    sendJson(res, 404, { error: `${label} model asset was not found` });
    return;
  }

  const token = githubToken();
  if (!token) {
    sendJson(res, 503, {
      error: `GitHub token is required to download ${label} models from this private repository release.`,
      env: "Set GURUGURU_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN before starting GURUGURU."
    });
    return;
  }

  const release = await fetchGithubJson<{ assets?: Array<{ name?: string; url?: string; size?: number; content_type?: string }> }>(
    releaseApiUrl,
    token
  );
  const asset = release.assets?.find((item) => item.name === filename);
  if (!asset?.url) {
    sendJson(res, 404, { error: `${label} model asset was not found in the GitHub release` });
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
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const command = text.trim().toLowerCase();
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
