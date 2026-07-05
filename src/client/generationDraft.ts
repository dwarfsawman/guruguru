import {
  defaultDenoiseForMode,
  normalizeDenoiseForMode,
  requiresFullDenoise
} from "../shared/generationMode";
import type { ControlNetOptions, GenerationMode, GenerationRequest, InpaintOptions } from "../shared/types";
import type { Asset, ProjectDetail } from "../shared/apiTypes";
import { formatSliderValue } from "./format";
import {
  generationDraftFields,
  requestRender,
  state,
  type GenerationDraft,
  type GenerationDraftField
} from "./appState";
import { persistProjectDraft, inpaintDraftForAsset } from "./draftStore";
import { findAsset } from "./assetLookup";
import { effectiveMaskDataUrl } from "./maskEditorController";
import { hasActivePoseData } from "./poseDraft";
import { renderPoseSkeletonDataUrl } from "./poseSkeleton";
import { poseDraftForAsset } from "./poseEditorController";
import { defaultPrompt } from "./views/generationPanel";

export function captureGenerationDraft() {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (!form) {
    return;
  }
  state.generationDraft = generationDraftFromForm(form);
  if (state.currentProjectId) {
    persistProjectDraft(state.currentProjectId);
  }
}

export function generationDraftFromForm(form: HTMLFormElement): GenerationDraft {
  const draft: GenerationDraft = {
    inpaint: null
  };
  for (const field of generationDraftFields) {
    const control = form.elements.namedItem(field) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (control) {
      draft[field] = control.value;
    }
  }
  draft.inpaint = inpaintDraftForAsset(draft.parentAssetId) ?? null;
  return draft;
}

export function generationDraftFromRequest(request: GenerationRequest): GenerationDraft {
  return {
    templateId: request.templateId,
    img2imgTemplateId: request.generationMode === "img2img" ? request.templateId : "",
    parentAssetId: request.parentAssetId ?? "",
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    seed: request.seed === null ? "" : String(request.seed),
    seedMode: request.seedMode,
    batchSize: String(request.batchSize),
    steps: String(request.steps),
    cfg: String(request.cfg),
    sampler: request.sampler,
    scheduler: request.scheduler,
    denoise: String(request.denoise),
    width: String(request.width),
    height: String(request.height),
    generationMode: request.generationMode,
    inpaint: null
  };
}

export function setGenerationDraftValue(field: GenerationDraftField, value: string) {
  state.generationDraft = {
    ...(state.generationDraft ?? {}),
    [field]: value
  };
  if (state.currentProjectId) {
    persistProjectDraft(state.currentProjectId);
  }
}

