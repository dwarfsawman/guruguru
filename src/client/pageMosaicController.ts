/**
 * モザイクツール(Docs/Feature-CGCollectionSuite.md P6)。ページ編集 lightbox の「モザイク」モードで
 * 矩形/多角形リージョンの追加・選択・頂点/辺編集・削除・granularity(粒度)編集を扱う。
 * 純ロジックは `mosaicRegion.ts`(モデル・normalize・矩形リサイズ)と `panelShapeEdit.ts`
 * (polygon 頂点操作 -- P5 と全く同じ関数を再利用する)を使う。保存は他モードと同じ「1s debounce PATCH +
 * lightbox クローズ時 flush」パターン(`panelShapeController.ts`/`pageObjectsController.ts` と同型)。
 *
 * 追加のジェスチャ:
 * - 矩形追加: 「矩形を追加」でモード ON → ステージ上をドラッグ → pointerup で確定(小さすぎれば破棄)。
 * - 多角形追加: 「多角形を追加」でモード ON → クリックのたびに頂点を追加 → ダブルクリック、または
 *   既存頂点数3以上で始点近傍をクリックすると閉じて確定する。ダブルクリックの2発目のクリック
 *   (`event.detail >= 2`)は頂点追加をスキップし(1発目で既に最終頂点が置かれているため)、
 *   dblclick イベント側で確定処理する(`handlePagePanelClick` の detail>=2 ガードと同じ考え方)。
 *
 * 編集: 選択中リージョンが rect なら4隅(自由リサイズ)+4辺(1軸リサイズ)ハンドル、polygon なら
 * P5 と同じ頂点ドラッグ/辺クリックでの頂点追加/削除。ドラッグ系の座標変換は `svgGizmo.ts` の
 * `getInverseStageTransform`(画面px→ステージ座標の絶対値。分割線ドラッグ(P5)と同じ理由で必要)を使う。
 *
 * **undo/redo は P6 のスコープ外**(コマ形状編集(P5)と同じ判断)。
 */
import type { MosaicRegion, MosaicShape } from "../shared/mosaicRegion";
import {
  DEFAULT_MOSAIC_GRANULARITY,
  MOSAIC_CLOSE_POLYGON_THRESHOLD,
  MOSAIC_GRANULARITY_MAX,
  MOSAIC_GRANULARITY_MIN,
  MOSAIC_MIN_DRAG_SIZE,
  createPolygonMosaicRegion,
  createRectMosaicRegion,
  resizeMosaicRectBounds,
  type MosaicRectHandleKind
} from "../shared/mosaicRegion";
import { insertPolygonVertex, movePolygonVertex, removePolygonVertex } from "../shared/panelShapeEdit";
import { getInverseStageTransform } from "./svgGizmo";
import { createDragSession } from "./dragSession";
import { createDebouncedPersister, type PersistAttemptContext } from "./debouncedPersister";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { clampNumber, isTextEntryTarget } from "./clientUtils";

// --- 保存(debounce PATCH + flush、パターンは panelShapeController と同型) ---

const mosaicPersister = createDebouncedPersister({ persist: persistMosaicRegions });

/** lightbox を開く直前に呼ぶ(保存タイマー・ドラッグ/追加作業状態をリセットする)。 */
export function resetMosaicEditSession(): void {
  mosaicPersister.reset();
  for (const session of mosaicDragSessions) {
    session.reset();
  }
}

/** 未保存の変更が保留中なら true を返しつつリセットする(lightbox クローズ判定用)。 */
export function consumeMosaicDirtyFlag(): boolean {
  return mosaicPersister.consumeDirtyFlag();
}

function scheduleSave(): void {
  mosaicPersister.schedule();
}

/** lightbox クローズ時に呼ぶ。保留中の debounce があれば即座に保存を実行し、その完了を返す。 */
export function flushMosaicEditSave(): Promise<void> {
  return mosaicPersister.flush();
}

