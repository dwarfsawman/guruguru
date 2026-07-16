/**
 * ネームスタジオ(V5 D5)の操作: テイク選択・ページ送り・コマ選択・レイアウトフリップ。
 * フリップの top-k 計算は共有純関数(nameStudioView 内)で即時、永続化だけ set-layout API。
 */
import type { SetCandidateLayoutResponse } from "../shared/scriptMangaApi";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { refreshScriptMangaCandidates } from "./scriptMangaController";
import { activeStudioTake, effectiveCandidatePlan } from "./views/nameStudioView";

let flipBusy = false;

function selectTake(candidateId: string): void {
  if (!candidateId) return;
  const candidate = state.scriptMangaCandidates.find((entry) => entry.id === candidateId);
  if (!candidate) return;
  const pageCount = effectiveCandidatePlan(candidate).pages.length;
  state.nameStudio = {
    takeId: candidateId,
    // 同ページ番号を保って読み比べる(ページ数差はクランプ)。
    pageIndex: Math.max(0, Math.min(pageCount - 1, state.nameStudio.pageIndex)),
    selectedPanelId: null
  };
  requestRender();
}

function movePage(delta: number): void {
  const take = activeStudioTake(state.scriptMangaCandidates, state.nameStudio);
  if (!take) return;
  const pageCount = effectiveCandidatePlan(take).pages.length;
  const next = Math.max(0, Math.min(pageCount - 1, state.nameStudio.pageIndex + delta));
  if (next === state.nameStudio.pageIndex) return;
  state.nameStudio = { ...state.nameStudio, takeId: take.id, pageIndex: next, selectedPanelId: null };
  requestRender();
}

function selectPanel(panelId: string): void {
  state.nameStudio = {
    ...state.nameStudio,
    selectedPanelId: state.nameStudio.selectedPanelId === panelId ? null : panelId
  };
  requestRender();
}

async function flipLayout(candidateId: string, target: HTMLElement): Promise<void> {
  const layoutTemplateId = target.dataset.layoutId;
  const pageIndex = Number(target.dataset.pageIndex);
  const candidate = state.scriptMangaCandidates.find((entry) => entry.id === candidateId);
  if (!candidate || !layoutTemplateId || !Number.isInteger(pageIndex) || flipBusy) return;
  if (candidate.status !== "active") {
    pushToast("採用済み・採用中の候補はフリップできません。", "error");
    return;
  }
  flipBusy = true;
  try {
    const response = await api<SetCandidateLayoutResponse>(
      `/api/script-manga-plan-candidates/${encodeURIComponent(candidateId)}/set-layout`,
      {
        method: "POST",
        body: JSON.stringify({ pageIndex, layoutTemplateId, expectedVersion: candidate.editVersion })
      }
    );
    state.scriptMangaCandidates = state.scriptMangaCandidates.map((entry) =>
      entry.id === candidateId ? response.candidate : entry
    );
    requestRender();
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
    // 409(並行更新・採用中)は最新状態を取り直して表示を合わせる。
    void refreshScriptMangaCandidates();
  } finally {
    flipBusy = false;
  }
}

registerActions({
  "studio-select-take": (candidateId) => selectTake(candidateId),
  "studio-prev-page": () => movePage(-1),
  "studio-next-page": () => movePage(1),
  "studio-select-panel": (panelId) => selectPanel(panelId),
  "studio-flip-layout": (candidateId, target) => void flipLayout(candidateId, target)
});
