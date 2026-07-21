/**
 * コマ形状編集(Docs/Feature-CGCollectionSuite.md P5)。ページ編集 lightbox の「コマ枠」モードで
 * 頂点ドラッグ/辺への頂点追加/頂点削除/直線分割を扱う。純ロジックは `panelShapeEdit.ts`
 * (rect/ellipse→polygon変換・頂点操作・分割)を使う。保存は他モードと同じ「1s debounce PATCH +
 * lightbox クローズ時 flush」パターン(`pageObjectsController.ts` と同型)。ただし分割だけは
 * パネル id が変わる(新規採番)構造的操作なので debounce を待たず即時 PATCH し、その完了を待ってから
 * 既存の割り当て(あれば)を新パネル id へ移行する(`panelAssignments` の requirePanel がサーバ側の
 * 保存済み layout を見るため、順序を守る必要がある)。
 *
 * undo/redo は `snapshotHistory.ts`(pageObjectHistory と同型の2スタック)でレイアウトスナップショットを持つ。
 * 分割の undo はレイアウトだけを戻す(移行済みコマ割り当ては戻らない)。
 */
import { PANEL_BLEED_OVERSHOOT, clonePageLayout, panelBounds, type LayoutPanel, type PageLayout } from "../shared/pageLayout";
import { LAYOUT_PANEL_BLEED } from "../shared/layoutPresets";
import { pointInPolygon } from "../shared/dialogueAutoLayout";
import {
  bezierPathData,
  fitClosedFreehandBezier,
  moveBezierAnchor,
  moveBezierHandle,
  polygonToBezier,
  removeBezierNode,
  type PanelBezierGeometry
} from "../shared/panelBezier";
import { snapPolygonVertexParallel } from "../shared/panelShapeAssist";
import {
  insertPolygonVertex,
  movePolygonVertex,
  panelShapeToPolygon,
  polygonArea,
  removePolygonVertex,
  splitPanelByLine
} from "../shared/panelShapeEdit";
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
  type LayoutJunction,
  type PageSide,
  type SharedBoundary
} from "../shared/nameLayoutEdit";
import type { PagePanelAssignment } from "../shared/apiTypes";
import { getInverseStageTransform, getStageTransform } from "./svgGizmo";
import { createDebouncedPersister, type PersistAttemptContext } from "./debouncedPersister";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { clampNumber, isTextEntryTarget } from "./clientUtils";
import { clearSnapshotHistory, createSnapshotHistory, pushSnapshot, redoSnapshot, undoSnapshot } from "./snapshotHistory";

// --- 保存(debounce PATCH + flush、分割だけは即時) ---

const shapePersister = createDebouncedPersister({ persist: persistShapeLayout });

/** lightbox を開く直前に呼ぶ(保存タイマー・ドラッグ状態・履歴・選択をリセットする)。 */
export function resetShapeEditSession(): void {
  shapePersister.reset();
  vertexDrag = null;
  bezierDrag = null;
  freehandDrag = null;
  splitDrag = null;
  geometryDrag = null;
  marqueeDrag = null;
  multiVertexDrag = null;
  panelMoveDrag = null;
  clearSnapshotHistory(layoutHistory);
  state.shapeGeometryPreview = null;
  state.shapeParallelSnapGuide = null;
  state.shapeFreehandMode = false;
  state.shapeFreehandDraft = null;
  state.shapeMarquee = null;
  state.shapeSelectedVertices = [];
  state.shapeAddVertexMode = false;
  state.shapeActiveGeometry = null;
}

// --- undo/redo(スナップショット2スタック) ---

const layoutHistory = createSnapshotHistory<PageLayout>();

/** 確定操作の直前レイアウトを履歴へ積む(deep copy して渡す)。 */
function pushLayoutHistory(before: PageLayout): void {
  pushSnapshot(layoutHistory, clonePageLayout(before));
}

/** ツールバーの undo/redo ボタンの disabled 判定(main.ts がビュー状態として渡す)。 */
export function panelShapeHistoryStatus(): { canUndo: boolean; canRedo: boolean } {
  return { canUndo: layoutHistory.undoStack.length > 0, canRedo: layoutHistory.redoStack.length > 0 };
}

function applyRestoredLayout(restored: PageLayout): void {
  state.pageLayoutDraft = restored;
  // 頂点 index はレイアウト世代に紐づくため、選択・プレビューは復元時に破棄する。
  state.shapeSelectedVertexIndex = null;
  state.shapeSelectedVertices = [];
  state.shapeMarquee = null;
  state.shapeGeometryPreview = null;
  state.shapeParallelSnapGuide = null;
  requestRender();
  scheduleSave();
}

function undoShapeLayout(): void {
  const draft = state.pageLayoutDraft;
  if (!draft || state.pagePanelLightbox?.mode !== "shapes") return;
  const restored = undoSnapshot(layoutHistory, clonePageLayout(draft));
  if (restored) applyRestoredLayout(restored);
}

function redoShapeLayout(): void {
  const draft = state.pageLayoutDraft;
  if (!draft || state.pagePanelLightbox?.mode !== "shapes") return;
  const restored = redoSnapshot(layoutHistory, clonePageLayout(draft));
  if (restored) applyRestoredLayout(restored);
}

/** 未保存の変更が保留中なら true を返しつつリセットする(lightbox クローズ判定用)。 */
export function consumeShapeEditDirtyFlag(): boolean {
  return shapePersister.consumeDirtyFlag();
}

function scheduleSave(): void {
  shapePersister.schedule();
}

/** lightbox クローズ時に呼ぶ。保留中の debounce があれば即座に保存を実行し、その完了を返す。 */
export function flushShapeEditSave(): Promise<void> {
  return shapePersister.flush();
}

