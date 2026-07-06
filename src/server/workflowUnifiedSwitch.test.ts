import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { patchWorkflow } from "./workflow.ts";
import {
  isUnifiedSwitchWorkflow,
  patchUnifiedSwitchWorkflow,
  resolveUnifiedSwitchRoles
} from "./workflowUnifiedSwitch.ts";
import type { GenerationRequest } from "../shared/types.ts";
import type { PatchContext } from "./workflow.ts";

// These tests run against the actual reference template JSON
// (Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json) so the structural role resolution is
// exercised on the real graph, node ids included.

const referencePath = fileURLToPath(
  new URL("../../Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json", import.meta.url)
);

function referenceWorkflow(): Record<string, any> {
  return JSON.parse(readFileSync(referencePath, "utf8"));
}

function baseRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    templateId: "template_unified",
    prompt: "a watercolor fox",
    negativePrompt: "blurry, low quality",
    seed: 4242,
    seedMode: "fixed",
    batchSize: 1,
    steps: 26,
    cfg: 4.5,
    sampler: "euler_ancestral",
    scheduler: "beta",
    denoise: 1,
    width: 1024,
    height: 768,
    generationMode: "txt2img",
    parentAssetId: null,
    relationType: null,
    inpaint: null,
    controlnet: null,
    ...overrides
  };
}

function baseContext(request: GenerationRequest, overrides: Partial<PatchContext> = {}): PatchContext {
  return {
    projectId: "project_unified",
    roundIndex: 5,
    batchIndex: 1,
    request,
    uploadedImageName: null,
    uploadedMaskName: null,
    uploadedControlImageName: null,
    dummyImageName: "guruguru-dummy.png",
    ...overrides
  };
}

test("isUnifiedSwitchWorkflow: true for the reference template, false for a plain graph", () => {
  assert.equal(isUnifiedSwitchWorkflow(referenceWorkflow()), true);
  assert.equal(
    isUnifiedSwitchWorkflow({
      "1": { class_type: "KSampler", inputs: { latent_image: ["2", 0] } },
      "2": { class_type: "EmptyLatentImage", inputs: {} }
    }),
    false
  );
});

test("resolveUnifiedSwitchRoles: every role resolves to the expected reference node id", () => {
  const roles = resolveUnifiedSwitchRoles(referenceWorkflow());
  assert.deepEqual(roles, {
    samplerNodeId: "747",
    useParentImageBoolNodeId: "770",
    useMaskBoolNodeId: "771",
    useEmptyLatentContentBoolNodeId: "780",
    useFillBoolNodeId: "781",
    useNoiseMaskBoolNodeId: "782",
    vaeEncodeForInpaintNodeId: "786",
    useControlNetBoolNodeId: "772",
    emptyLatentNodeId: "737",
    vaeEncodeNodeId: "761",
    parentLoadImageNodeId: "762",
    loadImageMaskNodeId: "763",
    txt2imgSchedulerNodeId: "734",
    img2imgSchedulerNodeId: "768",
    noiseNodeId: "718",
    guiderNodeId: "694",
    samplerSelectNodeId: "700",
    positivePromptNodeId: "748",
    negativePromptNodeId: "749",
    controlNetApplyNodeId: "752",
    controlLoadImageNodeId: "754",
    saveImageNodeId: "740"
  });
});

test("patchUnifiedSwitchWorkflow txt2img: booleans all false, unused image inputs get the dummy, values written without structural changes", () => {
  const template = referenceWorkflow();
  const request = baseRequest();
  const patched = patchUnifiedSwitchWorkflow(referenceWorkflow(), baseContext(request), "guruguru/project_unified/round_005/job_001") as Record<string, any>;

  // Mode booleans: txt2img = all branches off.
  assert.equal(patched["770"].inputs.value, false);
  assert.equal(patched["771"].inputs.value, false);
  assert.equal(patched["772"].inputs.value, false);

  // Unused image inputs all point at the dummy so ComfyUI's graph-wide validation passes.
  assert.equal(patched["762"].inputs.image, "guruguru-dummy.png");
  assert.equal(patched["763"].inputs.image, "guruguru-dummy.png");
  assert.equal(patched["763"].inputs.channel, "red");
  assert.equal(patched["754"].inputs.image, "guruguru-dummy.png");

  // Value writes.
  assert.equal(patched["748"].inputs.text, "a watercolor fox");
  assert.equal(patched["749"].inputs.text, "blurry, low quality");
  assert.equal(patched["718"].inputs.noise_seed, 4242);
  assert.equal(patched["694"].inputs.cfg, 4.5);
  assert.equal(patched["700"].inputs.sampler_name, "euler_ancestral");
  assert.equal(patched["734"].inputs.steps, 26);
  assert.equal(patched["734"].inputs.scheduler, "beta");
  assert.equal(patched["734"].inputs.denoise, 1);
  assert.equal(patched["768"].inputs.steps, 26);
  assert.equal(patched["768"].inputs.scheduler, "beta");
  assert.equal(patched["737"].inputs.width, 1024);
  assert.equal(patched["737"].inputs.height, 768);
  assert.equal(patched["737"].inputs.batch_size, 1);
  assert.equal(patched["740"].inputs.filename_prefix, "guruguru/project_unified/round_005/job_001");

  // No nodes added or removed, and every connection is untouched.
  assert.deepEqual(Object.keys(patched).sort(), Object.keys(template).sort());
  for (const [nodeId, rawNode] of Object.entries(template)) {
    for (const [inputName, value] of Object.entries((rawNode as any).inputs)) {
      if (Array.isArray(value)) {
        assert.deepEqual(patched[nodeId].inputs[inputName], value, `${nodeId}.inputs.${inputName} connection changed`);
      }
    }
  }
});

