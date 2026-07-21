/**
 * 人間ゲートのコマ割り修正(ネームスタジオ)。
 *
 * ドラフトは state.nameLayoutEdit に持ち、幾何操作は共有純ロジック(shared/nameLayoutEdit.ts)を
 * ドラッグ開始時のスナップショットへ適用する(累積誤差を避ける)。保存は
 * POST /api/script-manga-plan-candidates/:id/set-custom-layout(expectedVersion 楽観ロック)。
 * ポインタ委譲は panelShapeController と同型で main.ts から呼ばれる。
 */
import {
  detectJunctions,
  detectSharedBoundaries,
  edgeInMarginBand,
  edgeOutwardNormal,
  moveBoundaryAlongNormal,
  moveJunction,
  movePanelVertices,
  outerEdgeInfo,
  setBoundaryGutter,
  snapEdgeToBleed,
  toEditableNameLayout,
  translateEdgeAlongNormal,
  validateEditedNameLayout,
  type LayoutJunction,
  type PageSide,
  type SharedBoundary
} from "../shared/nameLayoutEdit";
import { insertPolygonVertex, removePolygonVertex } from "../shared/panelShapeEdit";
import { resolveScriptMangaLayout } from "../shared/layoutPresets";
import { clonePageLayout, type PageLayout } from "../shared/pageLayout";
import type { SetCandidateCustomLayoutResponse } from "../shared/scriptMangaApi";
import { api } from "./api";
import { pushToast, requestRender, state, type NameLayoutEditState } from "./appState";
import { registerActions } from "./actionRegistry";
import { createDragSession } from "./dragSession";
import { getInverseStageTransform, getStageTransform } from "./svgGizmo";
import { refreshScriptMangaCandidates } from "./scriptMangaController";
import { isTextEntryTarget } from "./clientUtils";
import { clearSnapshotHistory, createSnapshotHistory, pushSnapshot, redoSnapshot, undoSnapshot } from "./snapshotHistory";

// --- undo/redo(レイアウト+吹き出しヒントのスナップショット) ---

interface NameLayoutEditSnapshot {
  layout: PageLayout;
  hints: Record<number, { x: number; y: number }>;
}

const editHistory = createSnapshotHistory<NameLayoutEditSnapshot>();

function currentEditSnapshot(edit: NameLayoutEditState): NameLayoutEditSnapshot {
  return { layout: clonePageLayout(edit.draftLayout), hints: { ...edit.draftHints } };
}

function syncHistoryFlags(edit: NameLayoutEditState): void {
  edit.canUndo = editHistory.undoStack.length > 0;
  edit.canRedo = editHistory.redoStack.length > 0;
}

/** 確定操作の直前状態を履歴へ積む(snapshot は呼び出し側で deep copy 済みであること)。 */
function pushEditHistory(edit: NameLayoutEditState, snapshot: NameLayoutEditSnapshot): void {
  pushSnapshot(editHistory, snapshot);
  syncHistoryFlags(edit);
}

function applyEditSnapshot(edit: NameLayoutEditState, snapshot: NameLayoutEditSnapshot): void {
  edit.draftLayout = snapshot.layout;
  edit.draftHints = snapshot.hints;
  edit.preview = null;
  validateDraft(edit);
  syncHistoryFlags(edit);
  requestRender();
}

function undoLayoutEdit(): void {
  const edit = state.nameLayoutEdit;
  if (!edit) return;
  const restored = undoSnapshot(editHistory, currentEditSnapshot(edit));
  if (restored) applyEditSnapshot(edit, restored);
}

function redoLayoutEdit(): void {
  const edit = state.nameLayoutEdit;
  if (!edit) return;
  const restored = redoSnapshot(editHistory, currentEditSnapshot(edit));
  if (restored) applyEditSnapshot(edit, restored);
}

function stageRootElement(): SVGGraphicsElement | null {
  const el = document.getElementById("nameLayoutEditRoot");
  return el instanceof SVGGraphicsElement ? el : null;
}

function activeEditCandidate() {
  const edit = state.nameLayoutEdit;
  if (!edit) return null;
  return state.scriptMangaCandidates.find((candidate) => candidate.id === edit.candidateId) ?? null;
}

function validateDraft(edit: NameLayoutEditState): void {
  edit.issues = validateEditedNameLayout(edit.draftLayout, edit.baseLayout).issues.map((issue) => issue.message);
}

// --- セッション開始/終了 ---