/** 分割用: debounce をキャンセルして即座に保存し、その完了を待つ(パネル id 移行の前に必要)。 */
function persistShapeLayoutNow(): Promise<void> {
  return shapePersister.persistNow();
}

async function persistShapeLayout(context: PersistAttemptContext): Promise<void> {
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
    // isStale はより新しい保存の予約/発射を検知する(旧実装の saveDebounceTimer チェック相当+世代ガード)。
    if (state.pagePanelLightbox?.pageId === pageId && !context.isStale() && !vertexDrag && !bezierDrag && !freehandDrag && !splitDrag && !geometryDrag && !multiVertexDrag && !marqueeDrag && !panelMoveDrag) {
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
    shapePersister.markDirty();
    // 保存完了時点でレイヤモード等が book 側 layout を表示していても最新化されるよう再描画する
    // (これが無いと、保存前にタブを切り替えた場合に次の操作まで古いレイアウトが残る)。
    requestRender();
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
  pushLayoutHistory(draft);
  const nextPanels = [...draft.panels];
  nextPanels[index] = { ...panel, shape: { type: "polygon", points } };
  state.pageLayoutDraft = { ...draft, panels: nextPanels };
  state.shapeSelectedVertexIndex = null;
  requestRender();
  scheduleSave();
}

/** 選択中の多角形を見た目を保ったまま編集可能な cubic Bezier へ変換する。 */
function convertSelectedPanelToBezier(): void {
  const draft = state.pageLayoutDraft;
  const panelId = state.shapeSelectedPanelId;
  if (!draft || !panelId) return;
  const index = findDraftPanelIndex(panelId);
  const panel = index >= 0 ? draft.panels[index] : null;
  if (!panel || panel.shape.type !== "polygon") return;
  const bezier = polygonToBezier(panel.shape.points);
  if (!bezier) return;
  pushLayoutHistory(draft);
  const nextPanels = [...draft.panels];
  nextPanels[index] = { ...panel, shape: { type: "path", d: bezierPathData(bezier), bezier } };
  state.pageLayoutDraft = { ...draft, panels: nextPanels };
  state.shapeSelectedVertexIndex = null;
  requestRender();
  scheduleSave();
}

function toggleFreehandMode(): void {
  if (state.pagePanelLightbox?.mode !== "shapes" || !state.pageLayoutDraft) return;
  state.shapeFreehandMode = !state.shapeFreehandMode;
  state.shapeFreehandDraft = null;
  state.shapeSplitMode = false;
  state.shapeSplitDraft = null;
  state.shapeAddVertexMode = false;
  state.shapeSelectedPanelId = null;
  state.shapeSelectedVertexIndex = null;
  state.shapeSelectedVertices = [];
  requestRender();
}

/**
 * 頂点追加モード(全コマの辺中点に＋マーカーを出し、クリックで頂点を追加)。分割/フリーハンドと
 * 排他のモードトグル。有効化時に rect/ellipse コマを polygon 化する(マーカーは polygon にしか出ないため)。
 */
function toggleAddVertexMode(): void {
  const draft = state.pageLayoutDraft;
  if (state.pagePanelLightbox?.mode !== "shapes" || !draft) return;
  state.shapeAddVertexMode = !state.shapeAddVertexMode;
  if (state.shapeAddVertexMode) {
    state.pageLayoutDraft = toEditableNameLayout(draft);
  }
  state.shapeSplitMode = false;
  state.shapeSplitDraft = null;
  state.shapeFreehandMode = false;
  state.shapeFreehandDraft = null;
  state.shapeSelectedPanelId = null;
  state.shapeSelectedVertexIndex = null;
  state.shapeSelectedVertices = [];
  requestRender();
}

function applyBezierGeometry(panelId: string, bezier: PanelBezierGeometry): void {
  const draft = state.pageLayoutDraft;
  if (!draft) return;
  const index = findDraftPanelIndex(panelId);
  const panel = index >= 0 ? draft.panels[index] : null;
  if (!panel || panel.shape.type !== "path" || !panel.shape.bezier) return;
  const nextPanels = [...draft.panels];
  nextPanels[index] = { ...panel, shape: { type: "path", d: bezierPathData(bezier), bezier } };
  state.pageLayoutDraft = { ...draft, panels: nextPanels };
  requestRender();
}

function removeBezierAnchorAt(panelId: string, nodeIndex: number): void {
  const draft = state.pageLayoutDraft;
  if (!draft) return;
  const index = findDraftPanelIndex(panelId);
  const panel = index >= 0 ? draft.panels[index] : null;
  if (!panel || panel.shape.type !== "path" || !panel.shape.bezier) return;
  const bezier = removeBezierNode(panel.shape.bezier, nodeIndex);
  if (!bezier) {
    pushToast("これ以上アンカーを減らせません(最低3点必要です)。", "error");
    return;
  }
  pushLayoutHistory(draft);
  applyBezierGeometry(panelId, bezier);
  state.shapeSelectedVertexIndex = null;
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
  pushLayoutHistory(draft);
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
  pushLayoutHistory(draft);
  const nextPanels = [...draft.panels];
  nextPanels[index] = { ...panel, shape: { type: "polygon", points: nextPoints } };
  state.pageLayoutDraft = { ...draft, panels: nextPanels };
  state.shapeSelectedVertexIndex = null;
  requestRender();
  scheduleSave();
}

// --- 分割モード ---

/** 分割モード。コマの選択は不要(引いた線から対象コマを決める)。頂点追加/フリーハンドと排他。 */
function toggleSplitMode(): void {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "shapes" || !state.pageLayoutDraft) {
    return;
  }
  state.shapeSplitMode = !state.shapeSplitMode;
  state.shapeSplitDraft = null;
  state.shapeAddVertexMode = false;
  state.shapeFreehandMode = false;
  state.shapeFreehandDraft = null;
  state.shapeSelectedPanelId = null;
  state.shapeSelectedVertexIndex = null;
  state.shapeSelectedVertices = [];
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
  state.shapeSplitDraft = null;
  if (!lightbox || !draft || !split) {
    requestRender();
    return;
  }
  // 分割対象は選択ではなく引いた線から決める: 線分の中点を含むコマを優先し、
  // 見つからなければ分割が成立する最初のコマを使う。
  const mid: [number, number] = [(split.start[0] + split.current[0]) / 2, (split.start[1] + split.current[1]) / 2];
  const candidates = draft.panels
    .map((item, itemIndex) => ({
      panel: item,
      index: itemIndex,
      points: item.shape.type === "polygon" ? item.shape.points : panelShapeToPolygon(item.shape)
    }))
    .filter((entry): entry is { panel: LayoutPanel; index: number; points: [number, number][] } => entry.points !== null);
  candidates.sort((a, b) => Number(pointInPolygon(mid, b.points)) - Number(pointInPolygon(mid, a.points)));
  let chosen: { panel: LayoutPanel; index: number; result: { a: [number, number][]; b: [number, number][] } } | null = null;
  for (const entry of candidates) {
    const attempt = splitPanelByLine(entry.points, split.start, split.current, state.shapeSplitGutter);
    if (attempt) {
      chosen = { panel: entry.panel, index: entry.index, result: attempt };
      break;
    }
  }
  if (!chosen) {
    pushToast("コマをうまく2分割できませんでした。コマを横切るように線を引き直してください。", "error");
    requestRender();
    return;
  }
  const { panel, index, result } = chosen;
  const panelId = panel.id;

  const allocate = createPanelIdAllocator(draft.panels);
  const idA = allocate();
  const idB = allocate();
  const panelA: LayoutPanel = { id: idA, order: panel.order, shape: { type: "polygon", points: result.a } };
  const panelB: LayoutPanel = { id: idB, order: panel.order, shape: { type: "polygon", points: result.b } };
  if (panel.frame) {
    panelA.frame = { ...panel.frame };
    panelB.frame = { ...panel.frame };
  }
  const spliced = [...draft.panels];
  spliced.splice(index, 1, panelA, panelB);
  // 再採番はコピーに対して行う(draft と共有しているパネルを直接書き換えると、
  // 直後に積む undo スナップショットへ分割後の order が混入してしまう)。
  const nextPanels = spliced.map((item, i) => (item.order === i + 1 ? item : { ...item, order: i + 1 }));

  const areaA = polygonArea(result.a);
  const areaB = polygonArea(result.b);
  const winnerId = areaA >= areaB ? idA : idB;
  const originalAssignment = state.pagePanelAssignments.find((assignment) => assignment.panelId === panelId) ?? null;

  // undo はレイアウトのみ復元する(移行済みコマ割り当ては戻らない。復元後の再割り当てはユーザー操作)。
  pushLayoutHistory(draft);
  state.pageLayoutDraft = { ...draft, panels: nextPanels };
  // 分割モードは継続する(連続で複数のコマを分割できる)。終了はトグル/Esc。
  state.shapeSelectedVertexIndex = null;
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
  /** undo 用: ドラッグ開始時レイアウトのスナップショット。 */
  startLayout: PageLayout;
}

