import type { ProjectSummary } from "../shared/apiTypes";
import { buildScriptMangaDeepLink } from "../shared/scriptMangaDeepLink";
import { registerActions, registerEventBinder } from "./actionRegistry";
import { api } from "./api";
import { requestRender, state } from "./appState";

const HOME_REFRESH_MS = 5_000;
const HIDDEN_REFRESH_MS = 20_000;
let refreshBusy = false;
let lastHiddenRefreshAt = 0;
let lastProjectSignature = "";

function projectsSignature(projects: readonly ProjectSummary[]): string {
  return JSON.stringify(projects);
}

async function refreshHomeProjects(): Promise<void> {
  if (refreshBusy || state.currentProjectId !== null) return;
  if (document.hidden && Date.now() - lastHiddenRefreshAt < HIDDEN_REFRESH_MS) return;
  refreshBusy = true;
  try {
    const projects = (await api<{ projects: ProjectSummary[] }>("/api/projects")).projects;
    if (state.currentProjectId !== null) return;
    const signature = projectsSignature(projects);
    if (signature !== lastProjectSignature) {
      state.projects = projects;
      lastProjectSignature = signature;
      requestRender();
    }
    if (document.hidden) lastHiddenRefreshAt = Date.now();
  } catch {
    // 一覧pollは補助情報。通常操作のAPIエラー表示を上書きしない。
  } finally {
    refreshBusy = false;
  }
}

function openScriptMangaProgress(_id: string, target: HTMLElement): void {
  const projectId = target.dataset.projectId;
  const scriptId = target.dataset.scriptId;
  const revisionId = target.dataset.revisionId;
  if (!projectId || !scriptId || !revisionId) return;
  window.location.assign(buildScriptMangaDeepLink(window.location.href, {
    projectId,
    scriptId,
    revisionId,
    ...(target.dataset.candidateId ? { candidateId: target.dataset.candidateId } : {}),
    ...(target.dataset.runId ? { runId: target.dataset.runId } : {}),
    ...(target.dataset.planId ? { planId: target.dataset.planId } : {})
  }));
}

function bindHomeProgressEvents(): void {
  lastProjectSignature = projectsSignature(state.projects);
  window.setInterval(() => void refreshHomeProjects(), HOME_REFRESH_MS);
}

registerActions({ "open-script-manga-progress": openScriptMangaProgress });
registerEventBinder(bindHomeProgressEvents);
