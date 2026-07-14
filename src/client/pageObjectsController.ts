/**
 * ページオブジェクト編集(Docs/Feature-CGCollectionSuite.md P1/P2/P3)。ページ編集 lightbox の
 * 「オブジェクト」モードで box/text/balloon の追加/選択/移動/拡縮/回転/削除/z順/プロパティ変更を扱う。
 * ギズモの座標変換・ジェスチャ数学は `svgGizmo.ts`(共通・純関数)、undo/redo は
 * `pageObjectHistory.ts` を使う。保存は 1s debounce PATCH + lightbox クローズ時 flush
 * (`asset_paste_attachments` 的な「1行に配列」パターン、競合制御なし)。
 * data-action は `registerActions`、pointer drag は main.ts の委譲チェーンから呼ぶ
 * (`pagePanelLightboxController.ts` の crop 編集と同じ設計)。
 *
 * P2(テキスト)で追加したもの:
 * - text オブジェクトの追加・textarea 編集・スタイルパネル(フォント/縦横/サイズ/色/フチ/行間/字間/揃え/折返し幅)。
 * - box への「テキストを載せる」(content)トグル+同じスタイルパネル。
 * - ギズモの拡縮は text の場合 style.size(+ maxWidth 同率)を変える(box は従来通り size.x/y)。
 *   選択枠は layout の bbox(`textLayoutClient.ts` のクライアント側 LRU キャッシュ)を使う。
 * - `/api/text-layout` は 150ms debounce で叩く(`scheduleTextLayoutFetch`)。textarea の undo 履歴は
 *   500ms 静止で1エントリにまとめる(`scheduleTextHistoryCommit`/`flushTextHistoryCommit`)。
 *
 * P3(吹き出し)で追加したもの:
 * - balloon の追加・形状/塗り/線/しっぽ トグル+幅のプロパティ編集(content は box と同じ仕組みを再利用)。
 * - ギズモの拡縮は box と同じく size.x/y を変える(tail.tip/width も同率でスケールする -- tip はローカル
 *   座標なので、中心固定の拡縮であればそのままオブジェクトと一緒にスケールするだけでよい)。
 * - しっぽの tip 専用ドラッグハンドル(`data-page-object-handle="tail"`)。画面デルタを -rotation 回して
 *   ローカル座標へ変換する(`pagePanelLightboxController.ts` の crop パンと同じ考え方)。
 *
 * 追記(Docs/Feature-PageEditSidebarUx.md 課題A、2026-07-14): box/balloon の「テキストを載せる」(hasContent)
 * トグルは撤去した。本文編集は SETTINGS 見出しフィールド(pagePanelLightboxView.ts の renderObjectsToolbar)に
 * 一本化し、`updatePageObjectTextFromInput` が content 無し box/balloon への入力時に content を新規作成する
 * (空文字にしても content を null へは戻さない -- 「OFF→ON で入力済みテキストが消える」旧バグの解消)。
 *
 * 追記(課題C、2026-07-14): Shift+クリック複数選択とグループ化。`state.selectedPageObjectId: string | null`
 * を `state.selectedPageObjectIds: string[]`(先頭=primary)へ拡張した。選択集合の解決(通常/Shift/Alt
 * クリック)とグループ操作・複数移動の delta 適用は `pageObjectSelection.ts` の純関数に切り出してある。
 * move ジェスチャのみ複数対応(`beginObjectDrag` が選択中の全 editable オブジェクトの開始位置を
 * `moveGroupStart` へ保持し、`handlePageObjectsPointerMove` が同じ delta を全員へ適用する)。
 * scale/rotate/tail/tone-center は従来どおり primary 単体のみ(ギズモのハンドル自体、複数選択時は
 * `pagePanelLightboxView.ts` 側でそもそも描画しない)。レイヤ一覧のクリック修飾キーは `registerActions`
 * では拾えないため、`chronicleController.ts` の Beat チップと同じ capture リスナーパターンを使う
 * (`bindPageLayerEvents` 内)。
 */
import {
  BALLOON_TAIL_TIP_CLAMP,
  DEFAULT_BALLOON_TAIL_WIDTH,
  DEFAULT_BOX_SIZE,
  DEFAULT_TEXT_STYLE,
  DEFAULT_TONE_SIZE,
  PAGE_OBJECT_MAX_SIZE,
  PAGE_OBJECT_MIN_SIZE,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  TONE_CENTER_CLAMP,
  TONE_COUNT_MAX,
  TONE_KINDS,
  TONE_NOISE_GRAIN_MAX,
  TONE_NOISE_GRAIN_MIN,
  TONE_PITCH_MAX,
  TONE_PITCH_MIN,
  TONE_SNOW_BLUR_MAX,
  TONE_SNOW_SIZE_MAX,
  TONE_SNOW_SIZE_MIN,
  contentMaxWidth,
  createBalloonObject,
  createBoxObject,
  createImageObject,
  createTextObject,
  createToneObject,
  defaultBalloonTail,
  defaultImageObjectSize,
  defaultToneParams,
  type BalloonObject,
  type BalloonShape,
  type BoxObject,
  type ImageObject,
  type ImageObjectBand,
  type PageObject,
  type PageVec,
  type TextAlign,
  type TextContent,
  type TextDirection,
  type TextObject,
  type TextStyle,
  type ToneKind,
  type ToneObject,
  type ToneParams
} from "../shared/pageObjects";
import { panelBounds, type LayoutPanel } from "../shared/pageLayout";
import { balloonContentMaxWidth } from "../shared/balloonShape";
import { getStageTransform, gizmoRotateHandlePoint, rotateGizmoBox, scaleGizmoBoxAboutCenter } from "./svgGizmo";
import { gizmoBoxForPageObject } from "./pageObjectGizmoBox";
import { pageObjectGizmoViewBounds } from "./views/pagePanelLightboxView";
import {
  createPageObjectHistory,
  pushPageObjectHistory,
  redoPageObjects,
  snapshotPageObjects,
  undoPageObjects,
  type PageObjectHistorySnapshot,
  type PageObjectHistoryState
} from "./pageObjectHistory";
import type { FontSummary } from "../shared/apiTypes";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";
import { notifyChroniclePageObjectManualEdit } from "./chronicleController";
import { clampNumber } from "./clientUtils";
import { isTextEntryTarget } from "./clientUtils";
import { pageLayerBand, reorderPageObjectLayer, stepPageObjectLayer, type PageLayerDropPosition } from "./pageLayers";
import { ensureTextLayout } from "./textLayoutClient";
import {
  applyGroupId,
  applyGroupMoveDelta,
  clearGroupId,
  resolvePageObjectSelectionClick,
  sameSelection,
  type PageObjectSelectionModifiers
} from "./pageObjectSelection";

/** ギズモで動かせるオブジェクトの型(box/text/balloon/image/tone)。 */
type EditableObject = BoxObject | TextObject | BalloonObject | ImageObject | ToneObject;

function isEditableObject(object: PageObject): object is EditableObject {
  return (
    object.kind === "box" || object.kind === "text" || object.kind === "balloon" || object.kind === "image" || object.kind === "tone"
  );
}

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
  if (textLayoutDebounceTimer !== null) {
    window.clearTimeout(textLayoutDebounceTimer);
    textLayoutDebounceTimer = null;
  }
  if (textHistoryDebounceTimer !== null) {
    window.clearTimeout(textHistoryDebounceTimer);
    textHistoryDebounceTimer = null;
  }
  textHistoryBaseline = null;
  objectDrag = null;
}

/** 未保存の変更が保留中なら true を返しつつリセットする(lightbox クローズ判定用)。 */
export function consumePageObjectsDirtyFlag(): boolean {
  const value = objectsDirty;
  objectsDirty = false;
  return value;
}

/**
 * このモジュール経由の debounce PATCH を通さずにサーバへ保存済みの変更があったことを記録する
 * (Docs/Feature-ScriptToManga.md S3: セリフドロワーの `createDialoguePlacement` は専用 API で
 * pages.objects_json を直接更新するため)。lightbox クローズ時のページ一覧プレビュー再取得判定に乗せる。
 */
