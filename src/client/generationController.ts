import {
  defaultDenoiseForMode,
  normalizeDenoiseForMode,
  relationForGenerationMode,
  requiresParentAsset
} from "../shared/generationMode";
import type { GenerationMode, GenerationRequest } from "../shared/types";
import type { Asset, CollectRoundResponse, PageDetail, ProjectDetail, Round } from "../shared/apiTypes";
import { api } from "./api";
import { type Json } from "./json";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { findAsset } from "./assetLookup";
import { delay } from "./clientUtils";
import { readForm } from "./formUtils";
import { inpaintDraftForAsset } from "./draftStore";
import { templateGenerationDefaults, defaultModeForTemplate } from "./workflowDefaults";
import {
  applyAssetDimensionsToDraft,
  captureGenerationDraft,
  controlnetRequestForParent,
  fillGenerationFormFromAsset,
  findRound,
  generationDraftFromForm,
  generationDraftFromRequest,
  getActiveRound,
  getActiveRoundAssets,
  getPreferredParentAsset,
  inpaintRequestForParent,
  prepareGenerationFormForParent,
  referenceRequestForForm,
  rememberActiveRoundDraft,
  resolveTemplateForGeneration,
  restoreGenerationDraftForRound,
  roundsForActivePanelTarget,
  setGenerationDraftValue
} from "./generationDraft";
import { openAssetDetail } from "./assetDetailController";
import { styleLorasForRequest } from "./styleLoraController";
import { commitActiveMaskCanvas } from "./maskEditorController";
import {
  activePaintCanvasAndAsset,
  commitActivePaintCanvas,
  getOrCreatePaintLayer,
  paintHistoryStacks,
  paintLayerCache
} from "./paintEditorController";
import { composePaintResultCanvas } from "./paintCanvas";
import { buildPasteCompositeForGeneration, pasteLayersForAsset } from "./pasteObjectController";
import { clearActiveImagePan } from "./maskEditorController";
import { downloadBlob } from "./downloadUtils";
import { setFormValue } from "./formUtils";

const pendingAutoCollectRoundIds = new Set<string>();
const autoCollectIntervalMs = 3_000;
/**
 * ゴミ箱へ削除済み(未復元)の roundId。削除後も生きている pollCollectRound のループが
 * 削除済み Round へ collect を投げて 404 のエラートーストを出さないための目印。
 * 復元(undo)で取り除き、プロジェクトを離れる時にクリアする。
 */
const recentlyDeletedRoundIds = new Set<string>();

const VALID_GENERATION_MODES: ReadonlyArray<GenerationMode> = [
  "txt2img", "img2img", "ipadapter", "controlnet", "seed_reuse", "prompt_reuse", "upscale", "detail", "manual_upload"
];
const VALID_SEED_MODES: ReadonlyArray<GenerationRequest["seedMode"]> = ["fixed", "random", "increment", "reuse_parent_seed"];

