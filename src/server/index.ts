import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dataRoot, dbPath, getRow, initializeDb, instanceMode, setSetting } from "./db";
import { discardRoundTrashSnapshot, purgeAllRoundTrash } from "./roundTrash";
import { getComfyStatus, testComfyConnection } from "./comfy";
import { checkModels, listAvailableLoras } from "./modelCheck";
import { installModelPreset } from "./modelPresets";
import { getLlmSettings, getLlmStatus, improvePromptWithLlm, testLlmConnection, toLlmSettingsView } from "./llm";
import { getVlmAuditSettings, getVlmAuditStatus } from "./vlmAudit";
import { serveStatic } from "./files";
import { HttpError, readJson, sendJson } from "./http";
import { nonEmptyStringOr, numberOr, stringOr } from "./validate";
import { createTemplate, deleteTemplate, listTemplates, updateTemplatePromptProfile } from "./templates";
import { adoptCharacterSheetAsset, createCharacterSheetRun } from "./characterSheets";
import {
  approveReferenceSet,
  createReferenceSet,
  listProjectReferenceSets,
  serveReferenceSetImage,
  uploadReferenceSetImage
} from "./referenceSets";
import { generateReferenceSetCandidates } from "./referenceSetGeneration";
import { serveAssetFile, updateAssetStatus } from "./assets";
import { createProject, deleteProject, getProjectDetail, listProjects } from "./projects";
import {
  createPage,
  deletePage,
  getPageDetail,
  importImageAsPage,
  listPagesWithProject,
  listRecentImages,
  reorderPages,
  updatePage,
  updatePageLayout,
  updatePageMosaic,
  updatePageObjects,
  updatePagePanelAssignment
} from "./pages";
import {
  deleteLayoutTemplate,
  exportLayoutTemplate,
  exportPageLayout,
  importLayoutTemplate,
  listLayoutTemplates,
  refreshScriptMangaLayoutCandidates
} from "./layoutTemplates";
import { createPagePreviewPng, withOpenRasterExport } from "./openRasterExport";
import { createPageMedia, servePageMedia } from "./pageMedia";
import { withImageExport } from "./imageExport";
import { streamFileExport } from "./fileExport";
import { listFonts } from "./fonts";
import { computeTextLayout } from "./textLayoutApi";
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
  createCharacter,
  deleteCharacter,
  getCharacterBinding,
  listCharacters,
  putCharacterBinding,
  serveCharacterFaceImage,
  updateCharacter
} from "./characters";
import {
  addScriptRevision,
  createScript,
  deleteScript,
  getScript,
  getScriptRevision,
  listScriptRevisions,
  listScripts
} from "./scripts";
import {
  createDialogueLine,
  createDialoguePlacement,
  deleteDialogueLine,
  deleteDialoguePlacement,
  listDialogueLines,
  updateDialogueLine,
  updateDialoguePlacement
} from "./dialogueLines";
import {
  adoptDialogueProposalItems,
  createDialogueProposal,
  listDialogueProposals,
  rejectDialogueProposalItems
} from "./dialogueProposals";
import { getChronicle } from "./chronicle";
import { allocateDialoguePages, removeDialogueAllocation } from "./dialogueAllocation";
import { applyDialogueLayout, previewDialogueLayout, reflowDialogueLayout, unlockAllDialoguePlacementsForPage } from "./dialogueAutoLayoutApi";
import {
  approveScriptMangaRun,
  auditScriptMangaTask,
  cancelScriptMangaRun,
  createScriptMangaRun,
  withScriptMangaRunExport,
  getScriptMangaPlan,
  getScriptMangaRun,
  recordExternalScriptMangaTaskAudit,
  resumeScriptMangaRun,
  repairScriptMangaTask,
  retryScriptMangaTask,
  selectScriptMangaTaskCandidate,
  applyNamePlanEdits,
  startScriptMangaRun,
  updateScriptMangaPlan
} from "./scriptManga";
import {
  adoptScriptMangaPlanCandidate,
  archiveScriptMangaPlanCandidate,
  createScriptMangaPlanCandidates,
  importScriptMangaPlanCandidate,
  listScriptMangaPlanCandidates,
  requirePlanCandidate,
  setCandidateCustomLayout,
  setCandidateLayoutOverride
} from "./scriptMangaPlanCandidates";
import { preflightScriptMangaCandidate } from "./scriptMangaCandidatePreflight";
import { applySpeakerAnchors } from "./speakerAnchors";
import { importProjectFromStream, withProjectExportArchive } from "./projectTransfer";
import { fitPageBalloonText } from "./balloonTextFit";
import {
  DEFAULT_WEB_SAM_MODEL_BASE_URL,
  GITHUB_POSE_CIGPOSE_RELEASE_BASE_URL,
  GITHUB_POSE_RELEASE_BASE_URL,
  GITHUB_WEB_SAM_RELEASE_BASE_URL
} from "../shared/constants";
import type { ComfySettings, GenerationRequest, LlmSettings, VlmAuditSettings } from "../shared/types";

const port = Number(process.env.PORT ?? 5177);
const host = process.env.HOST?.trim() || undefined;
let isShuttingDown = false;

