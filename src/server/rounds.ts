import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createId, dataRoot, getRow, getRows, runSql, toApiRow, toApiRows } from "./db";
import { deleteQueuedPrompts, fetchViewImage, getHistory, interruptComfy } from "./comfy";
import { readImageSize, storeCompositeImage, storeControlImage, storeImage, storeMaskImage, storeReferenceImage } from "./storage";
import { clampInteger, maxBatchSize, normalizeGenerationRequest } from "./generationRequest";
import { HttpError } from "./http";
import { isJsonObject, numberOr, objectBody, stringOrNull, stringOr } from "./validate";
import { resolveSeed } from "./workflow";
import { decorateAsset } from "./assets";
import { branchAssignmentForRound, nextRoundIndex } from "./roundBranches";
import {
  readRoundTrashSnapshot,
  removeRoundTrashSnapshot,
  writeRoundTrashSnapshot,
  type SqlRow
} from "./roundTrash";
import { decodeCompositeDataUrl, decodeControlImageDataUrl, decodeImageDataUrl, decodeMaskDataUrl } from "./uploadDataUrl";
import { pasteSourceExtension } from "./pasteAttachments";
import { sanitizePastedObjects } from "../shared/pasteAttachments";
import {
  relationForGenerationMode,
  requiresParentAsset
} from "../shared/generationMode";
import { findProvider, getProvider } from "./providers/registry";
import { extractHistoryEntry, extractImages, selectFinalImages } from "./providers/comfyProvider";
import { resolveIntentArtifacts } from "./providers/types";
import type { GenerationProvider, ProviderJobSubmission, ProviderSubmittedJob } from "./providers/types";
import { toGenerationIntent } from "../shared/generationIntent";
import type { ControlNetOptions, GenerationMode, GenerationRequest, InpaintOptions, MaskedContent, ReferenceImageOptions } from "../shared/types";
import type { Asset, PageRow, Round } from "../shared/apiTypes";
import { isPathInside } from "./paths";
import { approvedReferenceSetFiles } from "./referenceSets";

export type { RoundAttachmentKind } from "./roundAttachments";
export { roundAttachmentPathFromRequest, resolveRoundAttachmentPath, serveRoundAttachment } from "./roundAttachments";

type GenerationJobStatus = "pending" | "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
type GenerationJob = {
  id: string;
  project_id: string;
  round_id: string;
  batch_index: number;
  prompt_id?: string | null;
  provider_job_ref?: string | null;
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
const roundCollectionLocks = new Map<string, Promise<CollectRoundResult>>();
/** ComfyUI の `type: "progress"` メッセージ(現在のサンプラー step)を Round 単位で保持する(DB化しない)。 */
const roundProgress = new Map<string, { value: number; max: number }>();

/** UX改善#5: `pollCollectRound` の collect レスポンスに乗せる現在の生成進捗。 */
export function getRoundProgress(roundId: string): { value: number; max: number } | null {
  return roundProgress.get(roundId) ?? null;
}

function getRoundForApi(roundId: string): Round | null {
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
  ) as unknown as Round | null;
}

/** Round が使う Provider の id。旧行を含め常に非 NULL(db.ts の ensureColumn 既定値 'comfy')。 */
function providerIdForRound(roundId: string): string {
  const row = getRow<{ provider_id: string | null }>("SELECT provider_id FROM generation_rounds WHERE id = ?", [roundId]);
  return row?.provider_id ?? "comfy";
}

