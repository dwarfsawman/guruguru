/**
 * ページオブジェクト編集(Docs/Feature-CGCollectionSuite.md P1)。ページ編集 lightbox の
 * 「オブジェクト」モードで box の追加/選択/移動/拡縮/回転/削除/z順/プロパティ変更を扱う。
 * ギズモの座標変換・ジェスチャ数学は `svgGizmo.ts`(共通・純関数)、undo/redo は
 * `pageObjectHistory.ts` を使う。保存は 1s debounce PATCH + lightbox クローズ時 flush
 * (`asset_paste_attachments` 的な「1行に配列」パターン、競合制御なし)。
 * data-action は `registerActions`、pointer drag は main.ts の委譲チェーンから呼ぶ
 * (`pagePanelLightboxController.ts` の crop 編集と同じ設計)。
 */
import {
  DEFAULT_BOX_SIZE,
  PAGE_OBJECT_MAX_SIZE,
  PAGE_OBJECT_MIN_SIZE,
  createBoxObject,
  type BoxObject,
  type PageObject
} from "../shared/pageObjects";
import {
  getStageTransform,
  gizmoRotateHandlePoint,
  moveGizmoBox,
  rotateGizmoBox,
  scaleGizmoBoxAboutCenter,
  type GizmoBox
} from "./svgGizmo";
import { pageObjectGizmoViewBounds } from "./views/pagePanelLightboxView";
import {
  createPageObjectHistory,
  pushPageObjectHistory,
  redoPageObjects,
  snapshotPageObjects,
  undoPageObjects,
  type PageObjectHistoryState
} from "./pageObjectHistory";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { isTextEntryTarget } from "./clientUtils";

// --- 保存(debounce PATCH + flush) ---

const SAVE_DEBOUNCE_MS = 1000;
let saveDebounceTimer: number | null = null;
/** 実行中の PATCH(flush が「全保存の完了」を待てるように保持する)。無ければ null。 */
let inflightSave: Promise<void> | null = null;
/** 直近の保存試行が成功したら true(閉じる時にページ一覧プレビューを最新化する目印)。 */
let objectsDirty = false;

