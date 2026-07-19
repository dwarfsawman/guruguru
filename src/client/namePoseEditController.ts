/**
 * ネームポーズレイヤの編集コントローラ(Docs/Feature-NamePoseLayer.md)。
 * nameLayoutEditController と同型: ドラフトは state.namePoseEdit、ドラッグ中は SVG 属性を
 * 直接更新して pointerup でコミット(snapshotHistory)。保存は /edits の {kind:"pose"} 差分。
 */
import type { PanelCastPose } from "../shared/mangaPlanV2";
import { orderPanelsByReadingDirection } from "../shared/dialogueAutoLayout";
import { panelBounds } from "../shared/pageLayout";
import { OPENPOSE_BONES } from "../shared/poseTypes";
import type { NamePlanEdit, ScriptMangaPlanView } from "../shared/scriptMangaApi";
import { api } from "./api";
import { registerActions } from "./actionRegistry";
import { pushToast, requestRender, state, type NamePoseEditState } from "./appState";
import {
  clearSnapshotHistory,
  createSnapshotHistory,
  pushSnapshot,
  redoSnapshot,
  undoSnapshot
} from "./snapshotHistory";
import { getInverseStageTransform } from "./svgGizmo";
import { directedPlanEditable } from "./views/nameStudioView";
import { POSE_STAGE_ROOT_ID } from "./views/namePoseLayerView";

type PoseDraftRecord = Record<string, PanelCastPose[]>;

const history = createSnapshotHistory<PoseDraftRecord>();

interface PoseDrag {
  kind: "joint" | "skeleton";
  pointerId: number;
  panelId: string;
  characterId: string;
  jointIndex: number;
  startClientX: number;
  startClientY: number;
  /** ドラッグ開始時のドラフト全体(コミット時に undo へ積む/cancel 時に復元)。 */
  startDraft: PoseDraftRecord;
  /** ドラッグ開始時の対象骨格(skeleton 移動のデルタ基準)。 */
  startJoints: PanelCastPose["joints"];
  /** ページ座標系でのパネル外接箱。 */
  bounds: [number, number, number, number];
  invert: (screen: { x: number; y: number }) => { x: number; y: number };
  moved: boolean;
}

let drag: PoseDrag | null = null;

function cloneDraft(record: PoseDraftRecord): PoseDraftRecord {
  return structuredClone(record);
}

function stageRootElement(): SVGGraphicsElement | null {
  const root = document.getElementById(POSE_STAGE_ROOT_ID);
  return root instanceof SVGGraphicsElement ? root : null;
}

function planPage(pageIndex: number) {
  return state.scriptMangaRun?.plan?.pages.find((page) => page.index === pageIndex) ?? null;
}

/** 編集対象ページ内の panelId → 外接箱(reading-order スロット対応)。 */
function panelBoundsById(pageIndex: number): Map<string, [number, number, number, number]> {
  const page = planPage(pageIndex);
  const result = new Map<string, [number, number, number, number]>();
  if (!page) return result;
  const ordered = orderPanelsByReadingDirection(page.layoutSnapshot.panels, page.layoutSnapshot.readingDirection);
  page.panels.forEach((panel, slotIndex) => {
    const slot = ordered[slotIndex];
    if (slot) result.set(panel.id, panelBounds(slot.shape));
  });
  return result;
}

function updateHistoryFlags(edit: NamePoseEditState): void {
  edit.canUndo = history.undoStack.length > 0;
  edit.canRedo = history.redoStack.length > 0;
}

function draftPose(edit: NamePoseEditState, panelId: string, characterId: string): PanelCastPose | null {
  return edit.draft[panelId]?.find((pose) => pose.characterId === characterId) ?? null;
}

// --- セッション出入り ---

function beginPoseEdit(target: HTMLElement): void {
  const run = state.scriptMangaRun;
  const plan = run?.plan;
  const pageIndex = Number(target.dataset.pageIndex);
  if (!run || !plan || !run.planId || run.planEditVersion === null || run.planEditVersion === undefined) return;
  if (!directedPlanEditable(run)) {
    pushToast("承認済み/実行中のプランはポーズを編集できません。", "error");
    return;
  }
  const page = plan.pages.find((candidate) => candidate.index === pageIndex);
  if (!page) return;
  const draft: PoseDraftRecord = {};
  for (const panel of page.panels) {
    draft[panel.id] = structuredClone(panel.castPoses ?? []);
  }
  clearSnapshotHistory(history);
  state.namePoseEdit = {
    runId: run.id,
    planId: run.planId,
    baseVersion: run.planEditVersion,
    pageIndex,
    draft,
    saved: cloneDraft(draft),
    selected: null,
    saveBusy: false,
    canUndo: false,
    canRedo: false
  };
  state.nameStudioDraft = null;
  requestRender();
}

