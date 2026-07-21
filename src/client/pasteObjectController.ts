/**
 * 画像貼り付け(Paste & Transform)の controller。
 *
 * - 取り込み: D&D / ファイル選択で画像を受け、長辺 4096 へキャップした上で
 *   `POST /api/projects/:id/paste-sources` へ永続化し、`PaintDraft.pasteObjects` に追加する。
 * - 表示: 貼り付けオブジェクトは `#pasteCanvas`(opacity 1、pointer-events: none)に
 *   z順で描画する。真実は draft(メタデータ)+ `pasteBitmapCache`(ビットマップ)で、
 *   domMorph が canvas を消しても毎 render 後の `syncAssetModalPasteObjects()` が復元する。
 * - 永続化: オブジェクト操作の確定ごとに debounce PUT で
 *   `PUT /api/assets/:id/paste-attachments` へ保存し、モーダルオープン時に GET で復元する。
 *
 * 元画像アセットは一切変更しない「エッジに添付」モデル(Docs/Feature-ImagePaste.md)。
 * taint 安全: 取り込みは必ず File/Blob/same-origin fetch → decode の経路のみ。
 * 本 module は `main.ts` を import しない(circular import なし)。
 */
import { pushToast, dismissToast, requestRender, state } from "./appState";
import { createDragSession } from "./dragSession";
import { registerActions, registerEventBinder } from "./actionRegistry";
import { api } from "./api";
import {
  ensurePaintDraft,
  paintDraftForAsset,
  paintLayerCache,
  pushPaintObjectsHistory,
  setPaintDraft,
  setPasteAttachmentsPersistHook,
  setPasteLayersProvider,
  undoPaintStroke
} from "./paintEditorController";
import { composePaintResultCanvas, type ComposedPasteLayer } from "./paintCanvas";
import type { PaintDraft } from "./paintTypes";
import { isTextEntryTarget } from "./clientUtils";
import type { Asset } from "../shared/apiTypes";
import { commitActiveMaskCanvas } from "./maskEditorController";
import { pointerToMaskCanvasPoint } from "./maskCanvas";
import { assetDimension, findAsset } from "./assetLookup";
import { formatCssNumber } from "./format";
import {
  applyMoveGesture,
  applyRotateGesture,
  applyScaleGesture,
  clampPasteTransform,
  fitInitialPasteTransform,
  hitTestPastedObjects,
  nudgeTransform,
  pastedObjectBounds,
  pastedObjectCorners,
  unionPasteBounds,
  type PasteBounds,
  type PasteGestureKind
} from "./pasteTransform";
import { localToWorld } from "./pasteTransform";
import {
  PASTE_HANDLE_SCREEN_RADIUS,
  PASTE_ROTATE_STICK_NATURAL,
  rotateHandlePosition
} from "./views/pasteGizmo";
import {
  PASTE_MAX_OBJECTS,
  PASTE_MAX_SOURCE_DIMENSION,
  type PastedObject,
  type PasteTransform
} from "../shared/pasteAttachments";

/** sourceId → デコード済みビットマップ(offscreen canvas)。morph の外に置く。 */
export const pasteBitmapCache = new Map<string, HTMLCanvasElement>();
/** サーバから添付を復元済みの assetId(セッション中はクライアント状態が真実)。 */
const loadedAttachmentAssetIds = new Set<string>();
/** 取得中の sourceId(多重 fetch 防止)。 */
const loadingSourceIds = new Set<string>();
/** モード自動切替直後で #paintCanvas が未サイズだった場合の配置持ち越し。 */
let pendingPlacement: { assetId: string; objectId: string; clientX: number; clientY: number } | null = null;

const PASTE_ACCEPTED_MIME = ["image/png", "image/jpeg", "image/webp"];
const PASTE_UNSUPPORTED_FORMAT_MESSAGE = "対応していない画像形式です(PNG / JPEG / WebP)。";
/** サーバ側 maxSourceImageBytes(uploadDataUrl.ts の 16MB)と同値のクライアント側プリフライト。 */
const PASTE_MAX_DATA_URL_LENGTH = Math.ceil(16 * 1024 * 1024 * 1.4) + 128;
const PASTE_LOADING_TOAST_DELAY_MS = 150;
const PASTE_PUT_DEBOUNCE_MS = 800;

// --- 永続化(debounce PUT) ------------------------------------------------

const pendingPutTimers = new Map<string, number>();

/** オブジェクト操作の確定ごとに呼ぶ。debounce 後に PUT で保存する。 */
export function schedulePasteAttachmentsPut(assetId: string) {
  const existing = pendingPutTimers.get(assetId);
  if (existing !== undefined) {
    window.clearTimeout(existing);
  }
  const timer = window.setTimeout(() => {
    pendingPutTimers.delete(assetId);
    void putPasteAttachments(assetId);
  }, PASTE_PUT_DEBOUNCE_MS);
  pendingPutTimers.set(assetId, timer);
}

/** モーダル close 等で保留中の PUT を即時送信する。 */
export function flushPasteAttachmentsPut(assetId?: string | null) {
  for (const [pendingAssetId, timer] of [...pendingPutTimers]) {
    if (assetId && pendingAssetId !== assetId) {
      continue;
    }
    window.clearTimeout(timer);
    pendingPutTimers.delete(pendingAssetId);
    void putPasteAttachments(pendingAssetId);
  }
}

async function putPasteAttachments(assetId: string) {
  const draft = paintDraftForAsset(assetId);
  if (!draft) {
    return;
  }
  try {
    await api(`/api/assets/${assetId}/paste-attachments`, {
      method: "PUT",
      body: JSON.stringify({ objects: draft.pasteObjects, enabled: draft.pasteEnabled })
    });
  } catch (error) {
    pushToast(`貼り付けの保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

// --- 復元(GET + ソース画像ロード) ----------------------------------------

function ensureAttachmentsLoaded(assetId: string) {
  if (loadedAttachmentAssetIds.has(assetId)) {
    return;
  }
  loadedAttachmentAssetIds.add(assetId);
  void (async () => {
    try {
      const response = await api<{ objects: PastedObject[]; enabled: boolean }>(`/api/assets/${assetId}/paste-attachments`);
      if (response.objects.length === 0) {
        return;
      }
      const draft = ensurePaintDraft(assetId);
      // このセッションで既に編集が始まっている場合はクライアント状態を優先する。
      if (draft.pasteObjects.length > 0) {
        return;
      }
      setPaintDraft({ ...draft, pasteObjects: response.objects, pasteEnabled: response.enabled });
      requestRender();
    } catch (error) {
      loadedAttachmentAssetIds.delete(assetId);
      pushToast(`貼り付けの読み込みに失敗しました: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  })();
}

