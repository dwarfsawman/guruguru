/**
 * Workflow import / template export の純粋 helper。
 * `src/client/main.ts` から、DOM/state に依存しない pure helper を分離したもの。
 * メッセージ文字列・fallback・role map 推論の挙動は維持。
 */
import type { WorkflowTemplate } from "./workflowTypes";

export function slugify(value: string) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "workflow-template";
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