let vertexDrag: VertexDragState | null = null;

interface BezierDragState {
  pointerId: number;
  panelId: string;
  nodeIndex: number;
  part: "anchor" | "in" | "out";
  pxPerUnit: number;
  startClientX: number;
  startClientY: number;
  startPoint: [number, number];
  pageHeight: number;
  startLayout: PageLayout;
}

let bezierDrag: BezierDragState | null = null;

interface FreehandDragState {
  pointerId: number;
  startLayout: PageLayout;
}

let freehandDrag: FreehandDragState | null = null;

/** ドラッグ範囲選択(クリックと区別するため 4px 動くまでは選択矩形を出さない)。 */
interface MarqueeDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startLocal: [number, number];
  moved: boolean;
  clickPanelId: string | null;
}

let marqueeDrag: MarqueeDragState | null = null;

/** 範囲選択済み頂点集合の一括移動ドラッグ。 */
interface MultiVertexDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  pxPerUnit: number;
  startLayout: PageLayout;
  refs: Array<{ panelIndex: number; vertexIndex: number }>;
}

let multiVertexDrag: MultiVertexDragState | null = null;

interface SplitDragState {
  pointerId: number;
}

let splitDrag: SplitDragState | null = null;

/** 幾何編集ドラッグ(人間ゲートのコマ割り修正と同じ操作系)。純関数は開始時スナップショットへ適用する。 */
interface GeometryDragBase {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  pxPerUnit: number;
  startLayout: PageLayout;
}

type GeometryDragState =
  | (GeometryDragBase & { kind: "edge"; panelIndex: number; edgeIndex: number; outward: [number, number]; outerSide: PageSide | null })
  | (GeometryDragBase & { kind: "boundary"; boundary: SharedBoundary })
  | (GeometryDragBase & { kind: "gutter"; boundary: SharedBoundary; dir: 1 | -1 })
  | (GeometryDragBase & { kind: "junction"; junction: LayoutJunction });

let geometryDrag: GeometryDragState | null = null;

/** コマ番号バッジのドラッグでコマ全体を平行移動する。delta は形が歪まないよう外接矩形から事前クランプする。 */
interface PanelMoveDragState {
  pointerId: number;
  panelId: string;
  pxPerUnit: number;
  startClientX: number;
  startClientY: number;
  startLayout: PageLayout;
  moved: boolean;
  minDx: number;
  maxDx: number;
  minDy: number;
  maxDy: number;
}

