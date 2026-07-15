import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationRequest } from "../shared/types";
import {
  buildScriptMangaRepairGenerationRequest,
  parseScriptMangaRepairRequest
} from "./scriptMangaRepair.ts";

const MASK = "data:image/png;base64,iVBORw0KGgo=";

function parentRequest(): GenerationRequest {
  return {
    templateId: "template_parent",
    prompt: "frozen positive prompt",
    negativePrompt: "frozen negative prompt",
    seed: 123,
    seedMode: "random",
    batchSize: 1,
    steps: 30,
    cfg: 4,
    sampler: "er_sde",
    scheduler: "simple",
    denoise: 1,
    width: 1232,
    height: 688,
    generationMode: "txt2img",
    loras: [{ name: "style.safetensors", strength: 0.7 }],
    reference: {
      referenceSet: { setId: "ref_set", version: 2 },
      images: { facePath: "C:/round-local/face.png" },
      face: { enabled: false },
      animaInContext: { enabled: true, strength: 0.8 },
      strict: true
    }
  };
}

test("parseScriptMangaRepairRequest exposes only mask controls and a bounded denoise", () => {
  const parsed = parseScriptMangaRepairRequest({
    assetId: "asset_parent",
    denoise: "0.55",
    prompt: "must be ignored",
    templateId: "must_be_ignored",
    inpaint: { maskDataUrl: MASK, maskedContent: "fill", onlyMaskedPadding: 48, featherRadius: 6 }
  });
  assert.deepEqual(parsed, {
    assetId: "asset_parent",
    denoise: 0.55,
    inpaint: {
      maskDataUrl: MASK,
      maskPath: null,
      maskWidth: null,
      maskHeight: null,
      maskedContent: "fill",
      inpaintArea: "only_masked",
      onlyMaskedPadding: 48,
      featherRadius: 6
    }
  });
});

test("parseScriptMangaRepairRequest rejects missing masks and full-redraw denoise", () => {
  assert.throws(
    () => parseScriptMangaRepairRequest({ assetId: "asset", inpaint: {} }),
    /inpaint\.maskDataUrl is required/
  );
  assert.throws(
    () => parseScriptMangaRepairRequest({ assetId: "asset", denoise: 1, inpaint: { maskDataUrl: MASK } }),
    /less than 1/
  );
  assert.throws(
    () => parseScriptMangaRepairRequest({
      assetId: "asset",
      inpaint: { maskDataUrl: MASK, featherRadius: 31 }
    }),
    /featherRadius must be an integer between 0 and 30/
  );
});

test("buildScriptMangaRepairGenerationRequest freezes parent generation fields and recreates attachments", () => {
  const source = parentRequest();
  source.controlnet = {
    poseImageDataUrl: null,
    poseImagePath: "C:/round-local/pose.png",
    strength: 0.35,
    startPercent: 0,
    endPercent: 0.65
  };
  const repair = parseScriptMangaRepairRequest({
    assetId: "asset_parent",
    inpaint: { maskDataUrl: MASK }
  });
  const request = buildScriptMangaRepairGenerationRequest({
    assetId: "asset_parent",
    width: 1232,
    height: 688,
    seed: 456,
    providerId: "fake",
    request: source,
    poseImageDataUrl: "data:image/png;base64,cG9zZQ=="
  }, repair);

  assert.equal(request.templateId, source.templateId);
  assert.equal(request.prompt, source.prompt);
  assert.equal(request.negativePrompt, source.negativePrompt);
  assert.equal(request.steps, source.steps);
  assert.equal(request.cfg, source.cfg);
  assert.equal(request.sampler, source.sampler);
  assert.equal(request.scheduler, source.scheduler);
  assert.deepEqual(request.loras, source.loras);
  assert.equal(request.generationMode, "img2img");
  assert.equal(request.parentAssetId, "asset_parent");
  assert.equal(request.seed, 456);
  assert.equal(request.denoise, 0.45);
  assert.equal(request.inpaint?.maskDataUrl, MASK);
  assert.deepEqual(request.reference?.referenceSet, { setId: "ref_set", version: 2 });
  assert.equal(request.reference?.imagePath, undefined);
  assert.equal(request.reference?.images, undefined);
  assert.equal(request.controlnet?.poseImageDataUrl, "data:image/png;base64,cG9zZQ==");
  assert.equal(request.pasteComposite, null);
  assert.equal(request.providerId, "fake");
});

test("buildScriptMangaRepairGenerationRequest fails rather than dropping non-reproducible conditioning", () => {
  const source = parentRequest();
  source.reference = {
    imagePath: "C:/round-local/ad-hoc.png",
    face: { enabled: true }
  };
  const repair = parseScriptMangaRepairRequest({ assetId: "asset_parent", inpaint: { maskDataUrl: MASK } });
  const withCopiedReference = buildScriptMangaRepairGenerationRequest({
    assetId: "asset_parent",
    width: 10,
    height: 10,
    seed: null,
    providerId: "fake",
    request: source,
    referenceImageDataUrl: "data:image/png;base64,cmVmZXJlbmNl"
  }, repair);
  assert.equal(withCopiedReference.reference?.imageDataUrl, "data:image/png;base64,cmVmZXJlbmNl");
  assert.equal(withCopiedReference.reference?.imagePath, undefined);

  assert.throws(
    () => buildScriptMangaRepairGenerationRequest({
      assetId: "asset_parent",
      width: 10,
      height: 10,
      seed: null,
      providerId: "fake",
      request: source
    }, repair),
    /reference attachment could not be reproduced/
  );

  source.reference = null;
  source.controlnet = {
    poseImageDataUrl: null,
    poseImagePath: "C:/round-local/pose.png",
    strength: 0.4,
    startPercent: 0,
    endPercent: 0.7
  };
  assert.throws(
    () => buildScriptMangaRepairGenerationRequest({
      assetId: "asset_parent",
      width: 10,
      height: 10,
      seed: null,
      providerId: "fake",
      request: source,
      poseImageDataUrl: null
    }, repair),
    /pose attachment could not be reproduced/
  );

  source.controlnet = null;
  source.seed = null;
  assert.throws(
    () => buildScriptMangaRepairGenerationRequest({
      assetId: "asset_parent",
      width: 10,
      height: 10,
      seed: null,
      providerId: "fake",
      request: source
    }, repair),
    /seed is unavailable/
  );
});