export async function generateRound(parentAsset: Asset | null, overrideMode?: string) {
  const projectId = state.currentProjectId;
  if (!projectId) {
    return;
  }

  const form = readForm("generation-form");
  // ブランチング後に親ノードへ戻ったとき、編集途中の内容(プロンプト等)を
  // 復元できるよう、送信前のフォーム内容を現在の Round に記憶しておく。
  rememberActiveRoundDraft();
  const rawMode = overrideMode ?? form.generationMode ?? "txt2img";
  // フォーム/呼び出し元由来の文字列は無検証キャストせず、既知の値のみ通す。
  const generationMode = (VALID_GENERATION_MODES as readonly string[]).includes(rawMode)
    ? rawMode
    : "txt2img";
  const resolvedParentAsset = resolveParentAssetForGeneration(parentAsset, generationMode, form.parentAssetId);
  const parentAssetId = resolvedParentAsset?.id ?? null;
  const requestedTemplateId = generationMode === "img2img"
    ? form.img2imgTemplateId || form.templateId
    : form.templateId;
  const template = resolveTemplateForGeneration(requestedTemplateId, generationMode);
  const denoise = normalizeDenoiseForMode(
    Number(form.denoise || defaultDenoiseForMode(generationMode)),
    generationMode
  );
  const inpaint = inpaintRequestForParent(parentAssetId, generationMode);
  const controlnet = controlnetRequestForParent(parentAssetId, generationMode, template);
  const request: GenerationRequest = {
    templateId: template.id,
    prompt: form.prompt,
    negativePrompt: form.negativePrompt,
    seed: form.seed ? Number(form.seed) : null,
    seedMode: (VALID_SEED_MODES as readonly string[]).includes(form.seedMode ?? "")
      ? (form.seedMode as GenerationRequest["seedMode"])
      : "fixed",
    batchSize: Number(form.batchSize || 16),
    steps: Number(form.steps || 20),
    cfg: Number(form.cfg || 6),
    sampler: form.sampler || "euler",
    scheduler: form.scheduler || "normal",
    denoise,
    width: Number(form.width || 1024),
    height: Number(form.height || 1024),
    generationMode: generationMode as GenerationMode,
    parentAssetId,
    relationType: resolvedParentAsset ? relationForGenerationMode(generationMode) : null
  };
  if (inpaint) {
    request.inpaint = inpaint;
  }
  if (controlnet) {
    request.controlnet = controlnet;
  }
  const reference = referenceRequestForForm();
  if (reference) {
    request.reference = reference;
  }
  const loras = styleLorasForRequest();
  if (loras.length > 0) {
    request.loras = loras;
  }
  // 貼り付け(添付)やペイントがあれば「見たまま」を合成して img2img 入力にする
  // (保存操作なし。親アセット・ツリーは不変 — Docs/Feature-ImagePaste.md)。
  // ペイントストロークは未保存でも含める(ユーザー確認済みの決定事項)。
  if (resolvedParentAsset && requiresParentAsset(generationMode)) {
    commitActivePaintCanvas();
    const composite = await buildPasteCompositeForGeneration(resolvedParentAsset);
    if (composite) {
      request.pasteComposite = composite;
    }
  }
  setGenerationDraftValue(generationMode === "img2img" ? "img2imgTemplateId" : "templateId", template.id);
  setGenerationDraftValue("generationMode", generationMode);

  state.busy = true;
  requestRender();
  const response = await api<{ promptId: string; round: Round }>(`/api/projects/${projectId}/rounds`, {
    method: "POST",
    // コマ内生成(Docs/Feature-PanelGeneration.md): targetPanelId は GenerationRequest に含めず
    // pageId と同じ扱いのサイドカーフィールドとしてサーバへ渡す(generation_rounds の別列)。
    body: JSON.stringify({ ...request, pageId: state.activePageId, targetPanelId: state.activePanelTarget?.panelId ?? null })
  });
  const roundId = response.round.id;
  const previousInpaint = parentAssetId ? inpaintDraftForAsset(parentAssetId) : null;
  state.generationDraft = generationDraftFromRequest(response.round.request);
  if (previousInpaint && inpaint && previousInpaint.parentAssetId === parentAssetId) {
    state.generationDraft.inpaint = previousInpaint;
  }
  state.generationDraftsByRound[roundId] = state.generationDraft;
  state.message = `ComfyUIに送信しました。prompt_id: ${response.promptId}`;
  if (response.round.warning?.length) {
    pushToast(response.round.warning.join(" "), "info");
  }
  state.busy = false;
  await refreshProject(roundId, null);
  requestRender();
  if (roundId) {
    // await 中の画面遷移で state.currentProjectId が変わっていても、poll のガード基準は
    // この round を作った projectId にする(新プロジェクトIDを基準に旧roundのpollが走るのを防ぐ)。
    void pollCollectRound(roundId, projectId);
  }
}

export async function generateFromSelected(mode: string) {
  const asset = getPreferredParentAsset();
  if (!asset) {
    throw new Error("selected画像、または詳細表示中の画像がありません。");
  }
  prepareGenerationFormForParent(asset, mode);
  await generateRound(asset, mode);
}

export function resolveParentAssetForGeneration(parentAsset: Asset | null, generationMode: string, formParentAssetId: string | null | undefined) {
  if (parentAsset) {
    return parentAsset;
  }
  if (!requiresParentAsset(generationMode)) {
    return null;
  }
  return findAsset(formParentAssetId ?? "");
}

export async function collectRound(roundId: string) {
  const result = await api<CollectRoundResponse>(`/api/rounds/${roundId}/collect`, {
    method: "POST",
    body: "{}"
  });
  const count = result.assets?.length ?? 0;
  state.message = count > 0
    ? `生成画像を取り込みました。${count}件`
    : String(result.message ?? "まだ出力画像はありません。");
  await refreshProject(roundId, state.activeAssetId);
  requestRender();
}

export async function interruptRound(roundId: string) {
  const result = await api<Json>(`/api/rounds/${roundId}/interrupt`, {
    method: "POST",
    body: "{}"
  });
  pendingAutoCollectRoundIds.delete(roundId);
  if (result.deleteError || result.interruptError) {
    state.message = `停止要求を完了できませんでした: ${String(result.deleteError ?? result.interruptError)}`;
  } else {
    state.message = result.interrupted
    ? "生成を停止しました。保存済みの画像はこのままブランチングに使えます。"
    : "未実行の生成を停止しました。保存済みの画像はこのままブランチングに使えます。";
  }
  await refreshProject(roundId, state.activeAssetId);
  requestRender();
}

type RoundDeletionRecord = { rootId: string; roundIds: string[] };
let roundDeletionUndoStack: RoundDeletionRecord[] = [];
let roundDeletionRedoStack: RoundDeletionRecord[] = [];

