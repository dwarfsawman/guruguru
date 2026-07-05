import { test } from "node:test";
import assert from "node:assert/strict";
import { patchWorkflow, resolveSeed } from "./workflow.ts";
import type { GenerationRequest } from "../shared/types.ts";

// These are characterization tests: they pin the CURRENT behavior of patchWorkflow/resolveSeed
// as observed against a representative ComfyUI API-format workflow, built the same way
// server/rounds.ts actually invokes patchWorkflow() in production. They intentionally do not
// assert "correct" behavior -- only that behavior does not change across the upcoming
// workflow.ts -> workflowGraph.ts/workflowInpaint.ts split.

function baseWorkflow(): Record<string, unknown> {
  // A plausible SD1.5-style txt2img API-format graph:
  // checkpoint -> CLIPTextEncode (positive/negative) -> KSampler -> VAEDecode -> SaveImage
  // plus an EmptyLatentImage feeding KSampler's latent_image input.
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "sd15.safetensors" },
      _meta: { title: "Load Checkpoint" }
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: "placeholder positive", clip: ["1", 1] },
      _meta: { title: "CLIP Text Encode (Positive Prompt)" }
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: "placeholder negative", clip: ["1", 1] },
      _meta: { title: "CLIP Text Encode (Negative Prompt)" }
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 512, batch_size: 1 },
      _meta: { title: "Empty Latent Image" }
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: 0,
        steps: 20,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0]
      },
      _meta: { title: "KSampler" }
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
      _meta: { title: "VAE Decode" }
    },
    "7": {
      class_type: "SaveImage",
      inputs: { images: ["6", 0], filename_prefix: "ComfyUI" },
      _meta: { title: "Save Image" }
    }
  };
}

function baseRoleMap(): Record<string, unknown> {
  return {
    positive_prompt_node: "2",
    negative_prompt_node: "3",
    seed_input: "5.inputs.seed",
    cfg_input: "5.inputs.cfg",
    steps_input: "5.inputs.steps",
    denoise_input: "5.inputs.denoise",
    batch_size_input: "4.inputs.batch_size",
    sampler_input: "5.inputs.sampler_name",
    scheduler_input: "5.inputs.scheduler",
    width_input: "4.inputs.width",
    height_input: "4.inputs.height",
    ksampler_node: "5",
    empty_latent_node: "4",
    save_image_node: "7",
    save_prefix_input: "7.inputs.filename_prefix"
  };
}

function baseRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    templateId: "template_1",
    prompt: "a photo of a cat",
    negativePrompt: "blurry, low quality",
    seed: 12345,
    seedMode: "fixed",
    batchSize: 1,
    steps: 24,
    cfg: 6.5,
    sampler: "dpmpp_2m",
    scheduler: "karras",
    denoise: 1,
    width: 768,
    height: 768,
    generationMode: "txt2img",
    parentAssetId: null,
    relationType: null,
    inpaint: null,
    ...overrides
  };
}

test("patchWorkflow txt2img: snapshot of patched workflow JSON", () => {
  const workflow = baseWorkflow();
  const roleMap = baseRoleMap();
  const request = baseRequest();

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_1",
    roundIndex: 3,
    batchIndex: 2,
    request,
    uploadedImageName: null,
    uploadedMaskName: null
  });

  assert.deepEqual(patched, {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "sd15.safetensors" },
      _meta: { title: "Load Checkpoint" }
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: "a photo of a cat", clip: ["1", 1] },
      _meta: { title: "CLIP Text Encode (Positive Prompt)" }
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: "blurry, low quality", clip: ["1", 1] },
      _meta: { title: "CLIP Text Encode (Negative Prompt)" }
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: 768, height: 768, batch_size: 1 },
      _meta: { title: "Empty Latent Image" }
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: 12345,
        steps: 24,
        cfg: 6.5,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0]
      },
      _meta: { title: "KSampler" }
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
      _meta: { title: "VAE Decode" }
    },
    "7": {
      class_type: "SaveImage",
      inputs: { images: ["6", 0], filename_prefix: "guruguru/project_1/round_003/job_002" },
      _meta: { title: "Save Image" }
    }
  });

  // The input workflow object must not be mutated (patchWorkflow deep-clones internally).
  assert.equal((workflow["5"] as { inputs: { seed: number } }).inputs.seed, 0);
});

test("patchWorkflow txt2img: save prefix omits job segment when batchIndex is not provided", () => {
  const workflow = baseWorkflow();
  const roleMap = baseRoleMap();
  const request = baseRequest();

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_1",
    roundIndex: 1,
    request,
    uploadedImageName: null,
    uploadedMaskName: null
  }) as Record<string, any>;

  assert.equal(patched["7"].inputs.filename_prefix, "guruguru/project_1/round_001");
});

