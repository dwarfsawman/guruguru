import { test } from "node:test";
import assert from "node:assert/strict";
import type { PastedObject } from "./pasteAttachments.ts";
import {
  PASTE_MAX_OBJECTS,
  clonePastedObjects,
  pastedObjectsValidationError,
  sanitizePastedObjects
} from "./pasteAttachments.ts";

function validObject(overrides: Partial<PastedObject> = {}): PastedObject {
  return {
    id: "obj-1",
    sourceId: "src-1",
    sourceWidth: 100,
    sourceHeight: 50,
    transform: { x: 10, y: 20, rotation: 0.5, scaleX: 1, scaleY: 1 },
    ...overrides
  };
}

test("sanitizePastedObjects: returns [] for non-array input", () => {
  assert.deepEqual(sanitizePastedObjects(null), []);
  assert.deepEqual(sanitizePastedObjects(undefined), []);
  assert.deepEqual(sanitizePastedObjects("x"), []);
});

test("sanitizePastedObjects: keeps valid entries and silently drops invalid ones", () => {
  const result = sanitizePastedObjects([
    validObject(),
    { id: "", sourceId: "s", sourceWidth: 1, sourceHeight: 1, transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } },
    validObject({ id: "obj-2", transform: { x: 0, y: 0, rotation: 0, scaleX: -1, scaleY: 1 } }),
    validObject({ id: "obj-3" })
  ]);
  assert.deepEqual(result.map((object) => object.id), ["obj-1", "obj-3"]);
});

test("sanitizePastedObjects: strips extra fields and copies deeply", () => {
  const input = { ...validObject(), extra: "x" };
  const [result] = sanitizePastedObjects([input]);
  assert.ok(result);
  assert.equal("extra" in result!, false);
  input.transform.x = 999;
  assert.equal(result!.transform.x, 10);
});

test("sanitizePastedObjects: caps the number of objects", () => {
  const many = Array.from({ length: PASTE_MAX_OBJECTS + 10 }, (_, index) => validObject({ id: `obj-${index}` }));
  assert.equal(sanitizePastedObjects(many).length, PASTE_MAX_OBJECTS);
});

test("pastedObjectsValidationError: null for a valid array, message for invalid input", () => {
  assert.equal(pastedObjectsValidationError([validObject()]), null);
  assert.equal(pastedObjectsValidationError([]), null);
  assert.match(pastedObjectsValidationError("x") ?? "", /must be an array/);
  assert.match(pastedObjectsValidationError([{ id: "a" }]) ?? "", /objects\[0\]/);
  assert.match(
    pastedObjectsValidationError([validObject({ transform: { x: Number.NaN, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } })]) ?? "",
    /objects\[0\]/
  );
});

test("pastedObjectsValidationError: rejects duplicated ids and oversized arrays", () => {
  assert.match(pastedObjectsValidationError([validObject(), validObject()]) ?? "", /duplicated id/);
  const many = Array.from({ length: PASTE_MAX_OBJECTS + 1 }, (_, index) => validObject({ id: `obj-${index}` }));
  assert.match(pastedObjectsValidationError(many) ?? "", /at most/);
});

test("clonePastedObjects: deep copy is independent of the source", () => {
  const source = [validObject()];
  const cloned = clonePastedObjects(source);
  source[0]!.transform.rotation = 9;
  assert.equal(cloned[0]!.transform.rotation, 0.5);
});
