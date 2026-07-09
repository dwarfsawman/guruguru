/**
 * コマ形状編集(Docs/Feature-CGCollectionSuite.md P5)。ページ編集 lightbox の「コマ枠」モードで
 * 頂点ドラッグ/辺への頂点追加/頂点削除/直線分割を扱う。純ロジックは `panelShapeEdit.ts`
 * (rect/ellipse→polygon変換・頂点操作・分割)を使う。保存は他モードと同じ「1s debounce PATCH +
 * lightbox クローズ時 flush」パターン(`pageObjectsController.ts` と同型)。ただし分割だけは
 * パネル id が変わる(新規採番)構造的操作なので debounce を待たず即時 PATCH し、その完了を待ってから
 * 既存の割り当て(あれば)を新パネル id へ移行する(`panelAssignments` の requirePanel がサーバ側の
 * 保存済み layout を見るため、順序を守る必要がある)。
 *
 * **undo/redo は P5 のスコープ外**(オブジェクトモードの `pageObjectHistory.ts` とは独立に持たない)。
 */
import type { LayoutPanel, PageLayout } from "../shared/pageLayout";
import {
  insertPolygonVertex,
  movePolygonVertex,
  panelShapeToPolygon,
  polygonArea,
  removePolygonVertex,
  splitPanelByLine
} from "../shared/panelShapeEdit";
import type { PagePanelAssignment } from "../shared/apiTypes";
import { getInverseStageTransform, getStageTransform } from "./svgGizmo";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { clampNumber, isTextEntryTarget } from "./clientUtils";

// --- 保存(debounce PATCH + flush、分割だけは即時) ---

const SAVE_DEBOUNCE_MS = 1000;
let saveDebounceTimer: number | null = null;
let inflightSave: Promise<void> | null = null;
let shapesDirty = false;

