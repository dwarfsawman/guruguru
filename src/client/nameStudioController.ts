/**
 * ネームスタジオ(V5 D5)の操作: テイク選択・ページ送り・コマ選択・レイアウトフリップ。
 * フリップの top-k 計算は共有純関数(nameStudioView 内)で即時、永続化だけ set-layout API。
 */
import type { NamePlanEdit, ScriptMangaPlanView, SetCandidateLayoutResponse } from "../shared/scriptMangaApi";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";
import {
  canonicalReaderIndex,
  firstReaderIndex,
  goNextReaderIndex,
  goPrevReaderIndex,
  lastReaderIndex,
  type BookReaderLayout
} from "./bookReader";
import { isTextEntryTarget } from "./clientUtils";
import { mapNameStudioPage, type ComparableNameStudioPlan } from "./nameStudioPageMapping";
import { nameStudioReaderSettings, type NameStudioFitMode } from "./nameStudioReader";
import { refreshScriptMangaCandidates } from "./scriptMangaController";
import { activeStudioTake, DIRECTED_TAKE_ID, directedPlanEditable, effectiveCandidatePlan } from "./views/nameStudioView";

let flipBusy = false;
let saveBusy = false;

function currentPageCount(takeId: string | null): number {
  if (takeId === DIRECTED_TAKE_ID) return state.scriptMangaRun?.plan?.pages.length ?? 0;
  const take = activeStudioTake(state.scriptMangaCandidates, state.nameStudio);
  return take ? effectiveCandidatePlan(take).pages.length : 0;
}

function currentPlan(): ComparableNameStudioPlan | null {
  if (state.nameStudio.takeId === DIRECTED_TAKE_ID) return state.scriptMangaRun?.plan ?? null;
  const take = activeStudioTake(state.scriptMangaCandidates, state.nameStudio);
  return take ? effectiveCandidatePlan(take) : null;
}

function canonicalStudioPageIndex(pageIndex: number, pageCount: number): number {
  return canonicalReaderIndex(pageIndex, pageCount, nameStudioReaderSettings(state.nameStudio));
}

function selectTake(candidateId: string): void {
  if (!candidateId) return;
  const fromPlan = currentPlan();
  if (candidateId === DIRECTED_TAKE_ID) {
    if (!state.scriptMangaRun?.plan) return;
    const mapping = mapNameStudioPage(fromPlan, state.scriptMangaRun.plan, state.nameStudio.pageIndex);
    state.nameStudio = {
      ...state.nameStudio,
      takeId: DIRECTED_TAKE_ID,
      pageIndex: canonicalStudioPageIndex(mapping.pageIndex, state.scriptMangaRun.plan.pages.length),
      selectedPanelId: null
    };
    state.nameStudioDraft = null;
    requestRender();
    return;
  }
  const candidate = state.scriptMangaCandidates.find((entry) => entry.id === candidateId);
  if (!candidate) return;
  const targetPlan = effectiveCandidatePlan(candidate);
  const mapping = mapNameStudioPage(fromPlan, targetPlan, state.nameStudio.pageIndex);
  state.nameStudio = {
    ...state.nameStudio,
    takeId: candidateId,
    // 同じ数値の頁ではなく、beat/source elementが一致する場面を優先して読み比べる。
    pageIndex: canonicalStudioPageIndex(mapping.pageIndex, targetPlan.pages.length),
    selectedPanelId: null
  };
  state.nameStudioDraft = null;
  requestRender();
}

function movePage(direction: "next" | "previous"): void {
  const takeId = state.nameStudio.takeId === DIRECTED_TAKE_ID
    ? DIRECTED_TAKE_ID
    : activeStudioTake(state.scriptMangaCandidates, state.nameStudio)?.id ?? null;
  if (!takeId) return;
  const pageCount = currentPageCount(takeId);
  const settings = nameStudioReaderSettings(state.nameStudio);
  const next = direction === "next"
    ? goNextReaderIndex(state.nameStudio.pageIndex, pageCount, settings)
    : goPrevReaderIndex(state.nameStudio.pageIndex, pageCount, settings);
  if (next === state.nameStudio.pageIndex) return;
  state.nameStudio = { ...state.nameStudio, takeId, pageIndex: next, selectedPanelId: null };
  state.nameStudioDraft = null;
  requestRender();
}

function jumpPage(edge: "first" | "last"): void {
  const takeId = state.nameStudio.takeId === DIRECTED_TAKE_ID
    ? DIRECTED_TAKE_ID
    : activeStudioTake(state.scriptMangaCandidates, state.nameStudio)?.id ?? null;
  if (!takeId) return;
  const pageCount = currentPageCount(takeId);
  const settings = nameStudioReaderSettings(state.nameStudio);
  const next = edge === "first"
    ? firstReaderIndex(pageCount, settings)
    : lastReaderIndex(pageCount, settings);
  if (next === state.nameStudio.pageIndex) return;
  state.nameStudio = { ...state.nameStudio, takeId, pageIndex: next, selectedPanelId: null };
  state.nameStudioDraft = null;
  requestRender();
}

