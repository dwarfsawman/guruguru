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
import { registerActions, registerEventBinder } from "./actionRegistry";
import { api } from "./api";
import { ensurePaintDraft, paintDraftForAsset, setPaintDraft } from "./paintEditorController";
import { commitActiveMaskCanvas } from "./maskEditorController";
import { pointerToMaskCanvasPoint } from "./maskCanvas";
import { assetDimension, findAsset } from "./assetLookup";
import { clampPasteTransform, fitInitialPasteTransform } from "./pasteTransform";
import {
  PASTE_MAX_OBJECTS,
  PASTE_MAX_SOURCE_DIMENSION,
  type PastedObject
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
      body: JSON.stringify({ objects: draft.pasteObjects })
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
      const response = await api<{ objects: PastedObject[] }>(`/api/assets/${assetId}/paste-attachments`);
      if (response.objects.length === 0) {
        return;
      }
      const draft = ensurePaintDraft(assetId);
      // このセッションで既に編集が始まっている場合はクライアント状態を優先する。
      if (draft.pasteObjects.length > 0) {
        return;
      }
      setPaintDraft({ ...draft, pasteObjects: response.objects });
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

/** `#pasteCanvas` へ draft の全オブジェクトを描く。ビットマップ未ロード分はプレースホルダ矩形。 */
export function renderPasteObjectsToCanvas(canvas: HTMLCanvasElement, assetId: string) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  const draft = paintDraftForAsset(assetId);
  if (!draft || draft.pasteObjects.length === 0) {
    return;
  }
  for (const object of draft.pasteObjects) {
    const bitmap = pasteBitmapCache.get(object.sourceId);
    context.save();
    context.translate(object.transform.x, object.transform.y);
    context.rotate(object.transform.rotation);
    context.scale(object.transform.scaleX, object.transform.scaleY);
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

function dragHasFiles(event: DragEvent): boolean {
  return !!event.dataTransfer && [...event.dataTransfer.types].includes("Files");
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
    if (dragHasFiles(event)) {
      pushToast("画像を開いてから編集エリアにドロップしてください。");
    }
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
function bindPasteObjectEvents(_app: HTMLElement) {
  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = dragHasFiles(event) && state.activeAssetId ? "copy" : "none";
    }
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    void handleWindowDrop(event);
  });
  window.addEventListener("dragenter", (event) => {
    if (dragHasFiles(event) && state.activeAssetId) {
      setDropHighlight(true);
    }
  });
  window.addEventListener("dragleave", (event) => {
    // ウィンドウ外へ出たときだけ解除する(子要素間の遷移では relatedTarget が付く)。
    if (!event.relatedTarget) {
      setDropHighlight(false);
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

// --- 後始末 -----------------------------------------------------------------

/** プロジェクト切替/ホーム遷移時のキャッシュ破棄。draft 側は draftStore が消す。 */
export function clearPasteCaches() {
  flushPasteAttachmentsPut();
  pasteBitmapCache.clear();
  loadedAttachmentAssetIds.clear();
  loadingSourceIds.clear();
  pendingPlacement = null;
}

/** アセット詳細モーダル close 時の後始末。保留中の PUT を flush する。 */
export function closePasteSession(assetId: string | null) {
  flushPasteAttachmentsPut(assetId);
  pendingPlacement = null;
}

registerActions({
  "paste-pick-file": () => {
    openPasteFilePicker();
  }
});

registerEventBinder(bindPasteObjectEvents);