export function draftNumber(draft: GenerationDraft | null, field: GenerationDraftField) {
  const value = draft?.[field];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function setPositivePromptDraft(value: string) {
  setGenerationDraftValue("prompt", value);
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (form) {
    setFormValue(form, "prompt", value);
  }
  syncPreviewPromptControl(value);
}

export function setGenerationSliderDraft(field: GenerationDraftField, control: HTMLInputElement) {
  setGenerationDraftValue(field, control.value);
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (form) {
    setFormValue(form, field, control.value);
  }
}

export function syncPreviewPromptControl(value: string) {
  const control = document.querySelector<HTMLTextAreaElement>("[data-generation-field='prompt']");
  if (control && control.value !== value) {
    control.value = value;
  }
}

export function inpaintRequestForParent(parentAssetId: string | null, generationMode: string): InpaintOptions | null {
  if (generationMode !== "img2img" || !parentAssetId) {
    return null;
  }
  const draft = inpaintDraftForAsset(parentAssetId);
  if (!draft || draft.enabled !== true) {
    return null;
  }
  const maskDataUrl = effectiveMaskDataUrl(draft);
  if (!maskDataUrl.startsWith("data:image/png;base64,")) {
    return null;
  }
  return {
    maskDataUrl,
    maskedContent: draft.maskedContent,
    inpaintArea: draft.inpaintArea,
    onlyMaskedPadding: draft.onlyMaskedPadding,
    featherRadius: draft.featherRadius
  };
}

export function controlnetRequestForParent(
  parentAssetId: string | null,
  generationMode: string,
  template: { workflowJson: unknown }
): ControlNetOptions | null {
  if (!parentAssetId) {
    return null;
  }
  const draft = poseDraftForAsset(parentAssetId);
  if (!hasActivePoseData(draft) || draft.imageWidth === null || draft.imageHeight === null) {
    return null;
  }
  if (!workflowHasControlNetApply(template.workflowJson)) {
    return null;
  }
  const poseImageDataUrl = renderPoseSkeletonDataUrl(draft.poses, draft.imageWidth, draft.imageHeight, draft.removedBones);
  if (!poseImageDataUrl.startsWith("data:image/png;base64,")) {
    return null;
  }
  return {
    poseImageDataUrl,
    strength: draft.strength,
    startPercent: draft.startPercent,
    endPercent: draft.endPercent
  };
}

export function workflowHasControlNetApply(workflowJson: unknown): boolean {
  if (!workflowJson || typeof workflowJson !== "object") {
    return false;
  }
  return Object.values(workflowJson as Record<string, unknown>).some((node) => {
    return !!node && typeof node === "object" && (node as { class_type?: unknown }).class_type === "ControlNetApplyAdvanced";
  });
}

export function updateDenoiseControlForMode(mode: string) {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  const control = form?.elements.namedItem("denoise") as HTMLInputElement | null;
  if (!form || !control) {
    return;
  }

  const current = Number(control.value);
  const value = requiresFullDenoise(mode)
    ? 1
    : !Number.isFinite(current) || current >= 1
      ? defaultDenoiseForMode(mode)
      : current;
  setFormValue(form, "denoise", String(value));
}

export function fillGenerationFormFromAsset(asset: Asset, mode: string) {
  state.activeAssetId = asset.id;
  requestRender();
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (!form) {
    return;
  }
  setFormValue(form, "parentAssetId", asset.id);
  setFormValue(form, "generationMode", mode);
  setFormValue(form, "prompt", asset.prompt);
  setFormValue(form, "negativePrompt", asset.negativePrompt);
  setFormValue(form, "seed", String(asset.seed ?? ""));
  setFormValue(form, "seedMode", "random");
  applyAssetDimensionsToForm(form, asset);
  preserveDenoiseOnAssetFill(form, mode);
  captureGenerationDraft();
}

export function preserveDenoiseOnAssetFill(form: HTMLFormElement, mode: string) {
  const denoise = form.elements.namedItem("denoise") as HTMLInputElement | null;
  if (!denoise) {
    return;
  }
  if (requiresFullDenoise(mode)) {
    setFormValue(form, "denoise", "1");
    return;
  }
  const current = Number(denoise.value);
  if (!Number.isFinite(current) || current <= 0 || current >= 1) {
    setFormValue(form, "denoise", String(defaultDenoiseForMode(mode)));
  }
}

export function prepareGenerationFormForParent(asset: Asset, mode: string) {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (!form) {
    return;
  }

  const previousMode = (form.elements.namedItem("generationMode") as HTMLSelectElement | null)?.value ?? "txt2img";
  const previousParentAssetId = (form.elements.namedItem("parentAssetId") as HTMLInputElement | null)?.value ?? "";
  const denoise = form.elements.namedItem("denoise") as HTMLInputElement | null;
  setFormValue(form, "parentAssetId", asset.id);
  setFormValue(form, "generationMode", mode);
  if (previousParentAssetId !== asset.id) {
    applyAssetDimensionsToForm(form, asset);
  }

  if (denoise && requiresFullDenoise(previousMode) && Number(denoise.value) >= 1 && !requiresFullDenoise(mode)) {
    setFormValue(form, "denoise", String(defaultDenoiseForMode(mode)));
  }

  captureGenerationDraft();
}

export function applyAssetDimensionsToForm(form: HTMLFormElement, asset: Asset) {
  if (typeof asset.width === "number" && Number.isFinite(asset.width)) {
    setFormValue(form, "width", String(asset.width));
  }
  if (typeof asset.height === "number" && Number.isFinite(asset.height)) {
    setFormValue(form, "height", String(asset.height));
  }
}

export function applyAssetDimensionsToDraft(asset: Asset) {
  if (typeof asset.width === "number" && Number.isFinite(asset.width)) {
    setGenerationDraftValue("width", String(asset.width));
  }
  if (typeof asset.height === "number" && Number.isFinite(asset.height)) {
    setGenerationDraftValue("height", String(asset.height));
  }
}

function setFormValue(form: HTMLFormElement, name: string, value: string) {
  const control = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (control) {
    control.value = value;
    const valueTargetId = (control as HTMLElement).dataset.valueTarget;
    if (valueTargetId && control instanceof HTMLInputElement) {
      const valueTarget = document.getElementById(valueTargetId);
      if (valueTarget) {
        valueTarget.textContent = formatSliderValue(control);
      }
    }
  }
}

export function resolveTemplateForGeneration(templateId: string, mode: string) {
  const current = state.templates.find((template) => template.id === templateId) ?? null;
  if (!current) {
    throw new Error(`${mode}用WorkflowTemplateが選択されていません。`);
  }
  return current;
}

export function preserveGenerationDenoise() {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  const denoiseControl = form?.elements.namedItem("denoise") as HTMLInputElement | null;
  const denoiseValue = denoiseControl?.value ?? state.generationDraft?.denoise;
  state.generationDraft = denoiseValue ? { denoise: denoiseValue } : null;
}

export function currentPositivePromptValue(asset: Asset) {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return state.generationDraft?.prompt ?? activeRound?.request?.prompt ?? asset.prompt ?? defaultPrompt;
}

export function currentBatchSizeValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return draftNumber(state.generationDraft, "batchSize") ?? activeRound?.request?.batchSize ?? 16;
}