const releaseAssetRegistry = new Map<string, string>([
  ["slimsam-77-encoder.onnx", GITHUB_WEB_SAM_RELEASE_BASE_URL],
  ["slimsam-77-decoder.onnx", GITHUB_WEB_SAM_RELEASE_BASE_URL],
  ["pose_landmarker_full.task", GITHUB_POSE_RELEASE_BASE_URL],
  ["pose_landmarker_heavy.task", GITHUB_POSE_RELEASE_BASE_URL],
  ["yolox_nano.onnx", GITHUB_POSE_CIGPOSE_RELEASE_BASE_URL],
  ["cigpose-l_coco_384x288.onnx", GITHUB_POSE_CIGPOSE_RELEASE_BASE_URL],
  ["cigpose-x_coco-wholebody_384x288.onnx", GITHUB_POSE_CIGPOSE_RELEASE_BASE_URL]
]);

initializeDb();
// 取り込みテンプレの自動漫画候補プール(ネームv4 D6)を起動時に構築する。
refreshScriptMangaLayoutCandidates();

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

server.listen(port, host, () => {
  console.log(`GURUGURU listening on http://${host ?? "127.0.0.1"}:${port} (${instanceMode})`);
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

/**
 * API ルートハンドラ。params は pattern(RegExp)の捕捉グループ(match.slice(1))。
 * 文字列 pattern(完全一致)の場合は空配列。
 */
type ApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  params: string[]
) => void | Promise<void>;

/**
 * 宣言的ルート: [method, pattern, handler]。テーブルは上から順に評価され、最初に
 * method+pattern が一致した 1 件だけが実行される。順序依存(例: /pages/reorder は
 * /pages/:pageId より前)はテーブルの並び順そのもので表現する。
 */
type ApiRoute = readonly [method: string, pattern: string | RegExp, handler: ApiHandler];

// PATCH/PUT の両方で同じテンプレ更新を受ける(従来挙動)。
const updateTemplateHandler: ApiHandler = async (req, res, _url, p) => {
  sendJson(res, 200, { template: updateTemplatePromptProfile(p[0]!, await readJson(req)) });
};

const apiRoutes: ApiRoute[] = [
  // --- ヘルス / エージェント情報 ---
  ["GET", "/api/health", (_req, res) => {
    sendJson(res, 200, { ok: true, instanceMode });
  }],
  ["GET", "/api/agent/capabilities", (_req, res) => {
    sendJson(res, 200, {
      apiVersion: 2,
      instanceMode,
      agentReady: instanceMode === "agent",
      endpoints: {
        installAnimaPreset: "POST /api/model-presets/anima",
        modelCheck: "GET /api/comfy/model-check?family=anima",
        importSourceAsset: "POST /api/projects/:projectId/source-assets",
        generate: "POST /api/projects/:projectId/rounds",
        collect: "POST /api/rounds/:roundId/collect",
        llmStatus: "GET /api/llm/status",
        vlmAuditStatus: "GET /api/vlm-audit/status",
        importScriptMangaCandidate: "POST /api/projects/:projectId/script-manga-plan-candidates/import",
        preflightScriptMangaCandidate: "POST /api/script-manga-plan-candidates/:candidateId/preflight",
        adoptScriptMangaCandidate: "POST /api/script-manga-plan-candidates/:candidateId/adopt",
        recordScriptMangaAudit: "POST /api/script-manga-tasks/:taskId/audit-results"
      },
      anima: {
        baseModel: "animaInt8Mxfp8_aestheticV11Int8.safetensors",
        modes: ["txt2img", "img2img", "inpaint", "controlnet", "inpaint+controlnet"],
        imageTransport: "data-url",
        inpaintMaskField: "inpaint.maskDataUrl",
        controlImageField: "controlnet.poseImageDataUrl"
      }
    });
  }],

  // --- ComfyUI 設定・状態 ---
  ["GET", "/api/settings/comfy", (_req, res) => {
    const settings = getSettingOrDefault();
    sendJson(res, 200, settings);
  }],
  ["PUT", "/api/settings/comfy", async (req, res) => {
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
  }],
  ["POST", "/api/comfy/test", async (_req, res) => {
    sendJson(res, 200, await testComfyConnection());
  }],
  ["GET", "/api/comfy/status", async (_req, res) => {
    sendJson(res, 200, await getComfyStatus());
  }],
  ["GET", "/api/comfy/model-check", async (_req, res, url) => {
    const family = url.searchParams.get("family");
    if (family !== "chroma" && family !== "anima") {
      sendJson(res, 404, { error: `Unknown model family: ${family}` });
      return;
    }
    sendJson(res, 200, await checkModels(family));
  }],
  ["POST", /^\/api\/model-presets\/(chroma|anima)$/, (_req, res, _url, p) => {
    sendJson(res, 200, installModelPreset(p[0] as "chroma" | "anima"));
  }],
  ["GET", "/api/comfy/loras", async (_req, res) => {
    sendJson(res, 200, await listAvailableLoras());
  }],

  // --- LLM / VLM 監査設定 ---
  ["GET", "/api/settings/llm", (_req, res) => {
    sendJson(res, 200, toLlmSettingsView(getLlmSettings()));
  }],
  ["PUT", "/api/settings/llm", async (req, res) => {
    const body = await readJson<Partial<LlmSettings> & { clearApiKey?: boolean }>(req);
    const currentSettings = getLlmSettings();
    // apiKey はフィールド単位の部分更新(既知の罠11: GET が生の値を返さないため、未指定=維持が既定。
    // 空文字/未指定は現在値を維持、`clearApiKey: true` で明示的に削除する -- character binding の
    // faceImageDataUrl/clearFaceImage と同型)。
    const apiKey =
      body.clearApiKey === true
        ? undefined
        : typeof body.apiKey === "string" && body.apiKey.trim()
          ? body.apiKey.trim()
          : currentSettings.apiKey;
    const settings: LlmSettings = {
      baseUrl: stringOr(body.baseUrl, currentSettings.baseUrl).trim().replace(/\/+$/, ""),
      model: stringOr(body.model, currentSettings.model).trim(),
      systemPrompt: stringOr(body.systemPrompt, currentSettings.systemPrompt),
      temperature: Math.min(2, Math.max(0, numberOr(body.temperature, currentSettings.temperature))),
      ...(apiKey ? { apiKey } : {})
    };
    setSetting("llm", settings);
    sendJson(res, 200, toLlmSettingsView(settings));
  }],
  ["POST", "/api/llm/test", async (_req, res) => {
    sendJson(res, 200, await testLlmConnection());
  }],
  ["GET", "/api/llm/status", async (_req, res) => {
    sendJson(res, 200, await getLlmStatus());
  }],
  ["GET", "/api/settings/vlm-audit", (_req, res) => {
    sendJson(res, 200, getVlmAuditSettings());
  }],
  ["PUT", "/api/settings/vlm-audit", async (req, res) => {
    const body = await readJson<Partial<VlmAuditSettings>>(req);
    const current = getVlmAuditSettings();
    const settings: VlmAuditSettings = {
      baseUrl: stringOr(body.baseUrl, current.baseUrl).trim().replace(/\/+$/, ""),
      model: stringOr(body.model, current.model).trim(),
      transport: body.transport === "openai-compatible" || body.transport === "lmstudio-native"
        ? body.transport
        : current.transport ?? "lmstudio-native",
      modelKey: stringOr(body.modelKey, current.modelKey ?? current.model).trim(),
      temperature: Math.min(2, Math.max(0, numberOr(body.temperature, current.temperature))),
      timeoutSeconds: Math.min(600, Math.max(5, numberOr(body.timeoutSeconds, current.timeoutSeconds))),
      maxReferenceImages: Math.min(6, Math.max(0, Math.trunc(numberOr(body.maxReferenceImages, current.maxReferenceImages)))),
      passThreshold: Math.min(1, Math.max(0, numberOr(body.passThreshold, current.passThreshold))),
      contextLength: Math.min(32768, Math.max(1024, Math.trunc(numberOr(body.contextLength, current.contextLength ?? 4096)))),
      manageModelLifecycle: typeof body.manageModelLifecycle === "boolean" ? body.manageModelLifecycle : current.manageModelLifecycle,
      releaseComfyBeforeAudit: typeof body.releaseComfyBeforeAudit === "boolean" ? body.releaseComfyBeforeAudit : current.releaseComfyBeforeAudit,
      unloadAfterAudit: typeof body.unloadAfterAudit === "boolean" ? body.unloadAfterAudit : current.unloadAfterAudit
    };
    setSetting("vlm_audit", settings);
    sendJson(res, 200, settings);
  }],
  ["GET", "/api/vlm-audit/status", async (_req, res) => {
    sendJson(res, 200, await getVlmAuditStatus());
  }],
  ["POST", "/api/llm/improve-prompt", async (req, res) => {
    const body = await readJson<{ prompt?: string; negativePrompt?: string }>(req);
    const improved = await improvePromptWithLlm(
      stringOr(body.prompt, ""),
      typeof body.negativePrompt === "string" ? body.negativePrompt : undefined
    );
    sendJson(res, 200, { prompt: improved });
  }],

  // --- WebSAM / pose モデル資材(GitHub Release 中継) ---
  ["GET", /^\/api\/websam-models\/([^/]+)$/, async (_req, res, _url, p) => {
    await serveReleaseAsset(res, p[0]!, "WebSAM");
  }],
  ["GET", /^\/api\/pose-models\/([^/]+)$/, async (_req, res, _url, p) => {
    await serveReleaseAsset(res, p[0]!, "pose");
  }],

  // --- 生成テンプレート ---
  ["GET", "/api/templates", (_req, res) => {
    sendJson(res, 200, { templates: listTemplates() });
  }],
  ["POST", "/api/templates", async (req, res) => {
    sendJson(res, 201, { template: createTemplate(await readJson(req)) });
  }],
  ["PATCH", /^\/api\/templates\/([^/]+)$/, updateTemplateHandler],
  ["PUT", /^\/api\/templates\/([^/]+)$/, updateTemplateHandler],
  ["DELETE", /^\/api\/templates\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, deleteTemplate(p[0]!));
  }],

  // --- コマ割りテンプレート(漫画レイアウト)。グローバル(全Book共通)。 ---
  ["GET", "/api/layout-templates", (_req, res) => {
    sendJson(res, 200, { templates: listLayoutTemplates() });
  }],
  ["POST", "/api/layout-templates", async (req, res) => {
    sendJson(res, 201, importLayoutTemplate(await readJson(req)));
  }],
  // テンプレートの .guruguru-layout.json5 書き出し(SPEC v0.3 §27、内蔵/取り込みの両対応)。
  ["GET", /^\/api\/layout-templates\/([^/]+)\/export$/, (_req, res, _url, p) => {
    const result = exportLayoutTemplate(decodeURIComponent(p[0]!));
    const body = Buffer.from(result.json5, "utf8");
    res.writeHead(200, {
      "content-type": "application/json5; charset=utf-8",
      "content-length": String(body.byteLength),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`
    });
    res.end(body);
  }],
  ["DELETE", /^\/api\/layout-templates\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, deleteLayoutTemplate(p[0]!));
  }],

  // --- プロジェクト(import は /:projectId より前に置く) ---
  ["GET", "/api/projects", (_req, res) => {
    sendJson(res, 200, { projects: listProjects() });
  }],
  ["POST", "/api/projects", async (req, res) => {
    sendJson(res, 201, { project: createProject(await readJson(req)) });
  }],
  // .guruzip プロジェクトインポート(Docs/Feature-ProjectImportExport.md §5)。ボディはZIP
  // バイナリそのもの(multipart にはしない)。
  ["POST", "/api/projects/import", async (req, res) => {
    const result = await importProjectFromStream(req);
    sendJson(res, 201, result);
  }],
  ["GET", /^\/api\/projects\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, getProjectDetail(p[0]!, { ensureRoundMonitor }));
  }],
  ["DELETE", /^\/api\/projects\/([^/]+)$/, async (_req, res, _url, p) => {
    sendJson(res, 200, await deleteProject(p[0]!));
  }],
  // .guruzip プロジェクトエクスポート(Docs/Feature-ProjectImportExport.md §5)。
  ["GET", /^\/api\/projects\/([^/]+)\/export$/, async (_req, res, _url, p) => {
    await withProjectExportArchive(p[0]!, async (result) => {
      res.writeHead(200, {
        "content-type": result.contentType,
        "content-length": String(result.byteLength),
        "content-disposition": `attachment; filename="${result.filename}"`
      });
      try {
        await pipeline(createReadStream(result.archivePath), res);
      } catch {
        // 応答header送信後の切断・読込失敗ではJSONエラーへ切り替えられない。接続を閉じ、
        // withProjectExportArchiveのfinallyで一時ZIPを削除する。
        if (!res.destroyed) {
          res.destroy();
        }
      }
    });
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/openraster-export$/, async (req, res, _url, p) => {
    await withOpenRasterExport(p[0]!, await readJson(req), (result) => streamFileExport(res, result));
  }],
  // 完成品の画像一括書き出し(Docs/Feature-CGCollectionSuite.md P4)。PNG/JPEG 連番(単ページは画像単体)。
  // format="pptx"(Docs/Feature-PptxExport.md)は同じエンドポイントで、常に単一 .pptx を返す。
  ["POST", /^\/api\/projects\/([^/]+)\/export-images$/, async (req, res, _url, p) => {
    await withImageExport(p[0]!, await readJson(req), (result) => streamFileExport(res, result));
  }],

  // --- Book のページ操作(/pages/reorder・/pages/import-image は /pages/:pageId より前) ---
  ["GET", /^\/api\/projects\/([^/]+)\/pages$/, (_req, res, _url, p) => {
    sendJson(res, 200, listPagesWithProject(p[0]!));
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/pages$/, async (req, res, _url, p) => {
    sendJson(res, 201, { page: createPage(p[0]!, await readJson(req)) });
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/pages\/reorder$/, async (req, res, _url, p) => {
    sendJson(res, 200, reorderPages(p[0]!, await readJson(req)));
  }],
  // 画像を新規ページとして取り込む(複数インポートの1枚分)。
  ["POST", /^\/api\/projects\/([^/]+)\/pages\/import-image$/, async (req, res, _url, p) => {
    sendJson(res, 201, await importImageAsPage(p[0]!, await readJson(req)));
  }],
  ["GET", /^\/api\/projects\/([^/]+)\/reference-images$/, async (_req, res, url, p) => {
    const limit = Number(url.searchParams.get("limit")) || 24;
    sendJson(res, 200, { images: await listRecentImages(p[0]!, limit) });
  }],
  ["GET", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/preview\.png$/, async (_req, res, url, p) => {
    const size = Number(url.searchParams.get("size")) || 512;
    const buffer = await createPagePreviewPng(p[0]!, p[1]!, { size });
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(buffer.byteLength),
      "cache-control": url.searchParams.has("v")
        ? "private, max-age=31536000, immutable"
        : "private, max-age=60"
    });
    res.end(buffer);
  }],
  ["GET", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, getPageDetail(p[0]!, p[1]!, { ensureRoundMonitor }));
  }],
  ["PATCH", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)$/, async (req, res, _url, p) => {
    sendJson(res, 200, { page: updatePage(p[0]!, p[1]!, await readJson(req)) });
  }],
  ["DELETE", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, deletePage(p[0]!, p[1]!));
  }],

  // --- ページ内オブジェクト・レイアウト編集 ---
  // コマ内生成(Docs/Feature-PanelGeneration.md): コマへの画像割り当て/クロップの更新。
  ["PATCH", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/panels\/([^/]+)\/assignment$/, async (req, res, _url, p) => {
    sendJson(res, 200, updatePagePanelAssignment(p[0]!, p[1]!, p[2]!, await readJson(req)));
  }],
  // ページオブジェクト(Docs/Feature-CGCollectionSuite.md P1): テキスト/吹き出し/ボックスの配列を丸ごと置換する。
  ["PATCH", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/objects$/, async (req, res, _url, p) => {
    sendJson(res, 200, updatePageObjects(p[0]!, p[1]!, await readJson(req)));
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/speaker-anchors$/, async (req, res, _url, p) => {
    sendJson(res, 200, applySpeakerAnchors(p[0]!, p[1]!, await readJson(req)));
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/fit-balloon-text$/, (_req, res, _url, p) => {
    sendJson(res, 200, fitPageBalloonText(p[0]!, p[1]!));
  }],
  // ImageObject(Docs/Feature-ScriptToManga.md S2): 配置時に Asset 画像を page_media へコピーする。
  ["POST", /^\/api\/projects\/([^/]+)\/page-media$/, async (req, res, _url, p) => {
    sendJson(res, 201, await createPageMedia(p[0]!, await readJson(req)));
  }],
  ["GET", /^\/api\/page-media\/([^/]+)$/, (_req, res, _url, p) => {
    servePageMedia(res, p[0]!);
  }],
  // コマ形状編集(Docs/Feature-CGCollectionSuite.md P5): レイアウト(panels の shape/order 等)を丸ごと置換する。
  // ページの現在のコマ枠+吹き出し+テキストを .guruguru-layout.json5 へ書き出す(SPEC v0.3 §27)。
  ["GET", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/export-layout$/, (_req, res, _url, p) => {
    const result = exportPageLayout(p[0]!, p[1]!);
    const body = Buffer.from(result.json5, "utf8");
    res.writeHead(200, {
      "content-type": "application/json5; charset=utf-8",
      "content-length": String(body.byteLength),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`
    });
    res.end(body);
  }],
  ["PATCH", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/layout$/, async (req, res, _url, p) => {
    sendJson(res, 200, updatePageLayout(p[0]!, p[1]!, await readJson(req)));
  }],
  // モザイク(Docs/Feature-CGCollectionSuite.md P6): 非破壊リージョンの配列を丸ごと置換する。
  ["PATCH", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/mosaic$/, async (req, res, _url, p) => {
    sendJson(res, 200, updatePageMosaic(p[0]!, p[1]!, await readJson(req)));
  }],

  // --- テキストオブジェクト(Docs/Feature-CGCollectionSuite.md P2): フォント一覧+自前レイアウト計算 ---
  ["GET", "/api/fonts", (_req, res) => {
    sendJson(res, 200, { fonts: listFonts() });
  }],
  ["POST", "/api/text-layout", async (req, res) => {
    sendJson(res, 200, computeTextLayout(await readJson(req)));
  }],

  // --- 生成ラウンド(作成) ---
  ["POST", /^\/api\/projects\/([^/]+)\/rounds$/, async (req, res, _url, p) => {
    const roundBody = await readJson<GenerationRequest & { pageId?: string | null; targetPanelId?: string | null }>(req);
    sendJson(
      res,
      201,
      await createGenerationRound(p[0]!, roundBody, roundBody.pageId ?? null, roundBody.targetPanelId ?? null)
    );
  }],

  // --- Script-Manga(Fountain → 自動コマ割り → コマ別画像生成 → 吹き出し完成の一括実行) ---
  ["POST", /^\/api\/projects\/([^/]+)\/script-manga-runs$/, async (req, res, _url, p) => {
    const body = await readJson<Record<string, unknown>>(req);
    if (body && typeof body === "object" && !Array.isArray(body) && typeof body.planCandidateId === "string") {
      throw new HttpError(
        400,
        "Adopt plan candidates through POST /api/script-manga-plan-candidates/:candidateId/adopt so full preflight cannot be bypassed"
      );
    }
    sendJson(res, 201, await createScriptMangaRun(p[0]!, body));
  }],
  ["GET", /^\/api\/script-manga-runs\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, getScriptMangaRun(p[0]!));
  }],
  // プラン候補(ネームv4 D3): 複数生成して見比べ、専用adopt APIでfull preflight後に採用する。
  ["POST", /^\/api\/projects\/([^/]+)\/script-manga-plan-candidates$/, async (req, res, _url, p) => {
    sendJson(res, 201, await createScriptMangaPlanCandidates(p[0]!, await readJson(req)));
  }],
  ["GET", /^\/api\/projects\/([^/]+)\/script-manga-plan-candidates$/, (_req, res, url, p) => {
    const scriptId = url.searchParams.get("scriptId") ?? "";
    sendJson(res, 200, listScriptMangaPlanCandidates(p[0]!, scriptId));
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/script-manga-plan-candidates\/import$/, async (req, res, _url, p) => {
    sendJson(res, 201, importScriptMangaPlanCandidate(p[0]!, await readJson(req)));
  }],
  // 候補採用。本体は scriptMangaPlanCandidates.adoptScriptMangaPlanCandidate(冪等リプレイ含む)。
  ["POST", /^\/api\/script-manga-plan-candidates\/([^/]+)\/adopt$/, async (req, res, _url, p) => {
    const result = await adoptScriptMangaPlanCandidate(p[0]!, () => readJson<Record<string, unknown>>(req));
    sendJson(res, result.status, result.body);
  }],
  ["POST", /^\/api\/script-manga-plan-candidates\/([^/]+)\/preflight$/, async (req, res, _url, p) => {
    const candidateId = p[0]!;
    const candidate = requirePlanCandidate(candidateId);
    sendJson(res, 200, await preflightScriptMangaCandidate(candidate.project_id, candidateId, await readJson(req)));
  }],
  ["POST", /^\/api\/script-manga-plan-candidates\/([^/]+)\/archive$/, (_req, res, _url, p) => {
    sendJson(res, 200, archiveScriptMangaPlanCandidate(p[0]!));
  }],
  // V5 D5: ページ別レイアウトフリップ(基礎プラン不変+layout overrides+楽観ロック)。
  ["POST", /^\/api\/script-manga-plan-candidates\/([^/]+)\/set-layout$/, async (req, res, _url, p) => {
    sendJson(res, 200, setCandidateLayoutOverride(p[0]!, await readJson(req)));
  }],
  // 人間ゲートのコマ割り修正(編集済みPageLayout+吹き出し位置ヒント、テンプレ選択より優先)。
  ["POST", /^\/api\/script-manga-plan-candidates\/([^/]+)\/set-custom-layout$/, async (req, res, _url, p) => {
    sendJson(res, 200, setCandidateCustomLayout(p[0]!, await readJson(req)));
  }],
  ["GET", /^\/api\/script-manga-plans\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, getScriptMangaPlan(p[0]!));
  }],
  // V5 D6: スタジオ用ホワイトリスト差分編集(完全V2のPATCHは successor/provided 系ツール向けに残置)。
  ["POST", /^\/api\/script-manga-plans\/([^/]+)\/edits$/, async (req, res, _url, p) => {
    sendJson(res, 200, applyNamePlanEdits(p[0]!, await readJson(req)));
  }],
  ["PATCH", /^\/api\/script-manga-plans\/([^/]+)$/, async (req, res, _url, p) => {
    sendJson(res, 200, updateScriptMangaPlan(p[0]!, await readJson(req)));
  }],
  ["POST", /^\/api\/script-manga-runs\/([^/]+)\/export$/, async (req, res, _url, p) => {
    await withScriptMangaRunExport(p[0]!, await readJson(req), (result) => streamFileExport(res, result));
  }],
  ["POST", /^\/api\/script-manga-runs\/([^/]+)\/(approve|start|resume|cancel)$/, async (_req, res, _url, p) => {
    const [runId, action] = p;
    const result = action === "approve"
      ? approveScriptMangaRun(runId!)
      : action === "start"
        ? await startScriptMangaRun(runId!)
        : action === "resume"
          ? await resumeScriptMangaRun(runId!)
          : await cancelScriptMangaRun(runId!);
    sendJson(res, 200, result);
  }],
  ["POST", /^\/api\/script-manga-tasks\/([^/]+)\/(retry|select|audit|repair)$/, async (req, res, _url, p) => {
    sendJson(
      res,
      200,
      p[1] === "retry"
        ? await retryScriptMangaTask(p[0]!)
        : p[1] === "audit"
          ? await auditScriptMangaTask(p[0]!)
          : p[1] === "repair"
            ? await repairScriptMangaTask(p[0]!, await readJson(req))
          : await selectScriptMangaTaskCandidate(p[0]!, await readJson(req))
    );
  }],
  ["POST", /^\/api\/script-manga-tasks\/([^/]+)\/audit-results$/, async (req, res, _url, p) => {
    sendJson(res, 200, recordExternalScriptMangaTaskAudit(p[0]!, await readJson(req)));
  }],

  // --- 素材アセット / ペースト画像 ---
  ["POST", /^\/api\/projects\/([^/]+)\/source-assets$/, async (req, res, _url, p) => {
    sendJson(res, 201, await createSourceAsset(p[0]!, await readJson(req)));
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/paste-sources$/, async (req, res, _url, p) => {
    sendJson(res, 201, await createPasteSource(p[0]!, await readJson(req)));
  }],
  ["GET", /^\/api\/projects\/([^/]+)\/paste-sources\/([^/]+)$/, (_req, res, _url, p) => {
    servePasteSource(res, p[0]!, p[1]!);
  }],
  ["GET", /^\/api\/assets\/([^/]+)\/paste-attachments$/, (_req, res, _url, p) => {
    sendJson(res, 200, getPasteAttachments(p[0]!));
  }],
  ["PUT", /^\/api\/assets\/([^/]+)\/paste-attachments$/, async (req, res, _url, p) => {
    sendJson(res, 200, putPasteAttachments(p[0]!, await readJson(req)));
  }],

  // --- 生成ラウンド(添付・回収・削除) ---
  ["GET", /^\/api\/rounds\/([^/]+)\/attachments\/(mask|pose|reference)$/, (_req, res, _url, p) => {
    serveRoundAttachment(res, p[0]!, p[1]! as "mask" | "pose" | "reference");
  }],
  ["POST", /^\/api\/rounds\/([^/]+)\/collect$/, async (_req, res, _url, p) => {
    const result = await collectRound(p[0]!);
    sendJson(res, result.statusCode, result.body);
  }],
  ["POST", /^\/api\/rounds\/([^/]+)\/interrupt$/, async (_req, res, _url, p) => {
    sendJson(res, 200, await interruptRound(p[0]!));
  }],
  ["POST", "/api/rounds/restore", async (req, res) => {
    sendJson(res, 200, restoreRounds(await readJson(req)));
  }],
  // プロジェクトを離れる時に呼ばれ、そのセッションの削除を確定(復元不能に)する。
  ["POST", "/api/rounds/trash/discard", async (req, res) => {
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
  }],
  ["DELETE", /^\/api\/rounds\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, deleteRoundTree(p[0]!));
  }],

  // --- 脚本ドメイン(Docs/Feature-ScriptToManga.md S3): Character / 参照セット ---
  ["GET", /^\/api\/projects\/([^/]+)\/characters$/, (_req, res, _url, p) => {
    sendJson(res, 200, { characters: listCharacters(p[0]!) });
  }],
  ["GET", /^\/api\/projects\/([^/]+)\/reference-sets$/, (_req, res, _url, p) => {
    sendJson(res, 200, { referenceSets: listProjectReferenceSets(p[0]!) });
  }],
  ["POST", /^\/api\/characters\/([^/]+)\/reference-sets$/, async (req, res, _url, p) => {
    sendJson(res, 201, { referenceSet: createReferenceSet(p[0]!, await readJson(req)) });
  }],
  ["PUT", /^\/api\/reference-sets\/([^/]+)\/images\/(face|full_body)$/, async (req, res, _url, p) => {
    sendJson(res, 200, { referenceSet: await uploadReferenceSetImage(p[0]!, p[1]!, await readJson(req)) });
  }],
  ["POST", /^\/api\/reference-sets\/([^/]+)\/(generate|approve)$/, async (req, res, _url, p) => {
    const result = p[1] === "generate"
      ? await generateReferenceSetCandidates(p[0]!, await readJson(req))
      : await approveReferenceSet(p[0]!, await readJson(req));
    sendJson(res, p[1] === "generate" ? 202 : 200,
      p[1] === "generate" ? result : { referenceSet: result });
  }],
  ["GET", /^\/api\/reference-images\/([^/]+)$/, (_req, res, _url, p) => {
    serveReferenceSetImage(res, p[0]!);
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/characters$/, async (req, res, _url, p) => {
    sendJson(res, 201, { character: createCharacter(p[0]!, await readJson(req)) });
  }],
  ["GET", /^\/api\/characters\/([^/]+)\/bindings\/([^/]+)\/face-image$/, (_req, res, _url, p) => {
    serveCharacterFaceImage(res, p[0]!, p[1]!);
  }],
  ["GET", /^\/api\/characters\/([^/]+)\/bindings\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, getCharacterBinding(p[0]!, p[1]!));
  }],
  ["PUT", /^\/api\/characters\/([^/]+)\/bindings\/([^/]+)$/, async (req, res, _url, p) => {
    sendJson(res, 200, await putCharacterBinding(p[0]!, p[1]!, await readJson(req)));
  }],
  ["POST", /^\/api\/characters\/([^/]+)\/character-sheet$/, async (req, res, _url, p) => {
    sendJson(res, 202, await createCharacterSheetRun(p[0]!, await readJson(req)));
  }],
  ["POST", /^\/api\/characters\/([^/]+)\/character-sheet\/adopt$/, async (req, res, _url, p) => {
    const input = await readJson(req) as Record<string, unknown>;
    sendJson(res, 200, await adoptCharacterSheetAsset(p[0]!, String(input.assetId ?? ""), String(input.providerId ?? "comfy")));
  }],
  ["PATCH", /^\/api\/characters\/([^/]+)$/, async (req, res, _url, p) => {
    sendJson(res, 200, { character: updateCharacter(p[0]!, await readJson(req)) });
  }],
  ["DELETE", /^\/api\/characters\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, deleteCharacter(p[0]!));
  }],

  // --- 脚本(Script / Revision) ---
  ["GET", /^\/api\/projects\/([^/]+)\/scripts$/, (_req, res, _url, p) => {
    sendJson(res, 200, { scripts: listScripts(p[0]!) });
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/scripts$/, async (req, res, _url, p) => {
    sendJson(res, 201, createScript(p[0]!, await readJson(req)));
  }],
  ["GET", /^\/api\/scripts\/([^/]+)\/revisions\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, getScriptRevision(p[0]!, Number(p[1])));
  }],
  // GET は設計書のルート表に明示は無いが、クライアントが「最新 revision」を O(revision数) の
  // ポーリング無しで解決するために追加した(scripts.ts の listScriptRevisions を配線するだけ)。
  ["GET", /^\/api\/scripts\/([^/]+)\/revisions$/, (_req, res, _url, p) => {
    sendJson(res, 200, { revisions: listScriptRevisions(p[0]!) });
  }],
  ["POST", /^\/api\/scripts\/([^/]+)\/revisions$/, async (req, res, _url, p) => {
    sendJson(res, 201, addScriptRevision(p[0]!, await readJson(req)));
  }],
  ["GET", /^\/api\/scripts\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, { script: getScript(p[0]!) });
  }],
  ["DELETE", /^\/api\/scripts\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, deleteScript(p[0]!));
  }],

  // --- セリフ(DialogueLine / Placement / Chronicle / 一括配置) ---
  ["GET", /^\/api\/projects\/([^/]+)\/dialogue-lines$/, (_req, res, url, p) => {
    sendJson(res, 200, {
      lines: listDialogueLines(p[0]!, {
        pageId: url.searchParams.get("pageId") ?? undefined,
        scriptId: url.searchParams.get("scriptId") ?? undefined,
        status: url.searchParams.get("status") ?? undefined
      })
    });
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/dialogue-lines$/, async (req, res, _url, p) => {
    sendJson(res, 201, { line: createDialogueLine(p[0]!, await readJson(req)) });
  }],
  // Chronicle Page Flow(S5、Docs/Done/Feature-ChroniclePageFlow.md §3)。
  ["GET", /^\/api\/projects\/([^/]+)\/chronicle$/, (_req, res, url, p) => {
    sendJson(res, 200, getChronicle(p[0]!, url.searchParams.get("scriptId") ?? undefined));
  }],
  // Chronicle Page Flow フェーズII(§3・§6): 一括割り当て/解除。
  ["POST", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-allocation\/remove$/, async (req, res, _url, p) => {
    sendJson(res, 200, removeDialogueAllocation(p[0]!, p[1]!, await readJson(req)));
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-allocation$/, async (req, res, _url, p) => {
    sendJson(res, 200, allocateDialoguePages(p[0]!, p[1]!, await readJson(req)));
  }],
  // Chronicle Page Flow フェーズIII(§3・§4): 吹き出し一括配置の preview/apply。
  ["POST", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-layout\/preview$/, async (req, res, _url, p) => {
    sendJson(res, 200, previewDialogueLayout(p[0]!, p[1]!, await readJson(req)));
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-layout\/apply$/, async (req, res, _url, p) => {
    sendJson(res, 200, applyDialogueLayout(p[0]!, p[1]!, await readJson(req)));
  }],
  // Chronicle Page Flow フェーズIV(§2.6・§3・§6): 再配置(seed 変更)とロック一括解除。
  ["POST", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-layout\/reflow$/, async (req, res, _url, p) => {
    sendJson(res, 200, reflowDialogueLayout(p[0]!, p[1]!, await readJson(req)));
  }],
  ["POST", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-layout\/unlock$/, (_req, res, _url, p) => {
    sendJson(res, 200, unlockAllDialoguePlacementsForPage(p[0]!, p[1]!));
  }],
  ["POST", /^\/api\/dialogue-lines\/([^/]+)\/placements$/, async (req, res, _url, p) => {
    sendJson(res, 201, createDialoguePlacement(p[0]!, await readJson(req)));
  }],
  ["PATCH", /^\/api\/dialogue-lines\/([^/]+)$/, async (req, res, _url, p) => {
    sendJson(res, 200, { line: updateDialogueLine(p[0]!, await readJson(req)) });
  }],
  ["DELETE", /^\/api\/dialogue-lines\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, deleteDialogueLine(p[0]!));
  }],
  ["PATCH", /^\/api\/dialogue-placements\/([^/]+)$/, async (req, res, _url, p) => {
    sendJson(res, 200, { placement: updateDialoguePlacement(p[0]!, await readJson(req)) });
  }],
  ["DELETE", /^\/api\/dialogue-placements\/([^/]+)$/, (_req, res, _url, p) => {
    sendJson(res, 200, deleteDialoguePlacement(p[0]!));
  }],

  // --- 構造化 LLM セリフ提案(Docs/Feature-ScriptToManga.md S4): DialogueProposal ---
  ["POST", /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-proposals$/, async (req, res, _url, p) => {
    sendJson(res, 201, await createDialogueProposal(p[0]!, p[1]!, await readJson(req)));
  }],
  ["GET", /^\/api\/projects\/([^/]+)\/dialogue-proposals$/, (_req, res, url, p) => {
    sendJson(res, 200, {
      proposals: listDialogueProposals(p[0]!, {
        pageId: url.searchParams.get("pageId") ?? undefined
      })
    });
  }],
  ["POST", /^\/api\/dialogue-proposals\/([^/]+)\/adopt$/, async (req, res, _url, p) => {
    sendJson(res, 200, adoptDialogueProposalItems(p[0]!, await readJson(req)));
  }],
  ["POST", /^\/api\/dialogue-proposals\/([^/]+)\/reject$/, async (req, res, _url, p) => {
    sendJson(res, 200, rejectDialogueProposalItems(p[0]!, await readJson(req)));
  }],

  // --- 生成アセット ---
  ["POST", /^\/api\/assets\/([^/]+)\/status$/, async (req, res, _url, p) => {
    sendJson(res, 200, updateAssetStatus(p[0]!, await readJson(req)));
  }],
  ["GET", /^\/api\/assets\/([^/]+)\/(image|thumbnail)$/, async (_req, res, url, p) => {
    await serveAssetFile(res, p[0]!, p[1]!, url);
  }]
];

