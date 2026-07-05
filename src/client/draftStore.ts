import { state, type GenerationDraft } from "./appState";
import type { InpaintDraft } from "./maskTypes";
import { defaultInpaintDraft, normalizeInpaintDraft } from "./maskDraft";
import type { PoseDraft } from "./poseTypes";

const DRAFT_STORAGE_PREFIX = "guruguru:draft:";

export function draftStorageKey(projectId: string) {
  return `${DRAFT_STORAGE_PREFIX}${projectId}`;
}

export function persistProjectDraft(projectId: string) {
  try {
    window.localStorage.setItem(
      draftStorageKey(projectId),
      JSON.stringify({
        generationDraft: state.generationDraft,
        inpaintDrafts: state.inpaintDrafts,
        poseDrafts: state.poseDrafts
      })
    );
  } catch {
    // localStorage が使えない環境（プライベートブラウジング等）では永続化を諦める。
  }
}

export function restoreProjectDraft(projectId: string): { generationDraft: GenerationDraft | null; inpaintDrafts: Record<string, InpaintDraft>; poseDrafts: Record<string, PoseDraft> } | null {
  try {
    const raw = window.localStorage.getItem(draftStorageKey(projectId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      generationDraft?: GenerationDraft | null;
      inpaintDrafts?: Record<string, InpaintDraft>;
      poseDrafts?: Record<string, PoseDraft>;
    };
    return {
      generationDraft: parsed.generationDraft ?? null,
      inpaintDrafts: parsed.inpaintDrafts ?? {},
      poseDrafts: parsed.poseDrafts ?? {}
    };
  } catch {
    return null;
  }
}

export function inpaintDraftForAsset(assetId: string | null | undefined) {
  const stored = assetId ? state.inpaintDrafts[assetId] : null;
  if (stored) {
    const normalized = normalizeInpaintDraft(stored);
    state.inpaintDrafts[normalized.parentAssetId] = normalized;
    return normalized;
  }
  const draft = state.generationDraft?.inpaint;
  if (!assetId || !draft || draft.parentAssetId !== assetId) {
    return null;
  }
  const normalized = normalizeInpaintDraft(draft);
  state.inpaintDrafts[assetId] = normalized;
  return normalized;
}

export function setInpaintDraft(draft: InpaintDraft | null) {
  const previousAssetId =
    state.generationDraft?.inpaint?.parentAssetId ??
    state.generationDraft?.parentAssetId ??
    state.activeAssetId;
  const normalized = draft ? normalizeInpaintDraft(draft) : null;
  if (normalized) {
    state.inpaintDrafts[normalized.parentAssetId] = normalized;
  } else if (previousAssetId) {
    delete state.inpaintDrafts[previousAssetId];
  }
  state.generationDraft = {
    ...(state.generationDraft ?? {}),
    inpaint: normalized
  };
  if (state.currentProjectId) {
    persistProjectDraft(state.currentProjectId);
  }
}

export function ensureInpaintDraft(assetId: string) {
  const draft = normalizeInpaintDraft(inpaintDraftForAsset(assetId) ?? defaultInpaintDraft(assetId));
  state.inpaintDrafts[assetId] = draft;
  state.generationDraft = {
    ...(state.generationDraft ?? {}),
    parentAssetId: assetId,
    generationMode: "img2img",
    inpaint: draft
  };
  return draft;
}
