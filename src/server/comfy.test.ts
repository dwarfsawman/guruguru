import assert from "node:assert/strict";
import test from "node:test";

process.env.GURUGURU_TEST_DB = "1";

const { isComfyQueueIdle } = await import("./comfy.ts");

test("isComfyQueueIdle permits VRAM release only for an explicitly empty global queue", () => {
  assert.equal(isComfyQueueIdle({ queue_running: [], queue_pending: [] }), true);
  assert.equal(isComfyQueueIdle({ queue_running: [["job"]], queue_pending: [] }), false);
  assert.equal(isComfyQueueIdle({ queue_running: [], queue_pending: [["job"]] }), false);
  assert.equal(isComfyQueueIdle({}), false);
  assert.equal(isComfyQueueIdle(null), false);
});
