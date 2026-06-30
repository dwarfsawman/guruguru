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
    if (request.generationMode === "img2img") {
      patchImg2ImgLatentPath(workflow, roleMap, context.uploadedImageName);
    }
  }

  const savePrefix = `guruguru/${context.projectId}/round_${String(context.roundIndex).padStart(3, "0")}`;
  setRolePath(workflow, roleMap.save_prefix_input, savePrefix);
  setNodeInput(workflow, roleMap.save_image_node, ["filename_prefix"], savePrefix);

  return workflow;
}

function patchImg2ImgLatentPath(workflow: JsonObject, roleMap: Record<string, unknown>, uploadedImageName: string) {
  const loadImageNodeId =
    stringRole(roleMap.load_image_node) ??
    nodeIdFromRolePath(roleMap.load_image_input) ??
    findNodeIdByClass(workflow, ["LoadImage"]) ??
    addLoadImageNode(workflow, uploadedImageName);

  setNodeInput(workflow, loadImageNodeId, ["image"], uploadedImageName);

  const vaeEncodeNodeId =
    stringRole(roleMap.vae_encode_node) ??
    nodeIdFromRolePath(roleMap.vae_encode_image_input) ??
    findNodeIdByClass(workflow, ["VAEEncode"]) ??
    addVaeEncodeNode(workflow, findVaeConnection(workflow));

  const ksamplerNodeId =
    stringRole(roleMap.ksampler_node) ??
    nodeIdFromRolePath(roleMap.ksampler_latent_image_input) ??
    findNodeIdWithInput(workflow, "latent_image") ??
    findNodeIdByClass(workflow, ["KSampler", "SamplerCustomAdvanced"]);
  if (!ksamplerNodeId) {
    throw new Error("img2img workflow requires a sampler node with a latent_image input");
  }

  const imageConnection = [loadImageNodeId, 0];
  setRolePath(workflow, roleMap.vae_encode_image_input, imageConnection);
  setNodeInput(workflow, vaeEncodeNodeId, ["pixels", "image"], imageConnection);
  setNodeInput(workflow, vaeEncodeNodeId, ["vae"], findVaeConnection(workflow));

  const latentConnection = [vaeEncodeNodeId, 0];
  setRolePath(workflow, roleMap.ksampler_latent_image_input, latentConnection);
  setNodeInput(workflow, ksamplerNodeId, ["latent_image"], latentConnection);
}

function addLoadImageNode(workflow: JsonObject, uploadedImageName: string): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      image: uploadedImageName
    },
    class_type: "LoadImage",
    _meta: {
      title: "GURUGURU img2img Load Image"
    }
  };
  return nodeId;
}

function addVaeEncodeNode(workflow: JsonObject, vaeConnection: unknown[]): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      pixels: null,
      vae: vaeConnection
    },
    class_type: "VAEEncode",
    _meta: {
      title: "GURUGURU img2img VAE Encode"
    }
  };
  return nodeId;
}

function findVaeConnection(workflow: JsonObject): unknown[] {
  const vaeLoaderNodeId = findNodeIdByClass(workflow, ["VAELoader"]);
  if (vaeLoaderNodeId) {
    return [vaeLoaderNodeId, 0];
  }

  for (const rawNode of Object.values(workflow)) {
    if (!isObject(rawNode) || typeof rawNode.class_type !== "string" || !isObject(rawNode.inputs)) {
      continue;
    }
    if (!rawNode.class_type.toLowerCase().includes("vaedecode")) {
      continue;
    }
    const vae = rawNode.inputs.vae;
    if (isConnection(vae)) {
      return [...vae];
    }
  }

  for (const rawNode of Object.values(workflow)) {
    if (!isObject(rawNode) || !isObject(rawNode.inputs)) {
      continue;
    }
    const vae = rawNode.inputs.vae;
    if (isConnection(vae)) {
      return [...vae];
    }
  }

  throw new Error("img2img derivation requires an existing VAE connection or VAELoader node");
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

function stringRole(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nodeIdFromRolePath(rawPath: unknown): string | null {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return null;
  }
  return rawPath.split(".").filter(Boolean)[0] ?? null;
}

function findNodeIdByClass(workflow: JsonObject, classFragments: string[]): string | null {
  for (const [nodeId, rawNode] of Object.entries(workflow)) {
    if (!isObject(rawNode) || typeof rawNode.class_type !== "string") {
      continue;
    }
    const classType = rawNode.class_type.toLowerCase();
    if (classFragments.some((fragment) => classType.includes(fragment.toLowerCase()))) {
      return nodeId;
    }
  }
  return null;
}

function findNodeIdWithInput(workflow: JsonObject, inputName: string): string | null {
  for (const [nodeId, rawNode] of Object.entries(workflow)) {
    if (!isObject(rawNode) || !isObject(rawNode.inputs)) {
      continue;
    }
    if (inputName in rawNode.inputs) {
      return nodeId;
    }
  }
  return null;
}

function nextNodeId(workflow: JsonObject): string {
  const numericIds = Object.keys(workflow)
    .map((nodeId) => Number(nodeId))
    .filter((nodeId) => Number.isInteger(nodeId) && nodeId >= 0);
  if (numericIds.length > 0) {
    return String(Math.max(...numericIds) + 1);
  }

  let index = 1;
  while (`guruguru_${index}` in workflow) {
    index += 1;
  }
  return `guruguru_${index}`;
}

function isConnection(value: unknown): value is unknown[] {
  return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number";
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