/** lightbox を開く直前に呼ぶ(保存タイマー・ドラッグ状態をリセットする)。 */
export function resetShapeEditSession(): void {
  if (saveDebounceTimer !== null) {
    window.clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  shapesDirty = false;
  vertexDrag = null;
  splitDrag = null;
}

/** 未保存の変更が保留中なら true を返しつつリセットする(lightbox クローズ判定用)。 */
export function consumeShapeEditDirtyFlag(): boolean {
  const value = shapesDirty;
  shapesDirty = false;
  return value;
}

function scheduleSave(): void {
  if (saveDebounceTimer !== null) {
    window.clearTimeout(saveDebounceTimer);
  }
  saveDebounceTimer = window.setTimeout(() => {
    saveDebounceTimer = null;
    void startPersist();
  }, SAVE_DEBOUNCE_MS);
}

function startPersist(): Promise<void> {
  const promise = persistShapeLayout().finally(() => {
    if (inflightSave === promise) {
      inflightSave = null;
    }
  });
  inflightSave = promise;
  return promise;
}

/** lightbox クローズ時に呼ぶ。保留中の debounce があれば即座に保存を実行し、その完了を返す。 */
export function flushShapeEditSave(): Promise<void> {
  if (saveDebounceTimer !== null) {
    window.clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
    return startPersist();
  }
  return inflightSave ?? Promise.resolve();
}

/** 分割用: debounce をキャンセルして即座に保存し、その完了を待つ(パネル id 移行の前に必要)。 */
function persistShapeLayoutNow(): Promise<void> {
  if (saveDebounceTimer !== null) {
    window.clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  return startPersist();
}

async function persistShapeLayout(): Promise<void> {
  // pageId/projectId/送信ボディは await より前(同期)に確定する(オブジェクト保存と同じ理由)。
  const lightbox = state.pagePanelLightbox;
  const projectId = state.currentProjectId;
  const draft = state.pageLayoutDraft;
  if (!lightbox || !projectId || !draft) {
    return;
  }
  const pageId = lightbox.pageId;
  try {
    const result = await api<{ layout: PageLayout }>(`/api/projects/${projectId}/pages/${pageId}/layout`, {
      method: "PATCH",
      body: JSON.stringify({ layout: draft })
    });
    // 応答時点で新しい編集が進行していない時だけドラフトへ反映する(pageObjectsController と同じ配慮)。
    if (state.pagePanelLightbox?.pageId === pageId && saveDebounceTimer === null && !vertexDrag && !splitDrag) {
      state.pageLayoutDraft = result.layout;
    }
    // サーバ側で消えたパネルへの割り当ては削除済みなので、ローカルの一覧からも落とす。
    const survivingIds = new Set(result.layout.panels.map((panel) => panel.id));
    state.pagePanelAssignments = state.pagePanelAssignments.filter((assignment) => survivingIds.has(assignment.panelId));
    // book 一覧側の layout も更新しておく(「コマ」モードへ戻った時に編集結果を反映させるため)。
    const bookPage = state.book?.pages.find((page) => page.id === pageId);
    if (bookPage) {
      bookPage.layout = result.layout;
    }
    shapesDirty = true;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  }
}

// --- 選択/変換 ---

function findDraftPanelIndex(panelId: string): number {
  return state.pageLayoutDraft?.panels.findIndex((panel) => panel.id === panelId) ?? -1;
}

/** main.ts の pointerdown 委譲(コマ本体クリック)から呼ぶ選択処理。分割モード中/頂点ハンドル上は呼ばない。 */
function selectShapePanel(panelId: string | null): void {
  if (state.shapeSelectedPanelId === panelId) {
    return;
  }
  state.shapeSelectedPanelId = panelId;
  state.shapeSelectedVertexIndex = null;
  requestRender();
}

/** 「多角形に変換して編集」ボタン。rect/ellipse を polygon 化する(path は不可)。 */
function convertSelectedPanelToPolygon(): void {
  const draft = state.pageLayoutDraft;
  const panelId = state.shapeSelectedPanelId;
  if (!draft || !panelId) {
    return;
  }
  const index = findDraftPanelIndex(panelId);
  if (index < 0) {
    return;
  }
  const panel = draft.panels[index]!;
  if (panel.shape.type === "polygon") {
    return;
  }
  const points = panelShapeToPolygon(panel.shape);
  if (!points) {
    pushToast("このコマ形状は多角形に変換できません。", "error");
    return;
  }
  const nextPanels = [...draft.panels];
  nextPanels[index] = { ...panel, shape: { type: "polygon", points } };
  state.pageLayoutDraft = { ...draft, panels: nextPanels };
  state.shapeSelectedVertexIndex = null;
  requestRender();
  scheduleSave();
}

// --- 頂点の移動/追加/削除 ---

function applyVertexMove(panelId: string, vertexIndex: number, newPos: [number, number], pageHeight: number): void {
  const draft = state.pageLayoutDraft;
  if (!draft) {
    return;
  }
  const index = draft.panels.findIndex((panel) => panel.id === panelId);
  if (index < 0) {
    return;
  }
  const panel = draft.panels[index]!;
  if (panel.shape.type !== "polygon") {
    return;
  }
  const nextPoints = movePolygonVertex(panel.shape.points, vertexIndex, newPos, { maxX: 1, maxY: pageHeight });
  const nextPanels = [...draft.panels];
  nextPanels[index] = { ...panel, shape: { type: "polygon", points: nextPoints } };
  state.pageLayoutDraft = { ...draft, panels: nextPanels };
  requestRender();
}

function insertVertexAt(panelId: string, edgeIndex: number): void {
  const draft = state.pageLayoutDraft;
  if (!draft) {
    return;
  }
  const index = findDraftPanelIndex(panelId);
  if (index < 0) {
    return;
  }
  const panel = draft.panels[index]!;
  if (panel.shape.type !== "polygon") {
    return;
  }
  const nextPoints = insertPolygonVertex(panel.shape.points, edgeIndex);
  const nextPanels = [...draft.panels];
  nextPanels[index] = { ...panel, shape: { type: "polygon", points: nextPoints } };
  state.pageLayoutDraft = { ...draft, panels: nextPanels };
  state.shapeSelectedVertexIndex = edgeIndex + 1;
  requestRender();
  scheduleSave();
}

function removeVertexAt(panelId: string, vertexIndex: number): void {
  const draft = state.pageLayoutDraft;
  if (!draft) {
    return;
  }
  const index = findDraftPanelIndex(panelId);
  if (index < 0) {
    return;
  }
  const panel = draft.panels[index]!;
  if (panel.shape.type !== "polygon") {
    return;
  }
  const nextPoints = removePolygonVertex(panel.shape.points, vertexIndex);
  if (!nextPoints) {
    pushToast("これ以上頂点を減らせません(最低3点必要です)。", "error");
    return;
  }
  const nextPanels = [...draft.panels];
  nextPanels[index] = { ...panel, shape: { type: "polygon", points: nextPoints } };
  state.pageLayoutDraft = { ...draft, panels: nextPanels };
  state.shapeSelectedVertexIndex = null;
  requestRender();
  scheduleSave();
}

// --- 分割モード ---

function toggleSplitMode(): void {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "shapes" || !state.shapeSelectedPanelId) {
    return;
  }
  state.shapeSplitMode = !state.shapeSplitMode;
  state.shapeSplitDraft = null;
  requestRender();
}

/** main.ts の change/input 委譲から呼ばれる。分割ガター幅の入力欄。 */
export function updateShapeSplitGutterFromControl(target: HTMLInputElement): void {
  state.shapeSplitGutter = clampNumber(Number(target.value), 0, 0.1, state.shapeSplitGutter);
}

/** 元のパネル id と衝突しない `panel_N` を発行する採番関数を作る。 */
function createPanelIdAllocator(panels: readonly LayoutPanel[]): () => string {
  const used = new Set(panels.map((panel) => panel.id));
  let counter = 1;
  return () => {
    let candidate = `panel_${counter}`;
    while (used.has(candidate)) {
      counter += 1;
      candidate = `panel_${counter}`;
    }
    used.add(candidate);
    counter += 1;
    return candidate;
  };
}

async function commitSplit(): Promise<void> {
  const lightbox = state.pagePanelLightbox;
  const draft = state.pageLayoutDraft;
  const split = state.shapeSplitDraft;
  const panelId = state.shapeSelectedPanelId;
  state.shapeSplitDraft = null;
  if (!lightbox || !draft || !split || !panelId) {
    requestRender();
    return;
  }
  const index = draft.panels.findIndex((panel) => panel.id === panelId);
  if (index < 0) {
    requestRender();
    return;
  }
  const panel = draft.panels[index]!;
  const points = panel.shape.type === "polygon" ? panel.shape.points : panelShapeToPolygon(panel.shape);
  if (!points) {
    pushToast("このコマ形状は分割できません。", "error");
    state.shapeSplitMode = false;
    requestRender();
    return;
  }
  const result = splitPanelByLine(points, split.start, split.current, state.shapeSplitGutter);
  if (!result) {
    pushToast("コマをうまく2分割できませんでした。線を引き直してください。", "error");
    requestRender();
    return;
  }

  const allocate = createPanelIdAllocator(draft.panels);
  const idA = allocate();
  const idB = allocate();
  const panelA: LayoutPanel = { id: idA, order: panel.order, shape: { type: "polygon", points: result.a } };
  const panelB: LayoutPanel = { id: idB, order: panel.order, shape: { type: "polygon", points: result.b } };
  if (panel.frame) {
    panelA.frame = { ...panel.frame };
    panelB.frame = { ...panel.frame };
  }
  const nextPanels = [...draft.panels];
  nextPanels.splice(index, 1, panelA, panelB);
  nextPanels.forEach((item, i) => {
    item.order = i + 1;
  });

  const areaA = polygonArea(result.a);
  const areaB = polygonArea(result.b);
  const winnerId = areaA >= areaB ? idA : idB;
  const originalAssignment = state.pagePanelAssignments.find((assignment) => assignment.panelId === panelId) ?? null;

  state.pageLayoutDraft = { ...draft, panels: nextPanels };
  state.shapeSelectedPanelId = winnerId;
  state.shapeSelectedVertexIndex = null;
  state.shapeSplitMode = false;
  requestRender();

  // 新パネル id はサーバの layout に保存されてから初めて存在する(page_panel_assignments の
  // requirePanel はサーバ再読込した layout を見るため)。分割は debounce を待たず即時保存する。
  await persistShapeLayoutNow();

  const pageId = lightbox.pageId;
  const projectId = state.currentProjectId;
  if (originalAssignment && projectId && state.pagePanelLightbox?.pageId === pageId) {
    try {
      const migrated = await api<{ assignment: PagePanelAssignment | null }>(
        `/api/projects/${projectId}/pages/${pageId}/panels/${winnerId}/assignment`,
        { method: "PATCH", body: JSON.stringify({ assetId: originalAssignment.assetId, crop: originalAssignment.crop }) }
      );
      state.pagePanelAssignments = state.pagePanelAssignments.filter((assignment) => assignment.panelId !== panelId);
      if (migrated.assignment) {
        state.pagePanelAssignments = [...state.pagePanelAssignments, migrated.assignment];
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error), "error");
    }
    requestRender();
  } else if (originalAssignment) {
    state.pagePanelAssignments = state.pagePanelAssignments.filter((assignment) => assignment.panelId !== panelId);
  }
}