/** lightbox を開く直前に呼ぶ(履歴・保存タイマー・dirty フラグをリセットする)。 */
export function resetPageObjectsSession(): void {
  objectHistory = createPageObjectHistory();
  objectsDirty = false;
  if (saveDebounceTimer !== null) {
    window.clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  objectDrag = null;
}

/** 未保存の変更が保留中なら true を返しつつリセットする(lightbox クローズ判定用)。 */
export function consumePageObjectsDirtyFlag(): boolean {
  const value = objectsDirty;
  objectsDirty = false;
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

/** persistPageObjects を実行し、flush が完了を待てるよう in-flight として記録する。 */
function startPersist(): Promise<void> {
  const promise = persistPageObjects().finally(() => {
    if (inflightSave === promise) {
      inflightSave = null;
    }
  });
  inflightSave = promise;
  return promise;
}

/**
 * lightbox クローズ時に呼ぶ。保留中の debounce があれば即座に保存を実行し、その完了を返す。
 * 保留が無くても実行中の PATCH があればその完了を返す(どちらも無ければ即 resolve)。
 * 呼び出し側(closePagePanelLightbox)はこの Promise の解決を待ってから dirty 判定 →
 * ページ一覧再取得を行う -- PATCH 完了前に reload すると古い `?v=` を拾うため順序厳守。
 * **state.pagePanelLightbox がまだ立っている間に呼ぶこと**(persistPageObjects は呼び出しと同期に
 * pageId/projectId/ドラフトを確定するので、その後 state をクリアしても PATCH は完走する)。
 */
export function flushPageObjectsSave(): Promise<void> {
  if (saveDebounceTimer !== null) {
    window.clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
    return startPersist();
  }
  return inflightSave ?? Promise.resolve();
}

async function persistPageObjects(): Promise<void> {
  // pageId/projectId/送信ボディは await より前(同期)に確定する。以降 state が
  // クリアされても(クローズ時 flush)この PATCH 自体は最後まで飛ぶ。
  const lightbox = state.pagePanelLightbox;
  const projectId = state.currentProjectId;
  if (!lightbox || !projectId) {
    return;
  }
  const pageId = lightbox.pageId;
  try {
    const result = await api<{ objects: PageObject[] }>(`/api/projects/${projectId}/pages/${pageId}/objects`, {
      method: "PATCH",
      body: JSON.stringify({ objects: state.pageObjectsDraft })
    });
    // 正規化済み応答をドラフトへ反映するのは「応答時点で新しい編集が何も進行していない」時だけに限定する。
    // 送信〜応答の間にユーザーが編集していた(=保存タイマーが再スケジュール済み or ドラッグ中)場合に
    // 無条件で代入すると、その編集が応答到着時に巻き戻ってしまう。閉じられた/別ページも同様に破棄。
    if (state.pagePanelLightbox?.pageId === pageId && saveDebounceTimer === null && objectDrag === null) {
      state.pageObjectsDraft = result.objects;
    }
    objectsDirty = true;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  }
}

// --- undo/redo ---

let objectHistory: PageObjectHistoryState = createPageObjectHistory();

function currentSnapshot() {
  return snapshotPageObjects(state.pageObjectsDraft, state.selectedPageObjectId);
}

function undoPageObjectsAction(): void {
  if (!state.pagePanelLightbox) {
    return;
  }
  const restored = undoPageObjects(objectHistory, currentSnapshot());
  if (!restored) {
    return;
  }
  state.pageObjectsDraft = restored.objects;
  state.selectedPageObjectId = restored.selectedId;
  requestRender();
  scheduleSave();
}

function redoPageObjectsAction(): void {
  if (!state.pagePanelLightbox) {
    return;
  }
  const restored = redoPageObjects(objectHistory, currentSnapshot());
  if (!restored) {
    return;
  }
  state.pageObjectsDraft = restored.objects;
  state.selectedPageObjectId = restored.selectedId;
  requestRender();
  scheduleSave();
}

/** main.ts の keydown 委譲から呼ばれる。lightbox がオブジェクトモードで開いている間だけ Ctrl+Z / Delete を奪う。 */
export function handlePageObjectsKeydown(event: KeyboardEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "objects") {
    return false;
  }
  // プロパティ入力欄などテキスト入力中はブラウザ標準のテキスト undo を優先する(Delete ガードと同じ)。
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !isTextEntryTarget(event.target)) {
    event.preventDefault();
    if (event.shiftKey) {
      redoPageObjectsAction();
    } else {
      undoPageObjectsAction();
    }
    return true;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && state.selectedPageObjectId && !isTextEntryTarget(event.target)) {
    event.preventDefault();
    deleteSelectedPageObject();
    return true;
  }
  return false;
}

// --- 追加/削除/z順/プロパティ ---

function findSelectedBox(): BoxObject | null {
  const id = state.selectedPageObjectId;
  if (!id) {
    return null;
  }
  const object = state.pageObjectsDraft.find((item) => item.id === id);
  return object && object.kind === "box" ? object : null;
}

function addBoxObject(): void {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "objects") {
    return;
  }
  const previous = currentSnapshot();
  const size = {
    x: Math.min(DEFAULT_BOX_SIZE.x, 0.8),
    y: Math.min(DEFAULT_BOX_SIZE.y, Math.max(PAGE_OBJECT_MIN_SIZE, lightbox.pageHeight * 0.5))
  };
  const center = { x: 0.5, y: lightbox.pageHeight / 2 };
  const object = createBoxObject(crypto.randomUUID(), center, size);
  pushPageObjectHistory(objectHistory, previous);
  state.pageObjectsDraft = [...state.pageObjectsDraft, object];
  state.selectedPageObjectId = object.id;
  requestRender();
  scheduleSave();
}

function deleteSelectedPageObject(): void {
  const id = state.selectedPageObjectId;
  if (!id) {
    return;
  }
  const previous = currentSnapshot();
  pushPageObjectHistory(objectHistory, previous);
  state.pageObjectsDraft = state.pageObjectsDraft.filter((item) => item.id !== id);
  state.selectedPageObjectId = null;
  requestRender();
  scheduleSave();
}

function reorderSelected(mutate: (objects: PageObject[], index: number) => void): void {
  const id = state.selectedPageObjectId;
  if (!id) {
    return;
  }
  const index = state.pageObjectsDraft.findIndex((item) => item.id === id);
  if (index < 0) {
    return;
  }
  const previous = currentSnapshot();
  const next = [...state.pageObjectsDraft];
  mutate(next, index);
  // 実際に順序が変わらなければ履歴・保存は不要(既に先頭/末尾)。
  if (next.every((item, i) => item.id === state.pageObjectsDraft[i]?.id)) {
    return;
  }
  pushPageObjectHistory(objectHistory, previous);
  state.pageObjectsDraft = next;
  requestRender();
  scheduleSave();
}

