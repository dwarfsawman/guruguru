import type { WorkflowTemplate } from "../shared/apiTypes";
import { createId, getRow, getRows, runSql, toApiRow, toApiRows } from "./db";
import { HttpError } from "./http";
import { validateRoleMapReferences } from "../shared/workflowRoleMap";
import { ensureWorkflowObject, hashJson, normalizeRoleMap } from "./workflow";
import { objectBody, requiredString, stringOr } from "./validate";

const TAG_QUALITY_DEFAULT = "masterpiece, best quality, very aesthetic, absurdres";
const TAG_NEGATIVE_DEFAULT = "low quality, worst quality, blurry, bad anatomy, deformed, extra digits, fewer digits";
const NATURAL_NEGATIVE_DEFAULT = "low quality, blurry, deformed, bad anatomy, extra limbs, extra fingers";

export function inferPromptProfile(workflow: unknown, explicitDialect?: unknown) {
  const serialized = JSON.stringify(workflow);
  const inferred = /animagine|pony|sdxl|checkpointloadersimple/iu.test(serialized) ? "tags" : "natural";
  const promptDialect: "natural" | "tags" = explicitDialect === "tags" || explicitDialect === "natural" ? explicitDialect : inferred;
  return {
    promptDialect,
    qualityTags: promptDialect === "tags" ? TAG_QUALITY_DEFAULT : "",
    negativeBase: promptDialect === "tags" ? TAG_NEGATIVE_DEFAULT : NATURAL_NEGATIVE_DEFAULT
  };
}

export function listTemplates(): WorkflowTemplate[] {
  return toApiRows(
    getRows(
      `SELECT *
       FROM workflow_templates
       WHERE deleted_at IS NULL
       ORDER BY updated_at DESC, name ASC`
    )
  ) as unknown as WorkflowTemplate[];
}

export function createTemplate(body: unknown) {
  const input = objectBody(body);
  const name = requiredString(input.name, "name");
  const description = stringOr(input.description, "");
  const type = stringOr(input.type, "txt2img");
  const workflow = parseJsonInput(input.workflowJson ?? input.workflow_json, "workflowJson");
  const roleMap = parseJsonInput(input.roleMap ?? input.role_map_json, "roleMap");
  const inferredProfile = inferPromptProfile(workflow, input.promptDialect);
  const qualityTags = stringOr(input.qualityTags, inferredProfile.qualityTags);
  const negativeBase = stringOr(input.negativeBase, inferredProfile.negativeBase);

  let normalizedRoleMap: Record<string, unknown>;
  try {
    ensureWorkflowObject(workflow);
    normalizedRoleMap = normalizeRoleMap(roleMap);
    validateRoleMapReferences(workflow, normalizedRoleMap);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }

  const version =
    (getRow<{ version: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM workflow_templates WHERE name = ?", [name])?.version ?? 1);
  const id = createId("template");
  const workflowHash = hashJson(workflow);

  runSql(
    `INSERT INTO workflow_templates
      (id, name, description, type, version, workflow_json, role_map_json, workflow_hash, prompt_dialect, quality_tags, negative_base)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description, type, version, JSON.stringify(workflow), JSON.stringify(normalizedRoleMap), workflowHash,
      inferredProfile.promptDialect, qualityTags, negativeBase]
  );

  return toApiRow(getRow("SELECT * FROM workflow_templates WHERE id = ?", [id])) as unknown as WorkflowTemplate | null;
}

export function deleteTemplate(templateId: string) {
  const template = getRow<Record<string, unknown>>("SELECT * FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [templateId]);
  if (!template) {
    throw new HttpError(404, "WorkflowTemplate was not found");
  }

  runSql(
    "UPDATE workflow_templates SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [templateId]
  );
  runSql(
    "UPDATE projects SET default_template_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE default_template_id = ?",
    [templateId]
  );

  return {
    template: toApiRow(getRow("SELECT * FROM workflow_templates WHERE id = ?", [templateId])) as unknown as WorkflowTemplate | null
  };
}

/** 生成方言メタデータだけを安全に編集する。workflow本体とversion/hashは不変。 */
export function updateTemplatePromptProfile(templateId: string, body: unknown) {
  const current = getRow<{ id: string; prompt_dialect: string; quality_tags: string; negative_base: string }>(
    "SELECT id, prompt_dialect, quality_tags, negative_base FROM workflow_templates WHERE id = ? AND deleted_at IS NULL",
    [templateId]
  );
  if (!current) throw new HttpError(404, "WorkflowTemplate was not found");
  const input = objectBody(body);
  const dialect = input.promptDialect ?? current.prompt_dialect;
  if (dialect !== "natural" && dialect !== "tags") throw new HttpError(400, "promptDialect must be natural or tags");
  const qualityTags = stringOr(input.qualityTags, current.quality_tags);
  const negativeBase = stringOr(input.negativeBase, current.negative_base);
  runSql(
    "UPDATE workflow_templates SET prompt_dialect = ?, quality_tags = ?, negative_base = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [dialect, qualityTags, negativeBase, templateId]
  );
  return toApiRow(getRow("SELECT * FROM workflow_templates WHERE id = ?", [templateId])) as unknown as WorkflowTemplate;
}

function parseJsonInput(value: unknown, name: string): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new HttpError(400, `${name} is not valid JSON`);
    }
  }
  if (typeof value === "object" && value !== null) {
    return value;
  }
  throw new HttpError(400, `${name} is required`);
}
