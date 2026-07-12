import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectWorkflowModelFamily, extractModelRequirements } from "./workflowModels.ts";

// This test runs against the actual reference template JSON
// (Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json) so extraction is
// exercised on the real graph, node ids included.

const referencePath = fileURLToPath(new URL("../../Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json", import.meta.url));

function referenceWorkflow(): Record<string, unknown> {
  return JSON.parse(readFileSync(referencePath, "utf8"));
}

test("extractModelRequirements: finds all model loaders in the reference unified-switch workflow", () => {
  const requirements = extractModelRequirements(referenceWorkflow());

  assert.deepEqual(
    requirements.find((r) => r.name === "Chroma1-HD-fp8mixed.safetensors"),
    {
      kind: "diffusionModel",
      name: "Chroma1-HD-fp8mixed.safetensors",
      loaderClass: "UNETLoader",
      inputName: "unet_name",
      feature: "base"
    }
  );

  assert.deepEqual(
    requirements.find((r) => r.name === "t5xxl_fp8_e4m3fn_scaled.safetensors"),
    {
      kind: "textEncoder",
      name: "t5xxl_fp8_e4m3fn_scaled.safetensors",
      loaderClass: "CLIPLoader",
      inputName: "clip_name",
      feature: "base"
    }
  );

  assert.deepEqual(
    requirements.find((r) => r.name === "ae.safetensors"),
    {
      kind: "vae",
      name: "ae.safetensors",
      loaderClass: "VAELoader",
      inputName: "vae_name",
      feature: "base"
    }
  );

  assert.deepEqual(
    requirements.find((r) => r.name === "diffusion_pytorch_model.safetensors"),
    {
      kind: "controlnet",
      name: "diffusion_pytorch_model.safetensors",
      loaderClass: "ControlNetLoader",
      inputName: "control_net_name",
      feature: "controlnet"
    }
  );
});

test("extractModelRequirements: recognizes the PuLID loader input (Docs/Feature-ConsistentCharacter.md)", () => {
  const requirements = extractModelRequirements({
    "1": { class_type: "PulidFluxModelLoader", inputs: { pulid_file: "pulid_flux_v0.9.1.safetensors" } }
  });

  assert.deepEqual(requirements, [
    { kind: "pulid", name: "pulid_flux_v0.9.1.safetensors", loaderClass: "PulidFluxModelLoader", inputName: "pulid_file", feature: "pulid" }
  ]);
});

test("extractModelRequirements: ignores non-string / connection-wired input values", () => {
  const requirements = extractModelRequirements({
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: ["5", 0]
      }
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "   "
      }
    }
  });

  assert.deepEqual(requirements, []);
});

test("extractModelRequirements: returns empty list for a workflow with no model loaders", () => {
  assert.deepEqual(extractModelRequirements({}), []);
});

test("detectWorkflowModelFamily: distinguishes Anima from the Chroma default", () => {
  assert.equal(detectWorkflowModelFamily({ "1": { inputs: { unet_name: "anima-base-v1.0.safetensors" } } }), "anima");
  assert.equal(detectWorkflowModelFamily(referenceWorkflow()), "chroma");
});
