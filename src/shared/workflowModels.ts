/**
 * ComfyUI ワークフローJSON(API形式)から「必要なモデルファイル一覧」を抽出する共有ロジック。
 * `src/client/workflowDefaults.ts` の `modelDefaultsFromWorkflow` と同様の
 * 入力名ベースのノード走査方式を踏襲する。ブラウザ専用APIに依存しないため、
 * 将来サーバー側の API からも利用できる。
 */
import { type Json, isJsonObject } from "./json";

export type ModelFamily = "chroma" | "anima";

export function detectWorkflowModelFamily(workflow: Json): ModelFamily {
  const serialized = JSON.stringify(workflow).toLowerCase();
  return serialized.includes("anima-") || serialized.includes("qwen_3_06b_base") ? "anima" : "chroma";
}

export type ModelKind =
  | "checkpoint"
  | "diffusionModel"
  | "textEncoder"
  | "vae"
  | "lora"
  | "controlnet"
  | "pulid";

/**
 * Consistent Character 機能タクソノミ。"base" はテンプレートの必須4モデル(常時要求・
 * トグル対象外)。それ以外はユーザーが任意にON/OFFできる機能で、`Docs/Feature-ConsistentCharacter.md`
 * の「必要ノードパック」表に対応する。
 */
export type FeatureKey = "base" | "controlnet" | "pulid" | "animaInContext";

export interface WorkflowModelRequirement {
  kind: ModelKind;
  name: string;
  loaderClass: string;
  inputName: string;
  feature: FeatureKey;
  /** Some feature adapters must be installed at the exact ComfyUI choice path. Defaults to true. */
  matchBasename?: boolean;
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
  // PulidFluxModelLoader(PaoloC68/ComfyUI-PuLID-Flux-Chroma)の実ソースで確認した入力名。
  pulid_file: "pulid"
};

export const MODEL_TARGET_DIRS: Record<ModelKind, string> = {
  checkpoint: "models/checkpoints",
  diffusionModel: "models/diffusion_models",
  textEncoder: "models/text_encoders",
  vae: "models/vae",
  lora: "models/loras",
  controlnet: "models/controlnet",
  pulid: "models/pulid"
};

export const KIND_TO_FEATURE: Record<ModelKind, FeatureKey> = {
  checkpoint: "base",
  diffusionModel: "base",
  textEncoder: "base",
  vae: "base",
  lora: "base",
  controlnet: "controlnet",
  pulid: "pulid"
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
