import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTemplateExportPayload,
  slugify,
  workflowExportFilename
} from "./workflowImport.ts";
import type { WorkflowTemplate } from "./workflowTypes.ts";

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
