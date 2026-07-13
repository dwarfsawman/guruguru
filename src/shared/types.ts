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
 * (PuLID / Anima In-Context)の参照元。face が false でも imageDataUrl/imagePath を持ちうる(先に画像だけ
 * 取り込んでおくケース)。inpaint.maskDataUrl と同じ規約で、保存後は imageDataUrl を
 * null化して request_json に残さない。
 */
export interface ReferenceImageOptions {
  imageDataUrl?: string | null;
  imagePath?: string | null;
  /** Server-resolved Character appearance binding. The client cannot provide a local file path. */
  characterBinding?: { characterId: string; providerId: string } | null;
  /** Approved Reference Set. The server validates ownership/version and copies its files per Round. */
  referenceSet?: { setId: string; version: number } | null;
  /** Server-populated per-Round copies. Clients must never provide these local paths. */
  images?: { facePath?: string | null; fullBodyPath?: string | null } | null;
  /** Automatic manga sets this so missing adapter/node packs fail instead of silently falling back. */
  strict?: boolean;
  face: { enabled: boolean };
  /** Experimental Anima identity conditioning. Availability is gated server-side per workflow family. */
  animaInContext?: {
    enabled: boolean;
    strength?: number;
    startPercent?: number;
    endPercent?: number;
  } | null;
}

/**
 * Consistent Character: 絵柄コントロール用の LoRA 選択(1件)。`name` は ComfyUI の
 * `LoraLoaderModelOnly.lora_name` が報告する実 choice 文字列(サブフォルダ込み。例
 * `chroma\\Chroma_Voyager_86.safetensors`)をそのまま使う。`strength` は 0〜2。
 */
export interface StyleLoraSelection {
  name: string;
  strength: number;
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
  /**
   * OpenAI互換サーバーの Authorization: Bearer トークン(Docs/Feature-ScriptToManga.md S4)。
   * この値そのものは API レスポンスへ露出しない(既知の罠11。GET/PUT /api/settings/llm は
   * `LlmSettingsView`(hasApiKey フラグのみ)を返す -- src/shared/apiTypes.ts 参照)。
   */
  apiKey?: string;
}

/** Dedicated local multimodal auditor; kept separate from prompt/dialogue LLM settings. */
export interface VlmAuditSettings {
  baseUrl: string;
  model: string;
  /** LM Studio native chat is used for this Gemma 4 build so image input and reasoning=off are explicit. */
  transport?: "lmstudio-native" | "openai-compatible";
  /** Downloaded LM Studio model key; `model` may instead be a loaded instance identifier. */
  modelKey?: string;
  temperature: number;
  timeoutSeconds: number;
  maxReferenceImages: number;
  passThreshold: number;
  contextLength?: number;
  manageModelLifecycle?: boolean;
  releaseComfyBeforeAudit?: boolean;
  unloadAfterAudit?: boolean;
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
  /** Consistent Character: ユーザーが選んだ絵柄/キャラ LoRA(複数スタック可)。 */
  loras?: StyleLoraSelection[] | null;
}

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}