/**
 * プロジェクトを離れる時に呼ぶ。undo 履歴を破棄し、サーバーのゴミ箱スナップショットも
 * discard して削除を確定する(undo はプロジェクトを開いている間だけ有効)。
 */
export function resetRoundDeletionHistory() {
  const rootIds = roundDeletionUndoStack.map((record) => record.rootId);
  roundDeletionUndoStack = [];
  roundDeletionRedoStack = [];
  recentlyDeletedRoundIds.clear();
  if (rootIds.length) {
    void api("/api/rounds/trash/discard", {
      method: "POST",
      body: JSON.stringify({ rootIds })
    }).catch(() => {
      // 破棄はベストエフォート。残骸はサーバー再起動時の全パージで消える。
    });
  }
}

/**
 * Round サブツリーの削除。ゴミ箱スナップショットへ退避してから完全削除するので
 * confirm なしで即実行し、トーストの「元に戻す」または Ctrl+Z(やり直しは
 * Ctrl+Y / Ctrl+Shift+Z)で復元できる。プロジェクトを離れると削除が確定する。
 */
export async function deleteRoundTree(roundId: string, options: { fromRedo?: boolean } = {}) {
  if (!state.currentProjectId) {
    return;
  }

  const result = await api<{ deleted: boolean; roundIds: string[]; deletedCount: number }>(`/api/rounds/${roundId}`, {
    method: "DELETE"
  });
  const deletedRoundIds = new Set(result.roundIds);
  for (const deletedRoundId of deletedRoundIds) {
    pendingAutoCollectRoundIds.delete(deletedRoundId);
    recentlyDeletedRoundIds.add(deletedRoundId);
    delete state.roundProgress[deletedRoundId];
  }
  roundDeletionUndoStack.push({ rootId: roundId, roundIds: result.roundIds });
  // redo 経由の再削除では redo スタックを消さない(消すと2件目以降の redo が効かなくなる)。
  if (!options.fromRedo) {
    roundDeletionRedoStack = [];
  }

  const keepRoundId = state.activeRoundId && !deletedRoundIds.has(state.activeRoundId) ? state.activeRoundId : null;
  state.activeAssetId = null;
  state.deletePreviewRoundId = null;
  await refreshProject(keepRoundId, null);
  pushToast(`${result.deletedCount}件のイテレーションを削除しました。`, "info", { label: "元に戻す (Ctrl+Z)", action: "undo-round-delete" });
  requestRender();
}

/** 直近の Round 削除を取り消す(ゴミ箱スナップショットからの復元)。 */
export async function undoRoundDeletion() {
  if (!state.currentProjectId || roundDeletionUndoStack.length === 0) {
    return;
  }
  const record = roundDeletionUndoStack.pop()!;
  let result: { restored: boolean; roundIds: string[]; restoredCount: number };
  try {
    result = await api<{ restored: boolean; roundIds: string[]; restoredCount: number }>("/api/rounds/restore", {
      method: "POST",
      body: JSON.stringify({ rootId: record.rootId })
    });
  } catch (error) {
    // 失敗時は record を戻す(pop したまま消えると undo/redo 両スタックから復元不能になる)。
    roundDeletionUndoStack.push(record);
    pushToast(error instanceof Error ? error.message : String(error), "error");
    requestRender();
    return;
  }
  roundDeletionRedoStack.push(record);
  for (const restoredRoundId of result.roundIds) {
    recentlyDeletedRoundIds.delete(restoredRoundId);
  }
  await refreshProject(record.rootId, null);
  pushToast(`${result.restoredCount}件のイテレーションを復元しました。`, "info", { label: "やり直す (Ctrl+Y)", action: "redo-round-delete" });
  requestRender();
}

/** 取り消した Round 削除をやり直す(再度削除し、スナップショットも作り直される)。 */
export async function redoRoundDeletion() {
  if (!state.currentProjectId || roundDeletionRedoStack.length === 0) {
    return;
  }
  const record = roundDeletionRedoStack.pop()!;
  try {
    await deleteRoundTree(record.rootId, { fromRedo: true });
  } catch (error) {
    roundDeletionRedoStack.push(record);
    pushToast(error instanceof Error ? error.message : String(error), "error");
    requestRender();
  }
}

