import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { HttpError, readJson } from "./http.ts";

function fakeRequest(body: string): IncomingMessage {
  return Readable.from([Buffer.from(body, "utf8")]) as unknown as IncomingMessage;
}

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

test("readJson: 正常なJSONボディをパースする", async () => {
  const body = await readJson<{ a: number }>(fakeRequest('{"a": 1}'));
  assert.deepEqual(body, { a: 1 });
});

test("readJson: 空ボディは {} になる", async () => {
  assert.deepEqual(await readJson(fakeRequest("")), {});
  assert.deepEqual(await readJson(fakeRequest("   \n")), {});
});

test("readJson: 不正なJSONは HttpError(400) になる(生のSyntaxErrorで500にしない)", async () => {
  await assert.rejects(
    () => readJson(fakeRequest("{not json")),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});