export async function createGenerationRound(
  projectId: string,
  requestBody: GenerationRequest,
  pageId?: string | null,
  targetPanelId?: string | null,
  scriptMangaTaskId?: string | null
) {
  const project = getRow<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
  const resolvedScriptMangaTaskId =
    typeof scriptMangaTaskId === "string" && scriptMangaTaskId.trim() ? scriptMangaTaskId.trim() : null;
  if (
    resolvedScriptMangaTaskId &&
    !getRow(
      `SELECT t.id FROM script_manga_tasks t
       JOIN script_manga_runs r ON r.id = t.run_id
       WHERE t.id = ? AND r.project_id = ?`,
      [resolvedScriptMangaTaskId, projectId]
    )
  ) {
    throw new HttpError(404, "Script manga task was not found in this project");
  }

  // Book のページに属する生成なら page_id を検証して保存する(single は null)。
  const resolvedPageId = typeof pageId === "string" && pageId.trim() ? pageId : null;
  if (resolvedPageId && !getRow("SELECT id FROM pages WHERE id = ? AND project_id = ?", [resolvedPageId, projectId])) {
    throw new HttpError(400, "Page was not found in this Project");
  }

  // コマ内生成(Docs/Feature-PanelGeneration.md): targetPanelId はそのページの layout.panels に
  // 実在するコマ id だけを許す(ページを跨いだ/レイアウト変更後の古い id 等を弾く)。
  const resolvedTargetPanelId = typeof targetPanelId === "string" && targetPanelId.trim() ? targetPanelId : null;
  if (resolvedTargetPanelId) {
    if (!resolvedPageId) {
      throw new HttpError(400, "targetPanelId requires pageId");
    }
    const page = toApiRow(getRow("SELECT * FROM pages WHERE id = ?", [resolvedPageId])) as unknown as PageRow;
    if (!page.layout?.panels.some((panel) => panel.id === resolvedTargetPanelId)) {
      throw new HttpError(400, "targetPanelId was not found in this Page's layout");
    }
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
  let parentRoundId = typeof parentAsset?.round_id === "string" ? parentAsset.round_id : null;
  if (resolvedTargetPanelId && parentRoundId) {
    const parentRound = getRow<{ target_panel_id: string | null }>(
      "SELECT target_panel_id FROM generation_rounds WHERE id = ? AND project_id = ?",
      [parentRoundId, projectId]
    );
    if (parentRound?.target_panel_id !== resolvedTargetPanelId) {
      parentRoundId = null;
    }
  }
  const seed = resolveSeed(requestBody, typeof parentAsset?.seed === "number" ? parentAsset.seed : null);
  let request: GenerationRequest = normalizeGenerationRequest({ ...requestBody, generationMode, parentAssetId: requestedParentAssetId, seed });
  request = await prepareInpaintRequest(projectId, roundId, parentAsset, requestBody, request);
  request = await prepareControlNetRequest(projectId, roundId, requestBody, request);
  request = await preparePasteCompositeRequest(projectId, roundId, parentAsset, requestBody, request);
  request = await prepareReferenceRequest(projectId, roundId, requestBody, request);
  const branch = branchAssignmentForRound(projectId, parentAsset, roundId, "txt2img_root");

  // S1(Docs/Feature-ScriptToManga.md): 通常は "comfy" 固定。`providerId` は契約テスト
  // (FakeProvider)専用の隠しフックで、クライアントは送らない(省略時 'comfy')。
  const providerId = stringOrNull((requestBody as unknown as Record<string, unknown>).providerId) ?? "comfy";
  const intentCtx = {
    roundId,
    providerId,
    recipeRevision: typeof template.version === "number" || typeof template.version === "string" ? String(template.version) : undefined,
    pageId: resolvedPageId,
    panelId: resolvedTargetPanelId
  };
  const initialIntent = toGenerationIntent(request, intentCtx);

  runSql("SAVEPOINT generation_round_link");
  try {
    runSql(
      `INSERT INTO generation_rounds
        (id, project_id, template_id, parent_round_id, round_index, status, generation_mode,
         branch_color_index, branch_reason, branch_key, page_id, target_panel_id, request_json,
         provider_id, intent_json, script_manga_task_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        resolvedPageId,
        resolvedTargetPanelId,
        JSON.stringify(request),
        providerId,
        JSON.stringify(initialIntent),
        resolvedScriptMangaTaskId
      ]
    );
    if (resolvedScriptMangaTaskId) {
      const linked = runSql(
        "UPDATE script_manga_tasks SET round_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'submitting'",
        [roundId, resolvedScriptMangaTaskId]
      ) as { changes?: number };
      if (linked.changes !== 1) throw new HttpError(409, "Script manga task is no longer accepting a generation round");
    }
    runSql("RELEASE generation_round_link");
  } catch (error) {
    runSql("ROLLBACK TO generation_round_link");
    runSql("RELEASE generation_round_link");
    throw error;
  }

  let provider: GenerationProvider | null = null;
  let submitted: ProviderSubmittedJob[] = [];
  try {
    provider = getProvider(providerId);
    const jobCount = clampInteger(request.batchSize, 1, maxBatchSize);
    const firstSeed = typeof request.seed === "number" ? request.seed : resolveSeed(request, typeof parentAsset?.seed === "number" ? parentAsset.seed : null);
    request = {
      ...request,
      batchSize: jobCount,
      seed: firstSeed
    };
    const finalIntent = toGenerationIntent(request, intentCtx);
    runSql("UPDATE generation_rounds SET request_json = ?, intent_json = ? WHERE id = ?", [JSON.stringify(request), JSON.stringify(finalIntent), roundId]);
    runSql("UPDATE generation_rounds SET status = 'running' WHERE id = ?", [roundId]);

    // Intent がこの Provider/recipe で実行可能かの事前検証(S1 v2: providerOptions の規律含む)。
    const validation = await provider.validateIntent(finalIntent);
    if (!validation.ok) {
      throw new HttpError(400, `Generation intent is not valid for provider "${providerId}": ${validation.issues.join(", ")}`);
    }

    const jobSubmissions: ProviderJobSubmission[] = [];
    for (let batchIndex = 0; batchIndex < jobCount; batchIndex += 1) {
      const jobRequest = requestForBatchJob(request, batchIndex);
      jobSubmissions.push({
        batchIndex,
        seed: jobRequest.seed,
        request: jobRequest
      });
    }

    submitted = await provider.submit({
      projectId,
      roundId,
      roundIndex,
      templateId: request.templateId,
      parentAssetImagePath: parentImagePathForRequest(parentAsset, request),
      intent: resolveIntentArtifacts(finalIntent),
      jobs: jobSubmissions
    });

    // provider.submit は ctx.jobs と同じ順序で結果を返す契約(providers/types.ts 参照)。
    submitted.forEach((job, index) => {
      const batchIndex = jobSubmissions[index]!.batchIndex;
      runSql(
        `INSERT INTO generation_jobs
          (id, project_id, round_id, batch_index, prompt_id, provider_job_ref, client_id, seed, status, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP)`,
        [createId("job"), projectId, roundId, batchIndex, job.jobRef, job.jobRef, job.watchRef ?? job.jobRef, job.seed]
      );
    });

    const first = submitted[0] ?? null;
    runSql(
      "UPDATE generation_rounds SET prompt_id = ?, patched_workflow_json = ?, warning_json = ?, status = 'running' WHERE id = ?",
      [first?.jobRef ?? null, first ? JSON.stringify(first.nativeSubmission) : null, first?.warnings?.length ? JSON.stringify(first.warnings) : null, roundId]
    );
    if (submitted.length > 0) {
      ensureRoundMonitor(roundId);
    }

    // S1 レビュー指摘5: capability スナップショットの解決(/object_info 等)は HTTP レスポンスを
    // 遅延させないよう非同期化する(await しない)。失敗しても round 自体は失敗させない。
    void provider
      .resolveCapabilities({ recipeId: request.templateId, revision: intentCtx.recipeRevision })
      .then((capabilities) => {
        runSql("UPDATE generation_rounds SET provider_snapshot_json = ? WHERE id = ?", [JSON.stringify(capabilities), roundId]);
      })
      .catch(() => {
        // Capability スナップショットはベストエフォートのメタデータ。
      });

    return {
      round: toApiRow(getRow("SELECT * FROM generation_rounds WHERE id = ?", [roundId])) as unknown as Round | null,
      promptId: first?.jobRef ?? null
    };
  } catch (error) {
    // S1 レビュー指摘4: submit 成功後(ComfyUI へのキュー投入は完了)に後続の DB 書き込み等が
    // 失敗した場合、キューに残った native ジョブをベストエフォートで後始末する(main の
    // deleteQueuedPrompts 後始末に相当。失敗しても元のエラーを優先して投げる)。
    if (submitted.length > 0 && provider) {
      try {
        await provider.interrupt(submitted.map((job) => job.jobRef), false);
      } catch (cleanupError) {
        console.warn(`Failed to clean up queued jobs for round ${roundId} after a submit-time error:`, cleanupError);
      }
    }
    runSql(
      "UPDATE generation_rounds SET status = 'failed', last_error_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [JSON.stringify(errorToJson(error)), roundId]
    );
    runSql(
      "UPDATE generation_jobs SET status = 'failed', last_error_json = ?, completed_at = CURRENT_TIMESTAMP WHERE round_id = ? AND status IN ('pending', 'queued', 'running')",
      [JSON.stringify(errorToJson(error)), roundId]
    );
    throw error;
  }
}

/** requiresParentAsset なモードで pasteComposite が無い場合に Provider へ渡す親アセットの画像パス。 */
function parentImagePathForRequest(parentAsset: Record<string, unknown> | null, request: GenerationRequest): string | null {
  return parentAsset && requiresParentAsset(request.generationMode) ? String(parentAsset.image_path) : null;
}

async function prepareInpaintRequest(
  projectId: string,
  roundId: string,
  parentAsset: Record<string, unknown> | null,
  rawRequest: GenerationRequest,
  normalizedRequest: GenerationRequest
): Promise<GenerationRequest> {
  const rawRequestRecord = rawRequest as unknown as Record<string, unknown>;
  const rawInpaint = isJsonObject(rawRequestRecord.inpaint)
    ? rawRequestRecord.inpaint as Record<string, unknown>
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

/**
 * `prepareInpaintRequest` と同型。クライアントが合成した「元画像+ペイント+添付」PNG を
 * decode → `composites/<roundId>_composite.png` へ保存し、request_json には
 * compositePath と生成時点の objects スナップショットのみを残す(dataUrl は破棄)。
 */
async function preparePasteCompositeRequest(
  projectId: string,
  roundId: string,
  parentAsset: Record<string, unknown> | null,
  rawRequest: GenerationRequest,
  normalizedRequest: GenerationRequest
): Promise<GenerationRequest> {
  const rawRequestRecord = rawRequest as unknown as Record<string, unknown>;
  const rawComposite = isJsonObject(rawRequestRecord.pasteComposite)
    ? rawRequestRecord.pasteComposite as Record<string, unknown>
    : null;
  const hasDataUrl = typeof rawComposite?.imageDataUrl === "string" && rawComposite.imageDataUrl.trim() !== "";

  if (!hasDataUrl) {
    return {
      ...normalizedRequest,
      pasteComposite: null
    };
  }

  if (!requiresParentAsset(normalizedRequest.generationMode)) {
    throw new HttpError(400, "pasteComposite is supported only for generations that use a parent image.");
  }
  if (!parentAsset) {
    throw new HttpError(400, "pasteComposite generation requires a parent Asset.");
  }

  const composite = decodeCompositeDataUrl(rawComposite.imageDataUrl);
  const compositeSize = readImageSize(composite.bytes);
  if (!compositeSize) {
    throw new HttpError(400, "Composite PNG dimensions could not be read.");
  }
  const parentSize = await parentAssetDimensions(parentAsset);
  if (parentSize && (compositeSize.width !== parentSize.width || compositeSize.height !== parentSize.height)) {
    throw new HttpError(
      400,
      `Composite size ${compositeSize.width}x${compositeSize.height} does not match parent image size ${parentSize.width}x${parentSize.height}.`
    );
  }

  const stored = await storeCompositeImage(projectId, roundId, composite.bytes);

  return {
    ...normalizedRequest,
    pasteComposite: {
      compositePath: stored.compositePath,
      compositeWidth: stored.width,
      compositeHeight: stored.height,
      objects: sanitizePastedObjects(rawComposite.objects)
    }
  };
}

async function prepareControlNetRequest(
  projectId: string,
  roundId: string,
  rawRequest: GenerationRequest,
  normalizedRequest: GenerationRequest
): Promise<GenerationRequest> {
  const rawRequestRecord = rawRequest as unknown as Record<string, unknown>;
  const rawControlNet = isJsonObject(rawRequestRecord.controlnet)
    ? rawRequestRecord.controlnet as Record<string, unknown>
    : null;
  const hasPoseDataUrl = typeof rawControlNet?.poseImageDataUrl === "string" && rawControlNet.poseImageDataUrl.trim() !== "";

  if (!hasPoseDataUrl) {
    return {
      ...normalizedRequest,
      controlnet: null
    };
  }

  const control = decodeControlImageDataUrl(rawControlNet.poseImageDataUrl);
  const stored = await storeControlImage(projectId, roundId, control.bytes);

  return {
    ...normalizedRequest,
    controlnet: normalizeControlNetOptions(rawControlNet, stored.controlPath)
  };
}

/**
 * Consistent Character(Docs/Feature-ConsistentCharacter.md)の参照画像。`prepareControlNetRequest`
 * と同型: dataUrl を decode → `reference/<roundId><ext>` へ保存 → request_json には
 * imagePath とトグル状態だけ残し、imageDataUrl は null化する。img2img 系のように親アセットを
 * 要求しない(顔/スタイル参照は generationMode と独立)。
 */
async function prepareReferenceRequest(
  projectId: string,
  roundId: string,
  rawRequest: GenerationRequest,
  normalizedRequest: GenerationRequest
): Promise<GenerationRequest> {
  const rawRequestRecord = rawRequest as unknown as Record<string, unknown>;
  const rawReference = isJsonObject(rawRequestRecord.reference)
    ? rawRequestRecord.reference as Record<string, unknown>
    : null;
  const hasImageDataUrl = typeof rawReference?.imageDataUrl === "string" && rawReference.imageDataUrl.trim() !== "";
  const rawBinding = isJsonObject(rawReference?.characterBinding)
    ? rawReference.characterBinding as Record<string, unknown>
    : null;
  const characterId = typeof rawBinding?.characterId === "string" ? rawBinding.characterId.trim() : "";
  const providerId = typeof rawBinding?.providerId === "string" ? rawBinding.providerId.trim() : "";
  const rawSet = isJsonObject(rawReference?.referenceSet)
    ? rawReference.referenceSet as Record<string, unknown>
    : null;
  const referenceSetId = typeof rawSet?.setId === "string" ? rawSet.setId.trim() : "";
  const referenceSetVersion = typeof rawSet?.version === "number" ? Math.trunc(rawSet.version) : 0;

  if (!hasImageDataUrl && (!characterId || !providerId) && (!referenceSetId || referenceSetVersion < 1)) {
    return {
      ...normalizedRequest,
      reference: null
    };
  }

  if (referenceSetId && referenceSetVersion > 0) {
    const resolvedSet = approvedReferenceSetFiles(referenceSetId, referenceSetVersion, projectId);
    const faceBytes = await readFile(resolvedSet.facePath);
    const faceExt = extname(resolvedSet.facePath).toLowerCase();
    const storedFace = await storeReferenceImage(projectId, `${roundId}_face`, faceExt, faceBytes);
    let fullBodyPath: string | null = null;
    if (resolvedSet.fullBodyPath) {
      const fullBodyBytes = await readFile(resolvedSet.fullBodyPath);
      const fullBodyExt = extname(resolvedSet.fullBodyPath).toLowerCase();
      fullBodyPath = (await storeReferenceImage(projectId, `${roundId}_full_body`, fullBodyExt, fullBodyBytes)).referencePath;
    }
    return {
      ...normalizedRequest,
      reference: normalizeReferenceOptions(rawReference ?? {}, storedFace.referencePath, fullBodyPath, {
        setId: resolvedSet.snapshot.setId,
        version: resolvedSet.snapshot.version
      })
    };
  }

  let bytes: Buffer;
  let extension: string;
  if (hasImageDataUrl) {
    const decoded = decodeImageDataUrl(rawReference!.imageDataUrl);
    bytes = decoded.bytes;
    extension = pasteSourceExtension(decoded.mimeType);
  } else {
    const row = getRow<{ binding_json: string }>(
      `SELECT cb.binding_json FROM character_bindings cb
       JOIN characters c ON c.id = cb.character_id
       WHERE c.project_id = ? AND cb.character_id = ? AND cb.provider_id = ?`,
      [projectId, characterId, providerId]
    );
    let binding: Record<string, unknown> = {};
    try {
      binding = row ? (JSON.parse(row.binding_json) as Record<string, unknown>) : {};
    } catch {
      binding = {};
    }
    const candidate = typeof binding.faceImagePath === "string" ? resolve(binding.faceImagePath) : "";
    if (!candidate || !isPathInside(candidate, resolve(dataRoot))) {
      throw new HttpError(404, "Character face binding was not found");
    }
    bytes = await readFile(candidate);
    const sourceExtension = extname(candidate).toLocaleLowerCase();
    extension = sourceExtension === ".jpg" || sourceExtension === ".jpeg" || sourceExtension === ".webp" ? sourceExtension : ".png";
  }
  const stored = await storeReferenceImage(projectId, roundId, extension, bytes);

  return {
    ...normalizedRequest,
    reference: normalizeReferenceOptions(rawReference ?? {}, stored.referencePath)
  };
}

function normalizeReferenceOptions(
  rawReference: Record<string, unknown>,
  imagePath: string,
  fullBodyPath: string | null = null,
  referenceSet: { setId: string; version: number } | null = null
): ReferenceImageOptions {
  const rawFace = isJsonObject(rawReference.face) ? (rawReference.face as Record<string, unknown>) : null;
  const rawAnima = isJsonObject(rawReference.animaInContext)
    ? (rawReference.animaInContext as Record<string, unknown>)
    : null;
  return {
    imageDataUrl: null,
    imagePath,
    referenceSet,
    images: { facePath: imagePath, fullBodyPath },
    strict: rawReference.strict === true,
    face: { enabled: Boolean(rawFace?.enabled) },
    animaInContext: rawAnima
      ? {
          enabled: Boolean(rawAnima.enabled),
          strength: clampFloat(numberOr(rawAnima.strength, 1), 0, 2),
          startPercent: clampFloat(numberOr(rawAnima.startPercent, 0), 0, 1),
          endPercent: clampFloat(numberOr(rawAnima.endPercent, 1), 0, 1)
        }
      : null
  };
}

function normalizeControlNetOptions(rawControlNet: Record<string, unknown>, poseImagePath: string): ControlNetOptions {
  return {
    poseImageDataUrl: null,
    poseImagePath,
    strength: clampFloat(numberOr(rawControlNet.strength, 1), 0, 2),
    startPercent: clampFloat(numberOr(rawControlNet.startPercent, 0), 0, 1),
    endPercent: clampFloat(numberOr(rawControlNet.endPercent, 1), 0, 1)
  };
}

function clampFloat(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function normalizeInpaintOptions(rawInpaint: Record<string, unknown>): InpaintOptions {
  const maskedContent = normalizeMaskedContent(rawInpaint.maskedContent ?? rawInpaint.masked_content);
  const inpaintArea = stringOr(rawInpaint.inpaintArea ?? rawInpaint.inpaint_area, "only_masked");
  if (inpaintArea !== "only_masked") {
    throw new HttpError(400, "Only inpaintArea='only_masked' is supported.");
  }

  return {
    maskedContent,
    inpaintArea: "only_masked",
    onlyMaskedPadding: clampInteger(numberOr(rawInpaint.onlyMaskedPadding ?? rawInpaint.only_masked_padding, 32), 0, 512),
    featherRadius: clampInteger(numberOr(rawInpaint.featherRadius ?? rawInpaint.feather_radius, 0), 0, 30),
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

export async function collectRound(roundId: string): Promise<CollectRoundResult> {
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
  // S1 レビュー指摘3: submit() が jobs 行を 1 件も作れずに失敗した Round(intent_json はある)は、
  // ComfyUI の history/prompt_id を前提とするレガシー経路(旧 Round)へ誤分類してはいけない。
  // レガシー判定は「jobs 0 件『かつ』intent_json が無い」に限定する。
  const isLegacyRound = jobs.length === 0 && !round.intent_json;
  if (isLegacyRound) {
    return collectLegacyRound(round);
  }
  if (jobs.length === 0) {
    return zeroJobRoundCollectResult(round);
  }

  const template = getRow<Record<string, unknown>>("SELECT * FROM workflow_templates WHERE id = ?", [round.template_id]);
  if (!template) {
    throw new HttpError(500, "Round template was not found");
  }

  const request = JSON.parse(String(round.request_json)) as GenerationRequest;
  const roleMap = parseStoredJsonObject(template.role_map_json);
  const workflowForOutputSelection =
    parseStoredJsonObject(round.patched_workflow_json) ?? parseStoredJsonObject(template.workflow_json);
  const provider = getProvider(providerIdForRound(roundId));
  const createdAssets: Asset[] = [];

  for (const job of jobs) {
    const nativeRef = jobNativeRef(job);
    if (!nativeRef || job.status === "cancelled" || job.status === "failed") {
      continue;
    }
    if (hasAssetsForPrompt(roundId, nativeRef)) {
      if (job.status !== "completed") {
        runSql(
          "UPDATE generation_jobs SET status = 'completed', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ?",
          [job.id]
        );
      }
      continue;
    }

    const images = await provider.collectImages(nativeRef, {
      projectId: String(round.project_id),
      roundId,
      roleMap,
      workflow: workflowForOutputSelection
    });
    if (images.length === 0) {
      continue;
    }

    for (const image of images) {
      const asset = await storeGeneratedAsset({
        round,
        template,
        request,
        imageBytes: image.bytes,
        filename: image.filename,
        outputNodeId: image.outputNodeId,
        promptId: nativeRef,
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
  if (isTerminal) {
    roundProgress.delete(roundId);
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
      progress: getRoundProgress(roundId),
      message: createdAssets.length > 0
        ? `${createdAssets.length} generated image(s) were collected.`
        : "No new generated images are available yet."
    }
  };
}

/**
 * S1 レビュー指摘3: submit() が(intent_json の保存は済んだが)jobs 行を 1 件も作れずに失敗した
 * Round の collect レスポンス。ComfyUI の prompt_id を要求するレガシー経路には委譲せず、Round の
 * 現在の終端状態(通常は 'failed')をそのまま 200 + jobStats で返す(main の挙動に合わせる)。
 */
function zeroJobRoundCollectResult(round: Record<string, unknown>): CollectRoundResult {
  const roundId = String(round.id);
  const isTerminal = typeof round.status === "string" && terminalRoundStatuses.has(round.status);
  return {
    statusCode: isTerminal ? 200 : 202,
    body: {
      round: getRoundForApi(roundId),
      assets: [],
      jobStats: jobStats(roundId),
      progress: getRoundProgress(roundId),
      message: isTerminal
        ? "This round did not produce any generation jobs."
        : "No new generated images are available yet."
    }
  };
}

// TODO(S1 フォローアップ, Docs/Feature-ScriptToManga.md S1): generation_jobs 行を持たない旧 Round は
// provider.collectImages ではなくここで直接 comfy.ts の history パースを呼んでいる。404 時の挙動
// (このレガシー経路は投げっぱなし、provider.collectImages は空配列で握りつぶす)が異なるため、
// 挙動保持を優先して現状維持している。
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
  const createdAssets: Asset[] = [];

  for (const image of images) {
    const imageBytes = await fetchViewImage(image);
    const asset = await storeGeneratedAsset({
      round,
      template,
      request,
      imageBytes,
      filename: image.filename,
      outputNodeId: image.nodeId ?? null,
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

async function storeGeneratedAsset({
  round,
  template,
  request,
  imageBytes,
  filename,
  outputNodeId,
  promptId,
  seed
}: {
  round: Record<string, unknown>;
  template: Record<string, unknown>;
  request: GenerationRequest;
  imageBytes: Buffer;
  filename: string;
  outputNodeId: string | null;
  promptId: string | null;
  seed: number | null;
}) {
  const roundId = String(round.id);
  const batchIndex = nextAssetBatchIndex(roundId);
  const stored = await storeImage(String(round.project_id), roundId, batchIndex, filename, imageBytes);
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
      outputNodeId
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

/**
 * このジョブの不透明な native 参照(S1 v2: `generation_jobs.provider_job_ref`)。旧行(v2 導入前に
 * 作成された行)は `provider_job_ref` が NULL のため `prompt_id`(comfy レガシー列)へ後方互換フォール
 * バックする(Docs/Feature-ScriptToManga.md S1 DB(v2方針))。
 */
function jobNativeRef(job: GenerationJob): string | null {
  return job.provider_job_ref ?? job.prompt_id ?? null;
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

export async function interruptRound(roundId: string) {
  const round = getRow<Record<string, unknown>>("SELECT * FROM generation_rounds WHERE id = ?", [roundId]);
  if (!round) {
    throw new HttpError(404, "Round was not found");
  }

  const jobs = getGenerationJobs(roundId);
  // S1 レビュー指摘3: submit() が jobs 行を作れずに失敗した Round(intent_json はある)は、
  // interruptLegacyRound へ委譲すると「すでに 'failed' な Round のステータスを問答無用で
  // 'interrupted' に上書きしてしまう」ため、collect と同じ判定でレガシー経路を限定する。
  const isLegacyRound = jobs.length === 0 && !round.intent_json;
  if (isLegacyRound) {
    return interruptLegacyRound(round);
  }
  if (jobs.length === 0) {
    return {
      round: toApiRow(round) as unknown as Round | null,
      interrupted: false,
      deletedPromptIds: []
    };
  }

  const activeJobs = jobs.filter((job) => activeJobStatuses.has(job.status));
  const activePromptIds = activeJobs
    .map((job) => jobNativeRef(job))
    .filter((promptId): promptId is string => typeof promptId === "string" && promptId.length > 0);
  if (activeJobs.length === 0) {
    return {
      round: toApiRow(updateRoundStatusFromJobs(roundId)) as unknown as Round | null,
      interrupted: false,
      deletedPromptIds: []
    };
  }

  const provider = getProvider(providerIdForRound(roundId));
  const result = await provider.interrupt(activePromptIds, activeJobs.some((job) => job.status === "running"));

  const runningSet = new Set(result.runningJobRefs);
  for (const job of activeJobs) {
    const promptId = jobNativeRef(job);
    if (job.status === "running" && !result.interruptedRunning) {
      continue;
    }
    if (job.status !== "running" && result.deleteError && promptId) {
      continue;
    }
    const status: GenerationJobStatus = result.interruptedRunning && (job.status === "running" || (promptId ? runningSet.has(promptId) : false))
      ? "interrupted"
      : "cancelled";
    runSql(
      "UPDATE generation_jobs SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [status, job.id]
    );
  }

  const updatedRound = updateRoundStatusFromJobs(roundId);

  return {
    round: toApiRow(updatedRound) as unknown as Round | null,
    interrupted: result.interruptedRunning,
    deletedPromptIds: activePromptIds,
    queueError: result.queueError,
    deleteError: result.deleteError,
    interruptError: result.interruptError,
    jobStats: jobStats(roundId)
  };
}

// TODO(S1 フォローアップ, Docs/Feature-ScriptToManga.md S1): このレガシー経路(generation_jobs 行を
// 持たない旧 Round)は queue 照合を行わず常に interruptComfy を試みる、より単純な既存挙動を保つため
// provider.interrupt を通さず comfy.ts を直接呼ぶ据え置きとしている。
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
    round: toApiRow(getRow("SELECT * FROM generation_rounds WHERE id = ?", [round.id])) as unknown as Round | null,
    interrupted,
    deletedPromptIds: promptId ? [promptId] : [],
    deleteError,
    interruptError
  };
}

/**
 * Round の進捗監視を開始する。実体は Provider(comfy: WebSocket)。ジョブ状態の DB 反映は
 * `onRoundJobUpdate` へコールバックで返してもらう(中立: rounds.ts はジョブ状態機械のまま残る)。
 */
export function ensureRoundMonitor(roundId: string) {
  const provider = getProvider(providerIdForRound(roundId));
  provider.watchProgress?.({
    roundId,
    onJobUpdate: (jobRef, status, error) => onRoundJobUpdate(roundId, jobRef, status, error),
    onProgress: (value, max) => roundProgress.set(roundId, { value, max })
  });
}

function onRoundJobUpdate(
  roundId: string,
  jobRef: string,
  status: "running" | "collectable" | "interrupted" | "failed",
  error?: unknown
) {
  // S1 v2: `provider_job_ref`(新)と `prompt_id`(comfy レガシー)のどちらでも一致させる
  // (`jobNativeRef` の書き込み側は常に両方へ jobRef を書くが、旧データは provider_job_ref が NULL)。
  const job = getRow<GenerationJob>(
    "SELECT * FROM generation_jobs WHERE round_id = ? AND (provider_job_ref = ? OR prompt_id = ?)",
    [roundId, jobRef, jobRef]
  );
  if (!job) {
    return;
  }

  if (status === "running") {
    // ノード(またはプロンプト)が切り替わったタイミングなので、直前ノードの進捗を持ち越さない。
    roundProgress.delete(roundId);
    runSql(
      "UPDATE generation_jobs SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ? AND status IN ('pending', 'queued')",
      [job.id]
    );
    runSql("UPDATE generation_rounds SET status = 'running' WHERE id = ?", [roundId]);
    return;
  }

  if (status === "collectable") {
    roundProgress.delete(roundId);
    void collectRound(roundId);
    return;
  }

  if (status === "interrupted") {
    roundProgress.delete(roundId);
    runSql(
      "UPDATE generation_jobs SET status = 'interrupted', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'completed'",
      [job.id]
    );
    updateRoundStatusFromJobs(roundId);
    void collectRound(roundId);
    return;
  }

  if (status === "failed") {
    roundProgress.delete(roundId);
    runSql(
      "UPDATE generation_jobs SET status = 'failed', last_error_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'completed'",
      [JSON.stringify(error ?? null), job.id]
    );
    updateRoundStatusFromJobs(roundId);
    void collectRound(roundId);
  }
}

/**
 * S1 レビュー指摘1 [critical]: `deleteRoundTree` はツリー内の全 Round(provider_id='manual' の
 * アップロード由来 Round を含みうる)に対してこれを呼ぶ。`getProvider` は未登録 provider_id で
 * HttpError(400) を投げるため、`manual` ラウンドが混じるとサブツリー削除全体が ROLLBACK して
 * ページ削除が失敗する(実測再現済み)。未知 provider は監視対象がそもそも無いので黙って無視する。
 */
function stopRoundMonitor(roundId: string) {
  roundProgress.delete(roundId);
  findProvider(providerIdForRound(roundId))?.stopWatch?.(roundId);
}

/**
 * Round サブツリーの削除(UX改善#3)。関連行をゴミ箱スナップショット
 * (`<dataRoot>/trash/rounds/<rootId>.json`)へ書き出してから DB からは完全削除する。
 * 画像ファイルは disk に残るため、`restoreRounds` でスナップショットから復元できる。
 */
export function deleteRoundTree(roundId: string) {
  const round = getRow<Record<string, unknown>>("SELECT * FROM generation_rounds WHERE id = ?", [roundId]);
  if (!round) {
    throw new HttpError(404, "Round was not found");
  }

  // depth ASC(親が先)で保存し、復元時にこの順で INSERT する(parent_round_id FK のため)。
  const rows = getRows<{ id: string; depth: number }>(
    `WITH RECURSIVE round_tree(id, depth) AS (
       SELECT id, 0 FROM generation_rounds WHERE id = ?
       UNION ALL
       SELECT child.id, round_tree.depth + 1
       FROM generation_rounds child
       JOIN round_tree ON child.parent_round_id = round_tree.id
     )
     SELECT id, depth FROM round_tree ORDER BY depth ASC`,
    [roundId]
  );
  const roundIds = rows.map((row) => row.id);
  const placeholders = roundIds.map(() => "?").join(", ");
  // task が既に削除済みのダングリング参照は履歴として保護しない(存在するtaskのみ409対象)。
  const scriptMangaHistory = getRow<{ id: string }>(
    `SELECT round.id FROM generation_rounds round
     WHERE round.id IN (${placeholders})
       AND round.script_manga_task_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM script_manga_tasks task WHERE task.id = round.script_manga_task_id)
     LIMIT 1`,
    roundIds
  );
  if (scriptMangaHistory) {
    throw new HttpError(409, "Rounds linked to script manga task history cannot be deleted");
  }

  const roundRows = roundIds.map(
    (id) => getRow<SqlRow>("SELECT * FROM generation_rounds WHERE id = ?", [id])!
  );
  const jobRows = getRows<SqlRow>(`SELECT * FROM generation_jobs WHERE round_id IN (${placeholders})`, roundIds);
  const assetRows = getRows<SqlRow>(`SELECT * FROM assets WHERE round_id IN (${placeholders})`, roundIds);
  const assetIds = assetRows.map((row) => String(row.id));
  const assetPlaceholders = assetIds.map(() => "?").join(", ");
  const assetParentRows = assetIds.length
    ? getRows<SqlRow>(
        `SELECT * FROM asset_parents WHERE parent_asset_id IN (${assetPlaceholders}) OR child_asset_id IN (${assetPlaceholders})`,
        [...assetIds, ...assetIds]
      )
    : [];
  const selectionEventRows = getRows<SqlRow>(
    `SELECT * FROM selection_events WHERE round_id IN (${placeholders})`,
    roundIds
  );

  writeRoundTrashSnapshot({
    version: 1,
    rootId: roundId,
    deletedAt: new Date().toISOString(),
    rounds: roundRows,
    jobs: jobRows,
    assets: assetRows,
    assetParents: assetParentRows,
    selectionEvents: selectionEventRows
  });

  runSql("BEGIN");
  try {
    // 子孫から順に削除(parent_round_id FK)。jobs / assets / selection_events /
    // asset_parents は ON DELETE CASCADE で連動する。
    for (const row of [...rows].reverse()) {
      stopRoundMonitor(row.id);
      runSql("DELETE FROM generation_rounds WHERE id = ?", [row.id]);
    }
    runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [round.project_id]);
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    removeRoundTrashSnapshot(roundId);
    throw error;
  }

  return {
    deleted: true,
    roundIds,
    deletedCount: rows.length
  };
}

function insertSqlRow(tableName: string, row: SqlRow) {
  const columns = Object.keys(row);
  runSql(
    `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => row[column] as string | number | null)
  );
}

