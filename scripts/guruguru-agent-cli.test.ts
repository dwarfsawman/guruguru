import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCandidateAdoptionRequest,
  confirmCandidateAdoption,
  confirmExternalAuditRecord,
  inspectContext,
  normalizeExternalAuditRequest,
  normalizeBaseUrl,
  parseCliArgs,
  resolveAgentRoute
} from "./guruguru-agent-cli.mjs";
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

test("agent CLI route selects embedded services only when their configured models are usable", async () => {
  let llmStatus: Record<string, unknown> | null = {
    ok: true,
    state: "connected",
    model: "director-model",
    modelListed: true
  };
  let vlmStatus: Record<string, unknown> = {
    ok: true,
    state: "model-not-loaded",
    model: "audit-model"
  };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/llm/status") {
        return llmStatus ? Response.json(llmStatus) : Response.json({ error: "temporary" }, { status: 500 });
      }
      if (path === "/api/vlm-audit/status") return Response.json(vlmStatus);
      return new Response("not found", { status: 404 });
    }
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const embedded = await resolveAgentRoute(baseUrl);
    assert.equal(embedded.planning.mode, "llm");
    assert.equal(embedded.planning.strategy, "embedded-candidates");
    assert.equal(embedded.audit.mode, "vlm", "on-demand VLM is a supported embedded route");

    llmStatus = { ok: true, state: "connected", model: "missing-model", modelListed: false };
    vlmStatus = { ok: false, state: "server-unreachable" };
    const external = await resolveAgentRoute(baseUrl);
    assert.equal(external.planning.mode, "provided");
    assert.equal(external.planning.strategy, "external-plan-import");
    assert.equal(external.audit.mode, "manual");
    assert.equal(external.audit.strategy, "external-audit-results");

    llmStatus = null;
    vlmStatus = { ok: true, state: "ready", model: "audit-model" };
    const partial = await resolveAgentRoute(baseUrl);
    assert.equal(partial.planning.mode, "provided", "one failed status must fail closed only for that service");
    assert.equal(partial.audit.mode, "vlm");
  } finally {
    server.stop(true);
  }
});

test("agent CLI adoption request applies routed audit mode and strict preparation gates", () => {
  assert.deepEqual(buildCandidateAdoptionRequest({ templateId: "template-1" }, "vlm"), {
    templateId: "template-1",
    auditMode: "vlm",
    generateImages: false,
    candidateSelectionPolicy: "review",
    requireReferenceSets: true,
    allowReferenceFallback: false
  });
  assert.equal(buildCandidateAdoptionRequest({ auditMode: "manual" }, "vlm").auditMode, "manual");
});

test("agent CLI accepts adoption only when candidate and run identities are atomically confirmed", () => {
  const confirmed = {
    candidate: { id: "candidate-1", status: "adopted", adoptedRunId: "run-1" },
    run: { id: "run-1" }
  };
  assert.equal(confirmCandidateAdoption("candidate-1", confirmed), confirmed);
  assert.throws(
    () => confirmCandidateAdoption("candidate-1", {
      candidate: { id: "candidate-1", status: "active", adoptedRunId: null },
      run: { id: "run-1" }
    }),
    /did not confirm/
  );
  assert.throws(
    () => confirmCandidateAdoption("candidate-1", {
      candidate: { id: "candidate-1", status: "adopted", adoptedRunId: "run-other" },
      run: { id: "run-1" }
    }),
    /did not confirm/
  );
});

test("agent CLI accepts external audit only when the dedicated report is echoed", () => {
  const request = {
    assetId: " asset-1 ",
    passed: true,
    score: 0.9,
    checks: { " anatomy ": "pass" },
    violations: ["  stray text  ", "stray text"],
    reviewer: " codex ",
    model: " vision-1 ",
    notes: " checked externally "
  };
  const normalized = normalizeExternalAuditRequest(request);
  const response = {
    report: { ...normalized, evaluatedAt: "2026-07-16T00:00:00.000Z" },
    run: { id: "run-1", tasks: [{ id: "task-1" }] }
  };
  assert.equal(confirmExternalAuditRecord("task-1", request, response), response);
  assert.throws(
    () => confirmExternalAuditRecord("task-1", request, {
      report: { ...normalized, passed: false, evaluatedAt: "2026-07-16T00:00:00.000Z" },
      run: { id: "run-1", tasks: [{ id: "task-1" }] }
    }),
    /did not confirm/
  );
});
