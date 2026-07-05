import { state, type GenerationDraft } from "./appState";
import type { InpaintDraft } from "./maskTypes";
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
