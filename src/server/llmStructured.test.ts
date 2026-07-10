import { test } from "node:test";
import assert from "node:assert/strict";
import { generateStructuredJson, StructuredJsonError } from "./llmStructured.ts";
import type { LlmSettings } from "../shared/types.ts";

type MockHandler = (req: Request, callIndex: number) => Response | Promise<Response>;
type MockServer = ReturnType<typeof Bun.serve>;

function startMockLlmServer(handler: MockHandler): { server: MockServer; baseUrl: string; callCount: () => number } {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const index = calls;
      calls += 1;
      return handler(req, index);
    }
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, callCount: () => calls };
}

function baseSettings(baseUrl: string): LlmSettings {
  return { baseUrl, model: "test-model", systemPrompt: "system", temperature: 0.4 };
}

function chatResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { "content-type": "application/json" }
  });
}

const SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object" } } },
  required: ["items"]
};

interface Item {
  text: string;
}

function validate(raw: unknown): Item[] | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { items?: unknown }).items)) {
    return null;
  }
  const items = (raw as { items: unknown[] }).items;
  const out: Item[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== "object" || typeof (entry as { text?: unknown }).text !== "string") {
      return null;
    }
    out.push({ text: (entry as { text: string }).text });
  }
  return out;
}

test("generateStructuredJson: first-try success with response_format:json_schema", async () => {
  let sawResponseFormat = false;
  const { server, baseUrl } = startMockLlmServer(async (req) => {
    const body = (await req.json()) as { response_format?: unknown };
    sawResponseFormat = body.response_format !== undefined;
    return chatResponse(JSON.stringify({ items: [{ text: "hello" }] }));
  });
  try {
    const result = await generateStructuredJson({
      settings: baseSettings(baseUrl),
      systemPrompt: "sys",
      userPrompt: "user",
      schema: SCHEMA,
      validate
    });
    assert.deepEqual(result.value, [{ text: "hello" }]);
    assert.equal(sawResponseFormat, true);
    assert.equal(result.messages.length, 2);
  } finally {
    server.stop(true);
  }
});

test("generateStructuredJson: strips code fences before parsing", async () => {
  const { server, baseUrl } = startMockLlmServer(() => chatResponse('```json\n{"items":[{"text":"fenced"}]}\n```'));
  try {
    const result = await generateStructuredJson({
      settings: baseSettings(baseUrl),
      systemPrompt: "sys",
      userPrompt: "user",
      schema: SCHEMA,
      validate
    });
    assert.deepEqual(result.value, [{ text: "fenced" }]);
  } finally {
    server.stop(true);
  }
});

test("generateStructuredJson: falls back to plain-prompt mode when json_schema mode errors", async () => {
  const { server, baseUrl, callCount } = startMockLlmServer(async (req, index) => {
    const body = (await req.json()) as { response_format?: unknown };
    if (index === 0) {
      assert.ok(body.response_format, "first attempt should request json_schema");
      return new Response("response_format not supported", { status: 400 });
    }
    assert.equal(body.response_format, undefined, "fallback attempt should not request json_schema");
    return chatResponse(JSON.stringify({ items: [{ text: "fallback-ok" }] }));
  });
  try {
    const result = await generateStructuredJson({
      settings: baseSettings(baseUrl),
      systemPrompt: "sys",
      userPrompt: "user",
      schema: SCHEMA,
      validate
    });
    assert.deepEqual(result.value, [{ text: "fallback-ok" }]);
    // フォールバック切り替え自体は maxRetries を消費しない: 2 回の HTTP 呼び出しで成功する。
    assert.equal(callCount(), 2);
  } finally {
    server.stop(true);
  }
});

test("generateStructuredJson: retries on schema validation failure and eventually succeeds", async () => {
  const { server, baseUrl } = startMockLlmServer((_req, index) => {
    if (index === 0) {
      return chatResponse(JSON.stringify({ items: [{ oops: "not text field" }] }));
    }
    return chatResponse(JSON.stringify({ items: [{ text: "recovered" }] }));
  });
  try {
    const result = await generateStructuredJson({
      settings: baseSettings(baseUrl),
      systemPrompt: "sys",
      userPrompt: "user",
      schema: SCHEMA,
      validate,
      maxRetries: 2
    });
    assert.deepEqual(result.value, [{ text: "recovered" }]);
  } finally {
    server.stop(true);
  }
});

test("generateStructuredJson: throws StructuredJsonError carrying last messages/rawOutput after exhausting retries", async () => {
  const { server, baseUrl } = startMockLlmServer(() => chatResponse("not json at all"));
  try {
    await assert.rejects(
      generateStructuredJson({
        settings: baseSettings(baseUrl),
        systemPrompt: "sys",
        userPrompt: "user",
        schema: SCHEMA,
        validate,
        maxRetries: 1
      }),
      (error: unknown) => {
        assert.ok(error instanceof StructuredJsonError);
        assert.ok(error.messages.length > 0);
        assert.equal(error.rawOutput, "not json at all");
        return true;
      }
    );
  } finally {
    server.stop(true);
  }
});

test("generateStructuredJson: 401/403 is not retried and surfaces immediately", async () => {
  let callCount = 0;
  const { server, baseUrl } = startMockLlmServer(() => {
    callCount += 1;
    return new Response("unauthorized", { status: 401 });
  });
  try {
    await assert.rejects(
      generateStructuredJson({
        settings: baseSettings(baseUrl),
        systemPrompt: "sys",
        userPrompt: "user",
        schema: SCHEMA,
        validate,
        maxRetries: 2
      })
    );
    assert.equal(callCount, 1, "401 must short-circuit without retrying or falling back");
  } finally {
    server.stop(true);
  }
});