function setReaderLayout(layout: BookReaderLayout): void {
  if (layout !== "single" && layout !== "spread") return;
  const takeId = state.nameStudio.takeId === DIRECTED_TAKE_ID
    ? DIRECTED_TAKE_ID
    : activeStudioTake(state.scriptMangaCandidates, state.nameStudio)?.id ?? null;
  const pageCount = takeId ? currentPageCount(takeId) : 0;
  const nextState = { ...state.nameStudio, layout, selectedPanelId: null };
  state.nameStudio = {
    ...nextState,
    pageIndex: canonicalReaderIndex(
      nextState.pageIndex,
      pageCount,
      nameStudioReaderSettings(nextState)
    )
  };
  state.nameStudioDraft = null;
  requestRender();
}

function setFitMode(fitMode: NameStudioFitMode): void {
  if (fitMode !== "fit-height" && fitMode !== "fit-width") return;
  state.nameStudio = { ...state.nameStudio, fitMode };
  requestRender();
}

function selectPanel(panelId: string): void {
  state.nameStudio = {
    ...state.nameStudio,
    selectedPanelId: state.nameStudio.selectedPanelId === panelId ? null : panelId
  };
  state.nameStudioDraft = null;
  requestRender();
}

function closePanelDialog(): void {
  if (!state.nameStudio.selectedPanelId) return;
  state.nameStudio = { ...state.nameStudio, selectedPanelId: null };
  state.nameStudioDraft = null;
  requestRender();
}

function toggleFullscreen(): void {
  state.nameStudio = { ...state.nameStudio, fullscreen: !state.nameStudio.fullscreen };
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

// --- 演出ネームの編集(V5 D6): フォーム値は常にドラフトからレンダーする ---

function beginPanelEdit(panelId: string): void {
  const run = state.scriptMangaRun;
  const plan = run?.plan;
  if (!run || !plan || !directedPlanEditable(run)) return;
  const page = plan.pages.find((candidatePage) => candidatePage.panels.some((panel) => panel.id === panelId));
  const panel = page?.panels.find((candidatePanel) => candidatePanel.id === panelId);
  if (!page || !panel) return;
  const entityNames = new Map(plan.narrativeGraph.entities.map((entity) => [entity.id, entity.name]));
  state.nameStudioDraft = {
    panelId,
    pageIndex: page.index,
    shotSize: panel.shot.size,
    shotAngle: panel.shot.angle,
    compositionIntent: panel.shot.compositionIntent,
    promptBase: panel.promptBase,
    pageIntent: page.pageIntent ?? "",
    cast: panel.cast.map((member) => ({
      characterId: member.characterId,
      name: entityNames.get(member.characterId) ?? member.characterId,
      expression: member.expression,
      action: member.action
    }))
  };
  requestRender();
}

function cancelPanelEdit(): void {
  state.nameStudioDraft = null;
  requestRender();
}

/** ドラフトと保存済みプランの差分だけをホワイトリスト編集として組み立てる(純関数)。 */
export function buildNamePlanEdits(
  draft: NonNullable<typeof state.nameStudioDraft>,
  plan: NonNullable<NonNullable<typeof state.scriptMangaRun>["plan"]>
): NamePlanEdit[] {
  const page = plan.pages.find((candidatePage) => candidatePage.index === draft.pageIndex);
  const panel = page?.panels.find((candidatePanel) => candidatePanel.id === draft.panelId);
  if (!page || !panel) return [];
  const edits: NamePlanEdit[] = [];
  const panelEdit: Extract<NamePlanEdit, { kind: "panel" }> = { kind: "panel", panelId: draft.panelId };
  if (draft.shotSize !== panel.shot.size) panelEdit.shotSize = draft.shotSize as NonNullable<Extract<NamePlanEdit, { kind: "panel" }>["shotSize"]>;
  if (draft.shotAngle !== panel.shot.angle) panelEdit.shotAngle = draft.shotAngle;
  if (draft.compositionIntent !== panel.shot.compositionIntent) panelEdit.compositionIntent = draft.compositionIntent;
  if (draft.promptBase !== panel.promptBase) panelEdit.promptBase = draft.promptBase;
  if (Object.keys(panelEdit).length > 2) edits.push(panelEdit);
  for (const member of draft.cast) {
    const original = panel.cast.find((candidateMember) => candidateMember.characterId === member.characterId);
    if (!original) continue;
    const castEdit: Extract<NamePlanEdit, { kind: "cast" }> = { kind: "cast", panelId: draft.panelId, characterId: member.characterId };
    if (member.expression !== original.expression) castEdit.expression = member.expression;
    if (member.action !== original.action) castEdit.action = member.action;
    if (Object.keys(castEdit).length > 3) edits.push(castEdit);
  }
  if (draft.pageIntent.trim() && draft.pageIntent !== (page.pageIntent ?? "")) {
    edits.push({ kind: "page", pageIndex: draft.pageIndex, pageIntent: draft.pageIntent });
  }
  return edits;
}

async function saveEdits(): Promise<void> {
  const run = state.scriptMangaRun;
  const draft = state.nameStudioDraft;
  if (!run?.plan || !run.planId || run.planEditVersion === null || !draft || saveBusy) return;
  const edits = buildNamePlanEdits(draft, run.plan);
  if (edits.length === 0) {
    state.nameStudioDraft = null;
    requestRender();
    return;
  }
  saveBusy = true;
  try {
    await api<ScriptMangaPlanView>(`/api/script-manga-plans/${encodeURIComponent(run.planId)}/edits`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: run.planEditVersion, edits })
    });
    // 再materializeは同期。runの状態(preparing→prepared/再承認待ち)はGETで取り直す。
    const refreshed = await api<typeof run>(`/api/script-manga-runs/${encodeURIComponent(run.id)}`);
    if (state.scriptMangaRun?.id === run.id) state.scriptMangaRun = refreshed;
    state.nameStudioDraft = null;
    pushToast("演出を差分適用しました。runは再承認待ちへ戻ります。", "info");
    requestRender();
  } catch (error) {
    // 409(並行更新)は最新を取り直しつつドラフトは保持(人間が突き合わせて再保存できる)。
    pushToast(error instanceof Error ? error.message : String(error), "error");
    try {
      const refreshed = await api<typeof run>(`/api/script-manga-runs/${encodeURIComponent(run.id)}`);
      if (state.scriptMangaRun?.id === run.id) state.scriptMangaRun = refreshed;
      requestRender();
    } catch {
      // 取り直し失敗は次のポーリングに任せる。
    }
  } finally {
    saveBusy = false;
  }
}