test("patchUnifiedSwitchWorkflow img2img: use-parent-image on, parent image loaded, denoise applied to the img2img scheduler only", () => {
  const request = baseRequest({ generationMode: "img2img", denoise: 0.6, parentAssetId: "asset_1", relationType: "img2img" });
  const patched = patchUnifiedSwitchWorkflow(
    referenceWorkflow(),
    baseContext(request, { uploadedImageName: "parent_upload.png" }),
    "prefix"
  ) as Record<string, any>;

  assert.equal(patched["770"].inputs.value, true);
  assert.equal(patched["771"].inputs.value, false);
  assert.equal(patched["772"].inputs.value, false);
  assert.equal(patched["762"].inputs.image, "parent_upload.png");
  assert.equal(patched["763"].inputs.image, "guruguru-dummy.png");
  assert.equal(patched["734"].inputs.denoise, 1);
  assert.equal(patched["768"].inputs.denoise, 0.6);
});

test("patchUnifiedSwitchWorkflow inpaint (maskedContent=original): use-mask on and the mask file is loaded via the red channel", () => {
  const request = baseRequest({
    generationMode: "img2img",
    denoise: 0.75,
    parentAssetId: "asset_1",
    inpaint: {
      maskedContent: "original",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 32,
      featherRadius: 0,
      maskDataUrl: null,
      maskPath: "/tmp/mask.png",
      maskWidth: 1232,
      maskHeight: 688
    }
  });
  const patched = patchUnifiedSwitchWorkflow(
    referenceWorkflow(),
    baseContext(request, { uploadedImageName: "parent_upload.png", uploadedMaskName: "mask_upload.png" }),
    "prefix"
  ) as Record<string, any>;

  assert.equal(patched["770"].inputs.value, true);
  assert.equal(patched["771"].inputs.value, true);
  assert.equal(patched["762"].inputs.image, "parent_upload.png");
  assert.equal(patched["763"].inputs.image, "mask_upload.png");
  assert.equal(patched["763"].inputs.channel, "red");
  // maskedContent=original: the whole content-switch tree stays on the original branch.
  assert.equal(patched["780"].inputs.value, false);
  assert.equal(patched["781"].inputs.value, false);
  assert.equal(patched["782"].inputs.value, false);
});

function inpaintRequest(maskedContent: "original" | "fill" | "latent_noise" | "latent_nothing", onlyMaskedPadding = 32): GenerationRequest {
  return baseRequest({
    generationMode: "img2img",
    denoise: 0.75,
    parentAssetId: "asset_1",
    inpaint: {
      maskedContent,
      inpaintArea: "only_masked",
      onlyMaskedPadding,
      featherRadius: 0,
      maskDataUrl: null,
      maskPath: "/tmp/mask.png",
      maskWidth: 1232,
      maskHeight: 688
    }
  });
}

function patchInpaint(template: Record<string, any>, request: GenerationRequest): Record<string, any> {
  return patchUnifiedSwitchWorkflow(
    template,
    baseContext(request, { uploadedImageName: "parent_upload.png", uploadedMaskName: "mask_upload.png" }),
    "prefix"
  ) as Record<string, any>;
}

test("patchUnifiedSwitchWorkflow inpaint (maskedContent=fill): fill branch on, onlyMaskedPadding mapped to grow_mask_by", () => {
  const patched = patchInpaint(referenceWorkflow(), inpaintRequest("fill"));

  assert.equal(patched["771"].inputs.value, true);
  assert.equal(patched["780"].inputs.value, false);
  assert.equal(patched["781"].inputs.value, true);
  assert.equal(patched["782"].inputs.value, false);
  assert.equal(patched["786"].inputs.grow_mask_by, 32);
});

test("patchUnifiedSwitchWorkflow inpaint (maskedContent=fill): grow_mask_by is clamped to the widget's 0..64 range", () => {
  const patched = patchInpaint(referenceWorkflow(), inpaintRequest("fill", 256));
  assert.equal(patched["786"].inputs.grow_mask_by, 64);
});