function ensureSourceBitmap(sourceId: string) {
  if (pasteBitmapCache.has(sourceId) || loadingSourceIds.has(sourceId) || !state.currentProjectId) {
    return;
  }
  loadingSourceIds.add(sourceId);
  const projectId = state.currentProjectId;
  void (async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/paste-sources/${sourceId}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const canvas = await decodeBlobToCanvas(blob);
      pasteBitmapCache.set(sourceId, canvas);
      requestRender();
    } catch (error) {
      pushToast(`貼り付け画像の取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      loadingSourceIds.delete(sourceId);
    }
  })();
}

// --- 描画 sync -------------------------------------------------------------

/**
 * 毎 render 後(`syncAssetModalPaintCanvas` の直後)に呼ばれ、`#pasteCanvas` を
 * natural size に設定して添付オブジェクトを z順で描き直す。
 * domMorph の width/height 属性剥がしによる canvas 消去はこの sync 一本で吸収する。
 */
export function syncAssetModalPasteObjects() {
  const canvas = document.querySelector<HTMLCanvasElement>("#pasteCanvas");
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  if (!canvas || !image) {
    return;
  }
  const assetId = canvas.dataset.assetId;
  if (!assetId) {
    return;
  }
  ensureAttachmentsLoaded(assetId);

  const sync = () => {
    const asset = findAsset(assetId);
    const width = image.naturalWidth || assetDimension(asset, "width") || Math.max(1, Math.round(image.clientWidth));
    const height = image.naturalHeight || assetDimension(asset, "height") || Math.max(1, Math.round(image.clientHeight));
    if (!width || !height) {
      return;
    }
    if (canvas.width !== width) {
      canvas.width = width;
    }
    if (canvas.height !== height) {
      canvas.height = height;
    }
    applyPendingPlacement(canvas, assetId);
    renderPasteObjectsToCanvas(canvas, assetId);
    syncPasteGizmo();
  };

  if (image.complete && image.naturalWidth > 0) {
    sync();
  } else {
    image.addEventListener("load", sync, { once: true });
  }
}

function applyPendingPlacement(canvas: HTMLCanvasElement, assetId: string) {
  if (!pendingPlacement || pendingPlacement.assetId !== assetId) {
    return;
  }
  const { objectId, clientX, clientY } = pendingPlacement;
  pendingPlacement = null;
  const draft = paintDraftForAsset(assetId);
  const target = draft?.pasteObjects.find((object) => object.id === objectId);
  if (!draft || !target) {
    return;
  }
  const point = pointerToMaskCanvasPoint(canvas, { clientX, clientY } as PointerEvent);
  const transform = clampPasteTransform(
    { ...target.transform, x: point.x, y: point.y },
    target.sourceWidth,
    target.sourceHeight,
    canvas.width,
    canvas.height
  );
  setPaintDraft({
    ...draft,
    pasteObjects: draft.pasteObjects.map((object) => (object.id === objectId ? { ...object, transform } : object))
  });
  schedulePasteAttachmentsPut(assetId);
}

/**
 * `#pasteCanvas` へ draft の全オブジェクトを描く。ビットマップ未ロード分はプレースホルダ矩形。
 * `dirtyRect` を渡すとその矩形にクリップして再描画する(ジェスチャ中の高速パス)。
 * `overrideTransform` はジェスチャ中の未確定変形(draft を触らず見た目だけ更新)。
 */
export function renderPasteObjectsToCanvas(
  canvas: HTMLCanvasElement,
  assetId: string,
  dirtyRect?: PasteBounds,
  overrideTransform?: { objectId: string; transform: PasteTransform }
) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.save();
  if (dirtyRect) {
    const x = Math.max(0, Math.floor(dirtyRect.x));
    const y = Math.max(0, Math.floor(dirtyRect.y));
    const width = Math.min(canvas.width, Math.ceil(dirtyRect.x + dirtyRect.width)) - x;
    const height = Math.min(canvas.height, Math.ceil(dirtyRect.y + dirtyRect.height)) - y;
    if (width <= 0 || height <= 0) {
      context.restore();
      return;
    }
    context.beginPath();
    context.rect(x, y, width, height);
    context.clip();
    context.clearRect(x, y, width, height);
  } else {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
  const draft = paintDraftForAsset(assetId);
  if (!draft || draft.pasteObjects.length === 0) {
    context.restore();
    return;
  }
  for (const object of draft.pasteObjects) {
    const transform = overrideTransform && overrideTransform.objectId === object.id
      ? overrideTransform.transform
      : object.transform;
    drawPastedObject(context, object, transform);
  }
  context.restore();
}

/** 1 オブジェクトを natural 座標系の 2D context へ描く(未ロード分はプレースホルダ+lazy fetch)。 */
function drawPastedObject(context: CanvasRenderingContext2D, object: PastedObject, transform: PasteTransform) {
  const bitmap = pasteBitmapCache.get(object.sourceId);
  context.save();
  context.translate(transform.x, transform.y);
  context.rotate(transform.rotation);
  context.scale(transform.scaleX, transform.scaleY);
  if (bitmap) {
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, -object.sourceWidth / 2, -object.sourceHeight / 2);
  } else {
    ensureSourceBitmap(object.sourceId);
    context.strokeStyle = "rgba(160, 160, 160, 0.9)";
    context.setLineDash([8, 6]);
    context.lineWidth = 2;
    context.strokeRect(-object.sourceWidth / 2, -object.sourceHeight / 2, object.sourceWidth, object.sourceHeight);
  }
  context.restore();
}

// --- グリッド(Round グリッド)のプレビュー合成 --------------------------------

/**
 * グリッドタイル表示用の貼り付けオブジェクト一覧。
 * このセッションで編集済み(ロード済み)ならクライアント draft が真実、
 * 未ロードならプロジェクト詳細に同梱されたサーバ永続値(detail.pasteAttachments)を使う。
 */
export function pasteObjectsForGridAsset(assetId: string): PastedObject[] {
  const draft = paintDraftForAsset(assetId);
  if (draft && (loadedAttachmentAssetIds.has(assetId) || draft.pasteObjects.length > 0)) {
    return draft.pasteObjects;
  }
  return state.detail?.pasteAttachments?.[assetId]?.objects ?? [];
}

/**
 * グリッドの PASTE バッジの ON/OFF 状態。`pasteObjectsForGridAsset` と同じ優先順位
 * (セッションで編集済みならクライアント draft、未ロードなら detail.pasteAttachments)。
 */
export function pasteEnabledForGridAsset(assetId: string): boolean {
  const draft = paintDraftForAsset(assetId);
  if (draft && (loadedAttachmentAssetIds.has(assetId) || draft.pasteObjects.length > 0)) {
    return draft.pasteEnabled;
  }
  return state.detail?.pasteAttachments?.[assetId]?.enabled ?? true;
}

/**
 * まだセッションで編集されていないアセットの draft を、detail.pasteAttachments の
 * 永続値(objects + enabled)で materialize する。PASTE バッジはモーダルを開いていない
 * グリッド上のアセットも直接トグルできる必要があるため、その書き込み先を用意する。
 */
function materializedPasteDraftForToggle(assetId: string): PaintDraft {
  const existing = paintDraftForAsset(assetId);
  if (existing && (loadedAttachmentAssetIds.has(assetId) || existing.pasteObjects.length > 0)) {
    return existing;
  }
  const fallback = state.detail?.pasteAttachments?.[assetId];
  const draft = ensurePaintDraft(assetId);
  if (!fallback) {
    return draft;
  }
  const materialized: PaintDraft = { ...draft, pasteObjects: fallback.objects, pasteEnabled: fallback.enabled };
  setPaintDraft(materialized);
  loadedAttachmentAssetIds.add(assetId);
  return materialized;
}

/** グリッドの PASTE バッジ用の添付トグル。データ(位置・変形・ソース画像)自体は保持したまま enabled だけ切り替える。 */
export function togglePasteEnabledForAsset(assetId: string) {
  const draft = materializedPasteDraftForToggle(assetId);
  if (draft.pasteObjects.length === 0) {
    return;
  }
  setPaintDraft({ ...draft, pasteEnabled: !draft.pasteEnabled });
  schedulePasteAttachmentsPut(assetId);
  requestRender();
}

/**
 * 毎 render 後に、グリッドの `.paste-grid-canvas`(タイルの <img> に重ねる合成面)を
 * natural size で描き直す。canvas は <img> と同じ intrinsic size + object-fit: cover
 * なのでクロップが一致する。ビットマップは lazy fetch(ロード完了で requestRender)。
 */
export function syncGridPasteCanvases() {
  const canvases = document.querySelectorAll<HTMLCanvasElement>(".paste-grid-canvas");
  canvases.forEach((canvas) => {
    const assetId = canvas.dataset.assetId;
    if (!assetId) {
      return;
    }
    const asset = findAsset(assetId);
    const width = assetDimension(asset, "width");
    const height = assetDimension(asset, "height");
    if (!width || !height) {
      return;
    }
    if (canvas.width !== width) {
      canvas.width = width;
    }
    if (canvas.height !== height) {
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.clearRect(0, 0, width, height);
    for (const object of pasteObjectsForGridAsset(assetId)) {
      drawPastedObject(context, object, object.transform);
    }
  });
}

// --- 選択・変形ジェスチャ -----------------------------------------------------

const PASTE_DRAG_THRESHOLD_PX = 3;
const PASTE_DIRTY_RECT_MARGIN = 4;

interface PasteGestureData {
  kind: PasteGestureKind;
  assetId: string;
  objectId: string;
  startPoint: { x: number; y: number };
  startClient: { x: number; y: number };
  startTransform: PasteTransform;
  currentTransform: PasteTransform;
  shiftKey: boolean;
  moved: boolean;
}

// pointerId 照合・setPointerCapture/release・up/cancel でのクリアは createDragSession(dragSession.ts)へ委譲。
const pasteSession = createDragSession<PasteGestureData>({
  onMove: (event, gesture) => {
    event.preventDefault();
    updatePasteGestureTransform(event, gesture);
  },
  onCommit: (event, gesture) => {
    event.preventDefault();
    endPasteGesture(gesture, true);
  },
  onCancel: (_event, gesture) => {
    endPasteGesture(gesture, false);
  }
});
let pasteGestureRafHandle: number | null = null;
let pasteGesturePrevBounds: PasteBounds | null = null;

function activePasteCanvases(): { paintCanvas: HTMLCanvasElement; pasteCanvas: HTMLCanvasElement } | null {
  const paintCanvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
  const pasteCanvas = document.querySelector<HTMLCanvasElement>("#pasteCanvas");
  if (!paintCanvas || !pasteCanvas) {
    return null;
  }
  return { paintCanvas, pasteCanvas };
}

function selectedPastedObject(draft: ReturnType<typeof paintDraftForAsset>): PastedObject | null {
  if (!draft || !draft.selectedPasteObjectId) {
    return null;
  }
  return draft.pasteObjects.find((object) => object.id === draft.selectedPasteObjectId) ?? null;
}

function beginPasteGesture(
  event: PointerEvent,
  kind: PasteGestureKind,
  assetId: string,
  object: PastedObject,
  paintCanvas: HTMLCanvasElement,
  captureTarget: Element | null
) {
  const point = pointerToMaskCanvasPoint(paintCanvas, event);
  pasteSession.begin(
    event,
    {
      kind,
      assetId,
      objectId: object.id,
      startPoint: point,
      startClient: { x: event.clientX, y: event.clientY },
      startTransform: { ...object.transform },
      currentTransform: { ...object.transform },
      shiftKey: event.shiftKey,
      moved: false
    },
    captureTarget
  );
  pasteGesturePrevBounds = pastedObjectBounds(object, PASTE_DIRTY_RECT_MARGIN);
}

function updatePasteGestureTransform(event: PointerEvent, gesture: PasteGestureData) {
  const canvases = activePasteCanvases();
  if (!canvases) {
    return;
  }
  const draft = paintDraftForAsset(gesture.assetId);
  const object = draft?.pasteObjects.find((entry) => entry.id === gesture.objectId);
  if (!object) {
    return;
  }
  const point = pointerToMaskCanvasPoint(canvases.paintCanvas, event);
  gesture.shiftKey = event.shiftKey;
  if (!gesture.moved) {
    const movedPx = Math.hypot(event.clientX - gesture.startClient.x, event.clientY - gesture.startClient.y);
    if (movedPx < PASTE_DRAG_THRESHOLD_PX) {
      return;
    }
    gesture.moved = true;
  }
  let next: PasteTransform;
  if (gesture.kind === "move") {
    next = applyMoveGesture(gesture.startTransform, gesture.startPoint, point, gesture.shiftKey);
  } else if (gesture.kind === "scale") {
    next = applyScaleGesture(gesture.startTransform, gesture.startPoint, point, gesture.shiftKey);
  } else {
    next = applyRotateGesture(gesture.startTransform, gesture.startPoint, point, gesture.shiftKey);
  }
  gesture.currentTransform = clampPasteTransform(
    next,
    object.sourceWidth,
    object.sourceHeight,
    canvases.pasteCanvas.width,
    canvases.pasteCanvas.height
  );
  schedulePasteGestureFlush();
}

function schedulePasteGestureFlush() {
  if (pasteGestureRafHandle !== null) {
    return;
  }
  pasteGestureRafHandle = requestAnimationFrame(() => {
    pasteGestureRafHandle = null;
    flushPasteGestureFrame();
  });
}

/** ジェスチャ中の 1 フレーム描画。render() を経由せず canvas dirtyRect + SVG 属性を直接更新する。 */
function flushPasteGestureFrame() {
  const gesture = pasteSession.data;
  const canvases = activePasteCanvases();
  if (!gesture || !canvases) {
    return;
  }
  const draft = paintDraftForAsset(gesture.assetId);
  const object = draft?.pasteObjects.find((entry) => entry.id === gesture.objectId);
  if (!object) {
    return;
  }
  const preview: PastedObject = { ...object, transform: gesture.currentTransform };
  const nextBounds = pastedObjectBounds(preview, PASTE_DIRTY_RECT_MARGIN);
  const dirty = unionPasteBounds(pasteGesturePrevBounds ? [pasteGesturePrevBounds, nextBounds] : [nextBounds]);
  pasteGesturePrevBounds = nextBounds;
  renderPasteObjectsToCanvas(canvases.pasteCanvas, gesture.assetId, dirty ?? undefined, {
    objectId: gesture.objectId,
    transform: gesture.currentTransform
  });
  updatePasteGizmoGeometry(preview);
  updatePasteReadout(gesture.currentTransform);
}

/** モード離脱等、pointer イベント外からの強制終了(commit=false が基本)。capture 解放はセッション側。 */
function finishPasteGesture(commit: boolean) {
  const gesture = pasteSession.data;
  pasteSession.reset();
  if (!gesture) {
    if (pasteGestureRafHandle !== null) {
      cancelAnimationFrame(pasteGestureRafHandle);
      pasteGestureRafHandle = null;
    }
    pasteGesturePrevBounds = null;
    return;
  }
  endPasteGesture(gesture, commit);
}

/** ジェスチャ終了の実体(up=commit / cancel・強制終了=破棄)。セッションはクリア済みで呼ばれる。 */
function endPasteGesture(gesture: PasteGestureData, commit: boolean) {
  if (pasteGestureRafHandle !== null) {
    cancelAnimationFrame(pasteGestureRafHandle);
    pasteGestureRafHandle = null;
  }
  pasteGesturePrevBounds = null;
  const draft = paintDraftForAsset(gesture.assetId);
  if (!draft) {
    return;
  }
  if (commit && gesture.moved) {
    pushPaintObjectsHistory(gesture.assetId, draft.pasteObjects, draft.selectedPasteObjectId);
    setPaintDraft({
      ...draft,
      pasteObjects: draft.pasteObjects.map((object) =>
        object.id === gesture.objectId ? { ...object, transform: gesture.currentTransform } : object
      )
    });
    schedulePasteAttachmentsPut(gesture.assetId);
  }
  requestRender();
}

/** ダブルクリック時、直前クリック(detail 1)で描かれたブラシ/消しゴムの点を取り消す。 */
function undoAccidentalStrokeBeforeReselect(tool: string) {
  if (tool === "brush" || tool === "eraser") {
    undoPaintStroke();
  }
}

function selectPastedObject(assetId: string, objectId: string | null, switchToSelectTool = false) {
  const draft = ensurePaintDraft(assetId);
  setPaintDraft({
    ...draft,
    selectedPasteObjectId: objectId,
    tool: switchToSelectTool ? "select" : draft.tool
  });
  requestRender();
}

/**
 * main.ts の pointerdown 分岐チェーンから `handlePaintEditorPointerDown` の直前に呼ばれる。
 * true を返した場合、呼び出し側は以降の分岐を処理しない(既存の early return 規約)。
 */
export function handlePastePointerDown(event: PointerEvent, target: HTMLElement): boolean {
  if (!state.paintEditMode || !state.activeAssetId) {
    return false;
  }
  const assetId = state.activeAssetId;
  const canvases = activePasteCanvases();

  // 1. ギズモハンドル(スケール/回転)
  const handle = target.closest<HTMLElement>("[data-paste-handle]");
  if (handle && event.button === 0 && canvases) {
    const draft = paintDraftForAsset(assetId);
    const selected = selectedPastedObject(draft);
    if (!selected) {
      return true;
    }
    event.preventDefault();
    const kind: PasteGestureKind = handle.dataset.pasteHandle === "rotate" ? "rotate" : "scale";
    if (kind === "rotate" && event.detail >= 2) {
      // 回転ハンドルのダブルクリック = 0° リセット
      const draft2 = paintDraftForAsset(assetId);
      if (draft2) {
        pushPaintObjectsHistory(assetId, draft2.pasteObjects, draft2.selectedPasteObjectId);
        setPaintDraft({
          ...draft2,
          pasteObjects: draft2.pasteObjects.map((object) =>
            object.id === selected.id ? { ...object, transform: { ...object.transform, rotation: 0 } } : object
          )
        });
        schedulePasteAttachmentsPut(assetId);
        requestRender();
      }
      return true;
    }
    beginPasteGesture(event, kind, assetId, selected, canvases.paintCanvas, handle);
    return true;
  }

  if (target.id !== "paintCanvas" || !canvases || event.button !== 0) {
    return false;
  }
  const draft = paintDraftForAsset(assetId);
  if (!draft) {
    return false;
  }
  const point = pointerToMaskCanvasPoint(canvases.paintCanvas, event);
  const hit = hitTestPastedObjects(draft.pasteObjects, point);

  // 2. 任意ツールからのダブルクリック再選択(1 クリック目のブラシ点は undo で巻き戻す)
  if (event.detail >= 2 && hit && draft.tool !== "select") {
    event.preventDefault();
    undoAccidentalStrokeBeforeReselect(draft.tool);
    selectPastedObject(assetId, hit.id, true);
    return true;
  }

  // 3. select ツール: クリックで選択+移動開始、空き領域で選択解除
  if (draft.tool !== "select") {
    return false;
  }
  event.preventDefault();
  if (!hit) {
    if (draft.selectedPasteObjectId) {
      selectPastedObject(assetId, null);
    }
    return true;
  }
  if (draft.selectedPasteObjectId !== hit.id) {
    selectPastedObject(assetId, hit.id);
  }
  beginPasteGesture(event, "move", assetId, hit, canvases.paintCanvas, canvases.paintCanvas);
  return true;
}

export function handlePastePointerMove(event: PointerEvent): boolean {
  if (pasteSession.handleMove(event)) {
    return true;
  }
  // ジェスチャ進行中は別ポインタの move も飲み込む(従来挙動を維持)。
  return pasteSession.data !== null;
}

export function handlePastePointerUp(event: PointerEvent): boolean {
  return pasteSession.handleUp(event);
}

export function handlePastePointerCancel(event: PointerEvent): boolean {
  return pasteSession.handleCancel(event);
}

/**
 * main.ts の keydown チェーンから `handlePaintEditorKeydown` の直前に呼ばれる。
 * Delete/Backspace = 選択オブジェクト削除、矢印 = ナッジ(Shift で 10px)。
 */
export function handlePasteKeydown(event: KeyboardEvent): boolean {
  if (!state.paintEditMode || !state.activeAssetId) {
    return false;
  }
  const assetId = state.activeAssetId;
  const draft = paintDraftForAsset(assetId);
  const selected = selectedPastedObject(draft);
  if (!draft || !selected) {
    return false;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    deleteSelectedPastedObject(assetId);
    return true;
  }
  const arrowDelta: Record<string, { x: number; y: number }> = {
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 }
  };
  const delta = arrowDelta[event.key];
  if (delta) {
    event.preventDefault();
    pushNudgeHistoryOncePerBurst(assetId, draft);
    const step = event.shiftKey ? 10 : 1;
    const canvases = activePasteCanvases();
    const nudged = nudgeTransform(selected.transform, delta.x * step, delta.y * step);
    const clamped = canvases
      ? clampPasteTransform(nudged, selected.sourceWidth, selected.sourceHeight, canvases.pasteCanvas.width, canvases.pasteCanvas.height)
      : nudged;
    setPaintDraft({
      ...draft,
      pasteObjects: draft.pasteObjects.map((object) =>
        object.id === selected.id ? { ...object, transform: clamped } : object
      )
    });
    schedulePasteAttachmentsPut(assetId);
    requestRender();
    return true;
  }
  return false;
}

/** Escape カスケード(main.ts)から呼ばれる。選択があれば解除して true。 */
export function deselectPasteObjectIfAny(): boolean {
  const assetId = state.activeAssetId;
  if (!state.paintEditMode || !assetId) {
    return false;
  }
  const draft = paintDraftForAsset(assetId);
  if (!draft?.selectedPasteObjectId) {
    return false;
  }
  finishPasteGesture(false);
  selectPastedObject(assetId, null);
  return true;
}

export function deleteSelectedPastedObject(assetId: string) {
  const draft = paintDraftForAsset(assetId);
  const selected = selectedPastedObject(draft);
  if (!draft || !selected) {
    return;
  }
  finishPasteGesture(false);
  pushPaintObjectsHistory(assetId, draft.pasteObjects, draft.selectedPasteObjectId);
  setPaintDraft({
    ...draft,
    pasteObjects: draft.pasteObjects.filter((object) => object.id !== selected.id),
    selectedPasteObjectId: null
  });
  schedulePasteAttachmentsPut(assetId);
  requestRender();
}

/** 矢印キー連打で undo エントリが溢れないよう、1 秒空いた最初のナッジだけ履歴に積む。 */
let lastNudgeHistoryAt = 0;
function pushNudgeHistoryOncePerBurst(assetId: string, draft: NonNullable<ReturnType<typeof paintDraftForAsset>>) {
  const now = Date.now();
  if (now - lastNudgeHistoryAt > 1000) {
    pushPaintObjectsHistory(assetId, draft.pasteObjects, draft.selectedPasteObjectId);
  }
  lastNudgeHistoryAt = now;
}

// --- オブジェクト操作(パネルの操作行) ---------------------------------------

function duplicateSelectedPastedObject(assetId: string) {
  const draft = paintDraftForAsset(assetId);
  const selected = selectedPastedObject(draft);
  if (!draft || !selected) {
    return;
  }
  if (draft.pasteObjects.length >= PASTE_MAX_OBJECTS) {
    pushToast(`貼り付けは 1 画像あたり最大 ${PASTE_MAX_OBJECTS} 件までです。`, "error");
    return;
  }
  pushPaintObjectsHistory(assetId, draft.pasteObjects, draft.selectedPasteObjectId);
  const copy: PastedObject = {
    ...selected,
    id: crypto.randomUUID(),
    transform: { ...selected.transform, x: selected.transform.x + 16, y: selected.transform.y + 16 }
  };
  setPaintDraft({
    ...draft,
    pasteObjects: [...draft.pasteObjects, copy],
    selectedPasteObjectId: copy.id
  });
  schedulePasteAttachmentsPut(assetId);
  requestRender();
}

/** z順の 1 段移動(direction: 1 = 前面へ / -1 = 背面へ)。配列順 = z順(末尾が最前面)。 */
function reorderSelectedPastedObject(assetId: string, direction: 1 | -1) {
  const draft = paintDraftForAsset(assetId);
  const selected = selectedPastedObject(draft);
  if (!draft || !selected) {
    return;
  }
  const index = draft.pasteObjects.findIndex((object) => object.id === selected.id);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= draft.pasteObjects.length) {
    return;
  }
  pushPaintObjectsHistory(assetId, draft.pasteObjects, draft.selectedPasteObjectId);
  const objects = [...draft.pasteObjects];
  const [moved] = objects.splice(index, 1);
  objects.splice(nextIndex, 0, moved!);
  setPaintDraft({ ...draft, pasteObjects: objects });
  schedulePasteAttachmentsPut(assetId);
  requestRender();
}

// --- ギズモ sync -------------------------------------------------------------

/**
 * 毎 render 後 + ジェスチャ中に、ギズモの枠・ハンドル位置とハンドル半径
 * (画面基準一定サイズ)を再計算して SVG 属性へ反映する。
 */
export function syncPasteGizmo() {
  const svg = document.querySelector<SVGSVGElement>("#pasteGizmoOverlay");
  if (!svg) {
    return;
  }
  const assetId = svg.dataset.assetId;
  const objectId = svg.dataset.objectId;
  const draft = assetId ? paintDraftForAsset(assetId) : null;
  const object = draft?.pasteObjects.find((entry) => entry.id === objectId);
  if (!object) {
    return;
  }
  const gesture = pasteSession.data;
  if (gesture && gesture.objectId === object.id) {
    updatePasteGizmoGeometry({ ...object, transform: gesture.currentTransform });
  } else {
    updatePasteGizmoGeometry(object);
  }
}

/** wheel zoom tick(render を経ない)中のハンドルサイズ補正。main.ts の wheel ハンドラから呼ぶ。 */
export function syncPasteGizmoScale() {
  syncPasteGizmo();
}

function updatePasteGizmoGeometry(object: PastedObject) {
  const svg = document.querySelector<SVGSVGElement>("#pasteGizmoOverlay");
  const pasteCanvas = document.querySelector<HTMLCanvasElement>("#pasteCanvas");
  if (!svg || !pasteCanvas) {
    return;
  }
  const corners = pastedObjectCorners(object);
  const outline = svg.querySelector<SVGPolygonElement>("#pasteGizmoOutline");
  outline?.setAttribute("points", corners.map((corner) => `${corner.x},${corner.y}`).join(" "));

  // 画面基準の一定サイズへ換算(natural px = 画面 px × canvas.width / rect.width)。
  const rect = pasteCanvas.getBoundingClientRect();
  const naturalPerScreen = rect.width > 0 ? pasteCanvas.width / rect.width : 1;
  const radius = PASTE_HANDLE_SCREEN_RADIUS * naturalPerScreen;
  corners.forEach((corner, index) => {
    const handle = svg.querySelector<SVGCircleElement>(`#pasteGizmoCorner${index}`);
    handle?.setAttribute("cx", formatCssNumber(corner.x));
    handle?.setAttribute("cy", formatCssNumber(corner.y));
    handle?.setAttribute("r", formatCssNumber(radius));
  });
  const stickNatural = PASTE_ROTATE_STICK_NATURAL * naturalPerScreen;
  const rotatePos = rotateHandlePosition(object, stickNatural);
  const topMid = localToWorld(object.transform, { x: 0, y: -object.sourceHeight / 2 });
  const stick = svg.querySelector<SVGLineElement>("#pasteGizmoRotateStick");
  stick?.setAttribute("x1", formatCssNumber(topMid.x));
  stick?.setAttribute("y1", formatCssNumber(topMid.y));
  stick?.setAttribute("x2", formatCssNumber(rotatePos.x));
  stick?.setAttribute("y2", formatCssNumber(rotatePos.y));
  const rotateHandle = svg.querySelector<SVGCircleElement>("#pasteGizmoRotateHandle");
  rotateHandle?.setAttribute("cx", formatCssNumber(rotatePos.x));
  rotateHandle?.setAttribute("cy", formatCssNumber(rotatePos.y));
  rotateHandle?.setAttribute("r", formatCssNumber(radius));
}

/** パネルのスケール%・回転角読み出し(ジェスチャ中は render を経ず直接更新)。 */
function updatePasteReadout(transform: PasteTransform) {
  const scaleTarget = document.querySelector<HTMLElement>("#pasteScaleValue");
  const rotationTarget = document.querySelector<HTMLElement>("#pasteRotationValue");
  if (scaleTarget) {
    scaleTarget.textContent = `${Math.round(transform.scaleX * 100)}%`;
  }
  if (rotationTarget) {
    const degrees = Math.round(((transform.rotation * 180) / Math.PI) % 360);
    rotationTarget.textContent = `${degrees}°`;
  }
}

// --- 取り込み ---------------------------------------------------------------

function isAcceptedImageBlob(blob: Blob): boolean {
  return PASTE_ACCEPTED_MIME.includes(blob.type);
}

/** blob をデコードし、長辺 PASTE_MAX_SOURCE_DIMENSION へキャップした offscreen canvas を返す。 */
async function decodeBlobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const draw = (source: CanvasImageSource, width: number, height: number) => {
    const scale = Math.min(1, PASTE_MAX_SOURCE_DIMENSION / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas 2D context is unavailable");
    }
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  };

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      const canvas = draw(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
      return canvas;
    } catch {
      // 一部形式で createImageBitmap が失敗する環境向けに <img> フォールバックへ。
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolvePromise, rejectPromise) => {
      const element = new Image();
      element.onload = () => resolvePromise(element);
      element.onerror = () => rejectPromise(new Error("画像のデコードに失敗しました"));
      element.src = url;
    });
    return draw(image, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const reader = new FileReader();
    reader.onload = () => resolvePromise(String(reader.result));
    reader.onerror = () => rejectPromise(new Error("画像の読み込みに失敗しました"));
    reader.readAsDataURL(blob);
  });
}

