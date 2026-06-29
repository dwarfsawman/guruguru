import { createHash, randomInt } from "node:crypto";
import type { GenerationRequest } from "../shared/types";

type JsonObject = Record<string, unknown>;

export interface PatchContext {
  projectId: string;
  roundIndex: number;
  request: GenerationRequest;
  uploadedImageName?: string | null;
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
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
  }

  const savePrefix = `guruguru/${context.projectId}/round_${String(context.roundIndex).padStart(3, "0")}`;
  setRolePath(workflow, roleMap.save_prefix_input, savePrefix);
  setNodeInput(workflow, roleMap.save_image_node, ["filename_prefix"], savePrefix);

  return workflow;
}

export function normalizeRoleMap(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error("role map must be a JSON object");
  }
  return value;
}

export function ensureWorkflowObject(value: unknown): Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error("workflow JSON must be an API-format JSON object");
  }
  return value;
}

function setRolePath(workflow: JsonObject, rawPath: unknown, value: unknown): boolean {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return false;
  }

  const path = rawPath.split(".").filter(Boolean);
  if (path.length < 2) {
    throw new Error(`Invalid role map path: ${rawPath}`);
  }

  let cursor: unknown = workflow;
  for (const part of path.slice(0, -1)) {
    if (!isObject(cursor) || !(part in cursor)) {
      throw new Error(`Role map path was not found: ${rawPath}`);
    }
    cursor = cursor[part];
  }

  if (!isObject(cursor)) {
    throw new Error(`Role map path does not resolve to an object: ${rawPath}`);
  }

  cursor[path[path.length - 1]!] = value;
  return true;
}

function setNodeInput(workflow: JsonObject, rawNodeId: unknown, candidateInputs: string[], value: unknown): boolean {
  if (typeof rawNodeId !== "string" || rawNodeId.trim() === "") {
    return false;
  }

  const node = workflow[rawNodeId];
  if (!isObject(node)) {
    throw new Error(`Role map node was not found: ${rawNodeId}`);
  }

  if (!isObject(node.inputs)) {
    node.inputs = {};
  }

  const inputs = node.inputs as JsonObject;
  for (const inputName of candidateInputs) {
    if (inputName in inputs) {
      inputs[inputName] = value;
      return true;
    }
  }

  inputs[candidateInputs[0]!] = value;
  return true;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}
