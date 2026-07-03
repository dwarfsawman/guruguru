import type { PatchContext } from "./workflow";
import {
  type JsonObject,
  findNodeIdByExactClass,
  getNodeInput,
  isConnection,
  isObject,
  setNodeInput
} from "./workflowGraph";

// Patches a "unified switch" template (Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.md):
// the template statically contains every branch (txt2img / img2img / inpaint / ControlNet on/off)
// wired through ComfySwitchNode nodes, and a generation mode is selected purely by writing the
// PrimitiveBoolean values that drive those switches. Unlike the dynamic-patch path
// (workflowInpaint.ts / workflowControlNet.ts), this never adds nodes or rewires connections, so
// there is no node-role inference to go wrong -- every target node is resolved structurally from
// the sampler outward on each call.
//
// ComfyUI validates LoadImage/LoadImageMask filenames graph-wide even on branches that lazy
// evaluation will never execute, so unused image inputs must still name a file that exists on the
// ComfyUI side. PatchContext.dummyImageName (uploaded via ensureDummyComfyImage) fills that role.

const MASK_CHANNEL = "red";

export function isUnifiedSwitchWorkflow(workflow: JsonObject): boolean {
  return Object.values(workflow).some(
    (node) => isObject(node) && node.class_type === "ComfySwitchNode"
  );
}

interface UnifiedSwitchRoles {
  samplerNodeId: string;
  useParentImageBoolNodeId: string;
  useMaskBoolNodeId: string | null;
  useControlNetBoolNodeId: string | null;
  emptyLatentNodeId: string;
  vaeEncodeNodeId: string;
  parentLoadImageNodeId: string;
  loadImageMaskNodeId: string | null;
  txt2imgSchedulerNodeId: string | null;
  img2imgSchedulerNodeId: string | null;
  noiseNodeId: string | null;
  guiderNodeId: string | null;
  samplerSelectNodeId: string | null;
  positivePromptNodeId: string | null;
  negativePromptNodeId: string | null;
  controlNetApplyNodeId: string | null;
  controlLoadImageNodeId: string | null;
  saveImageNodeId: string | null;
}

export function patchUnifiedSwitchWorkflow(
  workflow: JsonObject,
  context: PatchContext,
  savePrefix: string
): JsonObject {
  const { request } = context;
  const roles = resolveUnifiedSwitchRoles(workflow);

  const useParentImage = request.generationMode === "img2img" && Boolean(context.uploadedImageName);
  const useMask = useParentImage && Boolean(request.inpaint) && Boolean(context.uploadedMaskName);
  // generationMode "controlnet" feeds the parent image directly into the control-image slot;
  // an explicit pose attachment (request.controlnet) always wins over that behavior.
  const controlImageName = request.controlnet
    ? context.uploadedControlImageName ?? null
    : request.generationMode === "controlnet"
      ? context.uploadedImageName ?? null
      : null;
  const useControlNet = Boolean(controlImageName) && roles.useControlNetBoolNodeId !== null;

  if (useMask && request.inpaint && request.inpaint.maskedContent !== "original") {
    throw new Error(
      `unified switch workflow supports only maskedContent="original" (got "${request.inpaint.maskedContent}")`
    );
  }
  if (useMask && !roles.useMaskBoolNodeId) {
    throw new Error("unified switch workflow has no inpaint (mask) branch, but a mask was provided");
  }

  setNodeInput(workflow, roles.useParentImageBoolNodeId, ["value"], useParentImage);
  setNodeInput(workflow, roles.useMaskBoolNodeId, ["value"], useMask);
  setNodeInput(workflow, roles.useControlNetBoolNodeId, ["value"], useControlNet);

  // Every LoadImage/LoadImageMask must name an existing file even when its branch is switched
  // off (ComfyUI validates the whole graph); fall back to the pre-uploaded dummy image.
  const imageNameOrDummy = (name: string | null | undefined, slot: string): string => {
    if (name) {
      return name;
    }
    if (context.dummyImageName) {
      return context.dummyImageName;
    }
    throw new Error(`unified switch workflow requires a dummy image name for the unused ${slot} input`);
  };
  setNodeInput(
    workflow,
    roles.parentLoadImageNodeId,
    ["image"],
    imageNameOrDummy(useParentImage ? context.uploadedImageName : null, "parent image")
  );
  if (roles.loadImageMaskNodeId) {
    setNodeInput(
      workflow,
      roles.loadImageMaskNodeId,
      ["image"],
      imageNameOrDummy(useMask ? context.uploadedMaskName : null, "mask")
    );
    setNodeInput(workflow, roles.loadImageMaskNodeId, ["channel"], MASK_CHANNEL);
  }
  if (roles.controlLoadImageNodeId) {
    setNodeInput(
      workflow,
      roles.controlLoadImageNodeId,
      ["image"],
      imageNameOrDummy(useControlNet ? controlImageName : null, "control image")
    );
  }

  setNodeInput(workflow, roles.positivePromptNodeId, ["text"], request.prompt);
  setNodeInput(workflow, roles.negativePromptNodeId, ["text"], request.negativePrompt);
  setNodeInput(workflow, roles.noiseNodeId, ["noise_seed", "seed"], request.seed);
  setNodeInput(workflow, roles.guiderNodeId, ["cfg"], request.cfg);
  setNodeInput(workflow, roles.samplerSelectNodeId, ["sampler_name"], request.sampler);

  // The txt2img scheduler always runs at denoise=1; the user-controlled denoise applies only to
  // the img2img-side scheduler (denoise cannot be switched as a widget value, hence two nodes).
  setNodeInput(workflow, roles.txt2imgSchedulerNodeId, ["steps"], request.steps);
  setNodeInput(workflow, roles.txt2imgSchedulerNodeId, ["scheduler"], request.scheduler);
  setNodeInput(workflow, roles.txt2imgSchedulerNodeId, ["denoise"], 1);
  setNodeInput(workflow, roles.img2imgSchedulerNodeId, ["steps"], request.steps);
  setNodeInput(workflow, roles.img2imgSchedulerNodeId, ["scheduler"], request.scheduler);
  setNodeInput(workflow, roles.img2imgSchedulerNodeId, ["denoise"], request.denoise);

  setNodeInput(workflow, roles.emptyLatentNodeId, ["width"], request.width);
  setNodeInput(workflow, roles.emptyLatentNodeId, ["height"], request.height);
  setNodeInput(workflow, roles.emptyLatentNodeId, ["batch_size"], request.batchSize);

  if (request.controlnet && roles.controlNetApplyNodeId) {
    setNodeInput(workflow, roles.controlNetApplyNodeId, ["strength"], request.controlnet.strength);
    setNodeInput(workflow, roles.controlNetApplyNodeId, ["start_percent"], request.controlnet.startPercent);
    setNodeInput(workflow, roles.controlNetApplyNodeId, ["end_percent"], request.controlnet.endPercent);
  }

  setNodeInput(workflow, roles.saveImageNodeId, ["filename_prefix"], savePrefix);

  return workflow;
}

