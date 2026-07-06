import { DEFAULT_POSE_MODEL_BASE_URL } from "../shared/constants";
import { requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { persistProjectDraft } from "./draftStore";
import { clampNumber, imageToRawData } from "./clientUtils";
import { formatModelBytes } from "./websam/models";
import { formatCssNumber } from "./format";
import { pointerToSvgViewBoxPoint } from "./maskCanvas";
import { buildPoseModelUrls, defaultPoseModel, isCigposeModel, poseModelById } from "./pose/models";
import type { PoseWorkerProgress, PoseWorkerRequest, PoseWorkerResponse } from "./pose/types";
import type { PoseDraft, PosePoint } from "./poseTypes";
import { OPENPOSE_BONES } from "./poseTypes";
import {
  applyPoseThreshold,
  cloneRemovedBones,
  clonePoses,
  defaultPoseDraft,
  mediapipePosesToOpenPose,
  normalizePoseDraft,
  poseBoneConstraintForJoint,
  poseDescendants,
  projectPointToBoneCircle,
  rotatePointAround,
  withRemovedBone
} from "./poseDraft";
import type { PoseBoneConstraint } from "./poseDraft";
import { OPENPOSE_JOINT_PARENT } from "./poseDraft";

interface ActivePoseJointDrag {
  pointerId: number;
  assetId: string;
  /** `PoseDraft.poses` 内の何人目か */
  poseIndex: number;
  jointIndex: number;
  start: { x: number; y: number };
  current: { x: number; y: number };
  /** 閾値を超えて動いたら true。click（visible 復帰）と drag（移動）の判定に使う。 */
  moved: boolean;
  /** Shift ドラッグ時の回転拘束（骨長固定）。親を持たない関節などは null。 */
  constraint: PoseBoneConstraint | null;
  /** ドラッグ開始時点の関節座標のスナップショット（FK の子孫回転計算に使う）。 */
  startPoints: PosePoint[];
  /** ドラッグ関節の親 index（`OPENPOSE_JOINT_PARENT`）。ルート（neck）は undefined。 */
  parentIndex: number | undefined;
  /** ドラッグ関節の子孫 index 一覧（FK で一緒に回す）。 */
  descendants: number[];
  /** 直近の move で算出した「jointIndex → 新座標」。finish はこれを確定する。 */
  pending: Map<number, { x: number; y: number }> | null;
}

const POSE_JOINT_DRAG_THRESHOLD = 3;
let activePoseJointDrag: ActivePoseJointDrag | null = null;

/** ポーズ編集の Undo スナップショット（asset ごと）。編集直前の poses / removedBones を積む。 */
interface PoseEditSnapshot {
  poses: PosePoint[][] | null;
  removedBones: number[][] | undefined;
  source: "detected" | "edited";
}
const poseUndoStacks = new Map<string, PoseEditSnapshot[]>();
const POSE_UNDO_LIMIT = 50;

export interface PoseEdgeRef {
  poseIndex: number;
  boneIndex: number;
}
/** 選択中のエッジ集合（中点/重心に × を出す・一括削除/移動/回転の対象）。同一人物 index に限定。永続化しない。 */
let selectedPoseEdges: PoseEdgeRef[] = [];

/** マルチ選択の一括移動 / 回転FK ドラッグ。 */
interface ActivePoseSelectionDrag {
  pointerId: number;
  assetId: string;
  poseIndex: number;
  /** 平行移動で動かす関節（選択ボーンの端点）。 */
  moveIndices: number[];
  /** 回転FKで動かす関節（選択関節＋子孫からヒンジを除く）。 */
  rotateIndices: number[];
  /** 回転FKのヒンジ（最も浅い選択関節）の座標。 */
  pivot: { x: number; y: number };
  startPoints: PosePoint[];
  start: { x: number; y: number };
  moved: boolean;
  pending: Map<number, { x: number; y: number }> | null;
}
let activePoseSelectionDrag: ActivePoseSelectionDrag | null = null;

/** 矩形マルチ選択（ラバーバンド）。 */
interface ActivePoseMarquee {
  pointerId: number;
  assetId: string;
  start: { x: number; y: number };
  current: { x: number; y: number };
  /** Shift 押下で開始＝既存選択へ追加。 */
  additive: boolean;
  moved: boolean;
}
let activePoseMarquee: ActivePoseMarquee | null = null;
const POSE_MARQUEE_THRESHOLD = 4;

let poseWorker: Worker | null = null;
let poseCigposeWorker: Worker | null = null;
let poseRequestId = 0;
let latestPoseLoadRequestId = 0;
let latestPoseDetectRequestId = 0;
let posePendingDetect = false;

// ---- Pose worker 統合（MediaPipe / CIGPose）----
// WebSAM worker 統合（ensureWebSamWorker / handleWebSamWorkerResponse）と同型。
// model.kind ごとに worker を使い分ける（両者は同じ PoseWorkerRequest/Response を話す）:
//   - mediapipe: pose-worker.js（IIFE / classic worker。MediaPipe の wasm グルーが
//     module worker 非対応のため `{ type: "module" }` を付けない）
//   - cigpose:   pose-cigpose-worker.js（ESM / module worker。onnxruntime-web は
//     import.meta を使う wasm ローダのため module worker 必須）
type PoseWorkerKind = "mediapipe" | "cigpose";

function poseWorkerKind(draft: PoseDraft): PoseWorkerKind {
  const model = poseModelById(draft.modelId) ?? defaultPoseModel();
  return isCigposeModel(model) ? "cigpose" : "mediapipe";
}

function attachPoseWorkerHandlers(worker: Worker) {
  worker.addEventListener("message", (event: MessageEvent<PoseWorkerResponse>) => {
    void handlePoseWorkerResponse(event.data);
  });
  worker.addEventListener("error", (event) => {
    updateActivePoseDraft({
      modelStatus: "error",
      modelError: event.message || "Pose Worker initialization failed.",
      modelStatusText: "Error"
    });
  });
}

function ensurePoseWorker(kind: PoseWorkerKind) {
  if (kind === "cigpose") {
    if (!poseCigposeWorker) {
      poseCigposeWorker = new Worker("/pose-cigpose-worker.js", { type: "module" });
      attachPoseWorkerHandlers(poseCigposeWorker);
    }
    return poseCigposeWorker;
  }
  if (!poseWorker) {
    poseWorker = new Worker("/pose-worker.js");
    attachPoseWorkerHandlers(poseWorker);
  }
  return poseWorker;
}

function postPoseMessage(message: PoseWorkerRequest, kind: PoseWorkerKind) {
  ensurePoseWorker(kind).postMessage(message);
}

function nextPoseRequestId() {
  poseRequestId += 1;
  return poseRequestId;
}

export function poseDraftForAsset(assetId: string | null | undefined) {
  const stored = assetId ? state.poseDrafts[assetId] : null;
  if (!stored) {
    return null;
  }
  const normalized = normalizePoseDraft(stored);
  state.poseDrafts[normalized.parentAssetId] = normalized;
  return normalized;
}

function setPoseDraft(draft: PoseDraft) {
  const normalized = normalizePoseDraft(draft);
  state.poseDrafts[normalized.parentAssetId] = normalized;
  if (state.currentProjectId) {
    persistProjectDraft(state.currentProjectId);
  }
}

export function ensurePoseDraft(assetId: string) {
  const draft = poseDraftForAsset(assetId) ?? defaultPoseDraft(assetId);
  state.poseDrafts[assetId] = draft;
  return draft;
}

function updateActivePoseDraft(patch: Partial<PoseDraft>) {
  const assetId = state.activeAssetId;
  const draft = assetId ? poseDraftForAsset(assetId) : null;
  if (!assetId || !draft) {
    return;
  }
  setPoseDraft({ ...draft, ...patch });
  requestRender();
}

async function loadActivePoseModel() {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensurePoseDraft(assetId);
  const model = poseModelById(draft.modelId) ?? defaultPoseModel();
  const urls = buildPoseModelUrls(DEFAULT_POSE_MODEL_BASE_URL, model);
  if (!urls) {
    setPoseDraft({
      ...draft,
      modelStatus: "missing-url",
      modelError: "ポーズモデルURLが未設定です。",
      modelStatusText: "モデルURL未設定"
    });
    requestRender();
    return;
  }
  const requestId = nextPoseRequestId();
  latestPoseLoadRequestId = requestId;
  setPoseDraft({
    ...draft,
    modelStatus: "downloading",
    modelDownloadProgress: 0,
    modelError: "",
    modelStatusText: "モデル確認中"
  });
  requestRender();
  postPoseMessage({ type: "load-model", requestId, model, urls }, isCigposeModel(model) ? "cigpose" : "mediapipe");
}

/**
 * 選択中モデルの OPFS キャッシュ有無だけを worker へ問い合わせる（DL・初期化はしない）。
 * 応答（cache-status）でキャッシュ済みなら自動ロードする。ポーズタブ表示時・モデル切替時に呼ぶ。
 * すでにロード/検出が進んでいる状態では probe しない（無駄な再ロードを避ける）。
 */
export function probeActivePoseModelCache() {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensurePoseDraft(assetId);
  const inFlight =
    draft.modelStatus === "ready" ||
    draft.modelStatus === "downloading" ||
    draft.modelStatus === "initializing" ||
    draft.modelStatus === "detecting";
  if (inFlight) {
    return;
  }
  const model = poseModelById(draft.modelId) ?? defaultPoseModel();
  postPoseMessage(
    { type: "probe-cache", requestId: nextPoseRequestId(), model },
    isCigposeModel(model) ? "cigpose" : "mediapipe"
  );
}

async function requestPoseDetect() {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  const draft = ensurePoseDraft(assetId);
  if (draft.modelStatus !== "ready") {
    posePendingDetect = true;
    if (
      draft.modelStatus === "idle" ||
      draft.modelStatus === "not-cached" ||
      draft.modelStatus === "cached" ||
      draft.modelStatus === "missing-url" ||
      draft.modelStatus === "error"
    ) {
      await loadActivePoseModel();
    }
    return;
  }
  await sendPoseDetect(assetId);
}

async function sendPoseDetect(assetId: string) {
  const image = document.querySelector<HTMLImageElement>("#previewImage");
  const draft = poseDraftForAsset(assetId);
  if (!image || !draft) {
    return;
  }
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error("画像を読み込めませんでした。")), { once: true });
    });
  }
  const raw = imageToRawData(image);
  const requestId = nextPoseRequestId();
  latestPoseDetectRequestId = requestId;
  setPoseDraft({
    ...draft,
    modelStatus: "detecting",
    modelStatusText: "ポーズ検出中",
    modelError: "",
    imageWidth: raw.width,
    imageHeight: raw.height
  });
  requestRender();
  postPoseMessage({ type: "detect", requestId, imageData: raw }, poseWorkerKind(draft));
}