// --- pointer/dblclick/keydown 委譲(main.ts から呼ぶ) ---

function stageRootElement(): SVGGraphicsElement | null {
  const el = document.getElementById("pageShapeStageRoot");
  return el instanceof SVGGraphicsElement ? el : null;
}

interface VertexDragState {
  pointerId: number;
  panelId: string;
  vertexIndex: number;
  pxPerUnit: number;
  startClientX: number;
  startClientY: number;
  startPoint: [number, number];
  pageHeight: number;
}

let vertexDrag: VertexDragState | null = null;

interface SplitDragState {
  pointerId: number;
}

let splitDrag: SplitDragState | null = null;

/** main.ts の pointerdown 委譲から呼ばれる。分割ドラッグ開始/頂点ドラッグ開始/辺への頂点追加/パネル選択を切り分ける。 */
export function handlePanelShapePointerDown(event: PointerEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "shapes") {
    return false;
  }
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("[data-shape-stage]")) {
    return false;
  }
  const draft = state.pageLayoutDraft;
  if (!draft) {
    return true;
  }

  if (state.shapeSplitMode && state.shapeSelectedPanelId) {
    const root = stageRootElement();
    const inverse = root ? getInverseStageTransform(root) : null;
    if (!inverse) {
      return true;
    }
    event.preventDefault();
    const point = inverse({ x: event.clientX, y: event.clientY });
    state.shapeSplitDraft = { start: [point.x, point.y], current: [point.x, point.y] };
    splitDrag = { pointerId: event.pointerId };
    requestRender();
    return true;
  }

  const vertexEl = target.closest<SVGElement>("[data-shape-vertex]");
  if (vertexEl && state.shapeSelectedPanelId) {
    const vertexIndex = Number(vertexEl.getAttribute("data-shape-vertex"));
    const panel = draft.panels.find((item) => item.id === state.shapeSelectedPanelId);
    if (!panel || panel.shape.type !== "polygon" || !Number.isFinite(vertexIndex)) {
      return true;
    }
    const root = stageRootElement();
    const stage = root ? getStageTransform(root) : null;
    if (!stage) {
      return true;
    }
    event.preventDefault();
    state.shapeSelectedVertexIndex = vertexIndex;
    vertexDrag = {
      pointerId: event.pointerId,
      panelId: state.shapeSelectedPanelId,
      vertexIndex,
      pxPerUnit: stage.pxPerUnit,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPoint: [...panel.shape.points[vertexIndex]!] as [number, number],
      pageHeight: draft.page.height
    };
    requestRender();
    return true;
  }

  const edgeEl = target.closest<SVGElement>("[data-shape-edge]");
  if (edgeEl && state.shapeSelectedPanelId) {
    const edgeIndex = Number(edgeEl.getAttribute("data-shape-edge"));
    if (Number.isFinite(edgeIndex)) {
      event.preventDefault();
      insertVertexAt(state.shapeSelectedPanelId, edgeIndex);
    }
    return true;
  }

  const panelEl = target.closest<SVGElement>("[data-shape-panel-id]");
  if (panelEl) {
    event.preventDefault();
    selectShapePanel(panelEl.getAttribute("data-shape-panel-id"));
    return true;
  }

  // 背景クリック = 選択解除。
  event.preventDefault();
  selectShapePanel(null);
  return true;
}