function bringSelectedToFront(): void {
  reorderSelected((objects, index) => {
    const [item] = objects.splice(index, 1);
    if (item) {
      objects.push(item);
    }
  });
}

function sendSelectedToBack(): void {
  reorderSelected((objects, index) => {
    const [item] = objects.splice(index, 1);
    if (item) {
      objects.unshift(item);
    }
  });
}

const CLAMPABLE_FIELDS = {
  strokeWidth: { min: 0, max: 0.2 },
  cornerRadius: { min: 0, max: PAGE_OBJECT_MAX_SIZE }
} as const;

/** main.ts の change 委譲から呼ばれる。プロパティ行(fill/strokeColor/strokeWidth/cornerRadius)の入力反映。 */
export function updatePageObjectFieldFromControl(target: HTMLInputElement): void {
  const field = target.dataset.pageObjectField;
  const object = findSelectedBox();
  if (!field || !object) {
    return;
  }
  const index = state.pageObjectsDraft.findIndex((item) => item.id === object.id);
  if (index < 0) {
    return;
  }
  const updated: BoxObject = { ...object };
  if (field === "fill") {
    updated.fill = target.value;
  } else if (field === "strokeColor") {
    updated.strokeColor = target.value;
  } else if (field === "strokeWidth" || field === "cornerRadius") {
    const range = CLAMPABLE_FIELDS[field];
    const parsed = Number(target.value);
    const clamped = Number.isFinite(parsed) ? Math.min(range.max, Math.max(range.min, parsed)) : object[field] ?? 0;
    updated[field] = clamped;
  } else {
    return;
  }
  const previous = currentSnapshot();
  pushPageObjectHistory(objectHistory, previous);
  const next = [...state.pageObjectsDraft];
  next[index] = updated;
  state.pageObjectsDraft = next;
  requestRender();
  scheduleSave();
}

// --- ギズモ(移動/拡縮/回転)ジェスチャ ---

type ObjectGestureKind = "move" | "scale" | "rotate";
const ROTATE_SNAP_RAD = Math.PI / 12;
/** ハンドルの画面基準サイズ(px)。paste/crop の前例に合わせる。 */
const GIZMO_HANDLE_SCREEN_RADIUS_PX = 7;
const GIZMO_ROTATE_STICK_SCREEN_PX = 30;

interface ObjectDragState {
  pointerId: number;
  objectId: string;
  kind: ObjectGestureKind;
  /** ジェスチャ開始直前のスナップショット(実際に変化があった時だけ history へ push する)。 */
  startSnapshot: ReturnType<typeof currentSnapshot>;
  startObject: BoxObject;
  pxPerUnit: number;
  startClientX: number;
  startClientY: number;
  centerScreenX: number;
  centerScreenY: number;
  startDist: number;
  startAngle: number;
}

let objectDrag: ObjectDragState | null = null;

/** オブジェクトモードの `<g transform="scale(1000)">` ルート(回転していない基準要素。svgGizmo.ts 参照)。 */
function stageRootElement(): SVGGraphicsElement | null {
  const el = document.getElementById("pageObjectStageRoot");
  return el instanceof SVGGraphicsElement ? el : null;
}

function toGizmoBox(object: BoxObject): GizmoBox {
  return { center: { ...object.position }, size: { ...object.size }, rotation: object.rotation };
}

function objectIdFromEventTarget(target: EventTarget | null): { objectId: string | null; handleKind: "scale" | "rotate" | null } {
  if (!(target instanceof Element)) {
    return { objectId: null, handleKind: null };
  }
  const handle = target.closest<SVGElement>("[data-page-object-handle]");
  if (handle) {
    const kind = handle.getAttribute("data-page-object-handle") === "rotate" ? "rotate" : "scale";
    return { objectId: handle.getAttribute("data-page-object-owner"), handleKind: kind };
  }
  const shape = target.closest<SVGElement>("[data-page-object]");
  if (shape) {
    return { objectId: shape.getAttribute("data-page-object"), handleKind: null };
  }
  return { objectId: null, handleKind: null };
}