async function resetPoseDetection() {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  const current = ensurePoseDraft(assetId);
  selectedPoseEdges = [];
  clearPoseUndo(assetId);
  setPoseDraft({ ...current, poses: null, removedBones: undefined, source: "detected", enabled: false });
  requestRender();
  await requestPoseDetect();
}

async function handlePoseWorkerResponse(message: PoseWorkerResponse) {
  const assetId = state.activeAssetId;
  const draft = assetId ? poseDraftForAsset(assetId) : null;
  if (!assetId || !draft) {
    return;
  }

  if (message.type === "progress") {
    if (message.requestId < latestPoseLoadRequestId && message.progress.status !== "detecting") {
      return;
    }
    setPoseDraft({
      ...draft,
      modelStatus: message.progress.status,
      modelDownloadProgress: message.progress.totalBytes > 0 ? message.progress.bytesDownloaded / message.progress.totalBytes : 0,
      modelStatusText: poseProgressText(message.progress),
      modelError: ""
    });
    // ダウンロード progress はチャンクごとに大量に届く。毎回フル render すると
    // タブ切替などのクリックが詰まる(体感フリーズ)ため、描画はスロットルする。
    requestPoseProgressRender();
    return;
  }

  if (message.type === "model-ready") {
    if (message.requestId !== latestPoseLoadRequestId) {
      return;
    }
    setPoseDraft({
      ...draft,
      modelStatus: "ready",
      modelDownloadProgress: 1,
      modelStatusText: message.fallback ? "GPU不可のためCPUで初期化" : `${message.backend} 初期化済み`,
      modelError: ""
    });
    requestRender();
    if (posePendingDetect) {
      posePendingDetect = false;
      await sendPoseDetect(assetId);
    }
    return;
  }

  if (message.type === "cache-status") {
    // probe-cache の応答。別モデルへ切替済みなら無視。
    if (message.modelId !== draft.modelId) {
      return;
    }
    if (message.cached) {
      // キャッシュ済み: ロード/初期化/検出のいずれも進行していなければ自動ロード（DL不要で即 ready）。
      const inFlight =
        draft.modelStatus === "ready" ||
        draft.modelStatus === "downloading" ||
        draft.modelStatus === "initializing" ||
        draft.modelStatus === "detecting";
      if (!inFlight) {
        await loadActivePoseModel();
      }
    } else if (draft.modelStatus === "idle") {
      // 未キャッシュ: 自動ダウンロードはせず「未取得」表示に留める。
      setPoseDraft({ ...draft, modelStatus: "not-cached", modelStatusText: "未取得（未DL）" });
      requestRender();
    }
    return;
  }

  if (message.type === "detected") {
    if (message.requestId !== latestPoseDetectRequestId) {
      return;
    }
    const current = poseDraftForAsset(assetId);
    if (!current) {
      return;
    }
    // 新規検出結果に切り替わるので、手動のエッジ削除・Undo 履歴はリセットする。
    selectedPoseEdges = [];
    clearPoseUndo(assetId);
    const width = current.imageWidth ?? 0;
    const height = current.imageHeight ?? 0;
    const poses = width > 0 && height > 0 ? mediapipePosesToOpenPose(message.landmarks, width, height, current.keypointThreshold) : [];
    if (poses.length === 0) {
      setPoseDraft({
        ...current,
        modelStatus: "ready",
        modelStatusText: "人物ポーズを検出できませんでした",
        modelError: "",
        poses: null,
        removedBones: undefined
      });
      requestRender();
      return;
    }
    setPoseDraft({
      ...current,
      modelStatus: "ready",
      modelStatusText: poses.length > 1 ? `検出完了（${poses.length}人）` : "検出完了",
      modelError: "",
      poses,
      removedBones: undefined,
      source: "detected",
      enabled: true
    });
    requestRender();
    return;
  }

  if (message.type === "error") {
    if (message.requestId < Math.max(latestPoseLoadRequestId, latestPoseDetectRequestId)) {
      return;
    }
    posePendingDetect = false;
    setPoseDraft({
      ...draft,
      modelStatus: "error",
      modelError: message.message,
      modelStatusText: "Error"
    });
    requestRender();
  }
}

