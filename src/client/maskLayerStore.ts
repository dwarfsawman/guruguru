import type { InpaintDraft, MaskLayerSet } from "./maskTypes";
import { clearCanvas, createMaskLayerSet, drawDataUrlIntoCanvas } from "./maskCanvas";

export const maskLayerCache = new Map<string, MaskLayerSet>();

export async function ensureMaskLayerSet(draft: InpaintDraft, width: number, height: number): Promise<MaskLayerSet> {
  let layers = maskLayerCache.get(draft.parentAssetId);
  if (layers && layers.width === width && layers.height === height) {
    return layers;
  }

  layers = createMaskLayerSet(draft.parentAssetId, width, height);
  maskLayerCache.set(draft.parentAssetId, layers);
  await syncMaskLayerSetFromDraft(layers, draft);
  return layers;
}

export async function syncMaskLayerSetFromDraft(layers: MaskLayerSet, draft: InpaintDraft) {
  clearCanvas(layers.samMask);
  clearCanvas(layers.previewSamMask);
  clearCanvas(layers.manualInclude);
  clearCanvas(layers.manualErase);
  clearCanvas(layers.brushPrompt);
  await Promise.all([
    drawDataUrlIntoCanvas(layers.samMask, draft.samMaskDataUrl),
    drawDataUrlIntoCanvas(layers.previewSamMask, draft.previewSamMaskDataUrl),
    drawDataUrlIntoCanvas(layers.manualInclude, draft.manualIncludeMaskDataUrl || draft.maskDataUrl),
    drawDataUrlIntoCanvas(layers.manualErase, draft.manualEraseMaskDataUrl),
    drawDataUrlIntoCanvas(layers.brushPrompt, draft.brushPromptMaskDataUrl)
  ]);
}

export function getOrCreateMaskLayerSet(assetId: string, width: number, height: number): MaskLayerSet {
  let layers = maskLayerCache.get(assetId);
  if (layers && layers.width === width && layers.height === height) {
    return layers;
  }
  layers = createMaskLayerSet(assetId, width, height);
  maskLayerCache.set(assetId, layers);
  return layers;
}