async function persistMosaicRegions(context: PersistAttemptContext): Promise<void> {
  // pageId/projectId/送信ボディは await より前(同期)に確定する(オブジェクト/コマ枠保存と同じ理由)。
  const lightbox = state.pagePanelLightbox;
  const projectId = state.currentProjectId;
  if (!lightbox || !projectId) {
    return;
  }
  const pageId = lightbox.pageId;
  try {
    const result = await api<{ regions: MosaicRegion[] }>(`/api/projects/${projectId}/pages/${pageId}/mosaic`, {
      method: "PATCH",
      body: JSON.stringify({ regions: state.pageMosaicDraft })
    });
    // 応答時点で新しい編集が進行していない時だけドラフトへ反映する(他モードと同じ配慮)。
    if (state.pagePanelLightbox?.pageId === pageId && !context.isStale() && !mosaicDragActive()) {
      state.pageMosaicDraft = result.regions;
    }
    mosaicPersister.markDirty();
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  }
}

// --- 選択/削除 ---

function findDraftIndex(regionId: string): number {
  return state.pageMosaicDraft.findIndex((region) => region.id === regionId);
}

function selectRegion(regionId: string | null): void {
  if (state.mosaicSelectedRegionId === regionId) {
    return;
  }
  state.mosaicSelectedRegionId = regionId;
  state.mosaicSelectedVertexIndex = null;
  requestRender();
}

function deleteSelectedRegion(): void {
  const regionId = state.mosaicSelectedRegionId;
  if (!regionId) {
    return;
  }
  state.pageMosaicDraft = state.pageMosaicDraft.filter((region) => region.id !== regionId);
  state.mosaicSelectedRegionId = null;
  state.mosaicSelectedVertexIndex = null;
  requestRender();
  scheduleSave();
}

// --- 追加モード ---

function setAddMode(mode: "rect" | "polygon"): void {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "mosaic") {
    return;
  }
  const next = state.mosaicAddMode === mode ? null : mode;
  state.mosaicAddMode = next;
  state.mosaicPolygonDraft = next === "polygon" ? [] : null;
  state.mosaicRectDraft = null;
  state.mosaicSelectedRegionId = null;
  state.mosaicSelectedVertexIndex = null;
  requestRender();
}

function finalizePolygonDraft(): void {
  const points = state.mosaicPolygonDraft ?? [];
  state.mosaicAddMode = null;
  state.mosaicPolygonDraft = null;
  if (points.length < 3) {
    if (points.length > 0) {
      pushToast("多角形には3点以上必要です。", "error");
    }
    requestRender();
    return;
  }
  const region = createPolygonMosaicRegion(crypto.randomUUID(), points);
  state.pageMosaicDraft = [...state.pageMosaicDraft, region];
  state.mosaicSelectedRegionId = region.id;
  state.mosaicSelectedVertexIndex = null;
  requestRender();
  scheduleSave();
}

// --- 頂点/矩形ハンドル編集 ---

function pageHeightForLightbox(): number {
  return state.pagePanelLightbox?.pageHeight ?? 50;
}

function applyVertexMove(regionId: string, vertexIndex: number, newPos: [number, number]): void {
  const index = findDraftIndex(regionId);
  if (index < 0) {
    return;
  }
  const region = state.pageMosaicDraft[index]!;
  if (region.shape.type !== "polygon") {
    return;
  }
  const nextPoints = movePolygonVertex(region.shape.points, vertexIndex, newPos, { maxX: 1, maxY: pageHeightForLightbox() });
  const next = [...state.pageMosaicDraft];
  next[index] = { ...region, shape: { type: "polygon", points: nextPoints } };
  state.pageMosaicDraft = next;
  requestRender();
}

