import assert from "node:assert/strict";
import test from "node:test";
import { inspectContext, normalizeBaseUrl, parseCliArgs } from "./guruguru-agent-cli.mjs";
import { parseScriptMangaDeepLink } from "../src/shared/scriptMangaDeepLink";

test("agent CLI parses global options independently of command position", () => {
  assert.deepEqual(
    parseCliArgs(["--base-url", "http://127.0.0.1:5199", "context", "--project-id=p1", "--script-id", "s1"]),
    {
      positional: ["context"],
      options: {
        "base-url": "http://127.0.0.1:5199",
        "project-id": "p1",
        "script-id": "s1"
      }
    }
  );
  assert.equal(normalizeBaseUrl("http://127.0.0.1:5199/somewhere?x=1"), "http://127.0.0.1:5199");
});

test("agent CLI context verifies the complete API identity and emits the matching GUI URL", async () => {
  let candidateRunId = "run-1";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const payloads: Record<string, unknown> = {
        "/api/health": { ok: true, instanceMode: "agent" },
        "/api/projects": { projects: [{ id: "project-1", mode: "book", name: "Book" }] },
        "/api/projects/project-1/scripts": { scripts: [{ id: "script-1", projectId: "project-1" }] },
        "/api/scripts/script-1/revisions": { revisions: [{ id: "revision-1" }] },
        "/api/projects/project-1/script-manga-plan-candidates": {
          candidates: [{
            id: "candidate-1",
            status: "adopted",
            scriptRevisionId: "revision-1",
            adoptedRunId: candidateRunId,
            editVersion: 2
          }]
        },
        "/api/script-manga-runs/run-1": {
          id: "run-1",
          projectId: "project-1",
          scriptId: "script-1",
          scriptRevisionId: "revision-1",
          planId: "plan-1",
          status: "prepared",
          phase: "prepared",
          approvalStatus: "pending",
          completedCount: 0,
          failedCount: 0,
          tasks: [{ id: "task-1", pageId: "page-1", panelId: "panel-1", status: "pending" }]
        }
      };
      const payload = payloads[url.pathname];
      return payload === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(payload);
    }
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const result = await inspectContext(baseUrl, {
      "project-id": "project-1",
      "script-id": "script-1",
      "candidate-id": "candidate-1",
      "run-id": "run-1",
      "task-id": "task-1"
    });
    assert.equal(result.instance.instanceMode, "agent");
    assert.equal(result.context.revisionId, "revision-1");
    assert.equal(result.context.run?.planId, "plan-1");
    assert.equal(result.context.task?.panelId, "panel-1");
    assert.deepEqual(parseScriptMangaDeepLink(result.guiUrl), {
      projectId: "project-1",
      scriptId: "script-1",
      revisionId: "revision-1",
      runId: "run-1",
      planId: "plan-1",
      candidateId: "candidate-1",
      taskId: "task-1"
    });
    candidateRunId = "another-run";
    await assert.rejects(
      inspectContext(baseUrl, {
        "project-id": "project-1",
        "script-id": "script-1",
        "candidate-id": "candidate-1",
        "run-id": "run-1"
      }),
      /candidate and run are not the same adopted context/
    );
  } finally {
    server.stop(true);
  }
});
