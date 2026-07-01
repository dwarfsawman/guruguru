import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nonEmptyStringOr,
  numberOr,
  objectBody,
  positiveIntegerOr,
  requiredString,
  stringOr,
  stringOrNull
} from "./validate.ts";
import { HttpError } from "./http.ts";

test("objectBody: returns the value when it is a plain JSON object", () => {
  const body = { a: 1 };
  assert.equal(objectBody(body), body);
});

test("objectBody: throws HttpError 400 for non-object bodies", () => {
  for (const value of [null, undefined, "text", 42, [1, 2], true]) {
    assert.throws(() => objectBody(value), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, "Request body must be a JSON object");
      return true;
    });
  }
});

test("requiredString: returns the trimmed string when non-empty", () => {
  assert.equal(requiredString("  hello  ", "name"), "hello");
});

test("requiredString: throws HttpError 400 with field name for empty/whitespace/non-string", () => {
  for (const value of ["", "   ", null, undefined, 42]) {
    assert.throws(() => requiredString(value, "templateId"), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, "templateId is required");
      return true;
    });
  }
});

test("stringOr: returns the string value as-is", () => {
  assert.equal(stringOr("hello", "fallback"), "hello");
  assert.equal(stringOr("", "fallback"), "");
});

test("stringOr: returns fallback for non-string values", () => {
  assert.equal(stringOr(null, "fallback"), "fallback");
  assert.equal(stringOr(undefined, "fallback"), "fallback");
  assert.equal(stringOr(42, "fallback"), "fallback");
});

test("nonEmptyStringOr: returns trimmed value with trailing slashes stripped", () => {
  assert.equal(nonEmptyStringOr("http://host/path/", "fallback"), "http://host/path");
  assert.equal(nonEmptyStringOr("  http://host  ", "fallback"), "http://host");
});

test("nonEmptyStringOr: falls back to trimmed fallback when value is empty/non-string", () => {
  assert.equal(nonEmptyStringOr(null, "  fallback  "), "fallback");
  assert.equal(nonEmptyStringOr("   ", "fallback"), "fallback");
});

test("nonEmptyStringOr: falls back to default WebSAM base URL when fallback is also empty", () => {
  assert.equal(nonEmptyStringOr(null, ""), "/api/websam-models");
  assert.equal(nonEmptyStringOr("", "   "), "/api/websam-models");
});

test("stringOrNull: returns trimmed string when non-empty", () => {
  assert.equal(stringOrNull("  value  "), "value");
});

test("stringOrNull: returns null for empty/whitespace/non-string", () => {
  assert.equal(stringOrNull(""), null);
  assert.equal(stringOrNull("   "), null);
  assert.equal(stringOrNull(null), null);
  assert.equal(stringOrNull(42), null);
});

test("numberOr: returns finite numbers as-is", () => {
  assert.equal(numberOr(5, 0), 5);
  assert.equal(numberOr(0, 99), 0);
});

test("numberOr: parses numeric strings", () => {
  assert.equal(numberOr("42", 0), 42);
  assert.equal(numberOr("3.14", 0), 3.14);
});

test("numberOr: falls back for non-finite numbers, blank strings, or non-numeric strings", () => {
  assert.equal(numberOr(NaN, 7), 7);
  assert.equal(numberOr(Infinity, 7), 7);
  assert.equal(numberOr("   ", 7), 7);
  assert.equal(numberOr("abc", 7), 7);
  assert.equal(numberOr(null, 7), 7);
  assert.equal(numberOr(undefined, 7), 7);
});

test("positiveIntegerOr: truncates and clamps to a minimum of 1", () => {
  assert.equal(positiveIntegerOr(5.9, 1), 5);
  assert.equal(positiveIntegerOr(0, 1), 1);
  assert.equal(positiveIntegerOr(-3, 1), 1);
});

test("positiveIntegerOr: uses fallback (then still clamps) when value is not numeric", () => {
  assert.equal(positiveIntegerOr("abc", 4), 4);
  assert.equal(positiveIntegerOr(undefined, 0), 1);
});
