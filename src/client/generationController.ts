import {
  defaultDenoiseForMode,
  normalizeDenoiseForMode,
  relationForGenerationMode,
  requiresParentAsset
} from "../shared/generationMode";
import type { GenerationMode, GenerationRequest } from "../shared/types";
import type { Asset, CollectRoundResponse, ProjectDetail, Round } from "../shared/apiTypes";
import { api } from "./api";
import { type Json } from "./json";
import { requestRender, state } from "./appState";
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
  getActiveRoundAssets,
  getPreferredParentAsset,
  inpaintRequestForParent,
  prepareGenerationFormForParent,
  preserveGenerationDenoise,
  resolveTemplateForGeneration,
  setGenerationDraftValue
} from "./generationDraft";
import { openAssetDetail } from "./assetDetailController";
import { commitActiveMaskCanvas } from "./maskEditorController";
import {
  activePaintCanvasAndAsset,
  commitActivePaintCanvas,
  getOrCreatePaintLayer,
  paintLayerCache,
  paintUndoStacks
} from "./paintEditorController";
import { composePaintResultCanvas } from "./paintCanvas";
import { clearActiveImagePan } from "./maskEditorController";
import { setFormValue } from "./formUtils";

const pendingAutoCollectRoundIds = new Set<string>();
const autoCollectIntervalMs = 3_000;

