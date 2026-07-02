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