// Resolves every patch target by walking the graph from the sampler outward, so the roles hold
// for any re-export of the reference workflow regardless of node ids or titles.
export function resolveUnifiedSwitchRoles(workflow: JsonObject): UnifiedSwitchRoles {
  const samplerNodeId = findSamplerNodeId(workflow);
  if (!samplerNodeId) {
    throw new Error("unified switch workflow requires a sampler node with a latent_image input");
  }

  // latent path: sampler.latent_image -> latent switch -> (on_false) empty latent
  //                                                    -> (on_true) [mask switch ->] VAEEncode
  const latentSwitchNodeId = connectedNodeId(workflow, samplerNodeId, ["latent_image"]);
  if (!latentSwitchNodeId || !isClass(workflow, latentSwitchNodeId, "ComfySwitchNode")) {
    throw new Error("unified switch workflow: the sampler's latent_image must be fed by a ComfySwitchNode");
  }
  const useParentImageBoolNodeId = requireBoolNode(workflow, latentSwitchNodeId, "latent switch");
  const emptyLatentNodeId = connectedNodeId(workflow, latentSwitchNodeId, ["on_false"]);
  if (!emptyLatentNodeId) {
    throw new Error("unified switch workflow: the latent switch's on_false must connect to an empty-latent node");
  }

  const latentTrueNodeId = connectedNodeId(workflow, latentSwitchNodeId, ["on_true"]);
  if (!latentTrueNodeId) {
    throw new Error("unified switch workflow: the latent switch's on_true must connect to the img2img latent path");
  }
  let useMaskBoolNodeId: string | null = null;
  let loadImageMaskNodeId: string | null = null;
  let vaeEncodeNodeId: string | null;
  if (isClass(workflow, latentTrueNodeId, "ComfySwitchNode")) {
    const maskSwitchNodeId = latentTrueNodeId;
    useMaskBoolNodeId = requireBoolNode(workflow, maskSwitchNodeId, "mask switch");
    vaeEncodeNodeId = connectedNodeId(workflow, maskSwitchNodeId, ["on_false"]);
    const noiseMaskNodeId = connectedNodeId(workflow, maskSwitchNodeId, ["on_true"]);
    if (noiseMaskNodeId) {
      loadImageMaskNodeId = connectedNodeId(workflow, noiseMaskNodeId, ["mask"]);
    }
  } else {
    vaeEncodeNodeId = latentTrueNodeId;
  }
  if (!vaeEncodeNodeId || !isClass(workflow, vaeEncodeNodeId, "VAEEncode")) {
    throw new Error("unified switch workflow: the img2img latent path must contain a VAEEncode node");
  }
  const parentLoadImageNodeId = connectedNodeId(workflow, vaeEncodeNodeId, ["pixels"]);
  if (!parentLoadImageNodeId) {
    throw new Error("unified switch workflow: the VAEEncode pixels input must connect to the parent LoadImage node");
  }

  // sigmas path: sampler.sigmas -> sigmas switch -> (on_false) txt2img scheduler
  //                                              -> (on_true) img2img scheduler
  let txt2imgSchedulerNodeId: string | null = null;
  let img2imgSchedulerNodeId: string | null = null;
  const sigmasNodeId = connectedNodeId(workflow, samplerNodeId, ["sigmas"]);
  if (sigmasNodeId && isClass(workflow, sigmasNodeId, "ComfySwitchNode")) {
    txt2imgSchedulerNodeId = connectedNodeId(workflow, sigmasNodeId, ["on_false"]);
    img2imgSchedulerNodeId = connectedNodeId(workflow, sigmasNodeId, ["on_true"]);
  } else if (sigmasNodeId) {
    txt2imgSchedulerNodeId = sigmasNodeId;
  }

  const noiseNodeId = connectedNodeId(workflow, samplerNodeId, ["noise"]);
  const samplerSelectNodeId = connectedNodeId(workflow, samplerNodeId, ["sampler"]);
  const guiderNodeId = connectedNodeId(workflow, samplerNodeId, ["guider"]);

  // conditioning path: guider.positive/negative -> controlnet switch -> (on_false) CLIPTextEncode
  //                                                                  -> (on_true) ControlNetApplyAdvanced
  let useControlNetBoolNodeId: string | null = null;
  let positivePromptNodeId: string | null = null;
  let negativePromptNodeId: string | null = null;
  let controlNetApplyNodeId: string | null = null;
  let controlLoadImageNodeId: string | null = null;
  if (guiderNodeId) {
    const positiveSourceNodeId = connectedNodeId(workflow, guiderNodeId, ["positive"]);
    const negativeSourceNodeId = connectedNodeId(workflow, guiderNodeId, ["negative"]);
    if (positiveSourceNodeId && isClass(workflow, positiveSourceNodeId, "ComfySwitchNode")) {
      useControlNetBoolNodeId = requireBoolNode(workflow, positiveSourceNodeId, "controlnet switch");
      positivePromptNodeId = connectedNodeId(workflow, positiveSourceNodeId, ["on_false"]);
      controlNetApplyNodeId = connectedNodeId(workflow, positiveSourceNodeId, ["on_true"]);
      if (controlNetApplyNodeId) {
        controlLoadImageNodeId = connectedNodeId(workflow, controlNetApplyNodeId, ["image"]);
      }
    } else {
      positivePromptNodeId = positiveSourceNodeId;
    }
    negativePromptNodeId =
      negativeSourceNodeId && isClass(workflow, negativeSourceNodeId, "ComfySwitchNode")
        ? connectedNodeId(workflow, negativeSourceNodeId, ["on_false"])
        : negativeSourceNodeId;
  }

  return {
    samplerNodeId,
    useParentImageBoolNodeId,
    useMaskBoolNodeId,
    useControlNetBoolNodeId,
    emptyLatentNodeId,
    vaeEncodeNodeId,
    parentLoadImageNodeId,
    loadImageMaskNodeId,
    txt2imgSchedulerNodeId,
    img2imgSchedulerNodeId,
    noiseNodeId,
    guiderNodeId,
    samplerSelectNodeId,
    positivePromptNodeId,
    negativePromptNodeId,
    controlNetApplyNodeId,
    controlLoadImageNodeId,
    saveImageNodeId: findNodeIdByExactClass(workflow, "SaveImage")
  };
}

