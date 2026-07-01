import { createId, getRow, getRows, runSql, toApiRow, toApiRows } from "./db";
import { HttpError } from "./http";
import { validateRoleMapReferences } from "../shared/workflowRoleMap";
import { ensureWorkflowObject, hashJson, normalizeRoleMap } from "./workflow";
import { objectBody, requiredString, stringOr } from "./validate";

export function listTemplates() {
  return toApiRows(
    getRows(
      `SELECT *
       FROM workflow_templates
       WHERE deleted_at IS NULL
       ORDER BY updated_at DESC, name ASC`
    )
  );
}

export function createTemplate(body: unknown) {
  const input = objectBody(body);
  const name = requiredString(input.name, "name");
  const description = stringOr(input.description, "");
  const type = stringOr(input.type, "txt2img");
  const workflow = parseJsonInput(input.workflowJson ?? input.workflow_json, "workflowJson");
  const roleMap = parseJsonInput(input.roleMap ?? input.role_map_json, "roleMap");

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
      (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description, type, version, JSON.stringify(workflow), JSON.stringify(normalizedRoleMap), workflowHash]
  );

  return toApiRow(getRow("SELECT * FROM workflow_templates WHERE id = ?", [id]));
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
    template: toApiRow(getRow("SELECT * FROM workflow_templates WHERE id = ?", [templateId]))
  };
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
