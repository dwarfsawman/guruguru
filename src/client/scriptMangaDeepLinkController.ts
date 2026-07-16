import type {
  ScriptMangaPlanCandidatesResponse,
  ScriptMangaRunView
} from "../shared/scriptMangaApi";
import { parseScriptMangaDeepLink } from "../shared/scriptMangaDeepLink";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { openBook } from "./bookController";
import { openScriptScreen, selectScript } from "./scriptController";
import { DIRECTED_TAKE_ID } from "./views/nameStudioView";

/**
 * Apply the exact context emitted by `bun run agent:cli context`. The API remains the
 * authority: every optional identity is fetched and checked before it is shown.
 */
export async function applyInitialScriptMangaDeepLink(href = window.location.href): Promise<boolean> {
  const link = parseScriptMangaDeepLink(href);
  if (!link) return false;
  try {
    const project = state.projects.find((entry) => entry.id === link.projectId);
    if (!project) throw new Error(`共有URLのprojectが見つかりません: ${link.projectId}`);
    if (project.mode !== "book") throw new Error("Script画面はBook projectでのみ開けます。");

    await openBook(link.projectId);
    await openScriptScreen();
    if (!state.scripts.some((script) => script.id === link.scriptId)) {
      throw new Error(`共有URLのscriptがprojectに属していません: ${link.scriptId}`);
    }
    if (state.activeScriptId !== link.scriptId) await selectScript(link.scriptId);
    if (link.revisionId && state.activeScriptRevision?.id !== link.revisionId) {
      throw new Error(`共有URLの固定revisionは現在のscript revisionと一致しません: ${link.revisionId}`);
    }

    const candidateResponse = await api<ScriptMangaPlanCandidatesResponse>(
      `/api/projects/${encodeURIComponent(link.projectId)}/script-manga-plan-candidates?scriptId=${encodeURIComponent(link.scriptId)}`
    );
    state.scriptMangaCandidates = candidateResponse.candidates;
    state.scriptMangaCandidateBeatKinds = candidateResponse.beatKinds;
    state.scriptMangaCandidateDialogueChars = candidateResponse.dialogueCharsByOrderIndex;

    const candidate = link.candidateId
      ? candidateResponse.candidates.find((entry) => entry.id === link.candidateId)
      : null;
    if (link.candidateId && !candidate) {
      throw new Error(`共有URLのcandidateは現在の固定revisionに存在しません: ${link.candidateId}`);
    }

    let run: ScriptMangaRunView | null = null;
    if (link.runId) {
      run = await api<ScriptMangaRunView>(`/api/script-manga-runs/${encodeURIComponent(link.runId)}`);
      if (run.projectId !== link.projectId || run.scriptId !== link.scriptId) {
        throw new Error("共有URLのrunとproject/scriptの対応が一致しません。");
      }
      if (link.revisionId && run.scriptRevisionId !== link.revisionId) {
        throw new Error("共有URLのrunと固定revisionの対応が一致しません。");
      }
      if (link.planId && run.planId !== link.planId) {
        throw new Error("共有URLのrunとplanの対応が一致しません。");
      }
      if (link.taskId && !run.tasks.some((task) => task.id === link.taskId)) {
        throw new Error(`共有URLのtaskがrunに属していません: ${link.taskId}`);
      }
      if (candidate && candidate.adoptedRunId !== run.id) {
        throw new Error("共有URLのcandidateとrunは同じ採用コンテキストではありません。");
      }
      state.scriptMangaRun = run;
    } else if (link.taskId || link.planId) {
      throw new Error("taskId/planIdを指定する共有URLにはrunIdも必要です。");
    }

    state.nameStudio = {
      takeId: candidate?.id ?? (run?.plan ? DIRECTED_TAKE_ID : null),
      pageIndex: 0,
      selectedPanelId: null
    };
    state.nameStudioDraft = null;
    requestRender();
    return true;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
    requestRender();
    return true;
  }
}
