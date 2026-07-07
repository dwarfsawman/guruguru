import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleFeatureFragments, pruneControlNetBranch, type FeatureFlags } from "./workflowFeatureFragments.ts";

function baseWorkflow(): Record<string, any> {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "model.safetensors" } },
    "2": { class_type: "ModelSamplingAuraFlow", inputs: { shift: 1, model: ["1", 0] } }
  };
}

function flags(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
  return { lora: false, pulid: false, ...overrides };
}

test("assembleFeatureFragments: no-op when every flag is false", () => {
  const workflow = baseWorkflow();
  const patched = assembleFeatureFragments(workflow, flags(), null) as Record<string, any>;

  assert.deepEqual(Object.keys(patched).sort(), ["1", "2"]);
  assert.deepEqual(patched["2"].inputs.model, ["1", 0]);
});

test("assembleFeatureFragments: lora only splices LoraLoaderModelOnly between the base model and ModelSamplingAuraFlow", () => {
  const workflow = baseWorkflow();
  const patched = assembleFeatureFragments(workflow, flags({ lora: true }), null) as Record<string, any>;

  const loraNodeId = patched["2"].inputs.model[0];
  assert.equal(patched[loraNodeId].class_type, "LoraLoaderModelOnly");
  assert.deepEqual(patched[loraNodeId].inputs.model, ["1", 0]);
  assert.equal(patched[loraNodeId].inputs.lora_name, "Hyper-Chroma-low-step-LoRA.safetensors");
  assert.equal(patched[loraNodeId].inputs.strength_model, 1.0);
});

test("assembleFeatureFragments: pulid only wires model/image/prior_image and a shared LoadImage node", () => {
  const workflow = baseWorkflow();
  const patched = assembleFeatureFragments(workflow, flags({ pulid: true }), "ref.png") as Record<string, any>;

  const applyNodeId = patched["2"].inputs.model[0];
  const apply = patched[applyNodeId];
  assert.equal(apply.class_type, "ApplyPulidFlux");
  assert.deepEqual(apply.inputs.model, ["1", 0]);
  assert.equal(patched[apply.inputs.pulid_flux[0]].class_type, "PulidFluxModelLoader");
  assert.equal(patched[apply.inputs.pulid_flux[0]].inputs.pulid_file, "pulid_flux_v0.9.1.safetensors");
  assert.equal(patched[apply.inputs.eva_clip[0]].class_type, "PulidFluxEvaClipLoader");
  assert.equal(patched[apply.inputs.face_analysis[0]].class_type, "PulidFluxInsightFaceLoader");

  const imageNodeId = apply.inputs.image[0];
  assert.equal(patched[imageNodeId].class_type, "LoadImage");
  assert.equal(patched[imageNodeId].inputs.image, "ref.png");
  // image and prior_image share the exact same reference-image node (one shared upload, not two).
  assert.deepEqual(apply.inputs.prior_image, [imageNodeId, 0]);

  assert.equal(apply.inputs.fusion, "train_weight");
  assert.equal(apply.inputs.weight, 1.0);
});

test("assembleFeatureFragments: lora + pulid chain in the documented order and share one reference-image node", () => {
  const workflow = baseWorkflow();
  const patched = assembleFeatureFragments(
    workflow,
    flags({ lora: true, pulid: true }),
    "ref.png"
  ) as Record<string, any>;

  const pulidApplyId = patched["2"].inputs.model[0];
  const pulidApply = patched[pulidApplyId];
  assert.equal(pulidApply.class_type, "ApplyPulidFlux");

  const loraNodeId = pulidApply.inputs.model[0];
  assert.equal(patched[loraNodeId].class_type, "LoraLoaderModelOnly");
  assert.deepEqual(patched[loraNodeId].inputs.model, ["1", 0]);

  // image and prior_image both resolve to the exact same LoadImage node id (one shared upload).
  assert.deepEqual(pulidApply.inputs.prior_image, pulidApply.inputs.image);
  assert.equal(Object.values(patched).filter((n: any) => n.class_type === "LoadImage").length, 1);
});

