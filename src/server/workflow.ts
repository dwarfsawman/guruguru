import { randomInt } from "node:crypto";
import type { GenerationRequest } from "../shared/types";
import { type JsonObject, deepClone, ensureWorkflowObject, hashJson, normalizeRoleMap, setNodeInput, setRolePath } from "./workflowGraph";
import { patchImg2ImgLatentPath, patchInpaintLatentPath } from "./workflowInpaint";

export { ensureWorkflowObject, hashJson, normalizeRoleMap };

export interface PatchContext {
  projectId: string;
  roundIndex: number;
  batchIndex?: number | null;
  request: GenerationRequest;
  uploadedImageName?: string | null;
  uploadedMaskName?: string | null;
}

export function resolveSeed(request: GenerationRequest, parentSeed?: number | null): number {
  if (request.seedMode === "reuse_parent_seed" && typeof parentSeed === "number") {
    return parentSeed;
  }

  if (request.seedMode === "increment" && typeof request.seed === "number") {
    return request.seed + 1;
  }

  if (request.seedMode === "fixed" && typeof request.seed === "number") {
    return request.seed;
  }

  return randomInt(0, 2 ** 31 - 1);
}

export function patchWorkflow(workflowJson: unknown, roleMap: Record<string, unknown>, context: PatchContext) {
  const workflow = deepClone(workflowJson) as JsonObject;
  const { request } = context;

  setNodeInput(workflow, roleMap.positive_prompt_node, ["text", "prompt", "positive"], request.prompt);
  setNodeInput(workflow, roleMap.negative_prompt_node, ["text", "prompt", "negative"], request.negativePrompt);

  setRolePath(workflow, roleMap.seed_input, request.seed);
  setRolePath(workflow, roleMap.cfg_input, request.cfg);
  setRolePath(workflow, roleMap.steps_input, request.steps);
  setRolePath(workflow, roleMap.denoise_input, request.denoise);
  setRolePath(workflow, roleMap.batch_size_input, request.batchSize);
  setRolePath(workflow, roleMap.sampler_input ?? roleMap.sampler_name_input, request.sampler);
  setRolePath(workflow, roleMap.scheduler_input, request.scheduler);
  setRolePath(workflow, roleMap.width_input, request.width);
  setRolePath(workflow, roleMap.height_input, request.height);

  setNodeInput(workflow, roleMap.ksampler_node, ["seed"], request.seed);
  setNodeInput(workflow, roleMap.ksampler_node, ["cfg"], request.cfg);
  setNodeInput(workflow, roleMap.ksampler_node, ["steps"], request.steps);
  setNodeInput(workflow, roleMap.ksampler_node, ["denoise"], request.denoise);
  setNodeInput(workflow, roleMap.ksampler_node, ["sampler_name", "sampler"], request.sampler);
  setNodeInput(workflow, roleMap.ksampler_node, ["scheduler"], request.scheduler);

  setNodeInput(workflow, roleMap.empty_latent_node, ["batch_size"], request.batchSize);
  setNodeInput(workflow, roleMap.empty_latent_node, ["width"], request.width);
  setNodeInput(workflow, roleMap.empty_latent_node, ["height"], request.height);

  if (context.uploadedImageName) {
    setRolePath(workflow, roleMap.load_image_input, context.uploadedImageName);
    setRolePath(workflow, roleMap.ipadapter_image_input, context.uploadedImageName);
    setRolePath(workflow, roleMap.controlnet_image_input, context.uploadedImageName);
    setNodeInput(workflow, roleMap.load_image_node, ["image"], context.uploadedImageName);
    setNodeInput(workflow, roleMap.ipadapter_image_node, ["image"], context.uploadedImageName);
    setNodeInput(workflow, roleMap.controlnet_image_node, ["image"], context.uploadedImageName);
    if (request.generationMode === "img2img" && request.inpaint && context.uploadedMaskName) {
      patchInpaintLatentPath(workflow, roleMap, context.uploadedImageName, context.uploadedMaskName, request);
    } else if (request.generationMode === "img2img") {
      patchImg2ImgLatentPath(workflow, roleMap, context.uploadedImageName, request);
    }
  }

  const savePrefix = typeof context.batchIndex === "number"
    ? `guruguru/${context.projectId}/round_${String(context.roundIndex).padStart(3, "0")}/job_${String(context.batchIndex).padStart(3, "0")}`
    : `guruguru/${context.projectId}/round_${String(context.roundIndex).padStart(3, "0")}`;
  setRolePath(workflow, roleMap.save_prefix_input, savePrefix);
  setNodeInput(workflow, roleMap.save_image_node, ["filename_prefix"], savePrefix);

  return workflow;
}