/** main.ts の pointerdown 委譲から呼ばれる。ギズモハンドル/オブジェクト本体/背景を切り分ける。 */
export function handlePageObjectsPointerDown(event: PointerEvent): boolean {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "objects") {
    return false;
  }
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("[data-page-object-stage]")) {
    return false;
  }

  const { objectId, handleKind } = objectIdFromEventTarget(target);
  if (!objectId) {
    // 背景(ステージの空き領域)クリック = 選択解除。
    if (state.selectedPageObjectId) {
      state.selectedPageObjectId = null;
      requestRender();
    }
    return true;
  }

  const object = state.pageObjectsDraft.find((item) => item.id === objectId);
  if (!object || object.kind !== "box") {
    // P1 で編集対象なのは box のみ(text/balloon は将来フェーズ)。
    return true;
  }

  event.preventDefault();
  if (state.selectedPageObjectId !== objectId) {
    state.selectedPageObjectId = objectId;
    requestRender();
  }

  if (handleKind === "rotate" && event.detail >= 2) {
    // 回転ハンドルのダブルクリック = 0° リセット(paste/crop の前例踏襲)。
    commitObjectMutation(objectId, { ...object, rotation: 0 });
    return true;
  }

  beginObjectDrag(event, object, handleKind ?? "move");
  return true;
}

function beginObjectDrag(event: PointerEvent, object: BoxObject, kind: ObjectGestureKind): void {
  const root = stageRootElement();
  const stage = root ? getStageTransform(root) : null;
  if (!stage) {
    return;
  }
  const center = stage.toScreen(object.position);
  objectDrag = {
    pointerId: event.pointerId,
    objectId: object.id,
    kind,
    startSnapshot: currentSnapshot(),
    startObject: { ...object, position: { ...object.position }, size: { ...object.size } },
    pxPerUnit: stage.pxPerUnit,
    startClientX: event.clientX,
    startClientY: event.clientY,
    centerScreenX: center.x,
    centerScreenY: center.y,
    startDist: Math.hypot(event.clientX - center.x, event.clientY - center.y),
    startAngle: Math.atan2(event.clientY - center.y, event.clientX - center.x)
  };
  const captureTarget = event.target;
  if (captureTarget instanceof Element && "setPointerCapture" in captureTarget) {
    try {
      (captureTarget as unknown as { setPointerCapture(pointerId: number): void }).setPointerCapture(event.pointerId);
    } catch {
      // capture に失敗しても pointermove/up は app への委譲で届く。
    }
  }
}

export function handlePageObjectsPointerMove(event: PointerEvent): boolean {
  if (!objectDrag || event.pointerId !== objectDrag.pointerId) {
    return false;
  }
  const index = state.pageObjectsDraft.findIndex((item) => item.id === objectDrag!.objectId);
  if (index < 0) {
    objectDrag = null;
    return false;
  }
  const drag = objectDrag;
  const startBox = toGizmoBox(drag.startObject);
  let updated: BoxObject;
  if (drag.kind === "move") {
    const dx = (event.clientX - drag.startClientX) / drag.pxPerUnit;
    const dy = (event.clientY - drag.startClientY) / drag.pxPerUnit;
    const box = moveGizmoBox(startBox, dx, dy);
    updated = { ...drag.startObject, position: box.center };
  } else if (drag.kind === "scale") {
    const dist = Math.hypot(event.clientX - drag.centerScreenX, event.clientY - drag.centerScreenY);
    const factor = dist / Math.max(1, drag.startDist);
    const box = scaleGizmoBoxAboutCenter(startBox, factor, PAGE_OBJECT_MIN_SIZE, PAGE_OBJECT_MAX_SIZE);
    updated = { ...drag.startObject, size: box.size };
  } else {
    const angle = Math.atan2(event.clientY - drag.centerScreenY, event.clientX - drag.centerScreenX);
    const box = rotateGizmoBox(startBox, drag.startAngle, angle, event.shiftKey, ROTATE_SNAP_RAD);
    updated = { ...drag.startObject, rotation: box.rotation };
  }
  const next = [...state.pageObjectsDraft];
  next[index] = updated;
  state.pageObjectsDraft = next;
  requestRender();
  return true;
}

function boxUnchanged(a: BoxObject, b: BoxObject): boolean {
  return (
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.size.x === b.size.x &&
    a.size.y === b.size.y &&
    a.rotation === b.rotation
  );
}

