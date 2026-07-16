import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildScriptMangaDeepLink } from "../src/shared/scriptMangaDeepLink.ts";

const HELP = `GURUGURU agent CLI

All commands operate through the same HTTP API used by the GUI. Set --base-url on every
invocation or export GURUGURU_BASE_URL. No command reads the runtime database.

  bun run agent:cli -- --base-url URL context --project-id PROJECT --script-id SCRIPT [--candidate-id CANDIDATE] [--run-id RUN] [--task-id TASK]

  bun run agent:cli -- --base-url URL api METHOD /api/path [--json '{"key":"value"}' | --json-file request.json] [--output file]

  bun run agent:cli -- --base-url URL route

  bun run agent:cli -- --base-url URL candidate create --project-id PROJECT --script-id SCRIPT [--json-file options.json]
    [--revision-id REVISION --plan-file plan.json --group-id GROUP --profile readability]

  bun run agent:cli -- --base-url URL candidate import --project-id PROJECT --script-id SCRIPT
    --revision-id REVISION --plan-file plan.json [--group-id GROUP --profile readability]

  bun run agent:cli -- --base-url URL candidate preflight --candidate-id CANDIDATE
    [--template-id TEMPLATE] [--json-file config.json]

  bun run agent:cli -- --base-url URL candidate adopt --candidate-id CANDIDATE
    [--template-id TEMPLATE] [--json-file config.json]

  bun run agent:cli -- --base-url URL audit record --task-id TASK --json-file audit.json

  bun run agent:cli -- --base-url URL wait candidates --project-id PROJECT --script-id SCRIPT [--status adopted] [--interval 15] [--timeout 30]

  bun run agent:cli -- --base-url URL wait run --run-id RUN [--field approvalStatus] --equals approved [--interval 15] [--timeout 30]

The context command verifies project/script/fixed revision/candidate/run/plan/task relations
against the API and prints the canonical GUI URL for a human gate. Agents should not open it.

The route command checks the configured LLM/VLM services and selects the embedded or external
agent path. candidate create follows that decision: it uses embedded candidates when available,
or imports --plan-file at the pinned --revision-id when the embedded LLM is unavailable.
Use candidate import (or --force-external) when the supplied plan must be imported even while
the embedded LLM is ready.
`;

export function parseCliArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equalIndex = token.indexOf("=");
    if (equalIndex >= 0) {
      options[token.slice(2, equalIndex)] = token.slice(equalIndex + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return { positional, options };
}

function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

function numberOption(options, name, fallback, { minimum = 0 } = {}) {
  const raw = options[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`--${name} must be >= ${minimum}`);
  return value;
}

export function normalizeBaseUrl(value) {
  if (!value) throw new Error("--base-url or GURUGURU_BASE_URL is required");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("base URL must use http or https");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function apiUrl(baseUrl, path) {
  if (!path.startsWith("/api/")) throw new Error("API path must begin with /api/");
  return new URL(path, `${baseUrl}/`).toString();
}

async function responsePayload(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return await response.json();
  return await response.text();
}

export class AgentApiError extends Error {
  constructor(method, path, status, payload) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    super(`${method} ${path} -> ${status}: ${detail}`);
    this.name = "AgentApiError";
    this.status = status;
    this.payload = payload;
    this.exitCode = status === 422 && payload?.preflight ? 2 : 1;
  }
}

async function fetchChecked(baseUrl, path, init) {
  const response = await fetch(apiUrl(baseUrl, path), {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) }
  });
  if (!response.ok) {
    const payload = await responsePayload(response);
    throw new AgentApiError(init?.method ?? "GET", path, response.status, payload);
  }
  return response;
}