const POSE_PROGRESS_RENDER_INTERVAL_MS = 150;
let lastPoseProgressRenderAt = 0;

function requestPoseProgressRender() {
  const now = performance.now();
  if (now - lastPoseProgressRenderAt < POSE_PROGRESS_RENDER_INTERVAL_MS) {
    return;
  }
  lastPoseProgressRenderAt = now;
  requestRender();
}

function poseProgressText(progress: PoseWorkerProgress) {
  if (progress.status === "cached") {
    return "キャッシュ済み";
  }
  if (progress.status === "downloading") {
    return `ダウンロード中 ${formatModelBytes(progress.bytesDownloaded)} / ${formatModelBytes(progress.totalBytes)}`;
  }
  if (progress.status === "initializing") {
    return "初期化中";
  }
  if (progress.status === "detecting") {
    return "ポーズ検出中";
  }
  if (progress.status === "not-cached") {
    return "未取得";
  }
  return progress.status;
}

export function updatePoseDraftFromControl(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  options: { commit?: boolean } = {}
) {
  const field = control.dataset.poseField;
  const assetId = state.activeAssetId;
  if (!field || !assetId) {
    return;
  }
  const current = ensurePoseDraft(assetId);
  const next: PoseDraft = { ...current };
  if (field === "enabled" && control instanceof HTMLInputElement) {
    next.enabled = control.checked;
  } else if (field === "strength") {
    next.strength = clampNumber(Number(control.value), 0, 2, 1);
  } else if (field === "startPercent") {
    next.startPercent = clampNumber(Number(control.value), 0, 1, 0);
  } else if (field === "endPercent") {
    next.endPercent = clampNumber(Number(control.value), 0, 1, 1);
  } else if (field === "keypointThreshold") {
    next.keypointThreshold = clampNumber(Number(control.value), 0, 1, 0.5);
    // 検出済みポーズの visible をしきい値で再計算（座標・score は保持、再検出は不要）
    if (next.poses) {
      next.poses = applyPoseThreshold(next.poses, next.keypointThreshold);
    }
  } else if (field === "modelId") {
    const model = poseModelById(control.value);
    if (!model || model.id === current.modelId) {
      return;
    }
    // モデル切替: worker セッションは次回ロード時に張り替わるため、状態を未取得へ戻すだけでよい。
    // 検出済みの points はそのまま保持する（再検出は任意）。
    next.modelId = model.id;
    next.modelStatus = "idle";
    next.modelDownloadProgress = 0;
    next.modelStatusText = "未取得";
    next.modelError = "";
  }
  setPoseDraft(next);
  if (field === "enabled" || field === "modelId" || (field === "keypointThreshold" && options.commit)) {
    requestRender();
  }
  if (field === "modelId") {
    // 切替先モデルがキャッシュ済みなら自動でロード（再試行ボタン不要）。
    probeActivePoseModelCache();
  }
}

