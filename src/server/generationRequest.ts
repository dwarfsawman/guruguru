import {
  defaultDenoiseForMode,
  normalizeDenoiseForMode,
  relationForGenerationMode
} from "../shared/generationMode";
import type { GenerationMode, GenerationRequest, ParentRelation } from "../shared/types";
import { numberOr, positiveIntegerOr, requiredString, stringOr, stringOrNull } from "./validate";

export const maxBatchSize = 32;

export function normalizeGenerationRequest(input: GenerationRequest): GenerationRequest {
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
    width: positiveIntegerOr(input.width, 1024),
    height: positiveIntegerOr(input.height, 1024),
    generationMode,
    parentAssetId: stringOrNull(input.parentAssetId),
    relationType: (stringOrNull(input.relationType) as ParentRelation | null) ?? relationForGenerationMode(generationMode)
  };
}

export function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
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
  return normalizeDenoiseForMode(numberOr(rawDenoise, defaultDenoiseForMode(mode)), mode);
}
