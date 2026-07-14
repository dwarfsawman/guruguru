import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dataRoot, dbPath, getRow, initializeDb, setSetting } from "./db";
import { discardRoundTrashSnapshot, purgeAllRoundTrash } from "./roundTrash";
import { getComfyStatus, testComfyConnection } from "./comfy";
import { checkModels, listAvailableLoras } from "./modelCheck";
import { installModelPreset } from "./modelPresets";
import { getLlmSettings, getLlmStatus, improvePromptWithLlm, testLlmConnection, toLlmSettingsView } from "./llm";
import { getVlmAuditSettings, getVlmAuditStatus } from "./vlmAudit";
import { serveStatic } from "./files";
import { HttpError, readBuffer, readJson, sendJson } from "./http";
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
import { deleteLayoutTemplate, importLayoutTemplate, listLayoutTemplates } from "./layoutTemplates";
import { createOpenRasterExport, createPagePreviewPng } from "./openRasterExport";
import { createPageMedia, servePageMedia } from "./pageMedia";
import { createImageExport } from "./imageExport";
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
  createScriptMangaRunExport,
  getScriptMangaPlan,
  getScriptMangaRun,
  resumeScriptMangaRun,
  retryScriptMangaTask,
  selectScriptMangaTaskCandidate,
  startScriptMangaRun,
  updateScriptMangaPlan
} from "./scriptManga";
import {
  archiveScriptMangaPlanCandidate,
  createScriptMangaPlanCandidates,
  listScriptMangaPlanCandidates
} from "./scriptMangaPlanCandidates";
import { applySpeakerAnchors } from "./speakerAnchors";
import { exportProject, importProject } from "./projectTransfer";
import { fitPageBalloonText } from "./balloonTextFit";
import {
  DEFAULT_WEB_SAM_MODEL_BASE_URL,
  GITHUB_POSE_CIGPOSE_RELEASE_BASE_URL,
  GITHUB_POSE_RELEASE_BASE_URL,
  GITHUB_WEB_SAM_RELEASE_BASE_URL
} from "../shared/constants";
import type { ComfySettings, GenerationRequest, LlmSettings, VlmAuditSettings } from "../shared/types";