/**
 * ポーズタブの関節ドラッグ編集。pointerdown で `.pose-joint` circle を掴み、pointermove では
 * `requestRender()` を呼ばずに SVG 属性を直接書き換える（操作中は再描画しない）。
 * 修飾キーで挙動が変わる:
 *   - 修飾なし: 単一関節を自由移動
 *   - Shift: 単一ボーンを親中心に回転（骨長固定・子孫は追従しない）
 *   - Alt: 回転FK。掴んだ関節＋その子孫を親中心に同角度回転（ルートは全身平行移動）
 * pointerup で移動していなければ「クリック」とみなし、非表示関節のみ visible を復帰する
 * （表示中関節の誤削除を防ぐため visible→非表示トグルは廃止。エッジ削除は中点×で行う）。
 */
function beginPoseJointDrag(event: PointerEvent, joint: SVGCircleElement) {
  const assetId = state.activeAssetId;
  const svg = joint.closest<SVGSVGElement>(".pose-overlay");
  if (!assetId || !svg) {
    return;
  }
  const poseIndex = Number(joint.dataset.poseIndex ?? "-1");
  const jointIndex = Number(joint.dataset.jointIndex ?? "-1");
  const draft = poseDraftForAsset(assetId);
  const points = draft?.poses?.[poseIndex];
  if (!draft || !points || jointIndex < 0 || jointIndex >= points.length) {
    return;
  }
  // 関節を掴んだらエッジ選択は解除（finish の render で × が消える）
  selectedPoseEdges = [];
  const point = pointerToSvgViewBoxPoint(svg, event);
  activePoseJointDrag = {
    pointerId: event.pointerId,
    assetId,
    poseIndex,
    jointIndex,
    start: point,
    current: point,
    moved: false,
    constraint: poseBoneConstraintForJoint(points, jointIndex),
    startPoints: points.map((p) => ({ ...p })),
    parentIndex: OPENPOSE_JOINT_PARENT[jointIndex],
    descendants: poseDescendants(jointIndex),
    pending: null
  };
  try {
    joint.setPointerCapture(event.pointerId);
  } catch {
    // Capture may not be supported in test environments; dragging still works via document-level events.
  }
  joint.classList.add("dragging");
}

function continuePoseJointDrag(event: PointerEvent, svg: SVGSVGElement) {
  const drag = activePoseJointDrag;
  if (!drag) {
    return;
  }
  const point = pointerToSvgViewBoxPoint(svg, event);
  drag.current = point;
  const dx = point.x - drag.start.x;
  const dy = point.y - drag.start.y;
  if (!drag.moved && Math.hypot(dx, dy) > POSE_JOINT_DRAG_THRESHOLD) {
    drag.moved = true;
  }
  if (!drag.moved) {
    return;
  }
  const pending = computePoseDragPositions(drag, point, svg, { fk: event.altKey, rotate: event.shiftKey });
  drag.pending = pending;
  applyPoseDragToSvg(svg, drag.poseIndex, pending);
}

/**
 * ドラッグ中に更新すべき「関節 index → 新座標」を算出する。
 * - Alt（FK）: 親を持つ関節は親中心に掴んだ関節＋子孫を剛体回転（クランプしない＝骨長維持）。
 *   親を持たないルート（neck）は掴んだ関節＋全子孫を平行移動（全身移動）。
 * - Shift: 単一関節を骨長固定で親中心回転（境界クランプあり）。
 * - 修飾なし: 単一関節を自由移動（境界クランプあり）。
 */
function computePoseDragPositions(
  drag: ActivePoseJointDrag,
  cursor: { x: number; y: number },
  svg: SVGSVGElement,
  modifiers: { fk: boolean; rotate: boolean }
): Map<number, { x: number; y: number }> {
  const map = new Map<number, { x: number; y: number }>();
  const origin = drag.startPoints[drag.jointIndex];
  if (modifiers.fk && origin) {
    const anchor = drag.parentIndex !== undefined ? drag.startPoints[drag.parentIndex] : undefined;
    if (anchor) {
      const oldAngle = Math.atan2(origin.y - anchor.y, origin.x - anchor.x);
      const newAngle = Math.atan2(cursor.y - anchor.y, cursor.x - anchor.x);
      const delta = newAngle - oldAngle;
      for (const index of [drag.jointIndex, ...drag.descendants]) {
        const src = drag.startPoints[index];
        if (src) {
          map.set(index, rotatePointAround(src, anchor, delta));
        }
      }
      return map;
    }
    // ルート（親なし）: 掴んだ関節と全子孫を平行移動（全身移動）
    const tx = cursor.x - origin.x;
    const ty = cursor.y - origin.y;
    for (const index of [drag.jointIndex, ...drag.descendants]) {
      const src = drag.startPoints[index];
      if (src) {
        map.set(index, { x: src.x + tx, y: src.y + ty });
      }
    }
    return map;
  }
  const target =
    modifiers.rotate && drag.constraint ? projectPointToBoneCircle(drag.constraint, cursor.x, cursor.y) : cursor;
  map.set(drag.jointIndex, clampPointToPoseBounds(target, svg));
  return map;
}

/** 算出済みの「関節 index → 新座標」を SVG（joint circle と接続する bone line の端点）へ直接反映する。 */
function applyPoseDragToSvg(svg: SVGSVGElement, poseIndex: number, positions: Map<number, { x: number; y: number }>) {
  positions.forEach((pos, jointIndex) => {
    const jointEl = svg.querySelector<SVGCircleElement>(
      `.pose-joint[data-pose-index="${poseIndex}"][data-joint-index="${jointIndex}"]`
    );
    jointEl?.setAttribute("cx", formatCssNumber(pos.x));
    jointEl?.setAttribute("cy", formatCssNumber(pos.y));
  });
  const bones = svg.querySelectorAll<SVGLineElement>(`.pose-bone[data-pose-index="${poseIndex}"]`);
  bones.forEach((bone) => {
    const fromPos = positions.get(Number(bone.dataset.boneFrom ?? "-1"));
    const toPos = positions.get(Number(bone.dataset.boneTo ?? "-1"));
    if (fromPos) {
      bone.setAttribute("x1", formatCssNumber(fromPos.x));
      bone.setAttribute("y1", formatCssNumber(fromPos.y));
    }
    if (toPos) {
      bone.setAttribute("x2", formatCssNumber(toPos.x));
      bone.setAttribute("y2", formatCssNumber(toPos.y));
    }
  });
}

