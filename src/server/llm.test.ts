import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatCompletion,
  getLlmStatus,
  LlmHttpError,
  testLlmConnection,
  toLlmSettingsView
} from "./llm.ts";
import type { LlmSettings } from "../shared/types.ts";
import { defaultLlmSettings, initializeDb, setSetting } from "./db.ts";

type MockHandler = (req: Request) => Response | Promise<Response>;
type MockServer = ReturnType<typeof Bun.serve>;

function startMockLlmServer(handler: MockHandler): { server: MockServer; baseUrl: string } {
  const server = Bun.serve({ port: 0, fetch: handler });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

function baseSettings(baseUrl: string, overrides: Partial<LlmSettings> = {}): LlmSettings {
  return {
    baseUrl,
    model: "test-model",
    systemPrompt: "system",
    temperature: 0.4,
    ...overrides
  };
}

function chatResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { "content-type": "application/json" }
  });
}

test("chatCompletion: happy path returns trimmed content", async () => {
  const { server, baseUrl } = startMockLlmServer(() => chatResponse("  hello there  "));
  try {
    const result = await chatCompletion(baseSettings(baseUrl), { messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.content, "hello there");
  } finally {
    server.stop(true);
  }
});

test("chatCompletion: sends Authorization header only when apiKey is set", async () => {
  let seenAuth: string | null = null;
  const { server, baseUrl } = startMockLlmServer((req) => {
    seenAuth = req.headers.get("authorization");
    return chatResponse("ok");
  });
  try {
    await chatCompletion(baseSettings(baseUrl, { apiKey: "secret-token" }), {
      messages: [{ role: "user", content: "hi" }]
    });
    assert.equal(seenAuth, "Bearer secret-token");

    seenAuth = "unset";
    await chatCompletion(baseSettings(baseUrl), { messages: [{ role: "user", content: "hi" }] });
    assert.equal(seenAuth, null);
  } finally {
    server.stop(true);
  }
});

test("chatCompletion: 401 throws LlmHttpError(authError=true) without retrying", async () => {
  let callCount = 0;
  const { server, baseUrl } = startMockLlmServer(() => {
    callCount += 1;
    return new Response("unauthorized", { status: 401 });
  });
  try {
    await assert.rejects(
      chatCompletion(baseSettings(baseUrl), { messages: [{ role: "user", content: "hi" }] }),
      (error: unknown) => {
        assert.ok(error instanceof LlmHttpError);
        assert.equal(error.authError, true);
        assert.equal(error.retryable, false);
        return true;
      }
    );
    assert.equal(callCount, 1, "401 must not be retried");
  } finally {
    server.stop(true);
  }
});

test("chatCompletion: 429 is retried once and succeeds on the second attempt", async () => {
  let callCount = 0;
  const { server, baseUrl } = startMockLlmServer(() => {
    callCount += 1;
    if (callCount === 1) {
      return new Response("rate limited", { status: 429 });
    }
    return chatResponse("recovered");
  });
  try {
    const result = await chatCompletion(baseSettings(baseUrl), { messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.content, "recovered");
    assert.equal(callCount, 2);
  } finally {
    server.stop(true);
  }
});

test("chatCompletion: 500 is retried once, then throws if still failing", async () => {
  let callCount = 0;
  const { server, baseUrl } = startMockLlmServer(() => {
    callCount += 1;
    return new Response("boom", { status: 500 });
  });
  try {
    await assert.rejects(chatCompletion(baseSettings(baseUrl), { messages: [{ role: "user", content: "hi" }] }));
    assert.equal(callCount, 2, "500 should be retried exactly once");
  } finally {
    server.stop(true);
  }
});

test("chatCompletion: non-JSON error body is surfaced as an HTTP error, not a JSON.parse crash", async () => {
  const { server, baseUrl } = startMockLlmServer(() => new Response("<html>not json</html>", { status: 400 }));
  try {
    await assert.rejects(
      chatCompletion(baseSettings(baseUrl), { messages: [{ role: "user", content: "hi" }] }),
      (error: unknown) => {
        assert.ok(error instanceof LlmHttpError);
        assert.equal(error.status, 400);
        assert.match(error.message, /400/);
        return true;
      }
    );
  } finally {
    server.stop(true);
  }
});

test("chatCompletion: long error bodies are truncated to ~500 chars", async () => {
  const longBody = "x".repeat(2000);
  const { server, baseUrl } = startMockLlmServer(() => new Response(longBody, { status: 400 }));
  try {
    await assert.rejects(
      chatCompletion(baseSettings(baseUrl), { messages: [{ role: "user", content: "hi" }] }),
      (error: unknown) => {
        assert.ok(error instanceof LlmHttpError);
        assert.ok(error.message.length < longBody.length);
        return true;
      }
    );
  } finally {
    server.stop(true);
  }
});

test("chatCompletion: caller abort surfaces a cancellation-specific message", async () => {
  const { server, baseUrl } = startMockLlmServer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return chatResponse("too late");
  });
  try {
    const controller = new AbortController();
    const promise = chatCompletion(baseSettings(baseUrl), {
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
      timeoutMs: 5000
    });
    controller.abort();
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof LlmHttpError);
      assert.match(error.message, /キャンセル/);
      return true;
    });
  } finally {
    server.stop(true);
  }
});

test("toLlmSettingsView: apiKey 本体を落とし hasApiKey フラグだけを返す(既知の罠11)", () => {
  const withKey = toLlmSettingsView(baseSettings("http://example.invalid", { apiKey: "super-secret" }));
  assert.equal((withKey as unknown as { apiKey?: string }).apiKey, undefined, "apiKey フィールド自体を含まない");
  assert.equal(withKey.hasApiKey, true);
  assert.equal(JSON.stringify(withKey).includes("super-secret"), false);

  const withoutKey = toLlmSettingsView(baseSettings("http://example.invalid"));
  assert.equal(withoutKey.hasApiKey, false);
});

test("getLlmStatus reports a configured model that is absent from the server", async () => {
  initializeDb();
  const { server, baseUrl } = startMockLlmServer(() => Response.json({
    data: [{ id: "another-model" }]
  }));
  setSetting("llm", baseSettings(baseUrl));
  try {
    const status = await getLlmStatus();
    assert.equal(status.state, "connected");
    assert.equal(status.ok, false);
    assert.equal(status.model, "test-model");
    assert.equal(status.modelListed, false);
    assert.match(status.error ?? "", /not listed/i);
    const connection = await testLlmConnection();
    assert.equal(connection.ok, false);
    assert.equal(connection.modelListed, false);
  } finally {
    server.stop(true);
    setSetting("llm", defaultLlmSettings);
  }
});

test("getLlmStatus treats an explicitly empty OpenAI model list as unavailable", async () => {
  initializeDb();
  const { server, baseUrl } = startMockLlmServer(() => Response.json({ data: [] }));
  setSetting("llm", baseSettings(baseUrl));
  try {
    const status = await getLlmStatus();
    assert.equal(status.state, "connected");
    assert.equal(status.ok, false);
    assert.equal(status.modelListed, false);
  } finally {
    server.stop(true);
    setSetting("llm", defaultLlmSettings);
  }
});