/**
 * マスク編集中/非編集中でもペイント編集へ自動切替して select ツールにする。
 * InpaintDraft・マスクレイヤーは維持される(既存の相互排他遷移と同じ)。
 */
function switchToPasteEditing(assetId: string): void {
  const wasMaskEditing = state.maskEditMode;
  if (wasMaskEditing) {
    commitActiveMaskCanvas();
    state.maskEditMode = false;
  }
  const modeChanged = !state.paintEditMode;
  state.paintEditMode = true;
  const draft = ensurePaintDraft(assetId);
  if (draft.tool !== "select") {
    setPaintDraft({ ...draft, tool: "select" });
  }
  if (wasMaskEditing) {
    pushToast("ペイント編集に切り替えて貼り付けました。");
  } else if (modeChanged) {
    pushToast("ペイント編集を開始して貼り付けました。");
  }
}

/**
 * 画像 blob を 1 件取り込む。デコード → 16MB プリフライト → paste-sources POST →
 * draft へ追加(選択状態)→ debounce PUT。dropClient があればその位置へ配置する。
 */
export async function importPasteImageBlob(
  blob: Blob,
  dropClient: { clientX: number; clientY: number } | null = null
): Promise<boolean> {
  const assetId = state.activeAssetId;
  if (!assetId || !state.currentProjectId) {
    return false;
  }
  if (!isAcceptedImageBlob(blob)) {
    pushToast(PASTE_UNSUPPORTED_FORMAT_MESSAGE, "error");
    return false;
  }
  const existing = paintDraftForAsset(assetId);
  if (existing && existing.pasteObjects.length >= PASTE_MAX_OBJECTS) {
    pushToast(`貼り付けは 1 画像あたり最大 ${PASTE_MAX_OBJECTS} 件までです。`, "error");
    return false;
  }

  // モード自動切替(非編集/マスク編集→ペイント編集)はレイアウトが変わり、
  // 切替前の client 座標が切替後の canvas rect と対応しないため、
  // ドロップ位置はペイント編集中のドロップでのみ尊重する(それ以外は中央配置)。
  const honorDropPoint = state.paintEditMode;
  const loadingToastTimer = window.setTimeout(() => {
    pushToast("画像を読み込んでいます…");
  }, PASTE_LOADING_TOAST_DELAY_MS);
  let loadingToastId: string | null = null;
  try {
    const canvas = await decodeBlobToCanvas(blob);
    // キャップ後のビットマップを永続ソースとして保存する(クライアント表示と同一内容)。
    // ダウンスケール不要ならオリジナルのバイト列をそのまま保存する(再エンコードなし)。
    const wasDownscaled = typeof createImageBitmap === "function"
      ? Math.max(canvas.width, canvas.height) >= PASTE_MAX_SOURCE_DIMENSION
      : false;
    const dataUrl = wasDownscaled
      ? canvas.toDataURL(blob.type === "image/jpeg" ? "image/jpeg" : blob.type === "image/webp" ? "image/webp" : "image/png")
      : await blobToDataUrl(blob);
    if (dataUrl.length > PASTE_MAX_DATA_URL_LENGTH) {
      pushToast("画像が大きすぎます(最大 16 MB)。縮小してからドロップしてください。", "error");
      return false;
    }

    const response = await api<{ sourceId: string; url: string; width: number | null; height: number | null }>(
      `/api/projects/${state.currentProjectId}/paste-sources`,
      { method: "POST", body: JSON.stringify({ dataUrl }) }
    );
    pasteBitmapCache.set(response.sourceId, canvas);

    switchToPasteEditing(assetId);
    requestRender();

    const draft = ensurePaintDraft(assetId);
    const asset = findAsset(assetId);
    const paintCanvas = document.querySelector<HTMLCanvasElement>("#paintCanvas");
    const baseWidth = paintCanvas?.width && paintCanvas.width > 1 ? paintCanvas.width : assetDimension(asset, "width") ?? 0;
    const baseHeight = paintCanvas?.height && paintCanvas.height > 1 ? paintCanvas.height : assetDimension(asset, "height") ?? 0;
    const canvasSized = !!paintCanvas && paintCanvas.width > 1 && baseWidth === paintCanvas.width;
    const dropPoint = dropClient && honorDropPoint && canvasSized && paintCanvas
      ? pointerToMaskCanvasPoint(paintCanvas, dropClient as PointerEvent)
      : null;

    const object: PastedObject = {
      id: crypto.randomUUID(),
      sourceId: response.sourceId,
      sourceWidth: canvas.width,
      sourceHeight: canvas.height,
      transform: fitInitialPasteTransform(
        canvas.width,
        canvas.height,
        Math.max(1, baseWidth),
        Math.max(1, baseHeight),
        dropPoint
      )
    };
    if (dropClient && honorDropPoint && !canvasSized) {
      // 画像 load 待ちで canvas が未サイズ: 次の sync でドロップ位置へ再配置する。
      pendingPlacement = { assetId, objectId: object.id, clientX: dropClient.clientX, clientY: dropClient.clientY };
    }

    pushPaintObjectsHistory(assetId, draft.pasteObjects, draft.selectedPasteObjectId);
    setPaintDraft({
      ...draft,
      pasteObjects: [...draft.pasteObjects, object],
      selectedPasteObjectId: object.id,
      tool: "select"
    });
    schedulePasteAttachmentsPut(assetId);
    requestRender();
    return true;
  } catch (error) {
    pushToast(`貼り付けに失敗しました: ${error instanceof Error ? error.message : String(error)}`, "error");
    return false;
  } finally {
    window.clearTimeout(loadingToastTimer);
    if (loadingToastId) {
      dismissToast(loadingToastId);
    }
  }
}