let panelMoveDrag: PanelMoveDragState | null = null;

/** パネル全体を delta だけ平行移動する(polygon は全頂点、bezier はアンカー+制御点)。 */
function translatePanelById(layout: PageLayout, panelId: string, delta: readonly [number, number]): PageLayout {
  const clone = clonePageLayout(layout);
  const panel = clone.panels.find((item) => item.id === panelId);
  if (!panel) return clone;
  if (panel.shape.type === "polygon") {
    panel.shape.points = panel.shape.points.map(([x, y]) => [x + delta[0], y + delta[1]] as [number, number]);
  } else if (panel.shape.type === "path" && panel.shape.bezier) {
    const bezier: PanelBezierGeometry = {
      closed: true,
      nodes: panel.shape.bezier.nodes.map((node) => ({
        point: [node.point[0] + delta[0], node.point[1] + delta[1]] as [number, number],
        in: [node.in[0] + delta[0], node.in[1] + delta[1]] as [number, number],
        out: [node.out[0] + delta[0], node.out[1] + delta[1]] as [number, number]
      }))
    };
    panel.shape = { type: "path", d: bezierPathData(bezier), bezier };
  }
  return clone;
}

function parseEdgeRef(value: string | null | undefined): { panelIndex: number; edgeIndex: number } | null {
  if (!value) return null;
  const [panelIndex, edgeIndex] = value.split(":").map(Number);
  return Number.isInteger(panelIndex) && Number.isInteger(edgeIndex)
    ? { panelIndex: panelIndex!, edgeIndex: edgeIndex! }
    : null;
}

/**
 * 幾何編集ハンドルの pointerdown。rect/ellipse パネルを含むレイアウトは、最初のドラッグで
 * polygon 化してから操作する(「多角形に変換して編集」の自動版。id/order/frame/role は保持)。
 */
function beginGeometryDrag(event: PointerEvent, target: Element): boolean {
  const draft = state.pageLayoutDraft;
  if (!draft) return false;
  const boundaryEl = target.closest<SVGElement>("[data-shape-boundary]");
  const gutterEl = target.closest<SVGElement>("[data-shape-gutter]");
  const junctionEl = target.closest<SVGElement>("[data-shape-junction]");
  const edgelineEl = target.closest<SVGElement>("[data-shape-edgeline]");
  if (!boundaryEl && !gutterEl && !junctionEl && !edgelineEl) return false;
  const root = stageRootElement();
  const stage = root ? getStageTransform(root) : null;
  if (!stage) return true;
  const editable = toEditableNameLayout(draft);
  state.pageLayoutDraft = editable;
  const startLayout = clonePageLayout(editable);
  const base: GeometryDragBase = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    pxPerUnit: stage.pxPerUnit,
    startLayout
  };
  event.preventDefault();
  if (junctionEl) {
    const junction = detectJunctions(startLayout).find((entry) => entry.id === junctionEl.getAttribute("data-shape-junction"));
    if (junction) {
      geometryDrag = { ...base, kind: "junction", junction };
      state.shapeActiveGeometry = { kind: "junction", id: junction.id };
      requestRender();
    }
    return true;
  }
  if (boundaryEl || gutterEl) {
    const id = (boundaryEl ?? gutterEl)!.getAttribute(boundaryEl ? "data-shape-boundary" : "data-shape-gutter");
    const boundary = detectSharedBoundaries(startLayout).find((entry) => entry.id === id);
    if (boundary) {
      if (boundaryEl) {
        geometryDrag = { ...base, kind: "boundary", boundary };
        state.shapeActiveGeometry = { kind: "boundary", id: boundary.id };
      } else {
        // シェブロンは境界の両側にあり、どちらも「外向きドラッグで広げる」。向きは data-gutter-dir で受け取る。
        const dir = Number(gutterEl!.getAttribute("data-gutter-dir")) === -1 ? -1 : 1;
        geometryDrag = { ...base, kind: "gutter", boundary, dir };
        state.shapeActiveGeometry = { kind: "gutter", id: boundary.id };
        state.shapeGeometryPreview = { kind: "gutter", edges: boundary.edges.map((entry) => entry.ref) };
      }
      requestRender();
    }
    return true;
  }
  const ref = parseEdgeRef(edgelineEl!.getAttribute("data-shape-edgeline"));
  if (!ref) return true;
  const outward = edgeOutwardNormal(startLayout, ref);
  if (!outward) return true;
  const outer = outerEdgeInfo(startLayout, ref, detectSharedBoundaries(startLayout));
  geometryDrag = {
    ...base,
    kind: "edge",
    panelIndex: ref.panelIndex,
    edgeIndex: ref.edgeIndex,
    outward,
    outerSide: outer.isOuter ? outer.side : null
  };
  state.shapeActiveGeometry = { kind: "edge", id: `${ref.panelIndex}:${ref.edgeIndex}` };
  requestRender();
  return true;
}

