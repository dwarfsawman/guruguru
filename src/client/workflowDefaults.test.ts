import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendUnique,
  defaultModeForTemplate,
  emptyModelDefaults,
  firstStringInput,
  hasAnyInput,
  modelDefaultsFromWorkflow,
  numberFromNodeInput,
  numberFromPath,
  stringFromNodeInput,
  stringFromPath,
  templateGenerationDefaults,
  valueFromNodeInput,
  valueFromPath
} from "./workflowDefaults.ts";
import type { WorkflowTemplate } from "./workflowTypes.ts";

function template(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    id: "tmpl-1",
    name: "Template",
    description: "",
    type: "txt2img",
    version: 1,
    workflowHash: "hash",
    workflowJson: {},
    roleMap: {},
    ...overrides
  };
}

test("defaultModeForTemplate: returns the template's type when it is a known generation mode", () => {
  assert.equal(defaultModeForTemplate(template({ type: "img2img" })), "img2img");
  assert.equal(defaultModeForTemplate(template({ type: "ipadapter" })), "ipadapter");
  assert.equal(defaultModeForTemplate(template({ type: "controlnet" })), "controlnet");
});

test("defaultModeForTemplate: falls back to txt2img for null or unknown types", () => {
  assert.equal(defaultModeForTemplate(null), "txt2img");
  assert.equal(defaultModeForTemplate(template({ type: "hybrid" })), "txt2img");
});

test("emptyModelDefaults: empty arrays and no optional fields", () => {
  const defaults = emptyModelDefaults();
  assert.deepEqual(defaults.textEncoders, []);
  assert.deepEqual(defaults.loras, []);
  assert.equal(defaults.checkpoint, undefined);
  assert.equal(defaults.vae, undefined);
});

test("firstStringInput: returns the first matching non-empty string input", () => {
  assert.equal(firstStringInput({ ckpt_name: "model.safetensors" }, ["ckpt_name", "checkpoint_name"]), "model.safetensors");
  assert.equal(firstStringInput({ checkpoint_name: "alt.safetensors" }, ["ckpt_name", "checkpoint_name"]), "alt.safetensors");
});

test("firstStringInput: skips blank strings and returns undefined when nothing matches", () => {
  assert.equal(firstStringInput({ ckpt_name: "  " }, ["ckpt_name"]), undefined);
  assert.equal(firstStringInput({}, ["ckpt_name"]), undefined);
});

test("hasAnyInput: true when any of the names is a key on inputs", () => {
  assert.equal(hasAnyInput({ clip_name1: "a" }, ["clip_name", "clip_name1"]), true);
  assert.equal(hasAnyInput({}, ["clip_name"]), false);
});

test("appendUnique: appends a defined value once, ignoring duplicates and undefined", () => {
  const values: string[] = [];
  appendUnique(values, "a");
  appendUnique(values, "a");
  appendUnique(values, undefined);
  appendUnique(values, "b");
  assert.deepEqual(values, ["a", "b"]);
});

test("valueFromPath: resolves a dotted path through nested objects", () => {
  const source = { "3": { inputs: { seed: 42 } } };
  assert.equal(valueFromPath(source, "3.inputs.seed"), 42);
});

test("valueFromPath: returns undefined for a missing path, non-string path, or blank path", () => {
  const source = { "3": { inputs: { seed: 42 } } };
  assert.equal(valueFromPath(source, "3.inputs.missing"), undefined);
  assert.equal(valueFromPath(source, "999.inputs.seed"), undefined);
  assert.equal(valueFromPath(source, undefined), undefined);
  assert.equal(valueFromPath(source, ""), undefined);
});

test("stringFromPath / numberFromPath: type-narrow the resolved value", () => {
  const source = { "3": { inputs: { seed: 42, sampler_name: "euler", empty: "" } } };
  assert.equal(stringFromPath(source, "3.inputs.sampler_name"), "euler");
  assert.equal(stringFromPath(source, "3.inputs.seed"), undefined);
  assert.equal(stringFromPath(source, "3.inputs.empty"), undefined);
  assert.equal(numberFromPath(source, "3.inputs.seed"), 42);
  assert.equal(numberFromPath(source, "3.inputs.sampler_name"), undefined);
});

test("valueFromNodeInput: resolves the first matching input name on the referenced node", () => {
  const source = { "3": { inputs: { seed: 42, noise_seed: 7 } } };
  assert.equal(valueFromNodeInput(source, "3", ["seed", "noise_seed"]), 42);
  assert.equal(valueFromNodeInput(source, "3", ["noise_seed"]), 7);
});