function insertVertexAt(regionId: string, edgeIndex: number): void {
  const index = findDraftIndex(regionId);
  if (index < 0) {
    return;
  }
  const region = state.pageMosaicDraft[index]!;
  if (region.shape.type !== "polygon") {
    return;
  }
  const nextPoints = insertPolygonVertex(region.shape.points, edgeIndex);
  const next = [...state.pageMosaicDraft];
  next[index] = { ...region, shape: { type: "polygon", points: nextPoints } };
  state.pageMosaicDraft = next;
  state.mosaicSelectedVertexIndex = edgeIndex + 1;
  requestRender();
  scheduleSave();
}

function removeVertexAt(regionId: string, vertexIndex: number): void {
  const index = findDraftIndex(regionId);
  if (index < 0) {
    return;
  }
  const region = state.pageMosaicDraft[index]!;
  if (region.shape.type !== "polygon") {
    return;
  }
  const nextPoints = removePolygonVertex(region.shape.points, vertexIndex);
  if (!nextPoints) {
    pushToast("これ以上頂点を減らせません(最低3点必要です)。", "error");
    return;
  }
  const next = [...state.pageMosaicDraft];
  next[index] = { ...region, shape: { type: "polygon", points: nextPoints } };
  state.pageMosaicDraft = next;
  state.mosaicSelectedVertexIndex = null;
  requestRender();
  scheduleSave();
}

function applyRectHandleMove(
  regionId: string,
  handle: { kind: MosaicRectHandleKind; index: number },
  point: [number, number]
): void {
  const index = findDraftIndex(regionId);
  if (index < 0) {
    return;
  }
  const region = state.pageMosaicDraft[index]!;
  if (region.shape.type !== "rect") {
    return;
  }
  const nextBounds = resizeMosaicRectBounds(region.shape.bounds, handle, point);
  const next = [...state.pageMosaicDraft];
  next[index] = { ...region, shape: { type: "rect", bounds: nextBounds } };
  state.pageMosaicDraft = next;
  requestRender();
}

// --- granularity(粒度)編集 ---

/** main.ts の change/input 委譲から呼ばれる。「粒度を指定」チェックボックスのトグル。 */
export function toggleMosaicGranularityEnabled(checked: boolean): void {
  const regionId = state.mosaicSelectedRegionId;
  if (!regionId) {
    return;
  }
  const index = findDraftIndex(regionId);
  if (index < 0) {
    return;
  }
  const region = state.pageMosaicDraft[index]!;
  const next: MosaicRegion = { ...region };
  if (checked) {
    next.granularity = region.granularity ?? DEFAULT_MOSAIC_GRANULARITY;
  } else {
    delete next.granularity;
  }
  const nextList = [...state.pageMosaicDraft];
  nextList[index] = next;
  state.pageMosaicDraft = nextList;
  requestRender();
  scheduleSave();
}

/** main.ts の change/input 委譲から呼ばれる。粒度(長辺比)の数値入力。 */
export function updateMosaicGranularityFromControl(target: HTMLInputElement): void {
  const regionId = state.mosaicSelectedRegionId;
  if (!regionId) {
    return;
  }
  const index = findDraftIndex(regionId);
  if (index < 0) {
    return;
  }
  const region = state.pageMosaicDraft[index]!;
  const raw = Number(target.value);
  const next: MosaicRegion = { ...region };
  if (!Number.isFinite(raw) || raw <= 0) {
    delete next.granularity;
  } else {
    next.granularity = clampNumber(raw, MOSAIC_GRANULARITY_MIN, MOSAIC_GRANULARITY_MAX, DEFAULT_MOSAIC_GRANULARITY);
  }
  const nextList = [...state.pageMosaicDraft];
  nextList[index] = next;
  state.pageMosaicDraft = nextList;
  requestRender();
  scheduleSave();
}

// --- pointer/dblclick/keydown 委譲(main.ts から呼ぶ) ---

function stageRootElement(): SVGGraphicsElement | null {
  const el = document.getElementById("pageMosaicStageRoot");
  return el instanceof SVGGraphicsElement ? el : null;
}