function beginLayoutEdit(candidateId: string, target: HTMLElement): void {
  const pageIndex = Number(target.dataset.pageIndex);
  const candidate = state.scriptMangaCandidates.find((entry) => entry.id === candidateId);
  if (!candidate || !Number.isInteger(pageIndex)) return;
  if (candidate.status !== "active") {
    pushToast("採用済み・採用中の候補のコマ割りは修正できません。", "error");
    return;
  }
  const page = candidate.plan.pages.find((entry) => entry.index === pageIndex);
  if (!page) return;
  const baseTemplateId = candidate.layoutOverrides[pageIndex] ?? page.layoutTemplateId;
  const template = resolveScriptMangaLayout(baseTemplateId);
  if (!template) {
    pushToast(`レイアウト ${baseTemplateId} を解決できません。`, "error");
    return;
  }
  const baseLayout = toEditableNameLayout(template);
  const savedCustom = candidate.customLayouts?.[pageIndex];
  clearSnapshotHistory(editHistory);
  state.nameLayoutEdit = {
    candidateId,
    pageIndex,
    baseVersion: candidate.editVersion,
    baseLayout,
    draftLayout: savedCustom ? toEditableNameLayout(savedCustom) : clonePageLayout(baseLayout),
    draftHints: { ...(candidate.balloonHints?.[pageIndex] ?? {}) },
    preview: null,
    issues: [],
    saveBusy: false,
    canUndo: false,
    canRedo: false
  };
  requestRender();
}

/**
 * コマ割り修正セッションを破棄する(ドラッグセッション・undo履歴も含めて終了する)。
 * 脚本画面クローズ/脚本切替のクリア(scriptMangaController.ts)からも呼ぶ。
 */
export function resetNameLayoutEditSession(): void {
  layoutEditSession.reset();
  clearSnapshotHistory(editHistory);
  state.nameLayoutEdit = null;
}

function cancelLayoutEdit(): void {
  if (!state.nameLayoutEdit) return;
  resetNameLayoutEditSession();
  requestRender();
}

/** 未保存のローカル編集を破棄して、保存済み(または基準テンプレ)の状態へ戻す。undo で取り消せる。 */
function revertLayoutEdit(): void {
  const edit = state.nameLayoutEdit;
  const candidate = activeEditCandidate();
  if (!edit || !candidate) return;
  pushEditHistory(edit, currentEditSnapshot(edit));
  const savedCustom = candidate.customLayouts?.[edit.pageIndex];
  edit.draftLayout = savedCustom ? toEditableNameLayout(savedCustom) : clonePageLayout(edit.baseLayout);
  edit.draftHints = { ...(candidate.balloonHints?.[edit.pageIndex] ?? {}) };
  edit.preview = null;
  edit.issues = [];
  requestRender();
}

async function saveLayoutEdit(): Promise<void> {
  const edit = state.nameLayoutEdit;
  const candidate = activeEditCandidate();
  if (!edit || !candidate || edit.saveBusy) return;
  validateDraft(edit);
  if (edit.issues.length > 0) {
    requestRender();
    return;
  }
  edit.saveBusy = true;
  requestRender();
  try {
    const response = await api<SetCandidateCustomLayoutResponse>(
      `/api/script-manga-plan-candidates/${encodeURIComponent(candidate.id)}/set-custom-layout`,
      {
        method: "POST",
        body: JSON.stringify({
          pageIndex: edit.pageIndex,
          // セッション開始時に固定した baseVersion を送る(ポーリングで更新される candidate.editVersion を
          // 送ると、編集中の並行更新が 409 にならずサイレント上書きになる)。namePoseEditController と同型。
          expectedVersion: edit.baseVersion,
          layout: edit.draftLayout,
          balloonHints: Object.keys(edit.draftHints).length > 0 ? edit.draftHints : null
        })
      }
    );
    state.scriptMangaCandidates = state.scriptMangaCandidates.map((entry) =>
      entry.id === candidate.id ? response.candidate : entry
    );
    // await 中に cancel→新セッション開始が起きていたら、新しいセッションを破壊しない。
    if (state.nameLayoutEdit === edit) state.nameLayoutEdit = null;
    pushToast("コマ割りの修正を保存しました。「このネームで生成」で検査と採用へ進めます。", "info");
    requestRender();
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
    // 409(並行更新・採用中)は候補一覧を取り直す。ドラフトは保持し、人間が再保存できる。
    if (state.nameLayoutEdit === edit) edit.saveBusy = false;
    await refreshScriptMangaCandidates();
    // 再保存を可能にするため、409を人間へ提示した上で baseVersion を最新へ進める
    // (進めないと以後の保存が恒久409になる)。
    if (state.nameLayoutEdit === edit) {
      const refreshed = state.scriptMangaCandidates.find((entry) => entry.id === candidate.id);
      if (refreshed) edit.baseVersion = refreshed.editVersion;
    }
    requestRender();
  }
}