test("patchWorkflow img2img: adds LoadImage/VAEEncode/RepeatLatentBatch path and rewires KSampler latent_image", () => {
  const workflow = baseWorkflow();
  const roleMap = baseRoleMap();
  const request = baseRequest({
    generationMode: "img2img",
    denoise: 0.5,
    batchSize: 3,
    width: 512,
    height: 512,
    parentAssetId: "asset_1",
    relationType: "img2img"
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_2",
    roundIndex: 5,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: null
  }) as Record<string, any>;

  // New nodes are appended in the order patchImg2ImgLatentPath creates them: LoadImage(8),
  // then VAEEncode(9) is created (via findVaeConnection/addVaeEncodeNode) BEFORE the resize
  // node, then ImageScale(10) for the resize, then RepeatLatentBatch(11) for the batch.
  assert.deepEqual(patched["8"], {
    inputs: { image: "parent_upload.png" },
    class_type: "LoadImage",
    _meta: { title: "GURUGURU img2img Load Image" }
  });
  assert.deepEqual(patched["9"], {
    inputs: {
      pixels: ["10", 0],
      vae: ["1", 2]
    },
    class_type: "VAEEncode",
    _meta: { title: "GURUGURU img2img VAE Encode" }
  });
  assert.deepEqual(patched["10"], {
    inputs: {
      image: ["8", 0],
      upscale_method: "lanczos",
      width: 512,
      height: 512,
      crop: "disabled"
    },
    class_type: "ImageScale",
    _meta: { title: "GURUGURU img2img Resize" }
  });
  assert.deepEqual(patched["11"], {
    inputs: {
      samples: ["9", 0],
      amount: 3
    },
    class_type: "RepeatLatentBatch",
    _meta: { title: "GURUGURU img2img Batch" }
  });

  // KSampler latent_image now points at the RepeatLatentBatch output, and denoise/seed/etc.
  // are patched from the request as usual.
  assert.deepEqual(patched["5"].inputs.latent_image, ["11", 0]);
  assert.equal(patched["5"].inputs.denoise, 0.5);
  assert.equal(patched["5"].inputs.seed, 12345);

  // EmptyLatentImage node is still patched via role map even though its output is now unused
  // by KSampler -- patchWorkflow always applies width/height/batch_size role paths up front.
  assert.equal(patched["4"].inputs.batch_size, 3);
  assert.equal(patched["4"].inputs.width, 512);
  assert.equal(patched["4"].inputs.height, 512);

  assert.equal(patched["7"].inputs.filename_prefix, "guruguru/project_2/round_005/job_000");
});

test("patchWorkflow inpaint (maskedContent=original): builds LoadImage/LoadImageMask/GrowMask/SetLatentNoiseMask + paste-back composite", () => {
  const workflow = baseWorkflow();
  const roleMap = baseRoleMap();
  const request = baseRequest({
    generationMode: "img2img",
    denoise: 0.75,
    batchSize: 1,
    width: 512,
    height: 512,
    parentAssetId: "asset_9",
    relationType: "img2img",
    inpaint: {
      maskedContent: "original",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 32,
      maskDataUrl: null,
      maskPath: "/tmp/mask.png",
      maskWidth: 512,
      maskHeight: 512
    }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_3",
    roundIndex: 2,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: "mask_upload.png"
  }) as Record<string, any>;

  // maskWidth/maskHeight (512x512) match request.width/height (512x512), so no resize nodes
  // are inserted for image or mask (resizeImageForInpaint/resizeMaskForInpaint short-circuit).
  assert.deepEqual(patched["8"], {
    inputs: { image: "parent_upload.png" },
    class_type: "LoadImage",
    _meta: { title: "GURUGURU img2img Load Image" }
  });
  assert.deepEqual(patched["9"], {
    inputs: {
      image: "mask_upload.png",
      channel: "red"
    },
    class_type: "LoadImageMask",
    _meta: { title: "GURUGURU Inpaint Mask" }
  });
  // GrowMask (padding=32 > 0) on the mask connection.
  assert.deepEqual(patched["10"], {
    inputs: {
      mask: ["9", 0],
      expand: 32,
      tapered_corners: true
    },
    class_type: "GrowMask",
    _meta: { title: "GURUGURU Inpaint Padding" }
  });
  // maskedContent === "original": reuse/insert a plain VAEEncode fed with the resized image
  // (here: the raw LoadImage output, since no resize was needed), then SetLatentNoiseMask
  // wraps the encoded latent with the grown mask.
  assert.deepEqual(patched["11"], {
    inputs: {
      pixels: ["8", 0],
      vae: ["1", 2]
    },
    class_type: "VAEEncode",
    _meta: { title: "GURUGURU img2img VAE Encode" }
  });
  assert.deepEqual(patched["12"], {
    inputs: {
      samples: ["11", 0],
      mask: ["10", 0]
    },
    class_type: "SetLatentNoiseMask",
    _meta: { title: "GURUGURU Inpaint Noise Mask" }
  });

  assert.deepEqual(patched["5"].inputs.latent_image, ["12", 0]);
  assert.equal(patched["5"].inputs.denoise, 0.75);

  // patchSaveImageForInpaintComposite rewrites SaveImage's image input to the composite node's
  // output, and inserts an ImageCompositeMasked node pasting generated content back onto the
  // original (un-resized) image using the non-grown mask.
  assert.deepEqual(patched["13"], {
    inputs: {
      destination: ["8", 0],
      source: ["6", 0],
      x: 0,
      y: 0,
      resize_source: false,
      mask: ["9", 0]
    },
    class_type: "ImageCompositeMasked",
    _meta: { title: "GURUGURU Inpaint Paste Back" }
  });
  assert.deepEqual(patched["7"].inputs.images, ["13", 0]);
});

test("patchWorkflow inpaint (maskedContent=fill): uses VAEEncodeForInpaint and skips the plain VAEEncode path", () => {
  const workflow = baseWorkflow();
  const roleMap = baseRoleMap();
  const request = baseRequest({
    generationMode: "img2img",
    batchSize: 1,
    width: 512,
    height: 512,
    inpaint: {
      maskedContent: "fill",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 0,
      maskDataUrl: null,
      maskPath: "/tmp/mask.png",
      maskWidth: 512,
      maskHeight: 512
    }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_4",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: "mask_upload.png"
  }) as Record<string, any>;

  // padding=0 means no GrowMask node is inserted, so node ids continue straight from
  // 9=LoadImageMask to 9's next id 10... actually next id after LoadImageMask(9) is
  // VAEEncodeForInpaint at "10" since GrowMask is skipped when padding<=0.
  assert.deepEqual(patched["10"], {
    inputs: {
      pixels: ["8", 0],
      vae: ["1", 2],
      mask: ["9", 0],
      grow_mask_by: 0
    },
    class_type: "VAEEncodeForInpaint",
    _meta: { title: "GURUGURU Inpaint Encode" }
  });
});