function pointFromEvent(event: PointerEvent | MouseEvent): [number, number] | null {
  const root = stageRootElement();
  const inverse = root ? getInverseStageTransform(root) : null;
  if (!inverse) {
    return null;
  }
  const point = inverse({ x: event.clientX, y: event.clientY });
  return [point.x, point.y];
}

function distance(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// 各ドラッグは createDragSession(dragSession.ts)へ委譲する(pointerId 照合・setPointerCapture/release・
// up/cancel でのセッションクリアを共通化。capture 導入でウィンドウ外リリース時の張り付きも解消)。

interface VertexDragData {
  regionId: string;
  vertexIndex: number;
  startPoint: [number, number];
}

const vertexSession = createDragSession<VertexDragData>({
  onMove: (event, drag) => {
    const point = pointFromEvent(event);
    if (point) {
      applyVertexMove(drag.regionId, drag.vertexIndex, point);
    }
  },
  onCommit: (_event, drag) => {
    const shape = shapeOf(drag.regionId);
    const current = shape && shape.type === "polygon" ? shape.points[drag.vertexIndex] : null;
    if (current && (current[0] !== drag.startPoint[0] || current[1] !== drag.startPoint[1])) {
      scheduleSave();
    }
  },
  onCancel: (_event, drag) => {
    // ドラッグ開始前の位置へ復元する(保存しない)。
    applyVertexMove(drag.regionId, drag.vertexIndex, drag.startPoint);
  }
});

interface RectHandleDragData {
  regionId: string;
  handle: { kind: MosaicRectHandleKind; index: number };
  startBounds: [number, number, number, number];
}

const rectHandleSession = createDragSession<RectHandleDragData>({
  onMove: (event, drag) => {
    const point = pointFromEvent(event);
    if (point) {
      applyRectHandleMove(drag.regionId, drag.handle, point);
    }
  },
  onCommit: (_event, drag) => {
    const shape = shapeOf(drag.regionId);
    const current = shape && shape.type === "rect" ? shape.bounds : null;
    if (current && current.some((value, i) => value !== drag.startBounds[i])) {
      scheduleSave();
    }
  },
  onCancel: (_event, drag) => {
    // ドラッグ開始前の bounds へそのまま復元する(保存しない)。
    const index = findDraftIndex(drag.regionId);
    if (index >= 0) {
      const region = state.pageMosaicDraft[index]!;
      if (region.shape.type === "rect") {
        const next = [...state.pageMosaicDraft];
        next[index] = { ...region, shape: { type: "rect", bounds: drag.startBounds } };
        state.pageMosaicDraft = next;
        requestRender();
      }
    }
  }
});

const rectAddSession = createDragSession<Record<string, never>>({
  onMove: (event) => {
    if (!state.mosaicRectDraft) return;
    const point = pointFromEvent(event);
    if (point) {
      state.mosaicRectDraft = { start: state.mosaicRectDraft.start, current: point };
      requestRender();
    }
  },
  onCommit: () => {
    commitRectAdd();
  },
  onCancel: () => {
    state.mosaicRectDraft = null;
    requestRender();
  }
});

/** move/up/cancel の委譲順。従来の if チェーン順をそのまま配列で表現する。 */
const mosaicDragSessions = [vertexSession, rectHandleSession, rectAddSession] as const;

/** いずれかのモザイクドラッグが進行中か(保存応答でドラフトを上書きしない判定に使う)。 */
function mosaicDragActive(): boolean {
  return mosaicDragSessions.some((session) => session.data !== null);
}

function shapeOf(regionId: string): MosaicShape | null {
  return state.pageMosaicDraft.find((region) => region.id === regionId)?.shape ?? null;
}

/** main.ts の pointerdown 委譲から呼ばれる。追加モード/ハンドルドラッグ開始/リージョン選択を切り分ける。 */
export function handleMosaicPointerDown(event: PointerEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "mosaic") {
    return false;
  }
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("[data-mosaic-stage]")) {
    return false;
  }

  if (state.mosaicAddMode === "rect") {
    const point = pointFromEvent(event);
    if (!point) {
      return true;
    }
    event.preventDefault();
    state.mosaicRectDraft = { start: point, current: point };
    rectAddSession.begin(event, {});
    requestRender();
    return true;
  }

  if (state.mosaicAddMode === "polygon") {
    event.preventDefault();
    if (event.detail >= 2) {
      // ダブルクリックの2発目: 1発目のクリックで既に最終頂点が置かれているので追加しない
      // (dblclick イベント側で確定処理する)。
      return true;
    }
    const point = pointFromEvent(event);
    if (!point) {
      return true;
    }
    const draft = state.mosaicPolygonDraft ?? [];
    if (draft.length >= 3 && distance(point, draft[0]!) < MOSAIC_CLOSE_POLYGON_THRESHOLD) {
      finalizePolygonDraft();
      return true;
    }
    state.mosaicPolygonDraft = [...draft, point];
    requestRender();
    return true;
  }

  const vertexEl = target.closest<SVGElement>("[data-mosaic-vertex]");
  if (vertexEl && state.mosaicSelectedRegionId) {
    const vertexIndex = Number(vertexEl.getAttribute("data-mosaic-vertex"));
    const shape = shapeOf(state.mosaicSelectedRegionId);
    if (!shape || shape.type !== "polygon" || !Number.isFinite(vertexIndex)) {
      return true;
    }
    event.preventDefault();
    state.mosaicSelectedVertexIndex = vertexIndex;
    vertexSession.begin(event, {
      regionId: state.mosaicSelectedRegionId,
      vertexIndex,
      startPoint: [...shape.points[vertexIndex]!] as [number, number]
    });
    requestRender();
    return true;
  }

  const edgeEl = target.closest<SVGElement>("[data-mosaic-edge]");
  if (edgeEl && state.mosaicSelectedRegionId) {
    const edgeIndex = Number(edgeEl.getAttribute("data-mosaic-edge"));
    if (Number.isFinite(edgeIndex)) {
      event.preventDefault();
      insertVertexAt(state.mosaicSelectedRegionId, edgeIndex);
    }
    return true;
  }

  const rectCornerEl = target.closest<SVGElement>("[data-mosaic-rect-corner]");
  const rectEdgeEl = target.closest<SVGElement>("[data-mosaic-rect-edge]");
  const rectHandleEl = rectCornerEl ?? rectEdgeEl;
  if (rectHandleEl && state.mosaicSelectedRegionId) {
    const kind: MosaicRectHandleKind = rectCornerEl ? "corner" : "edge";
    const index = Number(rectHandleEl.getAttribute(rectCornerEl ? "data-mosaic-rect-corner" : "data-mosaic-rect-edge"));
    const shape = shapeOf(state.mosaicSelectedRegionId);
    if (!shape || shape.type !== "rect" || !Number.isFinite(index)) {
      return true;
    }
    event.preventDefault();
    rectHandleSession.begin(event, {
      regionId: state.mosaicSelectedRegionId,
      handle: { kind, index },
      startBounds: [...shape.bounds] as [number, number, number, number]
    });
    requestRender();
    return true;
  }

  const regionEl = target.closest<SVGElement>("[data-mosaic-region-id]");
  if (regionEl) {
    event.preventDefault();
    selectRegion(regionEl.getAttribute("data-mosaic-region-id"));
    return true;
  }

  event.preventDefault();
  selectRegion(null);
  return true;
}

