import type { RepairScriptMangaTaskRequest } from "../shared/scriptMangaApi";
import type { GenerationRequest, ReferenceImageOptions } from "../shared/types";
import { HttpError } from "./http";
import { objectBody, requiredString, stringOr } from "./validate";

export interface ParsedScriptMangaRepairRequest {
  assetId: string;
  denoise: number;
  inpaint: NonNullable<GenerationRequest["inpaint"]> & { maskDataUrl: string };
}

export interface ScriptMangaRepairParent {
  assetId: string;
  width: number;
  height: number;
  seed: number | null;
  providerId: string;
  request: GenerationRequest;
  /** A fresh data URL reconstructed from the parent round attachment, when pose was used. */
  poseImageDataUrl?: string | null;
  /** Exact bytes reconstructed from the parent round's face/reference attachment. */
  referenceImageDataUrl?: string | null;
}

const maskedContents = new Set(["fill", "original", "latent_noise", "latent_nothing"]);

function finiteNumber(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new HttpError(400, `${label} must be a finite number`);
  return parsed;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const parsed = finiteNumber(value, fallback, label);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

/** Parse the deliberately small repair surface. Story/prompt/workflow fields are not client-overridable. */
export function parseScriptMangaRepairRequest(body: unknown): ParsedScriptMangaRepairRequest {
  const input = objectBody(body);
  const rawInpaint = objectBody(input.inpaint);
  const denoise = finiteNumber(input.denoise, 0.45, "denoise");
  if (denoise <= 0 || denoise >= 1) throw new HttpError(400, "denoise must be greater than 0 and less than 1");
  const maskedContent = stringOr(rawInpaint.maskedContent, "original");
  if (!maskedContents.has(maskedContent)) throw new HttpError(400, `Unsupported maskedContent value: ${maskedContent}`);
  const inpaintArea = stringOr(rawInpaint.inpaintArea, "only_masked");
  if (inpaintArea !== "only_masked") throw new HttpError(400, "Only inpaintArea='only_masked' is supported.");

  return {
    assetId: requiredString(input.assetId, "assetId"),
    denoise,
    inpaint: {
      maskDataUrl: requiredString(rawInpaint.maskDataUrl, "inpaint.maskDataUrl"),
      maskPath: null,
      maskWidth: null,
      maskHeight: null,
      maskedContent: maskedContent as ParsedScriptMangaRepairRequest["inpaint"]["maskedContent"],
      inpaintArea: "only_masked",
      onlyMaskedPadding: boundedInteger(rawInpaint.onlyMaskedPadding, 32, 0, 512, "inpaint.onlyMaskedPadding"),
      featherRadius: boundedInteger(rawInpaint.featherRadius, 0, 0, 30, "inpaint.featherRadius")
    }
  };
}

/** Round-local paths are never copied. Reuse a pinned set, or copy the exact safe attachment as data. */
function reproducibleReference(
  reference: GenerationRequest["reference"],
  referenceImageDataUrl: string | null | undefined
): ReferenceImageOptions | null {
  if (!reference) return null;
  const common = {
    face: reference.face,
    animaInContext: reference.animaInContext ?? null,
    strict: reference.strict
  };
  if (reference.referenceSet?.setId && reference.referenceSet.version > 0) {
    return { ...common, referenceSet: { ...reference.referenceSet } };
  }
  if (reference.images?.fullBodyPath) {
    throw new HttpError(409, "The parent candidate uses a non-reproducible full-body reference image");
  }
  const usedReference = Boolean(
    reference.imagePath ||
    reference.images?.facePath ||
    reference.characterBinding ||
    reference.imageDataUrl
  );
  if (usedReference) {
    if (!referenceImageDataUrl) {
      throw new HttpError(409, "The parent candidate reference attachment could not be reproduced");
    }
    return { ...common, imageDataUrl: referenceImageDataUrl };
  }
  return null;
}

/** Build an img2img request while freezing every non-repair field to the chosen parent candidate. */
export function buildScriptMangaRepairGenerationRequest(
  parent: ScriptMangaRepairParent,
  repair: ParsedScriptMangaRepairRequest
): GenerationRequest & { providerId: string } {
  if (!Number.isInteger(parent.width) || parent.width < 1 || !Number.isInteger(parent.height) || parent.height < 1) {
    throw new HttpError(422, "Parent candidate dimensions are unavailable for inpaint repair");
  }
  const source = parent.request;
  const controlnet = source.controlnet && parent.poseImageDataUrl
    ? {
        poseImageDataUrl: parent.poseImageDataUrl,
        strength: source.controlnet.strength,
        startPercent: source.controlnet.startPercent,
        endPercent: source.controlnet.endPercent
      }
    : null;
  if (source.controlnet && !controlnet) {
    throw new HttpError(409, "The parent candidate pose attachment could not be reproduced");
  }
  const frozenSeed = parent.seed ?? source.seed;
  if (!Number.isFinite(frozenSeed)) {
    throw new HttpError(409, "The parent candidate seed is unavailable for a reproducible repair");
  }

  return {
    templateId: source.templateId,
    prompt: source.prompt,
    negativePrompt: source.negativePrompt,
    seed: frozenSeed,
    seedMode: "reuse_parent_seed",
    batchSize: 1,
    steps: source.steps,
    cfg: source.cfg,
    sampler: source.sampler,
    scheduler: source.scheduler,
    denoise: repair.denoise,
    width: parent.width,
    height: parent.height,
    generationMode: "img2img",
    parentAssetId: parent.assetId,
    relationType: "img2img",
    inpaint: repair.inpaint,
    controlnet,
    pasteComposite: null,
    reference: reproducibleReference(source.reference, parent.referenceImageDataUrl),
    loras: source.loras ?? null,
    providerId: parent.providerId
  };
}

export type { RepairScriptMangaTaskRequest };