async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method ?? "GET";
  const path = url.pathname;

  for (const [routeMethod, pattern, handler] of apiRoutes) {
    if (routeMethod !== method) {
      continue;
    }
    if (typeof pattern === "string") {
      if (pattern !== path) {
        continue;
      }
      await handler(req, res, url, []);
      return;
    }
    const match = path.match(pattern);
    if (!match) {
      continue;
    }
    await handler(req, res, url, match.slice(1));
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
  const releaseBaseUrl = releaseAssetRegistry.get(filename);
  if (!releaseBaseUrl) {
    sendJson(res, 404, { error: `${label} model asset was not found` });
    return;
  }

  const response = await fetch(`${releaseBaseUrl}/${encodeURIComponent(filename)}`, {
    headers: {
      accept: "application/octet-stream",
      "user-agent": "guruguru-model-loader"
    }
  });
  if (!response.ok || !response.body) {
    sendJson(res, response.status || 502, {
      error: `GitHub model download failed: ${response.status} ${response.statusText}`.trim()
    });
    return;
  }

  const contentLength = response.headers.get("content-length");
  res.writeHead(200, {
    "content-type": response.headers.get("content-type") || "application/octet-stream",
    // content-length 欠損時に空文字ヘッダを送らない(chunked に任せる)。
    ...(contentLength ? { "content-length": contentLength } : {}),
    "cache-control": "public, max-age=86400"
  });

  // 巨大onnxモデル配信で write の戻り値を無視するとバッファがメモリへ積み上がるため、
  // backpressure を尊重して drain を待つ。header送信後の失敗は destroy で接続を閉じる。
  try {
    for await (const chunk of response.body) {
      if (!res.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            res.off("error", onError);
            resolve();
          };
          const onError = (error: Error) => {
            res.off("drain", onDrain);
            reject(error);
          };
          res.once("drain", onDrain);
          res.once("error", onError);
        });
      }
    }
    res.end();
  } catch {
    if (!res.destroyed) {
      res.destroy();
    }
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