function cancelPoseEdit(): void {
  if (!state.namePoseEdit) return;
  drag = null;
  clearSnapshotHistory(history);
  state.namePoseEdit = null;
  requestRender();
}

// --- 履歴 ---

function undoPoseEdit(): void {
  const edit = state.namePoseEdit;
  if (!edit) return;
  const previous = undoSnapshot(history, cloneDraft(edit.draft));
  if (!previous) return;
  edit.draft = previous;
  updateHistoryFlags(edit);
  requestRender();
}

function redoPoseEdit(): void {
  const edit = state.namePoseEdit;
  if (!edit) return;
  const next = redoSnapshot(history, cloneDraft(edit.draft));
  if (!next) return;
  edit.draft = next;
  updateHistoryFlags(edit);
  requestRender();
}

function commitDraftChange(edit: NamePoseEditState, before: PoseDraftRecord): void {
  pushSnapshot(history, before);
  updateHistoryFlags(edit);
  requestRender();
}

// --- 深度・削除 ---

/** 選択骨格の深度を同一パネル内で1段前面/背面へ。深度は 0..n-1 へ正規化し直す。 */
function shiftSelectedDepth(direction: 1 | -1): void {
  const edit = state.namePoseEdit;
  const selected = edit?.selected;
  if (!edit || !selected) return;
  const poses = edit.draft[selected.panelId];
  if (!poses || poses.length < 2) return;
  const ordered = [...poses].sort((a, b) => a.depth - b.depth);
  const index = ordered.findIndex((pose) => pose.characterId === selected.characterId);
  const swapWith = index + direction;
  if (index < 0 || swapWith < 0 || swapWith >= ordered.length) return;
  const before = cloneDraft(edit.draft);
  const target = ordered[index]!;
  ordered[index] = ordered[swapWith]!;
  ordered[swapWith] = target;
  ordered.forEach((pose, depth) => {
    if (pose.depth !== depth) {
      pose.depth = depth;
      pose.source = "human";
    }
  });
  commitDraftChange(edit, before);
}

function removeSelectedPose(): void {
  const edit = state.namePoseEdit;
  const selected = edit?.selected;
  if (!edit || !selected) return;
  const poses = edit.draft[selected.panelId];
  if (!poses?.some((pose) => pose.characterId === selected.characterId)) return;
  const before = cloneDraft(edit.draft);
  edit.draft[selected.panelId] = poses.filter((pose) => pose.characterId !== selected.characterId);
  edit.selected = null;
  commitDraftChange(edit, before);
}

// --- 保存 ---

/** ドラフトと編集開始時スナップショットの差分から {kind:"pose"} 編集列を組む(純関数)。 */
export function buildPoseEdits(edit: Pick<NamePoseEditState, "draft" | "saved">): NamePlanEdit[] {
  const edits: NamePlanEdit[] = [];
  for (const [panelId, savedPoses] of Object.entries(edit.saved)) {
    const draftPoses = edit.draft[panelId] ?? [];
    for (const saved of savedPoses) {
      const draft = draftPoses.find((pose) => pose.characterId === saved.characterId);
      if (!draft) {
        edits.push({ kind: "pose", panelId, characterId: saved.characterId, joints: null });
        continue;
      }
      const jointsChanged = JSON.stringify(draft.joints) !== JSON.stringify(saved.joints);
      const depthChanged = draft.depth !== saved.depth;
      if (!jointsChanged && !depthChanged) continue;
      edits.push({
        kind: "pose",
        panelId,
        characterId: saved.characterId,
        ...(jointsChanged ? { joints: draft.joints.map((joint) => ({ ...joint })) } : {}),
        ...(depthChanged ? { depth: draft.depth } : {})
      });
    }
    // v1 の編集UIに骨格の新規作成は無い(復元済みが常にあるため)。draft 側にだけ
    // 存在する骨格が出来る経路は無いが、出来ても joints 送信で作成される。
    for (const draft of draftPoses) {
      if (!savedPoses.some((saved) => saved.characterId === draft.characterId)) {
        edits.push({
          kind: "pose",
          panelId,
          characterId: draft.characterId,
          joints: draft.joints.map((joint) => ({ ...joint })),
          depth: draft.depth
        });
      }
    }
  }
  return edits;
}