// --- D&D / ファイル選択 ------------------------------------------------------

const PASTE_ASSET_DRAG_MIME = "application/x-guruguru-asset-id";

function dragHasFiles(event: DragEvent): boolean {
  return !!event.dataTransfer && [...event.dataTransfer.types].includes("Files");
}

function dragHasAcceptablePayload(event: DragEvent): boolean {
  if (!event.dataTransfer) {
    return false;
  }
  const types = [...event.dataTransfer.types];
  return types.includes("Files") || types.includes(PASTE_ASSET_DRAG_MIME) || types.includes("text/uri-list");
}

/** アプリ内アセットの D&D: uri-list から assetId を抽出するフォールバック。 */
function assetIdFromUriList(uriList: string): string | null {
  const match = /\/api\/assets\/([^/]+)\/(?:image|thumbnail)/.exec(uriList);
  return match ? match[1]! : null;
}

/**
 * アプリ内アセットの取り込み: 必ず assetId を解決して `/api/assets/:id/image`
 * (フル解像度・same-origin)を fetch する。uri-list の URL 直 fetch は
 * サムネイル縮小版を貼ってしまうため行わない。
 */
async function importPasteFromAssetId(sourceAssetId: string) {
  const response = await fetch(`/api/assets/${sourceAssetId}/image`);
  if (!response.ok) {
    pushToast(`アセット画像の取得に失敗しました(HTTP ${response.status})`, "error");
    return;
  }
  const blob = await response.blob();
  await importPasteImageBlob(blob);
}