function commitObjectMutation(objectId: string, updated: BoxObject): void {
  const index = state.pageObjectsDraft.findIndex((item) => item.id === objectId);
  if (index < 0) {
    return;
  }
  const previous = currentSnapshot();
  pushPageObjectHistory(objectHistory, previous);
  const next = [...state.pageObjectsDraft];
  next[index] = updated;
  state.pageObjectsDraft = next;
  requestRender();
  scheduleSave();
}

export function handlePageObjectsPointerUp(event: PointerEvent): boolean {
  if (!objectDrag || event.pointerId !== objectDrag.pointerId) {
    return false;
  }
  const drag = objectDrag;
  objectDrag = null;
  const current = state.pageObjectsDraft.find((item) => item.id === drag.objectId);
  if (current && current.kind === "box" && !boxUnchanged(current, drag.startObject)) {
    // 実際に動いた/拡縮/回転した時だけ history へ push + 保存する(単クリックのみは選択だけで完結)。
    pushPageObjectHistory(objectHistory, drag.startSnapshot);
    scheduleSave();
  }
  return true;
}

/** ポインタキャプチャ喪失等の異常系。ドラッグ開始前の状態へ復元する(commit しない)。 */
export function handlePageObjectsPointerCancel(event: PointerEvent): boolean {
  if (!objectDrag || event.pointerId !== objectDrag.pointerId) {
    return false;
  }
  const drag = objectDrag;
  objectDrag = null;
  state.pageObjectsDraft = drag.startSnapshot.objects;
  state.selectedPageObjectId = drag.startSnapshot.selectedId;
  requestRender();
  return true;
}

/**
 * render ループ末尾から呼ばれ、ギズモのハンドル半径・回転ハンドルの柄長を画面基準の一定サイズへ直す
 * (`syncPagePanelCropGizmo` と同型)。
 */
export function syncPageObjectsGizmo(): void {
  const gizmo = document.querySelector<SVGGElement>("#pageObjectGizmo");
  if (!gizmo) {
    return;
  }
  const ctm = gizmo.getScreenCTM();
  if (!ctm || !ctm.a) {
    return;
  }
  const unitPerPx = 1 / ctm.a;
  const radius = GIZMO_HANDLE_SCREEN_RADIUS_PX * unitPerPx;
  const stick = GIZMO_ROTATE_STICK_SCREEN_PX * unitPerPx;
  for (let i = 0; i < 4; i += 1) {
    gizmo.querySelector<SVGCircleElement>(`#pageObjectGizmoCorner${i}`)?.setAttribute("r", String(radius));
  }
  const rotateHandle = gizmo.querySelector<SVGCircleElement>("#pageObjectGizmoRotate");
  rotateHandle?.setAttribute("r", String(radius));
  const topMidX = Number(gizmo.dataset.tmx);
  const topMidY = Number(gizmo.dataset.tmy);
  const upX = Number(gizmo.dataset.upx);
  const upY = Number(gizmo.dataset.upy);
  const pageHeight = Number(gizmo.dataset.ph);
  if (![topMidX, topMidY, upX, upY, pageHeight].every(Number.isFinite)) {
    return;
  }
  // render と同じ反転ロジック(pageObjectGizmoViewBounds + gizmoRotateHandlePoint)を画面基準の柄長で
  // 再適用する -- 判定を通さず無条件に外向き配置すると、ページ上端付近でハンドルがステージ外に切れて掴めない。
  const handle = gizmoRotateHandlePoint(
    { x: topMidX, y: topMidY },
    { x: upX, y: upY },
    stick,
    pageObjectGizmoViewBounds(pageHeight)
  );
  rotateHandle?.setAttribute("cx", String(handle.x));
  rotateHandle?.setAttribute("cy", String(handle.y));
  gizmo.querySelector<SVGLineElement>("#pageObjectGizmoStick")?.setAttribute("x2", String(handle.x));
  gizmo.querySelector<SVGLineElement>("#pageObjectGizmoStick")?.setAttribute("y2", String(handle.y));
}

registerActions({
  "add-page-object-box": () => addBoxObject(),
  "delete-selected-page-object": () => deleteSelectedPageObject(),
  "page-object-bring-front": () => bringSelectedToFront(),
  "page-object-send-back": () => sendSelectedToBack(),
  "page-objects-undo": () => undoPageObjectsAction(),
  "page-objects-redo": () => redoPageObjectsAction()
});
