import { test } from "node:test";
import assert from "node:assert/strict";
import { isJsonObject } from "./json.ts";

test("isJsonObject: accepts plain objects", () => {
  assert.equal(isJsonObject({}), true);
  assert.equal(isJsonObject({ a: 1 }), true);
});

test("isJsonObject: rejects null", () => {
  assert.equal(isJsonObject(null), false);
});

test("isJsonObject: rejects arrays", () => {
  assert.equal(isJsonObject([]), false);
  assert.equal(isJsonObject([1, 2, 3]), false);
});

test("isJsonObject: rejects primitives", () => {
  assert.equal(isJsonObject("string"), false);
  assert.equal(isJsonObject(42), false);
  assert.equal(isJsonObject(true), false);
  assert.equal(isJsonObject(undefined), false);
});