test("patchWorkflow inpaint (maskedContent=latent_noise): SetLatentNoiseMask wraps a fresh EmptyLatentImage", () => {
  const workflow = baseWorkflow();
  const roleMap = baseRoleMap();
  const request = baseRequest({
    generationMode: "img2img",
    batchSize: 2,
    width: 640,
    height: 480,
    inpaint: {
      maskedContent: "latent_noise",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 16,
      maskDataUrl: null,
      maskPath: "/tmp/mask.png",
      maskWidth: 640,
      maskHeight: 480
    }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_5",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: "mask_upload.png"
  }) as Record<string, any>;

  // Node order: 8=LoadImage, 9=LoadImageMask, 10=GrowMask(padding=16), 11=EmptyLatentImage,
  // 12=SetLatentNoiseMask. Notably this branch does NOT go through repeatLatentForBatchSize,
  // so EmptyLatentImage bakes batchSize directly and the batch_size role-map path on node 4
  // is also separately patched to 2 (the original EmptyLatentImage node is now orphaned).
  assert.deepEqual(patched["11"], {
    inputs: {
      width: 640,
      height: 480,
      batch_size: 2
    },
    class_type: "EmptyLatentImage",
    _meta: { title: "GURUGURU Inpaint Empty Latent" }
  });
  assert.deepEqual(patched["12"], {
    inputs: {
      samples: ["11", 0],
      mask: ["10", 0]
    },
    class_type: "SetLatentNoiseMask",
    _meta: { title: "GURUGURU Inpaint Noise Mask" }
  });
  assert.deepEqual(patched["5"].inputs.latent_image, ["12", 0]);
  // The original (now orphaned) EmptyLatentImage node is still patched via role map.
  assert.equal(patched["4"].inputs.batch_size, 2);
});

test("patchWorkflow inpaint (maskedContent=latent_nothing, default branch): plain EmptyLatentImage with no mask wiring into latent", () => {
  const workflow = baseWorkflow();
  const roleMap = baseRoleMap();
  const request = baseRequest({
    generationMode: "img2img",
    batchSize: 1,
    width: 512,
    height: 512,
    inpaint: {
      maskedContent: "latent_nothing",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 32,
      maskDataUrl: null,
      maskPath: "/tmp/mask.png",
      maskWidth: 512,
      maskHeight: 512
    }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_6",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: "mask_upload.png"
  }) as Record<string, any>;

  // 8=LoadImage, 9=LoadImageMask, 10=GrowMask, 11=EmptyLatentImage (fresh, unmasked latent).
  assert.deepEqual(patched["11"], {
    inputs: {
      width: 512,
      height: 512,
      batch_size: 1
    },
    class_type: "EmptyLatentImage",
    _meta: { title: "GURUGURU Inpaint Empty Latent" }
  });
  assert.deepEqual(patched["5"].inputs.latent_image, ["11", 0]);

  // Paste-back composite is still applied even for latent_nothing (the SaveImage output is
  // always rewired to a composite node when patchInpaintLatentPath runs).
  assert.equal(patched["7"].inputs.images[0], patched["7"].inputs.images[0]);
  const compositeNodeId = patched["7"].inputs.images[0];
  assert.equal(patched[compositeNodeId].class_type, "ImageCompositeMasked");
});

test("patchWorkflow inpaint: resizes image and mask when mask dimensions differ from request width/height", () => {
  const workflow = baseWorkflow();
  const roleMap = baseRoleMap();
  const request = baseRequest({
    generationMode: "img2img",
    batchSize: 1,
    width: 768,
    height: 768,
    inpaint: {
      maskedContent: "original",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 0,
      maskDataUrl: null,
      maskPath: "/tmp/mask.png",
      maskWidth: 512,
      maskHeight: 512
    }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_7",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: "mask_upload.png"
  }) as Record<string, any>;

  // 8=LoadImage, 9=LoadImageMask, 10=ImageScale(image resize to 768x768),
  // 11=MaskToImage, 12=ImageScale(mask-as-image resize), 13=ImageToMask,
  // 14=VAEEncode, 15=SetLatentNoiseMask (padding=0 so no GrowMask node).
  assert.deepEqual(patched["10"], {
    inputs: {
      image: ["8", 0],
      upscale_method: "lanczos",
      width: 768,
      height: 768,
      crop: "disabled"
    },
    class_type: "ImageScale",
    _meta: { title: "GURUGURU Inpaint Resize" }
  });
  assert.deepEqual(patched["11"], {
    inputs: { mask: ["9", 0] },
    class_type: "MaskToImage",
    _meta: { title: "GURUGURU Inpaint Mask Image" }
  });
  assert.deepEqual(patched["12"], {
    inputs: {
      image: ["11", 0],
      upscale_method: "lanczos",
      width: 768,
      height: 768,
      crop: "disabled"
    },
    class_type: "ImageScale",
    _meta: { title: "GURUGURU Inpaint Mask Resize" }
  });
  assert.deepEqual(patched["13"], {
    inputs: {
      image: ["12", 0],
      channel: "red"
    },
    class_type: "ImageToMask",
    _meta: { title: "GURUGURU Inpaint Scaled Mask" }
  });
  assert.deepEqual(patched["14"], {
    inputs: {
      pixels: ["10", 0],
      vae: ["1", 2]
    },
    class_type: "VAEEncode",
    _meta: { title: "GURUGURU img2img VAE Encode" }
  });
  assert.deepEqual(patched["15"], {
    inputs: {
      samples: ["14", 0],
      mask: ["13", 0]
    },
    class_type: "SetLatentNoiseMask",
    _meta: { title: "GURUGURU Inpaint Noise Mask" }
  });

  // The paste-back composite mask uses the resized (scaled) mask connection, not the raw one,
  // whenever a resize was necessary.
  const compositeNodeId = patched["7"].inputs.images[0];
  assert.deepEqual(patched[compositeNodeId].inputs.mask, ["13", 0]);
  assert.deepEqual(patched[compositeNodeId].inputs.destination, ["10", 0]);
});

