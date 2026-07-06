import { DEFAULT_WEB_SAM_MODEL_BASE_URL } from "../shared/constants";
import { requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { ensureInpaintDraft, inpaintDraftForAsset, setInpaintDraft } from "./draftStore";
import { ensureMaskLayerSet, getOrCreateMaskLayerSet, maskLayerCache } from "./maskLayerStore";
import { clampNumber, imageToRawData } from "./clientUtils";
import { paintLayerCache, pasteLayersForEyedropper } from "./paintEditorController";
import { composePaintResultCanvas } from "./paintCanvas";
import { buildWebSamModelUrls, formatModelBytes, modelForProvider, SMART_MASK_PROVIDERS } from "./websam/models";
import type {
  WebSamModelStatus,
  WebSamPromptMode,
  WebSamProviderId,
  WebSamWorkerCandidate,
  WebSamWorkerRequest,
  WebSamWorkerResponse
} from "./websam/types";
import type { ActiveBoxPrompt, InpaintDraft, SamMaskCandidate } from "./maskTypes";
import {
  clearCanvas,
  composeFinalMaskDataUrl,
  drawDataUrlIntoCanvas,
  normalizePromptBox,
  pointerToMaskCanvasPoint,
  renderFinalMaskToCanvas
} from "./maskCanvas";

let activeBoxPrompt: ActiveBoxPrompt | null = null;

let webSamWorker: Worker | null = null;
let webSamRequestId = 0;
let latestWebSamLoadRequestId = 0;
let latestWebSamEncodeRequestId = 0;
let latestWebSamDecodeRequestId = 0;

export function addWebSamPointPrompt(event: PointerEvent, canvas: HTMLCanvasElement) {
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensureInpaintDraft(assetId);
  const point = pointerToMaskCanvasPoint(canvas, event);
  const label: 0 | 1 = event.button === 2 || event.altKey || event.shiftKey ? 0 : 1;
  setInpaintDraft({
    ...draft,
    foregroundPoints: [...draft.foregroundPoints, { x: point.x, y: point.y, label, source: "point" }],
    webSamError: "",
    samCandidates: [],
    previewSamMaskDataUrl: ""
  });
  requestRender();
  void requestWebSamDecode();
}

export function beginWebSamBoxPrompt(event: PointerEvent, canvas: HTMLCanvasElement) {
  const point = pointerToMaskCanvasPoint(canvas, event);
  activeBoxPrompt = {
    pointerId: event.pointerId,
    start: point,
    current: point
  };
  canvas.setPointerCapture(event.pointerId);
}

function continueWebSamBoxPrompt(event: PointerEvent, canvas: HTMLCanvasElement) {
  if (!activeBoxPrompt) {
    return;
  }
  activeBoxPrompt.current = pointerToMaskCanvasPoint(canvas, event);
}

function finishWebSamBoxPrompt(canvas: HTMLCanvasElement) {
  if (!activeBoxPrompt) {
    return;
  }
  const assetId = canvas.dataset.assetId ?? state.activeAssetId;
  if (!assetId) {
    activeBoxPrompt = null;
    return;
  }
  try {
    canvas.releasePointerCapture(activeBoxPrompt.pointerId);
  } catch {
    // Capture may already be released.
  }
  const box = normalizePromptBox({
    x1: activeBoxPrompt.start.x,
    y1: activeBoxPrompt.start.y,
    x2: activeBoxPrompt.current.x,
    y2: activeBoxPrompt.current.y
  });
  activeBoxPrompt = null;
  if (!box) {
    return;
  }
  const draft = ensureInpaintDraft(assetId);
  setInpaintDraft({
    ...draft,
    boxPrompt: box,
    webSamError: "",
    samCandidates: [],
    previewSamMaskDataUrl: ""
  });
  requestRender();
  void requestWebSamDecode();
}

export function updateSmartMaskDraftFromControl(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const field = control.dataset.smartMaskField;
  const assetId = state.generationDraft?.inpaint?.parentAssetId ?? state.activeAssetId;
  if (!field || !assetId) {
    return;
  }
  if (field === "provider" && isSmartMaskProvider(control.value)) {
    setSmartMaskProvider(control.value);
    return;
  }
  const current = ensureInpaintDraft(assetId);
  const next: InpaintDraft = { ...current };
  if (field === "promptMode" && isWebSamPromptMode(control.value)) {
    next.webSamPromptMode = control.value;
    next.eraser = false;
  } else if (field === "threshold") {
    next.threshold = clampNumber(Number(control.value), -10, 10, 0);
  } else if (field === "smoothing") {
    next.smoothing = clampNumber(Number(control.value), 0, 4, 0);
  } else if (field === "maskOpacity") {
    next.maskOpacity = clampNumber(Number(control.value), 0, 1, 0.58);
  }
  setInpaintDraft(next);

  if (field === "threshold" || field === "smoothing") {
    void requestWebSamReprocess();
    return;
  }
  if (field === "maskOpacity") {
    const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
    if (canvas) {
      canvas.style.opacity = String(next.maskOpacity);
    }
  }
  requestRender();
}

function setSmartMaskProvider(provider: WebSamProviderId) {
  const assetId = state.generationDraft?.inpaint?.parentAssetId ?? state.activeAssetId;
  if (!assetId) {
    return;
  }
  const current = ensureInpaintDraft(assetId);
  const next: InpaintDraft = {
    ...current,
    selectedSmartMaskProvider: provider,
    eraser: false
  };
  if (provider === "manual") {
    next.webSamStatusText = "Manual";
  } else {
    next.webSamError = "";
    next.webSamModelStatus = state.settings?.webSamModelBaseUrl?.trim() ? "not-cached" : "missing-url";
    next.webSamStatusText = state.settings?.webSamModelBaseUrl?.trim() ? "未取得" : "モデルURL未設定";
  }
  setInpaintDraft(next);
  requestRender();
  if (provider !== "manual") {
    void loadActiveWebSamModel();
  }
}

function isSmartMaskProvider(value: string): value is WebSamProviderId {
  return SMART_MASK_PROVIDERS.some((provider) => provider.id === value);
}

export function isWebSamPromptMode(value: string): value is WebSamPromptMode {
  return value === "point" || value === "box" || value === "brush";
}

function ensureWebSamWorker() {
  if (webSamWorker) {
    return webSamWorker;
  }
  webSamWorker = new Worker("/websam-worker.js", { type: "module" });
  webSamWorker.addEventListener("message", (event: MessageEvent<WebSamWorkerResponse>) => {
    void handleWebSamWorkerResponse(event.data);
  });
  webSamWorker.addEventListener("error", (event) => {
    updateActiveWebSamDraft({
      webSamModelStatus: "error",
      webSamError: event.message || "WebSAM Worker initialization failed.",
      webSamStatusText: "Error"
    });
  });
  return webSamWorker;
}

function postWebSamMessage(message: WebSamWorkerRequest) {
  ensureWebSamWorker().postMessage(message);
}

function nextWebSamRequestId() {
  webSamRequestId += 1;
  return webSamRequestId;
}

function updateActiveWebSamDraft(patch: Partial<InpaintDraft>) {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!draft) {
    return;
  }
  setInpaintDraft({ ...draft, ...patch });
  requestRender();
}

