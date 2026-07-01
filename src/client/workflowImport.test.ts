import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTemplateExportPayload,
  defaultWorkflowImportDraft,
  defaultWorkflowImportRoleMap,
  parseWorkflowFileContent,
  slugify,
  workflowExportFilename
} from "./workflowImport.ts";
import type { WorkflowTemplate } from "./workflowTypes.ts";

test("defaultWorkflowImportDraft: uses empty name/description, txt2img type, and the default role map text", () => {
  const draft = defaultWorkflowImportDraft();
  assert.equal(draft.name, "");
  assert.equal(draft.description, "");
  assert.equal(draft.type, "txt2img");
  assert.equal(draft.workflowJson, "{}");
  assert.equal(draft.roleMap, defaultWorkflowImportRoleMap);
});

test("slugify: lowercases and replaces non-alphanumeric runs with a single hyphen", () => {
  assert.equal(slugify("My Cool Workflow!"), "my-cool-workflow");
  assert.equal(slugify("  spaced  out  "), "spaced-out");
});

test("slugify: strips leading/trailing hyphens", () => {
  assert.equal(slugify("---hello---"), "hello");
});

test("slugify: falls back to 'workflow-template' when the result would be empty", () => {
  assert.equal(slugify("!!!"), "workflow-template");
  assert.equal(slugify(""), "workflow-template");
});

test("parseWorkflowFileContent: rejects invalid JSON", () => {
  const result = parseWorkflowFileContent("{not json");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /読み込めませんでした/);
  }
});

test("parseWorkflowFileContent: rejects a non-object JSON root", () => {
  const result = parseWorkflowFileContent("[1,2,3]");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /ルートはJSON objectである必要があります/);
  }
});

test("parseWorkflowFileContent: reads workflowJson/roleMap directly when present (camelCase keys)", () => {
  const payload = {
    workflowJson: { "1": { class_type: "KSampler", inputs: {} } },
    roleMap: { seed_input: "1.inputs.seed" },
    name: "My Template",
    description: "desc",
    type: "txt2img"
  };
  const result = parseWorkflowFileContent(JSON.stringify(payload));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.result.workflowJson, payload.workflowJson);
    assert.deepEqual(result.result.roleMap, payload.roleMap);
    assert.equal(result.result.name, "My Template");
    assert.equal(result.result.description, "desc");
    assert.equal(result.result.type, "txt2img");
    assert.equal(result.message, "workflow JSONとrole mapを読み込みました。");
  }
});

test("parseWorkflowFileContent: falls back to workflow_json / role_map snake_case keys", () => {
  const payload = {
    workflow_json: { "1": { class_type: "KSampler", inputs: {} } },
    role_map: { seed_input: "1.inputs.seed" }
  };
  const result = parseWorkflowFileContent(JSON.stringify(payload));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.result.workflowJson, payload.workflow_json);
    assert.deepEqual(result.result.roleMap, payload.role_map);
  }
});

test("parseWorkflowFileContent: falls back to role_map_json key when roleMap/role_map are absent", () => {
  const payload = {
    workflowJson: { "1": {} },
    role_map_json: { seed_input: "1.inputs.seed" }
  };
  const result = parseWorkflowFileContent(JSON.stringify(payload));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.result.roleMap, payload.role_map_json);
  }
});

test("parseWorkflowFileContent: treats the whole root as workflowJson when no workflowJson/workflow_json key exists", () => {
  const payload = { "1": { class_type: "CLIPTextEncode", inputs: { text: "a cat" }, _meta: { title: "Positive" } } };
  const result = parseWorkflowFileContent(JSON.stringify(payload));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.result.workflowJson, payload);
  }
});

test("parseWorkflowFileContent: infers a role map via inferRoleMap() when none is present, with the auto-set message", () => {
  const payload = {
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat" }, _meta: { title: "Positive Prompt" } }
  };
  const result = parseWorkflowFileContent(JSON.stringify(payload));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.roleMap.positive_prompt_node, "6");
    assert.equal(result.message, "workflow JSONを読み込み、role mapを自動設定しました。必要に応じて内容を確認してください。");
  }
});

test("workflowExportFilename: uses .workflow.json suffix for kind 'workflow'", () => {
  assert.equal(workflowExportFilename("My Workflow", "workflow"), "my-workflow.workflow.json");
});

test("workflowExportFilename: uses .guruguru-template.json suffix for kind 'template'", () => {
  assert.equal(workflowExportFilename("My Template", "template"), "my-template.guruguru-template.json");
});

test("buildTemplateExportPayload: copies template fields and stamps a version + ISO exportedAt", () => {
  const template: WorkflowTemplate = {
    id: "tmpl-1",
    name: "Template A",
    description: "A description",
    type: "txt2img",
    version: 3,
    workflowHash: "hash",
    workflowJson: { "1": {} },
    roleMap: { seed_input: "1.inputs.seed" }
  };
  const payload = buildTemplateExportPayload(template);
  assert.equal(payload.guruguruTemplateVersion, 1);
  assert.equal(payload.name, "Template A");
  assert.equal(payload.description, "A description");
  assert.equal(payload.type, "txt2img");
  assert.equal(payload.version, 3);
  assert.deepEqual(payload.workflowJson, { "1": {} });
  assert.deepEqual(payload.roleMap, { seed_input: "1.inputs.seed" });
  assert.equal(typeof payload.exportedAt, "string");
  assert.doesNotThrow(() => new Date(payload.exportedAt).toISOString());
});
