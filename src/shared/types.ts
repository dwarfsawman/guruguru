import type { PastedObject } from "./pasteAttachments";

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

/**
 * 生成時の貼り付け込み合成画像(Docs/Feature-ImagePaste.md「エッジに添付」モデル)。
 * クライアントが「元画像+ペイントレイヤー+添付オブジェクト」を合成した PNG を
 * imageDataUrl で送り、サーバがファイル化して img2img 入力として ComfyUI へ渡す
 * (inpaint.maskDataUrl → maskPath と同型)。parentAssetId・ツリー構造は変えない。
 * objects は生成時点の添付スナップショット(エッジポップアウトの添付表示用)。
 */
export interface PasteCompositeOptions {
  imageDataUrl?: string | null;
  compositePath?: string | null;
  compositeWidth?: number | null;
  compositeHeight?: number | null;
  objects?: PastedObject[] | null;
}

/**
 * Consistent Character(Docs/Feature-ConsistentCharacter.md)の参照画像。顔スタイル参照
 * (PuLID)と全体スタイル参照(IP-Adapter)は同じ1枚の画像を共用し、それぞれ独立に
 * 有効化できる。両方 false でも imageDataUrl/imagePath を持ちうる(先に画像だけ
 * 取り込んでおくケース)。inpaint.maskDataUrl と同じ規約で、保存後は imageDataUrl を
 * null化して request_json に残さない。
 */
export interface ReferenceImageOptions {
  imageDataUrl?: string | null;
  imagePath?: string | null;
  face: { enabled: boolean };
  style: { enabled: boolean };
}

export interface ComfySettings {
  baseUrl: string;
  websocketUrl: string;
  timeoutSeconds: number;
  imageFetchMode: "view";
  storageDir: string;
  webSamModelBaseUrl: string;
}

export interface LlmSettings {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number;
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
  pasteComposite?: PasteCompositeOptions | null;
  reference?: ReferenceImageOptions | null;
}

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}