async function handleWebSamWorkerResponse(message: WebSamWorkerResponse) {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!assetId || !draft) {
    return;
  }

  if (message.type === "progress") {
    if (message.requestId < latestWebSamLoadRequestId && message.progress.status !== "encoding" && message.progress.status !== "decoding") {
      return;
    }
    setInpaintDraft({
      ...draft,
      webSamModelStatus: message.progress.status,
      webSamDownloadProgress: message.progress.totalBytes > 0 ? message.progress.bytesDownloaded / message.progress.totalBytes : 0,
      webSamStatusText: webSamProgressText(message.progress),
      webSamError: ""
    });
    // ダウンロード progress はチャンクごとに大量に届く。毎回フル render すると
    // タブ切替などのクリックが詰まる(体感フリーズ)ため、描画はスロットルする。
    requestWebSamProgressRender();
    return;
  }

  if (message.type === "model-ready") {
    if (message.requestId !== latestWebSamLoadRequestId) {
      return;
    }
    setInpaintDraft({
      ...draft,
      webSamModelStatus: "initializing",
      webSamDownloadProgress: 1,
      webSamStatusText: message.fallback ? "WebGPU不可のためWASMで初期化" : `${message.backend.toUpperCase()} 初期化済み`,
      webSamError: ""
    });
    requestRender();
    await encodeActiveImageForWebSam();
    return;
  }

  if (message.type === "encoded") {
    if (message.requestId !== latestWebSamEncodeRequestId) {
      return;
    }
    const current = inpaintDraftForAsset(assetId);
    if (!current) {
      return;
    }
    setInpaintDraft({
      ...current,
      webSamModelStatus: "ready",
      webSamStatusText: "Ready",
      imageWidth: message.width,
      imageHeight: message.height,
      webSamError: ""
    });
    requestRender();
    if (hasWebSamPrompt(current)) {
      await requestWebSamDecode();
    }
    return;
  }

  if (message.type === "decoded") {
    if (message.requestId !== latestWebSamDecodeRequestId) {
      return;
    }
    const candidates = await Promise.all(message.candidates.map(candidateFromWorker));
    const selectedIndex = candidates.some((candidate) => candidate.index === message.selectedIndex)
      ? message.selectedIndex
      : candidates[0]?.index ?? 0;
    const selected = candidates.find((candidate) => candidate.index === selectedIndex) ?? candidates[0] ?? null;
    const current = inpaintDraftForAsset(assetId);
    if (!current) {
      return;
    }
    if (selected) {
      await drawCandidatePreview(assetId, selected.dataUrl);
    }
    setInpaintDraft({
      ...current,
      webSamModelStatus: "ready",
      webSamStatusText: "Ready",
      webSamError: "",
      samCandidates: candidates,
      selectedSamCandidateIndex: selectedIndex,
      previewSamMaskDataUrl: selected?.dataUrl ?? ""
    });
    requestRender();
    return;
  }

  if (message.type === "error") {
    if (message.requestId < Math.max(latestWebSamLoadRequestId, latestWebSamEncodeRequestId, latestWebSamDecodeRequestId)) {
      return;
    }
    setInpaintDraft({
      ...draft,
      webSamModelStatus: "error",
      webSamError: message.message,
      webSamStatusText: "Error"
    });
    requestRender();
  }
}