test("patchUnifiedSwitchWorkflow inpaint (maskedContent=latent_noise): empty-latent branch with noise mask", () => {
  const patched = patchInpaint(referenceWorkflow(), inpaintRequest("latent_noise"));

  assert.equal(patched["771"].inputs.value, true);
  assert.equal(patched["780"].inputs.value, true);
  assert.equal(patched["781"].inputs.value, false);
  assert.equal(patched["782"].inputs.value, true);
});

test("patchUnifiedSwitchWorkflow inpaint (maskedContent=latent_nothing): empty-latent branch without noise mask", () => {
  const patched = patchInpaint(referenceWorkflow(), inpaintRequest("latent_nothing"));

  assert.equal(patched["771"].inputs.value, true);
  assert.equal(patched["780"].inputs.value, true);
  assert.equal(patched["781"].inputs.value, false);
  assert.equal(patched["782"].inputs.value, false);
});

test("patchUnifiedSwitchWorkflow inpaint: a legacy template without the content-switch tree rejects non-original maskedContent", () => {
  // Reproduce a pre-fill imported template: mask-switch.on_true goes straight to the
  // SetLatentNoiseMask node and none of the content-switch nodes exist.
  const legacy = referenceWorkflow();
  legacy["765"].inputs.on_true = ["764", 0];
  legacy["740"].inputs.images = ["298", 0];
  for (const nodeId of ["780", "781", "782", "783", "784", "785", "786", "787", "788", "789", "790"]) {
    delete legacy[nodeId];
  }

  const patchedOriginal = patchInpaint(legacy, inpaintRequest("original"));
  assert.equal(patchedOriginal["771"].inputs.value, true);
  assert.equal(patchedOriginal["763"].inputs.image, "mask_upload.png");

  assert.throws(
    () => patchInpaint(legacy, inpaintRequest("fill")),
    /supports only maskedContent="original"/
  );
});

test("reference template: inpaint output is pasted back over the parent image via the save-image switch", () => {
  const template = referenceWorkflow();
  // SaveImage reads from the save-image switch, which shares the use-mask boolean (771): raw
  // decode for txt2img/img2img, ImageCompositeMasked paste-back for all inpaint modes.
  assert.deepEqual(template["740"].inputs.images, ["790", 0]);
  assert.deepEqual(template["790"].inputs.switch, ["771", 0]);
  assert.deepEqual(template["790"].inputs.on_false, ["298", 0]);
  assert.deepEqual(template["790"].inputs.on_true, ["789", 0]);
  assert.deepEqual(template["789"].inputs.destination, ["762", 0]);
  assert.deepEqual(template["789"].inputs.source, ["298", 0]);
  assert.deepEqual(template["789"].inputs.mask, ["763", 0]);
});

test("patchUnifiedSwitchWorkflow img2img x pose ControlNet: all three branches configured, pose image and CN params applied", () => {
  const request = baseRequest({
    generationMode: "img2img",
    denoise: 0.55,
    parentAssetId: "asset_1",
    controlnet: { poseImageDataUrl: null, poseImagePath: "/tmp/pose.png", strength: 1.3, startPercent: 0.1, endPercent: 0.8 }
  });
  const patched = patchUnifiedSwitchWorkflow(
    referenceWorkflow(),
    baseContext(request, { uploadedImageName: "parent_upload.png", uploadedControlImageName: "pose_control.png" }),
    "prefix"
  ) as Record<string, any>;

  assert.equal(patched["770"].inputs.value, true);
  assert.equal(patched["771"].inputs.value, false);
  assert.equal(patched["772"].inputs.value, true);
  assert.equal(patched["762"].inputs.image, "parent_upload.png");
  assert.equal(patched["754"].inputs.image, "pose_control.png");
  assert.equal(patched["752"].inputs.strength, 1.3);
  assert.equal(patched["752"].inputs.start_percent, 0.1);
  assert.equal(patched["752"].inputs.end_percent, 0.8);
  // The apply node's conditioning/image wiring is untouched -- this is the exact failure mode of
  // the dynamic-patch path (ImageScale wired to ["752", 0]) that cannot happen here.
  assert.deepEqual(patched["752"].inputs.image, ["754", 0]);
  assert.deepEqual(patched["752"].inputs.positive, ["748", 0]);
  assert.deepEqual(patched["752"].inputs.negative, ["749", 0]);
});

