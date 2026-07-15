import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANIMA_INPAINT_LLLITE_FILE,
  ANIMA_IN_CONTEXT_LORA_FILE,
  ANIMA_IN_CONTEXT_MODEL_REQUIREMENTS,
  ANIMA_IN_CONTEXT_NODE_PACKS,
  ANIMA_POSE_LLLITE_FILE,
  assembleFeatureFragments,
  pruneControlNetBranch,
  type FeatureFlags
} from "./workflowFeatureFragments.ts";

function baseWorkflow(): Record<string, any> {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "model.safetensors" } },
    "2": { class_type: "ModelSamplingAuraFlow", inputs: { shift: 1, model: ["1", 0] } }
  };
}

function flags(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
  return { pulid: false, animaInpaint: false, animaControlnet: false, animaInContext: false, ...overrides };
}

test("assembleFeatureFragments: no-op when every flag is false", () => {
  const workflow = baseWorkflow();
  const patched = assembleFeatureFragments(workflow, flags(), null) as Record<string, any>;

  assert.deepEqual(Object.keys(patched).sort(), ["1", "2"]);
  assert.deepEqual(patched["2"].inputs.model, ["1", 0]);
});

test("assembleFeatureFragments: style loras splice LoraLoaderModelOnly nodes in request order between the base model and ModelSamplingAuraFlow", () => {
  const workflow = baseWorkflow();
  const patched = assembleFeatureFragments(workflow, flags(), null, [
    { name: "chroma\\A.safetensors", strength: 0.8 },
    { name: "chroma\\B.safetensors", strength: 1.2 }
  ]) as Record<string, any>;

  // Chain: base UNETLoader -> A -> B -> ModelSamplingAuraFlow (request order, last one nearest sampler).
  const bNodeId = patched["2"].inputs.model[0];
  assert.equal(patched[bNodeId].class_type, "LoraLoaderModelOnly");
  assert.equal(patched[bNodeId].inputs.lora_name, "chroma\\B.safetensors");
  assert.equal(patched[bNodeId].inputs.strength_model, 1.2);

  const aNodeId = patched[bNodeId].inputs.model[0];
  assert.equal(patched[aNodeId].class_type, "LoraLoaderModelOnly");
  assert.equal(patched[aNodeId].inputs.lora_name, "chroma\\A.safetensors");
  assert.equal(patched[aNodeId].inputs.strength_model, 0.8);
  assert.deepEqual(patched[aNodeId].inputs.model, ["1", 0]);
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

test("assembleFeatureFragments: style lora + pulid chain in the documented order (LoRA before PuLID)", () => {
  const workflow = baseWorkflow();
  const patched = assembleFeatureFragments(
    workflow,
    flags({ pulid: true }),
    "ref.png",
    [{ name: "chroma\\Style.safetensors", strength: 1.0 }]
  ) as Record<string, any>;

  const pulidApplyId = patched["2"].inputs.model[0];
  const pulidApply = patched[pulidApplyId];
  assert.equal(pulidApply.class_type, "ApplyPulidFlux");

  const loraNodeId = pulidApply.inputs.model[0];
  assert.equal(patched[loraNodeId].class_type, "LoraLoaderModelOnly");
  assert.equal(patched[loraNodeId].inputs.lora_name, "chroma\\Style.safetensors");
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

test("assembleFeatureFragments: throws when the base template has no model consumer", () => {
  assert.throws(
    () => assembleFeatureFragments({ "1": { class_type: "UNETLoader", inputs: {} } }, flags(), null, [{ name: "x.safetensors", strength: 1 }]),
    /require a ModelSamplingAuraFlow or CFGGuider/
  );
});

test("assembleFeatureFragments: Anima LoRA rewires CFGGuider and both schedulers", () => {
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "anima-base-v1.0.safetensors" } },
    "2": { class_type: "CFGGuider", inputs: { model: ["1", 0] } },
    "3": { class_type: "BasicScheduler", inputs: { model: ["1", 0] } },
    "4": { class_type: "BasicScheduler", inputs: { model: ["1", 0] } }
  };

  const patched = assembleFeatureFragments(workflow, flags(), null, [
    { name: "anima-style.safetensors", strength: 0.75 }
  ]) as Record<string, any>;

  const loraNodeId = patched["2"].inputs.model[0];
  assert.equal(patched[loraNodeId].class_type, "LoraLoaderModelOnly");
  assert.deepEqual(patched["3"].inputs.model, [loraNodeId, 0]);
  assert.deepEqual(patched["4"].inputs.model, [loraNodeId, 0]);
});

test("assembleFeatureFragments: Anima In-Context inserts adapter, reference encode, and apply before every model consumer", () => {
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "anima-base-v1.0.safetensors" } },
    "2": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
    "3": { class_type: "CFGGuider", inputs: { model: ["1", 0] } },
    "4": { class_type: "BasicScheduler", inputs: { model: ["1", 0] } },
    "5": { class_type: "BasicScheduler", inputs: { model: ["1", 0] } }
  };

  const patched = assembleFeatureFragments(
    workflow,
    flags({ animaInContext: true }),
    "anima-reference.png"
  ) as Record<string, any>;

  const applyNodeId = patched["3"].inputs.model[0];
  assert.equal(patched[applyNodeId].class_type, "AnimaInContextApply");
  assert.deepEqual(patched["4"].inputs.model, [applyNodeId, 0]);
  assert.deepEqual(patched["5"].inputs.model, [applyNodeId, 0]);

  const apply = patched[applyNodeId];
  assert.equal(apply.inputs.strength, 1.0);
  assert.equal(apply.inputs.start_percent, 0.0);
  assert.equal(apply.inputs.end_percent, 1.0);
  assert.equal(apply.inputs.cond_only, true);
  assert.equal(apply.inputs.fit_mode, "pad");
  assert.equal(apply.inputs.ref_timestep, 0.0);

  const adapterNodeId = apply.inputs.model[0];
  assert.equal(patched[adapterNodeId].class_type, "LoraLoaderModelOnly");
  assert.equal(patched[adapterNodeId].inputs.lora_name, ANIMA_IN_CONTEXT_LORA_FILE);
  assert.equal(patched[adapterNodeId].inputs.strength_model, 1.0);
  assert.deepEqual(patched[adapterNodeId].inputs.model, ["1", 0]);

  const refEncodeNodeId = apply.inputs.ref_latent[0];
  assert.equal(patched[refEncodeNodeId].class_type, "AnimaRefEncode");
  assert.deepEqual(patched[refEncodeNodeId].inputs.vae, ["2", 0]);
  const refImageNodeId = patched[refEncodeNodeId].inputs.image[0];
  assert.equal(patched[refImageNodeId].class_type, "LoadImage");
  assert.equal(patched[refImageNodeId].inputs.image, "anima-reference.png");
});