function moveGeometryDrag(event: PointerEvent): void {
  const drag = geometryDrag;
  if (!drag) return;
  const dx = (event.clientX - drag.startClientX) / drag.pxPerUnit;
  const dy = (event.clientY - drag.startClientY) / drag.pxPerUnit;
  if (drag.kind === "junction") {
    state.pageLayoutDraft = moveJunction(drag.startLayout, drag.junction, [dx, dy]);
  } else if (drag.kind === "boundary") {
    const offset = dx * drag.boundary.normal[0] + dy * drag.boundary.normal[1];
    state.pageLayoutDraft = moveBoundaryAlongNormal(drag.startLayout, drag.boundary, offset);
  } else if (drag.kind === "gutter") {
    // dir=-1 のシェブロン(法線の負側)は外向き=負方向なので符号を反転して「外へ引くと広がる」を揃える。
    const along = (dx * drag.boundary.normal[0] + dy * drag.boundary.normal[1]) * drag.dir;
    state.pageLayoutDraft = setBoundaryGutter(drag.startLayout, drag.boundary, Math.max(0, drag.boundary.gutterWidth + along * 2));
  } else {
    const ref = { panelIndex: drag.panelIndex, edgeIndex: drag.edgeIndex };
    const offset = dx * drag.outward[0] + dy * drag.outward[1];
    const moved = translateEdgeAlongNormal(drag.startLayout, ref, offset);
    state.pageLayoutDraft = moved;
    // 外周辺が余白帯へ出たら裁ち切りプレビュー(線が半透明になる)。
    state.shapeGeometryPreview = drag.outerSide && edgeInMarginBand(moved, ref, drag.outerSide)
      ? { kind: "bleed", edges: [ref], side: drag.outerSide }
      : null;
  }
  requestRender();
}

function finishGeometryDrag(): void {
  const drag = geometryDrag;
  geometryDrag = null;
  if (!drag) return;
  if (drag.kind === "edge" && state.shapeGeometryPreview?.kind === "bleed" && drag.outerSide) {
    // 余白帯で離した外周辺は裁ち切り(page外 0.015)へスナップする。
    state.pageLayoutDraft = state.pageLayoutDraft
      ? snapEdgeToBleed(state.pageLayoutDraft, { panelIndex: drag.panelIndex, edgeIndex: drag.edgeIndex }, drag.outerSide)
      : state.pageLayoutDraft;
  }
  state.shapeGeometryPreview = null;
  state.shapeActiveGeometry = null;
  if (JSON.stringify(drag.startLayout) !== JSON.stringify(state.pageLayoutDraft)) {
    pushLayoutHistory(drag.startLayout);
  }
  requestRender();
  scheduleSave();
}

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

  if (state.shapeFreehandMode) {
    const root = stageRootElement();
    const inverse = root ? getInverseStageTransform(root) : null;
    if (!inverse) return true;
    event.preventDefault();
    const point = inverse({ x: event.clientX, y: event.clientY });
    state.shapeFreehandDraft = [[
      clampNumber(point.x, 0, 1, 0),
      clampNumber(point.y, 0, draft.page.height, 0)
    ]];
    freehandDrag = { pointerId: event.pointerId, startLayout: clonePageLayout(draft) };
    requestRender();
    return true;
  }

  if (state.shapeSplitMode) {
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

  // 頂点追加モード: ＋マーカークリックで頂点を追加。それ以外のクリックは何もしない(モード維持)。
  if (state.shapeAddVertexMode) {
    const markerEl = target.closest<SVGElement>("[data-shape-addvertex]");
    if (markerEl) {
      const panelId = markerEl.getAttribute("data-shape-addvertex-panel") ?? "";
      const edgeIndex = Number(markerEl.getAttribute("data-shape-addvertex"));
      if (panelId && Number.isFinite(edgeIndex)) {
        event.preventDefault();
        insertVertexAt(panelId, edgeIndex);
      }
    }
    return true;
  }

  // 範囲選択済み頂点の一括移動ハンドル。
  const mvertexEl = target.closest<SVGElement>("[data-shape-mvertex]");
  if (mvertexEl && state.shapeSelectedVertices.length > 0) {
    const root = stageRootElement();
    const stage = root ? getStageTransform(root) : null;
    if (!stage) {
      return true;
    }
    event.preventDefault();
    multiVertexDrag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      pxPerUnit: stage.pxPerUnit,
      startLayout: clonePageLayout(draft),
      refs: [...state.shapeSelectedVertices]
    };
    return true;
  }

  const bezierAnchorEl = target.closest<SVGElement>("[data-shape-bezier-anchor]");
  const bezierHandleEl = target.closest<SVGElement>("[data-shape-bezier-handle]");
  if ((bezierAnchorEl || bezierHandleEl) && state.shapeSelectedPanelId) {
    const panel = draft.panels.find((item) => item.id === state.shapeSelectedPanelId);
    if (!panel || panel.shape.type !== "path" || !panel.shape.bezier) return true;
    const raw = bezierAnchorEl?.getAttribute("data-shape-bezier-anchor")
      ?? bezierHandleEl?.getAttribute("data-shape-bezier-handle")
      ?? "";
    const [indexText, sideText] = raw.split(":");
    const nodeIndex = Number(indexText);
    const part: BezierDragState["part"] = bezierAnchorEl ? "anchor" : sideText === "in" ? "in" : "out";
    const node = panel.shape.bezier.nodes[nodeIndex];
    const root = stageRootElement();
    const stage = root ? getStageTransform(root) : null;
    if (!node || !stage) return true;
    event.preventDefault();
    state.shapeSelectedVertexIndex = nodeIndex;
    bezierDrag = {
      pointerId: event.pointerId,
      panelId: panel.id,
      nodeIndex,
      part,
      pxPerUnit: stage.pxPerUnit,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPoint: [...(part === "anchor" ? node.point : node[part])] as [number, number],
      pageHeight: draft.page.height,
      startLayout: clonePageLayout(draft)
    };
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
    state.shapeParallelSnapGuide = null;
    vertexDrag = {
      pointerId: event.pointerId,
      panelId: state.shapeSelectedPanelId,
      vertexIndex,
      pxPerUnit: stage.pxPerUnit,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPoint: [...panel.shape.points[vertexIndex]!] as [number, number],
      pageHeight: draft.page.height,
      startLayout: clonePageLayout(draft)
    };
    requestRender();
    return true;
  }

  // コマ番号バッジ: ドラッグでコマ全体を平行移動(クリックだけなら選択)。
  // バッジは幾何ハンドルより上に描画されるため、重なった場合はバッジが勝つ。
  const moveEl = target.closest<SVGElement>("[data-shape-panel-move]");
  if (moveEl) {
    const panelId = moveEl.getAttribute("data-shape-panel-move") ?? "";
    const root = stageRootElement();
    const stage = root ? getStageTransform(root) : null;
    if (!stage || !panelId) {
      return true;
    }
    // rect/ellipse は最初の移動で polygon 化する(幾何ドラッグと同じ規約。bezier はそのまま平行移動)。
    const editable = toEditableNameLayout(draft);
    const panel = editable.panels.find((item) => item.id === panelId);
    if (!panel) {
      return true;
    }
    event.preventDefault();
    state.pageLayoutDraft = editable;
    const [x0, y0, x1, y1] = panelBounds(panel.shape);
    const bleed = LAYOUT_PANEL_BLEED;
    panelMoveDrag = {
      pointerId: event.pointerId,
      panelId,
      pxPerUnit: stage.pxPerUnit,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLayout: clonePageLayout(editable),
      moved: false,
      minDx: Math.min(0, -bleed - x0),
      maxDx: Math.max(0, 1 + bleed - x1),
      minDy: Math.min(0, -bleed - y0),
      maxDy: Math.max(0, editable.page.height + bleed - y1)
    };
    // バッジは選択ハンドルとしても働く(クリック=選択、ドラッグ=移動)。
    state.shapeSelectedPanelId = panelId;
    state.shapeSelectedVertexIndex = null;
    state.shapeSelectedVertices = [];
    requestRender();
    return true;
  }

  // 幾何編集ハンドル(境界/ガターシェブロン/交差点/辺ドラッグ)。選択パネルの頂点ハンドルより後、
  // パネル選択より前(辺ライン上のクリックはドラッグ、内部クリックは従来どおり選択)。
  if (beginGeometryDrag(event, target)) {
    return true;
  }

  // パネル本体/背景: クリック=選択/解除、ドラッグ=頂点の範囲選択(pointerup で判定)。
  const panelEl = target.closest<SVGElement>("[data-shape-panel-id]");
  const rootForMarquee = stageRootElement();
  const inverseForMarquee = rootForMarquee ? getInverseStageTransform(rootForMarquee) : null;
  if (!inverseForMarquee) {
    return true;
  }
  event.preventDefault();
  const marqueeStart = inverseForMarquee({ x: event.clientX, y: event.clientY });
  marqueeDrag = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startLocal: [marqueeStart.x, marqueeStart.y],
    moved: false,
    clickPanelId: panelEl?.getAttribute("data-shape-panel-id") ?? null
  };
  return true;
}

