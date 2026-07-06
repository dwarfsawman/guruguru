/**
 * ComfyUI ワークフローJSON(API形式)から「必要なモデルファイル一覧」を抽出する共有ロジック。
 * `src/client/workflowDefaults.ts` の `modelDefaultsFromWorkflow` と同様の
 * 入力名ベースのノード走査方式を踏襲する。ブラウザ専用APIに依存しないため、
 * 将来サーバー側の API からも利用できる。
 */
import { type Json, isJsonObject } from "./json";

export type ModelKind = "checkpoint" | "diffusionModel" | "textEncoder" | "vae" | "controlnet" | "lora";

export interface WorkflowModelRequirement {
  kind: ModelKind;
  name: string;
  loaderClass: string;
  inputName: string;
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
  lora_name: "lora"
};

export const MODEL_TARGET_DIRS: Record<ModelKind, string> = {
  checkpoint: "models/checkpoints",
  diffusionModel: "models/diffusion_models",
  textEncoder: "models/text_encoders",
  vae: "models/vae",
  controlnet: "models/controlnet",
  lora: "models/loras"
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
        requirements.push({ kind, name: value, loaderClass, inputName });
      }
    }
  }

  return requirements;
}