function setDropHighlight(active: boolean) {
  const media = document.querySelector<HTMLElement>(".preview-media");
  if (!media) {
    return;
  }
  media.classList.toggle("paste-drop-active", active);
  if (active) {
    media.dataset.pasteDropLabel = state.maskEditMode
      ? "ドロップでペイント編集に切り替えて貼り付け"
      : "ドロップして貼り付け";
  } else {
    delete media.dataset.pasteDropLabel;
  }
}

async function handleWindowDrop(event: DragEvent) {
  setDropHighlight(false);
  if (!state.activeAssetId) {
    if (dragHasAcceptablePayload(event)) {
      pushToast("画像を開いてから編集エリアにドロップしてください。");
    }
    return;
  }
  // アプリ内アセットのドラッグ(専用 MIME 優先、uri-list フォールバック)。
  const draggedAssetId =
    event.dataTransfer?.getData(PASTE_ASSET_DRAG_MIME) ||
    assetIdFromUriList(event.dataTransfer?.getData("text/uri-list") ?? "");
  if (draggedAssetId) {
    await importPasteFromAssetId(draggedAssetId);
    return;
  }
  const files = event.dataTransfer ? [...event.dataTransfer.files] : [];
  if (files.length === 0) {
    return;
  }
  const accepted = files.filter(isAcceptedImageBlob);
  if (accepted.length === 0) {
    pushToast(PASTE_UNSUPPORTED_FORMAT_MESSAGE, "error");
    return;
  }
  if (accepted.length < files.length) {
    pushToast(`対応形式(PNG / JPEG / WebP)以外の ${files.length - accepted.length} 件をスキップしました。`);
  }
  const dropClient = { clientX: event.clientX, clientY: event.clientY };
  for (const [index, file] of accepted.entries()) {
    // 複数ファイルは各々オブジェクト化。ドロップ位置は先頭のみ、以降は中央配置。
    await importPasteImageBlob(file, index === 0 ? dropClient : null);
  }
}