/**
 * ゴミ箱スナップショットからの復元。クライアントは削除時のルート Round id を渡す。
 * スナップショットは復元成功後に削除される(= 復元は 1 回きり。再削除すれば再作成される)。
 */
export function restoreRounds(body: unknown) {
  const input = objectBody(body);
  const rootId = typeof input.rootId === "string" ? input.rootId.trim() : "";
  if (!rootId) {
    throw new HttpError(400, "rootId is required");
  }
  const snapshot = readRoundTrashSnapshot(rootId);
  if (!snapshot) {
    throw new HttpError(404, "復元データが見つかりません(ゴミ箱の保持期限切れの可能性があります)");
  }
  const projectId = snapshot.rounds[0]?.project_id;
  if (typeof projectId !== "string" || !getRow("SELECT id FROM projects WHERE id = ?", [projectId])) {
    throw new HttpError(409, "復元先の Project が存在しません");
  }

  runSql("BEGIN");
  try {
    for (const row of snapshot.rounds) {
      // ルートの親 Round が(別の削除で)存在しなくなっていたら root として復元する。
      const parentId = row.parent_round_id;
      const parentExists =
        typeof parentId === "string" && !!getRow("SELECT id FROM generation_rounds WHERE id = ?", [parentId]);
      insertSqlRow("generation_rounds", { ...row, parent_round_id: parentExists ? parentId : null });
    }
    for (const row of snapshot.jobs) {
      insertSqlRow("generation_jobs", row);
    }
    for (const row of snapshot.assets) {
      insertSqlRow("assets", row);
    }
    for (const row of snapshot.assetParents) {
      // サブツリー外の端点(親アセット等)が別の削除で消えていたら、その関連だけ諦める。
      const parentOk = getRow("SELECT id FROM assets WHERE id = ?", [row.parent_asset_id as string]);
      const childOk = getRow("SELECT id FROM assets WHERE id = ?", [row.child_asset_id as string]);
      if (parentOk && childOk && !getRow("SELECT id FROM asset_parents WHERE id = ?", [row.id as string])) {
        insertSqlRow("asset_parents", row);
      }
    }
    for (const row of snapshot.selectionEvents) {
      insertSqlRow("selection_events", row);
    }
    runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [projectId]);
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    throw error;
  }
  removeRoundTrashSnapshot(rootId);

  return {
    restored: true,
    roundIds: snapshot.rounds.map((row) => String(row.id)),
    restoredCount: snapshot.rounds.length
  };
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

function errorToJson(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
}
