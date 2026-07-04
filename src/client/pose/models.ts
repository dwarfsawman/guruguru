import type { PoseModelDefinition, PoseModelUrls } from "./types";

const MB = 1024 * 1024;

const YOLOX_NANO_FILE = "yolox_nano.onnx";
const YOLOX_NANO_SIZE = 3_659_407;
const CIGPOSE_L_SIZE = 113_577_664;
const CIGPOSE_X_SIZE = 240_701_836;

export const POSE_MODELS: PoseModelDefinition[] = [
  {
    id: "pose-landmarker-full",
    kind: "mediapipe",
    label: "MediaPipe Pose Landmarker (Full)",
    description: "MediaPipe official pose landmarker, float16, ~9MB",
    modelFile: "pose_landmarker_full.task",
    totalSize: 9_398_198
  },
  {
    id: "pose-landmarker-heavy",
    kind: "mediapipe",
    label: "MediaPipe Pose Landmarker (Heavy)",
    description: "MediaPipe official pose landmarker, float16, ~29MB, 高精度",
    modelFile: "pose_landmarker_heavy.task",
    totalSize: 30_664_242
  },
  {
    id: "cigpose-l",
    kind: "cigpose",
    label: "CIGPose L (COCO body, GPU)",
    description: "CIGPose top-down（YOLOX-Nano + L, 17点, 384x288）。GPU推奨・高精度、DL 約117MB",
    modelFile: "cigpose-l_coco_384x288.onnx",
    totalSize: YOLOX_NANO_SIZE + CIGPOSE_L_SIZE,
    detectorFile: YOLOX_NANO_FILE,
    detectorSize: YOLOX_NANO_SIZE,
    poseSize: CIGPOSE_L_SIZE,
    inputWidth: 288,
    inputHeight: 384,
    splitRatio: 2.0,
    keypointLayout: "body17"
  },
  {
    id: "cigpose-x",
    kind: "cigpose",
    label: "CIGPose X (wholebody, GPU)",
    description: "CIGPose top-down（YOLOX-Nano + X wholebody, 先頭17点を body に使用, 384x288）。最重量・最高精度、DL 約244MB",
    modelFile: "cigpose-x_coco-wholebody_384x288.onnx",
    totalSize: YOLOX_NANO_SIZE + CIGPOSE_X_SIZE,
    detectorFile: YOLOX_NANO_FILE,
    detectorSize: YOLOX_NANO_SIZE,
    poseSize: CIGPOSE_X_SIZE,
    inputWidth: 288,
    inputHeight: 384,
    splitRatio: 2.0,
    keypointLayout: "wholebody133"
  }
];

export function defaultPoseModel(): PoseModelDefinition {
  return POSE_MODELS[0]!;
}

export function poseModelById(id: string | null | undefined): PoseModelDefinition | null {
  if (!id) {
    return null;
  }
  return POSE_MODELS.find((model) => model.id === id) ?? null;
}

export function buildPoseModelUrls(baseUrl: string, model: PoseModelDefinition): PoseModelUrls | null {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    return null;
  }
  const urls: PoseModelUrls = {
    modelUrl: `${normalized}/${model.modelFile}`
  };
  if (model.detectorFile) {
    urls.detectorUrl = `${normalized}/${model.detectorFile}`;
  }
  return urls;
}

/** CIGPose 系（onnxruntime-web の別 worker で動く top-down モデル）か。 */
export function isCigposeModel(model: PoseModelDefinition): boolean {
  return model.kind === "cigpose";
}

export function formatModelBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < MB) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / MB).toFixed(0)} MB`;
}
