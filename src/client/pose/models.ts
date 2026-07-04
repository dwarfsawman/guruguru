import type { PoseModelDefinition, PoseModelUrls } from "./types";

const MB = 1024 * 1024;

export const POSE_MODELS: PoseModelDefinition[] = [
  {
    id: "pose-landmarker-full",
    label: "MediaPipe Pose Landmarker (Full)",
    description: "MediaPipe official pose landmarker, float16, ~9MB",
    modelFile: "pose_landmarker_full.task",
    totalSize: 9_398_198
  },
  {
    id: "pose-landmarker-heavy",
    label: "MediaPipe Pose Landmarker (Heavy)",
    description: "MediaPipe official pose landmarker, float16, ~29MB, 高精度",
    modelFile: "pose_landmarker_heavy.task",
    totalSize: 30_664_242
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
  return {
    modelUrl: `${normalized}/${model.modelFile}`
  };
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
