import type {
  WebSamBox,
  WebSamModelDefinition,
  WebSamModelStatus,
  WebSamModelUrls,
  WebSamPrompt,
  WebSamRawImageData,
  WebSamWorkerCandidate,
  WebSamWorkerProgress,
  WebSamWorkerRequest,
  WebSamWorkerResponse
} from "./types";
import { postProcessMasks, reprocessMask } from "./maskPostprocess";

const MODEL_INPUT_SIZE = 1024;
const IMAGE_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGE_STD = [0.229, 0.224, 0.225] as const;
const CACHE_DIR = "guruguru-websam-models";

type OrtModule = Awaited<ReturnType<typeof loadOrtModule>>;
type InferenceSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;
type Tensor = InstanceType<OrtModule["Tensor"]>;

interface ModelSession {
  encoder: InferenceSession;
  decoder: InferenceSession;
  model: WebSamModelDefinition;
  backend: "webgpu" | "wasm";
}

interface Sam1Embedding {
  imageEmbeddings: Float32Array;
  imagePositionalEmbeddings: Float32Array;
}

interface CachedDecodeResult {
  rawLogits: Float32Array;
  scores: number[];
  selectedIndex: number;
  outputWidth: number;
  outputHeight: number;
}

type ReprocessRequest = Extract<WebSamWorkerRequest, { type: "reprocess" }>;

let ortModule: OrtModule | null = null;
let session: ModelSession | null = null;
let embedding: Sam1Embedding | null = null;
let cachedDecode: CachedDecodeResult | null = null;
let loadedImageSize: { width: number; height: number } | null = null;
let queue: Promise<void> = Promise.resolve();
let pendingReprocess: ReprocessRequest | null = null;
let reprocessScheduled = false;

function loadOrtModule() {
  return import("onnxruntime-web/webgpu");
}

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

self.addEventListener("message", (event: MessageEvent<WebSamWorkerRequest>) => {
  const message = event.data;
  if (message.type === "reprocess") {
    pendingReprocess = message;
    scheduleLatestReprocess();
    return;
  }
  // 新しい画像・prompt・session操作は、それ以前のslider再処理を無効化する。
  pendingReprocess = null;
  void serialize(() => handleRequest(message));
});

function scheduleLatestReprocess() {
  if (reprocessScheduled) {
    return;
  }
  reprocessScheduled = true;
  setTimeout(() => {
    void serialize(async () => {
      const message = pendingReprocess;
      pendingReprocess = null;
      if (message) {
        await handleRequest(message);
      }
    }).finally(() => {
      reprocessScheduled = false;
      if (pendingReprocess) {
        scheduleLatestReprocess();
      }
    });
  }, 0);
}