/** サーバー保存済みの修正・ヒントを破棄してテンプレレイアウトへ戻す。 */
async function resetLayoutEdit(): Promise<void> {
  const edit = state.nameLayoutEdit;
  const candidate = activeEditCandidate();
  if (!edit || !candidate || edit.saveBusy) return;
  edit.saveBusy = true;
  requestRender();
  try {
    const response = await api<SetCandidateCustomLayoutResponse>(
      `/api/script-manga-plan-candidates/${encodeURIComponent(candidate.id)}/set-custom-layout`,
      {
        method: "POST",
        body: JSON.stringify({
          pageIndex: edit.pageIndex,
          expectedVersion: edit.baseVersion,
          layout: null,
          balloonHints: null
        })
      }
    );
    state.scriptMangaCandidates = state.scriptMangaCandidates.map((entry) =>
      entry.id === candidate.id ? response.candidate : entry
    );
    pushEditHistory(edit, currentEditSnapshot(edit));
    edit.draftLayout = clonePageLayout(edit.baseLayout);
    edit.draftHints = {};
    edit.preview = null;
    edit.issues = [];
    edit.baseVersion = response.version;
    pushToast("テンプレのコマ割りへ戻しました。", "info");
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
    await refreshScriptMangaCandidates();
  } finally {
    if (state.nameLayoutEdit === edit) edit.saveBusy = false;
    requestRender();
  }
}

// --- ポインタ操作 ---

interface DragBase {
  startClientX: number;
  startClientY: number;
  pxPerUnit: number;
  startLayout: PageLayout;
  startHints: Record<number, { x: number; y: number }>;
}

type DragData =
  | (DragBase & { kind: "vertex"; panelIndex: number; vertexIndex: number })
  | (DragBase & { kind: "edge"; panelIndex: number; edgeIndex: number; outward: [number, number]; outerSide: PageSide | null })
  | (DragBase & { kind: "boundary"; boundary: SharedBoundary })
  | (DragBase & { kind: "gutter"; boundary: SharedBoundary })
  | (DragBase & { kind: "junction"; junction: LayoutJunction })
  | (DragBase & { kind: "balloon"; orderIndex: number });

// pointerId 照合・setPointerCapture/release・up/cancel でのクリアは createDragSession(dragSession.ts)へ委譲。
const layoutEditSession = createDragSession<DragData>({
  onMove: (event, drag) => {
    const edit = state.nameLayoutEdit;
    if (!edit) return false;
    const dx = (event.clientX - drag.startClientX) / drag.pxPerUnit;
    const dy = (event.clientY - drag.startClientY) / drag.pxPerUnit;
    if (drag.kind === "vertex") {
      edit.draftLayout = movePanelVertices(
        drag.startLayout,
        [{ panelIndex: drag.panelIndex, vertexIndex: drag.vertexIndex }],
        [dx, dy]
      );
    } else if (drag.kind === "junction") {
      edit.draftLayout = moveJunction(drag.startLayout, drag.junction, [dx, dy]);
    } else if (drag.kind === "boundary") {
      const offset = dx * drag.boundary.normal[0] + dy * drag.boundary.normal[1];
      edit.draftLayout = moveBoundaryAlongNormal(drag.startLayout, drag.boundary, offset);
    } else if (drag.kind === "gutter") {
      const along = dx * drag.boundary.normal[0] + dy * drag.boundary.normal[1];
      edit.draftLayout = setBoundaryGutter(drag.startLayout, drag.boundary, Math.max(0, drag.boundary.gutterWidth + along * 2));
    } else if (drag.kind === "edge") {
      const ref = { panelIndex: drag.panelIndex, edgeIndex: drag.edgeIndex };
      const offset = dx * drag.outward[0] + dy * drag.outward[1];
      edit.draftLayout = translateEdgeAlongNormal(drag.startLayout, ref, offset);
      // 外周辺が余白帯へ出たら裁ち切りプレビュー(線が半透明になる)。
      edit.preview = drag.outerSide && edgeInMarginBand(edit.draftLayout, ref, drag.outerSide)
        ? { kind: "bleed", panelIndex: ref.panelIndex, edgeIndex: ref.edgeIndex }
        : null;
    } else {
      const root = stageRootElement();
      const inverse = root ? getInverseStageTransform(root) : null;
      if (inverse) {
        const point = inverse({ x: event.clientX, y: event.clientY });
        const height = edit.draftLayout.page.height;
        edit.draftHints = {
          ...drag.startHints,
          [drag.orderIndex]: {
            x: Math.min(1, Math.max(0, point.x)),
            y: Math.min(height, Math.max(0, point.y))
          }
        };
      }
    }
    requestRender();
  },
  onCommit: (_event, drag) => {
    const edit = state.nameLayoutEdit;
    if (!edit) return;
    if (drag.kind === "edge" && edit.preview?.kind === "bleed" && drag.outerSide) {
      // 余白帯で離した外周辺は裁ち切りへスナップする。
      edit.draftLayout = snapEdgeToBleed(edit.draftLayout, { panelIndex: drag.panelIndex, edgeIndex: drag.edgeIndex }, drag.outerSide);
    }
    edit.preview = null;
    if (drag.kind !== "balloon") validateDraft(edit);
    // 実際に変化したドラッグだけを履歴へ積む(開始時スナップショットは drag が所有しているので再cloneしない)。
    const changed =
      JSON.stringify(drag.startLayout) !== JSON.stringify(edit.draftLayout) ||
      JSON.stringify(drag.startHints) !== JSON.stringify(edit.draftHints);
    if (changed) pushEditHistory(edit, { layout: drag.startLayout, hints: drag.startHints });
    requestRender();
  },
  onCancel: (_event, drag) => {
    const edit = state.nameLayoutEdit;
    if (!edit) return;
    // ドラッグ開始前の状態へ復元する。
    edit.draftLayout = drag.startLayout;
    edit.draftHints = drag.startHints;
    edit.preview = null;
    requestRender();
  }
});

