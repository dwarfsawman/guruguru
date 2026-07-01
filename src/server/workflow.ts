import { createHash, randomInt } from "node:crypto";
import type { GenerationRequest } from "../shared/types";

type JsonObject = Record<string, unknown>;
const GENERATED_MASK_CHANNEL = "red";

export interface PatchContext {
  projectId: string;
  roundIndex: number;
  batchIndex?: number | null;
  request: GenerationRequest;
  uploadedImageName?: string | null;
  uploadedMaskName?: string | null;
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

function patchImg2ImgLatentPath(
  workflow: JsonObject,
  roleMap: Record<string, unknown>,
  uploadedImageName: string,
  request: GenerationRequest
) {
  const loadImageNodeId =
    stringRole(roleMap.load_image_node) ??
    nodeIdFromRolePath(roleMap.load_image_input) ??
    findNodeIdByExactClass(workflow, "LoadImage") ??
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
  const resizedImageConnection = [addImageScaleNode(workflow, imageConnection, request.width, request.height), 0];
  setRolePath(workflow, roleMap.vae_encode_image_input, resizedImageConnection);
  setNodeInput(workflow, vaeEncodeNodeId, ["pixels", "image"], resizedImageConnection);
  setNodeInput(workflow, vaeEncodeNodeId, ["vae"], findVaeConnection(workflow));

  const latentConnection = [vaeEncodeNodeId, 0];
  const batchedLatentConnection = repeatLatentForBatchSize(workflow, roleMap, latentConnection, request.batchSize);
  setRolePath(workflow, roleMap.ksampler_latent_image_input, batchedLatentConnection);
  setNodeInput(workflow, ksamplerNodeId, ["latent_image"], batchedLatentConnection);
}

function patchInpaintLatentPath(
  workflow: JsonObject,
  roleMap: Record<string, unknown>,
  uploadedImageName: string,
  uploadedMaskName: string,
  request: GenerationRequest
) {
  const inpaint = request.inpaint;
  if (!inpaint) {
    return;
  }

  const loadImageNodeId =
    stringRole(roleMap.load_image_node) ??
    nodeIdFromRolePath(roleMap.load_image_input) ??
    findNodeIdByExactClass(workflow, "LoadImage") ??
    addLoadImageNode(workflow, uploadedImageName);
  setNodeInput(workflow, loadImageNodeId, ["image"], uploadedImageName);

  const loadMaskNodeId =
    stringRole(roleMap.load_image_mask_node) ??
    nodeIdFromRolePath(roleMap.load_image_mask_input) ??
    findNodeIdByExactClass(workflow, "LoadImageMask") ??
    addLoadImageMaskNode(workflow, uploadedMaskName);
  setNodeInput(workflow, loadMaskNodeId, ["image"], uploadedMaskName);
  setNodeInput(workflow, loadMaskNodeId, ["channel"], GENERATED_MASK_CHANNEL);

  const imageConnection = [loadImageNodeId, 0];
  const baseMaskConnection = [loadMaskNodeId, 0];
  const padding = Number.isFinite(inpaint.onlyMaskedPadding)
    ? Math.max(0, Math.trunc(inpaint.onlyMaskedPadding))
    : 32;
  const maskConnection = padding > 0
    ? [addGrowMaskNode(workflow, baseMaskConnection, padding), 0]
    : baseMaskConnection;
  const vaeConnection = findVaeConnection(workflow);

  const ksamplerNodeId =
    stringRole(roleMap.ksampler_node) ??
    nodeIdFromRolePath(roleMap.ksampler_latent_image_input) ??
    findNodeIdWithInput(workflow, "latent_image") ??
    findNodeIdByClass(workflow, ["KSampler", "SamplerCustomAdvanced"]);
  if (!ksamplerNodeId) {
    throw new Error("inpaint workflow requires a sampler node with a latent_image input");
  }

  // A1111 masked-content options are mapped to ComfyUI core latent strategies here;
  // they are intentionally compatible behaviors, not a complete A1111 clone.
  let latentConnection: unknown[];
  if (inpaint.maskedContent === "fill") {
    latentConnection = [
      configureVaeEncodeForInpaintNode(
        workflow,
        findNodeIdByExactClass(workflow, "VAEEncodeForInpaint") ?? addVaeEncodeForInpaintNode(workflow, vaeConnection),
        imageConnection,
        maskConnection,
        vaeConnection
      ),
      0
    ];
    latentConnection = repeatLatentForBatchSize(workflow, roleMap, latentConnection, request.batchSize);
  } else if (inpaint.maskedContent === "original") {
    const vaeEncodeNodeId =
      stringRole(roleMap.vae_encode_node) ??
      nodeIdFromRolePath(roleMap.vae_encode_image_input) ??
      findNodeIdByExactClass(workflow, "VAEEncode") ??
      addVaeEncodeNode(workflow, vaeConnection);
    setNodeInput(workflow, vaeEncodeNodeId, ["pixels", "image"], imageConnection);
    setNodeInput(workflow, vaeEncodeNodeId, ["vae"], vaeConnection);
    latentConnection = [addSetLatentNoiseMaskNode(workflow, [vaeEncodeNodeId, 0], maskConnection), 0];
    latentConnection = repeatLatentForBatchSize(workflow, roleMap, latentConnection, request.batchSize);
  } else if (inpaint.maskedContent === "latent_noise") {
    const emptyLatentConnection = [
      addEmptyLatentImageNode(workflow, request.width, request.height, request.batchSize),
      0
    ];
    latentConnection = [addSetLatentNoiseMaskNode(workflow, emptyLatentConnection, maskConnection), 0];
  } else {
    latentConnection = [
      addEmptyLatentImageNode(workflow, request.width, request.height, request.batchSize),
      0
    ];
  }

  setRolePath(workflow, roleMap.ksampler_latent_image_input, latentConnection);
  setNodeInput(workflow, ksamplerNodeId, ["latent_image"], latentConnection);
  patchSaveImageForInpaintComposite(workflow, roleMap, imageConnection, maskConnection);
}

function repeatLatentForBatchSize(
  workflow: JsonObject,
  roleMap: Record<string, unknown>,
  latentConnection: unknown[],
  batchSize: number
): unknown[] {
  const amount = Number.isFinite(batchSize) ? Math.max(1, Math.trunc(batchSize)) : 1;
  if (amount <= 1) {
    return latentConnection;
  }

  const repeatNodeId = findRepeatLatentBatchNode(workflow, roleMap) ?? addRepeatLatentBatchNode(workflow);
  setRolePath(workflow, roleMap.repeat_latent_batch_samples_input, latentConnection);
  setRolePath(workflow, roleMap.repeat_latent_batch_amount_input ?? repeatLatentAmountPath(workflow, roleMap), amount);
  setNodeInput(workflow, repeatNodeId, ["samples"], latentConnection);
  setNodeInput(workflow, repeatNodeId, ["amount"], amount);
  return [repeatNodeId, 0];
}

function findRepeatLatentBatchNode(workflow: JsonObject, roleMap: Record<string, unknown>): string | null {
  const roleNodeId =
    stringRole(roleMap.repeat_latent_batch_node) ??
    nodeIdFromRolePath(roleMap.repeat_latent_batch_samples_input) ??
    nodeIdFromRolePath(roleMap.repeat_latent_batch_amount_input);
  if (roleNodeId && nodeClassIncludes(workflow, roleNodeId, ["RepeatLatentBatch"])) {
    return roleNodeId;
  }

  const batchSizeNodeId = nodeIdFromRolePath(roleMap.batch_size_input);
  if (batchSizeNodeId && nodeClassIncludes(workflow, batchSizeNodeId, ["RepeatLatentBatch"])) {
    return batchSizeNodeId;
  }

  return findNodeIdByClass(workflow, ["RepeatLatentBatch"]);
}

function repeatLatentAmountPath(workflow: JsonObject, roleMap: Record<string, unknown>): unknown {
  const batchSizeNodeId = nodeIdFromRolePath(roleMap.batch_size_input);
  if (batchSizeNodeId && nodeClassIncludes(workflow, batchSizeNodeId, ["RepeatLatentBatch"])) {
    return roleMap.batch_size_input;
  }
  return undefined;
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

function addImageScaleNode(workflow: JsonObject, imageConnection: unknown[], width: number, height: number): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      image: imageConnection,
      upscale_method: "lanczos",
      width: positiveInteger(width),
      height: positiveInteger(height),
      crop: "disabled"
    },
    class_type: "ImageScale",
    _meta: {
      title: "GURUGURU img2img Resize"
    }
  };
  return nodeId;
}

