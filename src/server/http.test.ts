import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "./http.ts";

test("HttpError: carries statusCode and message", () => {
  const error = new HttpError(404, "Round was not found");
  assert.equal(error.statusCode, 404);
  assert.equal(error.message, "Round was not found");
});

test("HttpError: is an instance of Error", () => {
  const error = new HttpError(400, "bad request");
  assert.ok(error instanceof Error);
  assert.ok(error instanceof HttpError);
});

test("HttpError: name defaults to Error's name (no custom name override)", () => {
  const error = new HttpError(500, "oops");
  assert.equal(error.name, "Error");
});
