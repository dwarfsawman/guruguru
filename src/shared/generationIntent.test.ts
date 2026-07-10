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

function ctx(overrides: Partial<{ roundId: string; providerId: string; recipeRevision: string | null; pageId: string | null; panelId: string | null }> = {}) {
  return {
    roundId: "round-1",
    providerId: "comfy",
    ...overrides
  };
}

test("toGenerationIntent: txt2img is task=create with no source/inpaint/identity, empty control/styles, project target", () => {
  const intent = toGenerationIntent(request(), ctx());
  assert.equal(intent.version, 2);
  assert.equal(intent.task, "create");
  assert.deepEqual(intent.recipe, { providerId: "comfy", recipeId: "template-1", revision: undefined });
  assert.deepEqual(intent.prompt, { positive: "a cat", negative: "blurry" });
  assert.deepEqual(intent.canvas, { width: 1024, height: 1446 });
  assert.equal(intent.batchCount, 4);
  assert.deepEqual(intent.seed, { mode: "fixed", value: 42 });
  assert.equal(intent.source, null);
  assert.equal(intent.inpaint, null);
  assert.deepEqual(intent.control, []);
  assert.equal(intent.identity, null);
  assert.deepEqual(intent.styles, []);
  assert.deepEqual(intent.target, { kind: "project" });
  assert.deepEqual(intent.sampling, { steps: 20, cfg: 7, sampler: "euler", scheduler: "normal" });
  assert.deepEqual(intent.providerOptions, { comfy: { templateId: "template-1", generationMode: "txt2img" } });
  assert.equal(intent.output, undefined);
});

test("toGenerationIntent: recipe.revision carries recipeRevision when provided", () => {
  const intent = toGenerationIntent(request(), ctx({ recipeRevision: "3" }));
  assert.equal(intent.recipe.revision, "3");
});

test("toGenerationIntent: seed_reuse and prompt_reuse are task=create, like txt2img", () => {
  assert.equal(toGenerationIntent(request({ generationMode: "seed_reuse" }), ctx()).task, "create");
  assert.equal(toGenerationIntent(request({ generationMode: "prompt_reuse" }), ctx()).task, "create");
});

test("toGenerationIntent: upscale/detail map to their own task values", () => {
  assert.equal(toGenerationIntent(request({ generationMode: "upscale" }), ctx()).task, "upscale");
  assert.equal(toGenerationIntent(request({ generationMode: "detail" }), ctx()).task, "detail");
});

test("toGenerationIntent: img2img without a mask is task=transform and populates source from parentAssetId", () => {
  const intent = toGenerationIntent(
    request({ generationMode: "img2img", denoise: 0.5, parentAssetId: "asset-1" }),
    ctx({ roundId: "round-42" })
  );
  assert.equal(intent.task, "transform");
  assert.deepEqual(intent.source, { image: { kind: "asset", assetId: "asset-1" }, denoise: 0.5 });
});

test("toGenerationIntent: img2img with an inpaint mask is task=inpaint", () => {
  const intent = toGenerationIntent(
    request({
      generationMode: "img2img",
      parentAssetId: "asset-1",
      inpaint: {
        maskedContent: "fill",
        inpaintArea: "only_masked",
        onlyMaskedPadding: 16,
        featherRadius: 4,
        maskDataUrl: null,
        maskPath: "C:/data/project/masks/round_mask.png"
      }
    }),
    ctx()
  );
  assert.equal(intent.task, "inpaint");
});

test("toGenerationIntent: pasteComposite wins over parentAssetId and resolves to a roundAttachment composite ref", () => {
  const intent = toGenerationIntent(
    request({
      generationMode: "img2img",
      denoise: 0.6,
      parentAssetId: "asset-1",
      pasteComposite: {
        compositePath: "C:/data/project/composites/round_composite.png",
        compositeWidth: 1024,
        compositeHeight: 1446,
        objects: []
      }
    }),
    ctx({ roundId: "round-9" })
  );
  assert.deepEqual(intent.source, {
    image: { kind: "roundAttachment", roundId: "round-9", attachment: "composite" },
    denoise: 0.6
  });
});

test("toGenerationIntent: source is null for modes that do not use the parent image as a VAEEncode source", () => {
  assert.equal(toGenerationIntent(request({ generationMode: "txt2img", parentAssetId: "asset-1" }), ctx()).source, null);
  assert.equal(
    toGenerationIntent(request({ generationMode: "ipadapter", parentAssetId: "asset-1" }), ctx()).source,
    null
  );
  assert.equal(
    toGenerationIntent(request({ generationMode: "controlnet", parentAssetId: "asset-1" }), ctx()).source,
    null
  );
});

test("toGenerationIntent: source is null for img2img when neither pasteComposite nor parentAssetId are present", () => {
  const intent = toGenerationIntent(request({ generationMode: "img2img" }), ctx());
  assert.equal(intent.source, null);
});

test("toGenerationIntent: inpaint maps to a roundAttachment mask ref with maskedContent/padding/feather", () => {
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
    }),
    ctx({ roundId: "round-7" })
  );
  assert.deepEqual(intent.inpaint, {
    mask: { kind: "roundAttachment", roundId: "round-7", attachment: "mask" },
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
    }),
    ctx()
  );
  assert.equal(intent.inpaint?.feather, 0);
});

test("toGenerationIntent: inpaint is null when absent or when maskPath is missing", () => {
  assert.equal(toGenerationIntent(request({ generationMode: "img2img", inpaint: null }), ctx()).inpaint, null);
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
      }),
      ctx()
    ).inpaint,
    null
  );
});

