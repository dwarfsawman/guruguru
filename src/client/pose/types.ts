export type PoseModelStatus =
  | "idle"
  | "missing-url"
  | "not-cached"
  | "downloading"
  | "cached"
  | "initializing"
  | "ready"
  | "detecting"
  | "error";

export interface PoseModelDefinition {
  id: "pose-landmarker-full";
  label: string;
  description: string;
  modelFile: string;
  totalSize: number;
}

export interface PoseModelUrls {
  modelUrl: string;
}

export interface PoseRawImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PoseWorkerProgress {
  status: PoseModelStatus;
  bytesDownloaded: number;
  totalBytes: number;
  cached: boolean;
  detail?: string;
}

export interface PoseWorkerLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export type PoseWorkerRequest =
  | {
      type: "load-model";
      requestId: number;
      model: PoseModelDefinition;
      urls: PoseModelUrls;
    }
  | {
      type: "detect";
      requestId: number;
      imageData: PoseRawImageData;
    }
  | {
      type: "destroy";
      requestId: number;
    };

export type PoseWorkerResponse =
  | {
      type: "progress";
      requestId: number;
      progress: PoseWorkerProgress;
    }
  | {
      type: "model-ready";
      requestId: number;
      backend: "GPU" | "CPU";
      cached: boolean;
      fallback: boolean;
    }
  | {
      type: "detected";
      requestId: number;
      landmarks: PoseWorkerLandmark[][];
    }
  | {
      type: "destroyed";
      requestId: number;
    }
  | {
      type: "error";
      requestId: number;
      message: string;
    };