async function savePoseEdit(): Promise<void> {
  const edit = state.namePoseEdit;
  const run = state.scriptMangaRun;
  if (!edit || edit.saveBusy) return;
  const edits = buildPoseEdits(edit);
  if (edits.length === 0) {
    cancelPoseEdit();
    return;
  }
  edit.saveBusy = true;
  requestRender();
  try {
    await api<ScriptMangaPlanView>(`/api/script-manga-plans/${encodeURIComponent(edit.planId)}/edits`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: edit.baseVersion, edits })
    });
    const refreshed = await api<NonNullable<typeof run>>(`/api/script-manga-runs/${encodeURIComponent(edit.runId)}`);
    if (state.scriptMangaRun?.id === edit.runId) state.scriptMangaRun = refreshed;
    drag = null;
    clearSnapshotHistory(history);
    state.namePoseEdit = null;
    pushToast("ポーズを差分適用しました。runは再承認待ちへ戻ります。", "info");
    requestRender();
  } catch (error) {
    // 409(並行更新)はドラフトを保持したまま最新を取り直す(人間が突き合わせて再保存)。
    pushToast(error instanceof Error ? error.message : String(error), "error");
    edit.saveBusy = false;
    try {
      const refreshed = await api<NonNullable<typeof run>>(`/api/script-manga-runs/${encodeURIComponent(edit.runId)}`);
      if (state.scriptMangaRun?.id === edit.runId && refreshed) {
        state.scriptMangaRun = refreshed;
        if (refreshed.planEditVersion !== null && refreshed.planEditVersion !== undefined) {
          edit.baseVersion = refreshed.planEditVersion;
        }
      }
    } catch {
      // 取り直し失敗は次のポーリングに任せる。
    }
    requestRender();
  }
}

// --- ポインタ処理(main.ts のチェーンから呼ばれる) ---

/** ドラッグ中の骨格1体分を SVG 属性へ直接反映する(render() は呼ばない)。 */
function applyPoseToSvg(panelId: string, characterId: string, joints: PanelCastPose["joints"], bounds: [number, number, number, number]): void {
  const root = stageRootElement();
  if (!root) return;
  const width = Math.max(1e-6, bounds[2] - bounds[0]);
  const height = Math.max(1e-6, bounds[3] - bounds[1]);
  const pagePoints = joints.map((joint) => ({
    x: bounds[0] + joint.x * width,
    y: bounds[1] + joint.y * height,
    visible: joint.visible
  }));
  const selector = `[data-pose-panel="${CSS.escape(panelId)}"][data-pose-char="${CSS.escape(characterId)}"]`;
  for (const element of root.querySelectorAll<SVGElement>(`${selector}[data-pose-el="bone"], ${selector}[data-pose-el="hit"]`)) {
    const boneIndex = Number(element.dataset.boneIndex);
    const bone = OPENPOSE_BONES[boneIndex];
    if (!bone) continue;
    const a = pagePoints[bone[0]];
    const b = pagePoints[bone[1]];
    if (!a || !b) continue;
    element.setAttribute("x1", String(a.x));
    element.setAttribute("y1", String(a.y));
    element.setAttribute("x2", String(b.x));
    element.setAttribute("y2", String(b.y));
  }
  for (const element of root.querySelectorAll<SVGElement>(`${selector}[data-pose-el="joint"]`)) {
    const jointIndex = Number(element.dataset.jointIndex);
    const point = pagePoints[jointIndex];
    if (!point) continue;
    element.setAttribute("cx", String(point.x));
    element.setAttribute("cy", String(point.y));
  }
  const label = root.querySelector<SVGElement>(`${selector}[data-pose-el="label"]`);
  const visiblePoints = pagePoints.filter((point) => point.visible);
  if (label && visiblePoints.length > 0) {
    const top = visiblePoints.reduce((best, point) => (point.y < best.y ? point : best));
    label.setAttribute("x", String(top.x));
    label.setAttribute("y", String(Math.max(0.018, top.y - 0.014)));
  }
}

export function handleNamePoseEditPointerDown(event: PointerEvent): boolean {
  const edit = state.namePoseEdit;
  if (!edit || !(event.target instanceof Element)) return false;
  const stage = event.target.closest("[data-pose-stage]");
  if (!stage) return false;
  const root = stageRootElement();
  const invert = root ? getInverseStageTransform(root) : null;
  const handle = event.target.closest<SVGElement>("[data-pose-el='joint'], [data-pose-el='hit'], [data-pose-el='bone'], [data-pose-el='label']");
  if (!handle || !invert) {
    // ステージ背景クリック: 選択解除だけ行いイベントは消費する。
    if (edit.selected) {
      edit.selected = null;
      requestRender();
    }
    return true;
  }
  const panelId = handle.dataset.posePanel ?? "";
  const characterId = handle.dataset.poseChar ?? "";
  const pose = draftPose(edit, panelId, characterId);
  const bounds = panelBoundsById(edit.pageIndex).get(panelId);
  if (!pose || !bounds) return true;
  const isJoint = handle.dataset.poseEl === "joint";
  drag = {
    kind: isJoint ? "joint" : "skeleton",
    pointerId: event.pointerId,
    panelId,
    characterId,
    jointIndex: isJoint ? Number(handle.dataset.jointIndex) : -1,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startDraft: cloneDraft(edit.draft),
    startJoints: structuredClone(pose.joints),
    bounds,
    invert,
    moved: false
  };
  if (edit.selected?.panelId !== panelId || edit.selected.characterId !== characterId) {
    edit.selected = { panelId, characterId };
    requestRender();
  }
  event.preventDefault();
  return true;
}

