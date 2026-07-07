/**
 * WorkflowTemplate / workflow import / template generation defaults 型。
 * `src/client/main.ts` から型定義だけを分離したもの。挙動変更なし。
 * `WorkflowTemplate` はAPI境界の共有型として `src/shared/apiTypes.ts` に
 * 移動済みで、ここでは既存のimportを壊さないよう再エクスポートする。
 */
export type { WorkflowTemplate } from "../shared/apiTypes";

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
