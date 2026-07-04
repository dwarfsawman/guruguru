/**
 * CIGPose（top-down）ポーズ検出 worker（onnxruntime-web / WebGPU→WASM フォールバック）。
 *
 * MediaPipe 版（`pose/worker.ts`, classic worker）とは別の **module worker**。
 * onnxruntime-web は `import.meta` を使う wasm ローダのため module worker が必須で、
 * MediaPipe の wasm グルー（classic worker 必須）とは同居できない。両者は共通の
 * `PoseWorkerRequest` / `PoseWorkerResponse` プロトコルを話し、main.ts が model.kind で
 * どちらの worker へ送るかを振り分ける。
 *
 * パイプライン（`namas191297/cigpose-onnx` の run_onnx.py を移植）:
 *   1. YOLOX-Nano で人物 bbox 検出（letterbox 416 / grid+stride デコード / NMS）
 *   2. bbox ごとに crop→resize→ImageNet 正規化して CIGPose へ入力
 *   3. SimCC 出力を argmax デコード → crop 座標へリマップ
 *   4. COCO 17点（wholebody は先頭17点）を MediaPipe 33 レイアウトのスロットへ詰めて返す
 *      （既存 `mediapipeToOpenPose` 変換をそのまま流用できるようにするため）
 */
import { MAX_POSE_COUNT } from "../poseTypes";
import type {
  PoseModelDefinition,
  PoseModelUrls,
  PoseRawImageData,
  PoseWorkerLandmark,
  PoseWorkerProgress,
  PoseWorkerRequest,
  PoseWorkerResponse
} from "./types";

const CACHE_DIR = "guruguru-pose-models";

// ---- YOLOX-Nano（人物検出）----
const YOLOX_INPUT = 416;
const YOLOX_PAD = 114; // letterbox の余白色（グレー）
const YOLOX_STRIDES = [8, 16, 32] as const;
const DET_CONF_THRESHOLD = 0.5; // objectness*person
const DET_NMS_THRESHOLD = 0.45;

// ---- CIGPose（姿勢推定）----
const POSE_MEAN = [123.675, 116.28, 103.53] as const; // ImageNet（0-255スケール, RGB）
const POSE_STD = [58.395, 57.12, 57.375] as const;

/** COCO 17点 index → MediaPipe 33 landmark index。`poseDraft.ts` の変換が読むスロットに一致させる。 */
const COCO17_TO_MEDIAPIPE33 = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28] as const;
const MEDIAPIPE_LANDMARK_COUNT = 33;
const BODY_KEYPOINTS = COCO17_TO_MEDIAPIPE33.length; // 17

type OrtModule = Awaited<ReturnType<typeof loadOrtModule>>;
type InferenceSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;
type Tensor = InstanceType<OrtModule["Tensor"]>;

interface DetectorGrid {
  gridX: Float32Array;
  gridY: Float32Array;
  strides: Float32Array;
  count: number;
}

interface CigposeSession {
  detector: InferenceSession;
  pose: InferenceSession;
  model: PoseModelDefinition;
  backend: "GPU" | "CPU";
  grid: DetectorGrid;
}

interface PersonBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

let ortModule: OrtModule | null = null;
let session: CigposeSession | null = null;
let queue: Promise<void> = Promise.resolve();

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