test("patchWorkflow inpaint: featherRadius unspecified produces byte-identical output to no featherRadius field at all", () => {
  // Characterization test for the mask feather feature (Docs/Feature-MaskFeather.md):
  // featherRadius is optional and defaults to "no feathering" -- omitting it entirely must
  // produce the exact same patched workflow as today, with no MaskToImage/ImageBlur/ImageToMask
  // feather nodes inserted.
  const workflowA = baseWorkflow();
  const workflowB = baseWorkflow();
  const inpaintBase: Record<string, unknown> = {
    maskedContent: "original",
    inpaintArea: "only_masked",
    onlyMaskedPadding: 32,
    maskDataUrl: null,
    maskPath: "/tmp/mask.png",
    maskWidth: 512,
    maskHeight: 512
  };
  const requestWithoutField = baseRequest({
    generationMode: "img2img",
    denoise: 0.75,
    batchSize: 1,
    width: 512,
    height: 512,
    parentAssetId: "asset_9",
    relationType: "img2img",
    inpaint: { ...inpaintBase } as unknown as GenerationRequest["inpaint"]
  });
  const requestWithZero = baseRequest({
    generationMode: "img2img",
    denoise: 0.75,
    batchSize: 1,
    width: 512,
    height: 512,
    parentAssetId: "asset_9",
    relationType: "img2img",
    inpaint: { ...inpaintBase, featherRadius: 0 } as unknown as GenerationRequest["inpaint"]
  });

  const patchedA = patchWorkflow(workflowA, baseRoleMap(), {
    projectId: "project_3",
    roundIndex: 2,
    batchIndex: 0,
    request: requestWithoutField,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: "mask_upload.png"
  });
  const patchedB = patchWorkflow(workflowB, baseRoleMap(), {
    projectId: "project_3",
    roundIndex: 2,
    batchIndex: 0,
    request: requestWithZero,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: "mask_upload.png"
  });

  assert.deepEqual(patchedB, patchedA);

  // No feather-related node classes are present in either output.
  for (const patched of [patchedA, patchedB] as Record<string, any>[]) {
    for (const node of Object.values(patched)) {
      assert.notEqual((node as any).class_type, "ImageBlur");
    }
  }
});

test("patchWorkflow inpaint (maskedContent=original, featherRadius=6): inserts MaskToImage/ImageBlur/ImageToMask chains for both the sampler-side (post-grow) and paste-back (pre-grow) masks", () => {
  // Pins addMaskFeatherNodes wiring (Docs/Feature-MaskFeather.md): with padding=32 and
  // featherRadius=6, patchInpaintLatentPath builds the paste-back feather chain first (it is
  // computed eagerly from the resized, non-grown mask), then -- inside the maskedContent branch --
  // the sampler-side feather chain from the grown mask. Node ids continue directly from the
  // "maskedContent=original" baseline test (8=LoadImage, 9=LoadImageMask, 10=GrowMask).
  const workflow = baseWorkflow();
  const roleMap = baseRoleMap();
  const request = baseRequest({
    generationMode: "img2img",
    denoise: 0.75,
    batchSize: 1,
    width: 512,
    height: 512,
    parentAssetId: "asset_9",
    relationType: "img2img",
    inpaint: {
      maskedContent: "original",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 32,
      featherRadius: 6,
      maskDataUrl: null,
      maskPath: "/tmp/mask.png",
      maskWidth: 512,
      maskHeight: 512
    } as unknown as GenerationRequest["inpaint"]
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_3",
    roundIndex: 2,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: "mask_upload.png"
  }) as Record<string, any>;

  // 8=LoadImage, 9=LoadImageMask, 10=GrowMask(padding=32) -- unchanged from the no-feather case.
  assert.equal(patched["8"].class_type, "LoadImage");
  assert.equal(patched["9"].class_type, "LoadImageMask");
  assert.deepEqual(patched["10"], {
    inputs: { mask: ["9", 0], expand: 32, tapered_corners: true },
    class_type: "GrowMask",
    _meta: { title: "GURUGURU Inpaint Padding" }
  });

  // Paste-back feather chain (11-13): built off the resized/non-grown mask (node 9), since
  // compositeMaskConnection is computed eagerly before the maskedContent branch runs.
  assert.deepEqual(patched["11"], {
    inputs: { mask: ["9", 0] },
    class_type: "MaskToImage",
    _meta: { title: "GURUGURU Inpaint Mask Feather Image" }
  });
  assert.deepEqual(patched["12"], {
    inputs: { image: ["11", 0], blur_radius: 6, sigma: 2 },
    class_type: "ImageBlur",
    _meta: { title: "GURUGURU Inpaint Mask Feather" }
  });
  assert.deepEqual(patched["13"], {
    inputs: { image: ["12", 0], channel: "red" },
    class_type: "ImageToMask",
    _meta: { title: "GURUGURU Inpaint Feathered Mask" }
  });

  // maskedContent === "original": VAEEncode(14) is inserted next, then the sampler-side feather
  // chain (15-17) is built off the grown mask (node 10, not node 9) since feathredGrownMaskConnection
  // feathers AFTER grow.
  assert.deepEqual(patched["14"], {
    inputs: { pixels: ["8", 0], vae: ["1", 2] },
    class_type: "VAEEncode",
    _meta: { title: "GURUGURU img2img VAE Encode" }
  });
  assert.deepEqual(patched["15"], {
    inputs: { mask: ["10", 0] },
    class_type: "MaskToImage",
    _meta: { title: "GURUGURU Inpaint Mask Feather Image" }
  });
  assert.deepEqual(patched["16"], {
    inputs: { image: ["15", 0], blur_radius: 6, sigma: 2 },
    class_type: "ImageBlur",
    _meta: { title: "GURUGURU Inpaint Mask Feather" }
  });
  assert.deepEqual(patched["17"], {
    inputs: { image: ["16", 0], channel: "red" },
    class_type: "ImageToMask",
    _meta: { title: "GURUGURU Inpaint Feathered Mask" }
  });

  // SetLatentNoiseMask(18) wraps the VAEEncode output with the sampler-side feathered mask (17),
  // not the raw grown mask (10).
  assert.deepEqual(patched["18"], {
    inputs: { samples: ["14", 0], mask: ["17", 0] },
    class_type: "SetLatentNoiseMask",
    _meta: { title: "GURUGURU Inpaint Noise Mask" }
  });
  assert.deepEqual(patched["5"].inputs.latent_image, ["18", 0]);

  // Paste-back composite(19) uses the paste-back feathered mask (13), not the raw resized mask (9)
  // or the sampler-side feathered mask (17).
  assert.deepEqual(patched["19"], {
    inputs: {
      destination: ["8", 0],
      source: ["6", 0],
      x: 0,
      y: 0,
      resize_source: false,
      mask: ["13", 0]
    },
    class_type: "ImageCompositeMasked",
    _meta: { title: "GURUGURU Inpaint Paste Back" }
  });
  assert.deepEqual(patched["7"].inputs.images, ["19", 0]);
});