function clampPointToPoseBounds(point: { x: number; y: number }, svg: SVGSVGElement) {
  const viewBox = svg.viewBox.baseVal;
  const width = viewBox && viewBox.width > 0 ? viewBox.width : Number.POSITIVE_INFINITY;
  const height = viewBox && viewBox.height > 0 ? viewBox.height : Number.POSITIVE_INFINITY;
  return {
    x: Math.min(Math.max(point.x, 0), width),
    y: Math.min(Math.max(point.y, 0), height)
  };
}

function finishPoseJointDrag() {
  const drag = activePoseJointDrag;
  activePoseJointDrag = null;
  if (!drag) {
    return;
  }
  const jointEl = document.querySelector<SVGCircleElement>(
    `.pose-joint[data-pose-index="${drag.poseIndex}"][data-joint-index="${drag.jointIndex}"]`
  );
  jointEl?.classList.remove("dragging");
  try {
    jointEl?.releasePointerCapture(drag.pointerId);
  } catch {
    // Capture may already be released.
  }
  const draft = poseDraftForAsset(drag.assetId);
  const points = draft?.poses?.[drag.poseIndex];
  if (!draft || !points) {
    return;
  }
  if (!drag.moved) {
    // クリック（ドラッグなし）: 非表示関節のみ visible を復帰する。
    // 表示中関節のクリックは何もしない（誤ってエッジを消さないため）。
    const currentPoint = points[drag.jointIndex];
    if (!currentPoint || currentPoint.visible) {
      return;
    }
    pushPoseUndo(drag.assetId, draft);
    const nextPoints = points.slice();
    nextPoints[drag.jointIndex] = { ...currentPoint, visible: true };
    const nextPoses = draft.poses!.map((pose, index) => (index === drag.poseIndex ? nextPoints : pose));
    setPoseDraft({ ...draft, poses: nextPoses, source: "edited" });
    requestRender();
    return;
  }
  const pending = drag.pending;
  if (!pending || pending.size === 0) {
    return;
  }
  pushPoseUndo(drag.assetId, draft);
  const nextPoints = points.map((point, index) => {
    const pos = pending.get(index);
    return pos ? { ...point, x: pos.x, y: pos.y } : point;
  });
  const nextPoses = draft.poses!.map((pose, index) => (index === drag.poseIndex ? nextPoints : pose));
  setPoseDraft({ ...draft, poses: nextPoses, source: "edited" });
  requestRender();
}

/** ポーズ編集の直前状態（poses / removedBones / source）を Undo スタックへ積む。 */
function pushPoseUndo(assetId: string, draft: PoseDraft) {
  const stack = poseUndoStacks.get(assetId) ?? [];
  stack.push({
    poses: clonePoses(draft.poses),
    removedBones: cloneRemovedBones(draft.removedBones),
    source: draft.source
  });
  while (stack.length > POSE_UNDO_LIMIT) {
    stack.shift();
  }
  poseUndoStacks.set(assetId, stack);
}

/** Ctrl/Cmd+Z: 直前のポーズ編集を1手戻す。ポーズタブ表示中のみ有効。 */
function undoPoseEdit() {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  const stack = poseUndoStacks.get(assetId);
  if (!stack || stack.length === 0) {
    return;
  }
  const draft = poseDraftForAsset(assetId);
  if (!draft) {
    return;
  }
  const snapshot = stack.pop()!;
  selectedPoseEdges = [];
  setPoseDraft({
    ...draft,
    poses: snapshot.poses,
    removedBones: snapshot.removedBones,
    source: snapshot.source
  });
  requestRender();
}

/** asset の Undo スタックを破棄（再検出・リセット・モーダルを閉じたときなど）。 */
function clearPoseUndo(assetId: string | null | undefined) {
  if (assetId) {
    poseUndoStacks.delete(assetId);
  }
}

function isPoseEdgeSelected(poseIndex: number, boneIndex: number): boolean {
  return selectedPoseEdges.some((edge) => edge.poseIndex === poseIndex && edge.boneIndex === boneIndex);
}

/** 選択集合の対象人物 index（先頭要素の poseIndex）。空なら null。 */
function selectedPoseIndex(): number | null {
  return selectedPoseEdges.length > 0 ? selectedPoseEdges[0]!.poseIndex : null;
}

/** 指定人物の選択ボーン端点となる関節 index 一覧（重複除去）。 */
function selectedJointIndices(poseIndex: number): number[] {
  const set = new Set<number>();
  for (const edge of selectedPoseEdges) {
    if (edge.poseIndex !== poseIndex) {
      continue;
    }
    const bone = OPENPOSE_BONES[edge.boneIndex];
    if (bone) {
      set.add(bone[0]);
      set.add(bone[1]);
    }
  }
  return Array.from(set);
}

/** neck をルートとした親チェーンの深さ（ルート＝0）。回転FKのヒンジ選択に使う。 */
function poseJointDepth(jointIndex: number): number {
  let depth = 0;
  let current: number | undefined = jointIndex;
  const seen = new Set<number>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const parentIndex: number | undefined = OPENPOSE_JOINT_PARENT[current];
    if (parentIndex === undefined) {
      break;
    }
    depth += 1;
    current = parentIndex;
  }
  return depth;
}

/**
 * 回転FKのヒンジ（最も浅い選択関節）と、その周りに回す関節（選択関節＋子孫からヒンジを除く）を求める。
 * ヒンジは固定し、そこから深い関節を剛体回転させる。
 */