async function handleRequest(message: WebSamWorkerRequest) {
  try {
    if (message.type === "load-model") {
      await loadModel(message.requestId, message.model, message.urls);
    } else if (message.type === "encode-image") {
      await encodeImage(message.requestId, message.imageData);
    } else if (message.type === "decode") {
      await decodePrompt(message.requestId, message.prompt, message.outputWidth, message.outputHeight, message.threshold, message.smoothing);
    } else if (message.type === "reprocess") {
      await reprocessPrompt(
        message.requestId,
        message.outputWidth,
        message.outputHeight,
        message.threshold,
        message.smoothing,
        message.selectedIndex
      );
    } else if (message.type === "destroy") {
      await destroyCurrentSession();
      post({ type: "destroyed", requestId: message.requestId });
    }
  } catch (error) {
    post({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function loadModel(requestId: number, model: WebSamModelDefinition, urls: WebSamModelUrls) {
  await destroyCurrentSession();
  embedding = null;
  cachedDecode = null;
  loadedImageSize = null;

  const encoderCacheName = `${model.id}-encoder.onnx`;
  const decoderCacheName = `${model.id}-decoder.onnx`;
  let cached = false;
  let encoderBuffer = await readCachedModelFile(encoderCacheName);
  let decoderBuffer = await readCachedModelFile(decoderCacheName);

  if (encoderBuffer && decoderBuffer) {
    cached = true;
    postProgress(requestId, {
      status: "cached",
      bytesDownloaded: model.totalSize,
      totalBytes: model.totalSize,
      cached
    });
  } else {
    postProgress(requestId, {
      status: "not-cached",
      bytesDownloaded: 0,
      totalBytes: model.totalSize,
      cached: false
    });
    const buffers = await downloadModelFiles(requestId, model, urls);
    encoderBuffer = buffers.encoderBuffer;
    decoderBuffer = buffers.decoderBuffer;
    await Promise.allSettled([
      writeCachedModelFile(encoderCacheName, encoderBuffer),
      writeCachedModelFile(decoderCacheName, decoderBuffer)
    ]);
  }

  postProgress(requestId, {
    status: "initializing",
    bytesDownloaded: model.totalSize,
    totalBytes: model.totalSize,
    cached
  });
  const created = await createSam1Session(model, encoderBuffer, decoderBuffer);
  session = created;
  post({
    type: "model-ready",
    requestId,
    backend: created.backend,
    cached,
    fallback: created.backend === "wasm" && hasWebGpu()
  });
}

async function getOrt() {
  if (!ortModule) {
    ortModule = await loadOrtModule();
    ortModule.env.logLevel = "warning";
    ortModule.env.wasm.wasmPaths = "/ort/";
    ortModule.env.wasm.numThreads = 1;
  }
  return ortModule;
}

async function createSam1Session(model: WebSamModelDefinition, encoderBuffer: ArrayBuffer, decoderBuffer: ArrayBuffer): Promise<ModelSession> {
  const ort = await getOrt();
  const providerAttempts: Array<{ backend: "webgpu" | "wasm"; executionProviders: unknown[] }> = hasWebGpu()
    ? [
        { backend: "webgpu", executionProviders: ["webgpu"] },
        { backend: "wasm", executionProviders: ["wasm"] }
      ]
    : [{ backend: "wasm", executionProviders: ["wasm"] }];
  let lastError: unknown = null;

  for (const attempt of providerAttempts) {
    try {
      const options = { executionProviders: attempt.executionProviders } as Parameters<typeof ort.InferenceSession.create>[1];
      const encoder = await ort.InferenceSession.create(encoderBuffer, options);
      const decoder = await ort.InferenceSession.create(decoderBuffer, options);
      return { encoder, decoder, model, backend: attempt.backend };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`ONNX Runtime initialization failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function encodeImage(requestId: number, imageData: WebSamRawImageData) {
  if (!session) {
    throw new Error("WebSAM model is not ready.");
  }
  postProgress(requestId, {
    status: "encoding",
    bytesDownloaded: session.model.totalSize,
    totalBytes: session.model.totalSize,
    cached: true,
    detail: "preprocessing"
  });
  const inputTensor = preprocessImage(imageData);
  const ort = await getOrt();
  postProgress(requestId, {
    status: "encoding",
    bytesDownloaded: session.model.totalSize,
    totalBytes: session.model.totalSize,
    cached: true,
    detail: "encoder"
  });
  const results = await session.encoder.run({
    pixel_values: new ort.Tensor("float32", inputTensor, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]) as Tensor
  });
  embedding = {
    imageEmbeddings: results.image_embeddings.data as Float32Array,
    imagePositionalEmbeddings: results.image_positional_embeddings.data as Float32Array
  };
  cachedDecode = null;
  loadedImageSize = { width: imageData.width, height: imageData.height };
  post({ type: "encoded", requestId, width: imageData.width, height: imageData.height });
}

async function decodePrompt(
  requestId: number,
  prompt: WebSamPrompt,
  outputWidth: number,
  outputHeight: number,
  threshold: number,
  smoothing: number
) {
  if (!session || !embedding) {
    throw new Error("WebSAM image embedding is not ready.");
  }
  const points = promptToModelPoints(prompt, outputWidth, outputHeight);
  if (points.coords.length === 0) {
    throw new Error("Point, box, or brush prompt is required before decoding.");
  }
  postProgress(requestId, {
    status: "decoding",
    bytesDownloaded: session.model.totalSize,
    totalBytes: session.model.totalSize,
    cached: true
  });
  const ort = await getOrt();
  const results = await session.decoder.run({
    input_points: new ort.Tensor("float32", points.coords, [1, 1, points.count, 2]) as Tensor,
    input_labels: new ort.Tensor("int64", points.labels, [1, 1, points.count]) as Tensor,
    image_embeddings: new ort.Tensor("float32", embedding.imageEmbeddings, [1, 256, 64, 64]) as Tensor,
    image_positional_embeddings: new ort.Tensor("float32", embedding.imagePositionalEmbeddings, [1, 256, 64, 64]) as Tensor
  });
  const maskTensor = results.pred_masks;
  const dims = maskTensor.dims;
  const maskWidth = Number(dims[dims.length - 1]);
  const maskHeight = Number(dims[dims.length - 2]);
  const postProcessed = postProcessMasks(
    maskTensor.data as Float32Array,
    results.iou_scores.data as Float32Array,
    maskWidth,
    maskHeight,
    outputWidth,
    outputHeight,
    threshold,
    smoothing
  );
  cachedDecode = {
    rawLogits: postProcessed.rawLogits,
    scores: postProcessed.scores,
    selectedIndex: postProcessed.selectedIndex,
    outputWidth,
    outputHeight
  };
  const candidates = postProcessed.masks.map((alpha, index) => alphaMaskCandidate(
    index,
    postProcessed.scores[index] ?? null,
    outputWidth,
    outputHeight,
    alpha
  ));
  post({
    type: "decoded",
    requestId,
    candidates,
    selectedIndex: postProcessed.selectedIndex,
    replaceCandidates: true
  }, candidates.map((candidate) => candidate.mask.alpha));
}

async function reprocessPrompt(
  requestId: number,
  outputWidth: number,
  outputHeight: number,
  threshold: number,
  smoothing: number,
  selectedIndex: number
) {
  if (!cachedDecode) {
    throw new Error("No cached WebSAM logits are available. Decode a prompt first.");
  }
  if (cachedDecode.outputWidth !== outputWidth || cachedDecode.outputHeight !== outputHeight) {
    throw new Error("Cached WebSAM logits do not match the requested output size.");
  }
  const alpha = reprocessMask(cachedDecode.rawLogits, outputWidth, outputHeight, selectedIndex, threshold, smoothing);
  const candidate = alphaMaskCandidate(
    selectedIndex,
    cachedDecode.scores[selectedIndex] ?? null,
    outputWidth,
    outputHeight,
    alpha
  );
  cachedDecode.selectedIndex = selectedIndex;
  post({
    type: "decoded",
    requestId,
    candidates: [candidate],
    selectedIndex,
    replaceCandidates: false
  }, [candidate.mask.alpha]);
}

function alphaMaskCandidate(
  index: number,
  score: number | null,
  width: number,
  height: number,
  alpha: Uint8Array
): WebSamWorkerCandidate {
  return { index, score, mask: { width, height, alpha: alpha.buffer as ArrayBuffer } };
}

function preprocessImage(imageData: WebSamRawImageData): Float32Array {
  const { width, height } = imageData;
  if (!("OffscreenCanvas" in self)) {
    throw new Error("This browser does not support OffscreenCanvas in Workers.");
  }
  const scale = MODEL_INPUT_SIZE / Math.max(width, height);
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);
  const sourceCanvas = new OffscreenCanvas(width, height);
  const sourceContext = sourceCanvas.getContext("2d");
  const targetCanvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  const targetContext = targetCanvas.getContext("2d");
  if (!sourceContext || !targetContext) {
    throw new Error("Failed to initialize image preprocessing canvas.");
  }
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(imageData.data), width, height), 0, 0);
  targetContext.clearRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  targetContext.drawImage(sourceCanvas, 0, 0, scaledWidth, scaledHeight);
  const pixels = targetContext.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE).data;
  const pixelCount = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const tensor = new Float32Array(3 * pixelCount);

  for (let index = 0; index < pixelCount; index += 1) {
    const rgbaIndex = index * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = pixels[rgbaIndex + channel]! / 255;
      tensor[channel * pixelCount + index] = (value - IMAGE_MEAN[channel]!) / IMAGE_STD[channel]!;
    }
  }
  return tensor;
}

function promptToModelPoints(prompt: WebSamPrompt, outputWidth: number, outputHeight: number) {
  const pointItems: Array<{ x: number; y: number; label: 0 | 1 | 2 | 3 }> = [];
  for (const point of prompt.points) {
    pointItems.push({ x: point.x, y: point.y, label: point.label });
  }
  const normalizedBox = normalizeBox(prompt.box);
  if (normalizedBox) {
    pointItems.push({ x: normalizedBox.x1, y: normalizedBox.y1, label: 2 });
    pointItems.push({ x: normalizedBox.x2, y: normalizedBox.y2, label: 3 });
  }

  const coords = new Float32Array(pointItems.length * 2);
  const labels = new BigInt64Array(pointItems.length);
  for (let index = 0; index < pointItems.length; index += 1) {
    const point = pointItems[index]!;
    const [x, y] = imageToModelCoords(point.x, point.y, outputWidth, outputHeight);
    coords[index * 2] = x;
    coords[index * 2 + 1] = y;
    labels[index] = BigInt(point.label);
  }
  return { coords, labels, count: pointItems.length };
}

function normalizeBox(box: WebSamBox | null) {
  if (!box) {
    return null;
  }
  const x1 = Math.min(box.x1, box.x2);
  const x2 = Math.max(box.x1, box.x2);
  const y1 = Math.min(box.y1, box.y2);
  const y2 = Math.max(box.y1, box.y2);
  if (Math.abs(x2 - x1) < 2 || Math.abs(y2 - y1) < 2) {
    return null;
  }
  return { x1, y1, x2, y2 };
}

function imageToModelCoords(imageX: number, imageY: number, imageWidth: number, imageHeight: number): [number, number] {
  const scale = MODEL_INPUT_SIZE / Math.max(imageWidth, imageHeight);
  return [imageX * scale, imageY * scale];
}

async function downloadModelFiles(requestId: number, model: WebSamModelDefinition, urls: WebSamModelUrls) {
  let encoderDownloaded = 0;
  postProgress(requestId, {
    status: "downloading",
    bytesDownloaded: 0,
    totalBytes: model.totalSize,
    cached: false,
    detail: "encoder"
  });
  const encoderBuffer = await fetchWithProgress(urls.encoderUrl, model.encoderSize, (downloaded) => {
    encoderDownloaded = downloaded;
    postProgress(requestId, {
      status: "downloading",
      bytesDownloaded: encoderDownloaded,
      totalBytes: model.totalSize,
      cached: false,
      detail: "encoder"
    });
  });
  const decoderBuffer = await fetchWithProgress(urls.decoderUrl, model.decoderSize, (downloaded) => {
    postProgress(requestId, {
      status: "downloading",
      bytesDownloaded: encoderDownloaded + downloaded,
      totalBytes: model.totalSize,
      cached: false,
      detail: "decoder"
    });
  });
  return { encoderBuffer, decoderBuffer };
}

async function fetchWithProgress(url: string, expectedSize: number, onProgress: (downloaded: number) => void) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Model download failed: ${response.status} ${response.statusText}`);
  }
  const contentLength = Number(response.headers.get("content-length")) || expectedSize;
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    onProgress(buffer.byteLength);
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let downloaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    downloaded += value.byteLength;
    onProgress(Math.min(downloaded, contentLength || downloaded));
  }
  const output = new Uint8Array(downloaded);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

async function readCachedModelFile(filename: string) {
  if (!navigator.storage?.getDirectory) {
    return null;
  }
  try {
    const dir = await getCacheDirectory();
    const handle = await dir.getFileHandle(filename);
    const file = await handle.getFile();
    return file.arrayBuffer();
  } catch {
    return null;
  }
}

async function writeCachedModelFile(filename: string, data: ArrayBuffer) {
  if (!navigator.storage?.getDirectory) {
    return;
  }
  const dir = await getCacheDirectory();
  const handle = await dir.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort();
    throw error;
  }
}

async function getCacheDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(CACHE_DIR, { create: true });
}

async function destroyCurrentSession() {
  if (session) {
    await Promise.allSettled([session.encoder.release(), session.decoder.release()]);
  }
  session = null;
  embedding = null;
  cachedDecode = null;
  loadedImageSize = null;
}

function hasWebGpu() {
  return "gpu" in navigator;
}

function post(message: WebSamWorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer });
}

function postProgress(requestId: number, progress: WebSamWorkerProgress) {
  post({ type: "progress", requestId, progress });
}

export {};
