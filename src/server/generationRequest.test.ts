import { test } from "node:test";
import assert from "node:assert/strict";
import { clampInteger, maxBatchSize, normalizeGenerationRequest } from "./generationRequest.ts";
import { HttpError } from "./http.ts";
import type { GenerationRequest } from "../shared/types.ts";

function baseInput(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    templateId: "tmpl-1",
    prompt: "a cat",
    negativePrompt: "blurry",
    seed: 123,
    seedMode: "fixed",
    batchSize: 4,
    steps: 20,
    cfg: 6,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1,
    width: 1024,
    height: 1024,
    generationMode: "txt2img",
    ...overrides
  };
}

test("clampInteger: passes values within range through (truncated)", () => {
  assert.equal(clampInteger(5.9, 1, 10), 5);
  assert.equal(clampInteger(5, 1, 10), 5);
});

test("clampInteger: clamps below min and above max", () => {
  assert.equal(clampInteger(-3, 1, 10), 1);
  assert.equal(clampInteger(99, 1, 10), 10);
});

test("clampInteger: returns min for non-finite values", () => {
  assert.equal(clampInteger(NaN, 2, 10), 2);
  assert.equal(clampInteger(Infinity, 2, 10), 2);
});

test("normalizeGenerationRequest: style loras drop blank names, clamp strength to 0..2, and cap at 4", () => {
  const result = normalizeGenerationRequest(baseInput({
    loras: [
      { name: "chroma\\A.safetensors", strength: 0.8 },
      { name: "  ", strength: 1 },                     // blank name -> dropped
      { name: "chroma\\B.safetensors", strength: 5 },  // strength clamped to 2
      { name: "chroma\\C.safetensors", strength: -3 }, // clamped to 0
      { name: "chroma\\D.safetensors", strength: 1 },
      { name: "chroma\\E.safetensors", strength: 1 }   // 5th valid -> dropped by cap(4)
    ] as unknown as GenerationRequest["loras"]
  }));

  assert.deepEqual(result.loras, [
    { name: "chroma\\A.safetensors", strength: 0.8 },
    { name: "chroma\\B.safetensors", strength: 2 },
    { name: "chroma\\C.safetensors", strength: 0 },
    { name: "chroma\\D.safetensors", strength: 1 }
  ]);
});

test("normalizeGenerationRequest: style loras default to [] when absent or non-array", () => {
  assert.deepEqual(normalizeGenerationRequest(baseInput()).loras, []);
  assert.deepEqual(normalizeGenerationRequest(baseInput({ loras: "nope" as unknown as GenerationRequest["loras"] })).loras, []);
});

test("maxBatchSize: is 32", () => {
  assert.equal(maxBatchSize, 32);
});

test("normalizeGenerationRequest: requires a non-empty templateId", () => {
  assert.throws(() => normalizeGenerationRequest(baseInput({ templateId: "" })), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, 400);
    return true;
  });
});

test("normalizeGenerationRequest: defaults generationMode to txt2img when unset", () => {
  const input = baseInput();
  // @ts-expect-error simulate an unset generationMode from a loose caller
  delete input.generationMode;
  const result = normalizeGenerationRequest(input);
  assert.equal(result.generationMode, "txt2img");
});

test("normalizeGenerationRequest: clamps batchSize into [1, maxBatchSize]", () => {
  assert.equal(normalizeGenerationRequest(baseInput({ batchSize: 999 })).batchSize, maxBatchSize);
  assert.equal(normalizeGenerationRequest(baseInput({ batchSize: 0 })).batchSize, 1);
  assert.equal(normalizeGenerationRequest(baseInput({ batchSize: 8 })).batchSize, 8);
});

test("normalizeGenerationRequest: strips _karras suffix from sampler and sets scheduler to karras when scheduler is normal", () => {
  const result = normalizeGenerationRequest(baseInput({ sampler: "dpmpp_2m_karras", scheduler: "normal" }));
  assert.equal(result.sampler, "dpmpp_2m");
  assert.equal(result.scheduler, "karras");
});

test("normalizeGenerationRequest: _karras suffix does not override a non-normal scheduler", () => {
  const result = normalizeGenerationRequest(baseInput({ sampler: "euler_karras", scheduler: "exponential" }));
  assert.equal(result.sampler, "euler");
  assert.equal(result.scheduler, "exponential");
});

test("normalizeGenerationRequest: forces denoise to 1 for full-denoise modes", () => {
  const result = normalizeGenerationRequest(baseInput({ generationMode: "txt2img", denoise: 0.2 }));
  assert.equal(result.denoise, 1);
});

test("normalizeGenerationRequest: normalizes denoise for img2img using default when input is not finite", () => {
  const input = baseInput({ generationMode: "img2img" });
  // @ts-expect-error simulate a caller passing a non-numeric denoise
  input.denoise = "not-a-number";
  const result = normalizeGenerationRequest(input);
  assert.equal(result.denoise, 0.35);
});

test("normalizeGenerationRequest: seed passes through only when a finite number", () => {
  assert.equal(normalizeGenerationRequest(baseInput({ seed: 42 })).seed, 42);
  assert.equal(normalizeGenerationRequest(baseInput({ seed: null })).seed, null);
  assert.equal(normalizeGenerationRequest(baseInput({ seed: NaN })).seed, null);
});

test("normalizeGenerationRequest: relationType falls back to relationForGenerationMode(mode) when unset", () => {
  const result = normalizeGenerationRequest(baseInput({ generationMode: "ipadapter", relationType: null }));
  assert.equal(result.relationType, "ipadapter_reference");
});

test("normalizeGenerationRequest: relationType passed explicitly is preserved", () => {
  const result = normalizeGenerationRequest(baseInput({ generationMode: "img2img", relationType: "manual" }));
  assert.equal(result.relationType, "manual");
});

test("normalizeGenerationRequest: parentAssetId defaults to null when blank", () => {
  assert.equal(normalizeGenerationRequest(baseInput({ parentAssetId: "" })).parentAssetId, null);
  assert.equal(normalizeGenerationRequest(baseInput({ parentAssetId: "asset-1" })).parentAssetId, "asset-1");
});

test("normalizeGenerationRequest: width/height fall back to 1024 and are clamped to positive integers", () => {
  const input = baseInput();
  // @ts-expect-error simulate a caller passing a non-numeric width
  input.width = "bad";
  const result = normalizeGenerationRequest(input);
  assert.equal(result.width, 1024);
  assert.equal(normalizeGenerationRequest(baseInput({ width: 512.7 })).width, 512);
});