test("patchWorkflow inpaint (maskedContent=latent_nothing, featherRadius=6): no feather nodes are inserted at all", () => {
  // Per Docs/Feature-MaskFeather.md: latent_nothing never wires a sampler-side mask (no
  // SetLatentNoiseMask), so feathredGrownMaskConnection() is never invoked in that branch and no
  // orphaned sampler-side feather chain is created. However, the paste-back composite mask
  // connection is still computed eagerly, so a paste-back feather chain IS expected.
  const workflow = baseWorkflow();
  const roleMap = baseRoleMap();
  const request = baseRequest({
    generationMode: "img2img",
    batchSize: 1,
    width: 512,
    height: 512,
    inpaint: {
      maskedContent: "latent_nothing",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 32,
      featherRadius: 6,
      maskDataUrl: null,
      maskPath: "/tmp/mask.png",
      maskWidth: 512,
      maskHeight: 512
    } as unknown as GenerationRequest["inpaint"]
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_6",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: "mask_upload.png"
  }) as Record<string, any>;

  // Exactly one feather chain (3 nodes: MaskToImage/ImageBlur/ImageToMask) is present -- the
  // paste-back one. GrowMask(10) remains orphaned (pre-existing behavior, not repeated for feather).
  const blurNodes = Object.values(patched).filter((node: any) => node.class_type === "ImageBlur");
  assert.equal(blurNodes.length, 1);

  const compositeNodeId = patched["7"].inputs.images[0];
  const compositeNode = patched[compositeNodeId];
  assert.equal(compositeNode.class_type, "ImageCompositeMasked");
  const pasteBackMaskNodeId = compositeNode.inputs.mask[0];
  assert.equal(patched[pasteBackMaskNodeId].class_type, "ImageToMask");

  // The sampler's latent_image is the plain EmptyLatentImage output -- no SetLatentNoiseMask,
  // and therefore no sampler-side feather chain wired to it.
  const latentImageNodeId = patched["5"].inputs.latent_image[0];
  assert.equal(patched[latentImageNodeId].class_type, "EmptyLatentImage");
});

test("patchWorkflow: throws when img2img workflow has no sampler node with a latent_image input", () => {
  const workflow = baseWorkflow() as Record<string, any>;
  delete workflow["5"].inputs.latent_image;
  workflow["5"].class_type = "SomethingElse";
  const roleMap: Record<string, unknown> = { ...baseRoleMap() };
  delete roleMap.ksampler_node;

  const request = baseRequest({ generationMode: "img2img" });

  assert.throws(
    () =>
      patchWorkflow(workflow, roleMap, {
        projectId: "project_8",
        roundIndex: 1,
        batchIndex: 0,
        request,
        uploadedImageName: "parent_upload.png",
        uploadedMaskName: null
      }),
    /img2img workflow requires a sampler node with a latent_image input/
  );
});

function baseWorkflowWithControlNet(): Record<string, unknown> {
  const workflow = baseWorkflow() as Record<string, any>;
  // ControlNetApplyAdvanced(8) reads its control image from a LoadImage(9) node -- mirroring
  // the reference workflow's 752/754 pair (Docs/Done/Feature-PoseControlNet.md "参照ワークフローの構成").
  workflow["8"] = {
    class_type: "ControlNetApplyAdvanced",
    inputs: { image: ["9", 0], strength: 1, start_percent: 0, end_percent: 1 },
    _meta: { title: "Apply ControlNet" }
  };
  workflow["9"] = {
    class_type: "LoadImage",
    inputs: { image: "old_control.png" },
    _meta: { title: "Load Control Image" }
  };
  return workflow;
}

function baseRoleMapWithControlNet(): Record<string, unknown> {
  return {
    ...baseRoleMap(),
    controlnet_apply_node: "8",
    controlnet_strength_input: "8.inputs.strength",
    controlnet_start_percent_input: "8.inputs.start_percent",
    controlnet_end_percent_input: "8.inputs.end_percent"
  };
}

test("patchWorkflow controlnet: pose image overwrites the ControlNetApplyAdvanced-connected LoadImage and strength/percent are patched", () => {
  const workflow = baseWorkflowWithControlNet();
  // load_image_input is misinferred onto the SAME control LoadImage node (the documented
  // inferRoleMap gotcha) -- the pose attachment must still win because patchControlNetPath
  // runs after patchWorkflow's own load_image_input injection.
  const roleMap = { ...baseRoleMapWithControlNet(), load_image_input: "9.inputs.image" };
  const request = baseRequest({
    controlnet: { poseImageDataUrl: null, poseImagePath: "/tmp/pose.png", strength: 1.4, startPercent: 0.1, endPercent: 0.9 }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: null,
    uploadedControlImageName: "pose_control.png"
  }) as Record<string, any>;

  assert.equal(patched["9"].inputs.image, "pose_control.png");
  assert.equal(patched["8"].inputs.strength, 1.4);
  assert.equal(patched["8"].inputs.start_percent, 0.1);
  assert.equal(patched["8"].inputs.end_percent, 0.9);
});

