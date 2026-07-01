/**
 * マスク編集の下書き (InpaintDraft) に関する純粋 helper。
 * `src/client/main.ts` から、DOM/state に依存しない pure helper を分離したもの。
 * 既定値・fallback・判定の挙動は維持。
 *
 * - `maskedContent` の既定は `"original"`。
 * - `brushSize` 既定は `48`。
 * - `maskOpacity` 既定は `0.58`。
 * - 旧 `maskDataUrl` しかない draft を `manualIncludeMaskDataUrl` に移す fallback を維持。
 * - `hasMaskData` は `data:image/png;base64,` 判定を維持。
 *
 * 本 module は `main.ts` を import しない（circular import なし）。
 */
import type { MaskedContent } from "../shared/types";
import type { InpaintDraft } from "./maskTypes";

export const maskedContentOptions: Array<{ value: MaskedContent; label: string }> = [
  { value: "original", label: "original（元画像を維持・低デノイズで灰色になりにくい）" },
  { value: "fill", label: "fill（マスク部を灰色で埋める・低デノイズで灰色が残る）" },
  { value: "latent_noise", label: "latent noise（空の潜在にノイズマスク）" },
  { value: "latent_nothing", label: "latent nothing（空の潜在）" }
];

export function defaultInpaintDraft(assetId: string): InpaintDraft {
  return {
    parentAssetId: assetId,
    maskDataUrl: "",
    enabled: false,
    maskedContent: "original",
    inpaintArea: "only_masked",
    onlyMaskedPadding: 32,
    brushSize: 48,
    eraser: false,
    selectedSmartMaskProvider: "manual",
    selectedWebSamModel: "slimsam-77",
    webSamModelStatus: "idle",
    webSamDownloadProgress: 0,
    webSamStatusText: "未取得",
    webSamError: "",
    webSamPromptMode: "point",
    foregroundPoints: [],
    boxPrompt: null,
    brushPromptMaskDataUrl: "",
    samCandidates: [],
    selectedSamCandidateIndex: 0,
    samMaskDataUrl: "",
    previewSamMaskDataUrl: "",
    manualIncludeMaskDataUrl: "",
    manualEraseMaskDataUrl: "",
    threshold: 0,
    smoothing: 0,
    maskOpacity: 0.58,
    zoomScale: 1,
    panOffset: { x: 0, y: 0 },
    imageWidth: null,
    imageHeight: null
  };
}

export function normalizeInpaintDraft(draft: InpaintDraft): InpaintDraft {
  const defaults = defaultInpaintDraft(draft.parentAssetId);
  const normalized = {
    ...defaults,
    ...draft,
    panOffset: draft.panOffset ?? defaults.panOffset,
    foregroundPoints: draft.foregroundPoints ?? [],
    samCandidates: draft.samCandidates ?? []
  };
  if (
    !normalized.samMaskDataUrl &&
    !normalized.previewSamMaskDataUrl &&
    !normalized.manualIncludeMaskDataUrl &&
    !normalized.manualEraseMaskDataUrl &&
    !normalized.brushPromptMaskDataUrl &&
    normalized.maskDataUrl
  ) {
    normalized.manualIncludeMaskDataUrl = normalized.maskDataUrl;
  }
  return normalized;
}

export function hasMaskData(draft: InpaintDraft | null | undefined) {
  return !!draft?.maskDataUrl && draft.maskDataUrl.startsWith("data:image/png;base64,");
}

export function hasActiveMaskData(draft: InpaintDraft | null | undefined) {
  return draft?.enabled === true && hasMaskData(draft);
}

export function isMaskedContent(value: string): value is MaskedContent {
  return maskedContentOptions.some((option) => option.value === value);
}