export function currentGenerationModeValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  const requestMode = activeRound?.request?.generationMode;
  return (state.generationDraft?.generationMode ?? (requestMode === "manual_upload" ? "img2img" : requestMode) ?? "txt2img") as GenerationMode;
}

export function currentStepsValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return draftNumber(state.generationDraft, "steps") ?? activeRound?.request?.steps ?? 20;
}

export function currentCfgValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return draftNumber(state.generationDraft, "cfg") ?? activeRound?.request?.cfg ?? 7;
}

export function currentDenoiseValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  const mode = currentGenerationModeValue();
  const raw = draftNumber(state.generationDraft, "denoise") ?? activeRound?.request?.denoise ?? defaultDenoiseForMode(mode);
  return normalizeDenoiseForMode(raw, mode);
}

export function currentWidthValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return draftNumber(state.generationDraft, "width") ?? activeRound?.request?.width ?? 512;
}

export function currentHeightValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return draftNumber(state.generationDraft, "height") ?? activeRound?.request?.height ?? 768;
}

export function currentSeedValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return state.generationDraft?.seed ?? String(activeRound?.request?.seed ?? -1);
}

export function currentSeedModeValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return state.generationDraft?.seedMode ?? activeRound?.request?.seedMode ?? "random";
}

export function currentSamplerValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return state.generationDraft?.sampler ?? activeRound?.request?.sampler ?? "euler";
}

export function currentSchedulerValue() {
  const activeRound = state.detail ? getActiveRound(state.detail) : null;
  return state.generationDraft?.scheduler ?? activeRound?.request?.scheduler ?? "normal";
}

export function getActiveRound(detail: ProjectDetail) {
  return detail.rounds.find((round) => round.id === state.activeRoundId) ?? detail.rounds[0] ?? null;
}

export function findRound(roundId: string | null) {
  if (!roundId || !state.detail) {
    return null;
  }
  return state.detail.rounds.find((round) => round.id === roundId) ?? null;
}

export function getActiveRoundAssets() {
  if (!state.detail) {
    return [];
  }
  const activeRound = getActiveRound(state.detail);
  if (!activeRound) {
    return [];
  }
  return state.detail.assets.filter((asset) => asset.roundId === activeRound.id);
}

export function getPreferredParentAsset() {
  const active = findAsset(state.activeAssetId);
  if (active) {
    return active;
  }
  return getActiveRoundAssets().find((asset) => asset.status === "selected") ?? null;
}

export function assetPassesFilter(asset: Asset) {
  if (state.filter === "all") {
    return true;
  }
  if (state.filter === "unmarked") {
    return asset.status === "generated";
  }
  return asset.status === state.filter;
}