/**
 * `registerEventBinder` 経由の配線(初の実利用)。リスナは window に張る。
 * 現状アプリに drop リスナは皆無で、ファイルドロップ=ページ遷移によるアプリ離脱に
 * なるため、受け入れ可否に関わらず window ガード(preventDefault)は常設する。
 */
function bindPasteObjectEvents(app: HTMLElement) {
  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = dragHasAcceptablePayload(event) && state.activeAssetId ? "copy" : "none";
    }
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    void handleWindowDrop(event);
  });
  window.addEventListener("dragenter", (event) => {
    if (dragHasAcceptablePayload(event) && state.activeAssetId) {
      setDropHighlight(true);
    }
  });
  window.addEventListener("dragleave", (event) => {
    // ウィンドウ外へ出たときだけ解除する(子要素間の遷移では relatedTarget が付く)。
    if (!event.relatedTarget) {
      setDropHighlight(false);
    }
  });
  // ギャラリーサムネイルのドラッグ開始: assetId を専用 MIME で仕込む
  // (drop 側はこれを最優先で読み、フル解像度 /api/assets/:id/image を fetch する)。
  app.addEventListener("dragstart", (event) => {
    const target = event.target as HTMLElement | null;
    if (!(target instanceof HTMLImageElement) || !target.classList.contains("gen-image")) {
      return;
    }
    const assetId = target.closest<HTMLElement>("[data-id]")?.dataset.id;
    if (assetId && event.dataTransfer) {
      event.dataTransfer.setData(PASTE_ASSET_DRAG_MIME, assetId);
      event.dataTransfer.effectAllowed = "copy";
    }
  });
  // Ctrl+V: クリップボードの画像をモーダル中央へ貼り付け(テキスト入力中は素通し)。
  window.addEventListener("paste", (event) => {
    if (!state.activeAssetId || isTextEntryTarget(event.target)) {
      return;
    }
    const items = event.clipboardData?.items ?? [];
    for (const item of items) {
      if (item.kind === "file" && PASTE_ACCEPTED_MIME.includes(item.type)) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          void importPasteImageBlob(file);
          return;
        }
      }
    }
  });
}

