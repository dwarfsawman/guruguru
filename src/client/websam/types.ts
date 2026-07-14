export type WebSamProviderId = "manual" | "websam-slimsam-77";

export type WebSamPromptMode = "point" | "box" | "brush";

export type WebSamModelStatus =
  | "idle"
  | "missing-url"
  | "not-cached"
  | "downloading"
  | "cached"
  | "initializing"
  | "encoding"
  | "ready"
  | "decoding"
  | "error";

export interface WebSamPoint {
  x: number;
  y: number;
  label: 0 | 1;
  source?: "point" | "brush";
}

export interface WebSamBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface WebSamPrompt {
  points: WebSamPoint[];
  box: WebSamBox | null;
}

export interface WebSamRawImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface WebSamModelDefinition {
  id: "slimsam-77";
  providerId: "websam-slimsam-77";
  label: string;
  description: string;
  family: "sam1";
  encoderFile: string;
  decoderFile: string;
  encoderSize: number;
  decoderSize: number;
  totalSize: number;
  quantization: "int8";
}

export interface WebSamModelUrls {
  encoderUrl: string;
  decoderUrl: string;
}

export interface WebSamWorkerCandidate {
  index: number;
  score: number | null;
  mask: {
    width: number;
    height: number;
    alpha: ArrayBuffer;
  };
}

export interface WebSamWorkerProgress {
  status: WebSamModelStatus;
  bytesDownloaded: number;
  totalBytes: number;
  cached: boolean;
  detail?: string;
}

export type WebSamWorkerRequest =
  | {
      type: "load-model";
      requestId: number;
      model: WebSamModelDefinition;
      urls: WebSamModelUrls;
    }
  | {
      type: "encode-image";
      requestId: number;
      imageData: WebSamRawImageData;
    }
  | {
      type: "decode";
      requestId: number;
      prompt: WebSamPrompt;
      outputWidth: number;
      outputHeight: number;
      threshold: number;
      smoothing: number;
    }
  | {
      type: "reprocess";
      requestId: number;
      outputWidth: number;
      outputHeight: number;
      threshold: number;
      smoothing: number;
      selectedIndex: number;
    }
  | {
      type: "destroy";
      requestId: number;
    };

export type WebSamWorkerResponse =
  | {
      type: "progress";
      requestId: number;
      progress: WebSamWorkerProgress;
    }
  | {
      type: "model-ready";
      requestId: number;
      backend: "webgpu" | "wasm";
      cached: boolean;
      fallback: boolean;
    }
  | {
      type: "encoded";
      requestId: number;
      width: number;
      height: number;
    }
  | {
      type: "decoded";
      requestId: number;
      candidates: WebSamWorkerCandidate[];
      selectedIndex: number;
      replaceCandidates: boolean;
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
