import type { WebSamModelDefinition, WebSamModelUrls, WebSamProviderId } from "./types";

const MB = 1024 * 1024;

export const WEB_SAM_MODELS: WebSamModelDefinition[] = [
  {
    id: "slimsam-77",
    providerId: "websam-slimsam-77",
    label: "SlimSAM-77",
    description: "Recommended CPU-friendly SAM1 model, 77% pruned INT8",
    family: "sam1",
    encoderFile: "slimsam-77-encoder.onnx",
    decoderFile: "slimsam-77-decoder.onnx",
    encoderSize: 9 * MB,
    decoderSize: 5 * MB,
    totalSize: 14 * MB,
    quantization: "int8"
  }
];

export const SMART_MASK_PROVIDERS: Array<{ id: WebSamProviderId; label: string; modelId?: string }> = [
  { id: "manual", label: "Manual" },
  { id: "websam-slimsam-77", label: "WebSAM - SlimSAM-77", modelId: "slimsam-77" }
];

export function modelForProvider(providerId: WebSamProviderId) {
  return WEB_SAM_MODELS.find((model) => model.providerId === providerId) ?? null;
}

export function buildWebSamModelUrls(baseUrl: string, model: WebSamModelDefinition): WebSamModelUrls | null {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    return null;
  }
  return {
    encoderUrl: `${normalized}/${model.encoderFile}`,
    decoderUrl: `${normalized}/${model.decoderFile}`
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
