export type TemplateType = "txt2img" | "img2img" | "ipadapter" | "controlnet" | "hybrid";

export type RoundStatus = "pending" | "running" | "completed" | "failed" | "interrupted";

export type GenerationMode =
  | "txt2img"
  | "img2img"
  | "ipadapter"
  | "controlnet"
  | "seed_reuse"
  | "prompt_reuse"
  | "upscale"
  | "detail"
  | "manual_upload";

export type AssetStatus = "generated" | "selected" | "rejected" | "favorite" | "archived" | "failed";

export type SelectionAction = "select" | "unselect" | "reject" | "unreject" | "favorite" | "unfavorite";

export type ParentRelation =
  | "img2img"
  | "ipadapter_reference"
  | "controlnet_reference"
  | "seed_reuse"
  | "prompt_reuse"
  | "upscale"
  | "detailer"
  | "manual";

export type MaskedContent = "fill" | "original" | "latent_noise" | "latent_nothing";

export type InpaintArea = "only_masked";

export interface InpaintOptions {
  maskedContent: MaskedContent;
  inpaintArea: InpaintArea;
  onlyMaskedPadding: number;
  featherRadius?: number;
  maskDataUrl?: string | null;
  maskPath?: string | null;
  maskWidth?: number | null;
  maskHeight?: number | null;
}

export interface ControlNetOptions {
  poseImageDataUrl: string | null;
  poseImagePath?: string | null;
  strength: number;
  startPercent: number;
  endPercent: number;
}

export interface ComfySettings {
  baseUrl: string;
  websocketUrl: string;
  timeoutSeconds: number;
  imageFetchMode: "view";
  storageDir: string;
  webSamModelBaseUrl: string;
}

export interface GenerationRequest {
  templateId: string;
  prompt: string;
  negativePrompt: string;
  seed: number | null;
  seedMode: "fixed" | "random" | "increment" | "reuse_parent_seed";
  batchSize: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  denoise: number;
  width: number;
  height: number;
  generationMode: GenerationMode;
  parentAssetId?: string | null;
  relationType?: ParentRelation | null;
  inpaint?: InpaintOptions | null;
  controlnet?: ControlNetOptions | null;
}

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}