function parsePairRef(value: string | null | undefined): { a: number; b: number } | null {
  if (!value) return null;
  const [a, b] = value.split(":").map(Number);
  return Number.isInteger(a) && Number.isInteger(b) ? { a: a!, b: b! } : null;
}

function insertVertexOnEdge(edit: NameLayoutEditState, panelIndex: number, edgeIndex: number): void {
  const panel = edit.draftLayout.panels[panelIndex];
  if (!panel || panel.shape.type !== "polygon") return;
  pushEditHistory(edit, currentEditSnapshot(edit));
  const layout = clonePageLayout(edit.draftLayout);
  const target = layout.panels[panelIndex]!;
  if (target.shape.type !== "polygon") return;
  target.shape.points = insertPolygonVertex(target.shape.points, edgeIndex);
  edit.draftLayout = layout;
  validateDraft(edit);
  requestRender();
}

function removeVertex(edit: NameLayoutEditState, panelIndex: number, vertexIndex: number): void {
  const layout = clonePageLayout(edit.draftLayout);
  const target = layout.panels[panelIndex];
  if (!target || target.shape.type !== "polygon") return;
  const next = removePolygonVertex(target.shape.points, vertexIndex);
  if (!next) {
    pushToast("これ以上頂点を減らせません(最低3点必要です)。", "error");
    return;
  }
  pushEditHistory(edit, currentEditSnapshot(edit));
  target.shape.points = next;
  edit.draftLayout = layout;
  validateDraft(edit);
  requestRender();
}

