import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeIdFromRolePath } from "./workflowRolePath.ts";

test("nodeIdFromRolePath: extracts leading node id from a dotted path", () => {
  assert.equal(nodeIdFromRolePath("3.inputs.seed"), "3");
  assert.equal(nodeIdFromRolePath("12.inputs.image"), "12");
});

test("nodeIdFromRolePath: returns the whole string when there is no dot", () => {
  assert.equal(nodeIdFromRolePath("9"), "9");
});

test("nodeIdFromRolePath: null for non-string input", () => {
  assert.equal(nodeIdFromRolePath(undefined), null);
  assert.equal(nodeIdFromRolePath(null), null);
  assert.equal(nodeIdFromRolePath(42), null);
  assert.equal(nodeIdFromRolePath({}), null);
});

test("nodeIdFromRolePath: null for empty or whitespace-only string", () => {
  assert.equal(nodeIdFromRolePath(""), null);
  assert.equal(nodeIdFromRolePath("   "), null);
});

test("nodeIdFromRolePath: filters leading dots/empty segments", () => {
  assert.equal(nodeIdFromRolePath(".3.inputs.seed"), "3");
  assert.equal(nodeIdFromRolePath("..5"), "5");
});
