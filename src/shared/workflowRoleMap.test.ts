import { test } from "node:test";
import assert from "node:assert/strict";
import { inferRoleMap, validateRoleMapReferences } from "./workflowRoleMap.ts";

function sampleWorkflow() {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: 1,
        steps: 20,
        cfg: 6,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        latent_image: ["5", 0]
      },
      _meta: { title: "KSampler" }
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: 1024, height: 1024, batch_size: 1 },
      _meta: { title: "Empty Latent Image" }
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: "a cat" },
      _meta: { title: "Positive Prompt" }
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: "blurry" },
      _meta: { title: "Negative Prompt" }
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "out", images: ["8", 0] },
      _meta: { title: "Save Image" }
    },
    "12": {
      class_type: "LoadImage",
      inputs: { image: "input.png" },
      _meta: { title: "Load Image" }
    },
    "13": {
      class_type: "VAEEncode",
      inputs: { pixels: ["12", 0], vae: ["4", 0] },
      _meta: { title: "VAE Encode" }
    }
  };
}

test("inferRoleMap: returns empty object for non-object input", () => {
  assert.deepEqual(inferRoleMap(null), {});
  assert.deepEqual(inferRoleMap("not an object"), {});
  assert.deepEqual(inferRoleMap([1, 2, 3]), {});
});

test("inferRoleMap: identifies positive/negative prompt nodes by title hint", () => {
  const roleMap = inferRoleMap(sampleWorkflow());
  assert.equal(roleMap.positive_prompt_node, "6");
  assert.equal(roleMap.negative_prompt_node, "7");
});

test("inferRoleMap: maps sampler-related inputs to dotted paths", () => {
  const roleMap = inferRoleMap(sampleWorkflow());
  assert.equal(roleMap.seed_input, "3.inputs.seed");
  assert.equal(roleMap.cfg_input, "3.inputs.cfg");
  assert.equal(roleMap.steps_input, "3.inputs.steps");
  assert.equal(roleMap.denoise_input, "3.inputs.denoise");
  assert.equal(roleMap.sampler_input, "3.inputs.sampler_name");
  assert.equal(roleMap.scheduler_input, "3.inputs.scheduler");
  assert.equal(roleMap.ksampler_latent_image_input, "3.inputs.latent_image");
});

test("inferRoleMap: maps latent size/batch inputs", () => {
  const roleMap = inferRoleMap(sampleWorkflow());
  assert.equal(roleMap.width_input, "5.inputs.width");
  assert.equal(roleMap.height_input, "5.inputs.height");
  assert.equal(roleMap.batch_size_input, "5.inputs.batch_size");
});

test("inferRoleMap: maps load image / vae encode / save image nodes", () => {
  const roleMap = inferRoleMap(sampleWorkflow());
  assert.equal(roleMap.load_image_input, "12.inputs.image");
  assert.equal(roleMap.vae_encode_node, "13");
  assert.equal(roleMap.vae_encode_image_input, "13.inputs.pixels");
  assert.equal(roleMap.save_image_node, "9");
  assert.equal(roleMap.save_prefix_input, "9.inputs.filename_prefix");
});

test("inferRoleMap: falls back to RepeatLatentBatch for batch size when no EmptyLatent batch_size present", () => {
  const workflow = {
    "1": {
      class_type: "RepeatLatentBatch",
      inputs: { amount: 4, samples: ["2", 0] },
      _meta: { title: "Repeat Latent Batch" }
    }
  };
  const roleMap = inferRoleMap(workflow);
  assert.equal(roleMap.repeat_latent_batch_node, "1");
  assert.equal(roleMap.repeat_latent_batch_amount_input, "1.inputs.amount");
  assert.equal(roleMap.batch_size_input, "1.inputs.amount");
  assert.equal(roleMap.repeat_latent_batch_samples_input, "1.inputs.samples");
});

test("validateRoleMapReferences: throws when workflowJson is not an object", () => {
  assert.throws(() => validateRoleMapReferences(null, {}), /workflow JSON must be an API-format JSON object/);
});

test("validateRoleMapReferences: throws when roleMap is not an object", () => {
  assert.throws(() => validateRoleMapReferences({}, null), /role map must be a JSON object/);
});

test("validateRoleMapReferences: passes for valid node and path references", () => {
  const workflow = sampleWorkflow();
  assert.doesNotThrow(() =>
    validateRoleMapReferences(workflow, {
      save_image_node: "9",
      seed_input: "3.inputs.seed"
    })
  );
});

test("validateRoleMapReferences: skips empty/non-string values", () => {
  const workflow = sampleWorkflow();
  assert.doesNotThrow(() =>
    validateRoleMapReferences(workflow, {
      save_image_node: "",
      seed_input: undefined,
      cfg_input: 5
    })
  );
});