function openPasteFilePicker() {
  if (!state.activeAssetId) {
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = PASTE_ACCEPTED_MIME.join(",");
  input.multiple = true;
  input.addEventListener("change", () => {
    const files = input.files ? [...input.files] : [];
    void (async () => {
      for (const file of files) {
        await importPasteImageBlob(file);
      }
    })();
  });
  input.click();
}

// --- 生成・保存との合流 -------------------------------------------------------

/** 貼り付けオブジェクトを合成入力(z順)へ変換する。bitmap 未ロード分は含めない。 */
export function pasteLayersForAsset(assetId: string): ComposedPasteLayer[] {
  const draft = paintDraftForAsset(assetId);
  if (!draft) {
    return [];
  }
  const layers: ComposedPasteLayer[] = [];
  for (const object of draft.pasteObjects) {
    const bitmap = pasteBitmapCache.get(object.sourceId);
    if (!bitmap) {
      continue;
    }
    layers.push({
      bitmap,
      sourceWidth: object.sourceWidth,
      sourceHeight: object.sourceHeight,
      transform: { ...object.transform }
    });
  }
  return layers;
}

/**
 * img2img 系生成のための「元画像+ペイントレイヤー+添付オブジェクト」合成。
 * 添付もペイントも無ければ null(従来どおり親画像がそのまま入力になる)。
 * モーダルを開いていない生成(ギャラリーのボタン等)でも、永続化済みの添付を
 * GET + ソース fetch して合成できる。16MB 超過は Error を投げて生成を中断する
 * (呼び出し元の handleAction catch がトースト化)。
 */
export async function buildPasteCompositeForGeneration(
  asset: Asset
): Promise<{ imageDataUrl: string; objects: PastedObject[] } | null> {
  const assetId = asset.id;
  let objects: PastedObject[];
  let enabled: boolean;
  const draft = paintDraftForAsset(assetId);
  if (draft && loadedAttachmentAssetIds.has(assetId)) {
    objects = draft.pasteObjects;
    enabled = draft.pasteEnabled;
  } else if (draft && draft.pasteObjects.length > 0) {
    objects = draft.pasteObjects;
    enabled = draft.pasteEnabled;
  } else {
    const response = await api<{ objects: PastedObject[]; enabled: boolean }>(`/api/assets/${assetId}/paste-attachments`);
    objects = response.objects;
    enabled = response.enabled;
  }
  // pasteEnabled=false: データは保持したまま、合成にも生成にも含めない。
  if (!enabled) {
    objects = [];
  }
  const layer = paintLayerCache.get(assetId) ?? null;
  if (objects.length === 0 && !layer) {
    return null;
  }

  // 必要なソース bitmap を同期的に揃える(未ロード分を fetch)。
  const projectId = state.currentProjectId;
  if (!projectId) {
    return null;
  }
  for (const sourceId of new Set(objects.map((object) => object.sourceId))) {
    if (pasteBitmapCache.has(sourceId)) {
      continue;
    }
    const response = await fetch(`/api/projects/${projectId}/paste-sources/${sourceId}`);
    if (!response.ok) {
      throw new Error(`貼り付け画像の取得に失敗しました(${sourceId}: HTTP ${response.status})`);
    }
    pasteBitmapCache.set(sourceId, await decodeBlobToCanvas(await response.blob()));
  }

  // 元画像は same-origin fetch → decode(モーダル非表示でも合成できるように)。
  const baseResponse = await fetch(asset.imageUrl);
  if (!baseResponse.ok) {
    throw new Error(`元画像の取得に失敗しました(HTTP ${baseResponse.status})`);
  }
  const baseCanvas = await decodeBaseImageToCanvas(await baseResponse.blob());

  const pastedLayers: ComposedPasteLayer[] = [];
  for (const object of objects) {
    const bitmap = pasteBitmapCache.get(object.sourceId);
    if (bitmap) {
      pastedLayers.push({
        bitmap,
        sourceWidth: object.sourceWidth,
        sourceHeight: object.sourceHeight,
        transform: { ...object.transform }
      });
    }
  }

  const composed = composePaintResultCanvas(baseCanvas, layer, baseCanvas.width, baseCanvas.height, pastedLayers);
  const imageDataUrl = composed.toDataURL("image/png");
  if (imageDataUrl.length > PASTE_MAX_DATA_URL_LENGTH) {
    throw new Error("合成結果が 16MB を超えています。貼り付け画像を縮小してください。");
  }
  return { imageDataUrl, objects: objects.map((object) => ({ ...object, transform: { ...object.transform } })) };
}

/** 元画像 blob をキャップなしでデコードする(貼り付けソースと違い縮小しない)。 */
async function decodeBaseImageToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Canvas 2D context is unavailable");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

// --- 後始末 -----------------------------------------------------------------

/** プロジェクト切替/ホーム遷移時のキャッシュ破棄。draft 側は draftStore が消す。 */
export function clearPasteCaches() {
  finishPasteGesture(false);
  flushPasteAttachmentsPut();
  pasteBitmapCache.clear();
  loadedAttachmentAssetIds.clear();
  loadingSourceIds.clear();
  pendingPlacement = null;
}

/** アセット詳細モーダル close 時の後始末。進行中ジェスチャの破棄と保留中 PUT の flush。 */
export function closePasteSession(assetId: string | null) {
  finishPasteGesture(false);
  flushPasteAttachmentsPut(assetId);
  pendingPlacement = null;
}

registerActions({
  "paste-pick-file": () => {
    openPasteFilePicker();
  },
  "paste-object-delete": () => {
    if (state.activeAssetId) {
      deleteSelectedPastedObject(state.activeAssetId);
    }
  },
  "paste-object-duplicate": () => {
    if (state.activeAssetId) {
      duplicateSelectedPastedObject(state.activeAssetId);
    }
  },
  "paste-object-front": () => {
    if (state.activeAssetId) {
      reorderSelectedPastedObject(state.activeAssetId, 1);
    }
  },
  "paste-object-back": () => {
    if (state.activeAssetId) {
      reorderSelectedPastedObject(state.activeAssetId, -1);
    }
  },
  "toggle-paste-attach": (id) => {
    const assetId = id || state.activeAssetId;
    if (assetId) {
      togglePasteEnabledForAsset(assetId);
    }
  }
});

registerEventBinder(bindPasteObjectEvents);
// オブジェクト undo(objects エントリ)復元後の永続化フック(循環 import 回避のための登録)。
setPasteAttachmentsPersistHook(schedulePasteAttachmentsPut);
// スポイト採色をオブジェクト込みの見た目に揃えるプロバイダ(同じく循環回避の登録)。
setPasteLayersProvider(pasteLayersForAsset);
