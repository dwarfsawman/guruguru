/**
 * Workflow import / template export の純粋 helper。
 * `src/client/main.ts` から、DOM/state に依存しない pure helper を分離したもの。
 * メッセージ文字列・fallback・role map 推論の挙動は維持。
 */
import { type Json, isJsonObject, pickJsonObject } from "./json";
import { inferRoleMap } from "../shared/workflowRoleMap";
import type { WorkflowImportDraft, WorkflowTemplate } from "./workflowTypes";

export const defaultWorkflowImportRoleMap = `{
  "positive_prompt_node": "6",
  "negative_prompt_node": "7",
  "ksampler_node": "3",
  "seed_input": "3.inputs.seed",
  "cfg_input": "3.inputs.cfg",
  "steps_input": "3.inputs.steps",
  "denoise_input": "3.inputs.denoise",
  "ksampler_latent_image_input": "3.inputs.latent_image",
  "batch_size_input": "5.inputs.batch_size",
  "load_image_node": "12",
  "load_image_input": "12.inputs.image",
  "vae_encode_node": "13",
  "vae_encode_image_input": "13.inputs.pixels",
  "save_image_node": "9"
}`;

export function defaultWorkflowImportDraft(): WorkflowImportDraft {
  return {
    name: "",
    description: "",
    type: "txt2img",
    workflowJson: "{}",
    roleMap: defaultWorkflowImportRoleMap
  };
}

export function slugify(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "workflow-template";
}

export interface WorkflowFileImport {
  workflowJson: Json;
  roleMap: Json;
  name?: string;
  description?: string;
  type?: string;
}

export type WorkflowFileParseResult =
  | { ok: true; result: WorkflowFileImport; message: string }
  | { ok: false; error: string };

/**
 * workflow JSON ファイル内容の parse 判定ロジック。
 * JSON.parse / root object check / workflowJson・workflow_json・raw workflow の取り出し /
 * roleMap・role_map・role_map_json の取り出し / inferRoleMap() fallback を担う。
 * DOM・state 更新は呼び出し側で行う。
 */
export function parseWorkflowFileContent(text: string): WorkflowFileParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "workflow JSONファイルを読み込めませんでした。JSON形式を確認してください。" };
  }

  if (!isJsonObject(parsed)) {
    return { ok: false, error: "workflow JSONファイルのルートはJSON objectである必要があります。" };
  }

  const workflowJson = pickJsonObject(parsed, "workflowJson") ?? pickJsonObject(parsed, "workflow_json") ?? parsed;
  const importedRoleMap =
    pickJsonObject(parsed, "roleMap") ??
    pickJsonObject(parsed, "role_map") ??
    pickJsonObject(parsed, "role_map_json");
  const roleMap = importedRoleMap ?? inferRoleMap(workflowJson);
  const message = importedRoleMap
    ? "workflow JSONとrole mapを読み込みました。"
    : "workflow JSONを読み込み、role mapを自動設定しました。必要に応じて内容を確認してください。";

  return {
    ok: true,
    result: {
      workflowJson,
      roleMap,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
      type: typeof parsed.type === "string" ? parsed.type : undefined
    },
    message
  };
}

export function workflowExportFilename(name: string, kind: "template" | "workflow") {
  return kind === "workflow"
    ? `${slugify(name)}.workflow.json`
    : `${slugify(name)}.guruguru-template.json`;
}

export function buildTemplateExportPayload(template: WorkflowTemplate) {
  return {
    guruguruTemplateVersion: 1,
    exportedAt: new Date().toISOString(),
    name: template.name,
    description: template.description,
    type: template.type,
    version: template.version,
    workflowJson: template.workflowJson,
    roleMap: template.roleMap
  };
}
