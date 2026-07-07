import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRequirements } from "./modelCheck.ts";
import type { WorkflowModelRequirement } from "../shared/workflowModels.ts";

function requirement(overrides: Partial<WorkflowModelRequirement> = {}): WorkflowModelRequirement {
  return {
    kind: "vae",
    name: "ae.safetensors",
    loaderClass: "VAELoader",
    inputName: "vae_name",
    feature: "base",
    ...overrides
  };
}

test("matchRequirements: exact match is available", () => {
  const requirements = [requirement()];
  const choices = new Map([["VAELoader::vae_name", ["ae.safetensors", "other.safetensors"]]]);

  const result = matchRequirements(requirements, choices);

  assert.deepEqual(result, [
    {
      kind: "vae",
      name: "ae.safetensors",
      loaderClass: "VAELoader",
      inputName: "vae_name",
      targetDir: "models/vae",
      feature: "base",
      available: true
    }
  ]);
});

test("matchRequirements: basename match with forward-slash subfolder is available", () => {
  const requirements = [requirement()];
  const choices = new Map([["VAELoader::vae_name", ["sub/ae.safetensors"]]]);

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, true);
});

test("matchRequirements: basename match with backslash subfolder is available", () => {
  const requirements = [requirement()];
  const choices = new Map([["VAELoader::vae_name", ["sub\\ae.safetensors"]]]);

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, true);
});

test("matchRequirements: missing file among known choices is unavailable", () => {
  const requirements = [requirement()];
  const choices = new Map([["VAELoader::vae_name", ["other.safetensors"]]]);

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, false);
});

test("matchRequirements: null choices (unreachable ComfyUI or unexpected shape) is unknown", () => {
  const requirements = [requirement()];
  const choices = new Map([["VAELoader::vae_name", null]]);

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, null);
});

test("matchRequirements: loaderClass+inputName absent from the map (node not present) is unknown", () => {
  const requirements = [requirement()];
  const choices = new Map<string, string[] | null>();

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, null);
});

test("matchRequirements: two requirements sharing a loaderClass but different inputName resolve independently (LoadFluxIPAdapter)", () => {
  const requirements = [
    requirement({ kind: "ipadapterFlux", loaderClass: "LoadFluxIPAdapter", inputName: "ipadatper", name: "ip_adapter.safetensors", feature: "ipadapter" }),
    requirement({ kind: "clipVision", loaderClass: "LoadFluxIPAdapter", inputName: "clip_vision", name: "clip-vit-large-patch14.safetensors", feature: "ipadapter" })
  ];
  const choices = new Map([
    ["LoadFluxIPAdapter::ipadatper", ["ip_adapter.safetensors"]],
    ["LoadFluxIPAdapter::clip_vision", ["other-clip.safetensors"]]
  ]);

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, true);
  assert.equal(result[1].available, false);
});