test("assembleFeatureFragments: throws when pulid is enabled but no reference image name was given", () => {
  assert.throws(
    () => assembleFeatureFragments(baseWorkflow(), flags({ pulid: true }), null),
    /reference image name/
  );
});

test("assembleFeatureFragments: throws when the base template has no ModelSamplingAuraFlow node", () => {
  assert.throws(
    () => assembleFeatureFragments({ "1": { class_type: "UNETLoader", inputs: {} } }, flags({ lora: true }), null),
    /require a ModelSamplingAuraFlow node/
  );
});

function controlNetWorkflow() {
  return {
    G: { class_type: "CFGGuider", inputs: { positive: ["SW_POS", 0], negative: ["SW_NEG", 0] } },
    SW_POS: { class_type: "ComfySwitchNode", inputs: { switch: ["BOOL", 0], on_false: ["POS", 0], on_true: ["APPLY", 0] } },
    SW_NEG: { class_type: "ComfySwitchNode", inputs: { switch: ["BOOL", 0], on_false: ["NEG", 0], on_true: ["APPLY", 1] } },
    BOOL: { class_type: "PrimitiveBoolean", inputs: { value: true } },
    APPLY: {
      class_type: "ControlNetApplyAdvanced",
      inputs: { positive: ["POS", 0], negative: ["NEG", 0], control_net: ["CNLOADER", 0], image: ["CNIMG", 0] }
    },
    CNLOADER: { class_type: "ControlNetLoader", inputs: { control_net_name: "cn.safetensors" } },
    CNIMG: { class_type: "LoadImage", inputs: { image: "pose.png" } },
    POS: { class_type: "CLIPTextEncode", inputs: { text: "" } },
    NEG: { class_type: "CLIPTextEncode", inputs: { text: "" } }
  };
}

const controlNetRoles = {
  guiderNodeId: "G",
  positivePromptNodeId: "POS",
  negativePromptNodeId: "NEG",
  useControlNetBoolNodeId: "BOOL",
  controlNetApplyNodeId: "APPLY",
  controlLoadImageNodeId: "CNIMG"
};

test("pruneControlNetBranch: removes the ControlNet subgraph and rewires the guider straight to the plain prompts", () => {
  const workflow = controlNetWorkflow();
  const roles = pruneControlNetBranch(workflow, controlNetRoles);

  assert.deepEqual((workflow as any).G.inputs.positive, ["POS", 0]);
  assert.deepEqual((workflow as any).G.inputs.negative, ["NEG", 0]);
  for (const removed of ["SW_POS", "SW_NEG", "APPLY", "CNLOADER", "CNIMG", "BOOL"]) {
    assert.equal(removed in workflow, false, `${removed} should have been pruned`);
  }
  assert.deepEqual(Object.keys(workflow).sort(), ["G", "NEG", "POS"]);

  assert.equal(roles.useControlNetBoolNodeId, null);
  assert.equal(roles.controlNetApplyNodeId, null);
  assert.equal(roles.controlLoadImageNodeId, null);
});

test("pruneControlNetBranch: no-op when the template has no ControlNet branch at all", () => {
  const workflow = { G: { class_type: "CFGGuider", inputs: { positive: ["POS", 0], negative: ["NEG", 0] } } };
  const roles = {
    guiderNodeId: "G",
    positivePromptNodeId: "POS",
    negativePromptNodeId: "NEG",
    useControlNetBoolNodeId: null,
    controlNetApplyNodeId: null,
    controlLoadImageNodeId: null
  };

  const result = pruneControlNetBranch(workflow, roles);

  assert.deepEqual(result, roles);
  assert.deepEqual((workflow as any).G.inputs.positive, ["POS", 0]);
});