export async function pollCollectRound(roundId: string, projectId: string | null) {
  if (!projectId || pendingAutoCollectRoundIds.has(roundId)) {
    return;
  }
  pendingAutoCollectRoundIds.add(roundId);
  // Book: poll 開始時のページを捕捉する。別ページへ移動したら refreshProject が別ページの
  // detail を取ってきてしまうため、このループは自ページでない間は何もしない(既存の
  // currentProjectId ガードと同型 -- 監査が指摘した必須ガード)。
  const capturedPageId = state.activePageId;

  try {
    while (true) {
      await delay(autoCollectIntervalMs);
      if (state.currentProjectId !== projectId || state.activePageId !== capturedPageId) {
        return;
      }
      if (recentlyDeletedRoundIds.has(roundId)) {
        // Round がゴミ箱へ削除された(collect すると 404 になる)。
        // 復元(undo)時は refreshProject → resumeAutoCollectForActiveRounds が poll を再開する。
        return;
      }

      const knownAssetCount = knownRoundAssetCount(roundId);
      const result = await api<CollectRoundResponse>(`/api/rounds/${roundId}/collect`, {
        method: "POST",
        body: "{}"
      });

      // collect の await 中にページ/プロジェクトを離れていたら、ここで refreshProject を呼ぶと
      // 別スコープの detail で上書きしてしまう(グリッドが誤った詳細ビューに化ける)。ループ冒頭と
      // 同じガードを await 後にも置く。
      if (state.currentProjectId !== projectId || state.activePageId !== capturedPageId) {
        return;
      }

      const progressChanged = applyRoundProgress(roundId, result.progress ?? null);

      const count = result.assets?.length ?? 0;
      const status = result.round?.status;
      const responseAssetCount = responseRoundAssetCount(result.round);
      const displayedAssetCountChanged = responseAssetCount !== null && responseAssetCount !== knownAssetCount;
      if (count > 0 || displayedAssetCountChanged) {
        const collectedCount = responseAssetCount !== null
          ? Math.max(0, responseAssetCount - knownAssetCount)
          : count;
        state.message = collectedCount > 0
          ? `生成画像を自動で取り込みました。${collectedCount}件`
          : "生成画像を自動で更新しました。";
        // ユーザーのラウンド選択(activeRoundId)を維持する。poll中の roundId を渡すと
        // 生成中3秒毎に選択が強奪される。
        await refreshProject();
        requestRender();
      } else if (status && !isRoundActiveStatus(status)) {
        state.message = terminalRoundMessage(status);
        await refreshProject();
        requestRender();
        return;
      } else if (progressChanged) {
        requestRender();
      }

      if (status && !isRoundActiveStatus(status)) {
        return;
      }
    }
  } catch (error) {
    // 削除と collect が同時進行した場合の 404 は正常系(削除で poll が止まるだけ)なので通知しない。
    if (state.currentProjectId === projectId && !recentlyDeletedRoundIds.has(roundId)) {
      pushToast(error instanceof Error ? error.message : String(error), "error");
      requestRender();
    }
  } finally {
    pendingAutoCollectRoundIds.delete(roundId);
  }
}

/**
 * UX改善#5: collect レスポンスの `progress` を `state.roundProgress` へ反映する。
 * 戻り値は値が実際に変わったか(変わっていなければ poll tick 側で無駄な requestRender をしない)。
 */
function applyRoundProgress(roundId: string, next: { value: number; max: number } | null) {
  const previous = state.roundProgress[roundId] ?? null;
  if (next) {
    state.roundProgress[roundId] = next;
  } else {
    delete state.roundProgress[roundId];
  }
  return previous?.value !== next?.value || previous?.max !== next?.max;
}

export function knownRoundAssetCount(roundId: string) {
  const round = findRound(roundId);
  if (typeof round?.assetCount === "number") {
    return round.assetCount;
  }
  return state.detail?.assets.filter((asset) => asset.roundId === roundId).length ?? 0;
}

export function responseRoundAssetCount(round: Round | null | undefined) {
  return typeof round?.assetCount === "number" ? round.assetCount : null;
}

export async function refreshProject(keepRoundId = state.activeRoundId, keepAssetId = state.activeAssetId) {
  const projectId = state.currentProjectId;
  const pageId = state.activePageId;
  if (!projectId) {
    return;
  }
  // fetch 中にページ/プロジェクト遷移した場合、古い detail で新しい画面の state を上書きしない。
  const stillCurrent = () => state.currentProjectId === projectId && state.activePageId === pageId;
  // Book のページを開いている時は、そのページに絞った詳細を再取得する(round/asset id は全体一意なので
  // 下の keepRoundId/keepAssetId reconciliation はそのまま機能する)。
  if (pageId) {
    const pageDetail = await api<PageDetail>(`/api/projects/${projectId}/pages/${pageId}`);
    if (!stillCurrent()) {
      return;
    }
    state.detail = pageDetail;
    // コマ内生成(Docs/Feature-PanelGeneration.md): 生成完了(collect)のたびに割り当てが更新されうる
    // (asset 選択時の自動割り当て)ので、ページ詳細と一緒に取り直す。
    state.pagePanelAssignments = pageDetail.panelAssignments;
  } else {
    const detail = await api<ProjectDetail>(`/api/projects/${projectId}`);
    if (!stillCurrent()) {
      return;
    }
    state.detail = detail;
  }
  state.templates = state.detail.templates;
  const visibleRounds = roundsForActivePanelTarget(state.detail.rounds);
  const visibleRoundIds = new Set(visibleRounds.map((round) => round.id));
  const visibleAssets = state.activePanelTarget
    ? state.detail.assets.filter((asset) => visibleRoundIds.has(asset.roundId))
    : state.detail.assets;
  state.activeRoundId = visibleRounds.some((round) => round.id === keepRoundId)
    ? keepRoundId
    : visibleRounds[0]?.id ?? null;
  state.activeAssetId = visibleAssets.some((asset) => asset.id === keepAssetId) ? keepAssetId : null;
  if (!state.activeAssetId) {
    state.maskEditMode = false;
    state.paintEditMode = false;
  }
  resumeAutoCollectForActiveRounds();
}