self.addEventListener("message", (event: MessageEvent<PoseWorkerRequest>) => {
  const message = event.data;
  void serialize(async () => {
    try {
      if (message.type === "load-model") {
        await loadModel(message.requestId, message.model, message.urls);
      } else if (message.type === "probe-cache") {
        await probeCache(message.requestId, message.model);
      } else if (message.type === "detect") {
        await detect(message.requestId, message.imageData);
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
  });
});

async function getOrt() {
  if (!ortModule) {
    ortModule = await loadOrtModule();
    ortModule.env.logLevel = "warning";
    ortModule.env.wasm.wasmPaths = "/ort/";
    ortModule.env.wasm.numThreads = 1;
  }
  return ortModule;
}

async function loadModel(requestId: number, model: PoseModelDefinition, urls: PoseModelUrls) {
  await destroyCurrentSession();

  if (!urls.detectorUrl || !model.detectorFile) {
    throw new Error("CIGPose には人物検出器（YOLOX）URL が必要です。");
  }
  const detectorSize = model.detectorSize ?? 0;
  const poseSize = model.poseSize ?? model.totalSize;

  let detectorBuffer = await readCachedModelFile(model.detectorFile);
  let poseBuffer = await readCachedModelFile(model.modelFile);
  let cached = false;

  if (detectorBuffer && poseBuffer) {
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
    let detectorDownloaded = detectorBuffer ? detectorSize : 0;
    let poseDownloaded = poseBuffer ? poseSize : 0;
    const emit = (detail: string) =>
      postProgress(requestId, {
        status: "downloading",
        bytesDownloaded: detectorDownloaded + poseDownloaded,
        totalBytes: model.totalSize,
        cached: false,
        detail
      });
    if (!detectorBuffer) {
      detectorBuffer = await fetchWithProgress(urls.detectorUrl, detectorSize, (downloaded) => {
        detectorDownloaded = downloaded;
        emit("detector");
      });
    }
    if (!poseBuffer) {
      poseBuffer = await fetchWithProgress(urls.modelUrl, poseSize, (downloaded) => {
        poseDownloaded = downloaded;
        emit("pose");
      });
    }
    await Promise.allSettled([
      writeCachedModelFile(model.detectorFile, detectorBuffer),
      writeCachedModelFile(model.modelFile, poseBuffer)
    ]);
  }

  postProgress(requestId, {
    status: "initializing",
    bytesDownloaded: model.totalSize,
    totalBytes: model.totalSize,
    cached
  });

  const created = await createCigposeSession(model, detectorBuffer, poseBuffer);
  session = created;
  post({
    type: "model-ready",
    requestId,
    backend: created.backend,
    cached,
    fallback: created.backend === "CPU" && hasWebGpu()
  });
}

async function createCigposeSession(
  model: PoseModelDefinition,
  detectorBuffer: ArrayBuffer,
  poseBuffer: ArrayBuffer
): Promise<CigposeSession> {
  const ort = await getOrt();
  const attempts: Array<{ backend: "GPU" | "CPU"; executionProviders: unknown[] }> = hasWebGpu()
    ? [
        { backend: "GPU", executionProviders: ["webgpu"] },
        { backend: "CPU", executionProviders: ["wasm"] }
      ]
    : [{ backend: "CPU", executionProviders: ["wasm"] }];
  let lastError: unknown = null;

  for (const attempt of attempts) {
    try {
      const options = { executionProviders: attempt.executionProviders } as Parameters<
        typeof ort.InferenceSession.create
      >[1];
      const detector = await ort.InferenceSession.create(detectorBuffer, options);
      const pose = await ort.InferenceSession.create(poseBuffer, options);
      return { detector, pose, model, backend: attempt.backend, grid: buildDetectorGrid() };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `CIGPose ONNX Runtime initialization failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

/** YOLOX の grid 座標と stride を事前計算（numpy meshgrid(indexing="ij") 相当）。 */
function buildDetectorGrid(): DetectorGrid {
  const gridX: number[] = [];
  const gridY: number[] = [];
  const strides: number[] = [];
  for (const stride of YOLOX_STRIDES) {
    const size = YOLOX_INPUT / stride;
    for (let iy = 0; iy < size; iy += 1) {
      for (let ix = 0; ix < size; ix += 1) {
        gridX.push(ix);
        gridY.push(iy);
        strides.push(stride);
      }
    }
  }
  return {
    gridX: Float32Array.from(gridX),
    gridY: Float32Array.from(gridY),
    strides: Float32Array.from(strides),
    count: strides.length
  };
}

async function detect(requestId: number, imageData: PoseRawImageData) {
  if (!session) {
    throw new Error("CIGPose model is not ready.");
  }
  postProgress(requestId, {
    status: "detecting",
    bytesDownloaded: session.model.totalSize,
    totalBytes: session.model.totalSize,
    cached: true
  });

  const frameWidth = imageData.width;
  const frameHeight = imageData.height;
  const bitmap = await rawImageDataToBitmap(imageData);
  try {
    const boxes = await detectPersons(bitmap, frameWidth, frameHeight);
    const landmarks: PoseWorkerLandmark[][] = [];
    for (const box of boxes.slice(0, MAX_POSE_COUNT)) {
      landmarks.push(await estimatePose(bitmap, box, frameWidth, frameHeight));
    }
    post({ type: "detected", requestId, landmarks });
  } finally {
    bitmap.close();
  }
}

async function detectPersons(bitmap: ImageBitmap, frameWidth: number, frameHeight: number): Promise<PersonBox[]> {
  if (!session) {
    return [];
  }
  const ort = await getOrt();
  const ratio = Math.min(YOLOX_INPUT / frameHeight, YOLOX_INPUT / frameWidth);
  const scaledWidth = Math.floor(frameWidth * ratio);
  const scaledHeight = Math.floor(frameHeight * ratio);

  const canvas = new OffscreenCanvas(YOLOX_INPUT, YOLOX_INPUT);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to initialize YOLOX preprocessing canvas.");
  }
  context.fillStyle = `rgb(${YOLOX_PAD}, ${YOLOX_PAD}, ${YOLOX_PAD})`;
  context.fillRect(0, 0, YOLOX_INPUT, YOLOX_INPUT);
  context.drawImage(bitmap, 0, 0, scaledWidth, scaledHeight);
  const pixels = context.getImageData(0, 0, YOLOX_INPUT, YOLOX_INPUT).data;

  const plane = YOLOX_INPUT * YOLOX_INPUT;
  const blob = new Float32Array(3 * plane);
  for (let index = 0; index < plane; index += 1) {
    const rgba = index * 4;
    blob[index] = pixels[rgba]!; // R
    blob[plane + index] = pixels[rgba + 1]!; // G
    blob[2 * plane + index] = pixels[rgba + 2]!; // B
  }

  const inputName = session.detector.inputNames[0]!;
  const outputName = session.detector.outputNames[0]!;
  const results = await session.detector.run({
    [inputName]: new ort.Tensor("float32", blob, [1, 3, YOLOX_INPUT, YOLOX_INPUT]) as Tensor
  });
  const output = results[outputName]!;
  const raw = output.data as Float32Array;
  const stride = Number(output.dims[output.dims.length - 1]); // 85
  const anchors = Number(output.dims[output.dims.length - 2]);

  const grid = session.grid;
  const boxes: PersonBox[] = [];
  for (let a = 0; a < anchors; a += 1) {
    const base = a * stride;
    const objectness = raw[base + 4]!;
    const personCls = raw[base + 5]!; // class 0 = person
    const score = objectness * personCls;
    if (score < DET_CONF_THRESHOLD) {
      continue;
    }
    const s = grid.strides[a]!;
    const cx = (raw[base]! + grid.gridX[a]!) * s;
    const cy = (raw[base + 1]! + grid.gridY[a]!) * s;
    const w = Math.exp(raw[base + 2]!) * s;
    const h = Math.exp(raw[base + 3]!) * s;
    // letterbox 空間の box を元画像座標へ（padding は左上原点なのでオフセット不要）
    boxes.push({
      x1: (cx - w / 2) / ratio,
      y1: (cy - h / 2) / ratio,
      x2: (cx + w / 2) / ratio,
      y2: (cy + h / 2) / ratio,
      score
    });
  }
  return nonMaximumSuppression(boxes, DET_NMS_THRESHOLD);
}

function nonMaximumSuppression(boxes: PersonBox[], iouThreshold: number): PersonBox[] {
  const sorted = boxes.slice().sort((a, b) => b.score - a.score);
  const kept: PersonBox[] = [];
  for (const candidate of sorted) {
    let suppressed = false;
    for (const chosen of kept) {
      if (boxIoU(candidate, chosen) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) {
      kept.push(candidate);
    }
  }
  return kept;
}

function boxIoU(a: PersonBox, b: PersonBox): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const intersection = iw * ih;
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

async function estimatePose(
  bitmap: ImageBitmap,
  box: PersonBox,
  frameWidth: number,
  frameHeight: number
): Promise<PoseWorkerLandmark[]> {
  if (!session) {
    return emptyLandmarks();
  }
  const ort = await getOrt();
  const inputWidth = session.model.inputWidth ?? 288;
  const inputHeight = session.model.inputHeight ?? 384;
  const splitRatio = session.model.splitRatio ?? 2.0;

  // bbox を入力アスペクトへ合わせ、1.25 倍に広げてから元画像内へクランプ
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  let bw = box.x2 - box.x1;
  let bh = box.y2 - box.y1;
  const aspect = inputWidth / inputHeight;
  if (bw / Math.max(bh, 1) > aspect) {
    bh = bw / aspect;
  } else {
    bw = bh * aspect;
  }
  bw *= 1.25;
  bh *= 1.25;
  const sx1 = Math.floor(Math.max(0, cx - bw / 2));
  const sy1 = Math.floor(Math.max(0, cy - bh / 2));
  const sx2 = Math.floor(Math.min(frameWidth, cx + bw / 2));
  const sy2 = Math.floor(Math.min(frameHeight, cy + bh / 2));
  const cropWidth = Math.max(1, sx2 - sx1);
  const cropHeight = Math.max(1, sy2 - sy1);

  const canvas = new OffscreenCanvas(inputWidth, inputHeight);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to initialize CIGPose preprocessing canvas.");
  }
  context.drawImage(bitmap, sx1, sy1, cropWidth, cropHeight, 0, 0, inputWidth, inputHeight);
  const pixels = context.getImageData(0, 0, inputWidth, inputHeight).data;

  const plane = inputWidth * inputHeight;
  const tensor = new Float32Array(3 * plane);
  for (let index = 0; index < plane; index += 1) {
    const rgba = index * 4;
    tensor[index] = (pixels[rgba]! - POSE_MEAN[0]!) / POSE_STD[0]!; // R
    tensor[plane + index] = (pixels[rgba + 1]! - POSE_MEAN[1]!) / POSE_STD[1]!; // G
    tensor[2 * plane + index] = (pixels[rgba + 2]! - POSE_MEAN[2]!) / POSE_STD[2]!; // B
  }

  const inputName = session.pose.inputNames[0]!;
  const results = await session.pose.run({
    [inputName]: new ort.Tensor("float32", tensor, [1, 3, inputHeight, inputWidth]) as Tensor
  });
  const simccX = pickSimcc(results, session.pose.outputNames, inputWidth * splitRatio);
  const simccY = pickSimcc(results, session.pose.outputNames, inputHeight * splitRatio);
  const xBins = simccX.bins;
  const yBins = simccY.bins;

  const landmarks = emptyLandmarks();
  const scaleX = cropWidth / inputWidth;
  const scaleY = cropHeight / inputHeight;
  for (let k = 0; k < BODY_KEYPOINTS; k += 1) {
    const xPeak = argmaxRange(simccX.data, k * xBins, xBins);
    const yPeak = argmaxRange(simccY.data, k * yBins, yBins);
    const score = Math.min(xPeak.value, yPeak.value);
    const modelX = xPeak.index / splitRatio;
    const modelY = yPeak.index / splitRatio;
    const frameX = modelX * scaleX + sx1;
    const frameY = modelY * scaleY + sy1;
    landmarks[COCO17_TO_MEDIAPIPE33[k]!] = {
      x: frameX / frameWidth,
      y: frameY / frameHeight,
      z: 0,
      visibility: clamp01(score)
    };
  }
  return landmarks;
}

/** 出力名 simcc_x/simcc_y、無ければ最終次元サイズで判別して取り出す。 */
function pickSimcc(
  results: Record<string, Tensor>,
  outputNames: readonly string[],
  expectedBins: number
): { data: Float32Array; bins: number } {
  const target = Math.round(expectedBins);
  for (const name of outputNames) {
    const tensor = results[name];
    if (!tensor) {
      continue;
    }
    const bins = Number(tensor.dims[tensor.dims.length - 1]);
    if (bins === target) {
      return { data: tensor.data as Float32Array, bins };
    }
  }
  throw new Error(`CIGPose SimCC output with ${target} bins was not found.`);
}

function argmaxRange(data: Float32Array, offset: number, length: number): { index: number; value: number } {
  let bestIndex = 0;
  let bestValue = -Infinity;
  for (let i = 0; i < length; i += 1) {
    const value = data[offset + i]!;
    if (value > bestValue) {
      bestValue = value;
      bestIndex = i;
    }
  }
  return { index: bestIndex, value: bestValue };
}

function emptyLandmarks(): PoseWorkerLandmark[] {
  const landmarks: PoseWorkerLandmark[] = new Array(MEDIAPIPE_LANDMARK_COUNT);
  for (let i = 0; i < MEDIAPIPE_LANDMARK_COUNT; i += 1) {
    landmarks[i] = { x: 0, y: 0, z: 0, visibility: 0 };
  }
  return landmarks;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

async function rawImageDataToBitmap(imageData: PoseRawImageData): Promise<ImageBitmap> {
  if (!("OffscreenCanvas" in self)) {
    throw new Error("This browser does not support OffscreenCanvas in Workers.");
  }
  const source = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  return createImageBitmap(source);
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
  const merged = new Uint8Array(downloaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
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

/** OPFS にファイルが存在するか（中身は読まない）。probe-cache 用。 */
async function hasCachedModelFile(filename: string) {
  if (!navigator.storage?.getDirectory) {
    return false;
  }
  try {
    const dir = await getCacheDirectory();
    await dir.getFileHandle(filename);
    return true;
  } catch {
    return false;
  }
}

/** detector + pose の両ファイルが OPFS に揃っているかを確認して cache-status を返す。 */
async function probeCache(requestId: number, model: PoseModelDefinition) {
  const detectorFile = model.detectorFile;
  const cached = detectorFile
    ? (await hasCachedModelFile(detectorFile)) && (await hasCachedModelFile(model.modelFile))
    : await hasCachedModelFile(model.modelFile);
  post({ type: "cache-status", requestId, modelId: model.id, cached });
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
    await Promise.allSettled([session.detector.release(), session.pose.release()]);
  }
  session = null;
}

function hasWebGpu() {
  return "gpu" in navigator;
}

function post(message: PoseWorkerResponse) {
  self.postMessage(message);
}

function postProgress(requestId: number, progress: PoseWorkerProgress) {
  post({ type: "progress", requestId, progress });
}

export {};