export function markPageObjectsDirty(): void {
  objectsDirty = true;
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
 * 未確定の textarea 編集(`flushTextHistoryCommit`)も先に履歴へ確定させておく。
 */
export function flushPageObjectsSave(): Promise<void> {
  flushTextHistoryCommit();
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
  return snapshotPageObjects(state.pageObjectsDraft, state.selectedPageObjectIds);
}

/**
 * Chronicle 一括配置(Docs/Done/Feature-ChroniclePageFlow.md §2.3 フェーズIII)。apply 直前のスナップショットを
 * 呼び出し側(`chronicleController.ts`)が取得し、apply 成功後に `pushPageObjectHistorySnapshot` で1エントリ
 * として積む -- Undo 一回で一括配置前へ戻せるようにする(このモジュール外からの確定操作は他に無いため専用に公開する)。
 */
export function currentPageObjectsSnapshot(): PageObjectHistorySnapshot {
  return currentSnapshot();
}

export function pushPageObjectHistorySnapshotExternal(previous: PageObjectHistorySnapshot): void {
  pushPageObjectHistory(objectHistory, previous);
}

function undoPageObjectsAction(): void {
  if (!state.pagePanelLightbox) {
    return;
  }
  flushTextHistoryCommit();
  const restored = undoPageObjects(objectHistory, currentSnapshot());
  if (!restored) {
    return;
  }
  state.pageObjectsDraft = restored.objects;
  state.selectedPageObjectIds = restored.selectedIds;
  requestRender();
  scheduleSave();
}

function redoPageObjectsAction(): void {
  if (!state.pagePanelLightbox) {
    return;
  }
  flushTextHistoryCommit();
  const restored = redoPageObjects(objectHistory, currentSnapshot());
  if (!restored) {
    return;
  }
  state.pageObjectsDraft = restored.objects;
  state.selectedPageObjectIds = restored.selectedIds;
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
  if ((event.key === "Delete" || event.key === "Backspace") && state.selectedPageObjectIds.length > 0 && !isTextEntryTarget(event.target)) {
    event.preventDefault();
    deleteSelectedPageObject();
    return true;
  }
  return false;
}

// --- 追加/削除/z順 ---

/** 選択中の primary(先頭)オブジェクト。プロパティパネル等、単一選択が前提の経路はこれを使う。 */
function findSelectedObject(): PageObject | null {
  const id = state.selectedPageObjectIds[0];
  if (!id) {
    return null;
  }
  return state.pageObjectsDraft.find((item) => item.id === id) ?? null;
}

/** 新規に追加したオブジェクトを単独選択し、必要なら初回のレイアウトを(debounce 無しで)即座に取りに行く。 */
function selectNewObject(object: PageObject): void {
  state.selectedPageObjectIds = [object.id];
  requestRender();
  scheduleSave();
  if (object.kind === "text") {
    void ensureTextLayout(object.content, object.maxWidth);
  } else if (object.kind === "balloon" && object.content) {
    void ensureTextLayout(object.content, balloonContentMaxWidth(object.shape, object.size, object.content.style.direction));
  }
}

function addBoxObject(): void {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "objects") {
    return;
  }
  flushTextHistoryCommit();
  const previous = currentSnapshot();
  const size = {
    x: Math.min(DEFAULT_BOX_SIZE.x, 0.8),
    y: Math.min(DEFAULT_BOX_SIZE.y, Math.max(PAGE_OBJECT_MIN_SIZE, lightbox.pageHeight * 0.5))
  };
  const center = { x: 0.5, y: lightbox.pageHeight / 2 };
  const object = createBoxObject(crypto.randomUUID(), center, size);
  pushPageObjectHistory(objectHistory, previous);
  state.pageObjectsDraft = [...state.pageObjectsDraft, object];
  selectNewObject(object);
}

function addTextObject(): void {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "objects") {
    return;
  }
  flushTextHistoryCommit();
  const previous = currentSnapshot();
  const center = { x: 0.5, y: lightbox.pageHeight / 2 };
  const object = createTextObject(crypto.randomUUID(), center);
  pushPageObjectHistory(objectHistory, previous);
  state.pageObjectsDraft = [...state.pageObjectsDraft, object];
  selectNewObject(object);
}

function addBalloonObject(): void {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "objects") {
    return;
  }
  flushTextHistoryCommit();
  const previous = currentSnapshot();
  const center = { x: 0.5, y: lightbox.pageHeight / 2 };
  const object = createBalloonObject(crypto.randomUUID(), center);
  pushPageObjectHistory(objectHistory, previous);
  state.pageObjectsDraft = [...state.pageObjectsDraft, object];
  selectNewObject(object);
}

// --- トーン(Docs/Feature-ScreenTones.md): 「+ トーン」・seed 乱数 ---

/** 新規 seed / シャッフル用の乱数(既存 generationController.ts の randomSeed と同じ範囲)。 */
function randomToneSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

/**
 * 選択中パネルの形状。`renderObjectsToolbar`(view)が使う `layout` と同じソース(state.book の
 * 現在ページの `page.layout`)を参照する -- `state.pageLayoutDraft` はコマ形状編集(P5)専用の別ドラフトで、
 * 「+ トーン」時点では view 側の実描画と食い違い得るため使わない。
 */
function selectedPanelShape(): LayoutPanel | null {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || !lightbox.selectedPanelId) {
    return null;
  }
  const page = state.book?.pages.find((item) => item.id === lightbox.pageId);
  return page?.layout?.panels.find((panel) => panel.id === lightbox.selectedPanelId) ?? null;
}

/**
 * 「+ トーン」(Docs/Feature-ScreenTones.md エディタ UI)。コマ選択中はそのコマの外接矩形を領域にし
 * clipPanelId 付きで作成する(コマにトーンを貼る主要ユースケースを1クリック化)。未選択はページ中央に
 * 既定サイズ(0.35×0.35)・既定 toneType(halftone)で作成する。
 */
function addToneObject(): void {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "objects") {
    return;
  }
  flushTextHistoryCommit();
  const previous = currentSnapshot();
  const panel = selectedPanelShape();
  let center: PageVec = { x: 0.5, y: lightbox.pageHeight / 2 };
  let size: PageVec = { ...DEFAULT_TONE_SIZE };
  let clipPanelId: string | null = null;
  if (panel) {
    const bounds = panelBounds(panel.shape);
    center = { x: (bounds[0] + bounds[2]) / 2, y: (bounds[1] + bounds[3]) / 2 };
    size = {
      x: Math.max(PAGE_OBJECT_MIN_SIZE, bounds[2] - bounds[0]),
      y: Math.max(PAGE_OBJECT_MIN_SIZE, bounds[3] - bounds[1])
    };
    clipPanelId = panel.id;
  }
  const object = createToneObject(crypto.randomUUID(), center, randomToneSeed(), size, "halftone", clipPanelId);
  pushPageObjectHistory(objectHistory, previous);
  state.pageObjectsDraft = [...state.pageObjectsDraft, object];
  selectNewObject(object);
}

// --- 画像オブジェクト(Docs/Feature-ScriptToManga.md S2): 「画像追加」/「メディア差し替え」ピッカー ---

/** 「画像追加」/「メディア差し替え」ボタン。同じボタンをもう一度押す/キャンセルで閉じる。 */
function togglePageObjectImagePicker(action: string): void {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.mode !== "objects") {
    return;
  }
  if (action === "cancel") {
    state.pageObjectImagePicker = null;
    requestRender();
    return;
  }
  const mode: "add" | "replace" = action === "replace" ? "replace" : "add";
  // 「メディア差し替え」は単一選択(の image オブジェクト)前提の操作。複数選択時は
  // SETTINGS パネル自体がこのボタンを出さないが、念のため primary の kind もここで確認する。
  if (mode === "replace" && (state.selectedPageObjectIds.length !== 1 || findSelectedObject()?.kind !== "image")) {
    return;
  }
  state.pageObjectImagePicker = state.pageObjectImagePicker?.mode === mode ? null : { mode };
  requestRender();
}

/**
 * ピッカーでサムネをクリックした時の処理。`POST /api/projects/:id/page-media { assetId }` で
 * mediaId を取得し、"add" なら新規 ImageObject を追加、"replace" なら選択中の ImageObject の
 * mediaId だけを差し替える(帯/不透明度/クリップ設定は維持)。
 */
async function pickPageObjectImage(assetId: string): Promise<void> {
  const lightbox = state.pagePanelLightbox;
  const picker = state.pageObjectImagePicker;
  const projectId = state.currentProjectId;
  if (!lightbox || !picker || !projectId) {
    return;
  }
  const pageId = lightbox.pageId;
  const mode = picker.mode;
  const replaceTargetId = mode === "replace" ? state.selectedPageObjectIds[0] ?? null : null;
  state.pageObjectImagePicker = null;
  requestRender();
  try {
    const result = await api<{ mediaId: string; width: number | null; height: number | null }>(
      `/api/projects/${projectId}/page-media`,
      { method: "POST", body: JSON.stringify({ assetId }) }
    );
    // 取得中に lightbox が閉じられた/別ページへ切り替わっていたら結果を捨てる。
    if (state.pagePanelLightbox?.pageId !== pageId) {
      return;
    }
    if (mode === "add") {
      flushTextHistoryCommit();
      const previous = currentSnapshot();
      const center = { x: 0.5, y: lightbox.pageHeight / 2 };
      const size = defaultImageObjectSize(result.width, result.height);
      const object = createImageObject(crypto.randomUUID(), center, result.mediaId, size);
      pushPageObjectHistory(objectHistory, previous);
      state.pageObjectsDraft = [...state.pageObjectsDraft, object];
      selectNewObject(object);
      return;
    }
    if (!replaceTargetId) {
      return;
    }
    const index = state.pageObjectsDraft.findIndex((item) => item.id === replaceTargetId);
    const current = state.pageObjectsDraft[index];
    if (index < 0 || !current || current.kind !== "image") {
      return;
    }
    commitObjectMutation(replaceTargetId, { ...current, mediaId: result.mediaId });
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
    requestRender();
  }
}

