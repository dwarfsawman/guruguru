/**
 * マスク編集 / WebSAM / canvas layer 周辺の型定義。
 * `src/client/main.ts` から型だけを分離したもの。挙動変更なし。
 * `WebSamPoint` / `WebSamBox` / `WebSamModelStatus` / `WebSamPromptMode` / `WebSamProviderId`
 * は `./websam/types` から、`MaskedContent` / `InpaintArea` は `../shared/types` から import する。
 * 本 module は `main.ts` を import しない（circular import なし）。
 */
import type { InpaintArea, MaskedContent } from "../shared/types";
import type {
  WebSamBox,
  WebSamModelStatus,
  WebSamPoint,
  WebSamPromptMode,
  WebSamProviderId
} from "./websam/types";

export interface InpaintDraft {
  parentAssetId: string;
  maskDataUrl: string;
  enabled: boolean;
  maskedContent: MaskedContent;
  inpaintArea: InpaintArea;
  onlyMaskedPadding: number;
  featherRadius: number;
  brushSize: number;
  eraser: boolean;
  selectedSmartMaskProvider: WebSamProviderId;
  selectedWebSamModel: string;
  webSamModelStatus: WebSamModelStatus;
  webSamDownloadProgress: number;
  webSamStatusText: string;
  webSamError: string;
  webSamPromptMode: WebSamPromptMode;
  foregroundPoints: WebSamPoint[];
  boxPrompt: WebSamBox | null;
  brushPromptMaskDataUrl: string;
  samCandidates: SamMaskCandidate[];
  selectedSamCandidateIndex: number;
  samMaskDataUrl: string;
  previewSamMaskDataUrl: string;
  manualIncludeMaskDataUrl: string;
  manualEraseMaskDataUrl: string;
  threshold: number;
  smoothing: number;
  maskOpacity: number;
  zoomScale: number;
  panOffset: { x: number; y: number };
  imageWidth: number | null;
  imageHeight: number | null;
}

export interface SamMaskCandidate {
  index: number;
  score: number | null;
  dataUrl: string;
}

export type MaskStrokeKind = "manual-include" | "manual-erase" | "brush-prompt";

export interface MaskStrokeSegment {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface ActiveMaskStroke {
  pointerId: number;
  x: number;
  y: number;
  kind: MaskStrokeKind;
  /**
   * rAF バッチ用の未描画線分キュー。pointermove（getCoalescedEvents）で積み、
   * 次の requestAnimationFrame コールバックでまとめて `paintStroke` してから空にする。
   */
  pendingSegments: MaskStrokeSegment[];
}

export interface ActiveBoxPrompt {
  pointerId: number;
  start: { x: number; y: number };
  current: { x: number; y: number };
}

export interface ActiveImagePan {
  pointerId: number;
  assetId: string;
  startClient: { x: number; y: number };
  originOffset: { x: number; y: number };
}

export interface MaskLayerSet {
  assetId: string;
  width: number;
  height: number;
  samMask: HTMLCanvasElement;
  previewSamMask: HTMLCanvasElement;
  manualInclude: HTMLCanvasElement;
  manualErase: HTMLCanvasElement;
  brushPrompt: HTMLCanvasElement;
}

export type MaskBrushCursorKind = "pen" | "eraser" | "brush-prompt";
