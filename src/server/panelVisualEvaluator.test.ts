import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join, resolve } from "node:path";
import type { PanelSpec, ReferenceSpec } from "../shared/mangaPlanV2.ts";
import type { VlmAuditSettings } from "../shared/types.ts";

// This test module must never open the normal user database. Set the guard before dynamically
// importing panelVisualEvaluator (which imports db.ts and therefore opens its selected database).
process.env.GURUGURU_TEST_DB = "1";

const { createId, dataRoot, initializeDb, runSql } = await import("./db.ts");
const { evaluatePanelCandidate, PanelVisualEvaluationError } = await import("./panelVisualEvaluator.ts");

type MockHandler = (request: Request, callIndex: number) => Response | Promise<Response>;
type MockServer = ReturnType<typeof Bun.serve>;

interface Fixture {
  assetId: string;
  projectId: string;
  templateId: string;
  directory: string;
  candidateBytes: Buffer;
  referenceBytes: Buffer[];
  panel: PanelSpec;
  dispose: () => Promise<void>;
}

function startMockVlm(handler: MockHandler): { server: MockServer; baseUrl: string; callCount: () => number } {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const index = calls;
      calls += 1;
      return handler(request, index);
    }
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}/v1`, callCount: () => calls };
}

function settings(baseUrl: string, overrides: Partial<VlmAuditSettings> = {}): VlmAuditSettings {
  return {
    baseUrl,
    model: "mock-gemma-4-e2b",
    temperature: 0,
    timeoutSeconds: 2,
    maxReferenceImages: 2,
    passThreshold: 0.8,
    ...overrides
  };
}

function chatResponse(value: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
    headers: { "content-type": "application/json" }
  });
}

async function createFixture(referenceCount = 3): Promise<Fixture> {
  initializeDb();
  const suffix = createId("panel_vlm_test");
  const projectId = `project_${suffix}`;
  const templateId = `template_${suffix}`;
  const roundId = `round_${suffix}`;
  const assetId = `asset_${suffix}`;
  const directory = join(dataRoot, "panel-visual-evaluator-tests", suffix);
  await mkdir(directory, { recursive: true });

  const candidateBytes = Buffer.from(`medium-thumbnail-${suffix}`);
  const candidatePath = join(directory, "candidate-medium.png");
  await writeFile(candidatePath, candidateBytes);
  runSql("INSERT INTO projects (id, name, storage_dir) VALUES (?, ?, ?)", [projectId, suffix, directory]);
  runSql(
    `INSERT INTO workflow_templates (id, name, type, workflow_json, role_map_json, workflow_hash)
     VALUES (?, ?, 'txt2img', '{}', '{}', 'fixture-hash')`,
    [templateId, suffix]
  );
  runSql(
    `INSERT INTO generation_rounds
       (id, project_id, template_id, round_index, status, generation_mode, request_json)
     VALUES (?, ?, ?, 0, 'completed', 'txt2img', '{}')`,
    [roundId, projectId, templateId]
  );
  // image_path and small thumbnail are deliberately unusable: the evaluator must read the medium
  // thumbnail column and nothing else.
  runSql(
    `INSERT INTO assets
       (id, project_id, round_id, batch_index, image_path, thumbnail_small_path, thumbnail_medium_path,
        workflow_template_id, workflow_template_version, workflow_snapshot_hash)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1, 'fixture-hash')`,
    [assetId, projectId, roundId, join(directory, "unused-image.png"), join(directory, "unused-small.png"), candidatePath, templateId]
  );

  const manifest: ReferenceSpec[] = [];
  const referenceBytes: Buffer[] = [];
  for (let index = 0; index < referenceCount; index += 1) {
    const characterId = `character_${index}_${suffix}`;
    const bindingId = `binding_${index}_${suffix}`;
    const bytes = Buffer.from(`character-reference-${index}-${suffix}`);
    const faceImagePath = join(directory, `character-${index}.png`);
    await writeFile(faceImagePath, bytes);
    referenceBytes.push(bytes);
    runSql("INSERT INTO characters (id, project_id, name) VALUES (?, ?, ?)", [characterId, projectId, `Character ${index}`]);
    runSql(
      "INSERT INTO character_bindings (id, character_id, provider_id, binding_json) VALUES (?, ?, 'comfy', ?)",
      [bindingId, characterId, JSON.stringify({ faceImagePath })]
    );
    manifest.push({
      entityId: characterId,
      variantId: "default",
      artifact: { kind: "characterBinding", characterId, providerId: "comfy", role: "face" },
      role: "identity",
      strength: 1
    });
  }

  const focalCharacterId = manifest[0]?.entityId ?? `unbound-character-${suffix}`;
  const panel: PanelSpec = {
    id: `panel-${suffix}`,
    sourceElementIds: ["source-1"],
    beatIds: ["beat-1"],
    preStateId: "state-before",
    postStateDelta: { notes: ["the key is now held"] },
    settingId: "setting-lab",
    cast: [{
      characterId: focalCharacterId,
      variantId: "default",
      bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.8 },
      pose: "standing",
      gazeTarget: "prop-key",
      expression: "alert",
      action: "raises the key",
      speakingLineIds: []
    }],
    props: [{ entityId: "prop-key", state: "held", bbox: { x: 0.45, y: 0.35, width: 0.1, height: 0.1 } }],
    shot: {
      size: "medium",
      angle: "eye-level",
      focalSubjectId: focalCharacterId,
      compositionIntent: "character and raised key clearly visible"
    },
    dialogueLineIds: [],
    dialogueOrderIndexes: [],
    textSafeZones: [{ x: 0.65, y: 0.05, width: 0.3, height: 0.25 }],
    mustShow: [{ kind: "action", description: "The focal character raises the key", entityId: focalCharacterId }],
    mustNotShow: [{ kind: "other", description: "No lettering or speech bubbles" }],
    continuityFromPanelIds: ["previous-panel"],
    referenceManifest: manifest,
    sceneIndex: 0,
    sceneHeading: "INT. LAB - NIGHT",
    sourceText: "The character raises the key.",
    promptBase: "A character raises a key in a dark laboratory.",
    compiledPrompt: "medium shot, focal character raises the key, no text"
  };

  return {
    assetId,
    projectId,
    templateId,
    directory,
    candidateBytes,
    referenceBytes,
    panel,
    dispose: async () => {
      runSql("DELETE FROM projects WHERE id = ?", [projectId]);
      runSql("DELETE FROM workflow_templates WHERE id = ?", [templateId]);
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("evaluatePanelCandidate sends the medium thumbnail, bounded character references, and PanelSpec constraints", async () => {
  const fixture = await createFixture(3);
  let capturedBody: Record<string, unknown> | null = null;
  let capturedPath = "";
  const { server, baseUrl, callCount } = startMockVlm(async (request) => {
    capturedPath = new URL(request.url).pathname;
    capturedBody = await request.json() as Record<string, unknown>;
    return chatResponse({
      score: 0.92,
      checks: { visualIdentity: "pass", actionAlignment: "pass", fakeText: "pass", continuity: "pass" },
      violations: []
    });
  });
  try {
    const result = await evaluatePanelCandidate({ assetId: fixture.assetId, panel: fixture.panel, settings: settings(baseUrl) });
    assert.equal(callCount(), 1);
    assert.equal(capturedPath, "/v1/chat/completions");
    const requestBody = capturedBody as Record<string, unknown> | null;
    assert.ok(requestBody);
    assert.equal(requestBody.model, "mock-gemma-4-e2b");
    assert.equal((requestBody.response_format as { json_schema?: { strict?: boolean } }).json_schema?.strict, true);

    const messages = requestBody.messages as Array<{ role: string; content: unknown }>;
    assert.equal(messages.length, 2);
    const parts = messages[1]!.content as Array<{ type: string; image_url?: { url: string }; text?: string }>;
    const images = parts.filter((part) => part.type === "image_url");
    assert.equal(images.length, 3, "candidate plus maxReferenceImages=2 identity references");
    assert.equal(images[0]!.image_url!.url, `data:image/png;base64,${fixture.candidateBytes.toString("base64")}`);
    assert.equal(images[1]!.image_url!.url, `data:image/png;base64,${fixture.referenceBytes[0]!.toString("base64")}`);
    assert.equal(images[2]!.image_url!.url, `data:image/png;base64,${fixture.referenceBytes[1]!.toString("base64")}`);
    const prompt = parts.find((part) => part.type === "text")!.text!;
    assert.match(prompt, new RegExp(fixture.panel.id));
    assert.match(prompt, /raises the key/);
    assert.match(prompt, /"imageIndex":2/);
    assert.doesNotMatch(prompt, /base64|candidate-medium\.png/);

    assert.deepEqual({ ...result, evaluatedAt: "<timestamp>" }, {
      assetId: fixture.assetId,
      score: 0.92,
      passed: true,
      checks: { visualIdentity: "pass", actionAlignment: "pass", fakeText: "pass", continuity: "pass" },
      violations: [],
      model: "mock-gemma-4-e2b",
      evaluatedAt: "<timestamp>"
    });
    assert.ok(Number.isFinite(Date.parse(result.evaluatedAt)));
    const persistedShape = JSON.stringify(result);
    assert.doesNotMatch(persistedShape, /base64|data:image|candidate-medium\.png/);
    assert.equal(persistedShape.includes(resolve(fixture.directory)), false);
  } finally {
    server.stop(true);
    await fixture.dispose();
  }
});

test("evaluatePanelCandidate computes passed from the threshold, checks, and violations", async () => {
  const fixture = await createFixture(0);
  const { server, baseUrl } = startMockVlm(() => chatResponse({
    score: 0.95,
    checks: { visualIdentity: "pass", actionAlignment: "pass", fakeText: "fail", continuity: "pass" },
    violations: ["fake-text: pseudo lettering is visible"]
  }));
  try {
    const result = await evaluatePanelCandidate({ assetId: fixture.assetId, panel: fixture.panel, settings: settings(baseUrl) });
    assert.equal(result.passed, false);
    assert.equal(result.score, 0.95);
    assert.equal(result.checks.fakeText, "fail");
    assert.deepEqual(result.violations, ["fake-text: pseudo lettering is visible"]);
  } finally {
    server.stop(true);
    await fixture.dispose();
  }
});

test("evaluatePanelCandidate uses LM Studio native image input with reasoning disabled", async () => {
  const fixture = await createFixture(0);
  let captured: Record<string, unknown> | null = null;
  let path = "";
  const { server, baseUrl } = startMockVlm(async (request) => {
    path = new URL(request.url).pathname;
    captured = await request.json() as Record<string, unknown>;
    return Response.json({
      output: [{
        type: "message",
        content: "```json\n{\"score\":0.88,\"checks\":{\"visualIdentity\":\"pass\",\"actionAlignment\":\"pass\",\"fakeText\":\"pass\",\"continuity\":\"pass\"},\"violations\":[]}\n```"
      }]
    });
  });
  try {
    const result = await evaluatePanelCandidate({
      assetId: fixture.assetId,
      panel: fixture.panel,
      settings: settings(baseUrl, { transport: "lmstudio-native", contextLength: 4096 })
    });
    assert.equal(path, "/api/v1/chat");
    const body = captured as Record<string, unknown> | null;
    assert.ok(body);
    assert.equal(body.reasoning, "off");
    assert.equal(body.store, false);
    const input = body.input as Array<{ type?: string; data_url?: string; content?: string }>;
    assert.deepEqual(input.map((item) => item.type), ["text", "image"]);
    assert.match(input[1]!.data_url!, /^data:image\/png;base64,/);
    assert.equal(result.passed, true);
    assert.equal(result.score, 0.88);
  } finally {
    server.stop(true);
    await fixture.dispose();
  }
});

