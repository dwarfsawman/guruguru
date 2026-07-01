import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { isPathInside, isPathInsideOrEqual } from "./paths.ts";

const parent = resolve("C:/data/projects") ;

test("isPathInside: true for a real child path", () => {
  assert.equal(isPathInside(join(parent, "child.png"), parent), true);
  assert.equal(isPathInside(join(parent, "nested", "child.png"), parent), true);
});

test("isPathInside: false when target equals parent", () => {
  assert.equal(isPathInside(parent, parent), false);
});

test("isPathInside: false for a sibling directory that merely shares a text prefix", () => {
  assert.equal(isPathInside(resolve("C:/data/projects-evil/child.png"), parent), false);
});

test("isPathInside: false for traversal escaping the parent", () => {
  assert.equal(isPathInside(join(parent, "..", "outside.png"), parent), false);
  assert.equal(isPathInside(resolve("C:/etc/passwd"), parent), false);
});

test("isPathInside: false for a cross-drive target on Windows", () => {
  assert.equal(isPathInside("D:/data/projects/child.png", parent), false);
});

test("isPathInsideOrEqual: true for a real child path", () => {
  assert.equal(isPathInsideOrEqual(join(parent, "child.png"), parent), true);
});

test("isPathInsideOrEqual: true when target equals parent", () => {
  assert.equal(isPathInsideOrEqual(parent, parent), true);
});

test("isPathInsideOrEqual: false for traversal escaping the parent", () => {
  assert.equal(isPathInsideOrEqual(join(parent, "..", "outside.png"), parent), false);
});

test("isPathInsideOrEqual: false for a sibling directory sharing a text prefix", () => {
  assert.equal(isPathInsideOrEqual(resolve("C:/data/projects-evil"), parent), false);
});
