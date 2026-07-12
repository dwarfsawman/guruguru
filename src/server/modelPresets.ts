import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ModelFamily } from "../shared/workflowModels";
import { getRow, toApiRow } from "./db";
import { createTemplate } from "./templates";

const PRESETS: Record<ModelFamily, {
  name: string;
  description: string;
  file: string;
  promptDialect: "natural" | "tags";
  qualityTags: string;
  negativeBase: string;
}> = {
  chroma: {
    name: "Chroma Unified",
    description: "Chroma txt2img / img2img / inpaint / ControlNet unified preset",
    file: "Reference-UnifiedSwitchWorkflow.json",
    promptDialect: "natural",
    qualityTags: "",
    negativeBase: "low quality, blurry, deformed, bad anatomy, extra limbs, extra fingers"
  },
  anima: {
    name: "Anima Unified",
    description: "Anima txt2img / img2img / inpaint / LoRA unified preset",
    file: "Reference-AnimaUnifiedSwitchWorkflow.json",
    promptDialect: "tags",
    qualityTags: "masterpiece, best quality, score_7, safe",
    negativeBase: "worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration"
  }
};

export function installModelPreset(family: ModelFamily) {
  const preset = PRESETS[family];
  const existing = getRow<Record<string, unknown>>(
    "SELECT * FROM workflow_templates WHERE name = ? AND deleted_at IS NULL ORDER BY version DESC LIMIT 1",
    [preset.name]
  );
  if (existing) {
    return { template: toApiRow(existing), created: false };
  }
  const path = fileURLToPath(new URL(`../../Docs/ReferenceFlows/${preset.file}`, import.meta.url));
  const workflowJson = JSON.parse(readFileSync(path, "utf8"));
  const template = createTemplate({
    name: preset.name,
    description: preset.description,
    type: "hybrid",
    workflowJson,
    roleMap: {},
    promptDialect: preset.promptDialect,
    qualityTags: preset.qualityTags,
    negativeBase: preset.negativeBase
  });
  return { template, created: true };
}