const WEBSAM_PROGRESS_RENDER_INTERVAL_MS = 150;
let lastWebSamProgressRenderAt = 0;

function requestWebSamProgressRender() {
  const now = performance.now();
  if (now - lastWebSamProgressRenderAt < WEBSAM_PROGRESS_RENDER_INTERVAL_MS) {
    return;
  }
  lastWebSamProgressRenderAt = now;
  requestRender();
}

function webSamProgressText(progress: { status: WebSamModelStatus; bytesDownloaded: number; totalBytes: number; cached: boolean; detail?: string }) {
  if (progress.status === "cached") {
    return "キャッシュ済み";
  }
  if (progress.status === "downloading") {
    return `ダウンロード中 ${formatModelBytes(progress.bytesDownloaded)} / ${formatModelBytes(progress.totalBytes)}`;
  }
  if (progress.status === "initializing") {
    return "初期化中";
  }
  if (progress.status === "encoding") {
    return progress.detail === "encoder" ? "画像encode中" : "画像準備中";
  }
  if (progress.status === "decoding") {
    return "マスク候補生成中";
  }
  if (progress.status === "not-cached") {
    return "未取得";
  }
  return progress.status;
}

async function loadActiveWebSamModel() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? ensureInpaintDraft(assetId) : null;
  const model = draft ? modelForProvider(draft.selectedSmartMaskProvider) : null;
  if (!assetId || !draft || !model) {
    return;
  }
  const urls = buildWebSamModelUrls(state.settings?.webSamModelBaseUrl ?? DEFAULT_WEB_SAM_MODEL_BASE_URL, model);
  if (!urls) {
    setInpaintDraft({
      ...draft,
      webSamModelStatus: "missing-url",
      webSamError: "webSamModelBaseUrl が未設定です。",
      webSamStatusText: "モデルURL未設定"
    });
    requestRender();
    return;
  }
  const requestId = nextWebSamRequestId();
  latestWebSamLoadRequestId = requestId;
  setInpaintDraft({
    ...draft,
    webSamModelStatus: "downloading",
    webSamDownloadProgress: 0,
    webSamError: "",
    webSamStatusText: "モデル確認中"
  });
  requestRender();
  postWebSamMessage({ type: "load-model", requestId, model, urls });
}