test("evaluatePanelCandidate rejects non-strict model JSON instead of persisting a partial audit", async () => {
  const fixture = await createFixture(0);
  const { server, baseUrl } = startMockVlm(() => chatResponse({
    score: 1,
    passed: true,
    checks: { visualIdentity: "pass", actionAlignment: "pass", fakeText: "pass", continuity: "pass" },
    violations: []
  }));
  try {
    await assert.rejects(
      evaluatePanelCandidate({ assetId: fixture.assetId, panel: fixture.panel, settings: settings(baseUrl) }),
      (error: unknown) => error instanceof PanelVisualEvaluationError && /top-level shape/.test(error.message)
    );
  } finally {
    server.stop(true);
    await fixture.dispose();
  }
});

test("evaluatePanelCandidate rejects a medium-thumbnail path outside dataRoot before any HTTP request", async () => {
  const fixture = await createFixture(0);
  runSql("UPDATE assets SET thumbnail_medium_path = ? WHERE id = ?", [
    resolve(dataRoot, "..", "outside-panel-visual-audit.png"),
    fixture.assetId
  ]);
  const { server, baseUrl, callCount } = startMockVlm(() => chatResponse({
    score: 1,
    checks: { visualIdentity: "pass", actionAlignment: "pass", fakeText: "pass", continuity: "pass" },
    violations: []
  }));
  try {
    await assert.rejects(
      evaluatePanelCandidate({ assetId: fixture.assetId, panel: fixture.panel, settings: settings(baseUrl) }),
      (error: unknown) => error instanceof PanelVisualEvaluationError && /outside/.test(error.message)
    );
    assert.equal(callCount(), 0);
  } finally {
    server.stop(true);
    await fixture.dispose();
  }
});

test("evaluatePanelCandidate propagates OpenAI-compatible endpoint failures for the caller's fail-open policy", async () => {
  const fixture = await createFixture(0);
  const { server, baseUrl, callCount } = startMockVlm(() => new Response("mock endpoint unavailable", { status: 400 }));
  try {
    await assert.rejects(
      evaluatePanelCandidate({ assetId: fixture.assetId, panel: fixture.panel, settings: settings(baseUrl) }),
      /400/
    );
    assert.equal(callCount(), 1);
  } finally {
    server.stop(true);
    await fixture.dispose();
  }
});
