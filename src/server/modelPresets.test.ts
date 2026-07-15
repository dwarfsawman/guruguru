import { test } from "node:test";
import assert from "node:assert/strict";
import { getRow, initializeDb, runSql } from "./db.ts";
import { installModelPreset } from "./modelPresets.ts";

initializeDb();

test("installModelPreset: installs the Anima unified workflow once with tag prompt defaults", () => {
  runSql("DELETE FROM workflow_templates WHERE name = ?", ["Anima Unified"]);

  const first = installModelPreset("anima");
  const second = installModelPreset("anima");
  const row = getRow<Record<string, unknown>>(
    "SELECT * FROM workflow_templates WHERE name = ? AND deleted_at IS NULL",
    ["Anima Unified"]
  )!;
  const workflow = JSON.parse(String(row.workflow_json));

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(row.prompt_dialect, "tags");
  assert.equal(workflow["731"].inputs.unet_name, "animaInt8Mxfp8_aestheticV11Int8.safetensors");
  assert.equal(workflow["733"].inputs.type, "stable_diffusion");
  assert.equal(workflow["710"].inputs.vae_name, "qwen_image_vae.safetensors");
  assert.equal(
    getRow<{ count: number }>("SELECT COUNT(*) AS count FROM workflow_templates WHERE name = ?", ["Anima Unified"])!.count,
    1
  );

  runSql("DELETE FROM workflow_templates WHERE name = ?", ["Anima Unified"]);
});
