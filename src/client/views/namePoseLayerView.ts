/**
 * ネームポーズレイヤ(Docs/Feature-NamePoseLayer.md)の描画。
 * - 表示レイヤ: コマ枠SVGと同一 viewBox の別SVGを .studio-page へ絶対配置で重ねる
 *   (pointer-events: none)。キャラごとに1色+名前ラベル、depth 昇順(手前が上)。
 * - 編集ステージ: 同じSVGを pointer-events 有効で描き、関節ハンドル/ボーンヒット線に
 *   data-pose-* 属性を付けて namePoseEditController が掴む。座標系は nameLayoutEdit と
 *   同じ scale(1000) の g(id="nameStudioPoseRoot")+ getScreenCTM 方式。
 */
import { orderPanelsByReadingDirection } from "../../shared/dialogueAutoLayout";
import type { MangaPageSpec, MangaPlanV2, PanelCastPose } from "../../shared/mangaPlanV2";
import { panelBounds } from "../../shared/pageLayout";
import { OPENPOSE_BONES } from "../../shared/poseTypes";
import type { NamePoseEditState } from "../appState";
import { escapeAttr, escapeHtml } from "../format";

export const POSE_STAGE_ROOT_ID = "nameStudioPoseRoot";
const VIEWBOX_SCALE = 1000;

/** entity.color 未設定キャラ用の決定的フォールバックパレット。 */
const POSE_FALLBACK_PALETTE = [
  "#e5484d", "#f76b15", "#ffc53d", "#46a758", "#00a2c7", "#3e63dd", "#8e4ec6", "#e93d82"
] as const;

