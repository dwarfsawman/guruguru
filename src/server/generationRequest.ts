import {
  defaultDenoiseForMode,
  normalizeDenoiseForMode,
  relationForGenerationMode
} from "../shared/generationMode";
import type { GenerationMode, GenerationRequest, ParentRelation, StyleLoraSelection } from "../shared/types";
import { numberOr, positiveIntegerOr, requiredString, stringOr, stringOrNull } from "./validate";

export const maxStyleLoras = 4;

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
    relationType: (stringOrNull(input.relationType) as ParentRelation | null) ?? relationForGenerationMode(generationMode),
    loras: normalizeStyleLoras(input.loras)
  };
}

function normalizeStyleLoras(raw: unknown): StyleLoraSelection[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({ name: stringOr(entry.name, "").trim(), strength: clampStrength(numberOr(entry.strength, 1)) }))
    .filter((lora) => lora.name !== "")
    .slice(0, maxStyleLoras);
}

function clampStrength(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(2, Math.max(0, value));
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