function selectionRotatePlan(joints: number[], points: PosePoint[]): { pivot: { x: number; y: number }; indices: number[] } {
  let hinge = joints[0] ?? 0;
  let minDepth = Number.POSITIVE_INFINITY;
  for (const joint of joints) {
    const depth = poseJointDepth(joint);
    if (depth < minDepth) {
      minDepth = depth;
      hinge = joint;
    }
  }
  const set = new Set<number>();
  for (const joint of joints) {
    set.add(joint);
    for (const descendant of poseDescendants(joint)) {
      set.add(descendant);
    }
  }
  set.delete(hinge);
  const pivotPoint = points[hinge] ?? { x: 0, y: 0 };
  return { pivot: { x: pivotPoint.x, y: pivotPoint.y }, indices: Array.from(set) };
}

/** ボーン（エッジ）を選択集合へ設定/追加する。additive でないときは置換。異なる人物を選ぶと置換。 */
function selectPoseEdge(poseIndex: number, boneIndex: number, additive: boolean) {
  if (poseIndex < 0 || boneIndex < 0) {
    return;
  }
  const currentPose = selectedPoseIndex();
  if (additive && (currentPose === null || currentPose === poseIndex)) {
    if (isPoseEdgeSelected(poseIndex, boneIndex)) {
      selectedPoseEdges = selectedPoseEdges.filter(
        (edge) => !(edge.poseIndex === poseIndex && edge.boneIndex === boneIndex)
      );
    } else {
      selectedPoseEdges = [...selectedPoseEdges, { poseIndex, boneIndex }];
    }
  } else {
    selectedPoseEdges = [{ poseIndex, boneIndex }];
  }
  requestRender();
}

/** 選択中の全エッジを `removedBones` へ追加して一括削除する。 */
function deleteSelectedPoseEdges() {
  const assetId = state.activeAssetId;
  if (!assetId || selectedPoseEdges.length === 0) {
    return;
  }
  const draft = poseDraftForAsset(assetId);
  const poses = draft?.poses;
  if (!draft || !poses) {
    return;
  }
  pushPoseUndo(assetId, draft);
  let removed = draft.removedBones;
  for (const edge of selectedPoseEdges) {
    if (edge.poseIndex >= 0 && edge.poseIndex < poses.length) {
      removed = withRemovedBone(removed, poses.length, edge.poseIndex, edge.boneIndex);
    }
  }
  selectedPoseEdges = [];
  setPoseDraft({ ...draft, removedBones: removed, source: "edited" });
  requestRender();
}

/**
 * 選択集合の一括移動 / 回転FK ドラッグを開始する。
 * seedEdge を渡すと、その1本を選択集合として掴む（未選択ボーンをそのまま掴んで動かす場合）。
 */
function beginPoseSelectionDrag(event: PointerEvent, svg: SVGSVGElement, seedEdge?: PoseEdgeRef) {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  if (seedEdge) {
    selectedPoseEdges = [seedEdge];
  }
  const poseIndex = selectedPoseIndex();
  if (poseIndex === null) {
    return;
  }
  const draft = poseDraftForAsset(assetId);
  const points = draft?.poses?.[poseIndex];
  if (!draft || !points) {
    return;
  }
  const moveIndices = selectedJointIndices(poseIndex);
  if (moveIndices.length === 0) {
    return;
  }
  const startPoints = points.map((point) => ({ ...point }));
  const rotate = selectionRotatePlan(moveIndices, startPoints);
  const start = pointerToSvgViewBoxPoint(svg, event);
  activePoseSelectionDrag = {
    pointerId: event.pointerId,
    assetId,
    poseIndex,
    moveIndices,
    rotateIndices: rotate.indices,
    pivot: rotate.pivot,
    startPoints,
    start,
    moved: false,
    pending: null
  };
  try {
    (event.target as Element).setPointerCapture?.(event.pointerId);
  } catch {
    // Capture may not be supported; document-level listeners still drive the drag.
  }
  if (seedEdge) {
    requestRender();
  }
}

function continuePoseSelectionDrag(event: PointerEvent, svg: SVGSVGElement) {
  const drag = activePoseSelectionDrag;
  if (!drag) {
    return;
  }
  const point = pointerToSvgViewBoxPoint(svg, event);
  if (!drag.moved && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > POSE_JOINT_DRAG_THRESHOLD) {
    drag.moved = true;
  }
  if (!drag.moved) {
    return;
  }
  const map = new Map<number, { x: number; y: number }>();
  if (event.shiftKey || event.altKey) {
    // 回転FK: ヒンジ中心に選択関節＋子孫を剛体回転
    const oldAngle = Math.atan2(drag.start.y - drag.pivot.y, drag.start.x - drag.pivot.x);
    const newAngle = Math.atan2(point.y - drag.pivot.y, point.x - drag.pivot.x);
    const delta = newAngle - oldAngle;
    for (const index of drag.rotateIndices) {
      const src = drag.startPoints[index];
      if (src) {
        map.set(index, rotatePointAround(src, drag.pivot, delta));
      }
    }
  } else {
    // 一括平行移動
    const tx = point.x - drag.start.x;
    const ty = point.y - drag.start.y;
    for (const index of drag.moveIndices) {
      const src = drag.startPoints[index];
      if (src) {
        map.set(index, { x: src.x + tx, y: src.y + ty });
      }
    }
  }
  drag.pending = map;
  applyPoseDragToSvg(svg, drag.poseIndex, map);
}

function finishPoseSelectionDrag() {
  const drag = activePoseSelectionDrag;
  activePoseSelectionDrag = null;
  if (!drag) {
    return;
  }
  if (!drag.moved || !drag.pending || drag.pending.size === 0) {
    return;
  }
  const draft = poseDraftForAsset(drag.assetId);
  const points = draft?.poses?.[drag.poseIndex];
  if (!draft || !points) {
    return;
  }
  const pending = drag.pending;
  pushPoseUndo(drag.assetId, draft);
  const nextPoints = points.map((point, index) => {
    const pos = pending.get(index);
    return pos ? { ...point, x: pos.x, y: pos.y } : point;
  });
  const nextPoses = draft.poses!.map((pose, index) => (index === drag.poseIndex ? nextPoints : pose));
  setPoseDraft({ ...draft, poses: nextPoses, source: "edited" });
  requestRender();
}

