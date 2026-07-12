import { test } from "node:test";
import assert from "node:assert/strict";
import { inferPromptProfile } from "./templates.ts";

test("inferPromptProfile: SDXL/Animagine workflowはtags方言を推定する", () => {
  const profile = inferPromptProfile({ "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "animagine-xl.safetensors" } } });
  assert.equal(profile.promptDialect, "tags");
  assert.match(profile.qualityTags, /masterpiece/);
  assert.match(profile.negativeBase, /worst quality/);
});

test("inferPromptProfile: Chroma/T5 workflowはnatural、明示指定は推定を上書きする", () => {
  assert.equal(inferPromptProfile({ "1": { class_type: "UNETLoader", inputs: { unet_name: "chroma.safetensors" } } }).promptDialect, "natural");
  assert.equal(inferPromptProfile({ "1": { class_type: "UNETLoader" } }, "tags").promptDialect, "tags");
});
