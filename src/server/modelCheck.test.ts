import { test } from "node:test";
import assert from "node:assert/strict";
import { isNodePackPresent, matchRequirements } from "./modelCheck.ts";
import type { WorkflowModelRequirement } from "../shared/workflowModels.ts";
import type { FeatureNodePack } from "./workflowFeatureFragments.ts";

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

test("matchRequirements: two requirements sharing a loaderClass but different inputName resolve independently", () => {
  const requirements = [
    requirement({ kind: "controlnet", loaderClass: "DualInputLoader", inputName: "first_name", name: "first.safetensors", feature: "controlnet" }),
    requirement({ kind: "pulid", loaderClass: "DualInputLoader", inputName: "second_name", name: "second.safetensors", feature: "pulid" })
  ];
  const choices = new Map([
    ["DualInputLoader::first_name", ["first.safetensors"]],
    ["DualInputLoader::second_name", ["other.safetensors"]]
  ]);

  const result = matchRequirements(requirements, choices);

  assert.equal(result[0].available, true);
  assert.equal(result[1].available, false);
});

const PULID_PACK: FeatureNodePack = {
  label: "PuLID-Flux (Chroma対応fork)",
  representativeClass: "ApplyPulidFlux",
  requiredInputs: ["prior_image"]
};

/** `/object_info/ApplyPulidFlux` の疑似レスポンス(required/optional に任意の入力名を並べる)。 */
function applyPulidInfo(required: string[], optional: string[] = []): unknown {
  const section = (names: string[]) => Object.fromEntries(names.map((name) => [name, [["IMAGE"]]]));
  return { ApplyPulidFlux: { input: { required: section(required), optional: section(optional) } } };
}

test("isNodePackPresent: Chroma fork (prior_image あり) は導入済みと判定", () => {
  const info = applyPulidInfo(["model", "pulid_flux", "image", "prior_image"]);
  assert.equal(isNodePackPresent(info, PULID_PACK), true);
});

test("isNodePackPresent: 簡易 Flux fork (同名クラスだが prior_image なし) は未導入と判定", () => {
  const info = applyPulidInfo(["model", "pulid_flux", "image"]);
  assert.equal(isNodePackPresent(info, PULID_PACK), false);
});

test("isNodePackPresent: requiredInputs は optional セクションにあっても満たす", () => {
  const info = applyPulidInfo(["model"], ["prior_image"]);
  assert.equal(isNodePackPresent(info, PULID_PACK), true);
});

test("isNodePackPresent: クラス自体が存在しなければ未導入", () => {
  assert.equal(isNodePackPresent({}, PULID_PACK), false);
});

test("isNodePackPresent: ComfyUI 未接続(info=null)は未導入扱い", () => {
  assert.equal(isNodePackPresent(null, PULID_PACK), false);
});

test("isNodePackPresent: requiredInputs 未指定ならクラス名の存在のみで判定(従来動作)", () => {
  const pack: FeatureNodePack = { label: "core", representativeClass: "ApplyPulidFlux" };
  assert.equal(isNodePackPresent(applyPulidInfo(["model"]), pack), true);
  assert.equal(isNodePackPresent({}, pack), false);
});
