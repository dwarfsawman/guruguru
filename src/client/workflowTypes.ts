/**
 * WorkflowTemplate / workflow import / template generation defaults 型。
 * `src/client/main.ts` から型定義だけを分離したもの。挙動変更なし。
 * `Json` は `src/shared/json.ts` の共有型を利用する。
 */
import type { Json } from "../shared/json";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  type: string;
  version: number;
  workflowHash: string;
  workflowJson: Json;
  roleMap: Json;
}

export interface WorkflowImportDraft {
  name: string;
  description: string;
  type: string;
  workflowJson: string;
  roleMap: string;
}

export interface TemplateModelDefaults {
  checkpoint?: string;
  diffusionModel?: string;
  textEncoders: string[];
  vae?: string;
  loras: string[];
}

export interface TemplateGenerationDefaults {
  prompt?: string;
  negativePrompt?: string;
  seed?: number;
  batchSize?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  denoise?: number;
  width?: number;
  height?: number;
  model: TemplateModelDefaults;
}