test("patchWorkflow controlnet: without controlnet_apply_node role, falls back to an exact ControlNetApplyAdvanced class search and adds a LoadImage when the image input is not a connection", () => {
  const workflow = baseWorkflowWithControlNet() as Record<string, any>;
  workflow["8"].inputs.image = null;
  const roleMap: Record<string, unknown> = { ...baseRoleMap() };
  const request = baseRequest({
    controlnet: { poseImageDataUrl: null, poseImagePath: "/tmp/pose.png", strength: 1, startPercent: 0, endPercent: 1 }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl2",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: null,
    uploadedMaskName: null,
    uploadedControlImageName: "pose_control.png"
  }) as Record<string, any>;

  assert.deepEqual(patched["10"], {
    inputs: { image: "pose_control.png" },
    class_type: "LoadImage",
    _meta: { title: "GURUGURU ControlNet Load Image" }
  });
  assert.deepEqual(patched["8"].inputs.image, ["10", 0]);
});

test("patchWorkflow controlnet: request.controlnet is null leaves the ControlNet nodes untouched by patchControlNetPath (load_image_input still applies the parent image)", () => {
  const workflow = baseWorkflowWithControlNet();
  const roleMap = { ...baseRoleMapWithControlNet(), load_image_input: "9.inputs.image" };
  const request = baseRequest({ controlnet: null });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl3",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: null,
    uploadedControlImageName: null
  }) as Record<string, any>;

  assert.equal(patched["9"].inputs.image, "parent_upload.png");
  assert.equal(patched["8"].inputs.strength, 1);
});

test("patchWorkflow controlnet: no ControlNetApplyAdvanced node in the template is a silent no-op (pose attachment is optional)", () => {
  const workflow = baseWorkflow();
  const roleMap = baseRoleMap();
  const request = baseRequest({
    controlnet: { poseImageDataUrl: null, poseImagePath: "/tmp/pose.png", strength: 1, startPercent: 0, endPercent: 1 }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl4",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: null,
    uploadedMaskName: null,
    uploadedControlImageName: "pose_control.png"
  }) as Record<string, any>;

  assert.deepEqual(Object.keys(patched).sort(), Object.keys(baseWorkflow()).sort());
});

test("patchWorkflow controlnet: a pose attachment skips the roleMap-based controlnet_image_input/controlnet_image_node parent-image injection", () => {
  const workflow = baseWorkflowWithControlNet() as Record<string, any>;
  // A separate legacy controlnet_image_* role target, distinct from the ControlNetApplyAdvanced-
  // connected LoadImage(9) -- e.g. a hand-authored roleMap pointing at a different node entirely.
  workflow["11"] = {
    class_type: "LoadImage",
    inputs: { image: "legacy_control.png" },
    _meta: { title: "Legacy ControlNet Image" }
  };
  const roleMap = {
    ...baseRoleMapWithControlNet(),
    controlnet_image_input: "11.inputs.image",
    controlnet_image_node: "11"
  };
  const request = baseRequest({
    controlnet: { poseImageDataUrl: null, poseImagePath: "/tmp/pose.png", strength: 1, startPercent: 0, endPercent: 1 }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl5",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: null,
    uploadedControlImageName: "pose_control.png"
  }) as Record<string, any>;

  // The controlnet_image_* role injection is skipped entirely (node 11 keeps its old value);
  // the actual attachment happens on node 9 via patchControlNetPath's connection trace.
  assert.equal(patched["11"].inputs.image, "legacy_control.png");
  assert.equal(patched["9"].inputs.image, "pose_control.png");
});

test("patchWorkflow controlnet: without a pose attachment, the roleMap-based controlnet_image_input/controlnet_image_node still receives the parent image", () => {
  const workflow = baseWorkflowWithControlNet() as Record<string, any>;
  workflow["11"] = {
    class_type: "LoadImage",
    inputs: { image: "legacy_control.png" },
    _meta: { title: "Legacy ControlNet Image" }
  };
  const roleMap = {
    ...baseRoleMapWithControlNet(),
    controlnet_image_input: "11.inputs.image",
    controlnet_image_node: "11"
  };
  const request = baseRequest({ controlnet: null });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl6",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: null,
    uploadedControlImageName: null
  }) as Record<string, any>;

  assert.equal(patched["11"].inputs.image, "parent_upload.png");
});

test("patchWorkflow img2img x controlnet: parent image gets a fresh LoadImage distinct from the control-supplier LoadImage, and CFGGuider-style positive/negative wiring on the apply node is left untouched", () => {
  // baseWorkflowWithControlNet has no VAEEncode node (mirrors the reference workflow), so
  // patchImg2ImgLatentPath's LoadImage fallback would normally resolve to findNodeIdByExactClass's
  // first LoadImage match -- node 9, which is ALSO the ControlNetApplyAdvanced-connected control
  // image supplier. Sharing that node would let the img2img resize path clobber node 9's `image`
  // input with the parent upload, then patchControlNetPath would overwrite it again with the pose
  // image, breaking the parent-image resize/VAEEncode chain's actual source. The fix adds a
  // separate LoadImage node for the parent image instead of reusing node 9.
  const workflow = baseWorkflowWithControlNet();
  const roleMap = { ...baseRoleMapWithControlNet(), controlnet_image_node: "9" };
  const request = baseRequest({
    generationMode: "img2img",
    denoise: 0.6,
    batchSize: 1,
    width: 512,
    height: 512,
    parentAssetId: "asset_ctrl_1",
    relationType: "img2img",
    controlnet: { poseImageDataUrl: null, poseImagePath: "/tmp/pose.png", strength: 1.2, startPercent: 0, endPercent: 1 }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl7",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: null,
    uploadedControlImageName: "pose_control.png"
  }) as Record<string, any>;

  // Node 9 (the control-supplier LoadImage) keeps receiving the pose image, not the parent image.
  assert.equal(patched["9"].inputs.image, "pose_control.png");
  assert.equal(patched["9"].class_type, "LoadImage");

  // A NEW LoadImage node (10) is added for the parent image instead of reusing node 9.
  assert.deepEqual(patched["10"], {
    inputs: { image: "parent_upload.png" },
    class_type: "LoadImage",
    _meta: { title: "GURUGURU img2img Load Image" }
  });

  // The img2img resize/VAEEncode chain is built off the new node 10, not node 9.
  // Locate the dynamically-added VAEEncode node and confirm its pixels source traces back to 10.
  const vaeEncodeEntry = Object.entries(patched).find(([, node]) => (node as any).class_type === "VAEEncode");
  assert.ok(vaeEncodeEntry, "expected a dynamically-added VAEEncode node");
  const [, vaeEncodeNode] = vaeEncodeEntry!;
  const resizeNodeIdActual = (vaeEncodeNode as any).inputs.pixels[0];
  assert.equal(patched[resizeNodeIdActual].class_type, "ImageScale");
  assert.equal(patched[resizeNodeIdActual].inputs.image[0], "10");

  // ControlNetApplyAdvanced's own positive/negative/image wiring is unaffected structurally --
  // still a connection into node 6/7, and image still points at node 9 (now holding the pose image).
  assert.deepEqual(patched["8"].inputs.image, ["9", 0]);
  assert.equal(patched["8"].inputs.strength, 1.2);
});