async function fetchJson(baseUrl, path, init) {
  const response = await fetchChecked(baseUrl, path, init);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${path} did not return JSON (${contentType || "unknown content type"})`);
  }
  return await response.json();
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function jsonBodyFromOptions(options) {
  if (options.json !== undefined && options["json-file"] !== undefined) {
    throw new Error("use only one of --json or --json-file");
  }
  if (typeof options.json === "string") return JSON.parse(options.json);
  if (typeof options["json-file"] === "string") {
    return JSON.parse(await readFile(resolve(options["json-file"]), "utf8"));
  }
  return {};
}

function objectBody(value, label = "JSON body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stringOption(options, name) {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Select the supported production path without guessing from a failed generation call.
 * A reachable OpenAI-compatible server that explicitly omits the configured model is not
 * considered usable. VLM status `ok` includes the supported on-demand-load state.
 */
export async function resolveAgentRoute(baseUrl) {
  const [llm, vlm] = await Promise.all([
    fetchJson(baseUrl, "/api/llm/status").catch((error) => ({
      ok: false,
      state: "status-unavailable",
      error: error instanceof Error ? error.message : String(error)
    })),
    fetchJson(baseUrl, "/api/vlm-audit/status").catch((error) => ({
      ok: false,
      state: "status-unavailable",
      error: error instanceof Error ? error.message : String(error)
    }))
  ]);
  const embeddedPlanning = llm?.ok === true && llm?.modelListed !== false;
  const embeddedAudit = vlm?.ok === true;
  return {
    planning: {
      mode: embeddedPlanning ? "llm" : "provided",
      strategy: embeddedPlanning ? "embedded-candidates" : "external-plan-import",
      endpoint: embeddedPlanning
        ? "/api/projects/:projectId/script-manga-plan-candidates"
        : "/api/projects/:projectId/script-manga-plan-candidates/import",
      service: llm
    },
    audit: {
      mode: embeddedAudit ? "vlm" : "manual",
      strategy: embeddedAudit ? "embedded-vlm" : "external-audit-results",
      endpoint: embeddedAudit
        ? "/api/script-manga-tasks/:taskId/audit"
        : "/api/script-manga-tasks/:taskId/audit-results",
      service: vlm
    }
  };
}

function listFrom(value, key) {
  if (!value || typeof value !== "object" || !Array.isArray(value[key])) return [];
  return value[key];
}

function summaryCandidate(candidate) {
  return {
    id: candidate.id,
    status: candidate.status,
    scriptRevisionId: candidate.scriptRevisionId,
    adoptedRunId: candidate.adoptedRunId ?? null,
    editVersion: candidate.editVersion
  };
}

function summaryRun(run) {
  return {
    id: run.id,
    projectId: run.projectId,
    scriptId: run.scriptId,
    scriptRevisionId: run.scriptRevisionId,
    planId: run.planId,
    status: run.status,
    phase: run.phase,
    approvalStatus: run.approvalStatus,
    completedCount: run.completedCount,
    failedCount: run.failedCount,
    taskCount: Array.isArray(run.tasks) ? run.tasks.length : 0
  };
}

export async function inspectContext(baseUrl, options) {
  const projectId = requiredOption(options, "project-id");
  const scriptId = requiredOption(options, "script-id");
  const candidateId = typeof options["candidate-id"] === "string" ? options["candidate-id"] : undefined;
  const runId = typeof options["run-id"] === "string" ? options["run-id"] : undefined;
  const taskId = typeof options["task-id"] === "string" ? options["task-id"] : undefined;
  if (taskId && !runId) throw new Error("--task-id requires --run-id");

  const [health, projectsResponse, scriptsResponse, revisionsResponse, candidatesResponse, run] = await Promise.all([
    fetchJson(baseUrl, "/api/health"),
    fetchJson(baseUrl, "/api/projects"),
    fetchJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/scripts`),
    fetchJson(baseUrl, `/api/scripts/${encodeURIComponent(scriptId)}/revisions`),
    fetchJson(
      baseUrl,
      `/api/projects/${encodeURIComponent(projectId)}/script-manga-plan-candidates?scriptId=${encodeURIComponent(scriptId)}`
    ),
    runId ? fetchJson(baseUrl, `/api/script-manga-runs/${encodeURIComponent(runId)}`) : Promise.resolve(null)
  ]);

  const project = listFrom(projectsResponse, "projects").find((entry) => entry?.id === projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
  if (project.mode !== "book") throw new Error(`project is not a Book project: ${projectId}`);
  const script = listFrom(scriptsResponse, "scripts").find((entry) => entry?.id === scriptId);
  if (!script) throw new Error(`script does not belong to project: ${scriptId}`);
  const revisions = listFrom(revisionsResponse, "revisions");
  const latestRevision = revisions.at(-1);
  if (!latestRevision?.id) throw new Error(`script has no revision: ${scriptId}`);
  const candidates = listFrom(candidatesResponse, "candidates");
  const candidate = candidateId ? candidates.find((entry) => entry?.id === candidateId) : null;
  if (candidateId && !candidate) throw new Error(`candidate is not in the latest fixed revision: ${candidateId}`);
  if (candidate && candidate.scriptRevisionId !== latestRevision.id) {
    throw new Error("candidate revision does not match the script's latest revision");
  }
  if (run) {
    if (run.projectId !== projectId || run.scriptId !== scriptId) {
      throw new Error("run does not belong to the requested project/script");
    }
    if (run.scriptRevisionId !== latestRevision.id) {
      throw new Error("run revision does not match the script's latest revision");
    }
    if (candidate && candidate.adoptedRunId !== run.id) {
      throw new Error("candidate and run are not the same adopted context");
    }
  }
  const task = taskId && run?.tasks?.find((entry) => entry?.id === taskId);
  if (taskId && !task) throw new Error(`task does not belong to run: ${taskId}`);

  const deepLinkContext = {
    projectId,
    scriptId,
    revisionId: latestRevision.id,
    ...(candidateId ? { candidateId } : {}),
    ...(runId ? { runId, ...(run.planId ? { planId: run.planId } : {}) } : {}),
    ...(taskId ? { taskId } : {})
  };
  return {
    baseUrl,
    instance: {
      ok: health?.ok ?? null,
      instanceMode: health?.instanceMode ?? null
    },
    context: {
      projectId,
      scriptId,
      revisionId: latestRevision.id,
      candidate: candidate ? summaryCandidate(candidate) : null,
      run: run ? summaryRun(run) : null,
      task: task
        ? { id: task.id, pageId: task.pageId, panelId: task.panelId, status: task.status }
        : null
    },
    candidateCount: candidates.length,
    guiUrl: buildScriptMangaDeepLink(baseUrl, deepLinkContext)
  };
}

