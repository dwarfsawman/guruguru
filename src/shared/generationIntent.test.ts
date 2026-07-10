import { test } from "node:test";
import assert from "node:assert/strict";
import { toGenerationIntent } from "./generationIntent.ts";
import type { GenerationRequest } from "./types.ts";

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    templateId: "template-1",
    prompt: "a cat",
    negativePrompt: "blurry",
    seed: 42,
    seedMode: "fixed",
    batchSize: 4,
    steps: 20,
    cfg: 7,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1,
    width: 1024,
    height: 1446,
    generationMode: "txt2img",
    ...overrides
  };
}

test("toGenerationIntent: txt2img has no source/inpaint/identity, empty control/styles, null target", () => {
  const intent = toGenerationIntent(request());
  assert.equal(intent.version, 1);
  assert.deepEqual(intent.prompt, { positive: "a cat", negative: "blurry" });
  assert.deepEqual(intent.canvas, { width: 1024, height: 1446 });
  assert.equal(intent.batchCount, 4);
  assert.deepEqual(intent.seed, { mode: "fixed", value: 42 });
  assert.equal(intent.source, null);
  assert.equal(intent.inpaint, null);
  assert.deepEqual(intent.control, []);
  assert.equal(intent.identity, null);
  assert.deepEqual(intent.styles, []);
  assert.deepEqual(intent.target, { pageId: null, panelId: null });
  assert.deepEqual(intent.sampling, { steps: 20, cfg: 7, sampler: "euler", scheduler: "normal" });
  assert.deepEqual(intent.providerOptions, { comfy: { templateId: "template-1", generationMode: "txt2img" } });
  assert.equal(intent.output, undefined);
});

test("toGenerationIntent: img2img with a resolved parent image path populates source from parentImagePath", () => {
  const intent = toGenerationIntent(
    request({ generationMode: "img2img", denoise: 0.5 }),
    { parentImagePath: "C:/data/project/assets/parent.png" }
  );
  assert.deepEqual(intent.source, { imagePath: "C:/data/project/assets/parent.png", denoise: 0.5 });
});

test("toGenerationIntent: pasteComposite.compositePath wins over parentImagePath", () => {
  const intent = toGenerationIntent(
    request({
      generationMode: "img2img",
      denoise: 0.6,
      pasteComposite: {
        compositePath: "C:/data/project/composites/round_composite.png",
        compositeWidth: 1024,
        compositeHeight: 1446,
        objects: []
      }
    }),
    { parentImagePath: "C:/data/project/assets/parent.png" }
  );
  assert.deepEqual(intent.source, { imagePath: "C:/data/project/composites/round_composite.png", denoise: 0.6 });
});

test("toGenerationIntent: source is null for modes that do not require a parent asset, even if a path is given", () => {
  const intent = toGenerationIntent(request({ generationMode: "txt2img" }), {
    parentImagePath: "C:/data/project/assets/parent.png"
  });
  assert.equal(intent.source, null);
});

test("toGenerationIntent: source is null for a requiresParentAsset mode when neither pasteComposite nor parentImagePath resolve", () => {
  const intent = toGenerationIntent(request({ generationMode: "img2img" }));
  assert.equal(intent.source, null);
});

test("toGenerationIntent: inpaint maps maskPath/maskedContent/padding/feather", () => {
  const intent = toGenerationIntent(
    request({
      generationMode: "img2img",
      inpaint: {
        maskedContent: "fill",
        inpaintArea: "only_masked",
        onlyMaskedPadding: 16,
        featherRadius: 4,
        maskDataUrl: null,
        maskPath: "C:/data/project/masks/round_mask.png"
      }
    })
  );
  assert.deepEqual(intent.inpaint, {
    maskPath: "C:/data/project/masks/round_mask.png",
    maskedContent: "fill",
    padding: 16,
    feather: 4
  });
});

test("toGenerationIntent: inpaint defaults feather to 0 when featherRadius is absent", () => {
  const intent = toGenerationIntent(
    request({
      generationMode: "img2img",
      inpaint: {
        maskedContent: "original",
        inpaintArea: "only_masked",
        onlyMaskedPadding: 32,
        maskDataUrl: null,
        maskPath: "C:/data/project/masks/round_mask.png"
      }
    })
  );
  assert.equal(intent.inpaint?.feather, 0);
});