test("patchWorkflow img2img x controlnet (stale roleMap): a stale vae_encode_image_input pointing at the ControlNetApplyAdvanced node is sanitized away and does not corrupt the apply node's inputs", () => {
  // Simulates a DB-stored template whose roleMap was inferred before the inferRoleMap fix landed:
  // vae_encode_image_input erroneously points at node 8 (ControlNetApplyAdvanced).inputs.image.
  // sanitizeRoleMap must drop this stale role at the start of patchWorkflow so patchImg2ImgLatentPath
  // never treats node 8 as a VAEEncode node.
  const workflow = baseWorkflowWithControlNet();
  const roleMap = {
    ...baseRoleMapWithControlNet(),
    load_image_input: "9.inputs.image",
    vae_encode_image_input: "8.inputs.image"
  };
  const request = baseRequest({
    generationMode: "img2img",
    denoise: 0.6,
    batchSize: 1,
    width: 512,
    height: 512,
    parentAssetId: "asset_ctrl_2",
    relationType: "img2img"
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl8",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: null,
    uploadedControlImageName: null
  }) as Record<string, any>;

  // No pose is attached in this test, so the img2img strength=0 rule also applies -- strength is
  // forced to 0 (not left at the stale roleMap's misdirected value), and start_percent is
  // untouched by the sanitizer. Its image input is not the raw parent image string (would
  // indicate the sanitizer failed and the parent image clobbered it).
  assert.equal(patched["8"].inputs.strength, 0);
  assert.equal(patched["8"].inputs.start_percent, 0);
  assert.notEqual(patched["8"].inputs.image, "parent_upload.png");

  // A real VAEEncode node was dynamically added elsewhere and used for the img2img latent path.
  const vaeEncodeEntry = Object.entries(patched).find(([, node]) => (node as any).class_type === "VAEEncode");
  assert.ok(vaeEncodeEntry, "expected a dynamically-added VAEEncode node");

  // Also: since load_image_input was stale-pointed at the control-supplier LoadImage (9), the
  // sanitizer drops that role too and moves node 9 into controlnet_image_node, so the parent-image
  // injection at the top of patchWorkflow does not clobber node 9's image with the parent upload
  // (no pose attached in this test, so node 9 receives the parent image via controlnet_image_node
  // instead, preserving the "parent image as control image" behavior for generationMode img2img
  // without pose -- see the strength=0 test below for the full no-pose flow).
});

test("patchWorkflow img2img x controlnet, no pose attached: ControlNetApplyAdvanced strength is forced to 0 (no-op) and the control image slot receives the parent image so LoadImage does not reference a missing file", () => {
  const workflow = baseWorkflowWithControlNet();
  const roleMap = { ...baseRoleMapWithControlNet(), controlnet_image_node: "9" };
  const request = baseRequest({
    generationMode: "img2img",
    denoise: 0.6,
    batchSize: 1,
    width: 512,
    height: 512,
    parentAssetId: "asset_ctrl_3",
    relationType: "img2img",
    controlnet: null
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl9",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: null,
    uploadedControlImageName: null
  }) as Record<string, any>;

  // strength is forced to 0 so ControlNetApplyAdvanced is a no-op passthrough, making this
  // behave like plain img2img even though the template has a ControlNet section.
  assert.equal(patched["8"].inputs.strength, 0);

  // The control image slot (node 9, via controlnet_image_node) still receives the parent image --
  // this avoids ComfyUI failing on a stale/missing control image filename left over in the template.
  assert.equal(patched["9"].inputs.image, "parent_upload.png");
});

test("patchWorkflow controlnet mode (generationMode=\"controlnet\") is not affected by the img2img strength=0 rule even when request.controlnet is null", () => {
  const workflow = baseWorkflowWithControlNet();
  const roleMap = { ...baseRoleMapWithControlNet(), controlnet_image_node: "9" };
  const request = baseRequest({
    generationMode: "controlnet",
    controlnet: null
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl10",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: null,
    uploadedControlImageName: null
  }) as Record<string, any>;

  // strength is left at the template's original value (1) -- the strength=0 override only
  // applies to generationMode "img2img".
  assert.equal(patched["8"].inputs.strength, 1);
  assert.equal(patched["9"].inputs.image, "parent_upload.png");
});

