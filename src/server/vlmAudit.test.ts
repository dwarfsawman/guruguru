import assert from "node:assert/strict";
import test from "node:test";
import type { VlmAuditSettings } from "../shared/types.ts";

process.env.GURUGURU_TEST_DB = "1";

const { acquireVlmModel, getVlmAuditStatus, releaseVlmModel } = await import("./vlmAudit.ts");

function settings(baseUrl: string): VlmAuditSettings {
  return {
    baseUrl: `${baseUrl}/v1`,
    model: "audit-model",
    modelKey: "audit-model",
    transport: "lmstudio-native",
    temperature: 0,
    timeoutSeconds: 2,
    maxReferenceImages: 2,
    passThreshold: 0.65,
    contextLength: 4096,
    manageModelLifecycle: true,
    releaseComfyBeforeAudit: false,
    unloadAfterAudit: true
  };
}

test("LM Studio lifecycle loads a downloaded vision model and unloads the acquired instance", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  let loaded = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ path, body });
      if (path === "/api/v1/models") {
        return Response.json({
          models: [{
            key: "audit-model",
            capabilities: { vision: true },
            loaded_instances: loaded ? [{ id: "audit-instance" }] : []
          }]
        });
      }
      if (path === "/api/v1/models/load") {
        loaded = true;
        return Response.json({ instance_id: "audit-instance", status: "loaded" });
      }
      if (path === "/api/v1/models/unload") {
        loaded = false;
        return Response.json({ instance_id: "audit-instance" });
      }
      return new Response("not found", { status: 404 });
    }
  });
  try {
    const config = settings(`http://127.0.0.1:${server.port}`);
    const before = await getVlmAuditStatus(config);
    assert.equal(before.ok, true, "downloaded lifecycle-managed model is ready on demand");
    assert.deepEqual(before.loadedModelIds, []);

    const lease = await acquireVlmModel(config);
    assert.equal(lease.instanceId, "audit-instance");
    assert.equal(lease.settings.model, "audit-instance");
    await releaseVlmModel(lease);

    assert.deepEqual(calls.map((call) => call.path), [
      "/api/v1/models",
      "/api/v1/models",
      "/api/v1/models/load",
      "/api/v1/models/unload"
    ]);
    assert.deepEqual(calls[2]!.body, {
      model: "audit-model",
      context_length: 4096,
      flash_attention: true,
      offload_kv_cache_to_gpu: false
    });
    assert.deepEqual(calls[3]!.body, { instance_id: "audit-instance" });
  } finally {
    server.stop(true);
  }
});

test("LM Studio lifecycle reuses an already loaded vision instance", async () => {
  let postCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (request.method === "POST") postCount += 1;
      return Response.json({
        models: [{ key: "audit-model", capabilities: { vision: true }, loaded_instances: [{ id: "existing-instance" }] }]
      });
    }
  });
  try {
    const lease = await acquireVlmModel({ ...settings(`http://127.0.0.1:${server.port}`), unloadAfterAudit: false });
    assert.equal(lease.instanceId, "existing-instance");
    assert.equal(lease.settings.model, "existing-instance");
    await releaseVlmModel(lease);
    assert.equal(postCount, 0);
  } finally {
    server.stop(true);
  }
});
