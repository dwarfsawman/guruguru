import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultDenoiseForMode,
  normalizeDenoiseForMode,
  relationForGenerationMode,
  requiresFullDenoise,
  requiresParentAsset
} from "./generationMode.ts";

test("requiresFullDenoise: true for txt2img/seed_reuse/prompt_reuse", () => {
  assert.equal(requiresFullDenoise("txt2img"), true);
  assert.equal(requiresFullDenoise("seed_reuse"), true);
  assert.equal(requiresFullDenoise("prompt_reuse"), true);
});

test("requiresFullDenoise: false for other modes", () => {
  assert.equal(requiresFullDenoise("img2img"), false);
  assert.equal(requiresFullDenoise("ipadapter"), false);
  assert.equal(requiresFullDenoise("controlnet"), false);
  assert.equal(requiresFullDenoise("upscale"), false);
  assert.equal(requiresFullDenoise("detail"), false);
  assert.equal(requiresFullDenoise("manual_upload"), false);
});

test("defaultDenoiseForMode: 1 when full denoise required", () => {
  assert.equal(defaultDenoiseForMode("txt2img"), 1);
  assert.equal(defaultDenoiseForMode("seed_reuse"), 1);
  assert.equal(defaultDenoiseForMode("prompt_reuse"), 1);
});

test("defaultDenoiseForMode: 0.8 for img2img", () => {
  assert.equal(defaultDenoiseForMode("img2img"), 0.8);
});

test("defaultDenoiseForMode: 0.45 for other modes", () => {
  assert.equal(defaultDenoiseForMode("ipadapter"), 0.45);
  assert.equal(defaultDenoiseForMode("controlnet"), 0.45);
  assert.equal(defaultDenoiseForMode("upscale"), 0.45);
  assert.equal(defaultDenoiseForMode("detail"), 0.45);
  assert.equal(defaultDenoiseForMode("manual_upload"), 0.45);
});

test("normalizeDenoiseForMode: forces 1 for full-denoise modes regardless of input", () => {
  assert.equal(normalizeDenoiseForMode(0.2, "txt2img"), 1);
  assert.equal(normalizeDenoiseForMode(0, "seed_reuse"), 1);
});

test("normalizeDenoiseForMode: falls back to mode default when not finite", () => {
  assert.equal(normalizeDenoiseForMode(NaN, "img2img"), 0.8);
  assert.equal(normalizeDenoiseForMode(Infinity, "detail"), 0.45);
});

test("normalizeDenoiseForMode: clamps to [0, 1]", () => {
  assert.equal(normalizeDenoiseForMode(-1, "img2img"), 0);
  assert.equal(normalizeDenoiseForMode(5, "img2img"), 1);
  assert.equal(normalizeDenoiseForMode(0.6, "img2img"), 0.6);
});

test("requiresParentAsset: true for img2img/ipadapter/controlnet", () => {
  assert.equal(requiresParentAsset("img2img"), true);
  assert.equal(requiresParentAsset("ipadapter"), true);
  assert.equal(requiresParentAsset("controlnet"), true);
});

test("requiresParentAsset: false for other modes", () => {
  assert.equal(requiresParentAsset("txt2img"), false);
  assert.equal(requiresParentAsset("seed_reuse"), false);
  assert.equal(requiresParentAsset("upscale"), false);
});

test("relationForGenerationMode: maps each known mode", () => {
  assert.equal(relationForGenerationMode("ipadapter"), "ipadapter_reference");
  assert.equal(relationForGenerationMode("controlnet"), "controlnet_reference");
  assert.equal(relationForGenerationMode("seed_reuse"), "seed_reuse");
  assert.equal(relationForGenerationMode("prompt_reuse"), "prompt_reuse");
  assert.equal(relationForGenerationMode("upscale"), "upscale");
  assert.equal(relationForGenerationMode("detail"), "detailer");
});

test("relationForGenerationMode: falls back to img2img for txt2img/img2img/unknown", () => {
  assert.equal(relationForGenerationMode("img2img"), "img2img");
  assert.equal(relationForGenerationMode("txt2img"), "img2img");
  assert.equal(relationForGenerationMode("manual_upload"), "img2img");
});