const port = Number(process.env.PORT ?? 5177);
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
    if (family !== "chroma" && family !== "anima") {
      sendJson(res, 404, { error: `Unknown model family: ${family}` });
      return;
    }
    sendJson(res, 200, await checkModels(family));
    return;
  }

  const modelPresetMatch = path.match(/^\/api\/model-presets\/(chroma|anima)$/);
  if (method === "POST" && modelPresetMatch) {
    sendJson(res, 200, installModelPreset(modelPresetMatch[1] as "chroma" | "anima"));
    return;
  }

  if (method === "GET" && path === "/api/comfy/loras") {
    sendJson(res, 200, await listAvailableLoras());
    return;
  }

  if (method === "GET" && path === "/api/settings/llm") {
    sendJson(res, 200, toLlmSettingsView(getLlmSettings()));
    return;
  }

  if (method === "PUT" && path === "/api/settings/llm") {
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

  if (method === "GET" && path === "/api/settings/vlm-audit") {
    sendJson(res, 200, getVlmAuditSettings());
    return;
  }

  if (method === "PUT" && path === "/api/settings/vlm-audit") {
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
    return;
  }

  if (method === "GET" && path === "/api/vlm-audit/status") {
    sendJson(res, 200, await getVlmAuditStatus());
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
  if ((method === "PATCH" || method === "PUT") && templateDeleteMatch) {
    sendJson(res, 200, { template: updateTemplatePromptProfile(templateDeleteMatch[1]!, await readJson(req)) });
    return;
  }
  if (method === "DELETE" && templateDeleteMatch) {
    sendJson(res, 200, deleteTemplate(templateDeleteMatch[1]!));
    return;
  }

  // --- コマ割りテンプレート(漫画レイアウト)。グローバル(全Book共通)。 ---
  if (method === "GET" && path === "/api/layout-templates") {
    sendJson(res, 200, { templates: listLayoutTemplates() });
    return;
  }
  if (method === "POST" && path === "/api/layout-templates") {
    sendJson(res, 201, { template: importLayoutTemplate(await readJson(req)) });
    return;
  }
  const layoutTemplateDeleteMatch = path.match(/^\/api\/layout-templates\/([^/]+)$/);
  if (method === "DELETE" && layoutTemplateDeleteMatch) {
    sendJson(res, 200, deleteLayoutTemplate(layoutTemplateDeleteMatch[1]!));
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

  // .gguru プロジェクトインポート(Docs/Feature-ProjectImportExport.md §5)。ボディは .gguru
  // バイナリそのもの(multipart にはしない)。/api/projects/:id と衝突しないよう先に判定する
  // (":id" 部分に "import" は入り得ないため実害はないが、意図を明確にする)。
  if (method === "POST" && path === "/api/projects/import") {
    const result = await importProject(await readBuffer(req));
    sendJson(res, 201, result);
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

  // .gguru プロジェクトエクスポート(Docs/Feature-ProjectImportExport.md §5)。
  const projectExportMatch = path.match(/^\/api\/projects\/([^/]+)\/export$/);
  if (method === "GET" && projectExportMatch) {
    const result = await exportProject(projectExportMatch[1]!);
    res.writeHead(200, {
      "content-type": result.contentType,
      "content-length": String(result.buffer.byteLength),
      "content-disposition": `attachment; filename="${result.filename}"`
    });
    res.end(result.buffer);
    return;
  }

  const openRasterExportMatch = path.match(/^\/api\/projects\/([^/]+)\/openraster-export$/);
  if (method === "POST" && openRasterExportMatch) {
    const result = await createOpenRasterExport(openRasterExportMatch[1]!, await readJson(req));
    res.writeHead(200, {
      "content-type": result.contentType,
      "content-length": String(result.buffer.byteLength),
      "content-disposition": `attachment; filename="${result.filename}"`
    });
    res.end(result.buffer);
    return;
  }

  // 完成品の画像一括書き出し(Docs/Feature-CGCollectionSuite.md P4)。PNG/JPEG 連番(単ページは画像単体)。
  // format="pptx"(Docs/Feature-PptxExport.md)は同じエンドポイントで、常に単一 .pptx を返す。
  const imageExportMatch = path.match(/^\/api\/projects\/([^/]+)\/export-images$/);
  if (method === "POST" && imageExportMatch) {
    const result = await createImageExport(imageExportMatch[1]!, await readJson(req));
    res.writeHead(200, {
      "content-type": result.contentType,
      "content-length": String(result.buffer.byteLength),
      "content-disposition": `attachment; filename="${result.filename}"`
    });
    res.end(result.buffer);
    return;
  }

  // --- Book のページ操作。/pages/reorder は /pages/:pageId より前に判定する。 ---
  const pagesCollectionMatch = path.match(/^\/api\/projects\/([^/]+)\/pages$/);
  if (method === "GET" && pagesCollectionMatch) {
    sendJson(res, 200, listPagesWithProject(pagesCollectionMatch[1]!));
    return;
  }
  if (method === "POST" && pagesCollectionMatch) {
    sendJson(res, 201, { page: createPage(pagesCollectionMatch[1]!, await readJson(req)) });
    return;
  }

  const pagesReorderMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/reorder$/);
  if (method === "POST" && pagesReorderMatch) {
    sendJson(res, 200, reorderPages(pagesReorderMatch[1]!, await readJson(req)));
    return;
  }

  // 画像を新規ページとして取り込む(複数インポートの1枚分)。/pages/:pageId より前に判定する。
  const pageImportImageMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/import-image$/);
  if (method === "POST" && pageImportImageMatch) {
    sendJson(res, 201, await importImageAsPage(pageImportImageMatch[1]!, await readJson(req)));
    return;
  }

  const referenceImagesMatch = path.match(/^\/api\/projects\/([^/]+)\/reference-images$/);
  if (method === "GET" && referenceImagesMatch) {
    const limit = Number(url.searchParams.get("limit")) || 24;
    sendJson(res, 200, { images: await listRecentImages(referenceImagesMatch[1]!, limit) });
    return;
  }

  const pagePreviewMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/preview\.png$/);
  if (method === "GET" && pagePreviewMatch) {
    const size = Number(url.searchParams.get("size")) || 512;
    const buffer = await createPagePreviewPng(pagePreviewMatch[1]!, pagePreviewMatch[2]!, { size });
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(buffer.byteLength),
      "cache-control": "private, max-age=60"
    });
    res.end(buffer);
    return;
  }

  const pageDetailMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)$/);
  if (method === "GET" && pageDetailMatch) {
    sendJson(res, 200, getPageDetail(pageDetailMatch[1]!, pageDetailMatch[2]!, { ensureRoundMonitor }));
    return;
  }
  if (method === "PATCH" && pageDetailMatch) {
    sendJson(res, 200, { page: updatePage(pageDetailMatch[1]!, pageDetailMatch[2]!, await readJson(req)) });
    return;
  }
  if (method === "DELETE" && pageDetailMatch) {
    sendJson(res, 200, deletePage(pageDetailMatch[1]!, pageDetailMatch[2]!));
    return;
  }

  // コマ内生成(Docs/Feature-PanelGeneration.md): コマへの画像割り当て/クロップの更新。
  const panelAssignmentMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/panels\/([^/]+)\/assignment$/);
  if (method === "PATCH" && panelAssignmentMatch) {
    sendJson(
      res,
      200,
      updatePagePanelAssignment(panelAssignmentMatch[1]!, panelAssignmentMatch[2]!, panelAssignmentMatch[3]!, await readJson(req))
    );
    return;
  }

  // ページオブジェクト(Docs/Feature-CGCollectionSuite.md P1): テキスト/吹き出し/ボックスの配列を丸ごと置換する。
  const pageObjectsMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/objects$/);
  if (method === "PATCH" && pageObjectsMatch) {
    sendJson(res, 200, updatePageObjects(pageObjectsMatch[1]!, pageObjectsMatch[2]!, await readJson(req)));
    return;
  }
  const speakerAnchorsMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/speaker-anchors$/);
  if (method === "POST" && speakerAnchorsMatch) {
    sendJson(res, 200, applySpeakerAnchors(speakerAnchorsMatch[1]!, speakerAnchorsMatch[2]!, await readJson(req)));
    return;
  }
  const fitBalloonTextMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/fit-balloon-text$/);
  if (method === "POST" && fitBalloonTextMatch) {
    sendJson(res, 200, fitPageBalloonText(fitBalloonTextMatch[1]!, fitBalloonTextMatch[2]!));
    return;
  }

  // ImageObject(Docs/Feature-ScriptToManga.md S2): 配置時に Asset 画像を page_media へコピーする。
  const pageMediaCreateMatch = path.match(/^\/api\/projects\/([^/]+)\/page-media$/);
  if (method === "POST" && pageMediaCreateMatch) {
    sendJson(res, 201, await createPageMedia(pageMediaCreateMatch[1]!, await readJson(req)));
    return;
  }

  const pageMediaServeMatch = path.match(/^\/api\/page-media\/([^/]+)$/);
  if (method === "GET" && pageMediaServeMatch) {
    servePageMedia(res, pageMediaServeMatch[1]!);
    return;
  }

  // コマ形状編集(Docs/Feature-CGCollectionSuite.md P5): レイアウト(panels の shape/order 等)を丸ごと置換する。
  const pageLayoutMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/layout$/);
  if (method === "PATCH" && pageLayoutMatch) {
    sendJson(res, 200, updatePageLayout(pageLayoutMatch[1]!, pageLayoutMatch[2]!, await readJson(req)));
    return;
  }

  // モザイク(Docs/Feature-CGCollectionSuite.md P6): 非破壊リージョンの配列を丸ごと置換する。
  const pageMosaicMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/mosaic$/);
  if (method === "PATCH" && pageMosaicMatch) {
    sendJson(res, 200, updatePageMosaic(pageMosaicMatch[1]!, pageMosaicMatch[2]!, await readJson(req)));
    return;
  }

  // テキストオブジェクト(Docs/Feature-CGCollectionSuite.md P2): フォント一覧+自前レイアウト計算。
  if (method === "GET" && path === "/api/fonts") {
    sendJson(res, 200, { fonts: listFonts() });
    return;
  }
  if (method === "POST" && path === "/api/text-layout") {
    sendJson(res, 200, computeTextLayout(await readJson(req)));
    return;
  }

  const generateMatch = path.match(/^\/api\/projects\/([^/]+)\/rounds$/);
  if (method === "POST" && generateMatch) {
    const roundBody = await readJson<GenerationRequest & { pageId?: string | null; targetPanelId?: string | null }>(req);
    sendJson(
      res,
      201,
      await createGenerationRound(generateMatch[1]!, roundBody, roundBody.pageId ?? null, roundBody.targetPanelId ?? null)
    );
    return;
  }

  // Fountain → 自動コマ割り → コマ別画像生成 → 吹き出し完成の一括実行。
  const scriptMangaCreateMatch = path.match(/^\/api\/projects\/([^/]+)\/script-manga-runs$/);
  if (method === "POST" && scriptMangaCreateMatch) {
    sendJson(res, 201, await createScriptMangaRun(scriptMangaCreateMatch[1]!, await readJson(req)));
    return;
  }
  const scriptMangaRunMatch = path.match(/^\/api\/script-manga-runs\/([^/]+)$/);
  if (method === "GET" && scriptMangaRunMatch) {
    sendJson(res, 200, getScriptMangaRun(scriptMangaRunMatch[1]!));
    return;
  }
  // プラン候補(ネームv4 D3): 複数生成して見比べ、planCandidateId 付き run 作成で採用する。
  const scriptMangaCandidatesMatch = path.match(/^\/api\/projects\/([^/]+)\/script-manga-plan-candidates$/);
  if (method === "POST" && scriptMangaCandidatesMatch) {
    sendJson(res, 201, await createScriptMangaPlanCandidates(scriptMangaCandidatesMatch[1]!, await readJson(req)));
    return;
  }
  if (method === "GET" && scriptMangaCandidatesMatch) {
    const scriptId = url.searchParams.get("scriptId") ?? "";
    sendJson(res, 200, listScriptMangaPlanCandidates(scriptMangaCandidatesMatch[1]!, scriptId));
    return;
  }
  const scriptMangaCandidateArchiveMatch = path.match(/^\/api\/script-manga-plan-candidates\/([^/]+)\/archive$/);
  if (method === "POST" && scriptMangaCandidateArchiveMatch) {
    sendJson(res, 200, archiveScriptMangaPlanCandidate(scriptMangaCandidateArchiveMatch[1]!));
    return;
  }
  const scriptMangaPlanMatch = path.match(/^\/api\/script-manga-plans\/([^/]+)$/);
  if (method === "GET" && scriptMangaPlanMatch) {
    sendJson(res, 200, getScriptMangaPlan(scriptMangaPlanMatch[1]!));
    return;
  }
  if (method === "PATCH" && scriptMangaPlanMatch) {
    sendJson(res, 200, updateScriptMangaPlan(scriptMangaPlanMatch[1]!, await readJson(req)));
    return;
  }
  const scriptMangaRunExportMatch = path.match(/^\/api\/script-manga-runs\/([^/]+)\/export$/);
  if (method === "POST" && scriptMangaRunExportMatch) {
    const result = await createScriptMangaRunExport(scriptMangaRunExportMatch[1]!, await readJson(req));
    res.writeHead(200, {
      "content-type": result.contentType,
      "content-length": String(result.buffer.byteLength),
      "content-disposition": `attachment; filename="${result.filename}"`
    });
    res.end(result.buffer);
    return;
  }
  const scriptMangaRunActionMatch = path.match(/^\/api\/script-manga-runs\/([^/]+)\/(approve|start|resume|cancel)$/);
  if (method === "POST" && scriptMangaRunActionMatch) {
    const [, runId, action] = scriptMangaRunActionMatch;
    const result = action === "approve"
      ? approveScriptMangaRun(runId!)
      : action === "start"
        ? await startScriptMangaRun(runId!)
        : action === "resume"
          ? await resumeScriptMangaRun(runId!)
          : await cancelScriptMangaRun(runId!);
    sendJson(res, 200, result);
    return;
  }
  const scriptMangaTaskActionMatch = path.match(/^\/api\/script-manga-tasks\/([^/]+)\/(retry|select|audit)$/);
  if (method === "POST" && scriptMangaTaskActionMatch) {
    sendJson(
      res,
      200,
      scriptMangaTaskActionMatch[2] === "retry"
        ? await retryScriptMangaTask(scriptMangaTaskActionMatch[1]!)
        : scriptMangaTaskActionMatch[2] === "audit"
          ? await auditScriptMangaTask(scriptMangaTaskActionMatch[1]!)
          : await selectScriptMangaTaskCandidate(scriptMangaTaskActionMatch[1]!, await readJson(req))
    );
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

  const roundAttachmentMatch = path.match(/^\/api\/rounds\/([^/]+)\/attachments\/(mask|pose|reference)$/);
  if (method === "GET" && roundAttachmentMatch) {
    serveRoundAttachment(res, roundAttachmentMatch[1]!, roundAttachmentMatch[2]! as "mask" | "pose" | "reference");
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

  // --- 脚本ドメイン(Docs/Feature-ScriptToManga.md S3): Character / Script / DialogueLine / Placement ---
  const charactersCollectionMatch = path.match(/^\/api\/projects\/([^/]+)\/characters$/);
  if (method === "GET" && charactersCollectionMatch) {
    sendJson(res, 200, { characters: listCharacters(charactersCollectionMatch[1]!) });
    return;
  }

  const projectReferenceSetsMatch = path.match(/^\/api\/projects\/([^/]+)\/reference-sets$/);
  if (method === "GET" && projectReferenceSetsMatch) {
    sendJson(res, 200, { referenceSets: listProjectReferenceSets(projectReferenceSetsMatch[1]!) });
    return;
  }

  const characterReferenceSetsMatch = path.match(/^\/api\/characters\/([^/]+)\/reference-sets$/);
  if (method === "POST" && characterReferenceSetsMatch) {
    sendJson(res, 201, { referenceSet: createReferenceSet(characterReferenceSetsMatch[1]!, await readJson(req)) });
    return;
  }

  const referenceSetImageMatch = path.match(/^\/api\/reference-sets\/([^/]+)\/images\/(face|full_body)$/);
  if (method === "PUT" && referenceSetImageMatch) {
    sendJson(res, 200, { referenceSet: await uploadReferenceSetImage(referenceSetImageMatch[1]!, referenceSetImageMatch[2]!, await readJson(req)) });
    return;
  }

  const referenceSetActionMatch = path.match(/^\/api\/reference-sets\/([^/]+)\/(generate|approve)$/);
  if (method === "POST" && referenceSetActionMatch) {
    const result = referenceSetActionMatch[2] === "generate"
      ? await generateReferenceSetCandidates(referenceSetActionMatch[1]!, await readJson(req))
      : await approveReferenceSet(referenceSetActionMatch[1]!, await readJson(req));
    sendJson(res, referenceSetActionMatch[2] === "generate" ? 202 : 200,
      referenceSetActionMatch[2] === "generate" ? result : { referenceSet: result });
    return;
  }

  const referenceImageMatch = path.match(/^\/api\/reference-images\/([^/]+)$/);
  if (method === "GET" && referenceImageMatch) {
    serveReferenceSetImage(res, referenceImageMatch[1]!);
    return;
  }
  if (method === "POST" && charactersCollectionMatch) {
    sendJson(res, 201, { character: createCharacter(charactersCollectionMatch[1]!, await readJson(req)) });
    return;
  }

  const characterFaceImageMatch = path.match(/^\/api\/characters\/([^/]+)\/bindings\/([^/]+)\/face-image$/);
  if (method === "GET" && characterFaceImageMatch) {
    serveCharacterFaceImage(res, characterFaceImageMatch[1]!, characterFaceImageMatch[2]!);
    return;
  }

  const characterBindingMatch = path.match(/^\/api\/characters\/([^/]+)\/bindings\/([^/]+)$/);
  if (method === "GET" && characterBindingMatch) {
    sendJson(res, 200, getCharacterBinding(characterBindingMatch[1]!, characterBindingMatch[2]!));
    return;
  }
  if (method === "PUT" && characterBindingMatch) {
    sendJson(res, 200, await putCharacterBinding(characterBindingMatch[1]!, characterBindingMatch[2]!, await readJson(req)));
    return;
  }

  const characterSheetMatch = path.match(/^\/api\/characters\/([^/]+)\/character-sheet$/);
  if (method === "POST" && characterSheetMatch) {
    sendJson(res, 202, await createCharacterSheetRun(characterSheetMatch[1]!, await readJson(req)));
    return;
  }
  const characterSheetAdoptMatch = path.match(/^\/api\/characters\/([^/]+)\/character-sheet\/adopt$/);
  if (method === "POST" && characterSheetAdoptMatch) {
    const input = await readJson(req) as Record<string, unknown>;
    sendJson(res, 200, await adoptCharacterSheetAsset(characterSheetAdoptMatch[1]!, String(input.assetId ?? ""), String(input.providerId ?? "comfy")));
    return;
  }

  const characterDetailMatch = path.match(/^\/api\/characters\/([^/]+)$/);
  if (method === "PATCH" && characterDetailMatch) {
    sendJson(res, 200, { character: updateCharacter(characterDetailMatch[1]!, await readJson(req)) });
    return;
  }
  if (method === "DELETE" && characterDetailMatch) {
    sendJson(res, 200, deleteCharacter(characterDetailMatch[1]!));
    return;
  }

  const scriptsCollectionMatch = path.match(/^\/api\/projects\/([^/]+)\/scripts$/);
  if (method === "GET" && scriptsCollectionMatch) {
    sendJson(res, 200, { scripts: listScripts(scriptsCollectionMatch[1]!) });
    return;
  }
  if (method === "POST" && scriptsCollectionMatch) {
    sendJson(res, 201, createScript(scriptsCollectionMatch[1]!, await readJson(req)));
    return;
  }

  const scriptRevisionDetailMatch = path.match(/^\/api\/scripts\/([^/]+)\/revisions\/([^/]+)$/);
  if (method === "GET" && scriptRevisionDetailMatch) {
    sendJson(res, 200, getScriptRevision(scriptRevisionDetailMatch[1]!, Number(scriptRevisionDetailMatch[2])));
    return;
  }

  // GET は設計書のルート表に明示は無いが、クライアントが「最新 revision」を O(revision数) の
  // ポーリング無しで解決するために追加した(scripts.ts の listScriptRevisions を配線するだけ)。
  const scriptRevisionsMatch = path.match(/^\/api\/scripts\/([^/]+)\/revisions$/);
  if (method === "GET" && scriptRevisionsMatch) {
    sendJson(res, 200, { revisions: listScriptRevisions(scriptRevisionsMatch[1]!) });
    return;
  }
  if (method === "POST" && scriptRevisionsMatch) {
    sendJson(res, 201, addScriptRevision(scriptRevisionsMatch[1]!, await readJson(req)));
    return;
  }

  const scriptDetailMatch = path.match(/^\/api\/scripts\/([^/]+)$/);
  if (method === "GET" && scriptDetailMatch) {
    sendJson(res, 200, { script: getScript(scriptDetailMatch[1]!) });
    return;
  }
  if (method === "DELETE" && scriptDetailMatch) {
    sendJson(res, 200, deleteScript(scriptDetailMatch[1]!));
    return;
  }

  const dialogueLinesCollectionMatch = path.match(/^\/api\/projects\/([^/]+)\/dialogue-lines$/);
  if (method === "GET" && dialogueLinesCollectionMatch) {
    sendJson(res, 200, {
      lines: listDialogueLines(dialogueLinesCollectionMatch[1]!, {
        pageId: url.searchParams.get("pageId") ?? undefined,
        scriptId: url.searchParams.get("scriptId") ?? undefined,
        status: url.searchParams.get("status") ?? undefined
      })
    });
    return;
  }
  if (method === "POST" && dialogueLinesCollectionMatch) {
    sendJson(res, 201, { line: createDialogueLine(dialogueLinesCollectionMatch[1]!, await readJson(req)) });
    return;
  }

  // Chronicle Page Flow(S5、Docs/Done/Feature-ChroniclePageFlow.md §3)。dialogue-lines と同じブロックに置く
  // (`/api/projects/:id/scripts` 等、他の projectId 系ルートとの前方一致衝突は起きない -- 末尾 $ で完全一致)。
  const chronicleMatch = path.match(/^\/api\/projects\/([^/]+)\/chronicle$/);
  if (method === "GET" && chronicleMatch) {
    sendJson(res, 200, getChronicle(chronicleMatch[1]!, url.searchParams.get("scriptId") ?? undefined));
    return;
  }

  // Chronicle Page Flow フェーズII(§3・§6): 一括割り当て/解除。`/pages/:pageId` より末尾セグメントが
  // 多く末尾 $ で完全一致するため、既存の pageDetailMatch 等との順序衝突は無い。
  const dialogueAllocationRemoveMatch = path.match(
    /^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-allocation\/remove$/
  );
  if (method === "POST" && dialogueAllocationRemoveMatch) {
    sendJson(
      res,
      200,
      removeDialogueAllocation(dialogueAllocationRemoveMatch[1]!, dialogueAllocationRemoveMatch[2]!, await readJson(req))
    );
    return;
  }

  const dialogueAllocationMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-allocation$/);
  if (method === "POST" && dialogueAllocationMatch) {
    sendJson(res, 200, allocateDialoguePages(dialogueAllocationMatch[1]!, dialogueAllocationMatch[2]!, await readJson(req)));
    return;
  }

  // Chronicle Page Flow フェーズIII(§3・§4): 吹き出し一括配置の preview/apply。末尾セグメントが
  // dialogue-allocation より多く末尾 $ で完全一致するため、前段の pageDetailMatch 等との順序衝突は無い。
  const dialogueLayoutPreviewMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-layout\/preview$/);
  if (method === "POST" && dialogueLayoutPreviewMatch) {
    sendJson(res, 200, previewDialogueLayout(dialogueLayoutPreviewMatch[1]!, dialogueLayoutPreviewMatch[2]!, await readJson(req)));
    return;
  }

  const dialogueLayoutApplyMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-layout\/apply$/);
  if (method === "POST" && dialogueLayoutApplyMatch) {
    sendJson(res, 200, applyDialogueLayout(dialogueLayoutApplyMatch[1]!, dialogueLayoutApplyMatch[2]!, await readJson(req)));
    return;
  }

  // Chronicle Page Flow フェーズIV(§2.6・§3・§6): 再配置(seed 変更)とロック一括解除。
  const dialogueLayoutReflowMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-layout\/reflow$/);
  if (method === "POST" && dialogueLayoutReflowMatch) {
    sendJson(res, 200, reflowDialogueLayout(dialogueLayoutReflowMatch[1]!, dialogueLayoutReflowMatch[2]!, await readJson(req)));
    return;
  }

  const dialogueLayoutUnlockMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-layout\/unlock$/);
  if (method === "POST" && dialogueLayoutUnlockMatch) {
    sendJson(res, 200, unlockAllDialoguePlacementsForPage(dialogueLayoutUnlockMatch[1]!, dialogueLayoutUnlockMatch[2]!));
    return;
  }

  const dialoguePlacementsCreateMatch = path.match(/^\/api\/dialogue-lines\/([^/]+)\/placements$/);
  if (method === "POST" && dialoguePlacementsCreateMatch) {
    sendJson(res, 201, createDialoguePlacement(dialoguePlacementsCreateMatch[1]!, await readJson(req)));
    return;
  }

  const dialogueLineDetailMatch = path.match(/^\/api\/dialogue-lines\/([^/]+)$/);
  if (method === "PATCH" && dialogueLineDetailMatch) {
    sendJson(res, 200, { line: updateDialogueLine(dialogueLineDetailMatch[1]!, await readJson(req)) });
    return;
  }
  if (method === "DELETE" && dialogueLineDetailMatch) {
    sendJson(res, 200, deleteDialogueLine(dialogueLineDetailMatch[1]!));
    return;
  }

  const dialoguePlacementDetailMatch = path.match(/^\/api\/dialogue-placements\/([^/]+)$/);
  if (method === "PATCH" && dialoguePlacementDetailMatch) {
    sendJson(res, 200, { placement: updateDialoguePlacement(dialoguePlacementDetailMatch[1]!, await readJson(req)) });
    return;
  }
  if (method === "DELETE" && dialoguePlacementDetailMatch) {
    sendJson(res, 200, deleteDialoguePlacement(dialoguePlacementDetailMatch[1]!));
    return;
  }

  // --- 構造化 LLM セリフ提案(Docs/Feature-ScriptToManga.md S4): DialogueProposal ---
  const dialogueProposalsCreateMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)\/dialogue-proposals$/);
  if (method === "POST" && dialogueProposalsCreateMatch) {
    sendJson(
      res,
      201,
      await createDialogueProposal(dialogueProposalsCreateMatch[1]!, dialogueProposalsCreateMatch[2]!, await readJson(req))
    );
    return;
  }

  const dialogueProposalsCollectionMatch = path.match(/^\/api\/projects\/([^/]+)\/dialogue-proposals$/);
  if (method === "GET" && dialogueProposalsCollectionMatch) {
    sendJson(res, 200, {
      proposals: listDialogueProposals(dialogueProposalsCollectionMatch[1]!, {
        pageId: url.searchParams.get("pageId") ?? undefined
      })
    });
    return;
  }

  const dialogueProposalAdoptMatch = path.match(/^\/api\/dialogue-proposals\/([^/]+)\/adopt$/);
  if (method === "POST" && dialogueProposalAdoptMatch) {
    sendJson(res, 200, adoptDialogueProposalItems(dialogueProposalAdoptMatch[1]!, await readJson(req)));
    return;
  }

  const dialogueProposalRejectMatch = path.match(/^\/api\/dialogue-proposals\/([^/]+)\/reject$/);
  if (method === "POST" && dialogueProposalRejectMatch) {
    sendJson(res, 200, rejectDialogueProposalItems(dialogueProposalRejectMatch[1]!, await readJson(req)));
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

  res.writeHead(200, {
    "content-type": response.headers.get("content-type") || "application/octet-stream",
    "content-length": response.headers.get("content-length") ?? "",
    "cache-control": "public, max-age=86400"
  });

  for await (const chunk of response.body) {
    res.write(chunk);
  }
  res.end();
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
