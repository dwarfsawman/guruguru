import { type Json as JsonObject, isJsonObject } from "./json";

interface WorkflowNode {
  id: string;
  inputs: JsonObject;
  classType: string;
  title: string;
}

export function inferRoleMap(workflowJson: unknown): JsonObject {
  const nodes = workflowNodes(workflowJson);
  const roleMap: JsonObject = {};

  const textNodes = nodes.filter((node) => isPromptTextNode(node));
  const negativePrompt = textNodes.find((node) => hasRoleHint(node, ["negative", "ネガティブ"]));
  const positivePrompt =
    textNodes.find((node) => node !== negativePrompt && hasRoleHint(node, ["positive", "ポジティブ"])) ??
    textNodes.find((node) => node !== negativePrompt);

  if (positivePrompt) {
    roleMap.positive_prompt_node = positivePrompt.id;
  }
  if (negativePrompt) {
    roleMap.negative_prompt_node = negativePrompt.id;
  }

  addInputPath(roleMap, "seed_input", findInput(nodes, ["seed", "noise_seed"], ["KSampler", "RandomNoise"]));
  addInputPath(roleMap, "cfg_input", findInput(nodes, ["cfg"], ["KSampler", "CFGGuider"]));
  addInputPath(roleMap, "steps_input", findInput(nodes, ["steps"], ["KSampler", "BasicScheduler"]));
  addInputPath(roleMap, "denoise_input", findInput(nodes, ["denoise"], ["KSampler", "BasicScheduler"]));
  const latentBatchSize = findInput(nodes, ["batch_size"], ["EmptyLatent", "EmptySD3Latent"]);
  const repeatLatentBatchAmount = findInput(nodes, ["amount"], ["RepeatLatentBatch"]);
  addInputPath(roleMap, "batch_size_input", latentBatchSize ?? repeatLatentBatchAmount);
  addInputPath(roleMap, "repeat_latent_batch_amount_input", repeatLatentBatchAmount);
  addInputPath(roleMap, "sampler_input", findInput(nodes, ["sampler_name", "sampler"], ["KSampler", "KSamplerSelect"]));
  addInputPath(roleMap, "scheduler_input", findInput(nodes, ["scheduler"], ["KSampler", "BasicScheduler"]));
  addInputPath(roleMap, "ksampler_latent_image_input", findInput(nodes, ["latent_image"], ["KSampler"]));
  addInputPath(roleMap, "repeat_latent_batch_samples_input", findInput(nodes, ["samples"], ["RepeatLatentBatch"]));
  addInputPath(roleMap, "width_input", findInput(nodes, ["width"], ["EmptyLatent", "EmptySD3Latent"]));
  addInputPath(roleMap, "height_input", findInput(nodes, ["height"], ["EmptyLatent", "EmptySD3Latent"]));
  addInputPath(roleMap, "load_image_input", findInput(nodes, ["image"], ["LoadImage"]));
  const vaeEncode = findNode(nodes, ["VAEEncode"]);
  if (vaeEncode) {
    roleMap.vae_encode_node = vaeEncode.id;
  }
  const repeatLatentBatch = findNode(nodes, ["RepeatLatentBatch"]);
  if (repeatLatentBatch) {
    roleMap.repeat_latent_batch_node = repeatLatentBatch.id;
  }
  addInputPath(roleMap, "vae_encode_image_input", findInput(nodes, ["pixels", "image"], ["VAEEncode"]));
  const saveImage = findNode(nodes, ["SaveImage"]);
  if (saveImage) {
    roleMap.save_image_node = saveImage.id;
  }
  addInputPath(roleMap, "save_prefix_input", findInput(nodes, ["filename_prefix"], ["SaveImage"]));

  return roleMap;
}