async function encodeActiveImageForWebSam() {
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!image || !assetId || !draft) {
    return;
  }
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error("画像を読み込めませんでした。")), { once: true });
    });
  }
  const raw = webSamInputRawData(image, assetId);
  const requestId = nextWebSamRequestId();
  latestWebSamEncodeRequestId = requestId;
  setInpaintDraft({
    ...draft,
    webSamModelStatus: "encoding",
    webSamStatusText: "画像encode中",
    webSamError: ""
  });
  requestRender();
  postWebSamMessage({ type: "encode-image", requestId, imageData: raw });
}


/**
 * WebSAM のエンコード入力を作る。貼り付け画像(添付オブジェクト)やペイントレイヤーが
 * あれば「見たまま」の合成(生成時の pasteComposite と同じ層順)を入力にし、
 * 無ければ従来どおり元画像をそのまま使う。貼り付けた被写体も SAM の選択対象になる。
 */
function webSamInputRawData(image: HTMLImageElement, assetId: string) {
  const pastedLayers = pasteLayersForEyedropper(assetId);
  const layer = paintLayerCache.get(assetId) ?? null;
  if (pastedLayers.length === 0 && !layer) {
    return imageToRawData(image);
  }
  const composed = composePaintResultCanvas(image, layer, image.naturalWidth, image.naturalHeight, pastedLayers);
  const context = composed.getContext("2d");
  if (!context) {
    return imageToRawData(image);
  }
  const imageData = context.getImageData(0, 0, composed.width, composed.height);
  return { data: imageData.data, width: composed.width, height: composed.height };
}

export async function requestWebSamDecode() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!assetId || !draft || draft.selectedSmartMaskProvider === "manual") {
    return;
  }
  if (!hasWebSamPrompt(draft)) {
    setInpaintDraft({
      ...draft,
      webSamError: "Point、Box、Brush prompt のいずれかを指定してください。",
      webSamStatusText: "プロンプト未指定"
    });
    requestRender();
    return;
  }
  if (draft.webSamModelStatus !== "ready") {
    if (draft.webSamModelStatus === "idle" || draft.webSamModelStatus === "not-cached" || draft.webSamModelStatus === "missing-url" || draft.webSamModelStatus === "error") {
      await loadActiveWebSamModel();
    }
    return;
  }
  const width = draft.imageWidth ?? document.querySelector<HTMLCanvasElement>("#maskCanvas")?.width ?? 0;
  const height = draft.imageHeight ?? document.querySelector<HTMLCanvasElement>("#maskCanvas")?.height ?? 0;
  if (width <= 0 || height <= 0) {
    return;
  }
  const requestId = nextWebSamRequestId();
  latestWebSamDecodeRequestId = requestId;
  setInpaintDraft({
    ...draft,
    webSamModelStatus: "decoding",
    webSamStatusText: "マスク候補生成中",
    webSamError: ""
  });
  requestRender();
  postWebSamMessage({
    type: "decode",
    requestId,
    prompt: {
      points: draft.foregroundPoints,
      box: draft.boxPrompt
    },
    outputWidth: width,
    outputHeight: height,
    threshold: draft.threshold,
    smoothing: draft.smoothing
  });
}

