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
});

test("patchUnifiedSwitchWorkflow inpaint: rejects maskedContent other than \"original\"", () => {
  const request = baseRequest({
    generationMode: "img2img",
    parentAssetId: "asset_1",
    inpaint: {
      maskedContent: "fill",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 32,
      featherRadius: 0,
      maskDataUrl: null,
      maskPath: "/tmp/mask.png",
      maskWidth: 1232,
      maskHeight: 688
    }
  });

  assert.throws(
    () =>
      patchUnifiedSwitchWorkflow(
        referenceWorkflow(),
        baseContext(request, { uploadedImageName: "parent_upload.png", uploadedMaskName: "mask_upload.png" }),
        "prefix"
      ),
    /supports only maskedContent="original"/
  );
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