export function validateRoleMapReferences(workflowJson: unknown, roleMap: unknown): void {
  if (!isJsonObject(workflowJson)) {
    throw new Error("workflow JSON must be an API-format JSON object");
  }
  if (!isJsonObject(roleMap)) {
    throw new Error("role map must be a JSON object");
  }

  for (const [key, value] of Object.entries(roleMap)) {
    if (typeof value !== "string" || value.trim() === "") {
      continue;
    }

    if (key.endsWith("_node")) {
      validateNodeReference(workflowJson, key, value);
      continue;
    }

    if (key.endsWith("_input")) {
      validatePathReference(workflowJson, key, value);
    }
  }
}

function workflowNodes(workflowJson: unknown): WorkflowNode[] {
  if (!isJsonObject(workflowJson)) {
    return [];
  }

  return Object.entries(workflowJson)
    .flatMap(([id, rawNode]) => {
      if (!isJsonObject(rawNode)) {
        return [];
      }

      return [{
        id,
        inputs: isJsonObject(rawNode.inputs) ? rawNode.inputs : {},
        classType: typeof rawNode.class_type === "string" ? rawNode.class_type : "",
        title: nodeTitle(rawNode)
      }];
    })
    .sort((a, b) => compareNodeIds(a.id, b.id));
}

function nodeTitle(node: JsonObject): string {
  const meta = node._meta;
  if (!isJsonObject(meta) || typeof meta.title !== "string") {
    return "";
  }
  return meta.title;
}

function isPromptTextNode(node: WorkflowNode): boolean {
  if (!("text" in node.inputs)) {
    return false;
  }

  const className = node.classType.toLowerCase();
  const label = `${node.title} ${node.classType}`.toLowerCase();
  return className.includes("text") || className.includes("prompt") || label.includes("prompt");
}

function hasRoleHint(node: WorkflowNode, hints: string[]): boolean {
  const label = `${node.title} ${node.classType}`.toLowerCase();
  return hints.some((hint) => label.includes(hint.toLowerCase()));
}

function findInput(nodes: WorkflowNode[], inputNames: string[], preferredClassFragments: string[]): { node: WorkflowNode; inputName: string } | null {
  for (const classFragment of preferredClassFragments) {
    const match = findInputInNodes(
      nodes.filter((node) => node.classType.includes(classFragment)),
      inputNames
    );
    if (match) {
      return match;
    }
  }

  return findInputInNodes(nodes, inputNames);
}

function findInputInNodes(nodes: WorkflowNode[], inputNames: string[]): { node: WorkflowNode; inputName: string } | null {
  for (const node of nodes) {
    for (const inputName of inputNames) {
      if (inputName in node.inputs) {
        return { node, inputName };
      }
    }
  }
  return null;
}

function findNode(nodes: WorkflowNode[], preferredClassFragments: string[]): WorkflowNode | null {
  for (const classFragment of preferredClassFragments) {
    const match = nodes.find((node) => node.classType.includes(classFragment));
    if (match) {
      return match;
    }
  }
  return null;
}

function addInputPath(roleMap: JsonObject, key: string, match: { node: WorkflowNode; inputName: string } | null) {
  if (match) {
    roleMap[key] = `${match.node.id}.inputs.${match.inputName}`;
  }
}

function validateNodeReference(workflow: JsonObject, key: string, rawNodeId: string): void {
  const node = workflow[rawNodeId];
  if (!isJsonObject(node)) {
    throw new Error(`Role map node was not found: ${rawNodeId} (${key})`);
  }
}

function validatePathReference(workflow: JsonObject, key: string, rawPath: string): void {
  const path = rawPath.split(".").filter(Boolean);
  if (path.length < 2) {
    throw new Error(`Invalid role map path: ${rawPath} (${key})`);
  }

  let cursor: unknown = workflow;
  for (const part of path.slice(0, -1)) {
    if (!isJsonObject(cursor) || !(part in cursor)) {
      throw new Error(`Role map path was not found: ${rawPath} (${key})`);
    }
    cursor = cursor[part];
  }

  if (!isJsonObject(cursor)) {
    throw new Error(`Role map path does not resolve to an object: ${rawPath} (${key})`);
  }
}

function compareNodeIds(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}