function bindNameStudioEvents(app: HTMLElement): void {
  const applyEdit = (target: EventTarget | null): void => {
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement) && !(target instanceof HTMLTextAreaElement)) return;
    const field = target.dataset.studioEdit;
    const draft = state.nameStudioDraft;
    if (!field || !draft) return;
    if (field === "cast-expression" || field === "cast-action") {
      const characterId = target.dataset.characterId;
      const member = draft.cast.find((candidateMember) => candidateMember.characterId === characterId);
      if (!member) return;
      if (field === "cast-expression") member.expression = target.value;
      else member.action = target.value;
      return;
    }
    if (field === "shotSize") draft.shotSize = target.value;
    else if (field === "shotAngle") draft.shotAngle = target.value;
    else if (field === "compositionIntent") draft.compositionIntent = target.value;
    else if (field === "promptBase") draft.promptBase = target.value;
    else if (field === "pageIntent") draft.pageIntent = target.value;
  };
  // ドラフトへの書き込みだけなので再レンダー不要(値はドラフトからレンダーされる)。
  app.addEventListener("input", (event) => applyEdit(event.target));
  app.addEventListener("change", (event) => applyEdit(event.target));
  app.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.classList.contains("studio-panel-dialog-backdrop")) {
      closePanelDialog();
    }
  });
}

/**
 * Name Studioの閲覧キー。全画面ではbody focusでも動作し、通常表示ではStudio内に
 * focusがある場合だけ処理する。他の編集UIやコマ詳細ダイアログからキーを奪わない。
 */
export function handleNameStudioKeydown(event: KeyboardEvent): boolean {
  const card = document.querySelector<HTMLElement>("[data-key=\"name-studio\"]");
  if (!card) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (!state.nameStudio.fullscreen && !target?.closest("[data-key=\"name-studio\"]")) return false;

  if (event.key === "Escape") {
    if (state.nameStudio.selectedPanelId) {
      closePanelDialog();
      return true;
    }
    if (state.nameStudio.fullscreen) {
      event.preventDefault();
      toggleFullscreen();
      return true;
    }
    return false;
  }
  if (state.nameStudio.selectedPanelId || isTextEntryTarget(event.target)) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;

  if (event.key === "ArrowRight") {
    event.preventDefault();
    movePage("next");
    return true;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    movePage("previous");
    return true;
  }
  if (event.key === "Home") {
    event.preventDefault();
    jumpPage("first");
    return true;
  }
  if (event.key === "End") {
    event.preventDefault();
    jumpPage("last");
    return true;
  }
  return false;
}

registerActions({
  "studio-select-take": (candidateId) => selectTake(candidateId),
  "studio-prev-page": () => movePage("previous"),
  "studio-next-page": () => movePage("next"),
  "studio-first-page": () => jumpPage("first"),
  "studio-last-page": () => jumpPage("last"),
  "studio-set-layout": (id) => setReaderLayout(id as BookReaderLayout),
  "studio-set-fit": (id) => setFitMode(id as NameStudioFitMode),
  "studio-toggle-fullscreen": () => toggleFullscreen(),
  "studio-select-panel": (panelId) => selectPanel(panelId),
  "studio-close-panel": () => closePanelDialog(),
  "studio-flip-layout": (candidateId, target) => void flipLayout(candidateId, target),
  "studio-edit-panel": (panelId) => beginPanelEdit(panelId),
  "studio-save-edits": () => void saveEdits(),
  "studio-cancel-edits": () => cancelPanelEdit()
});

registerEventBinder(bindNameStudioEvents);