test("toGenerationIntent: controlnet with a pose draft maps to a single roundAttachment pose control entry", () => {
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
    }),
    ctx({ roundId: "round-3" })
  );
  assert.deepEqual(intent.control, [
    {
      kind: "pose",
      image: { kind: "roundAttachment", roundId: "round-3", attachment: "pose" },
      strength: 0.8,
      range: [0.1, 0.9]
    }
  ]);
});

test("toGenerationIntent: controlnet without a pose draft uses the parent asset as the control image (S1 review issue 2)", () => {
  const intent = toGenerationIntent(
    request({ generationMode: "controlnet", parentAssetId: "asset-77", controlnet: null }),
    ctx()
  );
  assert.deepEqual(intent.control, [
    { kind: "pose", image: { kind: "asset", assetId: "asset-77" }, strength: 1, range: [0, 1] }
  ]);
  // ...and does NOT get mis-recorded as an img2img-style source (the historical bug).
  assert.equal(intent.source, null);
});

test("toGenerationIntent: control is empty when generationMode is not controlnet, even with a pose draft", () => {
  assert.deepEqual(
    toGenerationIntent(
      request({
        generationMode: "img2img",
        controlnet: { poseImageDataUrl: null, poseImagePath: "C:/data/pose.png", strength: 1, startPercent: 0, endPercent: 1 }
      }),
      ctx()
    ).control,
    []
  );
});

test("toGenerationIntent: control is empty for controlnet mode with neither a pose draft nor a parent asset", () => {
  assert.deepEqual(toGenerationIntent(request({ generationMode: "controlnet", controlnet: null }), ctx()).control, []);
});

test("toGenerationIntent: identity is set from PuLID reference when reference.face.enabled and imagePath are present", () => {
  const enabled = toGenerationIntent(
    request({ reference: { imageDataUrl: null, imagePath: "C:/data/project/reference/round.png", face: { enabled: true } } }),
    ctx({ roundId: "round-5" })
  );
  assert.deepEqual(enabled.identity, { face: { kind: "roundAttachment", roundId: "round-5", attachment: "reference" } });

  const disabled = toGenerationIntent(
    request({ reference: { imageDataUrl: null, imagePath: "C:/data/project/reference/round.png", face: { enabled: false } } }),
    ctx()
  );
  assert.equal(disabled.identity, null);

  const noImage = toGenerationIntent(request({ reference: { imageDataUrl: null, imagePath: null, face: { enabled: true } } }), ctx());
  assert.equal(noImage.identity, null);

  assert.equal(toGenerationIntent(request({ reference: null }), ctx()).identity, null);
});

test("toGenerationIntent: ipadapter mode falls back to the parent asset as identity when there is no PuLID reference (S1 review issue 2)", () => {
  const intent = toGenerationIntent(request({ generationMode: "ipadapter", parentAssetId: "asset-9" }), ctx());
  assert.deepEqual(intent.identity, { face: { kind: "asset", assetId: "asset-9" } });
  assert.equal(intent.source, null);
});

test("toGenerationIntent: PuLID reference takes priority over the ipadapter parent-asset fallback", () => {
  const intent = toGenerationIntent(
    request({
      generationMode: "ipadapter",
      parentAssetId: "asset-9",
      reference: { imageDataUrl: null, imagePath: "C:/data/reference.png", face: { enabled: true } }
    }),
    ctx({ roundId: "round-11" })
  );
  assert.deepEqual(intent.identity, { face: { kind: "roundAttachment", roundId: "round-11", attachment: "reference" } });
});

test("toGenerationIntent: styles map loras verbatim (id=name)", () => {
  const intent = toGenerationIntent(
    request({
      loras: [
        { name: "chroma\\Chroma_Voyager_86.safetensors", strength: 0.8 },
        { name: "style_b.safetensors", strength: 1.2 }
      ]
    }),
    ctx()
  );
  assert.deepEqual(intent.styles, [
    { id: "chroma\\Chroma_Voyager_86.safetensors", strength: 0.8 },
    { id: "style_b.safetensors", strength: 1.2 }
  ]);
});

test("toGenerationIntent: styles is an empty array when loras is absent", () => {
  assert.deepEqual(toGenerationIntent(request(), ctx()).styles, []);
  assert.deepEqual(toGenerationIntent(request({ loras: null }), ctx()).styles, []);
});

test("toGenerationIntent: target is a discriminated union over project/page/panel", () => {
  assert.deepEqual(toGenerationIntent(request(), ctx()).target, { kind: "project" });
  assert.deepEqual(toGenerationIntent(request(), ctx({ pageId: "page-1" })).target, { kind: "page", pageId: "page-1" });
  assert.deepEqual(
    toGenerationIntent(request(), ctx({ pageId: "page-1", panelId: "panel-2" })).target,
    { kind: "panel", pageId: "page-1", panelId: "panel-2" }
  );
  // panelId without pageId should not happen in practice (rounds.ts requires pageId), but degrade to project.
  assert.deepEqual(toGenerationIntent(request(), ctx({ panelId: "panel-2" })).target, { kind: "project" });
});

test("toGenerationIntent: seed mode maps reuse_parent_seed to reuse_parent, others pass through", () => {
  assert.equal(toGenerationIntent(request({ seedMode: "fixed" }), ctx()).seed.mode, "fixed");
  assert.equal(toGenerationIntent(request({ seedMode: "random" }), ctx()).seed.mode, "random");
  assert.equal(toGenerationIntent(request({ seedMode: "increment" }), ctx()).seed.mode, "increment");
  assert.equal(toGenerationIntent(request({ seedMode: "reuse_parent_seed" }), ctx()).seed.mode, "reuse_parent");
});

test("toGenerationIntent: seed value passes through as-is, including null", () => {
  assert.equal(toGenerationIntent(request({ seed: 123 }), ctx()).seed.value, 123);
  assert.equal(toGenerationIntent(request({ seed: null }), ctx()).seed.value, null);
});