/** 選択中オブジェクト全員を削除する(C-3: 複数選択時も undo 1エントリでまとめて消す)。 */
function deleteSelectedPageObject(): void {
  const ids = state.selectedPageObjectIds;
  if (ids.length === 0) {
    return;
  }
  flushTextHistoryCommit();
  const previous = currentSnapshot();
  pushPageObjectHistory(objectHistory, previous);
  const idSet = new Set(ids);
  state.pageObjectsDraft = state.pageObjectsDraft.filter((item) => !idSet.has(item.id));
  state.selectedPageObjectIds = [];
  requestRender();
  scheduleSave();
}

/** z順の前面/背面移動(C-3: 複数選択時は無効。UI 側もボタンを disabled にするが、ここでも防御する)。 */
function reorderSelected(mutate: (objects: PageObject[], index: number) => void): void {
  if (state.selectedPageObjectIds.length !== 1) {
    return;
  }
  const id = state.selectedPageObjectIds[0]!;
  const index = state.pageObjectsDraft.findIndex((item) => item.id === id);
  if (index < 0) {
    return;
  }
  flushTextHistoryCommit();
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

/** レイヤ一覧の D&D / 上下ボタンで得た新しい配列を、通常の z 順変更と同じ履歴・保存経路へ流す。 */
function commitPageObjectLayerOrder(next: PageObject[]): void {
  if (next.length !== state.pageObjectsDraft.length || next.every((item, index) => item.id === state.pageObjectsDraft[index]?.id)) {
    return;
  }
  flushTextHistoryCommit();
  const previous = currentSnapshot();
  pushPageObjectHistory(objectHistory, previous);
  state.pageObjectsDraft = next;
  requestRender();
  scheduleSave();
}

function movePageLayerRelative(draggedId: string, targetId: string, position: PageLayerDropPosition): void {
  commitPageObjectLayerOrder(reorderPageObjectLayer(state.pageObjectsDraft, draggedId, targetId, position));
}

function stepPageLayer(objectId: string, direction: "up" | "down"): void {
  commitPageObjectLayerOrder(stepPageObjectLayer(state.pageObjectsDraft, objectId, direction));
}

/**
 * レイヤ一覧行のクリック選択(C-2)。オブジェクト行は紙面クリックと同じ選択解決規則
 * (通常/Shift/Alt、`resolvePageObjectSelectionClick`)に従う。コマ(panel)行は仕様どおり
 * 修飾キーを無視し常に単一選択(複数選択の対象はページオブジェクトのみ)。
 */
function selectPageLayer(id: string, modifiers: PageObjectSelectionModifiers): void {
  const lightbox = state.pagePanelLightbox;
  if (!lightbox || lightbox.cropPanelId) {
    return;
  }
  const separator = id.indexOf(":");
  const kind = separator >= 0 ? id.slice(0, separator) : "";
  const layerId = separator >= 0 ? id.slice(separator + 1) : "";
  if (!layerId) {
    return;
  }
  if (kind === "object" && state.pageObjectsDraft.some((object) => object.id === layerId)) {
    const nextSelection = resolvePageObjectSelectionClick(state.pageObjectsDraft, state.selectedPageObjectIds, layerId, modifiers);
    if (sameSelection(nextSelection, state.selectedPageObjectIds) && !lightbox.selectedPanelId) {
      return;
    }
    flushTextHistoryCommit();
    state.selectedPageObjectIds = nextSelection;
    lightbox.selectedPanelId = null;
  } else if (kind === "panel") {
    flushTextHistoryCommit();
    state.selectedPageObjectIds = [];
    lightbox.selectedPanelId = layerId;
  } else {
    return;
  }
  state.dialogueDrawerOpen = false;
  requestRender();
}

function togglePageLayerVisibility(id: string): void {
  const separator = id.indexOf(":");
  const kind = separator >= 0 ? id.slice(0, separator) : "";
  const layerId = separator >= 0 ? id.slice(separator + 1) : "";
  if (!layerId) {
    return;
  }
  if (kind === "object") {
    const hidden = new Set(state.pageLayerHiddenObjectIds);
    hidden.has(layerId) ? hidden.delete(layerId) : hidden.add(layerId);
    state.pageLayerHiddenObjectIds = [...hidden];
  } else if (kind === "panel") {
    const hidden = new Set(state.pageLayerHiddenPanelIds);
    hidden.has(layerId) ? hidden.delete(layerId) : hidden.add(layerId);
    state.pageLayerHiddenPanelIds = [...hidden];
  } else {
    return;
  }
  requestRender();
}

function togglePageLayerHideNonImage(): void {
  state.pageLayerHideNonImage = !state.pageLayerHideNonImage;
  requestRender();
}

function showAllPageLayers(): void {
  state.pageLayerHiddenObjectIds = [];
  state.pageLayerHiddenPanelIds = [];
  state.pageLayerHideNonImage = false;
  requestRender();
}

let draggedPageLayer: { objectId: string; band: "front" | "back" } | null = null;

function clearPageLayerDropState(app: HTMLElement): void {
  app.querySelectorAll<HTMLElement>(".page-layer-row.is-dragging, .page-layer-row.is-drop-before, .page-layer-row.is-drop-after").forEach((row) => {
    row.classList.remove("is-dragging", "is-drop-before", "is-drop-after");
  });
}

/**
 * `bindPageLayerEvents` の capture リスナーが記録する、直近の「レイヤ選択」クリックの Shift/Alt 押下有無
 * (C-2)。`registerActions` のハンドラは (id, target) しか受け取らない(main.ts の click 委譲が生イベントを
 * 渡さない)ため、`chronicleController.ts` の Beat チップと同じパターンで capture フェーズで先取りする。
 */
let modifiersForLastLayerSelectClick: PageObjectSelectionModifiers = { shiftKey: false, altKey: false };

function bindPageLayerEvents(app: HTMLElement): void {
  app.addEventListener(
    "click",
    (event) => {
      const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action="select-page-layer"]');
      modifiersForLastLayerSelectClick = trigger ? { shiftKey: event.shiftKey, altKey: event.altKey } : { shiftKey: false, altKey: false };
    },
    { capture: true }
  );

  app.addEventListener("dragstart", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, input, select, textarea")) {
      event.preventDefault();
      return;
    }
    const row = target?.closest<HTMLElement>("[data-page-layer-object-id]");
    const objectId = row?.dataset.pageLayerObjectId;
    const object = objectId ? state.pageObjectsDraft.find((item) => item.id === objectId) : null;
    if (!row || !objectId || !object) {
      return;
    }
    draggedPageLayer = { objectId, band: pageLayerBand(object) };
    row.classList.add("is-dragging");
    event.dataTransfer?.setData("text/plain", objectId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  });

  app.addEventListener("dragover", (event) => {
    if (!draggedPageLayer) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>("[data-page-layer-object-id]");
    if (!row || row.dataset.pageLayerObjectId === draggedPageLayer.objectId || row.dataset.pageLayerBand !== draggedPageLayer.band) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    clearPageLayerDropState(app);
    const position: PageLayerDropPosition = event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2 ? "before" : "after";
    row.classList.add(position === "before" ? "is-drop-before" : "is-drop-after");
    row.dataset.pageLayerDropPosition = position;
  });

  app.addEventListener("drop", (event) => {
    const dragged = draggedPageLayer;
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>("[data-page-layer-object-id]");
    const targetId = row?.dataset.pageLayerObjectId;
    const position = row?.dataset.pageLayerDropPosition as PageLayerDropPosition | undefined;
    if (dragged && row && targetId && position && row.dataset.pageLayerBand === dragged.band) {
      event.preventDefault();
      movePageLayerRelative(dragged.objectId, targetId, position);
    }
    draggedPageLayer = null;
    clearPageLayerDropState(app);
  });

  app.addEventListener("dragend", () => {
    draggedPageLayer = null;
    clearPageLayerDropState(app);
  });
}

// --- テキストレイアウト取得(150ms debounce)と textarea の undo 履歴(500ms 静止で1エントリ) ---

const TEXT_LAYOUT_DEBOUNCE_MS = 150;
let textLayoutDebounceTimer: number | null = null;

/** `/api/text-layout` の取得を150ms debounce する(タイピング中の毎キー入力でサーバを叩かないため)。 */
function scheduleTextLayoutFetch(content: TextContent, maxWidth: number | undefined): void {
  if (textLayoutDebounceTimer !== null) {
    window.clearTimeout(textLayoutDebounceTimer);
  }
  textLayoutDebounceTimer = window.setTimeout(() => {
    textLayoutDebounceTimer = null;
    void ensureTextLayout(content, maxWidth);
  }, TEXT_LAYOUT_DEBOUNCE_MS);
}

