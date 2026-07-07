/**
 * ComfyUI ワークフローJSON(API形式)から「必要なモデルファイル一覧」を抽出する共有ロジック。
 * `src/client/workflowDefaults.ts` の `modelDefaultsFromWorkflow` と同様の
 * 入力名ベースのノード走査方式を踏襲する。ブラウザ専用APIに依存しないため、
 * 将来サーバー側の API からも利用できる。
 */
import { type Json, isJsonObject } from "./json";

export type ModelKind =
  | "checkpoint"
  | "diffusionModel"
  | "textEncoder"
  | "vae"
  | "controlnet"
  | "lora"
  | "pulid"
  | "ipadapterFlux"
  | "clipVision";

/**
 * Consistent Character 機能タクソノミ。"base" はテンプレートの必須4モデル(常時要求・
 * トグル対象外)。それ以外はユーザーが任意にON/OFFできる機能で、`Docs/Feature-ConsistentCharacter.md`
 * の「必要ノードパック」表に対応する。
 */
export type FeatureKey = "base" | "controlnet" | "lora" | "pulid" | "ipadapter" | "rmbg";

export interface WorkflowModelRequirement {
  kind: ModelKind;
  name: string;
  loaderClass: string;
  inputName: string;
  feature: FeatureKey;
}

const INPUT_NAME_TO_KIND: Record<string, ModelKind> = {
  ckpt_name: "checkpoint",
  unet_name: "diffusionModel",
  clip_name: "textEncoder",
  clip_name1: "textEncoder",
  clip_name2: "textEncoder",
  clip_name3: "textEncoder",
  vae_name: "vae",
  control_net_name: "controlnet",
  lora_name: "lora",
  // PulidFluxModelLoader(PaoloC68/ComfyUI-PuLID-Flux-Chroma)の実ソースで確認した入力名。
  pulid_file: "pulid",
  // LoadFluxIPAdapter(XLabs-AI/x-flux-comfyui)の実ソースで確認した入力名。
  // "ipadatper" は原文ママ(アップストリームのタイポ)。
  ipadatper: "ipadapterFlux",
  // 同ノードの clip_vision 入力。コアの CLIPVisionLoader は入力名が "clip_name" のため衝突しない。
  clip_vision: "clipVision"
};

export const MODEL_TARGET_DIRS: Record<ModelKind, string> = {
  checkpoint: "models/checkpoints",
  diffusionModel: "models/diffusion_models",
  textEncoder: "models/text_encoders",
  vae: "models/vae",
  controlnet: "models/controlnet",
  lora: "models/loras",
  pulid: "models/pulid",
  ipadapterFlux: "models/xlabs/ipadapters",
  clipVision: "models/clip_vision"
};

export const KIND_TO_FEATURE: Record<ModelKind, FeatureKey> = {
  checkpoint: "base",
  diffusionModel: "base",
  textEncoder: "base",
  vae: "base",
  controlnet: "controlnet",
  lora: "lora",
  pulid: "pulid",
  ipadapterFlux: "ipadapter",
  clipVision: "ipadapter"
};

export function extractModelRequirements(workflow: Json): WorkflowModelRequirement[] {
  const requirements: WorkflowModelRequirement[] = [];

  for (const rawNode of Object.values(workflow)) {
    if (!isJsonObject(rawNode) || !isJsonObject(rawNode.inputs)) {
      continue;
    }

    const loaderClass = typeof rawNode.class_type === "string" ? rawNode.class_type : "";
    const inputs = rawNode.inputs;

    for (const [inputName, kind] of Object.entries(INPUT_NAME_TO_KIND)) {
      const value = inputs[inputName];
      if (typeof value === "string" && value.trim() !== "") {
        requirements.push({ kind, name: value, loaderClass, inputName, feature: KIND_TO_FEATURE[kind] });
      }
    }
  }

  return requirements;
}
