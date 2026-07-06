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
    ...overrides
  };
}

test("matchRequirements: exact match is available", () => {
  const requirements = [requirement()];
  const choices = new Map([["VAELoader", ["ae.safetensors", "other.safetensors"]]]);

  const result = matchRequirements(requirements, choices);

  assert.deepEqual(result, [
    {
      kind: "vae",
      name: "ae.safetensors",
      loaderClass: "VAELoader",
      inputName: "vae_name",
      targetDir: "models/vae",
      available: true
    }
  ]);
});

test("matchRequirements: basename match with forward-slash subfolder is available", () => {
  const requirements = [requirement()];
  const choices = new Map([["VAELoader", ["sub/ae.safetensors"]]]);

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, true);
});

test("matchRequirements: basename match with backslash subfolder is available", () => {
  const requirements = [requirement()];
  const choices = new Map([["VAELoader", ["sub\\ae.safetensors"]]]);

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, true);
});

test("matchRequirements: missing file among known choices is unavailable", () => {
  const requirements = [requirement()];
  const choices = new Map([["VAELoader", ["other.safetensors"]]]);

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, false);
});

test("matchRequirements: null choices (unreachable ComfyUI or unexpected shape) is unknown", () => {
  const requirements = [requirement()];
  const choices = new Map([["VAELoader", null]]);

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, null);
});

test("matchRequirements: loaderClass absent from the map (node not present) is unknown", () => {
  const requirements = [requirement()];
  const choices = new Map<string, string[] | null>();

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, null);
});