test("patchWorkflow inpaint x controlnet: pose image and parent/mask images do not collide on the same LoadImage node", () => {
  const workflow = baseWorkflowWithControlNet();
  const roleMap = { ...baseRoleMapWithControlNet(), controlnet_image_node: "9" };
  const request = baseRequest({
    generationMode: "img2img",
    batchSize: 1,
    width: 512,
    height: 512,
    inpaint: {
      maskedContent: "original",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 0,
      maskDataUrl: null,
      maskPath: "/tmp/mask.png",
      maskWidth: 512,
      maskHeight: 512
    },
    controlnet: { poseImageDataUrl: null, poseImagePath: "/tmp/pose.png", strength: 1, startPercent: 0, endPercent: 1 }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl11",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: "mask_upload.png",
    uploadedControlImageName: "pose_control.png"
  }) as Record<string, any>;

  // The control-supplier LoadImage (9) receives the pose image.
  assert.equal(patched["9"].inputs.image, "pose_control.png");

  // A separate LoadImage node was added for the parent image (inpaint's own LoadImage fallback
  // must not reuse node 9 either).
  const loadImageNodes = Object.entries(patched).filter(
    ([, node]) => (node as any).class_type === "LoadImage" && (node as any).inputs.image === "parent_upload.png"
  );
  assert.equal(loadImageNodes.length, 1);
  assert.notEqual(loadImageNodes[0]![0], "9");

  // ControlNetApplyAdvanced's strength/percent wiring is untouched by the collision-avoidance fix.
  assert.equal(patched["8"].inputs.strength, 1);
});

test("resolveSeed: seedMode=fixed returns request.seed", () => {
  assert.equal(resolveSeed(baseRequest({ seedMode: "fixed", seed: 777 }), null), 777);
});

test("resolveSeed: seedMode=increment returns request.seed + 1", () => {
  assert.equal(resolveSeed(baseRequest({ seedMode: "increment", seed: 41 }), null), 42);
});

test("resolveSeed: seedMode=reuse_parent_seed returns parentSeed when provided", () => {
  assert.equal(resolveSeed(baseRequest({ seedMode: "reuse_parent_seed", seed: 1 }), 999), 999);
});

test("resolveSeed: seedMode=reuse_parent_seed falls back to random when parentSeed is missing", () => {
  const seed = resolveSeed(baseRequest({ seedMode: "reuse_parent_seed", seed: 1 }), null);
  assert.equal(typeof seed, "number");
  assert.ok(seed >= 0 && seed < 2 ** 31);
});

test("resolveSeed: seedMode=random ignores request.seed and returns a value in range", () => {
  const seed = resolveSeed(baseRequest({ seedMode: "random", seed: 555 }), null);
  assert.equal(typeof seed, "number");
  assert.ok(Number.isInteger(seed));
  assert.ok(seed >= 0 && seed < 2 ** 31);
});

test("resolveSeed: seedMode=fixed but seed is null falls back to random", () => {
  const seed = resolveSeed(baseRequest({ seedMode: "fixed", seed: null }), null);
  assert.equal(typeof seed, "number");
  assert.ok(seed >= 0 && seed < 2 ** 31);
});

test("resolveSeed: seedMode=increment but seed is null falls back to random", () => {
  const seed = resolveSeed(baseRequest({ seedMode: "increment", seed: null }), null);
  assert.equal(typeof seed, "number");
  assert.ok(seed >= 0 && seed < 2 ** 31);
});

test("patchWorkflow img2img x controlnet (stale roleMap): a stale load_image_input pointing at the ControlNetApplyAdvanced node itself is sanitized away -- no ImageScale reads its CONDITIONING output", () => {
  // Reproduces the ComfyUI 400 "return_type_mismatch ... received_type(CONDITIONING)" failure:
  // a DB-stored roleMap (inferred before the inferRoleMap fix) has load_image_input pointing at
  // node 8 (ControlNetApplyAdvanced).inputs.image. Without sanitization, patchImg2ImgLatentPath
  // treats node 8 as the parent LoadImage and wires the dynamically-added ImageScale's image
  // input to ["8", 0] -- a CONDITIONING output.
  const workflow = baseWorkflowWithControlNet();
  const roleMap = {
    ...baseRoleMapWithControlNet(),
    load_image_input: "8.inputs.image"
  };
  const request = baseRequest({
    generationMode: "img2img",
    denoise: 0.6,
    parentAssetId: "asset_ctrl_stale",
    relationType: "img2img",
    controlnet: { poseImageDataUrl: null, poseImagePath: "/tmp/pose.png", strength: 1.2, startPercent: 0, endPercent: 1 }
  });

  const patched = patchWorkflow(workflow, roleMap, {
    projectId: "project_ctrl_stale",
    roundIndex: 1,
    batchIndex: 0,
    request,
    uploadedImageName: "parent_upload.png",
    uploadedMaskName: null,
    uploadedControlImageName: "pose_control.png"
  }) as Record<string, any>;

  // No image-typed input anywhere reads from node 8's CONDITIONING outputs.
  for (const [nodeId, node] of Object.entries(patched)) {
    if (node.class_type === "ImageScale" || node.class_type === "VAEEncode") {
      const source = node.inputs.image ?? node.inputs.pixels;
      assert.notEqual(source?.[0], "8", `${nodeId} must not read from ControlNetApplyAdvanced`);
    }
  }

  // Node 8's own image input was neither clobbered with the parent filename string nor left
  // dangling -- it connects to a LoadImage node holding the pose image.
  const applyImage = patched["8"].inputs.image;
  assert.ok(Array.isArray(applyImage), "apply image input must stay a connection");
  assert.equal(patched[applyImage[0]].class_type, "LoadImage");
  assert.equal(patched[applyImage[0]].inputs.image, "pose_control.png");
  assert.equal(patched["8"].inputs.strength, 1.2);

  // The parent image reaches the sampler through a real LoadImage -> ImageScale -> VAEEncode chain.
  const vaeEncodeEntry = Object.entries(patched).find(([, node]) => (node as any).class_type === "VAEEncode");
  assert.ok(vaeEncodeEntry, "expected a dynamically-added VAEEncode node");
  const scaleNodeId = (vaeEncodeEntry![1] as any).inputs.pixels[0];
  assert.equal(patched[scaleNodeId].class_type, "ImageScale");
  const parentLoadNodeId = patched[scaleNodeId].inputs.image[0];
  assert.equal(patched[parentLoadNodeId].class_type, "LoadImage");
  assert.equal(patched[parentLoadNodeId].inputs.image, "parent_upload.png");
});