/** 矩形マルチ選択（ラバーバンド）を開始する。overlay 背景の空きドラッグから呼ぶ。 */
function beginPoseMarquee(event: PointerEvent, svg: SVGSVGElement) {
  const assetId = state.activeAssetId;
  if (!assetId) {
    return;
  }
  const start = pointerToSvgViewBoxPoint(svg, event);
  activePoseMarquee = {
    pointerId: event.pointerId,
    assetId,
    start,
    current: start,
    additive: event.shiftKey,
    moved: false
  };
  try {
    (event.target as Element).setPointerCapture?.(event.pointerId);
  } catch {
    // Capture may not be supported; document-level listeners still drive the marquee.
  }
  ensurePoseMarqueeRect(svg);
}

function continuePoseMarquee(event: PointerEvent, svg: SVGSVGElement) {
  const marquee = activePoseMarquee;
  if (!marquee) {
    return;
  }
  const point = pointerToSvgViewBoxPoint(svg, event);
  marquee.current = point;
  if (!marquee.moved && Math.hypot(point.x - marquee.start.x, point.y - marquee.start.y) > POSE_MARQUEE_THRESHOLD) {
    marquee.moved = true;
  }
  const rect = ensurePoseMarqueeRect(svg);
  if (rect) {
    const x = Math.min(marquee.start.x, point.x);
    const y = Math.min(marquee.start.y, point.y);
    rect.setAttribute("x", formatCssNumber(x));
    rect.setAttribute("y", formatCssNumber(y));
    rect.setAttribute("width", formatCssNumber(Math.abs(point.x - marquee.start.x)));
    rect.setAttribute("height", formatCssNumber(Math.abs(point.y - marquee.start.y)));
  }
}

function finishPoseMarquee() {
  const marquee = activePoseMarquee;
  activePoseMarquee = null;
  document.querySelector(".pose-marquee")?.remove();
  if (!marquee) {
    return;
  }
  if (!marquee.moved) {
    // クリック（囲まなかった）: 選択解除
    if (selectedPoseEdges.length > 0) {
      selectedPoseEdges = [];
      requestRender();
    }
    return;
  }
  const draft = poseDraftForAsset(marquee.assetId);
  if (!draft) {
    return;
  }
  const rect = {
    x1: Math.min(marquee.start.x, marquee.current.x),
    y1: Math.min(marquee.start.y, marquee.current.y),
    x2: Math.max(marquee.start.x, marquee.current.x),
    y2: Math.max(marquee.start.y, marquee.current.y)
  };
  const hits = poseEdgesInRect(draft, rect);
  if (hits.length === 0) {
    if (!marquee.additive && selectedPoseEdges.length > 0) {
      selectedPoseEdges = [];
      requestRender();
    }
    return;
  }
  const additive = marquee.additive && selectedPoseIndex() === hits[0]!.poseIndex;
  if (additive) {
    const merged = [...selectedPoseEdges];
    for (const edge of hits) {
      if (!merged.some((e) => e.poseIndex === edge.poseIndex && e.boneIndex === edge.boneIndex)) {
        merged.push(edge);
      }
    }
    selectedPoseEdges = merged;
  } else {
    selectedPoseEdges = hits;
  }
  requestRender();
}

/**
 * 矩形内（bone の中点が矩形内）にある描画中ボーンを返す。移動/回転の一貫性のため、
 * 最も多くヒットした人物 index に限定して返す（選択は単一人物）。
 */
function poseEdgesInRect(
  draft: PoseDraft,
  rect: { x1: number; y1: number; x2: number; y2: number }
): PoseEdgeRef[] {
  const poses = draft.poses;
  if (!poses) {
    return [];
  }
  const byPose = new Map<number, PoseEdgeRef[]>();
  poses.forEach((points, poseIndex) => {
    const removed = draft.removedBones?.[poseIndex];
    OPENPOSE_BONES.forEach((bone, boneIndex) => {
      if (removed?.includes(boneIndex)) {
        return;
      }
      const from = points[bone[0]];
      const to = points[bone[1]];
      if (!from || !to || !from.visible || !to.visible) {
        return;
      }
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2;
      if (mx >= rect.x1 && mx <= rect.x2 && my >= rect.y1 && my <= rect.y2) {
        const list = byPose.get(poseIndex) ?? [];
        list.push({ poseIndex, boneIndex });
        byPose.set(poseIndex, list);
      }
    });
  });
  let best: PoseEdgeRef[] = [];
  for (const list of byPose.values()) {
    if (list.length > best.length) {
      best = list;
    }
  }
  return best;
}

/** overlay に矩形選択用の <rect> を用意（無ければ作成）して返す。 */
function ensurePoseMarqueeRect(svg: SVGSVGElement): SVGRectElement | null {
  let rect = svg.querySelector<SVGRectElement>(".pose-marquee");
  if (!rect) {
    rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "pose-marquee");
    svg.appendChild(rect);
  }
  return rect;
}

async function destroyPoseWorkerSession() {
  if (poseWorker) {
    poseWorker.postMessage({ type: "destroy", requestId: nextPoseRequestId() });
  }
  if (poseCigposeWorker) {
    poseCigposeWorker.postMessage({ type: "destroy", requestId: nextPoseRequestId() });
  }
}

// ---- main.ts(composition root)向けの公開 API ----

export function getSelectedPoseEdges(): PoseEdgeRef[] {
  return selectedPoseEdges;
}

export function clearSelectedPoseEdges() {
  selectedPoseEdges = [];
}

/** 画像詳細モーダルを閉じるときのポーズ編集セッション後始末。 */
export function closePoseEditorSession() {
  void destroyPoseWorkerSession();
  posePendingDetect = false;
  selectedPoseEdges = [];
}