export async function requestWebSamReprocess() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  if (!assetId || !draft || draft.selectedSmartMaskProvider === "manual" || draft.samCandidates.length === 0) {
    return;
  }
  const width = draft.imageWidth ?? document.querySelector<HTMLCanvasElement>("#maskCanvas")?.width ?? 0;
  const height = draft.imageHeight ?? document.querySelector<HTMLCanvasElement>("#maskCanvas")?.height ?? 0;
  if (width <= 0 || height <= 0) {
    return;
  }
  const requestId = nextWebSamRequestId();
  latestWebSamDecodeRequestId = requestId;
  postWebSamMessage({
    type: "reprocess",
    requestId,
    outputWidth: width,
    outputHeight: height,
    threshold: draft.threshold,
    smoothing: draft.smoothing
  });
}

function hasWebSamPrompt(draft: InpaintDraft) {
  return draft.foregroundPoints.length > 0 || !!normalizePromptBox(draft.boxPrompt);
}

function candidateFromWorker(candidate: WebSamWorkerCandidate): Promise<SamMaskCandidate> {
  return imageDataToDataUrl(candidate.mask).then((dataUrl) => ({
    index: candidate.index,
    score: candidate.score,
    dataUrl
  }));
}

function imageDataToDataUrl(imageData: ImageData) {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return Promise.resolve("");
  }
  context.putImageData(imageData, 0, 0);
  return Promise.resolve(canvas.toDataURL("image/png"));
}

async function drawCandidatePreview(assetId: string, dataUrl: string) {
  const draft = inpaintDraftForAsset(assetId);
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  if (!draft || !canvas) {
    return;
  }
  const layers = await ensureMaskLayerSet(draft, canvas.width, canvas.height);
  clearCanvas(layers.previewSamMask);
  await drawDataUrlIntoCanvas(layers.previewSamMask, dataUrl);
  renderFinalMaskToCanvas(canvas, layers, { ...draft, previewSamMaskDataUrl: dataUrl }, true);
}

function selectSamCandidate(index: number) {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  const candidate = draft?.samCandidates.find((item) => item.index === index) ?? null;
  if (!assetId || !draft || !candidate) {
    return;
  }
  setInpaintDraft({
    ...draft,
    selectedSamCandidateIndex: candidate.index,
    previewSamMaskDataUrl: candidate.dataUrl
  });
  void drawCandidatePreview(assetId, candidate.dataUrl);
  requestRender();
}

export async function applySelectedSamCandidate() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  const candidate = draft?.samCandidates.find((item) => item.index === draft.selectedSamCandidateIndex) ?? null;
  const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
  if (!assetId || !draft || !candidate || !canvas) {
    return;
  }
  const layers = await ensureMaskLayerSet(draft, canvas.width, canvas.height);
  clearCanvas(layers.samMask);
  clearCanvas(layers.previewSamMask);
  await drawDataUrlIntoCanvas(layers.samMask, candidate.dataUrl);
  setInpaintDraft({
    ...draft,
    samMaskDataUrl: candidate.dataUrl,
    previewSamMaskDataUrl: "",
    maskDataUrl: composeFinalMaskDataUrl(layers, false),
    webSamStatusText: "SAM結果を適用"
  });
  renderFinalMaskToCanvas(canvas, layers, { ...draft, previewSamMaskDataUrl: "" }, false);
  requestRender();
}

function clearWebSamPrompts() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  const layers = assetId ? maskLayerCache.get(assetId) : null;
  if (!assetId || !draft) {
    return;
  }
  if (layers) {
    clearCanvas(layers.brushPrompt);
  }
  setInpaintDraft({
    ...draft,
    foregroundPoints: [],
    boxPrompt: null,
    brushPromptMaskDataUrl: "",
    samCandidates: [],
    selectedSamCandidateIndex: 0,
    previewSamMaskDataUrl: "",
    webSamError: ""
  });
  requestRender();
}