test("assembleFeatureFragments: Anima face + full_body encodes both and combines only that character in LatentBatch", () => {
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: {} },
    "2": { class_type: "VAELoader", inputs: {} },
    "3": { class_type: "CFGGuider", inputs: { model: ["1", 0] } }
  };
  const patched = assembleFeatureFragments(
    workflow,
    flags({ animaInContext: true }),
    "face.png",
    [],
    { width: 768, height: 1024 },
    "full-body.png"
  ) as Record<string, any>;

  const apply = patched[patched["3"].inputs.model[0]];
  const batch = patched[apply.inputs.ref_latent[0]];
  assert.equal(batch.class_type, "AnimaRefLatentBatch");
  assert.equal(batch.inputs.fit_mode, "pad");
  const faceEncode = patched[batch.inputs.ref_latent_1[0]];
  const fullEncode = patched[batch.inputs.ref_latent_2[0]];
  assert.equal(patched[faceEncode.inputs.image[0]].inputs.image, "face.png");
  assert.equal(patched[fullEncode.inputs.image[0]].inputs.image, "full-body.png");
  assert.equal(Object.values(patched).filter((node: any) => node.class_type === "AnimaRefEncode").length, 2);
  assert.equal(Object.values(patched).filter((node: any) => node.class_type === "AnimaRefLatentBatch").length, 1);
});

test("assembleFeatureFragments: user LoRAs remain before the dedicated Anima In-Context adapter", () => {
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: {} },
    "2": { class_type: "VAELoader", inputs: {} },
    "3": { class_type: "CFGGuider", inputs: { model: ["1", 0] } }
  };
  const patched = assembleFeatureFragments(
    workflow,
    flags({ animaInContext: true }),
    "ref.png",
    [{ name: "anima-style.safetensors", strength: 0.8 }]
  ) as Record<string, any>;

  const apply = patched[patched["3"].inputs.model[0]];
  const adapter = patched[apply.inputs.model[0]];
  const style = patched[adapter.inputs.model[0]];
  assert.equal(adapter.inputs.lora_name, ANIMA_IN_CONTEXT_LORA_FILE);
  assert.equal(style.inputs.lora_name, "anima-style.safetensors");
  assert.deepEqual(style.inputs.model, ["1", 0]);
});