export function poseCharacterColor(plan: MangaPlanV2, characterId: string): string {
  const entity = plan.narrativeGraph.entities.find((candidate) => candidate.id === characterId);
  if (entity?.color && /^#[0-9a-fA-F]{3,8}$/u.test(entity.color.trim())) return entity.color.trim();
  let hash = 0;
  for (let index = 0; index < characterId.length; index += 1) {
    hash = (hash * 31 + characterId.charCodeAt(index)) >>> 0;
  }
  return POSE_FALLBACK_PALETTE[hash % POSE_FALLBACK_PALETTE.length]!;
}

function characterName(plan: MangaPlanV2, characterId: string): string {
  return plan.narrativeGraph.entities.find((entity) => entity.id === characterId)?.name ?? characterId;
}

function num(value: number): string {
  return Number(value.toFixed(6)).toString();
}

interface PanelPoseGeometry {
  panelId: string;
  bounds: [number, number, number, number];
  poses: PanelCastPose[];
}

/** reading-order スロットへ対応する plan panel の骨格と外接箱を集める。 */
function pagePoseGeometries(
  page: MangaPageSpec,
  draftByPanel?: Record<string, PanelCastPose[]>
): PanelPoseGeometry[] {
  const ordered = orderPanelsByReadingDirection(page.layoutSnapshot.panels, page.layoutSnapshot.readingDirection);
  const geometries: PanelPoseGeometry[] = [];
  page.panels.forEach((panel, slotIndex) => {
    const slot = ordered[slotIndex];
    if (!slot) return;
    const poses = draftByPanel ? draftByPanel[panel.id] ?? [] : panel.castPoses ?? [];
    if (poses.length === 0) return;
    geometries.push({
      panelId: panel.id,
      bounds: panelBounds(slot.shape),
      poses: [...poses].sort((a, b) => a.depth - b.depth)
    });
  });
  return geometries;
}

/** パネルローカル 0..1 → ページ座標(width-relative)。 */
function toPagePoint(
  bounds: [number, number, number, number],
  joint: { x: number; y: number }
): { x: number; y: number } {
  const width = Math.max(1e-6, bounds[2] - bounds[0]);
  const height = Math.max(1e-6, bounds[3] - bounds[1]);
  return { x: bounds[0] + joint.x * width, y: bounds[1] + joint.y * height };
}

function renderPose(
  geometry: PanelPoseGeometry,
  pose: PanelCastPose,
  plan: MangaPlanV2,
  edit: NamePoseEditState | null
): string {
  const color = poseCharacterColor(plan, pose.characterId);
  const points = pose.joints.map((joint) => ({ ...toPagePoint(geometry.bounds, joint), visible: joint.visible }));
  const selected = edit?.selected?.panelId === geometry.panelId && edit.selected.characterId === pose.characterId;
  const dataAttrs = `data-pose-panel="${escapeAttr(geometry.panelId)}" data-pose-char="${escapeAttr(pose.characterId)}"`;
  const parts: string[] = [];
  // ボーン(表示線)+ 編集時の透明ヒット線。
  OPENPOSE_BONES.forEach(([from, to], boneIndex) => {
    const a = points[from];
    const b = points[to];
    if (!a || !b || !a.visible || !b.visible) return;
    const line = `x1="${num(a.x)}" y1="${num(a.y)}" x2="${num(b.x)}" y2="${num(b.y)}"`;
    parts.push(`<line class="pose-layer-bone" ${line} stroke="${escapeAttr(color)}"
      stroke-width="${selected ? 0.0075 : 0.005}" stroke-linecap="round" data-pose-el="bone"
      data-bone-index="${boneIndex}" ${dataAttrs} />`);
    if (edit) {
      parts.push(`<line class="pose-layer-bone-hit" ${line} stroke="rgba(0,0,0,0)" stroke-width="0.022"
        stroke-linecap="round" data-pose-el="hit" data-bone-index="${boneIndex}" ${dataAttrs} />`);
    }
  });
  // 関節。編集時は不可視関節も薄いハンドルとして出す(クリックで可視トグル)。
  points.forEach((point, jointIndex) => {
    if (!point.visible && !edit) return;
    parts.push(`<circle class="pose-layer-joint ${point.visible ? "" : "is-hidden-joint"}"
      cx="${num(point.x)}" cy="${num(point.y)}" r="${edit ? 0.009 : 0.006}"
      fill="${point.visible ? escapeAttr(color) : "rgba(255,255,255,0.85)"}"
      stroke="${point.visible ? "rgba(255,255,255,0.9)" : escapeAttr(color)}" stroke-width="0.0018"
      data-pose-el="joint" data-joint-index="${jointIndex}" ${dataAttrs} />`);
  });
  // 名前ラベル: 可視関節の最上部の少し上。編集時は深度も添える(1=最奥)。
  const anchorPoints = points.filter((point) => point.visible);
  if (anchorPoints.length > 0) {
    const top = anchorPoints.reduce((best, point) => (point.y < best.y ? point : best));
    const label = edit
      ? `${characterName(plan, pose.characterId)} [${pose.depth + 1}]`
      : characterName(plan, pose.characterId);
    parts.push(`<text class="pose-layer-label" x="${num(top.x)}" y="${num(Math.max(0.018, top.y - 0.014))}"
      font-size="0.02" text-anchor="middle" fill="${escapeAttr(color)}"
      stroke="rgba(255,255,255,0.9)" stroke-width="0.004" paint-order="stroke"
      data-pose-el="label" ${dataAttrs}>${escapeHtml(label)}</text>`);
  }
  return `<g class="pose-layer-figure ${selected ? "is-selected" : ""}" ${dataAttrs}>${parts.join("")}</g>`;
}

/**
 * ページ1枚分のポーズレイヤSVG。edit を渡すと編集ステージ(ヒット線・不可視関節・
 * data-pose-stage)として描く。
 */
export function renderNamePoseOverlaySvg(
  page: MangaPageSpec,
  plan: MangaPlanV2,
  edit: NamePoseEditState | null = null
): string {
  const geometries = pagePoseGeometries(page, edit && edit.pageIndex === page.index ? edit.draft : undefined);
  const height = page.layoutSnapshot.page.height;
  const body = geometries
    .map((geometry) => geometry.poses.map((pose) => renderPose(geometry, pose, plan, edit)).join(""))
    .join("");
  return `<svg class="studio-pose-svg ${edit ? "is-editing" : ""}"
    viewBox="0 0 ${VIEWBOX_SCALE} ${num(height * VIEWBOX_SCALE)}" preserveAspectRatio="xMidYMid meet"
    ${edit ? `data-pose-stage="1"` : `aria-hidden="true"`}>
    <g ${edit ? `id="${POSE_STAGE_ROOT_ID}"` : ""} transform="scale(${VIEWBOX_SCALE})">
      ${edit ? `<rect class="pose-stage-bg" x="0" y="0" width="1" height="${num(height)}" fill="rgba(0,0,0,0)" />` : ""}
      ${body}
    </g>
  </svg>`;
}

/** 編集ツールバー。選択中の骨格があれば深度操作・削除を出す。 */
export function renderNamePoseEditToolbar(edit: NamePoseEditState, plan: MangaPlanV2): string {
  const selected = edit.selected;
  const selectedPoses = selected ? edit.draft[selected.panelId] ?? [] : [];
  const selectedPose = selected
    ? selectedPoses.find((pose) => pose.characterId === selected.characterId) ?? null
    : null;
  const maxDepth = selectedPoses.length > 0 ? Math.max(...selectedPoses.map((pose) => pose.depth)) : 0;
  const selectedBlock = selectedPose && selected
    ? `<span class="pose-toolbar-selected">
        <span class="pose-toolbar-dot" style="background:${escapeAttr(poseCharacterColor(plan, selected.characterId))}"></span>
        ${escapeHtml(characterName(plan, selected.characterId))}
      </span>
      <button type="button" class="button-secondary compact" data-action="studio-pose-depth-up"
        ${selectedPose.depth >= maxDepth ? "disabled" : ""}>前面へ</button>
      <button type="button" class="button-secondary compact" data-action="studio-pose-depth-down"
        ${selectedPose.depth <= 0 ? "disabled" : ""}>背面へ</button>
      <button type="button" class="button-secondary compact" data-action="studio-pose-remove">骨格を削除</button>`
    : `<span class="pose-toolbar-hint">関節をドラッグ=移動 / ボーンをドラッグ=全体移動 / 関節クリック=表示切替</span>`;
  return `
    <div class="studio-pose-toolbar" role="toolbar" aria-label="ポーズ編集">
      <button type="button" class="button-primary compact" data-action="studio-pose-save"
        ${edit.saveBusy ? "disabled" : ""}>${edit.saveBusy ? "保存中…" : "保存(再構成)"}</button>
      <button type="button" class="button-secondary compact" data-action="studio-pose-cancel">閉じる</button>
      <button type="button" class="button-secondary compact" data-action="studio-pose-undo"
        ${edit.canUndo ? "" : "disabled"} title="Ctrl+Z">↩ 元に戻す</button>
      <button type="button" class="button-secondary compact" data-action="studio-pose-redo"
        ${edit.canRedo ? "" : "disabled"} title="Ctrl+Shift+Z">↪ やり直す</button>
      ${selectedBlock}
    </div>`;
}