export function handleNameLayoutEditPointerDown(event: PointerEvent): boolean {
  const edit = state.nameLayoutEdit;
  if (!edit) return false;
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("[data-nle-stage]")) return false;
  const root = stageRootElement();
  const stage = root ? getStageTransform(root) : null;
  if (!stage) return true;

  const base: Omit<DragBase, "startLayout" | "startHints"> = {
    startClientX: event.clientX,
    startClientY: event.clientY,
    pxPerUnit: stage.pxPerUnit
  };
  const snapshot = () => ({
    startLayout: clonePageLayout(edit.draftLayout),
    startHints: { ...edit.draftHints }
  });

  const insertEl = target.closest<SVGElement>("[data-nle-insert]");
  if (insertEl) {
    const ref = parsePairRef(insertEl.getAttribute("data-nle-insert"));
    if (ref) {
      event.preventDefault();
      insertVertexOnEdge(edit, ref.a, ref.b);
    }
    return true;
  }
  const vertexEl = target.closest<SVGElement>("[data-nle-vertex]");
  if (vertexEl) {
    const ref = parsePairRef(vertexEl.getAttribute("data-nle-vertex"));
    if (!ref) return true;
    event.preventDefault();
    layoutEditSession.begin(event, { ...base, ...snapshot(), kind: "vertex", panelIndex: ref.a, vertexIndex: ref.b });
    return true;
  }
  const junctionEl = target.closest<SVGElement>("[data-nle-junction]");
  if (junctionEl) {
    const id = junctionEl.getAttribute("data-nle-junction");
    const start = snapshot();
    const junction = detectJunctions(start.startLayout).find((entry) => entry.id === id);
    if (!junction) return true;
    event.preventDefault();
    layoutEditSession.begin(event, { ...base, ...start, kind: "junction", junction });
    return true;
  }
  const boundaryEl = target.closest<SVGElement>("[data-nle-boundary]");
  const gutterEl = target.closest<SVGElement>("[data-nle-gutter]");
  if (boundaryEl || gutterEl) {
    const id = (boundaryEl ?? gutterEl)!.getAttribute(boundaryEl ? "data-nle-boundary" : "data-nle-gutter");
    const start = snapshot();
    const boundary = detectSharedBoundaries(start.startLayout).find((entry) => entry.id === id);
    if (!boundary) return true;
    event.preventDefault();
    layoutEditSession.begin(event, { ...base, ...start, kind: boundaryEl ? "boundary" : "gutter", boundary });
    if (!boundaryEl) {
      edit.preview = { kind: "gutter", edges: boundary.edges.map((entry) => entry.ref) };
      requestRender();
    }
    return true;
  }
  const balloonEl = target.closest<SVGElement>("[data-nle-balloon]");
  if (balloonEl) {
    const orderIndex = Number(balloonEl.getAttribute("data-nle-balloon"));
    if (!Number.isInteger(orderIndex)) return true;
    event.preventDefault();
    layoutEditSession.begin(event, { ...base, ...snapshot(), kind: "balloon", orderIndex });
    return true;
  }
  const edgeEl = target.closest<SVGElement>("[data-nle-edge]");
  if (edgeEl) {
    const ref = parsePairRef(edgeEl.getAttribute("data-nle-edge"));
    if (!ref) return true;
    const start = snapshot();
    const outward = edgeOutwardNormal(start.startLayout, { panelIndex: ref.a, edgeIndex: ref.b });
    if (!outward) return true;
    const boundaries = detectSharedBoundaries(start.startLayout);
    const outer = outerEdgeInfo(start.startLayout, { panelIndex: ref.a, edgeIndex: ref.b }, boundaries);
    event.preventDefault();
    layoutEditSession.begin(event, {
      ...base,
      ...start,
      kind: "edge",
      panelIndex: ref.a,
      edgeIndex: ref.b,
      outward,
      outerSide: outer.isOuter ? outer.side : null
    });
    return true;
  }
  // 背景クリックは何もしない(選択状態を持たないため)。
  return true;
}

export function handleNameLayoutEditPointerMove(event: PointerEvent): boolean {
  return layoutEditSession.handleMove(event);
}

export function handleNameLayoutEditPointerUp(event: PointerEvent): boolean {
  return layoutEditSession.handleUp(event);
}

export function handleNameLayoutEditPointerCancel(event: PointerEvent): boolean {
  return layoutEditSession.handleCancel(event);
}

/** main.ts の keydown 委譲から呼ばれる。編集セッション中の Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y。 */
export function handleNameLayoutEditKeydown(event: KeyboardEvent): boolean {
  if (!state.nameLayoutEdit) return false;
  if ((event.ctrlKey || event.metaKey) && !isTextEntryTarget(event.target)) {
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) redoLayoutEdit();
      else undoLayoutEdit();
      return true;
    }
    if (key === "y") {
      event.preventDefault();
      redoLayoutEdit();
      return true;
    }
  }
  return false;
}

/** 頂点ダブルクリック=削除(panelShapeController と同じ操作系)。 */
export function handleNameLayoutEditDblClick(event: MouseEvent): boolean {
  const edit = state.nameLayoutEdit;
  if (!edit) return false;
  const target = event.target;
  const vertexEl = target instanceof Element ? target.closest<SVGElement>("[data-nle-vertex]") : null;
  if (!vertexEl) return false;
  const ref = parsePairRef(vertexEl.getAttribute("data-nle-vertex"));
  if (!ref) return false;
  event.preventDefault();
  removeVertex(edit, ref.a, ref.b);
  return true;
}

registerActions({
  "studio-edit-layout": (candidateId, target) => beginLayoutEdit(candidateId, target),
  "studio-layout-save": () => void saveLayoutEdit(),
  "studio-layout-cancel": () => cancelLayoutEdit(),
  "studio-layout-revert": () => revertLayoutEdit(),
  "studio-layout-reset": () => void resetLayoutEdit(),
  "studio-layout-undo": () => undoLayoutEdit(),
  "studio-layout-redo": () => redoLayoutEdit()
});