test("assembleFeatureFragments: Anima In-Context validates the model family, reference, and VAE before mutation", () => {
  assert.throws(
    () => assembleFeatureFragments(baseWorkflow(), flags({ animaInContext: true }), "ref.png"),
    /only supported by the Anima/
  );

  const missingReference = {
    "1": { class_type: "UNETLoader", inputs: {} },
    "2": { class_type: "VAELoader", inputs: {} },
    "3": { class_type: "CFGGuider", inputs: { model: ["1", 0] } }
  };
  assert.throws(
    () => assembleFeatureFragments(missingReference, flags({ animaInContext: true }), null),
    /reference image name/
  );
  assert.deepEqual(Object.keys(missingReference).sort(), ["1", "2", "3"]);

  const missingVae = {
    "1": { class_type: "UNETLoader", inputs: {} },
    "2": { class_type: "CFGGuider", inputs: { model: ["1", 0] } }
  };
  assert.throws(
    () => assembleFeatureFragments(missingVae, flags({ animaInContext: true }), "ref.png"),
    /requires a VAELoader/
  );
  assert.deepEqual(Object.keys(missingVae).sort(), ["1", "2"]);
});

test("assembleFeatureFragments: Anima inpaint LLLite receives the parent image and red-channel mask", () => {
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: {} },
    "2": { class_type: "CFGGuider", inputs: { model: ["1", 0] } },
    "3": { class_type: "BasicScheduler", inputs: { model: ["1", 0] } }
  };
  const patched = assembleFeatureFragments(
    workflow,
    flags({ animaInpaint: true }),
    null,
    [],
    {},
    null,
    { parentImageName: "parent.png", maskImageName: "mask.png" }
  ) as Record<string, any>;

  const apply = patched[patched["2"].inputs.model[0]];
  assert.equal(apply.class_type, "AnimaLLLiteApply");
  assert.equal(apply.inputs.lllite_name, ANIMA_INPAINT_LLLITE_FILE);
  assert.equal(apply.inputs.preserve_wrapper, true);
  assert.equal(patched[apply.inputs.image[0]].inputs.image, "parent.png");
  const mask = patched[apply.inputs.mask[0]];
  assert.equal(mask.class_type, "LoadImageMask");
  assert.equal(mask.inputs.image, "mask.png");
  assert.equal(mask.inputs.channel, "red");
  assert.deepEqual(patched["3"].inputs.model, patched["2"].inputs.model);
});

test("assembleFeatureFragments: Anima pose LLLite uses API strength/window and stacks after inpaint", () => {
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: {} },
    "2": { class_type: "CFGGuider", inputs: { model: ["1", 0] } }
  };
  const patched = assembleFeatureFragments(
    workflow,
    flags({ animaInpaint: true, animaControlnet: true }),
    null,
    [],
    {},
    null,
    {
      parentImageName: "parent.png",
      maskImageName: "mask.png",
      controlImageName: "pose.png",
      controlStrength: 0.75,
      controlStartPercent: 0.1,
      controlEndPercent: 0.8
    }
  ) as Record<string, any>;

  const pose = patched[patched["2"].inputs.model[0]];
  assert.equal(pose.class_type, "AnimaLLLiteApply");
  assert.equal(pose.inputs.lllite_name, ANIMA_POSE_LLLITE_FILE);
  assert.equal(pose.inputs.strength, 0.75);
  assert.equal(pose.inputs.start_percent, 0.1);
  assert.equal(pose.inputs.end_percent, 0.8);
  assert.equal(patched[pose.inputs.image[0]].inputs.image, "pose.png");
  const inpaint = patched[pose.inputs.model[0]];
  assert.equal(inpaint.inputs.lllite_name, ANIMA_INPAINT_LLLITE_FILE);
});

test("assembleFeatureFragments: Anima LLLite validates required uploaded images before mutation", () => {
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: {} },
    "2": { class_type: "CFGGuider", inputs: { model: ["1", 0] } }
  };
  assert.throws(
    () => assembleFeatureFragments(workflow, flags({ animaControlnet: true }), null),
    /control image name/
  );
  assert.deepEqual(Object.keys(workflow).sort(), ["1", "2"]);
});

test("Anima In-Context exports the adapter and complete node-pack contracts for model-check integration", () => {
  assert.deepEqual(ANIMA_IN_CONTEXT_MODEL_REQUIREMENTS, [
    {
      kind: "lora",
      name: "anima-incontext-character.safetensors",
      loaderClass: "LoraLoaderModelOnly",
      inputName: "lora_name",
      feature: "animaInContext",
      matchBasename: false
    }
  ]);
  assert.deepEqual(
    ANIMA_IN_CONTEXT_NODE_PACKS.map((pack) => pack.representativeClass),
    ["AnimaRefEncode", "AnimaRefLatentBatch", "AnimaInContextApply"]
  );
});

test("assembleFeatureFragments: PuLID is rejected for an Anima-style direct model chain", () => {
  const workflow = {
    "1": { class_type: "UNETLoader", inputs: {} },
    "2": { class_type: "CFGGuider", inputs: { model: ["1", 0] } }
  };
  assert.throws(() => assembleFeatureFragments(workflow, flags({ pulid: true }), "ref.png"), /only supported by the Chroma/);
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
