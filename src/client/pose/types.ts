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

/** 検出エンジン。mediapipe = @mediapipe/tasks-vision（classic worker）、cigpose = onnxruntime-web top-down（module worker）。 */
export type PoseModelKind = "mediapipe" | "cigpose";

/** CIGPose の出力キーポイント配列。body17 = COCO 17点、wholebody133 = COCO-WholeBody 133点（先頭17点を body として使用）。 */
export type PoseKeypointLayout = "body17" | "wholebody133";

export interface PoseModelDefinition {
  id: string;
  /** 省略時は "mediapipe" 扱い（既存 .task モデルとの後方互換）。 */
  kind?: PoseModelKind;
  label: string;
  description: string;
  /** メインのモデルファイル名（mediapipe: .task、cigpose: pose .onnx）。 */
  modelFile: string;
  /** ダウンロード進捗の分母（cigpose は detector + pose の合計）。 */
  totalSize: number;
  // ---- cigpose 専用 ----
  /** 人物検出器のファイル名（YOLOX-Nano ONNX）。 */
  detectorFile?: string;
  detectorSize?: number;
  poseSize?: number;
  /** pose モデルの入力幅/高さ（px）。384x288 モデルは inputWidth=288, inputHeight=384。 */
  inputWidth?: number;
  inputHeight?: number;
  /** SimCC の分割比（argmax 位置を割って入力座標へ戻す）。 */
  splitRatio?: number;
  keypointLayout?: PoseKeypointLayout;
}

export interface PoseModelUrls {
  modelUrl: string;
  /** cigpose の人物検出器 URL。 */
  detectorUrl?: string;
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