export async function generateRound(parentAsset: Asset | null, overrideMode?: string) {
  if (!state.currentProjectId) {
    return;
  }

  const form = readForm("generation-form");
  const generationMode = overrideMode ?? form.generationMode ?? "txt2img";
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
    seedMode: form.seedMode as GenerationRequest["seedMode"],
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
  setGenerationDraftValue(generationMode === "img2img" ? "img2imgTemplateId" : "templateId", template.id);
  setGenerationDraftValue("generationMode", generationMode);

  state.busy = true;
  requestRender();
  const response = await api<{ promptId: string; round: Round }>(`/api/projects/${state.currentProjectId}/rounds`, {
    method: "POST",
    body: JSON.stringify(request)
  });
  const roundId = response.round.id;
  const previousInpaint = parentAssetId ? inpaintDraftForAsset(parentAssetId) : null;
  state.generationDraft = generationDraftFromRequest(response.round.request);
  if (previousInpaint && inpaint && previousInpaint.parentAssetId === parentAssetId) {
    state.generationDraft.inpaint = previousInpaint;
  }
  state.message = `ComfyUIに送信しました。prompt_id: ${response.promptId}`;
  state.busy = false;
  await refreshProject(roundId, null);
  requestRender();
  if (roundId) {
    void pollCollectRound(roundId, state.currentProjectId);
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
export async function deleteRoundTree(roundId: string) {
  if (!state.currentProjectId) {
    return;
  }

  const result = await api<{ deleted: boolean; roundIds: string[]; deletedCount: number }>(`/api/rounds/${roundId}`, {
    method: "DELETE"
  });
  const deletedRoundIds = new Set(result.roundIds);
  for (const deletedRoundId of deletedRoundIds) {
    pendingAutoCollectRoundIds.delete(deletedRoundId);
  }
  roundDeletionUndoStack.push({ rootId: roundId, roundIds: result.roundIds });
  roundDeletionRedoStack = [];

  const keepRoundId = state.activeRoundId && !deletedRoundIds.has(state.activeRoundId) ? state.activeRoundId : null;
  state.activeAssetId = null;
  state.deletePreviewRoundId = null;
  await refreshProject(keepRoundId, null);
  state.message = `${result.deletedCount}件のイテレーションを削除しました。`;
  state.messageAction = { label: "元に戻す (Ctrl+Z)", action: "undo-round-delete" };
  requestRender();
}

/** 直近の Round 削除を取り消す(ゴミ箱スナップショットからの復元)。 */
export async function undoRoundDeletion() {
  const record = roundDeletionUndoStack.pop();
  if (!record || !state.currentProjectId) {
    return;
  }
  const result = await api<{ restored: boolean; roundIds: string[]; restoredCount: number }>("/api/rounds/restore", {
    method: "POST",
    body: JSON.stringify({ rootId: record.rootId })
  });
  roundDeletionRedoStack.push(record);
  await refreshProject(record.rootId, null);
  state.message = `${result.restoredCount}件のイテレーションを復元しました。`;
  state.messageAction = { label: "やり直す (Ctrl+Y)", action: "redo-round-delete" };
  requestRender();
}

/** 取り消した Round 削除をやり直す(再度削除し、スナップショットも作り直される)。 */
export async function redoRoundDeletion() {
  const record = roundDeletionRedoStack.pop();
  if (!record || !state.currentProjectId) {
    return;
  }
  await deleteRoundTree(record.rootId);
}

export async function pollCollectRound(roundId: string, projectId: string | null) {
  if (!projectId || pendingAutoCollectRoundIds.has(roundId)) {
    return;
  }
  pendingAutoCollectRoundIds.add(roundId);

  try {
    while (true) {
      await delay(autoCollectIntervalMs);
      if (state.currentProjectId !== projectId) {
        return;
      }

      const knownAssetCount = knownRoundAssetCount(roundId);
      const result = await api<CollectRoundResponse>(`/api/rounds/${roundId}/collect`, {
        method: "POST",
        body: "{}"
      });

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
        await refreshProject(roundId, state.activeAssetId);
        requestRender();
      } else if (status && !isRoundActiveStatus(status)) {
        state.message = terminalRoundMessage(status);
        await refreshProject(roundId, state.activeAssetId);
        requestRender();
        return;
      }

      if (status && !isRoundActiveStatus(status)) {
        return;
      }
    }
  } catch (error) {
    if (state.currentProjectId === projectId) {
      state.message = error instanceof Error ? error.message : String(error);
      requestRender();
    }
  } finally {
    pendingAutoCollectRoundIds.delete(roundId);
  }
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
  if (!state.currentProjectId) {
    return;
  }
  state.detail = await api<ProjectDetail>(`/api/projects/${state.currentProjectId}`);
  state.templates = state.detail.templates;
  state.activeRoundId = state.detail.rounds.some((round) => round.id === keepRoundId)
    ? keepRoundId
    : state.detail.rounds[0]?.id ?? null;
  state.activeAssetId = state.detail.assets.some((asset) => asset.id === keepAssetId) ? keepAssetId : null;
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
  await setAssetStatus(assetId, asset.status === "selected" ? "generated" : "selected");
}

export async function toggleFavorite(assetId: string) {
  const asset = findAsset(assetId);
  if (!asset) {
    return;
  }
  await setAssetStatus(assetId, asset.status === "favorite" ? "generated" : "favorite");
}

export async function selectAllActiveRound() {
  const assets = getActiveRoundAssets().filter((asset) => !["archived", "failed"].includes(asset.status));
  for (const asset of assets) {
    if (asset.status !== "selected") {
      await setAssetStatus(asset.id, "selected", false);
    }
  }
  await refreshProject(state.activeRoundId, state.activeAssetId);
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
  for (const asset of assets) {
    await setAssetStatus(asset.id, asset.status === "selected" ? "generated" : "selected", false);
  }
  await refreshProject(state.activeRoundId, state.activeAssetId);
  requestRender();
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

export function exportSelected() {
  const count = getActiveRoundAssets().filter((asset) => asset.status === "selected").length;
  state.message = count > 0
    ? `${count}枚の選択画像を保存対象にしました。保存先はComfyUI接続設定の保存先です。`
    : "保存対象の選択画像がありません。";
  requestRender();
}

export function previewRoundDeletion(roundId: string) {
  state.deletePreviewRoundId = roundId;
  requestRender();
}

export function selectRound(roundId: string) {
  preserveGenerationDenoise();
  state.activeRoundId = roundId;
  state.activeAssetId = null;
  state.deletePreviewRoundId = null;
  state.maskEditMode = false;
  state.paintEditMode = false;
  state.maskPanelTab = "mask";
  clearActiveImagePan();
  requestRender();
}

/**
 * main.ts の click ハンドラから同じ優先順位で呼ばれる。`.asset-card-main` のクリックは
 * 即時に選択トグルする(dblclick と区別するための 220ms 遅延タイマーは廃止)。
 * ダブルクリック時は 1 打目でトグルが走ったあと dblclick で詳細が開く。
 * 2 打目(event.detail >= 2)はトグルの二重発火を避けるため消費だけする。
 */
export function handleAssetCardClick(event: MouseEvent): boolean {
  const target = event.target as HTMLElement;
  const assetCardMain = target.closest<HTMLElement>(".asset-card-main");
  if (!assetCardMain?.dataset.id) {
    return false;
  }
  event.preventDefault();
  if (event.detail >= 2) {
    return true;
  }
  captureGenerationDraft();
  void toggleSelect(assetCardMain.dataset.id);
  return true;
}

export function handleAssetCardDblClick(event: MouseEvent): boolean {
  const target = event.target as HTMLElement;
  const assetCardMain = target.closest<HTMLElement>(".asset-card-main");
  if (!assetCardMain?.dataset.id) {
    return false;
  }
  event.preventDefault();
  captureGenerationDraft();
  openAssetDetail(assetCardMain.dataset.id);
  return true;
}

/**
 * iteration dot のクリックは即時に Round を選択する(遅延タイマー廃止)。
 * ダブルクリック時は 1 打目で選択が走ったあと dblclick で削除プレビューに入る。
 */
export function handleIterationDotClick(event: MouseEvent): boolean {
  const target = event.target as HTMLElement;
  const iterationDot = target.closest<HTMLElement>(".iteration-dot");
  if (!iterationDot?.dataset.id) {
    return false;
  }
  event.preventDefault();
  if (event.detail >= 2) {
    return true;
  }
  captureGenerationDraft();
  selectRound(iterationDot.dataset.id);
  return true;
}

export function handleIterationDotDblClick(event: MouseEvent): boolean {
  const target = event.target as HTMLElement;
  const dot = target.closest<HTMLElement>(".iteration-dot");
  if (!dot?.dataset.id) {
    return false;
  }
  event.preventDefault();
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

export function resetGenerationParamsToTemplateDefaults() {
  const form = document.querySelector<HTMLFormElement>("#generation-form");
  if (!form) {
    return;
  }

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
  const composed = composePaintResultCanvas(image, layer, canvas.width, canvas.height);
  const dataUrl = composed.toDataURL("image/png");

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
      height: canvas.height
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
  paintUndoStacks.delete(assetId);
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
  "asset-selected": (id) => setAssetStatus(id, "selected"),
  "asset-rejected": (id) => setAssetStatus(id, "rejected"),
  "asset-unmarked": (id) => setAssetStatus(id, "generated"),
  "toggle-select": (id) => toggleSelect(id),
  "toggle-favorite": (id) => toggleFavorite(id),
  "select-all": () => selectAllActiveRound(),
  "clear-selection": () => clearSelectionActiveRound(),
  "invert-selection": () => invertSelectionActiveRound(),
  "export-selected": () => exportSelected(),
  "reset-session": () => resetActiveRoundMarks(),
  "reset-generation-params": () => resetGenerationParamsToTemplateDefaults(),
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