const TEXT_HISTORY_DEBOUNCE_MS = 500;
let textHistoryDebounceTimer: number | null = null;
/** textarea 編集セッションの開始直前スナップショット。null なら編集セッション中でない。 */
let textHistoryBaseline: PageObjectHistorySnapshot | null = null;

function scheduleTextHistoryCommit(): void {
  if (textHistoryDebounceTimer !== null) {
    window.clearTimeout(textHistoryDebounceTimer);
  }
  textHistoryDebounceTimer = window.setTimeout(() => {
    textHistoryDebounceTimer = null;
    flushTextHistoryCommit();
  }, TEXT_HISTORY_DEBOUNCE_MS);
}

/**
 * 未確定の textarea 編集セッションがあれば、その開始前スナップショットを1個の undo エントリとして積む。
 * 他の確定操作(追加/削除/z順/undo/redo/ドラッグ開始/プロパティ変更/lightbox close)の前に必ず呼ぶ
 * -- 呼ばずに他の操作を history へ push すると、textarea 編集の baseline が「その操作の後」になり
 * undo で textarea 編集だけ戻せなくなる。
 */
function flushTextHistoryCommit(): void {
  if (textHistoryDebounceTimer !== null) {
    window.clearTimeout(textHistoryDebounceTimer);
    textHistoryDebounceTimer = null;
  }
  if (textHistoryBaseline) {
    pushPageObjectHistory(objectHistory, textHistoryBaseline);
    textHistoryBaseline = null;
  }
}

function beginTextHistoryEdit(): void {
  if (textHistoryBaseline === null) {
    textHistoryBaseline = currentSnapshot();
  }
}

/** 変更後オブジェクトのレイアウトを(debounce しながら)取得しにいく。box/balloon は content があれば対象。 */
function scheduleLayoutForUpdatedObject(updated: PageObject): void {
  if (updated.kind === "text") {
    scheduleTextLayoutFetch(updated.content, updated.maxWidth);
  } else if (updated.kind === "box" && updated.content) {
    scheduleTextLayoutFetch(updated.content, contentMaxWidth(updated.size, updated.content.style.direction));
  } else if (updated.kind === "balloon" && updated.content) {
    scheduleTextLayoutFetch(updated.content, balloonContentMaxWidth(updated.shape, updated.size, updated.content.style.direction));
  }
}

// --- テキストスタイル操作の共通ヘルパ(TextObject 自身にも box/balloon の content にも使う) ---

const OUTLINE_WIDTH_DEFAULT = 0.12;
const OUTLINE_COLOR_DEFAULT = "#ffffff";
/** 折り返し有効化チェックを入れた時に使う初期幅(page 単位)。 */
const TEXT_MAX_WIDTH_DEFAULT = 0.4;

function applyTextStyleField(style: TextStyle, field: string, target: HTMLInputElement | HTMLSelectElement): TextStyle {
  switch (field) {
    case "color":
      return { ...style, color: target.value };
    case "direction": {
      const direction: TextDirection = target.value === "vertical" ? "vertical" : "horizontal";
      return { ...style, direction };
    }
    case "fontId":
      return { ...style, fontId: target.value || "default" };
    case "align": {
      const value = target.value;
      const align: TextAlign = value === "center" || value === "end" ? value : "start";
      return { ...style, align };
    }
    case "size":
      return { ...style, size: clampNumber(Number(target.value), TEXT_SIZE_MIN, TEXT_SIZE_MAX, style.size) };
    case "lineSpacing":
      return { ...style, lineSpacing: clampNumber(Number(target.value), 0.5, 4, style.lineSpacing ?? 1.6) };
    case "letterSpacing":
      return { ...style, letterSpacing: clampNumber(Number(target.value), 0.2, 4, style.letterSpacing ?? 1.0) };
    case "outlineWidth":
      return { ...style, outlineWidth: clampNumber(Number(target.value), 0, 1, style.outlineWidth ?? 0) };
    case "outlineColor":
      return { ...style, outlineColor: target.value };
    case "outlineEnabled": {
      if ((target as HTMLInputElement).checked) {
        return { ...style, outlineColor: style.outlineColor ?? OUTLINE_COLOR_DEFAULT, outlineWidth: style.outlineWidth ?? OUTLINE_WIDTH_DEFAULT };
      }
      const { outlineColor: _outlineColor, outlineWidth: _outlineWidth, ...rest } = style;
      return rest;
    }
    default:
      return style;
  }
}

function updateBoxOwnField(box: BoxObject, field: string, target: HTMLInputElement): BoxObject | null {
  if (field === "fill" || field === "strokeColor") {
    return { ...box, [field]: target.value };
  }
  if (field === "strokeWidth" || field === "cornerRadius") {
    const range = field === "strokeWidth" ? { min: 0, max: 0.2 } : { min: 0, max: PAGE_OBJECT_MAX_SIZE };
    const parsed = Number(target.value);
    const clamped = Number.isFinite(parsed) ? Math.min(range.max, Math.max(range.min, parsed)) : (box[field] ?? 0);
    return { ...box, [field]: clamped };
  }
  return null;
}

function updateTextOwnField(text: TextObject, field: string, target: HTMLInputElement | HTMLSelectElement): TextObject | null {
  if (field === "maxWidthEnabled") {
    const updated: TextObject = { ...text };
    if ((target as HTMLInputElement).checked) {
      updated.maxWidth = text.maxWidth ?? TEXT_MAX_WIDTH_DEFAULT;
    } else {
      delete updated.maxWidth;
    }
    return updated;
  }
  if (field === "maxWidth") {
    return { ...text, maxWidth: clampNumber(Number(target.value), PAGE_OBJECT_MIN_SIZE, PAGE_OBJECT_MAX_SIZE, text.maxWidth ?? TEXT_MAX_WIDTH_DEFAULT) };
  }
  const nextStyle = applyTextStyleField(text.content.style, field, target);
  if (nextStyle === text.content.style) {
    return null;
  }
  return { ...text, content: { ...text.content, style: nextStyle } };
}

function updateBoxContentField(box: BoxObject, field: string, target: HTMLInputElement | HTMLSelectElement): BoxObject | null {
  if (!box.content) {
    return null;
  }
  const nextStyle = applyTextStyleField(box.content.style, field, target);
  return { ...box, content: { ...box.content, style: nextStyle } };
}

const BALLOON_SHAPE_VALUES = new Set<BalloonShape>(["ellipse", "rounded", "cloud", "jagged", "thought", "compound", "spike", "roundRect", "caption"]);

/**
 * balloon 自身のプロパティ(shape/塗り/線/しっぽ トグル+幅)。content の中身は updateBalloonContentField。
 * A-2: 「テキストを載せる」(hasContent)トグルは撤去済み -- 本文編集は SETTINGS 見出しフィールド経由の
 * updatePageObjectTextFromInput に一本化し、そちらが content の新規作成も担う。
 */
function updateBalloonOwnField(balloon: BalloonObject, field: string, target: HTMLInputElement | HTMLSelectElement): BalloonObject | null {
  if (field === "shape") {
    const value = target.value;
    if (!BALLOON_SHAPE_VALUES.has(value as BalloonShape)) {
      return null;
    }
    return { ...balloon, shape: value as BalloonShape };
  }
  if (field === "fill" || field === "strokeColor") {
    return { ...balloon, [field]: target.value };
  }
  if (field === "strokeWidth") {
    const parsed = Number(target.value);
    return { ...balloon, strokeWidth: Number.isFinite(parsed) ? Math.min(0.2, Math.max(0, parsed)) : balloon.strokeWidth };
  }
  if (field === "tailEnabled") {
    const updated: BalloonObject = { ...balloon };
    updated.tail = (target as HTMLInputElement).checked ? balloon.tail ?? defaultBalloonTail(balloon.size) : null;
    return updated;
  }
  if (field === "tailWidth") {
    if (!balloon.tail) {
      return null;
    }
    const width = clampNumber(Number(target.value), 0, PAGE_OBJECT_MAX_SIZE, balloon.tail.width);
    return { ...balloon, tail: { ...balloon.tail, width } };
  }
  return null;
}

function updateBalloonContentField(balloon: BalloonObject, field: string, target: HTMLInputElement | HTMLSelectElement): BalloonObject | null {
  if (!balloon.content) {
    return null;
  }
  const nextStyle = applyTextStyleField(balloon.content.style, field, target);
  return { ...balloon, content: { ...balloon.content, style: nextStyle } };
}

const IMAGE_BAND_VALUES = new Set<ImageObjectBand>(["back", "front"]);

/** 画像オブジェクト自身のプロパティ(帯/不透明度/クリップ先コマ)。メディア差し替えは別 action(ピッカー)。 */
function updateImageOwnField(image: ImageObject, field: string, target: HTMLInputElement | HTMLSelectElement): ImageObject | null {
  if (field === "band") {
    const value = target.value;
    return IMAGE_BAND_VALUES.has(value as ImageObjectBand) ? { ...image, band: value as ImageObjectBand } : null;
  }
  if (field === "opacity") {
    const parsed = Number(target.value);
    return { ...image, opacity: Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : (image.opacity ?? 1) };
  }
  if (field === "clipPanelId") {
    const value = target.value.trim();
    return { ...image, clipPanelId: value || null };
  }
  return null;
}