export function handleNamePoseEditPointerMove(event: PointerEvent): boolean {
  const edit = state.namePoseEdit;
  if (!edit || !drag || event.pointerId !== drag.pointerId) return false;
  const pose = draftPose(edit, drag.panelId, drag.characterId);
  if (!pose) return true;
  const dx = event.clientX - drag.startClientX;
  const dy = event.clientY - drag.startClientY;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return true;
  drag.moved = true;
  const width = Math.max(1e-6, drag.bounds[2] - drag.bounds[0]);
  const height = Math.max(1e-6, drag.bounds[3] - drag.bounds[1]);
  const clampCoord = (value: number): number => Math.min(2, Math.max(-1, value));
  if (drag.kind === "joint") {
    const stagePoint = drag.invert({ x: event.clientX, y: event.clientY });
    const joint = pose.joints[drag.jointIndex];
    if (!joint) return true;
    joint.x = clampCoord((stagePoint.x - drag.bounds[0]) / width);
    joint.y = clampCoord((stagePoint.y - drag.bounds[1]) / height);
  } else {
    // 骨格全体の平行移動: 画面pxデルタをステージ単位→パネルローカルへ。
    const origin = drag.invert({ x: drag.startClientX, y: drag.startClientY });
    const current = drag.invert({ x: event.clientX, y: event.clientY });
    const deltaX = (current.x - origin.x) / width;
    const deltaY = (current.y - origin.y) / height;
    pose.joints.forEach((joint, index) => {
      const start = drag!.startJoints[index]!;
      joint.x = clampCoord(start.x + deltaX);
      joint.y = clampCoord(start.y + deltaY);
    });
  }
  applyPoseToSvg(drag.panelId, drag.characterId, pose.joints, drag.bounds);
  return true;
}

export function handleNamePoseEditPointerUp(event: PointerEvent): boolean {
  const edit = state.namePoseEdit;
  if (!edit || !drag || event.pointerId !== drag.pointerId) return false;
  const finished = drag;
  drag = null;
  const pose = draftPose(edit, finished.panelId, finished.characterId);
  if (!pose) return true;
  if (finished.moved) {
    pose.source = "human";
    commitDraftChange(edit, finished.startDraft);
    return true;
  }
  if (finished.kind === "joint") {
    // クリック(移動なし)= 可視トグル。
    const joint = pose.joints[finished.jointIndex];
    if (joint) {
      const before = cloneDraft(edit.draft);
      joint.visible = !joint.visible;
      pose.source = "human";
      commitDraftChange(edit, before);
    }
    return true;
  }
  // ボーン/ラベルのクリックは選択のみ(pointerdown で処理済み)。
  return true;
}

export function handleNamePoseEditPointerCancel(event: PointerEvent): boolean {
  const edit = state.namePoseEdit;
  if (!edit || !drag || event.pointerId !== drag.pointerId) return false;
  edit.draft = drag.startDraft;
  drag = null;
  requestRender();
  return true;
}

/** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Escape。lightbox 等より先に呼ぶこと(既知の教訓)。 */
export function handleNamePoseEditKeydown(event: KeyboardEvent): boolean {
  const edit = state.namePoseEdit;
  if (!edit) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    cancelPoseEdit();
    return true;
  }
  const key = event.key.toLocaleLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === "z" && !event.shiftKey) {
    event.preventDefault();
    undoPoseEdit();
    return true;
  }
  if ((event.ctrlKey || event.metaKey) && (key === "y" || (key === "z" && event.shiftKey))) {
    event.preventDefault();
    redoPoseEdit();
    return true;
  }
  return false;
}

function togglePoseLayer(): void {
  state.nameStudio = {
    ...state.nameStudio,
    showPoseLayer: state.nameStudio.showPoseLayer === false
  };
  requestRender();
}

registerActions({
  "studio-toggle-pose-layer": () => togglePoseLayer(),
  "studio-edit-poses": (_id, target) => beginPoseEdit(target),
  "studio-pose-save": () => void savePoseEdit(),
  "studio-pose-cancel": () => cancelPoseEdit(),
  "studio-pose-undo": () => undoPoseEdit(),
  "studio-pose-redo": () => redoPoseEdit(),
  "studio-pose-depth-up": () => shiftSelectedDepth(1),
  "studio-pose-depth-down": () => shiftSelectedDepth(-1),
  "studio-pose-remove": () => removeSelectedPose()
});
