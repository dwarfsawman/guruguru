import assert from "node:assert/strict";
import test from "node:test";
import { buildScriptMangaDeepLink, parseScriptMangaDeepLink } from "./scriptMangaDeepLink";

test("script manga deep links round-trip every identity without preserving unrelated browser state", () => {
  const built = buildScriptMangaDeepLink("http://127.0.0.1:5199/old?stale=1#fragment", {
    projectId: "project / one",
    scriptId: "script-2",
    revisionId: "revision-2",
    runId: "run-3",
    planId: "plan-3",
    candidateId: "candidate-4",
    taskId: "task-5"
  });
  const url = new URL(built);
  assert.equal(url.origin, "http://127.0.0.1:5199");
  assert.equal(url.pathname, "/");
  assert.equal(url.hash, "");
  assert.equal(url.searchParams.has("stale"), false);
  assert.deepEqual(parseScriptMangaDeepLink(url), {
    projectId: "project / one",
    scriptId: "script-2",
    revisionId: "revision-2",
    runId: "run-3",
    planId: "plan-3",
    candidateId: "candidate-4",
    taskId: "task-5"
  });
});

test("script manga deep links reject incomplete or unrelated URLs", () => {
  assert.equal(parseScriptMangaDeepLink("http://127.0.0.1:5199/"), null);
  assert.equal(parseScriptMangaDeepLink("http://127.0.0.1:5199/?view=script&projectId=p"), null);
  assert.equal(parseScriptMangaDeepLink("http://127.0.0.1:5199/?view=book&projectId=p&scriptId=s"), null);
});
