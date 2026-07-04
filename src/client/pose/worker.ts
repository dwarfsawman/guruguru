import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
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
const WASM_BASE_URL = "/mediapipe-wasm";

interface LandmarkerSession {
  landmarker: PoseLandmarker;
  model: PoseModelDefinition;
  backend: "GPU" | "CPU";
}

let session: LandmarkerSession | null = null;
let queue: Promise<void> = Promise.resolve();

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

async function loadModel(requestId: number, model: PoseModelDefinition, urls: PoseModelUrls) {
  await destroyCurrentSession();

  const cacheName = model.modelFile;
  let cached = false;
  let modelBuffer = await readCachedModelFile(cacheName);

  if (modelBuffer) {
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
    modelBuffer = await fetchWithProgress(requestId, urls.modelUrl, model.totalSize);
    await writeCachedModelFile(cacheName, modelBuffer).catch(() => undefined);
  }

  postProgress(requestId, {
    status: "initializing",
    bytesDownloaded: model.totalSize,
    totalBytes: model.totalSize,
    cached
  });

  const created = await createLandmarkerSession(model, modelBuffer);
  session = created;
  post({
    type: "model-ready",
    requestId,
    backend: created.backend,
    cached,
    fallback: created.backend === "CPU"
  });
}

async function createLandmarkerSession(model: PoseModelDefinition, modelBuffer: ArrayBuffer): Promise<LandmarkerSession> {
  const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
  const delegateAttempts: Array<"GPU" | "CPU"> = ["GPU", "CPU"];
  let lastError: unknown = null;

  for (const delegate of delegateAttempts) {
    try {
      const landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetBuffer: new Uint8Array(modelBuffer),
          delegate
        },
        runningMode: "IMAGE",
        numPoses: MAX_POSE_COUNT
      });
      return { landmarker, model, backend: delegate };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`MediaPipe Pose Landmarker initialization failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function detect(requestId: number, imageData: PoseRawImageData) {
  if (!session) {
    throw new Error("Pose model is not ready.");
  }
  postProgress(requestId, {
    status: "detecting",
    bytesDownloaded: session.model.totalSize,
    totalBytes: session.model.totalSize,
    cached: true
  });
  const bitmap = await rawImageDataToBitmap(imageData);
  try {
    const result = session.landmarker.detect(bitmap);
    const landmarks: PoseWorkerLandmark[][] = result.landmarks.map((pose) =>
      pose.map((point) => ({
        x: point.x,
        y: point.y,
        z: point.z,
        visibility: point.visibility
      }))
    );
    post({ type: "detected", requestId, landmarks });
  } finally {
    bitmap.close();
  }
}

async function rawImageDataToBitmap(imageData: PoseRawImageData): Promise<ImageBitmap> {
  if (!("OffscreenCanvas" in self)) {
    throw new Error("This browser does not support OffscreenCanvas in Workers.");
  }
  const source = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  return createImageBitmap(source);
}

async function fetchWithProgress(requestId: number, url: string, expectedSize: number) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Model download failed: ${response.status} ${response.statusText}`);
  }
  const contentLength = Number(response.headers.get("content-length")) || expectedSize;
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    postProgress(requestId, {
      status: "downloading",
      bytesDownloaded: buffer.byteLength,
      totalBytes: contentLength,
      cached: false
    });
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
    postProgress(requestId, {
      status: "downloading",
      bytesDownloaded: Math.min(downloaded, contentLength || downloaded),
      totalBytes: contentLength,
      cached: false
    });
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
    session.landmarker.close();
  }
  session = null;
}

function post(message: PoseWorkerResponse) {
  self.postMessage(message);
}

function postProgress(requestId: number, progress: PoseWorkerProgress) {
  post({ type: "progress", requestId, progress });
}

export {};