export function handlePanelShapePointerMove(event: PointerEvent): boolean {
  if (vertexDrag && event.pointerId === vertexDrag.pointerId) {
    const dx = (event.clientX - vertexDrag.startClientX) / vertexDrag.pxPerUnit;
    const dy = (event.clientY - vertexDrag.startClientY) / vertexDrag.pxPerUnit;
    const newPos: [number, number] = [vertexDrag.startPoint[0] + dx, vertexDrag.startPoint[1] + dy];
    applyVertexMove(vertexDrag.panelId, vertexDrag.vertexIndex, newPos, vertexDrag.pageHeight);
    return true;
  }
  if (splitDrag && event.pointerId === splitDrag.pointerId && state.shapeSplitDraft) {
    const root = stageRootElement();
    const inverse = root ? getInverseStageTransform(root) : null;
    if (!inverse) {
      return true;
    }
    const point = inverse({ x: event.clientX, y: event.clientY });
    state.shapeSplitDraft = { start: state.shapeSplitDraft.start, current: [point.x, point.y] };
    requestRender();
    return true;
  }
  return false;
}

export function handlePanelShapePointerUp(event: PointerEvent): boolean {
  if (vertexDrag && event.pointerId === vertexDrag.pointerId) {
    const drag = vertexDrag;
    vertexDrag = null;
    const draft = state.pageLayoutDraft;
    const panel = draft?.panels.find((item) => item.id === drag.panelId);
    const current = panel && panel.shape.type === "polygon" ? panel.shape.points[drag.vertexIndex] : null;
    if (current && (current[0] !== drag.startPoint[0] || current[1] !== drag.startPoint[1])) {
      scheduleSave();
    }
    return true;
  }
  if (splitDrag && event.pointerId === splitDrag.pointerId) {
    splitDrag = null;
    void commitSplit();
    return true;
  }
  return false;
}