export function resumeAutoCollectForActiveRounds() {
  if (!state.currentProjectId || !state.detail) {
    return;
  }
  for (const round of state.detail.rounds) {
    if (isRoundActive(round)) {
      void pollCollectRound(round.id, state.currentProjectId);
    }
  }
}

export function isRoundActive(round: Round | null | undefined) {
  return !!round && isRoundActiveStatus(round.status);
}

export function isRoundActiveStatus(status: string) {
  return status === "pending" || status === "running";
}

export function terminalRoundMessage(status: string) {
  if (status === "completed") {
    return "生成が完了しました。";
  }
  if (status === "interrupted") {
    return "生成は停止済みです。保存済みの画像はこのままブランチングに使えます。";
  }
  if (status === "failed") {
    return "生成に失敗しました。保存済みの画像があればこのままブランチングに使えます。";
  }
  return `生成状態: ${status}`;
}

export async function setAssetStatus(assetId: string, status: string, refresh = true) {
  await api(`/api/assets/${assetId}/status`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
  if (refresh) {
    await refreshProject(state.activeRoundId, state.activeAssetId);
    requestRender();
  }
}

export async function toggleSelect(assetId: string) {
  const asset = findAsset(assetId);
  if (!asset) {
    return;
  }
  if (asset.status === "selected") {
    await setAssetStatus(assetId, "generated");
    return;
  }
  await selectSingleAsset(assetId);
}

export async function toggleFavorite(assetId: string) {
  const asset = findAsset(assetId);
  if (!asset) {
    return;
  }
  await setAssetStatus(assetId, asset.status === "favorite" ? "generated" : "favorite");
}

async function selectSingleAsset(assetId: string) {
  const target = findAsset(assetId);
  if (!target) {
    return;
  }
  const assets = getActiveRoundAssets();
  for (const asset of assets) {
    if (asset.id !== assetId && asset.status === "selected") {
      await setAssetStatus(asset.id, "generated", false);
    }
  }
  await setAssetStatus(assetId, "selected", false);
  await refreshProject(state.activeRoundId, state.activeAssetId);
  requestRender();
}

export async function selectAllActiveRound() {
  const assets = getActiveRoundAssets().filter((asset) => !["archived", "failed"].includes(asset.status));
  const target = assets.find((asset) => asset.status === "selected") ?? assets[0] ?? null;
  if (!target) {
    return;
  }
  await selectSingleAsset(target.id);
  state.message = "img2imgに使える画像は1枚のみです。";
  requestRender();
}

export async function clearSelectionActiveRound() {
  const assets = getActiveRoundAssets().filter((asset) => asset.status === "selected");
  for (const asset of assets) {
    await setAssetStatus(asset.id, "generated", false);
  }
  await refreshProject(state.activeRoundId, state.activeAssetId);
  requestRender();
}

export async function invertSelectionActiveRound() {
  const assets = getActiveRoundAssets().filter((asset) => !["archived", "failed", "rejected"].includes(asset.status));
  if (assets.length === 0) {
    return;
  }
  const currentIndex = assets.findIndex((asset) => asset.status === "selected");
  const target = assets[(currentIndex + 1) % assets.length]!;
  await selectSingleAsset(target.id);
}

export async function resetActiveRoundMarks() {
  const assets = getActiveRoundAssets().filter((asset) => ["selected", "rejected", "favorite"].includes(asset.status));
  for (const asset of assets) {
    await setAssetStatus(asset.id, "generated", false);
  }
  state.message = "現在のイテレーションの選択状態をクリアしました。";
  await refreshProject(state.activeRoundId, null);
  requestRender();
}

/** ギャラリーの「保存」ボタン。選択中(selected)の画像をブラウザダウンロードとして保存する。 */
export async function exportSelected() {
  const selected = getActiveRoundAssets().filter((asset) => asset.status === "selected");
  if (selected.length === 0) {
    state.message = "保存対象の選択画像がありません。";
    requestRender();
    return;
  }
  try {
    for (const asset of selected) {
      const response = await fetch(asset.imageUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
      downloadBlob(blob, `${asset.id}.${extension}`);
    }
    state.message = selected.length > 1 ? `選択画像${selected.length}件を保存しました。` : "選択画像を保存しました。";
  } catch (error) {
    pushToast(`選択画像の保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
  requestRender();
}

export function previewRoundDeletion(roundId: string) {
  state.deletePreviewRoundId = roundId;
  requestRender();
}

export function selectRound(roundId: string) {
  // 現在の Round の編集内容を記憶してから切り替え、切替先で記憶済みの内容を復元する。
  rememberActiveRoundDraft();
  restoreGenerationDraftForRound(roundId);
  state.activeRoundId = roundId;
  state.activeAssetId = null;
  state.deletePreviewRoundId = null;
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  clearActiveImagePan();
  requestRender();
}

let pendingAssetCardSelect: { assetId: string; timer: number } | null = null;
let pendingIterationDotSelect: { timer: number } | null = null;

function scheduleAssetCardSelect(assetId: string) {
  clearPendingAssetCardSelect();
  pendingAssetCardSelect = {
    assetId,
    timer: window.setTimeout(() => {
      pendingAssetCardSelect = null;
      void toggleSelect(assetId);
    }, 220)
  };
}

function clearPendingAssetCardSelect() {
  if (!pendingAssetCardSelect) {
    return;
  }
  window.clearTimeout(pendingAssetCardSelect.timer);
  pendingAssetCardSelect = null;
}

function scheduleIterationDotSelect(roundId: string) {
  clearPendingIterationDotSelect();
  pendingIterationDotSelect = {
    timer: window.setTimeout(() => {
      pendingIterationDotSelect = null;
      captureGenerationDraft();
      selectRound(roundId);
    }, 220)
  };
}

function clearPendingIterationDotSelect() {
  if (!pendingIterationDotSelect) {
    return;
  }
  window.clearTimeout(pendingIterationDotSelect.timer);
  pendingIterationDotSelect = null;
}

/** main.ts の click ハンドラから同じ優先順位で呼ばれる。`.asset-card-main` のシングル/ダブルクリック判定のみ扱う。 */
export function handleAssetCardClick(event: MouseEvent): boolean {
  const target = event.target as HTMLElement;
  const assetCardMain = target.closest<HTMLElement>(".asset-card-main");
  if (!assetCardMain?.dataset.id) {
    return false;
  }
  if (event.detail >= 2) {
    event.preventDefault();
    clearPendingAssetCardSelect();
    return true;
  }
  captureGenerationDraft();
  scheduleAssetCardSelect(assetCardMain.dataset.id);
  return true;
}

export function handleAssetCardDblClick(event: MouseEvent): boolean {
  const target = event.target as HTMLElement;
  const assetCardMain = target.closest<HTMLElement>(".asset-card-main");
  if (!assetCardMain?.dataset.id) {
    return false;
  }
  event.preventDefault();
  clearPendingAssetCardSelect();
  captureGenerationDraft();
  openAssetDetail(assetCardMain.dataset.id);
  return true;
}

export function handleIterationDotClick(event: MouseEvent): boolean {
  const target = event.target as HTMLElement;
  const iterationDot = target.closest<HTMLElement>(".iteration-dot");
  if (!iterationDot?.dataset.id) {
    return false;
  }
  if (event.detail >= 2) {
    event.preventDefault();
    clearPendingIterationDotSelect();
    previewRoundDeletion(iterationDot.dataset.id);
    return true;
  }
  event.preventDefault();
  scheduleIterationDotSelect(iterationDot.dataset.id);
  return true;
}

export function handleIterationDotDblClick(event: MouseEvent): boolean {
  const target = event.target as HTMLElement;
  const dot = target.closest<HTMLElement>(".iteration-dot");
  if (!dot?.dataset.id) {
    return false;
  }
  event.preventDefault();
  clearPendingIterationDotSelect();
  previewRoundDeletion(dot.dataset.id);
  return true;
}

export function randomSeed() {
  const input = document.querySelector<HTMLInputElement>('input[name="seed"]');
  const seedMode = document.querySelector<HTMLSelectElement>('select[name="seedMode"]');
  if (input) {
    input.value = String(Math.floor(Math.random() * 2147483647));
  }
  if (seedMode) {
    seedMode.value = "fixed";
  }
  captureGenerationDraft();
}

export function swapResolution() {
  const width = document.querySelector<HTMLInputElement>('input[name="width"]');
  const height = document.querySelector<HTMLInputElement>('input[name="height"]');
  if (!width || !height) {
    return;
  }
  const nextWidth = height.value;
  height.value = width.value;
  width.value = nextWidth;
  captureGenerationDraft();
}

export function scaleResolution(direction: -1 | 1) {
  const widthInput = document.querySelector<HTMLInputElement>('input[name="width"]');
  const heightInput = document.querySelector<HTMLInputElement>('input[name="height"]');
  if (!widthInput || !heightInput) {
    return;
  }

  const width = resolutionValue(widthInput, 1024);
  const height = resolutionValue(heightInput, 1024);
  if (width <= 0 || height <= 0) {
    return;
  }

  const step = 64;
  const latentStep = 8;
  let nextWidth = width;
  let nextHeight = height;
  if (width <= height) {
    nextWidth = Math.max(step, width + step * direction);
    nextHeight = roundToStep((nextWidth * height) / width, latentStep);
  } else {
    nextHeight = Math.max(step, height + step * direction);
    nextWidth = roundToStep((nextHeight * width) / height, latentStep);
  }

  widthInput.value = String(Math.max(latentStep, nextWidth));
  heightInput.value = String(Math.max(latentStep, nextHeight));
  captureGenerationDraft();
}

export function resolutionValue(input: HTMLInputElement, fallback: number) {
  const value = Number(input.value);
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;
}

export function roundToStep(value: number, step: number) {
  return Math.max(step, Math.round(value / step) * step);
}

/**
 * 「ノード元値」: 編集内容(プロンプト・生成パラメータ)を、表示中ノード(activeRound)の
 * 開始時点の値(round.request)へ戻す。request を持たないノード(初回など)は従来どおり
 * Workflow JSON の初期値へフォールバックする。
 */
export function resetGenerationParamsToNodeValues() {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (!form) {
    return;
  }

  const round = state.detail ? getActiveRound(state.detail) : null;
  const request = round?.request;
  if (!request) {
    resetGenerationParamsToTemplateDefaults(form);
    return;
  }

  const mode = request.generationMode === "manual_upload" ? "img2img" : request.generationMode;
  if (state.templates.some((template) => template.id === request.templateId)) {
    setFormValue(form, "templateId", request.templateId);
    if (mode === "img2img") {
      setFormValue(form, "img2imgTemplateId", request.templateId);
    }
  }
  setFormValue(form, "prompt", request.prompt ?? "");
  setFormValue(form, "negativePrompt", request.negativePrompt ?? "");
  setFormValue(form, "batchSize", String(request.batchSize ?? 16));
  setFormValue(form, "steps", String(request.steps ?? 20));
  setFormValue(form, "cfg", String(request.cfg ?? 7));
  setFormValue(form, "denoise", String(normalizeDenoiseForMode(request.denoise ?? defaultDenoiseForMode(mode), mode)));
  setFormValue(form, "width", String(request.width ?? 512));
  setFormValue(form, "height", String(request.height ?? 768));
  setFormValue(form, "seed", request.seed === null || request.seed === undefined ? "" : String(request.seed));
  setFormValue(form, "seedMode", request.seedMode ?? "random");
  setFormValue(form, "sampler", request.sampler ?? "euler");
  setFormValue(form, "scheduler", request.scheduler ?? "normal");
  setFormValue(form, "generationMode", mode);

  captureGenerationDraft();
  rememberActiveRoundDraft();
  state.message = "編集内容をノード開始時点の値に戻しました。";
  requestRender();
}

function resetGenerationParamsToTemplateDefaults(form: HTMLFormElement) {
  const templateId = (form.elements.namedItem("templateId") as HTMLSelectElement | null)?.value ?? "";
  const template = state.templates.find((item) => item.id === templateId) ?? null;
  const defaults = templateGenerationDefaults(template);
  const mode = defaultModeForTemplate(template);

  setFormValue(form, "batchSize", String(defaults.batchSize ?? 16));
  setFormValue(form, "steps", String(defaults.steps ?? 20));
  setFormValue(form, "cfg", String(defaults.cfg ?? 7));
  setFormValue(form, "denoise", String(normalizeDenoiseForMode(defaults.denoise ?? defaultDenoiseForMode(mode), mode)));
  setFormValue(form, "width", String(defaults.width ?? 512));
  setFormValue(form, "height", String(defaults.height ?? 768));
  setFormValue(form, "seed", String(defaults.seed ?? -1));
  setFormValue(form, "seedMode", "random");
  setFormValue(form, "sampler", defaults.sampler ?? "euler");
  setFormValue(form, "scheduler", defaults.scheduler ?? "normal");
  setFormValue(form, "generationMode", mode);

  captureGenerationDraft();
  rememberActiveRoundDraft();
  state.message = "生成パラメータをWorkflow JSONの初期値に戻しました。";
  requestRender();
}

async function savePaintResultAsSourceAsset() {
  const active = activePaintCanvasAndAsset();
  const asset = state.activeAssetId ? findAsset(state.activeAssetId) : null;
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  if (!active || !asset || !image || !state.currentProjectId) {
    return;
  }
  commitActivePaintCanvas();
  const { canvas, assetId } = active;
  const layer = getOrCreatePaintLayer(assetId, canvas.width, canvas.height);
  // 貼り付けオブジェクトも見たままの合成に含める(元アセットの添付はそのまま残る)。
  const composed = composePaintResultCanvas(image, layer, canvas.width, canvas.height, pasteLayersForAsset(assetId));
  const dataUrl = composed.toDataURL("image/png");
  // サーバ側 16MB 検証(uploadDataUrl.ts)の手前で親切に失敗させるプリフライト。
  if (dataUrl.length > Math.ceil(16 * 1024 * 1024 * 1.4) + 128) {
    state.busy = false;
    pushToast("合成結果が 16MB を超えています。画像サイズを縮小してください。", "error");
    requestRender();
    return;
  }

  const form = document.querySelector<HTMLFormElement>("#generation-form");
  const draft = form ? generationDraftFromForm(form) : null;
  const templateId = draft?.img2imgTemplateId || draft?.templateId || asset.workflowTemplateId || "";
  if (!templateId) {
    state.message = "WorkflowTemplateを選択してから保存してください。";
    requestRender();
    return;
  }

  const denoise = normalizeDenoiseForMode(
    Number(draft?.denoise || defaultDenoiseForMode("img2img")),
    "img2img"
  );

  state.busy = true;
  state.message = "ペイント結果を新規アセットとして保存しています。";
  requestRender();

  const response = await api<{ round: Round; asset: Asset }>(`/api/projects/${state.currentProjectId}/source-assets`, {
    method: "POST",
    body: JSON.stringify({
      filename: `paint_${assetId}_${Date.now()}.png`,
      mimeType: "image/png",
      dataUrl,
      templateId,
      prompt: draft?.prompt ?? "",
      negativePrompt: draft?.negativePrompt ?? "",
      seed: draft?.seed ? Number(draft.seed) : null,
      seedMode: draft?.seedMode ?? "random",
      batchSize: Number(draft?.batchSize || 1),
      steps: Number(draft?.steps || 20),
      cfg: Number(draft?.cfg || 7),
      sampler: draft?.sampler || "euler",
      scheduler: draft?.scheduler || "normal",
      denoise,
      width: canvas.width,
      height: canvas.height,
      pageId: state.activePageId
    })
  });

  state.busy = false;
  state.generationDraft = {
    ...(draft ?? {}),
    templateId: draft?.templateId || templateId,
    img2imgTemplateId: templateId,
    denoise: String(denoise),
    generationMode: "img2img"
  };
  applyAssetDimensionsToDraft(response.asset);
  paintLayerCache.delete(assetId);
  paintHistoryStacks.delete(assetId);
  delete state.paintDrafts[assetId];
  state.paintEditMode = false;
  state.message = "ペイント結果を新規アセットとして保存し、親画像に設定しました。";
  await refreshProject(response.round.id, null);
  requestRender();
}

registerActions({
  "select-round": (id) => selectRound(id),
  "collect-round": (id) => collectRound(id),
  "interrupt-round": (id) => interruptRound(id),
  "delete-round": (id) => deleteRoundTree(id),
  "undo-round-delete": () => undoRoundDeletion(),
  "redo-round-delete": () => redoRoundDeletion(),
  "cancel-delete-round": () => {
    state.deletePreviewRoundId = null;
    requestRender();
  },
  "generate-round": () => generateRound(null, "txt2img"),
  "img2img-next": () => generateFromSelected("img2img"),
  "generate-from-preview": (id, target) => {
    commitActiveMaskCanvas();
    const asset = findAsset(id);
    if (asset) {
      return generateRound(asset, target.dataset.mode ?? "img2img");
    }
  },
  "paint-save": () => savePaintResultAsSourceAsset(),
  "asset-selected": (id) => selectSingleAsset(id),
  "asset-rejected": (id) => setAssetStatus(id, "rejected"),
  "asset-unmarked": (id) => setAssetStatus(id, "generated"),
  "toggle-select": (id) => toggleSelect(id),
  "toggle-favorite": (id) => toggleFavorite(id),
  "select-all": () => selectAllActiveRound(),
  "clear-selection": () => clearSelectionActiveRound(),
  "invert-selection": () => invertSelectionActiveRound(),
  "export-selected": () => exportSelected(),
  "reset-session": () => resetActiveRoundMarks(),
  "reset-generation-params": () => resetGenerationParamsToNodeValues(),
  "random-seed": () => randomSeed(),
  "swap-resolution": () => swapResolution(),
  "scale-resolution": (_id, target) => scaleResolution(target.dataset.scaleDirection === "down" ? -1 : 1),
  "use-parent": (id, target) => {
    const asset = findAsset(id);
    if (asset) {
      fillGenerationFormFromAsset(asset, target.dataset.mode ?? "img2img");
    }
  }
});
