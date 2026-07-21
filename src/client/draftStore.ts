import { state, type GenerationDraft, type GenerationDraftField, type ReferenceDraft } from "./appState";
import type { InpaintDraft } from "./maskTypes";
import { defaultInpaintDraft, normalizeInpaintDraft } from "./maskDraft";
import type { PoseDraft } from "./poseTypes";
import type { StyleLoraSelection } from "../shared/types";

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

/**
 * 新規ページに引き継ぐ生成設定フィールド。顔参照画像(reference)と seed 値、img2img の親アセットは
 * 引き継がない(seed は毎回ランダム、参照は空スタート、新規ページは親なし=txt2img)。
 */
const CARRYOVER_FIELDS: GenerationDraftField[] = [
  "templateId",
  "img2imgTemplateId",
  "prompt",
  "negativePrompt",
  "seedMode",
  "batchSize",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "denoise",
  "width",
  "height"
];

/** GenerationDraft から引き継ぎ対象フィールドだけ抽出する(generationMode は txt2img に強制)。 */
export function carryoverFields(draft: GenerationDraft | null | undefined): GenerationDraft {
  const out: GenerationDraft = { generationMode: "txt2img", parentAssetId: "", seed: "", inpaint: null };
  if (draft) {
    for (const field of CARRYOVER_FIELDS) {
      const value = draft[field];
      if (typeof value === "string") {
        out[field] = value;
      }
    }
  }
  return out;
}

/**
 * Book: アクティブページの参照画像/スタイル LoRA/生成設定ドラフトを per-page マップへ書き戻す(書き込みスルー)。
 * 参照/LoRA/生成設定はフォームレベルの1枚(state.referenceDraft / state.loraDraft / state.generationDraft)を
 * 編集する作りなので、ページを離れる前・永続化の前にここで現ページのマップへ確定させる。生成設定は
 * 次ページ引き継ぎのスナップショットとして carryoverFields で正規化して持つ。activePageId が無い
 * (single / page grid / Book共通設定画面)場合は何もしない。
 */