test("validateRoleMapReferences: throws for missing *_node reference", () => {
  const workflow = sampleWorkflow();
  assert.throws(
    () => validateRoleMapReferences(workflow, { save_image_node: "999" }),
    /Role map node was not found: 999/
  );
});

test("validateRoleMapReferences: throws for *_input path with fewer than 2 segments", () => {
  const workflow = sampleWorkflow();
  assert.throws(
    () => validateRoleMapReferences(workflow, { seed_input: "3" }),
    /Invalid role map path: 3/
  );
});

test("validateRoleMapReferences: throws when *_input path segment is not found", () => {
  const workflow = sampleWorkflow();
  assert.throws(
    () => validateRoleMapReferences(workflow, { seed_input: "999.inputs.seed" }),
    /Role map path was not found: 999\.inputs\.seed/
  );
});

test("validateRoleMapReferences: throws when *_input path does not resolve to an object", () => {
  const workflow = sampleWorkflow();
  assert.throws(
    () => validateRoleMapReferences(workflow, { seed_input: "3.inputs.seed.value" }),
    /Role map path does not resolve to an object: 3\.inputs\.seed\.value/
  );
});

// Reduced form of the reference ControlNet workflow (Docs/ReferenceFlows/ComfyUI_00147_controlnet.json):
// no VAEEncode node exists, and ControlNetApplyAdvanced(752) reads its control image from a
// LoadImage(754) node. Before the fix, inferRoleMap's unrestricted vae_encode_image_input fallback
// misinferred 752.inputs.image as vae_encode_image_input, and load_image_input pointed at 754.
function controlNetWorkflowWithoutVaeEncode() {
  return {
    ...sampleWorkflowWithoutVaeEncode(),
    "752": {
      class_type: "ControlNetApplyAdvanced",
      inputs: {
        strength: 1,
        start_percent: 0,
        end_percent: 1,
        positive: ["6", 0],
        negative: ["7", 0],
        control_net: ["753", 0],
        image: ["754", 0]
      },
      _meta: { title: "Apply ControlNet" }
    },
    "753": {
      class_type: "ControlNetLoader",
      inputs: { control_net_name: "control.safetensors" },
      _meta: { title: "Load ControlNet Model" }
    },
    "754": {
      class_type: "LoadImage",
      inputs: { image: "old_control.png" },
      _meta: { title: "Load Image" }
    }
  };
}

function sampleWorkflowWithoutVaeEncode() {
  const workflow = sampleWorkflow() as Record<string, unknown>;
  const { "13": _vaeEncode, ...rest } = workflow;
  return rest;
}

test("inferRoleMap: without a VAEEncode node, vae_encode_image_input is NOT inferred (no unrestricted fallback onto ControlNetApplyAdvanced.inputs.image)", () => {
  const roleMap = inferRoleMap(controlNetWorkflowWithoutVaeEncode());
  assert.equal(roleMap.vae_encode_image_input, undefined);
  assert.equal(roleMap.vae_encode_node, undefined);
});

test("inferRoleMap: load_image_input does not point at the LoadImage feeding ControlNetApplyAdvanced.inputs.image", () => {
  const roleMap = inferRoleMap(controlNetWorkflowWithoutVaeEncode());
  // The only other LoadImage in this fixture is node 12 (from sampleWorkflow's img2img LoadImage).
  assert.equal(roleMap.load_image_input, "12.inputs.image");
});

test("inferRoleMap: infers controlnet_image_node by tracing ControlNetApplyAdvanced.inputs.image to its LoadImage source", () => {
  const roleMap = inferRoleMap(controlNetWorkflowWithoutVaeEncode());
  assert.equal(roleMap.controlnet_image_node, "754");
});

test("inferRoleMap: controlnet_image_node is not set when ControlNetApplyAdvanced.inputs.image is not a LoadImage connection", () => {
  const workflow = controlNetWorkflowWithoutVaeEncode() as Record<string, any>;
  workflow["752"].inputs.image = null;
  const roleMap = inferRoleMap(workflow);
  assert.equal(roleMap.controlnet_image_node, undefined);
});

test("inferRoleMap: a VAEEncode node elsewhere in a ControlNet workflow is still inferred normally", () => {
  const workflow = {
    ...controlNetWorkflowWithoutVaeEncode(),
    "13": sampleWorkflow()["13"]
  };
  const roleMap = inferRoleMap(workflow);
  assert.equal(roleMap.vae_encode_node, "13");
  assert.equal(roleMap.vae_encode_image_input, "13.inputs.pixels");
});