export function handlePanelShapePointerMove(event: PointerEvent): boolean {
  if (freehandDrag && event.pointerId === freehandDrag.pointerId) {
    const root = stageRootElement();
    const inverse = root ? getInverseStageTransform(root) : null;
    const draft = state.pageLayoutDraft;
    if (inverse && draft && state.shapeFreehandDraft) {
      const local = inverse({ x: event.clientX, y: event.clientY });
      const point: [number, number] = [
        clampNumber(local.x, 0, 1, 0),
        clampNumber(local.y, 0, draft.page.height, 0)
      ];
      const last = state.shapeFreehandDraft[state.shapeFreehandDraft.length - 1];
      if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= 0.003) {
        state.shapeFreehandDraft = [...state.shapeFreehandDraft, point];
        requestRender();
      }
    }
    return true;
  }
  if (bezierDrag && event.pointerId === bezierDrag.pointerId) {
    const drag = bezierDrag;
    const panel = drag.startLayout.panels.find((item) => item.id === drag.panelId);
    if (!panel || panel.shape.type !== "path" || !panel.shape.bezier) return true;
    const dx = (event.clientX - drag.startClientX) / drag.pxPerUnit;
    const dy = (event.clientY - drag.startClientY) / drag.pxPerUnit;
    const limit = PANEL_BLEED_OVERSHOOT;
    const point: [number, number] = [
      clampNumber(drag.startPoint[0] + dx, -limit, 1 + limit, drag.startPoint[0]),
      clampNumber(drag.startPoint[1] + dy, -limit, drag.pageHeight + limit, drag.startPoint[1])
    ];
    const bezier = drag.part === "anchor"
      ? moveBezierAnchor(panel.shape.bezier, drag.nodeIndex, point)
      : moveBezierHandle(panel.shape.bezier, drag.nodeIndex, drag.part, point, !event.altKey);
    applyBezierGeometry(drag.panelId, bezier);
    return true;
  }
  if (geometryDrag && event.pointerId === geometryDrag.pointerId) {
    moveGeometryDrag(event);
    return true;
  }
  if (panelMoveDrag && event.pointerId === panelMoveDrag.pointerId) {
    const drag = panelMoveDrag;
    const dxRaw = (event.clientX - drag.startClientX) / drag.pxPerUnit;
    const dyRaw = (event.clientY - drag.startClientY) / drag.pxPerUnit;
    if (!drag.moved && Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) > 3) {
      drag.moved = true;
    }
    if (drag.moved) {
      const dx = clampNumber(dxRaw, drag.minDx, drag.maxDx, 0);
      const dy = clampNumber(dyRaw, drag.minDy, drag.maxDy, 0);
      state.pageLayoutDraft = translatePanelById(drag.startLayout, drag.panelId, [dx, dy]);
      requestRender();
    }
    return true;
  }
  if (multiVertexDrag && event.pointerId === multiVertexDrag.pointerId) {
    const dx = (event.clientX - multiVertexDrag.startClientX) / multiVertexDrag.pxPerUnit;
    const dy = (event.clientY - multiVertexDrag.startClientY) / multiVertexDrag.pxPerUnit;
    state.pageLayoutDraft = movePanelVertices(multiVertexDrag.startLayout, multiVertexDrag.refs, [dx, dy]);
    requestRender();
    return true;
  }
  if (marqueeDrag && event.pointerId === marqueeDrag.pointerId) {
    if (!marqueeDrag.moved) {
      const dist = Math.hypot(event.clientX - marqueeDrag.startClientX, event.clientY - marqueeDrag.startClientY);
      if (dist > 4) marqueeDrag.moved = true;
    }
    if (marqueeDrag.moved) {
      const root = stageRootElement();
      const inverse = root ? getInverseStageTransform(root) : null;
      if (inverse) {
        const point = inverse({ x: event.clientX, y: event.clientY });
        state.shapeMarquee = { start: marqueeDrag.startLocal, current: [point.x, point.y] };
        requestRender();
      }
    }
    return true;
  }
  if (vertexDrag && event.pointerId === vertexDrag.pointerId) {
    const dx = (event.clientX - vertexDrag.startClientX) / vertexDrag.pxPerUnit;
    const dy = (event.clientY - vertexDrag.startClientY) / vertexDrag.pxPerUnit;
    const candidate: [number, number] = [vertexDrag.startPoint[0] + dx, vertexDrag.startPoint[1] + dy];
    const snapped = snapPolygonVertexParallel(vertexDrag.startLayout, vertexDrag.panelId, vertexDrag.vertexIndex, candidate);
    state.shapeParallelSnapGuide = snapped.guide;
    applyVertexMove(vertexDrag.panelId, vertexDrag.vertexIndex, snapped.point, vertexDrag.pageHeight);
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
  if (freehandDrag && event.pointerId === freehandDrag.pointerId) {
    const drag = freehandDrag;
    freehandDrag = null;
    const points = state.shapeFreehandDraft ?? [];
    state.shapeFreehandDraft = null;
    const bezier = fitClosedFreehandBezier(points);
    if (!bezier) {
      pushToast("閉じた領域になるよう、もう少し大きく一周描いてください。", "error");
      requestRender();
      return true;
    }
    const draft = state.pageLayoutDraft;
    if (!draft) return true;
    const id = createPanelIdAllocator(draft.panels)();
    const order = draft.panels.reduce((max, panel) => Math.max(max, panel.order), 0) + 1;
    const panel: LayoutPanel = { id, order, shape: { type: "path", d: bezierPathData(bezier), bezier } };
    pushLayoutHistory(drag.startLayout);
    state.pageLayoutDraft = { ...draft, panels: [...draft.panels, panel] };
    state.shapeSelectedPanelId = id;
    state.shapeSelectedVertexIndex = null;
    state.shapeFreehandMode = false;
    requestRender();
    scheduleSave();
    return true;
  }
  if (bezierDrag && event.pointerId === bezierDrag.pointerId) {
    const drag = bezierDrag;
    bezierDrag = null;
    if (JSON.stringify(drag.startLayout) !== JSON.stringify(state.pageLayoutDraft)) {
      pushLayoutHistory(drag.startLayout);
      scheduleSave();
    }
    requestRender();
    return true;
  }
  if (geometryDrag && event.pointerId === geometryDrag.pointerId) {
    finishGeometryDrag();
    return true;
  }
  if (panelMoveDrag && event.pointerId === panelMoveDrag.pointerId) {
    const drag = panelMoveDrag;
    panelMoveDrag = null;
    if (drag.moved && JSON.stringify(drag.startLayout) !== JSON.stringify(state.pageLayoutDraft)) {
      pushLayoutHistory(drag.startLayout);
      scheduleSave();
    }
    requestRender();
    return true;
  }
  if (multiVertexDrag && event.pointerId === multiVertexDrag.pointerId) {
    const drag = multiVertexDrag;
    multiVertexDrag = null;
    if (JSON.stringify(drag.startLayout) !== JSON.stringify(state.pageLayoutDraft)) {
      pushLayoutHistory(drag.startLayout);
      scheduleSave();
    }
    requestRender();
    return true;
  }
  if (marqueeDrag && event.pointerId === marqueeDrag.pointerId) {
    const drag = marqueeDrag;
    marqueeDrag = null;
    if (!drag.moved) {
      // クリック: 従来どおりパネル選択/背景で解除。範囲選択は解除する。
      state.shapeMarquee = null;
      state.shapeSelectedVertices = [];
      selectShapePanel(drag.clickPanelId);
      requestRender();
      return true;
    }
    const rect = state.shapeMarquee;
    state.shapeMarquee = null;
    const draft = state.pageLayoutDraft;
    if (!rect || !draft) {
      requestRender();
      return true;
    }
    // 頂点 index を確定させるため、範囲選択の確定時に polygon 化する(幾何ドラッグと同じ規約)。
    const editable = toEditableNameLayout(draft);
    state.pageLayoutDraft = editable;
    const x0 = Math.min(rect.start[0], rect.current[0]);
    const x1 = Math.max(rect.start[0], rect.current[0]);
    const y0 = Math.min(rect.start[1], rect.current[1]);
    const y1 = Math.max(rect.start[1], rect.current[1]);
    const selected: Array<{ panelIndex: number; vertexIndex: number }> = [];
    editable.panels.forEach((panel, panelIndex) => {
      if (panel.shape.type !== "polygon") return;
      panel.shape.points.forEach(([x, y], vertexIndex) => {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) selected.push({ panelIndex, vertexIndex });
      });
    });
    state.shapeSelectedVertices = selected;
    state.shapeSelectedPanelId = null;
    state.shapeSelectedVertexIndex = null;
    requestRender();
    return true;
  }
  if (vertexDrag && event.pointerId === vertexDrag.pointerId) {
    const drag = vertexDrag;
    vertexDrag = null;
    state.shapeParallelSnapGuide = null;
    const draft = state.pageLayoutDraft;
    const panel = draft?.panels.find((item) => item.id === drag.panelId);
    const current = panel && panel.shape.type === "polygon" ? panel.shape.points[drag.vertexIndex] : null;
    if (current && (current[0] !== drag.startPoint[0] || current[1] !== drag.startPoint[1])) {
      pushLayoutHistory(drag.startLayout);
      scheduleSave();
    }
    requestRender();
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
  if (freehandDrag && event.pointerId === freehandDrag.pointerId) {
    state.pageLayoutDraft = freehandDrag.startLayout;
    freehandDrag = null;
    state.shapeFreehandDraft = null;
    requestRender();
    return true;
  }
  if (bezierDrag && event.pointerId === bezierDrag.pointerId) {
    state.pageLayoutDraft = bezierDrag.startLayout;
    bezierDrag = null;
    requestRender();
    return true;
  }
  if (geometryDrag && event.pointerId === geometryDrag.pointerId) {
    // ドラッグ開始前の状態へ復元する(保存しない)。
    state.pageLayoutDraft = geometryDrag.startLayout;
    geometryDrag = null;
    state.shapeGeometryPreview = null;
    state.shapeActiveGeometry = null;
    requestRender();
    return true;
  }
  if (panelMoveDrag && event.pointerId === panelMoveDrag.pointerId) {
    // ドラッグ開始前の状態へ復元する(保存しない)。
    state.pageLayoutDraft = panelMoveDrag.startLayout;
    panelMoveDrag = null;
    requestRender();
    return true;
  }
  if (multiVertexDrag && event.pointerId === multiVertexDrag.pointerId) {
    // ドラッグ開始前の状態へ復元する(保存しない)。
    state.pageLayoutDraft = multiVertexDrag.startLayout;
    multiVertexDrag = null;
    requestRender();
    return true;
  }
  if (marqueeDrag && event.pointerId === marqueeDrag.pointerId) {
    marqueeDrag = null;
    state.shapeMarquee = null;
    requestRender();
    return true;
  }
  if (vertexDrag && event.pointerId === vertexDrag.pointerId) {
    const drag = vertexDrag;
    vertexDrag = null;
    state.shapeParallelSnapGuide = null;
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
  const bezierEl = target instanceof Element ? target.closest<SVGElement>("[data-shape-bezier-anchor]") : null;
  if (!vertexEl && !bezierEl) {
    return false;
  }
  const vertexIndex = Number(vertexEl?.getAttribute("data-shape-vertex") ?? bezierEl?.getAttribute("data-shape-bezier-anchor"));
  if (!Number.isFinite(vertexIndex)) {
    return false;
  }
  event.preventDefault();
  if (bezierEl) removeBezierAnchorAt(state.shapeSelectedPanelId, vertexIndex);
  else removeVertexAt(state.shapeSelectedPanelId, vertexIndex);
  return true;
}

/** main.ts の keydown 委譲から呼ばれる。Ctrl+Z/Y(undo/redo)・選択中頂点の Delete・Escape。 */
export function handlePanelShapeKeydown(event: KeyboardEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "shapes") {
    return false;
  }
  if ((event.ctrlKey || event.metaKey) && !isTextEntryTarget(event.target)) {
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) redoShapeLayout();
      else undoShapeLayout();
      return true;
    }
    if (key === "y") {
      event.preventDefault();
      redoShapeLayout();
      return true;
    }
  }
  // Escape は段階的に解除する(モード/範囲選択→パネル選択→(未処理なら)lightbox クローズ)。
  if (
    event.key === "Escape" &&
    (state.shapeFreehandMode ||
      state.shapeSplitMode ||
      state.shapeAddVertexMode ||
      state.shapeSelectedVertices.length > 0 ||
      state.shapeMarquee)
  ) {
    event.preventDefault();
    state.shapeFreehandMode = false;
    state.shapeFreehandDraft = null;
    freehandDrag = null;
    state.shapeSplitMode = false;
    state.shapeSplitDraft = null;
    splitDrag = null;
    state.shapeAddVertexMode = false;
    state.shapeSelectedVertices = [];
    state.shapeMarquee = null;
    marqueeDrag = null;
    requestRender();
    return true;
  }
  if (event.key === "Escape" && state.shapeSelectedPanelId) {
    event.preventDefault();
    state.shapeSelectedPanelId = null;
    state.shapeSelectedVertexIndex = null;
    requestRender();
    return true;
  }
  if (
    (event.key === "Delete" || event.key === "Backspace") &&
    state.shapeSelectedPanelId &&
    state.shapeSelectedVertexIndex !== null &&
    !isTextEntryTarget(event.target)
  ) {
    event.preventDefault();
    const panel = state.pageLayoutDraft?.panels.find((item) => item.id === state.shapeSelectedPanelId);
    if (panel?.shape.type === "path" && panel.shape.bezier) {
      removeBezierAnchorAt(state.shapeSelectedPanelId, state.shapeSelectedVertexIndex);
    } else {
      removeVertexAt(state.shapeSelectedPanelId, state.shapeSelectedVertexIndex);
    }
    return true;
  }
  return false;
}

registerActions({
  "convert-panel-shape-to-polygon": () => convertSelectedPanelToPolygon(),
  "convert-panel-shape-to-bezier": () => convertSelectedPanelToBezier(),
  "toggle-panel-shape-freehand-mode": () => toggleFreehandMode(),
  "toggle-panel-shape-split-mode": () => toggleSplitMode(),
  "toggle-panel-shape-add-vertex-mode": () => toggleAddVertexMode(),
  "page-shape-undo": () => undoShapeLayout(),
  "page-shape-redo": () => redoShapeLayout()
});