function clearWebSamResult() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  const layers = assetId ? maskLayerCache.get(assetId) : null;
  if (!assetId || !draft) {
    return;
  }
  if (layers) {
    clearCanvas(layers.samMask);
    clearCanvas(layers.previewSamMask);
    setInpaintDraft({
      ...draft,
      samMaskDataUrl: "",
      previewSamMaskDataUrl: "",
      samCandidates: [],
      selectedSamCandidateIndex: 0,
      maskDataUrl: composeFinalMaskDataUrl(layers, false)
    });
  } else {
    setInpaintDraft({ ...draft, samMaskDataUrl: "", previewSamMaskDataUrl: "", samCandidates: [], selectedSamCandidateIndex: 0, maskDataUrl: "" });
  }
  requestRender();
}

/** SAM マスクを含む全マスク層をクリアする（旧: 手動修正のみクリア）。ボタン表示は「マスクをクリア」。 */
function clearManualMaskLayers() {
  const assetId = state.activeAssetId ?? state.generationDraft?.inpaint?.parentAssetId ?? null;
  const draft = assetId ? inpaintDraftForAsset(assetId) : null;
  const layers = assetId ? maskLayerCache.get(assetId) : null;
  if (!assetId || !draft) {
    return;
  }
  if (layers) {
    clearCanvas(layers.manualInclude);
    clearCanvas(layers.manualErase);
    clearCanvas(layers.samMask);
    clearCanvas(layers.previewSamMask);
    setInpaintDraft({
      ...draft,
      manualIncludeMaskDataUrl: "",
      manualEraseMaskDataUrl: "",
      samMaskDataUrl: "",
      previewSamMaskDataUrl: "",
      samCandidates: [],
      selectedSamCandidateIndex: 0,
      maskDataUrl: composeFinalMaskDataUrl(layers, false)
    });
  } else {
    setInpaintDraft({
      ...draft,
      manualIncludeMaskDataUrl: "",
      manualEraseMaskDataUrl: "",
      samMaskDataUrl: "",
      previewSamMaskDataUrl: "",
      samCandidates: [],
      selectedSamCandidateIndex: 0
    });
  }
  requestRender();
}


export async function destroyWebSamWorkerSession() {
  if (!webSamWorker) {
    return;
  }
  const requestId = nextWebSamRequestId();
  postWebSamMessage({ type: "destroy", requestId });
}

// ---- main.ts(composition root)向けの公開 API ----

export function clearActiveWebSamBoxPrompt() {
  activeBoxPrompt = null;
}

export function handleWebSamPointerMove(event: PointerEvent): boolean {
  if (activeBoxPrompt) {
    if (event.pointerId !== activeBoxPrompt.pointerId) {
      return true;
    }
    const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
    if (!canvas) {
      return true;
    }
    event.preventDefault();
    continueWebSamBoxPrompt(event, canvas);
    return true;
  }
  return false;
}

export function handleWebSamPointerUp(event: PointerEvent): boolean {
  if (activeBoxPrompt && event.pointerId === activeBoxPrompt.pointerId) {
    const canvas = document.querySelector<HTMLCanvasElement>("#maskCanvas");
    if (canvas) {
      event.preventDefault();
      finishWebSamBoxPrompt(canvas);
    }
    return true;
  }
  return false;
}

export function handleWebSamPointerCancel(event: PointerEvent): boolean {
  if (activeBoxPrompt && event.pointerId === activeBoxPrompt.pointerId) {
    activeBoxPrompt = null;
    return true;
  }
  return false;
}

registerActions({
  "websam-load-model": () => loadActiveWebSamModel(),
  "websam-retry": () => loadActiveWebSamModel(),
  "websam-decode": () => requestWebSamDecode(),
  "websam-candidate": (_id, target) => {
    selectSamCandidate(Number(target.dataset.index ?? 0));
  },
  "websam-apply-candidate": () => applySelectedSamCandidate(),
  "websam-clear-prompts": () => {
    clearWebSamPrompts();
  },
  "websam-clear-result": () => {
    clearWebSamResult();
  },
  "websam-clear-manual": () => {
    clearManualMaskLayers();
  },
  "set-smart-mask-provider": (_id, target) => {
    const provider = target.dataset.provider ?? "";
    if (isSmartMaskProvider(provider)) {
      setSmartMaskProvider(provider);
    }
  }
});