async function runApiCommand(baseUrl, positional, options) {
  const method = (positional[1] ?? "").toUpperCase();
  const path = positional[2] ?? "";
  if (!method || !path) throw new Error("api requires METHOD and /api/path");
  let body;
  if (options.json !== undefined || options["json-file"] !== undefined) {
    body = JSON.stringify(await jsonBodyFromOptions(options));
  }
  const response = await fetchChecked(baseUrl, path, {
    method,
    ...(body === undefined ? {} : { body, headers: { "Content-Type": "application/json" } })
  });
  const output = typeof options.output === "string" ? resolve(options.output) : null;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, new Uint8Array(await response.arrayBuffer()));
    process.stdout.write(`${JSON.stringify({ output, status: response.status })}\n`);
    return;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") && !contentType.startsWith("text/")) {
    throw new Error(`binary response (${contentType || "unknown"}) requires --output`);
  }
  const payload = await responsePayload(response);
  process.stdout.write(`${typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)}\n`);
}

async function postJson(baseUrl, path, body) {
  return fetchJson(baseUrl, path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" }
  });
}

/** Fail closed unless the atomic adopt response proves both sides of the candidate/run relation. */
export function confirmCandidateAdoption(candidateId, result) {
  if (
    result?.candidate?.id !== candidateId ||
    result?.candidate?.status !== "adopted" ||
    typeof result?.run?.id !== "string" ||
    result.candidate.adoptedRunId !== result.run.id
  ) {
    throw new Error("candidate adoption response did not confirm the adopted candidate/run identity");
  }
  return result;
}

export function buildCandidateAdoptionRequest(body, routedAuditMode) {
  return {
    ...objectBody(body),
    auditMode: body.auditMode === undefined ? routedAuditMode : body.auditMode,
    generateImages: false,
    candidateSelectionPolicy: "review",
    requireReferenceSets: true,
    allowReferenceFallback: false
  };
}

export function normalizeExternalAuditRequest(request) {
  const body = objectBody(request, "audit JSON body");
  const checks = body.checks && typeof body.checks === "object" && !Array.isArray(body.checks)
    ? Object.fromEntries(Object.entries(body.checks).map(([name, value]) => [name.trim(), value]))
    : body.checks ?? {};
  const violations = Array.isArray(body.violations)
    ? [...new Set(body.violations.map((value) => typeof value === "string" ? value.trim() : value))]
    : body.violations ?? [];
  return {
    ...body,
    assetId: typeof body.assetId === "string" ? body.assetId.trim() : body.assetId,
    reviewer: typeof body.reviewer === "string" ? body.reviewer.trim() : body.reviewer,
    model: typeof body.model === "string" ? body.model.trim() : body.model,
    notes: typeof body.notes === "string" ? body.notes.trim() : body.notes ?? "",
    checks,
    violations
  };
}