test("valueFromNodeInput: undefined for a non-string node id or a node without inputs", () => {
  const source = { "3": { inputs: { seed: 42 } } };
  assert.equal(valueFromNodeInput(source, undefined, ["seed"]), undefined);
  assert.equal(valueFromNodeInput(source, "999", ["seed"]), undefined);
  assert.equal(valueFromNodeInput({ "4": {} }, "4", ["seed"]), undefined);
});

test("stringFromNodeInput / numberFromNodeInput: type-narrow the node input value", () => {
  const source = { "3": { inputs: { sampler_name: "euler", steps: 20 } } };
  assert.equal(stringFromNodeInput(source, "3", ["sampler_name"]), "euler");
  assert.equal(numberFromNodeInput(source, "3", ["steps"]), 20);
  assert.equal(numberFromNodeInput(source, "3", ["sampler_name"]), undefined);
});

test("modelDefaultsFromWorkflow: collects checkpoint, diffusion model, text encoders, vae, and loras", () => {
  const workflow = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd15.safetensors" } },
    "2": { class_type: "UNETLoader", inputs: { unet_name: "flux.safetensors" } },
    "3": { class_type: "DualCLIPLoader", inputs: { clip_name1: "clip1.safetensors", clip_name2: "clip2.safetensors" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: "vae.safetensors" } },
    "5": { class_type: "LoraLoader", inputs: { lora_name: "style.safetensors" } }
  };
  const model = modelDefaultsFromWorkflow(workflow);
  assert.equal(model.checkpoint, "sd15.safetensors");
  assert.equal(model.diffusionModel, "flux.safetensors");
  assert.deepEqual(model.textEncoders, ["clip1.safetensors", "clip2.safetensors"]);
  assert.equal(model.vae, "vae.safetensors");
  assert.deepEqual(model.loras, ["style.safetensors"]);
});

test("modelDefaultsFromWorkflow: ignores nodes without object inputs and dedupes lora names", () => {
  const workflow = {
    "1": { class_type: "Note", inputs: null },
    "2": { class_type: "LoraLoader", inputs: { lora_name: "a.safetensors" } },
    "3": { class_type: "LoraLoader", inputs: { lora_name: "a.safetensors" } }
  };
  const model = modelDefaultsFromWorkflow(workflow);
  assert.deepEqual(model.loras, ["a.safetensors"]);
});

test("templateGenerationDefaults: returns empty model defaults for a null template", () => {
  const defaults = templateGenerationDefaults(null);
  assert.deepEqual(defaults.model, emptyModelDefaults());
  assert.equal(defaults.prompt, undefined);
});

test("templateGenerationDefaults: reads prompt/negativePrompt/sampling fields via role map paths and node fallbacks", () => {
  const workflowJson = {
    "3": {
      class_type: "KSampler",
      inputs: { seed: 99, steps: 25, cfg: 7, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 1 }
    },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 768, batch_size: 2 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat" } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry" } }
  };
  const roleMap = {
    positive_prompt_node: "6",
    negative_prompt_node: "7",
    ksampler_node: "3",
    empty_latent_node: "5"
  };
  const defaults = templateGenerationDefaults(template({ workflowJson, roleMap }));
  assert.equal(defaults.prompt, "a cat");
  assert.equal(defaults.negativePrompt, "blurry");
  assert.equal(defaults.seed, 99);
  assert.equal(defaults.steps, 25);
  assert.equal(defaults.cfg, 7);
  assert.equal(defaults.sampler, "dpmpp_2m");
  assert.equal(defaults.scheduler, "karras");
  assert.equal(defaults.denoise, 1);
  assert.equal(defaults.width, 512);
  assert.equal(defaults.height, 768);
  assert.equal(defaults.batchSize, 2);
});

test("templateGenerationDefaults: prefers explicit *_input role map paths over ksampler node fallback", () => {
  const workflowJson = {
    "3": { class_type: "KSampler", inputs: { seed: 1 } },
    "10": { inputs: { seed: 555 } }
  };
  const roleMap = { seed_input: "10.inputs.seed", ksampler_node: "3" };
  const defaults = templateGenerationDefaults(template({ workflowJson, roleMap }));
  assert.equal(defaults.seed, 555);
});