export function handleMosaicPointerMove(event: PointerEvent): boolean {
  return mosaicDragSessions.some((session) => session.handleMove(event));
}

export function handleMosaicPointerUp(event: PointerEvent): boolean {
  return mosaicDragSessions.some((session) => session.handleUp(event));
}

function commitRectAdd(): void {
  const draft = state.mosaicRectDraft;
  state.mosaicRectDraft = null;
  state.mosaicAddMode = null;
  if (!draft) {
    requestRender();
    return;
  }
  const x = Math.min(draft.start[0], draft.current[0]);
  const y = Math.min(draft.start[1], draft.current[1]);
  const w = Math.abs(draft.current[0] - draft.start[0]);
  const h = Math.abs(draft.current[1] - draft.start[1]);
  if (w < MOSAIC_MIN_DRAG_SIZE || h < MOSAIC_MIN_DRAG_SIZE) {
    requestRender();
    return;
  }
  const region = createRectMosaicRegion(crypto.randomUUID(), x, y, w, h);
  state.pageMosaicDraft = [...state.pageMosaicDraft, region];
  state.mosaicSelectedRegionId = region.id;
  state.mosaicSelectedVertexIndex = null;
  requestRender();
  scheduleSave();
}

export function handleMosaicPointerCancel(event: PointerEvent): boolean {
  return mosaicDragSessions.some((session) => session.handleCancel(event));
}

