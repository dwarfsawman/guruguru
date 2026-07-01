/**
 * WorkflowTemplate から生成フォーム既定値 / model readout 用の値を読む純粋 helper。
 * `src/client/main.ts` から抽出。戻り値・fallback・参照 role map path の意味は維持。
 */
import { type Json, isJsonObject } from "./json";
import type { TemplateGenerationDefaults, TemplateModelDefaults, WorkflowTemplate } from "./workflowTypes";

export function defaultModeForTemplate(template: WorkflowTemplate | null) {
  if (template && ["txt2img", "img2img", "ipadapter", "controlnet"].includes(template.type)) {
    return template.type;
  }
  return "txt2img";
}

export function templateGenerationDefaults(template: WorkflowTemplate | null): TemplateGenerationDefaults {
  if (!template) {
    return { model: emptyModelDefaults() };
  }

  const workflow = template.workflowJson;
  const roleMap = template.roleMap;
  return {
    prompt: stringFromNodeInput(workflow, roleMap.positive_prompt_node, ["text", "prompt", "positive"]),
    negativePrompt: stringFromNodeInput(workflow, roleMap.negative_prompt_node, ["text", "prompt", "negative"]),
    seed: numberFromPath(workflow, roleMap.seed_input) ?? numberFromNodeInput(workflow, roleMap.ksampler_node, ["seed"]),
    batchSize:
      numberFromPath(workflow, roleMap.batch_size_input ?? roleMap.repeat_latent_batch_amount_input) ??
      numberFromNodeInput(workflow, roleMap.empty_latent_node, ["batch_size"]) ??
      numberFromNodeInput(workflow, roleMap.repeat_latent_batch_node, ["amount"]),
    steps: numberFromPath(workflow, roleMap.steps_input) ?? numberFromNodeInput(workflow, roleMap.ksampler_node, ["steps"]),
    cfg: numberFromPath(workflow, roleMap.cfg_input) ?? numberFromNodeInput(workflow, roleMap.ksampler_node, ["cfg"]),
    sampler:
      stringFromPath(workflow, roleMap.sampler_input ?? roleMap.sampler_name_input) ??
      stringFromNodeInput(workflow, roleMap.ksampler_node, ["sampler_name", "sampler"]),
    scheduler:
      stringFromPath(workflow, roleMap.scheduler_input) ??
      stringFromNodeInput(workflow, roleMap.ksampler_node, ["scheduler"]),
    denoise: numberFromPath(workflow, roleMap.denoise_input) ?? numberFromNodeInput(workflow, roleMap.ksampler_node, ["denoise"]),
    width: numberFromPath(workflow, roleMap.width_input) ?? numberFromNodeInput(workflow, roleMap.empty_latent_node, ["width"]),
    height: numberFromPath(workflow, roleMap.height_input) ?? numberFromNodeInput(workflow, roleMap.empty_latent_node, ["height"]),
    model: modelDefaultsFromWorkflow(workflow)
  };
}

export function emptyModelDefaults(): TemplateModelDefaults {
  return {
    textEncoders: [],
    loras: []
  };
}

export function modelDefaultsFromWorkflow(workflow: Json): TemplateModelDefaults {
  const model = emptyModelDefaults();

  for (const rawNode of Object.values(workflow)) {
    if (!isJsonObject(rawNode) || !isJsonObject(rawNode.inputs)) {
      continue;
    }

    const classType = typeof rawNode.class_type === "string" ? rawNode.class_type : "";
    const inputs = rawNode.inputs;

    model.checkpoint ??= firstStringInput(inputs, ["ckpt_name", "checkpoint_name"]);
    model.diffusionModel ??= firstStringInput(inputs, ["unet_name", "diffusion_model_name", "model_name"]);

    if (classType.includes("CLIP") || hasAnyInput(inputs, ["clip_name", "clip_name1", "clip_name2", "clip_name3"])) {
      appendUnique(model.textEncoders, firstStringInput(inputs, ["clip_name"]));
      appendUnique(model.textEncoders, firstStringInput(inputs, ["clip_name1"]));
      appendUnique(model.textEncoders, firstStringInput(inputs, ["clip_name2"]));
      appendUnique(model.textEncoders, firstStringInput(inputs, ["clip_name3"]));
    }

    if (classType.includes("VAE") || "vae_name" in inputs) {
      model.vae ??= firstStringInput(inputs, ["vae_name"]);
    }

    appendUnique(model.loras, firstStringInput(inputs, ["lora_name"]));
  }

  return model;
}

export function firstStringInput(inputs: Json, names: string[]) {
  for (const name of names) {
    const value = inputs[name];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

export function hasAnyInput(inputs: Json, names: string[]) {
  return names.some((name) => name in inputs);
}

export function appendUnique(values: string[], value: string | undefined) {
  if (value && !values.includes(value)) {
    values.push(value);
  }
}

export function stringFromPath(source: Json, rawPath: unknown) {
  const value = valueFromPath(source, rawPath);
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function numberFromPath(source: Json, rawPath: unknown) {
  const value = valueFromPath(source, rawPath);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringFromNodeInput(source: Json, rawNodeId: unknown, inputNames: string[]) {
  const value = valueFromNodeInput(source, rawNodeId, inputNames);
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function numberFromNodeInput(source: Json, rawNodeId: unknown, inputNames: string[]) {
  const value = valueFromNodeInput(source, rawNodeId, inputNames);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function valueFromNodeInput(source: Json, rawNodeId: unknown, inputNames: string[]) {
  if (typeof rawNodeId !== "string") {
    return undefined;
  }

  const node = source[rawNodeId];
  if (!isJsonObject(node) || !isJsonObject(node.inputs)) {
    return undefined;
  }

  for (const inputName of inputNames) {
    if (inputName in node.inputs) {
      return node.inputs[inputName];
    }
  }
  return undefined;
}

export function valueFromPath(source: Json, rawPath: unknown) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return undefined;
  }

  let cursor: unknown = source;
  for (const part of rawPath.split(".").filter(Boolean)) {
    if (!isJsonObject(cursor) || !(part in cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}