export function confirmExternalAuditRecord(taskId, request, result) {
  const expected = normalizeExternalAuditRequest(request);
  const actual = result?.report;
  if (
    actual?.assetId !== expected.assetId ||
    actual?.passed !== expected.passed ||
    actual?.score !== expected.score ||
    actual?.reviewer !== expected.reviewer ||
    actual?.model !== expected.model ||
    actual?.notes !== expected.notes ||
    JSON.stringify(actual?.checks) !== JSON.stringify(expected.checks) ||
    JSON.stringify(actual?.violations) !== JSON.stringify(expected.violations) ||
    typeof actual?.evaluatedAt !== "string" ||
    typeof result?.run?.id !== "string" ||
    !Array.isArray(result.run.tasks) ||
    !result.run.tasks.some((task) => task?.id === taskId)
  ) {
    throw new Error("external audit response did not confirm the persisted report");
  }
  return result;
}

/** --plan-file is an automatic-route fallback; its mere presence must not bypass a healthy LLM. */
export function shouldImportCandidate(route, options) {
  return options["force-external"] === true || route?.planning?.mode === "provided";
}

function applyCommonCandidateOptions(body, options) {
  const groupId = stringOption(options, "group-id");
  const profile = stringOption(options, "profile");
  const agent = stringOption(options, "agent");
  const model = stringOption(options, "model");
  const notes = stringOption(options, "notes");
  return {
    ...body,
    ...(groupId ? { groupId } : {}),
    ...(profile ? { profile } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(notes ? { notes } : {})
  };
}

async function importCandidate(baseUrl, options, initialBody = {}) {
  const projectId = requiredOption(options, "project-id");
  const scriptId = requiredOption(options, "script-id");
  const scriptRevisionId = requiredOption(options, "revision-id");
  const planFile = requiredOption(options, "plan-file");
  const plan = JSON.parse(await readFile(resolve(planFile), "utf8"));
  const body = applyCommonCandidateOptions({
    ...objectBody(initialBody),
    scriptId,
    scriptRevisionId,
    plan
  }, options);
  return postJson(
    baseUrl,
    `/api/projects/${encodeURIComponent(projectId)}/script-manga-plan-candidates/import`,
    body
  );
}

async function runCandidateCommand(baseUrl, positional, options) {
  const action = positional[1];
  if (action === "create") {
    const projectId = requiredOption(options, "project-id");
    const scriptId = requiredOption(options, "script-id");
    const body = objectBody(await jsonBodyFromOptions(options));
    const route = await resolveAgentRoute(baseUrl);
    if (shouldImportCandidate(route, options)) {
      if (typeof options["plan-file"] !== "string") {
        throw new Error("embedded LLM is unavailable; provide --revision-id and --plan-file for external import");
      }
      const result = await importCandidate(baseUrl, options, body);
      writeJson({ route: route.planning, result });
      return;
    }
    const result = await postJson(
      baseUrl,
      `/api/projects/${encodeURIComponent(projectId)}/script-manga-plan-candidates`,
      { ...body, scriptId }
    );
    writeJson({ route: route.planning, result });
    return;
  }
  if (action === "import") {
    writeJson(await importCandidate(baseUrl, options, await jsonBodyFromOptions(options)));
    return;
  }
  if (action === "preflight") {
    const candidateId = requiredOption(options, "candidate-id");
    const body = objectBody(await jsonBodyFromOptions(options));
    const templateId = stringOption(options, "template-id");
    const providerId = stringOption(options, "provider-id");
    const report = await postJson(
      baseUrl,
      `/api/script-manga-plan-candidates/${encodeURIComponent(candidateId)}/preflight`,
      { ...body, ...(templateId ? { templateId } : {}), ...(providerId ? { providerId } : {}) }
    );
    writeJson(report);
    if (report?.ok !== true) {
      const error = new Error("candidate preflight failed");
      error.exitCode = 2;
      throw error;
    }
    return;
  }
  if (action === "adopt") {
    const candidateId = requiredOption(options, "candidate-id");
    const body = objectBody(await jsonBodyFromOptions(options));
    const templateId = stringOption(options, "template-id");
    const providerId = stringOption(options, "provider-id");
    const requestBody = {
      ...body,
      ...(templateId ? { templateId } : {}),
      ...(providerId ? { providerId } : {})
    };
    const routedAuditMode = requestBody.auditMode === undefined
      ? (await resolveAgentRoute(baseUrl)).audit.mode
      : "manual";
    const result = await postJson(
      baseUrl,
      `/api/script-manga-plan-candidates/${encodeURIComponent(candidateId)}/adopt`,
      buildCandidateAdoptionRequest(requestBody, routedAuditMode)
    );
    writeJson(confirmCandidateAdoption(candidateId, result));
    return;
  }
  throw new Error("candidate action must be create, import, preflight, or adopt");
}

async function runAuditCommand(baseUrl, positional, options) {
  if (positional[1] !== "record") throw new Error("audit action must be record");
  const taskId = requiredOption(options, "task-id");
  const body = objectBody(await jsonBodyFromOptions(options), "audit JSON body");
  if (Object.keys(body).length === 0) throw new Error("audit record requires --json or --json-file");
  const normalizedBody = normalizeExternalAuditRequest(body);
  const result = await postJson(
    baseUrl,
    `/api/script-manga-tasks/${encodeURIComponent(taskId)}/audit-results`,
    normalizedBody
  );
  writeJson(confirmExternalAuditRecord(taskId, normalizedBody, result));
}

function fieldValue(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

async function waitLoop({ intervalSeconds, timeoutSeconds, read, match }) {
  const started = Date.now();
  while (true) {
    const value = await read();
    const matched = match(value);
    if (matched !== undefined) return matched;
    if (timeoutSeconds > 0 && Date.now() - started >= timeoutSeconds * 1000) {
      const error = new Error(`wait timed out after ${timeoutSeconds}s`);
      error.exitCode = 2;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalSeconds * 1000));
  }
}

async function runWaitCommand(baseUrl, positional, options) {
  const target = positional[1];
  const intervalSeconds = numberOption(options, "interval", 15, { minimum: 0.1 });
  const timeoutSeconds = numberOption(options, "timeout", 30);
  if (target === "candidates") {
    const projectId = requiredOption(options, "project-id");
    const scriptId = requiredOption(options, "script-id");
    const status = typeof options.status === "string" ? options.status : "adopted";
    const result = await waitLoop({
      intervalSeconds,
      timeoutSeconds,
      read: () => fetchJson(
        baseUrl,
        `/api/projects/${encodeURIComponent(projectId)}/script-manga-plan-candidates?scriptId=${encodeURIComponent(scriptId)}`
      ),
      match: (response) => {
        const found = listFrom(response, "candidates").find((candidate) => candidate?.status === status);
        return found ? summaryCandidate(found) : undefined;
      }
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (target === "run") {
    const runId = requiredOption(options, "run-id");
    const field = typeof options.field === "string" ? options.field : "approvalStatus";
    const expected = requiredOption(options, "equals");
    const result = await waitLoop({
      intervalSeconds,
      timeoutSeconds,
      read: () => fetchJson(baseUrl, `/api/script-manga-runs/${encodeURIComponent(runId)}`),
      match: (run) => String(fieldValue(run, field)) === expected ? summaryRun(run) : undefined
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error("wait target must be candidates or run");
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseCliArgs(argv);
  const command = positional[0];
  if (!command || command === "help" || options.help === true) {
    process.stdout.write(HELP);
    return;
  }
  const baseUrl = normalizeBaseUrl(
    typeof options["base-url"] === "string" ? options["base-url"] : process.env.GURUGURU_BASE_URL
  );
  if (command === "context") {
    process.stdout.write(`${JSON.stringify(await inspectContext(baseUrl, options), null, 2)}\n`);
    return;
  }
  if (command === "api") {
    await runApiCommand(baseUrl, positional, options);
    return;
  }
  if (command === "wait") {
    await runWaitCommand(baseUrl, positional, options);
    return;
  }
  if (command === "route") {
    writeJson(await resolveAgentRoute(baseUrl));
    return;
  }
  if (command === "candidate") {
    await runCandidateCommand(baseUrl, positional, options);
    return;
  }
  if (command === "audit") {
    await runAuditCommand(baseUrl, positional, options);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof AgentApiError ? { status: error.status, response: error.payload } : {})
    })}\n`);
    process.exitCode = error?.exitCode ?? 1;
  }
}