/** main.ts の dblclick 委譲から呼ばれる。多角形追加モード中は現在の頂点列で確定する。 */
export function handleMosaicDblClick(event: MouseEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "mosaic") {
    return false;
  }
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("[data-mosaic-stage]")) {
    return false;
  }
  if (state.mosaicAddMode === "polygon") {
    event.preventDefault();
    finalizePolygonDraft();
    return true;
  }
  // 通常編集中: 頂点ハンドルのダブルクリック = 頂点削除(P5 の頂点編集と同じ操作感)。
  const vertexEl = target.closest<SVGElement>("[data-mosaic-vertex]");
  if (vertexEl && state.mosaicSelectedRegionId) {
    const vertexIndex = Number(vertexEl.getAttribute("data-mosaic-vertex"));
    if (Number.isFinite(vertexIndex)) {
      event.preventDefault();
      removeVertexAt(state.mosaicSelectedRegionId, vertexIndex);
      return true;
    }
  }
  return false;
}

/** main.ts の keydown 委譲から呼ばれる。選択中頂点/リージョンの Delete/Backspace = 削除。 */
export function handleMosaicKeydown(event: KeyboardEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "mosaic") {
    return false;
  }
  // Esc カスケード: 追加モード(描画中の draft 含む)→ 選択解除。ここで処理しないと
  // lightbox の Escape(閉じる)まで素通りする(コマ枠モードと同じ「Esc は lightbox より前に」)。
  if (event.key === "Escape") {
    if (state.mosaicAddMode !== null || state.mosaicRectDraft || state.mosaicPolygonDraft) {
      event.preventDefault();
      state.mosaicAddMode = null;
      state.mosaicRectDraft = null;
      state.mosaicPolygonDraft = null;
      requestRender();
      return true;
    }
    if (state.mosaicSelectedRegionId !== null || state.mosaicSelectedVertexIndex !== null) {
      event.preventDefault();
      state.mosaicSelectedRegionId = null;
      state.mosaicSelectedVertexIndex = null;
      requestRender();
      return true;
    }
  }
  if ((event.key === "Delete" || event.key === "Backspace") && !isTextEntryTarget(event.target)) {
    if (state.mosaicSelectedRegionId && state.mosaicSelectedVertexIndex !== null) {
      event.preventDefault();
      removeVertexAt(state.mosaicSelectedRegionId, state.mosaicSelectedVertexIndex);
      return true;
    }
    if (state.mosaicSelectedRegionId) {
      event.preventDefault();
      deleteSelectedRegion();
      return true;
    }
  }
  return false;
}

registerActions({
  "set-mosaic-add-mode": (id) => setAddMode(id === "polygon" ? "polygon" : "rect"),
  "delete-selected-mosaic-region": () => deleteSelectedRegion()
});