function addLoadImageMaskNode(workflow: JsonObject, uploadedMaskName: string): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      image: uploadedMaskName,
      // ComfyUI's LoadImageMask alpha output is inverted; generated masks are white-on-transparent.
      channel: GENERATED_MASK_CHANNEL
    },
    class_type: "LoadImageMask",
    _meta: {
      title: "GURUGURU Inpaint Mask"
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

function addVaeEncodeForInpaintNode(workflow: JsonObject, vaeConnection: unknown[]): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      pixels: null,
      vae: vaeConnection,
      mask: null,
      grow_mask_by: 0
    },
    class_type: "VAEEncodeForInpaint",
    _meta: {
      title: "GURUGURU Inpaint Encode"
    }
  };
  return nodeId;
}

function configureVaeEncodeForInpaintNode(
  workflow: JsonObject,
  nodeId: string,
  imageConnection: unknown[],
  maskConnection: unknown[],
  vaeConnection: unknown[]
): string {
  setNodeInput(workflow, nodeId, ["pixels", "image"], imageConnection);
  setNodeInput(workflow, nodeId, ["mask"], maskConnection);
  setNodeInput(workflow, nodeId, ["vae"], vaeConnection);
  setNodeInput(workflow, nodeId, ["grow_mask_by"], 0);
  return nodeId;
}