export function commitActivePageDrafts() {
  const pageId = state.activePageId;
  if (!pageId) {
    return;
  }
  state.referenceDraftsByPage[pageId] = state.referenceDraft ?? { imageDataUrl: null };
  state.loraDraftsByPage[pageId] = state.loraDraft;
  state.pageSettingsByPage[pageId] = carryoverFields(state.generationDraft);
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
  commitActivePageDrafts();
  try {
    window.localStorage.setItem(
      draftStorageKey(projectId),
      JSON.stringify({
        generationDraft: state.generationDraft,
        generationDraftsByRound: state.generationDraftsByRound,
        inpaintDrafts: state.inpaintDrafts,
        poseDrafts: state.poseDrafts,
        referenceDraft: state.referenceDraft,
        loraDraft: state.loraDraft,
        referenceDraftsByPage: state.referenceDraftsByPage,
        loraDraftsByPage: state.loraDraftsByPage,
        pageSettingsByPage: state.pageSettingsByPage,
        bookCommonSettings: state.bookCommonSettings,
        bookCommonLora: state.bookCommonLora
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

export function restoreProjectDraft(projectId: string): {
  generationDraft: GenerationDraft | null;
  generationDraftsByRound: Record<string, GenerationDraft>;
  inpaintDrafts: Record<string, InpaintDraft>;
  poseDrafts: Record<string, PoseDraft>;
  referenceDraft: ReferenceDraft | null;
  loraDraft: StyleLoraSelection[];
  referenceDraftsByPage: Record<string, ReferenceDraft>;
  loraDraftsByPage: Record<string, StyleLoraSelection[]>;
  pageSettingsByPage: Record<string, GenerationDraft>;
  bookCommonSettings: GenerationDraft | null;
  bookCommonLora: StyleLoraSelection[] | null;
} | null {
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
      referenceDraft?: ReferenceDraft | null;
      loraDraft?: StyleLoraSelection[];
      referenceDraftsByPage?: Record<string, ReferenceDraft>;
      loraDraftsByPage?: Record<string, StyleLoraSelection[]>;
      pageSettingsByPage?: Record<string, GenerationDraft>;
      bookCommonSettings?: GenerationDraft | null;
      bookCommonLora?: StyleLoraSelection[] | null;
    };
    return {
      generationDraft: parsed.generationDraft ?? null,
      generationDraftsByRound: parsed.generationDraftsByRound ?? {},
      inpaintDrafts: resetWebSamSessionStatus(parsed.inpaintDrafts ?? {}),
      poseDrafts: resetPoseSessionStatus(parsed.poseDrafts ?? {}),
      referenceDraft: parsed.referenceDraft ?? null,
      loraDraft: parsed.loraDraft ?? [],
      referenceDraftsByPage: parsed.referenceDraftsByPage ?? {},
      loraDraftsByPage: parsed.loraDraftsByPage ?? {},
      pageSettingsByPage: parsed.pageSettingsByPage ?? {},
      bookCommonSettings: parsed.bookCommonSettings ?? null,
      bookCommonLora: parsed.bookCommonLora ?? null
    };
  } catch {
    return null;
  }
}

/**
 * worker のモデル status はプロセス内限りのセッション状態。localStorage から復元した draft に
 * "ready"/"detecting" 等が残っていると、再オープン初回の検出が「ready なのに worker セッション無し」で
 * 必ず1回エラーになるため、復元時に未取得状態へ戻す(キャッシュ有無は probe が改めて確認する)。
 */
function resetPoseSessionStatus(drafts: Record<string, PoseDraft>): Record<string, PoseDraft> {
  for (const draft of Object.values(drafts)) {
    draft.modelStatus = "idle";
    draft.modelDownloadProgress = 0;
    draft.modelStatusText = "未取得";
    draft.modelError = "";
  }
  return drafts;
}

function resetWebSamSessionStatus(drafts: Record<string, InpaintDraft>): Record<string, InpaintDraft> {
  for (const draft of Object.values(drafts)) {
    if (draft.selectedSmartMaskProvider !== "manual") {
      draft.webSamModelStatus = "idle";
      draft.webSamDownloadProgress = 0;
      draft.webSamStatusText = "未取得";
      draft.webSamError = "";
    }
  }
  return drafts;
}

/** Project を離れる際(ホームへ戻る等)の draft リセット。永続化済みの draft には触れない。 */
export function resetProjectDrafts() {
  flushProjectDraftPersist();
  state.generationDraft = null;
  state.generationDraftsByRound = {};
  state.inpaintDrafts = {};
  state.paintDrafts = {};
  state.poseDrafts = {};
  state.referenceDraft = null;
  state.loraDraft = [];
  state.referenceDraftsByPage = {};
  state.loraDraftsByPage = {};
  state.pageSettingsByPage = {};
  state.bookCommonSettings = null;
  state.bookCommonLora = null;
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
  state.referenceDraft = restored?.referenceDraft ?? null;
  state.loraDraft = restored?.loraDraft ?? [];
  state.referenceDraftsByPage = restored?.referenceDraftsByPage ?? {};
  state.loraDraftsByPage = restored?.loraDraftsByPage ?? {};
  state.pageSettingsByPage = restored?.pageSettingsByPage ?? {};
  state.bookCommonSettings = restored?.bookCommonSettings ?? null;
  state.bookCommonLora = restored?.bookCommonLora ?? null;
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

/**
 * グリッドの MASK バッジから、モーダルを開いていない(=非 active)アセットの
 * `enabled` だけを直接切り替える。`setInpaintDraft` と違い `state.generationDraft.inpaint`
 * を無条件に上書きしない(対象アセットが現在の生成親でない限り、次回生成の参照先を壊さない)。
 */
export function setInpaintEnabledForAsset(assetId: string, enabled: boolean) {
  const draft = inpaintDraftForAsset(assetId);
  if (!draft) {
    return;
  }
  const normalized = normalizeInpaintDraft({ ...draft, enabled });
  state.inpaintDrafts[assetId] = normalized;
  const isCurrentGenerationParent =
    state.generationDraft?.inpaint?.parentAssetId === assetId || state.generationDraft?.parentAssetId === assetId;
  if (isCurrentGenerationParent) {
    state.generationDraft = { ...(state.generationDraft ?? {}), inpaint: normalized };
  }
  if (state.currentProjectId) {
    persistProjectDraft(state.currentProjectId);
  }
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