const TONE_KIND_VALUES = new Set<ToneKind>(TONE_KINDS);

/**
 * トーン自身のプロパティ(種別/色/不透明度/クリップ先コマ)+ params 内の色/トグル系フィールド。
 * params の中身のうち **数値**は updateToneParamField、**色/チェックボックス**はこちら(2026-07-14 追補:
 * backColor は文字列なので Number() 変換に流さない -- 既存の color フィールドと同じ扱いにする)。
 */
function updateToneOwnField(tone: ToneObject, field: string, target: HTMLInputElement | HTMLSelectElement): ToneObject | null {
  if (field === "toneType") {
    const value = target.value;
    if (!TONE_KIND_VALUES.has(value as ToneKind) || value === tone.toneType) {
      return null;
    }
    // 種別切替: params はその種別の既定値へリセットする(Docs/Feature-ScreenTones.md エディタ UI 節)。
    return { ...tone, toneType: value as ToneKind, params: defaultToneParams(value as ToneKind) };
  }
  if (field === "color") {
    return { ...tone, color: target.value };
  }
  if (field === "opacity") {
    const parsed = Number(target.value);
    return { ...tone, opacity: Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : (tone.opacity ?? 1) };
  }
  if (field === "clipPanelId") {
    const value = target.value.trim();
    return { ...tone, clipPanelId: value || null };
  }
  // snow: 背面粒の色(params.backColor)。color 入力は常に妥当な #rrggbb を返すので追加検証は不要
  // (object.color と同じ扱い -- Number() には流さない)。
  if (field === "backColor") {
    return { ...tone, params: { ...tone.params, backColor: target.value } };
  }
  // lines/noise: 濃度グラデの有効/無効トグル(startRatio/endRatio の有無で表す。tailEnabled/
  // maxWidthEnabled と同じ「チェックボックスで optional フィールドの有無を切り替える」パターン)。
  if (field === "gradientEnabled") {
    const params = { ...tone.params };
    if ((target as HTMLInputElement).checked) {
      params.startRatio = params.startRatio ?? 0.7;
      params.endRatio = params.endRatio ?? 0.05;
    } else {
      delete params.startRatio;
      delete params.endRatio;
    }
    return { ...tone, params };
  }
  // focus: 最大半径(outerRadius)の有効/無効トグル。既定値は領域の半対角線程度(未指定時の
  // 見た目=領域端に近い、体感差の少ない初期値にする)。
  if (field === "outerRadiusEnabled") {
    const params = { ...tone.params };
    if ((target as HTMLInputElement).checked) {
      params.outerRadius = params.outerRadius ?? Math.max(0.01, Math.hypot(tone.size.x, tone.size.y) / 2);
    } else {
      delete params.outerRadius;
    }
    return { ...tone, params };
  }
  return null;
}

/**
 * トーンの `params` 個別フィールド更新(SETTINGS パネルの種別別 number 入力)。ギズモ拡縮では params の
 * 長さ系はスケールしない(v1 は size のみ、Docs/Feature-ScreenTones.md 組み込みチェックリスト)ので、
 * この経路だけが params を書き換える(center はドラッグハンドル、`handlePageObjectsPointerMove` 側)。
 */
