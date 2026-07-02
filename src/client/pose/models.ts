import type { PoseModelDefinition, PoseModelUrls } from "./types";

const MB = 1024 * 1024;

export const POSE_MODELS: PoseModelDefinition[] = [
  {
    id: "pose-landmarker-full",
    label: "MediaPipe Pose Landmarker (Full)",
    description: "MediaPipe official pose landmarker, float16, ~9MB",
    modelFile: "pose_landmarker_full.task",
    totalSize: 9_398_198
  }
];

export function defaultPoseModel(): PoseModelDefinition {
  return POSE_MODELS[0]!;
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