function addRepeatLatentBatchNode(workflow: JsonObject): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      samples: null,
      amount: 1
    },
    class_type: "RepeatLatentBatch",
    _meta: {
      title: "GURUGURU img2img Batch"
    }
  };
  return nodeId;
}

function addGrowMaskNode(workflow: JsonObject, maskConnection: unknown[], padding: number): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      mask: maskConnection,
      expand: padding,
      tapered_corners: true
    },
    class_type: "GrowMask",
    _meta: {
      title: "GURUGURU Inpaint Padding"
    }
  };
  return nodeId;
}

function addSetLatentNoiseMaskNode(workflow: JsonObject, samplesConnection: unknown[], maskConnection: unknown[]): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      samples: samplesConnection,
      mask: maskConnection
    },
    class_type: "SetLatentNoiseMask",
    _meta: {
      title: "GURUGURU Inpaint Noise Mask"
    }
  };
  return nodeId;
}

function addEmptyLatentImageNode(workflow: JsonObject, width: number, height: number, batchSize: number): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      width,
      height,
      batch_size: Math.max(1, Math.trunc(batchSize))
    },
    class_type: "EmptyLatentImage",
    _meta: {
      title: "GURUGURU Inpaint Empty Latent"
    }
  };
  return nodeId;
}

function patchSaveImageForInpaintComposite(
  workflow: JsonObject,
  roleMap: Record<string, unknown>,
  originalImageConnection: unknown[],
  maskConnection: unknown[]
) {
  const saveNodeId =
    stringRole(roleMap.save_image_node) ??
    nodeIdFromRolePath(roleMap.save_prefix_input) ??
    findNodeIdByExactClass(workflow, "SaveImage");
  if (!saveNodeId) {
    throw new Error("inpaint workflow requires a SaveImage node");
  }

  const generatedImageConnection = getNodeInput(workflow, saveNodeId, ["images", "image"]);
  if (!isConnection(generatedImageConnection)) {
    throw new Error("inpaint workflow requires the SaveImage image input to be connected");
  }

  const compositeNodeId = nextNodeId(workflow);
  workflow[compositeNodeId] = {
    inputs: {
      destination: originalImageConnection,
      source: [...generatedImageConnection],
      x: 0,
      y: 0,
      resize_source: false,
      mask: maskConnection
    },
    class_type: "ImageCompositeMasked",
    _meta: {
      title: "GURUGURU Inpaint Paste Back"
    }
  };
  setNodeInput(workflow, saveNodeId, ["images", "image"], [compositeNodeId, 0]);
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

function getNodeInput(workflow: JsonObject, rawNodeId: unknown, candidateInputs: string[]): unknown {
  if (typeof rawNodeId !== "string" || rawNodeId.trim() === "") {
    return undefined;
  }

  const node = workflow[rawNodeId];
  if (!isObject(node) || !isObject(node.inputs)) {
    return undefined;
  }

  for (const inputName of candidateInputs) {
    if (inputName in node.inputs) {
      return node.inputs[inputName];
    }
  }
  return undefined;
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

function findNodeIdByExactClass(workflow: JsonObject, className: string): string | null {
  for (const [nodeId, rawNode] of Object.entries(workflow)) {
    if (!isObject(rawNode) || typeof rawNode.class_type !== "string") {
      continue;
    }
    if (rawNode.class_type === className) {
      return nodeId;
    }
  }
  return null;
}

function nodeClassIncludes(workflow: JsonObject, nodeId: string, classFragments: string[]): boolean {
  const node = workflow[nodeId];
  if (!isObject(node) || typeof node.class_type !== "string") {
    return false;
  }
  const classType = node.class_type.toLowerCase();
  return classFragments.some((fragment) => classType.includes(fragment.toLowerCase()));
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

function positiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
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