function findSamplerNodeId(workflow: JsonObject): string | null {
  for (const [nodeId, rawNode] of Object.entries(workflow)) {
    if (!isObject(rawNode) || !isObject(rawNode.inputs)) {
      continue;
    }
    if ("latent_image" in rawNode.inputs && typeof rawNode.class_type === "string" && rawNode.class_type !== "ComfySwitchNode") {
      return nodeId;
    }
  }
  return null;
}

function requireBoolNode(workflow: JsonObject, switchNodeId: string, label: string): string {
  const boolNodeId = connectedNodeId(workflow, switchNodeId, ["switch"]);
  if (!boolNodeId || !isClass(workflow, boolNodeId, "PrimitiveBoolean")) {
    throw new Error(`unified switch workflow: the ${label}'s switch input must be fed by a PrimitiveBoolean node`);
  }
  return boolNodeId;
}

function connectedNodeId(workflow: JsonObject, nodeId: string, inputNames: string[]): string | null {
  const connection = getNodeInput(workflow, nodeId, inputNames);
  if (!isConnection(connection)) {
    return null;
  }
  const sourceNodeId = connection[0];
  return typeof sourceNodeId === "string" && isObject(workflow[sourceNodeId]) ? sourceNodeId : null;
}

function isClass(workflow: JsonObject, nodeId: string, className: string): boolean {
  const node = workflow[nodeId];
  return isObject(node) && node.class_type === className;
}