function updateToneParamField(tone: ToneObject, field: string, target: HTMLInputElement): ToneObject | null {
  const parsed = Number(target.value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const params: ToneParams = { ...tone.params };
  switch (field) {
    case "pitch":
      params.pitch = clampNumber(parsed, TONE_PITCH_MIN, TONE_PITCH_MAX, params.pitch ?? 0.015);
      break;
    case "dotRatio":
      params.dotRatio = clampNumber(parsed, 0, 1, params.dotRatio ?? 0.45);
      break;
    case "angle":
      params.angle = parsed;
      break;
    case "startRatio":
      params.startRatio = clampNumber(parsed, 0, 1, params.startRatio ?? 0.7);
      break;
    case "endRatio":
      params.endRatio = clampNumber(parsed, 0, 1, params.endRatio ?? 0.05);
      break;
    case "lineRatio":
      params.lineRatio = clampNumber(parsed, 0, 1, params.lineRatio ?? 0.35);
      break;
    case "count":
      params.count = clampNumber(Math.round(parsed), 1, TONE_COUNT_MAX, params.count ?? 72);
      break;
    case "length":
      params.length = clampNumber(parsed, 0, 1, params.length ?? 0.7);
      break;
    case "lineWidth":
      params.lineWidth = clampNumber(parsed, 0, 1, params.lineWidth ?? 0.004);
      break;
    case "jitter":
      params.jitter = clampNumber(parsed, 0, 1, params.jitter ?? 0.5);
      break;
    case "innerRadius":
      params.innerRadius = clampNumber(parsed, 0, PAGE_OBJECT_MAX_SIZE, params.innerRadius ?? 0.12);
      break;
    case "outerRadius":
      // トグル(outerRadiusEnabled)で存在する時だけこの入力が出るので、既定の fallback は使われない想定だが
      // 念のため領域端相当の広い値にしておく。
      params.outerRadius = clampNumber(parsed, 0, PAGE_OBJECT_MAX_SIZE, params.outerRadius ?? PAGE_OBJECT_MAX_SIZE);
      break;
    case "density":
      params.density = clampNumber(parsed, 0, 1, params.density ?? 0.35);
      break;
    case "grain":
      params.grain = clampNumber(parsed, TONE_NOISE_GRAIN_MIN, TONE_NOISE_GRAIN_MAX, params.grain ?? 0.003);
      break;
    case "frontRatio":
      params.frontRatio = clampNumber(parsed, 0, 1, params.frontRatio ?? 0.4);
      break;
    case "frontSize":
      params.frontSize = clampNumber(parsed, TONE_SNOW_SIZE_MIN, TONE_SNOW_SIZE_MAX, params.frontSize ?? 0.05);
      break;
    case "backSize":
      params.backSize = clampNumber(parsed, TONE_SNOW_SIZE_MIN, TONE_SNOW_SIZE_MAX, params.backSize ?? 0.03);
      break;
    case "frontBlur":
      params.frontBlur = clampNumber(parsed, 0, TONE_SNOW_BLUR_MAX, params.frontBlur ?? 0.5);
      break;
    case "backBlur":
      params.backBlur = clampNumber(parsed, 0, TONE_SNOW_BLUR_MAX, params.backBlur ?? 0.3);
      break;
    default:
      return null;
  }
  return { ...tone, params };
}

/** 「シャッフル」ボタン。speed/focus/flash の seed を振り直す(Docs/Feature-ScreenTones.md エディタ UI)。 */
function shuffleToneSeed(): void {
  const object = findSelectedObject();
  if (!object || object.kind !== "tone") {
    return;
  }
  commitObjectMutation(object.id, { ...object, seed: randomToneSeed() });
}

/** 確定的なプロパティ変更(色ピッカー/select/number 等の change イベント)を history へ push して保存する。 */
function commitFieldChange(index: number, updated: PageObject): void {
  flushTextHistoryCommit();
  const previous = currentSnapshot();
  pushPageObjectHistory(objectHistory, previous);
  const next = [...state.pageObjectsDraft];
  next[index] = updated;
  state.pageObjectsDraft = next;
  requestRender();
  scheduleSave();
  scheduleLayoutForUpdatedObject(updated);
}

/** main.ts の change 委譲から呼ばれる。プロパティ行(fill/strokeColor/... や text/content のスタイル欄)の入力反映。 */
export function updatePageObjectFieldFromControl(target: HTMLInputElement | HTMLSelectElement): void {
  const object = findSelectedObject();
  if (!object) {
    return;
  }
  const index = state.pageObjectsDraft.findIndex((item) => item.id === object.id);
  if (index < 0) {
    return;
  }

  const contentField = target.dataset.pageObjectContentField;
  if (contentField && (object.kind === "box" || object.kind === "balloon")) {
    const updated =
      object.kind === "box" ? updateBoxContentField(object, contentField, target) : updateBalloonContentField(object, contentField, target);
    if (updated) {
      commitFieldChange(index, updated);
    }
    return;
  }

  const toneParamField = target.dataset.pageObjectToneParam;
  if (toneParamField && object.kind === "tone") {
    const updated = updateToneParamField(object, toneParamField, target as HTMLInputElement);
    if (updated) {
      commitFieldChange(index, updated);
    }
    return;
  }

  const field = target.dataset.pageObjectField;
  if (!field) {
    return;
  }
  if (object.kind === "box") {
    const updated = updateBoxOwnField(object, field, target as HTMLInputElement);
    if (updated) {
      commitFieldChange(index, updated);
    }
    return;
  }
  if (object.kind === "balloon") {
    const updated = updateBalloonOwnField(object, field, target);
    if (updated) {
      commitFieldChange(index, updated);
      // Chronicle Page Flow(§2.6): プロパティパネルでの尻ぽ変更(トグル/幅)も「手動編集」に数える。
      // shape/fill/strokeColor 等の見た目変更はロック対象外(仕様書 §2.6 の「移動/リサイズ/回転/
      // 尻尾変更」に厳密に合わせる判断)。
      if (field === "tailEnabled" || field === "tailWidth") {
        notifyChroniclePageObjectManualEdit(object.id);
      }
    }
    return;
  }
  if (object.kind === "image") {
    const updated = updateImageOwnField(object, field, target);
    if (updated) {
      commitFieldChange(index, updated);
    }
    return;
  }
  if (object.kind === "tone") {
    const updated = updateToneOwnField(object, field, target);
    if (updated) {
      commitFieldChange(index, updated);
    }
    return;
  }
  if (object.kind === "text") {
    const updated = updateTextOwnField(object, field, target);
    if (updated) {
      commitFieldChange(index, updated);
    }
  }
}

/**
 * main.ts の input 委譲から呼ばれる。テキスト本文 textarea(TextObject 自身、または box/balloon の
 * content)。タイピングごとに draft は即座に書き換えて再描画するが、undo 履歴と /api/text-layout の
 * 取得はそれぞれ debounce する(`scheduleTextHistoryCommit`/`scheduleTextLayoutFetch`)。
 */
export function updatePageObjectTextFromInput(target: HTMLTextAreaElement): void {
  const object = findSelectedObject();
  if (!object) {
    return;
  }
  const index = state.pageObjectsDraft.findIndex((item) => item.id === object.id);
  if (index < 0) {
    return;
  }
  let updated: PageObject;
  if (object.kind === "text") {
    updated = { ...object, content: { ...object.content, text: target.value } };
  } else if (object.kind === "box") {
    // content が無い box への入力(A-1): 旧「テキストを載せる」ON 時と同じ既定スタイル(横書き)で新規作成する。
    const content: TextContent = object.content
      ? { ...object.content, text: target.value }
      : { text: target.value, style: { ...DEFAULT_TEXT_STYLE, direction: "horizontal" } };
    updated = { ...object, content };
  } else if (object.kind === "balloon") {
    // balloon は createBalloonObject 時点から content を持つため通常は既存 content の text 更新のみだが、
    // 手動編集などで content が欠けているケースに備えて box と同じ新規作成フォールバックを用意する。
    const content: TextContent = object.content
      ? { ...object.content, text: target.value }
      : { text: target.value, style: { ...DEFAULT_TEXT_STYLE } };
    updated = { ...object, content };
  } else {
    return;
  }
  beginTextHistoryEdit();
  const next = [...state.pageObjectsDraft];
  next[index] = updated;
  state.pageObjectsDraft = next;
  requestRender();
  scheduleSave();
  scheduleLayoutForUpdatedObject(updated);
  scheduleTextHistoryCommit();
}

// --- ギズモ(移動/拡縮/回転)ジェスチャ ---

type ObjectGestureKind = "move" | "scale" | "rotate" | "tail" | "tone-center";
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
  startObject: EditableObject;
  /**
   * 複数選択の移動(C-3)用: kind === "move" の時、選択中の全 editable オブジェクトの開始時点コピー
   * (`objectId` 自身を含む)。scale/rotate/tail/tone-center は単一選択時にしか起きないため、
   * その場合は `[cloneEditableObjectForDrag(object)]` の1件だけを持たせて経路を統一している。
   */
  moveGroupStart: EditableObject[];
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

function objectIdFromEventTarget(
  target: EventTarget | null
): { objectId: string | null; handleKind: "scale" | "rotate" | "tail" | "tone-center" | null } {
  if (!(target instanceof Element)) {
    return { objectId: null, handleKind: null };
  }
  const handle = target.closest<SVGElement>("[data-page-object-handle]");
  if (handle) {
    const raw = handle.getAttribute("data-page-object-handle");
    const kind = raw === "rotate" ? "rotate" : raw === "tail" ? "tail" : raw === "tone-center" ? "tone-center" : "scale";
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
    // 背景(ステージの空き領域)クリック = 選択解除(C-2: 修飾キーによらず常に全解除)。
    if (state.selectedPageObjectIds.length > 0 || lightbox.selectedPanelId) {
      flushTextHistoryCommit();
      state.selectedPageObjectIds = [];
      lightbox.selectedPanelId = null;
      requestRender();
    }
    return true;
  }

  const object = state.pageObjectsDraft.find((item) => item.id === objectId);
  if (!object || !isEditableObject(object)) {
    return true;
  }

  event.preventDefault();

  // ギズモハンドル(拡縮/回転/しっぽ/トーン中心)は単一選択時にしか描画されない(C-3)。
  // ハンドルへの pointerdown は選択集合を変更せず、既存の単一選択オブジェクトを対象に操作する。
  if (handleKind) {
    if (handleKind === "rotate" && event.detail >= 2) {
      // 回転ハンドルのダブルクリック = 0° リセット(paste/crop の前例踏襲)。
      commitObjectMutation(objectId, { ...object, rotation: 0 });
      return true;
    }
    beginObjectDrag(event, object, handleKind);
    return true;
  }

  const modifiers: PageObjectSelectionModifiers = { shiftKey: event.shiftKey, altKey: event.altKey };

  if (modifiers.shiftKey) {
    // Shift+クリックはトグル選択のみでドラッグは開始しない。トグルで対象(グループ)を選択から
    // 外した直後にその対象を掴んだままドラッグを始めてしまうと、選択解除したはずのオブジェクトまで
    // 一緒に動いてしまう(collectMoveGroupStart の「クリック対象は常に含める」防御と衝突する)ため、
    // Shift は選択操作に専念させる(C-2)。
    flushTextHistoryCommit();
    state.selectedPageObjectIds = resolvePageObjectSelectionClick(state.pageObjectsDraft, state.selectedPageObjectIds, objectId, modifiers);
    lightbox.selectedPanelId = null;
    state.dialogueDrawerOpen = false;
    requestRender();
    return true;
  }

  // オブジェクト本体クリック: 選択集合の解決(C-2)。既に複数選択に含まれるオブジェクトを
  // 修飾キー無しでクリックした場合は選択を維持したままドラッグを始める(「選択中オブジェクトの
  // どれかをドラッグ→全員に同じ delta」= 掴んだだけで選択が1個に潰れてはいけない、C-3)。
  const keepExistingSelection =
    !modifiers.altKey && state.selectedPageObjectIds.length > 1 && state.selectedPageObjectIds.includes(objectId);
  if (!keepExistingSelection) {
    const nextSelection = resolvePageObjectSelectionClick(state.pageObjectsDraft, state.selectedPageObjectIds, objectId, modifiers);
    if (!sameSelection(nextSelection, state.selectedPageObjectIds) || lightbox.selectedPanelId) {
      flushTextHistoryCommit();
      state.selectedPageObjectIds = nextSelection;
      lightbox.selectedPanelId = null;
      state.dialogueDrawerOpen = false;
      requestRender();
    }
  }

  beginObjectDrag(event, object, "move");
  return true;
}

/** ドラッグ開始直前のオブジェクトを deep copy する(以後のポインタ移動が draft を直接書き換えるため、参照共有だと巻き添えで壊れる)。 */
function cloneEditableObjectForDrag(object: EditableObject): EditableObject {
  if (object.kind === "box" || object.kind === "image") {
    return { ...object, position: { ...object.position }, size: { ...object.size } };
  }
  if (object.kind === "balloon") {
    return {
      ...object,
      position: { ...object.position },
      size: { ...object.size },
      tail: object.tail ? { tip: { ...object.tail.tip }, width: object.tail.width } : object.tail
    };
  }
  if (object.kind === "tone") {
    return {
      ...object,
      position: { ...object.position },
      size: { ...object.size },
      params: { ...object.params, center: object.params.center ? { ...object.params.center } : object.params.center }
    };
  }
  return { ...object, position: { ...object.position }, content: { ...object.content, style: { ...object.content.style } } };
}

/**
 * kind === "move" の時、選択中の全 editable オブジェクト(`object` 自身を含む)の開始時点コピーを集める。
 * それ以外のジェスチャは単一選択時にしか起きないため `object` 自身だけの1件配列にする(C-3)。
 */
function collectMoveGroupStart(object: EditableObject, kind: ObjectGestureKind): EditableObject[] {
  if (kind !== "move") {
    return [cloneEditableObjectForDrag(object)];
  }
  const selectedIds = new Set(state.selectedPageObjectIds);
  const members = state.pageObjectsDraft.filter(
    (item): item is EditableObject => isEditableObject(item) && selectedIds.has(item.id)
  );
  // 選択集合が(何らかの理由で)クリックしたオブジェクト自身を含んでいない場合の防御 -- 常にドラッグ対象を含める。
  if (!members.some((item) => item.id === object.id)) {
    members.push(object);
  }
  return members.map(cloneEditableObjectForDrag);
}

function beginObjectDrag(event: PointerEvent, object: EditableObject, kind: ObjectGestureKind): void {
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
    startObject: cloneEditableObjectForDrag(object),
    moveGroupStart: collectMoveGroupStart(object, kind),
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

/** text の拡縮ドラッグ: style.size を factor 倍(クランプ後の実効倍率で maxWidth も同率スケール)。 */
function scaleTextObject(start: TextObject, factor: number): TextObject {
  const nextSize = clampNumber(start.content.style.size * factor, TEXT_SIZE_MIN, TEXT_SIZE_MAX, start.content.style.size);
  const effectiveFactor = start.content.style.size > 0 ? nextSize / start.content.style.size : 1;
  const nextStyle: TextStyle = { ...start.content.style, size: nextSize };
  const updated: TextObject = { ...start, content: { ...start.content, style: nextStyle } };
  if (start.maxWidth !== undefined) {
    updated.maxWidth = clampNumber(start.maxWidth * effectiveFactor, PAGE_OBJECT_MIN_SIZE, PAGE_OBJECT_MAX_SIZE, start.maxWidth);
  }
  return updated;
}

/**
 * balloon の拡縮ドラッグ: box と同じく size を変えるが、tail はローカル座標(中心=原点)なので
 * size の実効倍率でそのままスケールすれば移動/回転と独立に追従する(tip の長さも tail.width も同率)。
 */
function scaleBalloonObject(start: BalloonObject, nextSize: { x: number; y: number }): BalloonObject {
  const factor = start.size.x > 0 ? nextSize.x / start.size.x : 1;
  const updated: BalloonObject = { ...start, size: nextSize };
  if (start.tail) {
    updated.tail = {
      tip: clampTailTip({ x: start.tail.tip.x * factor, y: start.tail.tip.y * factor }),
      width: clampNumber(start.tail.width * factor, 0, PAGE_OBJECT_MAX_SIZE, start.tail.width)
    };
  }
  return updated;
}

/** tail.tip(ローカル座標)を ± BALLOON_TAIL_TIP_CLAMP へ収める(`normalizePageObjects` の clamp と同じ範囲)。 */
function clampTailTip(tip: { x: number; y: number }): { x: number; y: number } {
  return {
    x: clampNumber(tip.x, -BALLOON_TAIL_TIP_CLAMP, BALLOON_TAIL_TIP_CLAMP, 0),
    y: clampNumber(tip.y, -BALLOON_TAIL_TIP_CLAMP, BALLOON_TAIL_TIP_CLAMP, 0)
  };
}

/** トーン(focus/flash)の params.center(ローカル座標)を ± TONE_CENTER_CLAMP へ収める(normalize と同じ範囲)。 */
function clampToneCenter(center: { x: number; y: number }): { x: number; y: number } {
  return {
    x: clampNumber(center.x, -TONE_CENTER_CLAMP, TONE_CENTER_CLAMP, 0),
    y: clampNumber(center.y, -TONE_CENTER_CLAMP, TONE_CENTER_CLAMP, 0)
  };
}

export function handlePageObjectsPointerMove(event: PointerEvent): boolean {
  if (!objectDrag || event.pointerId !== objectDrag.pointerId) {
    return false;
  }
  const drag = objectDrag;

  if (drag.kind === "move") {
    // 複数選択の移動(C-3): moveGroupStart(単一選択時は1件だけ)へ同じ delta を適用する。
    // 開始位置からの絶対 delta を毎回適用するので、pointermove を何度呼んでも誤差が蓄積しない。
    if (!state.pageObjectsDraft.some((item) => item.id === drag.objectId)) {
      objectDrag = null;
      return false;
    }
    const dx = (event.clientX - drag.startClientX) / drag.pxPerUnit;
    const dy = (event.clientY - drag.startClientY) / drag.pxPerUnit;
    state.pageObjectsDraft = applyGroupMoveDelta(state.pageObjectsDraft, drag.moveGroupStart, dx, dy);
    requestRender();
    return true;
  }

  const index = state.pageObjectsDraft.findIndex((item) => item.id === drag.objectId);
  if (index < 0) {
    objectDrag = null;
    return false;
  }
  const startBox = gizmoBoxForPageObject(drag.startObject);
  let updated: EditableObject;
  if (drag.kind === "scale") {
    const dist = Math.hypot(event.clientX - drag.centerScreenX, event.clientY - drag.centerScreenY);
    const factor = dist / Math.max(1, drag.startDist);
    if (drag.startObject.kind === "box" || drag.startObject.kind === "image" || drag.startObject.kind === "tone") {
      // トーンは v1 では size のみスケールする(params の長さ系は変えない、Docs/Feature-ScreenTones.md
      // 組み込みチェックリスト -- box/image と同じ扱い)。
      const box = scaleGizmoBoxAboutCenter(startBox, factor, PAGE_OBJECT_MIN_SIZE, PAGE_OBJECT_MAX_SIZE);
      updated = { ...drag.startObject, size: box.size };
    } else if (drag.startObject.kind === "balloon") {
      const box = scaleGizmoBoxAboutCenter(startBox, factor, PAGE_OBJECT_MIN_SIZE, PAGE_OBJECT_MAX_SIZE);
      updated = scaleBalloonObject(drag.startObject, box.size);
    } else {
      updated = scaleTextObject(drag.startObject, factor);
    }
  } else if (drag.kind === "tail") {
    if (drag.startObject.kind !== "balloon") {
      // tail ハンドルは balloon にしか出さないので通常到達しない防御分岐。
      objectDrag = null;
      return false;
    }
    const dxScreen = (event.clientX - drag.startClientX) / drag.pxPerUnit;
    const dyScreen = (event.clientY - drag.startClientY) / drag.pxPerUnit;
    // 画面デルタを -rotation 回してローカル軸のデルタにする(`panGestureCrop` と同じ考え方)。
    const rotation = drag.startObject.rotation;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const localDx = dxScreen * cos + dyScreen * sin;
    const localDy = -dxScreen * sin + dyScreen * cos;
    const startTip = drag.startObject.tail?.tip ?? { x: 0, y: 0 };
    const nextTip = clampTailTip({ x: startTip.x + localDx, y: startTip.y + localDy });
    updated = { ...drag.startObject, tail: { tip: nextTip, width: drag.startObject.tail?.width ?? DEFAULT_BALLOON_TAIL_WIDTH } };
  } else if (drag.kind === "tone-center") {
    if (drag.startObject.kind !== "tone") {
      // tone-center ハンドルは tone(focus/flash)にしか出さないので通常到達しない防御分岐。
      objectDrag = null;
      return false;
    }
    const dxScreen = (event.clientX - drag.startClientX) / drag.pxPerUnit;
    const dyScreen = (event.clientY - drag.startClientY) / drag.pxPerUnit;
    // 画面デルタを -rotation 回してローカル軸のデルタにする(tail ハンドルと同じ考え方)。
    const rotation = drag.startObject.rotation;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const localDx = dxScreen * cos + dyScreen * sin;
    const localDy = -dxScreen * sin + dyScreen * cos;
    const startCenter = drag.startObject.params.center ?? { x: 0, y: 0 };
    const nextCenter = clampToneCenter({ x: startCenter.x + localDx, y: startCenter.y + localDy });
    updated = { ...drag.startObject, params: { ...drag.startObject.params, center: nextCenter } };
  } else {
    const angle = Math.atan2(event.clientY - drag.centerScreenY, event.clientX - drag.centerScreenX);
    const box = rotateGizmoBox(startBox, drag.startAngle, angle, event.shiftKey, ROTATE_SNAP_RAD);
    updated = { ...drag.startObject, rotation: box.rotation };
  }
  const next = [...state.pageObjectsDraft];
  next[index] = updated;
  state.pageObjectsDraft = next;
  requestRender();
  if (drag.kind === "scale" && updated.kind === "text") {
    // 拡縮ドラッグ中はサイズが連続的に変わるので、レイアウト取得は debounce に任せる(ギズモ枠自体は
    // 直近のキャッシュ/仮サイズで追従し、確定した見た目は pointerup で最新化される)。
    scheduleTextLayoutFetch(updated.content, updated.maxWidth);
  } else if (drag.kind === "scale" && updated.kind === "balloon" && updated.content) {
    scheduleTextLayoutFetch(updated.content, balloonContentMaxWidth(updated.shape, updated.size, updated.content.style.direction));
  }
  return true;
}

function editableObjectUnchanged(a: EditableObject, b: EditableObject): boolean {
  if (a.position.x !== b.position.x || a.position.y !== b.position.y || a.rotation !== b.rotation) {
    return false;
  }
  if (a.kind === "box" && b.kind === "box") {
    return a.size.x === b.size.x && a.size.y === b.size.y;
  }
  if (a.kind === "image" && b.kind === "image") {
    return a.size.x === b.size.x && a.size.y === b.size.y;
  }
  if (a.kind === "tone" && b.kind === "tone") {
    if (a.size.x !== b.size.x || a.size.y !== b.size.y) {
      return false;
    }
    const ac = a.params.center;
    const bc = b.params.center;
    if (Boolean(ac) !== Boolean(bc)) {
      return false;
    }
    if (ac && bc && (ac.x !== bc.x || ac.y !== bc.y)) {
      return false;
    }
    return true;
  }
  if (a.kind === "text" && b.kind === "text") {
    return a.content.style.size === b.content.style.size && a.maxWidth === b.maxWidth;
  }
  if (a.kind === "balloon" && b.kind === "balloon") {
    if (a.size.x !== b.size.x || a.size.y !== b.size.y) {
      return false;
    }
    const at = a.tail;
    const bt = b.tail;
    if (Boolean(at) !== Boolean(bt)) {
      return false;
    }
    if (at && bt && (at.tip.x !== bt.tip.x || at.tip.y !== bt.tip.y || at.width !== bt.width)) {
      return false;
    }
    return true;
  }
  return false;
}

function commitObjectMutation(objectId: string, updated: EditableObject): void {
  const index = state.pageObjectsDraft.findIndex((item) => item.id === objectId);
  if (index < 0) {
    return;
  }
  flushTextHistoryCommit();
  const previous = currentSnapshot();
  pushPageObjectHistory(objectHistory, previous);
  const next = [...state.pageObjectsDraft];
  next[index] = updated;
  state.pageObjectsDraft = next;
  requestRender();
  scheduleSave();
  // Chronicle Page Flow(Docs/Done/Feature-ChroniclePageFlow.md §2.6): 回転ハンドルのダブルクリックリセットも
  // 「回転」の手動編集にあたるため、対応する自動生成 placement をロックする。
  notifyChroniclePageObjectManualEdit(objectId);
}

export function handlePageObjectsPointerUp(event: PointerEvent): boolean {
  if (!objectDrag || event.pointerId !== objectDrag.pointerId) {
    return false;
  }
  const drag = objectDrag;
  objectDrag = null;
  const current = state.pageObjectsDraft.find((item) => item.id === drag.objectId);
  // 複数選択の移動でも、全員が同じ delta で動くため primary(drag.objectId)の変化だけ見れば
  // 「何か動いたか」を判定できる(dx=dy=0 なら moveGroupStart の全員も unchanged)。
  if (current && isEditableObject(current) && !editableObjectUnchanged(current, drag.startObject)) {
    // 実際に動いた/拡縮/回転した時だけ history へ push + 保存する(単クリックのみは選択だけで完結)。
    // 選択オブジェクトが何個でも undo は1エントリ(pushPageObjectHistory は1回だけ呼ぶ)。
    pushPageObjectHistory(objectHistory, drag.startSnapshot);
    scheduleSave();
    if (current.kind === "text") {
      // ドラッグ確定時は debounce を待たず即座に最新レイアウトを取りに行く。
      void ensureTextLayout(current.content, current.maxWidth);
    } else if (current.kind === "balloon" && current.content) {
      void ensureTextLayout(current.content, balloonContentMaxWidth(current.shape, current.size, current.content.style.direction));
    }
    // Chronicle Page Flow(§2.6): move/scale/rotate/tail のいずれのドラッグも「手動編集」として
    // 対応する自動生成 placement をロックする(drag.kind で絞らず、実変化があった時だけ呼ぶ)。
    // 複数選択の move は動いた各オブジェクトに対して呼ぶ(C-3)。
    if (drag.kind === "move") {
      for (const start of drag.moveGroupStart) {
        notifyChroniclePageObjectManualEdit(start.id);
      }
    } else {
      notifyChroniclePageObjectManualEdit(current.id);
    }
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
  state.selectedPageObjectIds = drag.startSnapshot.selectedIds;
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
  gizmo.querySelector<SVGCircleElement>("#pageObjectGizmoTail")?.setAttribute("r", String(radius));
  gizmo.querySelector<SVGCircleElement>("#pageObjectGizmoToneCenter")?.setAttribute("r", String(radius));
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

/**
 * オブジェクトモード表示中の全 text(text オブジェクト本体 + box/balloon の content)のレイアウトを
 * (未キャッシュなら)取得しにいく。lightbox を開いた直後・追加/削除以外での draft 差し替え(undo/redo 等)
 * の後に呼ぶ想定 -- debounce しない即時取得(既にキャッシュ/inflight なら何もしない安全な呼び出し)。
 */
export function ensureAllPageObjectTextLayouts(objects: readonly PageObject[]): void {
  for (const object of objects) {
    if (object.kind === "text") {
      void ensureTextLayout(object.content, object.maxWidth);
    } else if (object.kind === "box" && object.content) {
      void ensureTextLayout(object.content, contentMaxWidth(object.size, object.content.style.direction));
    } else if (object.kind === "balloon" && object.content) {
      void ensureTextLayout(object.content, balloonContentMaxWidth(object.shape, object.size, object.content.style.direction));
    }
  }
}

/**
 * `GET /api/fonts` を初回オブジェクトモード表示時に1回だけ取得してキャッシュする(`state.pageObjectFonts`)。
 * 既に取得済み/取得中なら何もしない -- `openPagePanelLightbox`(objects が既定モードの時)と
 * `setPagePanelMode("objects")`(コマモードから切り替えた時)の両方から呼ぶ。
 */
export function ensureFontsLoaded(): void {
  if (state.pageObjectFonts.status === "loading" || state.pageObjectFonts.status === "ready") {
    return;
  }
  state.pageObjectFonts = { ...state.pageObjectFonts, status: "loading" };
  void (async () => {
    try {
      const result = await api<{ fonts: FontSummary[] }>("/api/fonts");
      state.pageObjectFonts = { status: "ready", fonts: result.fonts };
    } catch (error) {
      state.pageObjectFonts = { status: "error", fonts: [] };
      pushToast(error instanceof Error ? error.message : String(error), "error");
    }
    requestRender();
  })();
}

// --- グループ化(Docs/Feature-PageEditSidebarUx.md 課題C-4) ---

/** 「グループ化」: 選択中(2個以上)へ新規ユニーク groupId を割り当てる(既存グループ混在は新IDへ結合)。 */
function groupSelectedPageObjects(): void {
  const ids = state.selectedPageObjectIds;
  if (ids.length < 2) {
    return;
  }
  flushTextHistoryCommit();
  const previous = currentSnapshot();
  pushPageObjectHistory(objectHistory, previous);
  state.pageObjectsDraft = applyGroupId(state.pageObjectsDraft, ids, crypto.randomUUID());
  requestRender();
  scheduleSave();
}

/** 「グループ解除」: 選択中オブジェクトの groupId を外す(選択中に groupId 持ちが1件も無ければ何もしない)。 */
function ungroupSelectedPageObjects(): void {
  const ids = state.selectedPageObjectIds;
  if (ids.length === 0) {
    return;
  }
  const idSet = new Set(ids);
  const hasGroupedSelection = state.pageObjectsDraft.some((object) => idSet.has(object.id) && object.groupId !== undefined);
  if (!hasGroupedSelection) {
    return;
  }
  flushTextHistoryCommit();
  const previous = currentSnapshot();
  pushPageObjectHistory(objectHistory, previous);
  state.pageObjectsDraft = clearGroupId(state.pageObjectsDraft, ids);
  requestRender();
  scheduleSave();
}

registerActions({
  "add-page-object-box": () => addBoxObject(),
  "add-page-object-balloon": () => addBalloonObject(),
  "add-page-object-text": () => addTextObject(),
  "add-page-object-tone": () => addToneObject(),
  "shuffle-tone-seed": () => shuffleToneSeed(),
  "delete-selected-page-object": () => deleteSelectedPageObject(),
  "page-object-bring-front": () => bringSelectedToFront(),
  "page-object-send-back": () => sendSelectedToBack(),
  "group-selected-page-objects": () => groupSelectedPageObjects(),
  "ungroup-selected-page-objects": () => ungroupSelectedPageObjects(),
  "select-page-layer": (id) => selectPageLayer(id, modifiersForLastLayerSelectClick),
  "toggle-page-layer-visibility": (id) => togglePageLayerVisibility(id),
  "toggle-page-layer-hide-non-image": () => togglePageLayerHideNonImage(),
  "show-all-page-layers": () => showAllPageLayers(),
  "move-page-layer-up": (id) => stepPageLayer(id, "up"),
  "move-page-layer-down": (id) => stepPageLayer(id, "down"),
  "page-objects-undo": () => undoPageObjectsAction(),
  "page-objects-redo": () => redoPageObjectsAction(),
  "toggle-page-object-image-picker": (id) => togglePageObjectImagePicker(id),
  "pick-page-object-image": (id) => {
    void pickPageObjectImage(id);
  }
});

registerEventBinder(bindPageLayerEvents);
