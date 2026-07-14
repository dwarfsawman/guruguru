import assert from "node:assert/strict";
import test from "node:test";
import { postProcessMasks, reprocessMask, smoothBinaryMask } from "./maskPostprocess.ts";

test("postProcessMasks returns three 1-byte alpha masks and caches logits", () => {
  const rawMasks = new Float32Array([
    -1, 1, -1, 1,
    1, 1, -1, -1,
    -1, -1, -1, 1
  ]);
  const result = postProcessMasks(rawMasks, new Float32Array([0.1, 0.9, 0.3]), 2, 2, 2, 2, 0, 0);
  assert.equal(result.masks.length, 3);
  assert.deepEqual([...result.masks[0]!], [0, 255, 0, 255]);
  assert.deepEqual([...result.masks[1]!], [255, 255, 0, 0]);
  assert.equal(result.rawLogits.length, 12);
  assert.equal(result.selectedIndex, 1);
});

test("reprocessMask processes only the requested candidate", () => {
  const logits = new Float32Array([
    1, 1, 1, 1,
    -1, 2, -1, 2,
    -1, -1, -1, -1
  ]);
  assert.deepEqual([...reprocessMask(logits, 2, 2, 1, 0, 0)], [0, 255, 0, 255]);
  assert.throws(() => reprocessMask(logits, 2, 2, 3, 0, 0), /Invalid WebSAM mask index/);
});

test("smoothBinaryMask reuses caller scratch buffers and removes an isolated island", () => {
  const alpha = new Uint8Array(25);
  alpha[12] = 255;
  const scratchA = new Uint8Array(alpha.length);
  const scratchB = new Uint8Array(alpha.length);
  const result = smoothBinaryMask(alpha, 5, 5, 1, scratchA, scratchB);
  assert.equal(result, alpha);
  assert.deepEqual([...result], new Array(25).fill(0));
});