test("toGenerationIntent: inpaint is null when absent or when maskPath is missing", () => {
  assert.equal(toGenerationIntent(request({ generationMode: "img2img", inpaint: null })).inpaint, null);
  assert.equal(
    toGenerationIntent(
      request({
        generationMode: "img2img",
        inpaint: {
          maskedContent: "original",
          inpaintArea: "only_masked",
          onlyMaskedPadding: 32,
          maskDataUrl: null,
          maskPath: null
        }
      })
    ).inpaint,
    null
  );
});

test("toGenerationIntent: controlnet maps to a single pose control entry", () => {
  const intent = toGenerationIntent(
    request({
      generationMode: "controlnet",
      controlnet: {
        poseImageDataUrl: null,
        poseImagePath: "C:/data/project/control/round_pose.png",
        strength: 0.8,
        startPercent: 0.1,
        endPercent: 0.9
      }
    })
  );
  assert.deepEqual(intent.control, [
    { kind: "pose", imagePath: "C:/data/project/control/round_pose.png", strength: 0.8, range: [0.1, 0.9] }
  ]);
});

test("toGenerationIntent: control is an empty array when controlnet is absent or has no poseImagePath", () => {
  assert.deepEqual(toGenerationIntent(request({ controlnet: null })).control, []);
  assert.deepEqual(
    toGenerationIntent(
      request({
        controlnet: { poseImageDataUrl: null, poseImagePath: null, strength: 1, startPercent: 0, endPercent: 1 }
      })
    ).control,
    []
  );
});

test("toGenerationIntent: identity is set only when reference.face.enabled is true and imagePath is present", () => {
  const enabled = toGenerationIntent(
    request({ reference: { imageDataUrl: null, imagePath: "C:/data/project/reference/round.png", face: { enabled: true } } })
  );
  assert.deepEqual(enabled.identity, { faceImagePath: "C:/data/project/reference/round.png" });

  const disabled = toGenerationIntent(
    request({ reference: { imageDataUrl: null, imagePath: "C:/data/project/reference/round.png", face: { enabled: false } } })
  );
  assert.equal(disabled.identity, null);

  const noImage = toGenerationIntent(
    request({ reference: { imageDataUrl: null, imagePath: null, face: { enabled: true } } })
  );
  assert.equal(noImage.identity, null);

  assert.equal(toGenerationIntent(request({ reference: null })).identity, null);
});

test("toGenerationIntent: styles map loras verbatim (id=name)", () => {
  const intent = toGenerationIntent(
    request({
      loras: [
        { name: "chroma\\Chroma_Voyager_86.safetensors", strength: 0.8 },
        { name: "style_b.safetensors", strength: 1.2 }
      ]
    })
  );
  assert.deepEqual(intent.styles, [
    { id: "chroma\\Chroma_Voyager_86.safetensors", strength: 0.8 },
    { id: "style_b.safetensors", strength: 1.2 }
  ]);
});

test("toGenerationIntent: styles is an empty array when loras is absent", () => {
  assert.deepEqual(toGenerationIntent(request()).styles, []);
  assert.deepEqual(toGenerationIntent(request({ loras: null })).styles, []);
});

test("toGenerationIntent: target carries pageId/panelId when provided, defaulting to null", () => {
  const withTarget = toGenerationIntent(request(), { pageId: "page-1", panelId: "panel-2" });
  assert.deepEqual(withTarget.target, { pageId: "page-1", panelId: "panel-2" });

  const withoutTarget = toGenerationIntent(request());
  assert.deepEqual(withoutTarget.target, { pageId: null, panelId: null });
});

test("toGenerationIntent: seed mode maps reuse_parent_seed to reuse_parent, others pass through", () => {
  assert.equal(toGenerationIntent(request({ seedMode: "fixed" })).seed.mode, "fixed");
  assert.equal(toGenerationIntent(request({ seedMode: "random" })).seed.mode, "random");
  assert.equal(toGenerationIntent(request({ seedMode: "increment" })).seed.mode, "increment");
  assert.equal(toGenerationIntent(request({ seedMode: "reuse_parent_seed" })).seed.mode, "reuse_parent");
});

test("toGenerationIntent: seed value passes through as-is, including null", () => {
  assert.equal(toGenerationIntent(request({ seed: 123 })).seed.value, 123);
  assert.equal(toGenerationIntent(request({ seed: null })).seed.value, null);
});
