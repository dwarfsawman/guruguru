import type { GenerationRequest } from "../shared/types";
import { nodeIdFromRolePath } from "../shared/workflowRolePath";
import {
  type JsonObject,
  findNodeIdByClass,
  findNodeIdByExactClass,
  findNodeIdWithInput,
  findVaeConnection,
  getNodeInput,
  isConnection,
  nextNodeId,
  nodeClassIncludes,
  positiveInteger,
  setNodeInput,
  setRolePath,
  stringRole
} from "./workflowGraph";

const GENERATED_MASK_CHANNEL = "red";

export function patchImg2ImgLatentPath(
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
  const resizedImageConnection = [addImageScaleNode(workflow, imageConnection, request.width, request.height, "GURUGURU img2img Resize"), 0];
  setRolePath(workflow, roleMap.vae_encode_image_input, resizedImageConnection);
  setNodeInput(workflow, vaeEncodeNodeId, ["pixels", "image"], resizedImageConnection);
  setNodeInput(workflow, vaeEncodeNodeId, ["vae"], findVaeConnection(workflow));

  const latentConnection = [vaeEncodeNodeId, 0];
  const batchedLatentConnection = repeatLatentForBatchSize(workflow, roleMap, latentConnection, request.batchSize);
  setRolePath(workflow, roleMap.ksampler_latent_image_input, batchedLatentConnection);
  setNodeInput(workflow, ksamplerNodeId, ["latent_image"], batchedLatentConnection);
}

export function patchInpaintLatentPath(
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
  const resizedImageConnection = resizeImageForInpaint(workflow, imageConnection, request);
  const baseMaskConnection = [loadMaskNodeId, 0];
  const resizedMaskConnection = resizeMaskForInpaint(workflow, baseMaskConnection, request);
  const padding = Number.isFinite(inpaint.onlyMaskedPadding)
    ? Math.max(0, Math.trunc(inpaint.onlyMaskedPadding))
    : 32;
  // The grown mask gives the sampler a slightly larger noise region for context.
  const grownMaskConnection = padding > 0
    ? [addGrowMaskNode(workflow, resizedMaskConnection, padding), 0]
    : resizedMaskConnection;
  // The paste-back composite uses the original (non-grown) mask so generated content
  // is only written back where the user actually painted, avoiding gray bleed into padding.
  const compositeMaskConnection = resizedMaskConnection;
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
        resizedImageConnection,
        grownMaskConnection,
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
    setNodeInput(workflow, vaeEncodeNodeId, ["pixels", "image"], resizedImageConnection);
    setNodeInput(workflow, vaeEncodeNodeId, ["vae"], vaeConnection);
    latentConnection = [addSetLatentNoiseMaskNode(workflow, [vaeEncodeNodeId, 0], grownMaskConnection), 0];
    latentConnection = repeatLatentForBatchSize(workflow, roleMap, latentConnection, request.batchSize);
  } else if (inpaint.maskedContent === "latent_noise") {
    const emptyLatentConnection = [
      addEmptyLatentImageNode(workflow, request.width, request.height, request.batchSize),
      0
    ];
    latentConnection = [addSetLatentNoiseMaskNode(workflow, emptyLatentConnection, grownMaskConnection), 0];
  } else {
    latentConnection = [
      addEmptyLatentImageNode(workflow, request.width, request.height, request.batchSize),
      0
    ];
  }

  setRolePath(workflow, roleMap.ksampler_latent_image_input, latentConnection);
  setNodeInput(workflow, ksamplerNodeId, ["latent_image"], latentConnection);
  patchSaveImageForInpaintComposite(workflow, roleMap, resizedImageConnection, compositeMaskConnection);
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

function resizeImageForInpaint(workflow: JsonObject, imageConnection: unknown[], request: GenerationRequest): unknown[] {
  if (request.inpaint?.maskWidth === positiveInteger(request.width) && request.inpaint.maskHeight === positiveInteger(request.height)) {
    return imageConnection;
  }
  return [addImageScaleNode(workflow, imageConnection, request.width, request.height, "GURUGURU Inpaint Resize"), 0];
}

function resizeMaskForInpaint(workflow: JsonObject, maskConnection: unknown[], request: GenerationRequest): unknown[] {
  if (request.inpaint?.maskWidth === positiveInteger(request.width) && request.inpaint.maskHeight === positiveInteger(request.height)) {
    return maskConnection;
  }

  const maskImageConnection = [addMaskToImageNode(workflow, maskConnection), 0];
  const resizedMaskImageConnection = [
    addImageScaleNode(workflow, maskImageConnection, request.width, request.height, "GURUGURU Inpaint Mask Resize"),
    0
  ];
  return [addImageToMaskNode(workflow, resizedMaskImageConnection), 0];
}

function addImageScaleNode(
  workflow: JsonObject,
  imageConnection: unknown[],
  width: number,
  height: number,
  title: string
): string {
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
      title
    }
  };
  return nodeId;
}

function addMaskToImageNode(workflow: JsonObject, maskConnection: unknown[]): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      mask: maskConnection
    },
    class_type: "MaskToImage",
    _meta: {
      title: "GURUGURU Inpaint Mask Image"
    }
  };
  return nodeId;
}

function addImageToMaskNode(workflow: JsonObject, imageConnection: unknown[]): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      image: imageConnection,
      channel: GENERATED_MASK_CHANNEL
    },
    class_type: "ImageToMask",
    _meta: {
      title: "GURUGURU Inpaint Scaled Mask"
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
      width: positiveInteger(width),
      height: positiveInteger(height),
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