export function handlePoseEditorKeydown(event: KeyboardEvent): boolean {
  if (!(state.maskEditMode && state.maskPanelTab === "pose")) {
    return false;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undoPoseEdit();
    return true;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && selectedPoseEdges.length > 0) {
    event.preventDefault();
    deleteSelectedPoseEdges();
    return true;
  }
  return false;
}

export function handlePoseEditorPointerDown(event: PointerEvent): boolean {
  if (!(state.maskEditMode && state.maskPanelTab === "pose" && (event.button === 0 || event.button === 2))) {
    return false;
  }
  const targetEl = event.target as Element;
  const poseSvg = targetEl.closest<SVGSVGElement>(".pose-overlay");
  // 中点/重心 × ボタン: 選択中エッジを一括削除（左クリックのみ）
  if (event.button === 0 && targetEl.closest(".pose-edge-delete")) {
    event.preventDefault();
    deleteSelectedPoseEdges();
    return true;
  }
  const joint = targetEl.closest<SVGCircleElement>(".pose-joint");
  if (joint) {
    event.preventDefault();
    beginPoseJointDrag(event, joint);
    return true;
  }
  if (poseSvg && event.button === 0) {
    // ボーン（透明ヒット線）: Shift=選択トグル / 既選択=そのまま掴んで移動・回転 / 未選択=単独選択して掴む
    const boneHit = targetEl.closest<SVGLineElement>(".pose-bone-hit");
    if (boneHit) {
      event.preventDefault();
      const poseIndex = Number(boneHit.getAttribute("data-pose-index") ?? "-1");
      const boneIndex = Number(boneHit.getAttribute("data-bone-index") ?? "-1");
      if (event.shiftKey) {
        selectPoseEdge(poseIndex, boneIndex, true);
      } else if (isPoseEdgeSelected(poseIndex, boneIndex)) {
        beginPoseSelectionDrag(event, poseSvg);
      } else {
        beginPoseSelectionDrag(event, poseSvg, { poseIndex, boneIndex });
      }
      return true;
    }
    // overlay 背景（空き領域）: 矩形マルチ選択（ラバーバンド）
    if (targetEl.closest(".pose-overlay-bg") || targetEl.classList.contains("pose-overlay")) {
      event.preventDefault();
      beginPoseMarquee(event, poseSvg);
      return true;
    }
  }
  return false;
}

export function handlePoseEditorPointerMove(event: PointerEvent): boolean {
  if (activePoseJointDrag) {
    if (event.pointerId !== activePoseJointDrag.pointerId) {
      return true;
    }
    const svg = document.querySelector<SVGSVGElement>(".pose-overlay");
    if (!svg) {
      return true;
    }
    event.preventDefault();
    continuePoseJointDrag(event, svg);
    return true;
  }
  if (activePoseSelectionDrag) {
    if (event.pointerId !== activePoseSelectionDrag.pointerId) {
      return true;
    }
    const svg = document.querySelector<SVGSVGElement>(".pose-overlay");
    if (!svg) {
      return true;
    }
    event.preventDefault();
    continuePoseSelectionDrag(event, svg);
    return true;
  }
  if (activePoseMarquee) {
    if (event.pointerId !== activePoseMarquee.pointerId) {
      return true;
    }
    const svg = document.querySelector<SVGSVGElement>(".pose-overlay");
    if (!svg) {
      return true;
    }
    event.preventDefault();
    continuePoseMarquee(event, svg);
    return true;
  }
  return false;
}

export function handlePoseEditorPointerUp(event: PointerEvent): boolean {
  if (activePoseJointDrag && event.pointerId === activePoseJointDrag.pointerId) {
    event.preventDefault();
    finishPoseJointDrag();
    return true;
  }
  if (activePoseSelectionDrag && event.pointerId === activePoseSelectionDrag.pointerId) {
    event.preventDefault();
    finishPoseSelectionDrag();
    return true;
  }
  if (activePoseMarquee && event.pointerId === activePoseMarquee.pointerId) {
    event.preventDefault();
    finishPoseMarquee();
    return true;
  }
  return false;
}

export function handlePoseEditorPointerCancel(event: PointerEvent): boolean {
  if (activePoseJointDrag && event.pointerId === activePoseJointDrag.pointerId) {
    activePoseJointDrag = null;
    return true;
  }
  if (activePoseSelectionDrag && event.pointerId === activePoseSelectionDrag.pointerId) {
    // キャンセル: 移動/回転を確定せず破棄。SVG は次の render() で正しい位置に戻る。
    activePoseSelectionDrag = null;
    requestRender();
    return true;
  }
  if (activePoseMarquee && event.pointerId === activePoseMarquee.pointerId) {
    // キャンセル: ラバーバンドの rect を除去して選択は変更しない。
    activePoseMarquee = null;
    document.querySelector(".pose-marquee")?.remove();
    return true;
  }
  return false;
}

/**
 * タブ横のランプ(四角トグル)によるポーズ添付の ON/OFF。
 * ポーズ未検出(データなし)のときは何もしない(ランプ側も disabled 灰色)。
 * なお enabled=true でもポーズが空なら controlnet リクエストは組まれない
 * (`controlnetRequestForParent` が poses を要求する)ため、生成には影響しない。
 */
/** モーダル側(引数なし)・グリッドの POSE バッジ(assetId 指定)のどちらからも呼べる。 */
function togglePoseAttach(assetId: string | null = state.activeAssetId) {
  const draft = assetId ? poseDraftForAsset(assetId) : null;
  if (!draft || !draft.poses || draft.poses.length === 0) {
    return;
  }
  setPoseDraft({ ...draft, enabled: !draft.enabled });
  requestRender();
}

registerActions({
  "pose-load-model": () => loadActivePoseModel(),
  "pose-detect": () => requestPoseDetect(),
  "pose-reset": () => resetPoseDetection(),
  "toggle-pose-attach": (id) => togglePoseAttach(id || state.activeAssetId)
});
