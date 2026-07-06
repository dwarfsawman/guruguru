import { state, type GenerationDraft } from "./appState";
import type { InpaintDraft } from "./maskTypes";
import { defaultInpaintDraft, normalizeInpaintDraft } from "./maskDraft";
import type { PoseDraft } from "./poseTypes";

const DRAFT_STORAGE_PREFIX = "guruguru:draft:";

export function draftStorageKey(projectId: string) {
  return `${DRAFT_STORAGE_PREFIX}${projectId}`;
}

/**
 * localStorage への永続化は debounce する。InpaintDraft のマスク dataURL は数MBに
 * なり得るため、毎 render の同期 JSON.stringify + setItem は UI(タブ切替等)を
 * 目に見えて遅くする。書き込みはアイドル後に 1 回だけ行い、unload 時に flush する。
 */
const PERSIST_DRAFT_DEBOUNCE_MS = 400;
let persistDraftTimer: number | null = null;
let persistDraftPendingProjectId: string | null = null;

export function persistProjectDraft(projectId: string) {
  persistDraftPendingProjectId = projectId;
  if (persistDraftTimer !== null) {
    return;
  }
  persistDraftTimer = window.setTimeout(() => {
    persistDraftTimer = null;
    flushProjectDraftPersist();
  }, PERSIST_DRAFT_DEBOUNCE_MS);
}

/** 保留中の draft 永続化を即時に書き込む(unload / プロジェクト離脱時)。 */
export function flushProjectDraftPersist() {
  if (persistDraftTimer !== null) {
    window.clearTimeout(persistDraftTimer);
    persistDraftTimer = null;
  }
  const projectId = persistDraftPendingProjectId;
  persistDraftPendingProjectId = null;
  if (!projectId) {
    return;
  }
  try {
    window.localStorage.setItem(
      draftStorageKey(projectId),
      JSON.stringify({
        generationDraft: state.generationDraft,
        generationDraftsByRound: state.generationDraftsByRound,
        inpaintDrafts: state.inpaintDrafts,
        poseDrafts: state.poseDrafts
      })
    );
  } catch {
    // localStorage が使えない環境（プライベートブラウジング等）では永続化を諦める。
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    flushProjectDraftPersist();
  });
}

export function restoreProjectDraft(projectId: string): { generationDraft: GenerationDraft | null; generationDraftsByRound: Record<string, GenerationDraft>; inpaintDrafts: Record<string, InpaintDraft>; poseDrafts: Record<string, PoseDraft> } | null {
  try {
    const raw = window.localStorage.getItem(draftStorageKey(projectId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      generationDraft?: GenerationDraft | null;
      generationDraftsByRound?: Record<string, GenerationDraft>;
      inpaintDrafts?: Record<string, InpaintDraft>;
      poseDrafts?: Record<string, PoseDraft>;
    };
    return {
      generationDraft: parsed.generationDraft ?? null,
      generationDraftsByRound: parsed.generationDraftsByRound ?? {},
      inpaintDrafts: parsed.inpaintDrafts ?? {},
      poseDrafts: parsed.poseDrafts ?? {}
    };
  } catch {
    return null;
  }
}

/** Project を離れる際(ホームへ戻る等)の draft リセット。永続化済みの draft には触れない。 */
export function resetProjectDrafts() {
  flushProjectDraftPersist();
  state.generationDraft = null;
  state.generationDraftsByRound = {};
  state.inpaintDrafts = {};
  state.paintDrafts = {};
  state.poseDrafts = {};
}

/** Project を開く際、永続化済みの draft があれば復元し、なければリセットする。 */
export function restoreOrResetProjectDrafts(projectId: string) {
  // 前プロジェクトの保留中 debounce 書き込みを、state を差し替える前に確定させる。
  flushProjectDraftPersist();
  const restored = restoreProjectDraft(projectId);
  state.generationDraft = restored?.generationDraft ?? null;
  state.generationDraftsByRound = restored?.generationDraftsByRound ?? {};
  state.inpaintDrafts = restored?.inpaintDrafts ?? {};
  state.paintDrafts = {};
  state.poseDrafts = restored?.poseDrafts ?? {};
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
