import type { Round } from "../shared/apiTypes";
import type { GenerationRequest } from "../shared/types";
import { decorateAsset } from "./assets";
import { createId, getRow, runSql, toApiRow } from "./db";
import { normalizeGenerationRequest } from "./generationRequest";
import { HttpError } from "./http";
import { branchAssignmentForRound, nextRoundIndex } from "./roundBranches";
import { storeImage } from "./storage";
import { decodeImageDataUrl, normalizedUploadFileName } from "./uploadDataUrl";
import { numberOr, objectBody, positiveIntegerOr, requiredString, stringOr } from "./validate";

export async function createSourceAsset(projectId: string, body: unknown) {
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

  // Book のページに属するアップロードなら page_id を検証して保存する(single は null)。
  const rawPageId = input.pageId ?? input.page_id;
  const resolvedPageId = typeof rawPageId === "string" && rawPageId.trim() ? rawPageId : null;
  if (resolvedPageId && !getRow("SELECT id FROM pages WHERE id = ? AND project_id = ?", [resolvedPageId, projectId])) {
    throw new HttpError(400, "Page was not found in this Project");
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
    width: positiveIntegerOr(input.width, 1024),
    height: positiveIntegerOr(input.height, 1024),
    generationMode: "manual_upload",
    parentAssetId: null,
    relationType: "manual"
  });
  const stored = await storeImage(projectId, roundId, 0, filename, image.bytes);

  runSql(
    `INSERT INTO generation_rounds
      (id, project_id, template_id, parent_round_id, round_index, status, generation_mode,
       branch_color_index, branch_reason, branch_key, page_id, request_json, completed_at)
     VALUES (?, ?, ?, NULL, ?, 'completed', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      roundId,
      projectId,
      templateId,
      roundIndex,
      request.generationMode,
      branch.colorIndex,
      branch.reason,
      `asset:${assetId}`,
      resolvedPageId,
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
    round: toApiRow(getRow("SELECT * FROM generation_rounds WHERE id = ?", [roundId])) as unknown as Round | null,
    asset: decorateAsset(toApiRow(getRow("SELECT * FROM assets WHERE id = ?", [assetId]))!)
  };
}
