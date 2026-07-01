import { test } from "node:test";
import assert from "node:assert/strict";
import { isJsonObject, parseJsonObjectText, pickJsonObject } from "./json.ts";

test("isJsonObject: re-exported from shared/json and behaves the same", () => {
  assert.equal(isJsonObject({}), true);
  assert.equal(isJsonObject(null), false);
  assert.equal(isJsonObject([]), false);
});

test("parseJsonObjectText: parses a valid JSON object string", () => {
  const result = parseJsonObjectText('{"a": 1}', "role map");
  assert.deepEqual(result.value, { a: 1 });
  assert.equal(result.error, null);
});

test("parseJsonObjectText: errors with the label when text is blank and allowEmpty is false", () => {
  const result = parseJsonObjectText("   ", "role map");
  assert.equal(result.value, null);
  assert.equal(result.error, "role mapを入力してください。");
});

test("parseJsonObjectText: returns an empty object without error when blank and allowEmpty is true", () => {
  const result = parseJsonObjectText("", "role map", true);
  assert.deepEqual(result.value, {});
  assert.equal(result.error, null);
});

test("parseJsonObjectText: errors when the parsed root is not a JSON object", () => {
  const arrayResult = parseJsonObjectText("[1,2,3]", "workflow JSON");
  assert.equal(arrayResult.value, null);
  assert.match(arrayResult.error ?? "", /ルートはJSON objectである必要があります/);

  const stringResult = parseJsonObjectText('"just a string"', "workflow JSON");
  assert.equal(stringResult.value, null);
});

test("parseJsonObjectText: errors with parse failure detail for invalid JSON", () => {
  const result = parseJsonObjectText("{not valid json", "workflow JSON");
  assert.equal(result.value, null);
  assert.match(result.error ?? "", /workflow JSONをJSONとして読めません/);
});

test("pickJsonObject: returns the nested object when the key holds a JSON object", () => {
  const source = { nested: { a: 1 } };
  assert.deepEqual(pickJsonObject(source, "nested"), { a: 1 });
});

test("pickJsonObject: returns null when the key is missing or not a JSON object", () => {
  assert.equal(pickJsonObject({}, "missing"), null);
  assert.equal(pickJsonObject({ value: "string" }, "value"), null);
  assert.equal(pickJsonObject({ value: [1, 2] }, "value"), null);
  assert.equal(pickJsonObject({ value: null }, "value"), null);
});
