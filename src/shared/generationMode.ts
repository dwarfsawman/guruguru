import type { ParentRelation } from "./types";

export function requiresFullDenoise(mode: string) {
  return mode === "txt2img" || mode === "seed_reuse" || mode === "prompt_reuse";
}

export function defaultDenoiseForMode(mode: string) {
  if (requiresFullDenoise(mode)) {
    return 1;
  }
  return mode === "img2img" ? 0.8 : 0.45;
}

export function normalizeDenoiseForMode(value: number, mode: string) {
  if (requiresFullDenoise(mode)) {
    return 1;
  }
  if (!Number.isFinite(value)) {
    return defaultDenoiseForMode(mode);
  }
  return Math.min(1, Math.max(0, value));
}

export function requiresParentAsset(mode: string) {
  return mode === "img2img" || mode === "ipadapter" || mode === "controlnet";
}

export function relationForGenerationMode(mode: string): ParentRelation {
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
