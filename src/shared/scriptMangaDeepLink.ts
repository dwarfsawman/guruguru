export interface ScriptMangaDeepLink {
  projectId: string;
  scriptId: string;
  revisionId?: string;
  runId?: string;
  planId?: string;
  candidateId?: string;
  taskId?: string;
}

const VIEW_NAME = "script";

function optionalParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value || undefined;
}

/**
 * Parse the canonical Script/Name Studio URL. A project and script are mandatory so a
 * shared link can never silently fall back to whichever item the browser selected last.
 */
export function parseScriptMangaDeepLink(value: string | URL): ScriptMangaDeepLink | null {
  const url = value instanceof URL ? value : new URL(value);
  if (url.searchParams.get("view") !== VIEW_NAME) return null;
  const projectId = optionalParam(url.searchParams, "projectId");
  const scriptId = optionalParam(url.searchParams, "scriptId");
  if (!projectId || !scriptId) return null;
  const revisionId = optionalParam(url.searchParams, "revisionId");
  const runId = optionalParam(url.searchParams, "runId");
  const planId = optionalParam(url.searchParams, "planId");
  const candidateId = optionalParam(url.searchParams, "candidateId");
  const taskId = optionalParam(url.searchParams, "taskId");
  return {
    projectId,
    scriptId,
    ...(revisionId ? { revisionId } : {}),
    ...(runId ? { runId } : {}),
    ...(planId ? { planId } : {}),
    ...(candidateId ? { candidateId } : {}),
    ...(taskId ? { taskId } : {})
  };
}

/** Build the URL printed by the agent CLI and consumed by the browser. */
export function buildScriptMangaDeepLink(baseUrl: string | URL, context: ScriptMangaDeepLink): string {
  const url = baseUrl instanceof URL ? new URL(baseUrl.toString()) : new URL(baseUrl);
  url.pathname = "/";
  url.hash = "";
  url.search = "";
  url.searchParams.set("view", VIEW_NAME);
  url.searchParams.set("projectId", context.projectId);
  url.searchParams.set("scriptId", context.scriptId);
  if (context.revisionId) url.searchParams.set("revisionId", context.revisionId);
  if (context.runId) url.searchParams.set("runId", context.runId);
  if (context.planId) url.searchParams.set("planId", context.planId);
  if (context.candidateId) url.searchParams.set("candidateId", context.candidateId);
  if (context.taskId) url.searchParams.set("taskId", context.taskId);
  return url.toString();
}