test("patchUnifiedSwitchWorkflow txt2img x pose ControlNet: parent branch off, controlnet branch on", () => {
  const request = baseRequest({
    controlnet: { poseImageDataUrl: null, poseImagePath: "/tmp/pose.png", strength: 1, startPercent: 0, endPercent: 1 }
  });
  const patched = patchUnifiedSwitchWorkflow(
    referenceWorkflow(),
    baseContext(request, { uploadedControlImageName: "pose_control.png" }),
    "prefix"
  ) as Record<string, any>;

  assert.equal(patched["770"].inputs.value, false);
  assert.equal(patched["772"].inputs.value, true);
  assert.equal(patched["762"].inputs.image, "guruguru-dummy.png");
  assert.equal(patched["754"].inputs.image, "pose_control.png");
});

test("patchUnifiedSwitchWorkflow generationMode=controlnet: the parent image feeds the control-image slot, latent path stays txt2img", () => {
  const request = baseRequest({ generationMode: "controlnet", parentAssetId: "asset_1", controlnet: null });
  const patched = patchUnifiedSwitchWorkflow(
    referenceWorkflow(),
    baseContext(request, { uploadedImageName: "parent_upload.png" }),
    "prefix"
  ) as Record<string, any>;

  assert.equal(patched["770"].inputs.value, false);
  assert.equal(patched["772"].inputs.value, true);
  assert.equal(patched["754"].inputs.image, "parent_upload.png");
  assert.equal(patched["762"].inputs.image, "guruguru-dummy.png");
  // No explicit CN options attached, so the template's own strength/percent values remain.
  assert.equal(patched["752"].inputs.strength, 1);
});

test("reference template: ControlNetApplyAdvanced has the vae connection Chroma/Flux controlnets require", () => {
  // Without this the prompt validates but sampling fails with "This Controlnet needs a VAE but
  // none was provided" (observed live with the Chroma controlnet on 2026-07-03).
  assert.deepEqual(referenceWorkflow()["752"].inputs.vae, ["710", 0]);
});

test("patchUnifiedSwitchWorkflow: restores a missing vae connection on the CN apply node (pre-fix template imports)", () => {
  const template = referenceWorkflow();
  delete template["752"].inputs.vae;
  const request = baseRequest({ generationMode: "controlnet", parentAssetId: "asset_1", controlnet: null });
  const patched = patchUnifiedSwitchWorkflow(
    template,
    baseContext(request, { uploadedImageName: "parent_upload.png" }),
    "prefix"
  ) as Record<string, any>;

  // Wired to the same VAE that feeds the img2img VAEEncode node (761.inputs.vae = ["710", 0]).
  assert.deepEqual(patched["752"].inputs.vae, ["710", 0]);
});

test("patchUnifiedSwitchWorkflow: leaves an existing vae connection on the CN apply node untouched", () => {
  const template = referenceWorkflow();
  template["752"].inputs.vae = ["999", 0];
  template["999"] = { class_type: "VAELoader", inputs: { vae_name: "other.safetensors" } };
  const request = baseRequest({ generationMode: "controlnet", parentAssetId: "asset_1", controlnet: null });
  const patched = patchUnifiedSwitchWorkflow(
    template,
    baseContext(request, { uploadedImageName: "parent_upload.png" }),
    "prefix"
  ) as Record<string, any>;

  assert.deepEqual(patched["752"].inputs.vae, ["999", 0]);
});

test("patchUnifiedSwitchWorkflow: throws when an unused image input has no dummy name to fall back to", () => {
  const request = baseRequest();
  assert.throws(
    () => patchUnifiedSwitchWorkflow(referenceWorkflow(), baseContext(request, { dummyImageName: null }), "prefix"),
    /requires a dummy image name/
  );
});

test("patchWorkflow dispatch: a unified-switch template is patched by value writes only, even with a poisoned roleMap", () => {
  // The roleMap points load_image_input at ControlNetApplyAdvanced.inputs.image -- the stale-DB
  // misinference behind the ComfyUI 400 return_type_mismatch error. The unified path must ignore
  // the roleMap entirely, so the output is byte-identical to patching with an empty roleMap.
  const poisonedRoleMap = {
    load_image_input: "752.inputs.image",
    vae_encode_image_input: "752.inputs.image",
    ksampler_node: "752"
  };
  const request = baseRequest({
    generationMode: "img2img",
    denoise: 0.6,
    parentAssetId: "asset_1",
    controlnet: { poseImageDataUrl: null, poseImagePath: "/tmp/pose.png", strength: 1.2, startPercent: 0, endPercent: 1 }
  });
  const context = baseContext(request, { uploadedImageName: "parent_upload.png", uploadedControlImageName: "pose_control.png" });

  const patchedPoisoned = patchWorkflow(referenceWorkflow(), poisonedRoleMap, context);
  const patchedClean = patchWorkflow(referenceWorkflow(), {}, context);

  assert.deepEqual(patchedPoisoned, patchedClean);
  // And no ImageScale was ever inserted (node set unchanged from the template).
  assert.deepEqual(Object.keys(patchedPoisoned as object).sort(), Object.keys(referenceWorkflow()).sort());
});