export function handlePanelShapePointerCancel(event: PointerEvent): boolean {
  if (vertexDrag && event.pointerId === vertexDrag.pointerId) {
    const drag = vertexDrag;
    vertexDrag = null;
    // ドラッグ開始前の位置へ復元する(保存しない)。
    applyVertexMove(drag.panelId, drag.vertexIndex, drag.startPoint, drag.pageHeight);
    return true;
  }
  if (splitDrag && event.pointerId === splitDrag.pointerId) {
    splitDrag = null;
    state.shapeSplitDraft = null;
    requestRender();
    return true;
  }
  return false;
}

/** main.ts の dblclick 委譲から呼ばれる。頂点ダブルクリック = 削除。 */
export function handlePanelShapeDblClick(event: MouseEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "shapes" || !state.shapeSelectedPanelId) {
    return false;
  }
  const target = event.target;
  const vertexEl = target instanceof Element ? target.closest<SVGElement>("[data-shape-vertex]") : null;
  if (!vertexEl) {
    return false;
  }
  const vertexIndex = Number(vertexEl.getAttribute("data-shape-vertex"));
  if (!Number.isFinite(vertexIndex)) {
    return false;
  }
  event.preventDefault();
  removeVertexAt(state.shapeSelectedPanelId, vertexIndex);
  return true;
}

/** main.ts の keydown 委譲から呼ばれる。選択中頂点の Delete/Backspace = 削除。 */
export function handlePanelShapeKeydown(event: KeyboardEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "shapes") {
    return false;
  }
  if (
    (event.key === "Delete" || event.key === "Backspace") &&
    state.shapeSelectedPanelId &&
    state.shapeSelectedVertexIndex !== null &&
    !isTextEntryTarget(event.target)
  ) {
    event.preventDefault();
    removeVertexAt(state.shapeSelectedPanelId, state.shapeSelectedVertexIndex);
    return true;
  }
  return false;
}

registerActions({
  "convert-panel-shape-to-polygon": () => convertSelectedPanelToPolygon(),
  "toggle-panel-shape-split-mode": () => toggleSplitMode()
});
