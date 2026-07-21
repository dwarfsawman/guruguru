/**
 * ページ編集 lightbox「コマ」モード+クロップ編集 UI(pagePanelLightboxView.ts から分割)。
 * シングルクリックでコマ選択、クロップ編集モードでは対象コマの画像をパン/拡大縮小/回転できる
 * (スポットライト+paste 風ギズモ)。詳細は pagePanelLightboxView.ts のファイル先頭コメント参照。
 */
import type { PagePanelAssignment } from "../../shared/apiTypes";
import type { LayoutPanel, PageLayout, PanelCrop } from "../../shared/pageLayout";
import { panelBounds } from "../../shared/pageLayout";
import type { PagePanelLightboxState } from "../appState";
import { escapeAttr } from "../format";
import { num, panelShapeElement, shapeCenter } from "./pageLayoutSvg";
import {
  GIZMO_HANDLE_RADIUS,
  GIZMO_ROTATE_STICK,
  VIEWBOX_SCALE,
  boxCenter,
  imageRectForCrop,
  panelClipId,
  renderPanelClipPath,
  rotationTransformAttr
} from "./lightboxViewShared";

/** 「コマ」モードの `<svg>` 中身。P1 以前と完全に同一の内容(関数抽出のみ、ロジック変更なし)。 */
export function renderPanelsStageContent(layout: PageLayout, lightbox: PagePanelLightboxState, assignments: PagePanelAssignment[]): string {
  const assignmentByPanel = new Map(assignments.map((assignment) => [assignment.panelId, assignment]));
  const cropPanel = lightbox.cropPanelId ? layout.panels.find((panel) => panel.id === lightbox.cropPanelId) ?? null : null;
  const cropAssignment = cropPanel ? assignmentByPanel.get(cropPanel.id) ?? null : null;
  const cropDraft = cropPanel ? lightbox.cropDraft ?? cropAssignment?.crop ?? null : null;
  // クロップ編集中の対象コマは画像をオーバーレイ(スポットライト+ギズモ)側で描くので、コマ本体は枠だけにする。
  const overlay = cropPanel && cropAssignment && cropDraft ? renderCropOverlay(cropPanel, cropAssignment, cropDraft, layout.page.height) : "";
  return `
    <defs>${layout.panels.map(renderPanelClipPath).join("")}</defs>
    <g transform="scale(${VIEWBOX_SCALE})">
      <rect x="0" y="0" width="1" height="${num(layout.page.height)}" class="page-panel-paper" />
      ${layout.panels.map((panel) => renderPanelGroup(panel, assignmentByPanel.get(panel.id) ?? null, lightbox)).join("")}
      ${overlay}
    </g>
  `;
}

function renderPanelGroup(panel: LayoutPanel, assignment: PagePanelAssignment | null, lightbox: PagePanelLightboxState): string {
  const isSelected = lightbox.selectedPanelId === panel.id;
  const isCropTarget = lightbox.cropPanelId === panel.id;
  const isDimmed = lightbox.cropPanelId !== null && !isCropTarget;
  const stateClass = ["page-panel-group", isSelected ? "is-selected" : "", isCropTarget ? "is-crop-target" : "", isDimmed ? "is-dimmed" : ""]
    .filter(Boolean)
    .join(" ");

  // 対象コマの画像はオーバーレイ(スポットライト)で描くので、ここでは他コマの画像だけを出す。
  const crop = assignment?.crop ?? null;
  const image = assignment && crop && !isCropTarget ? renderAssignmentImage(panel, assignment, crop) : "";
  // stroke-width は正規化座標系の数値属性(pageLayoutSvg.ts と同じ規約)。色は CSS クラスで状態別に出し分ける。
  // fill は "none" ではなく "transparent" にする -- "none" は SVG のヒットテスト対象から内部を除外してしまい、
  // 枠線ちょうどでないとクリックが拾えなくなる(コマ内部どこでも選択できるようにするため)。
  const strokeWidth = isSelected || isCropTarget ? 0.01 : 0.005;
  const outline = panelShapeElement(panel.shape, `class="page-panel-outline" fill="transparent" stroke-width="${num(strokeWidth)}" stroke-linejoin="miter"`);
  const hint = assignment ? "" : renderEmptyPanelHint(panel);

  return `<g class="${stateClass}" data-panel-id="${escapeAttr(panel.id)}">${image}${outline}${hint}</g>`;
}

/** 割り当て画像1枚(パネル形状クリップ + 回転)。他コマ用(pointer-events なしの純表示)。 */
function renderAssignmentImage(panel: LayoutPanel, assignment: PagePanelAssignment, crop: PanelCrop): string {
  const bounds = panelBounds(panel.shape);
  const rect = imageRectForCrop(bounds, crop, assignment);
  const transform = rotationTransformAttr(crop, boxCenter(bounds));
  const image = `<image href="${escapeAttr(assignment.assetImageUrl)}" x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" preserveAspectRatio="none" class="page-panel-image"${transform} />`;
  // clip は wrapper <g> に持たせ、回転は内側 <image> に付ける(clip を固定したまま画像だけ回す)。
  return `<g clip-path="url(#${panelClipId(panel.id)})">${image}</g>`;
}

/**
 * クロップ編集のスポットライト+ギズモ。全コマの後ろ(最前面)に1枚だけ描く。
 * - ghost: 元画像全体を薄く(pointer-events なし)。
 * - bright: コマ形状にクリップした明画像(ドラッグ=パンの当たり判定)。
 * - gizmo: 回転した外接矩形の枠 + コーナー(拡縮)/上(回転)ハンドル。
 */
function renderCropOverlay(panel: LayoutPanel, assignment: PagePanelAssignment, crop: PanelCrop, pageHeight: number): string {
  const bounds = panelBounds(panel.shape);
  const rect = imageRectForCrop(bounds, crop, assignment);
  const transform = rotationTransformAttr(crop, boxCenter(bounds));
  const rectAttrs = `x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" preserveAspectRatio="none"`;
  const href = escapeAttr(assignment.assetImageUrl);
  const ghost = `<image href="${href}" ${rectAttrs} class="page-panel-image-ghost"${transform} />`;
  const bright = `<g clip-path="url(#${panelClipId(panel.id)})"><image href="${href}" ${rectAttrs} class="page-panel-image is-draggable" data-crop-drag-panel="${escapeAttr(panel.id)}"${transform} /></g>`;
  return `<g class="page-panel-crop-overlay">${ghost}${bright}${renderCropGizmo(panel, crop, pageHeight)}</g>`;
}

/** 点を center まわりに角 rotation(rad, SVG y-down の時計回り)だけ回す。 */
function rotatePoint(point: [number, number], center: [number, number], rotation: number): [number, number] {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = point[0] - center[0];
  const dy = point[1] - center[1];
  return [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos];
}

/**
 * 回転ハンドルの位置。上辺中央 `topMid` から外向き `up` に `stick` 伸ばすのが基本だが、
 * その位置がページ範囲外(＝ステージにクリップされて掴めない。例: 最上段コマ)になる場合は
 * 内向きへ反転して必ず可視域に収める。sync も同じロジックで画面基準の `stick` で再計算する。
 */
export function cropRotateHandlePoint(
  topMid: [number, number],
  up: [number, number],
  stick: number,
  pageHeight: number
): [number, number] {
  const outward: [number, number] = [topMid[0] + up[0] * stick, topMid[1] + up[1] * stick];
  if (outward[0] < 0 || outward[0] > 1 || outward[1] < 0 || outward[1] > pageHeight) {
    return [topMid[0] - up[0] * stick, topMid[1] - up[1] * stick];
  }
  return outward;
}

/** paste 風ギズモ: 回転した外接矩形の枠 + 4 コーナー(拡縮)+ 回転ハンドル。半径/柄長は sync が画面基準へ再計算。 */
function renderCropGizmo(panel: LayoutPanel, crop: PanelCrop, pageHeight: number): string {
  const bounds = panelBounds(panel.shape);
  const center = boxCenter(bounds);
  const rotation = crop.rotation ?? 0;
  const rawCorners: [number, number][] = [
    [bounds[0], bounds[1]],
    [bounds[2], bounds[1]],
    [bounds[2], bounds[3]],
    [bounds[0], bounds[3]]
  ];
  const corners = rawCorners.map((corner) => rotatePoint(corner, center, rotation));
  const topMid = rotatePoint([(bounds[0] + bounds[2]) / 2, bounds[1]], center, rotation);
  // 回転後の「上」方向(ローカル -Y を rotation 回した単位ベクトル)。
  const up: [number, number] = [Math.sin(rotation), -Math.cos(rotation)];
  const rotateHandle = cropRotateHandlePoint(topMid, up, GIZMO_ROTATE_STICK, pageHeight);
  const outlinePoints = corners.map(([x, y]) => `${num(x)},${num(y)}`).join(" ");
  const cornerCursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"];
  const cornerHandles = corners
    .map(
      (corner, index) =>
        `<circle id="pagePanelGizmoCorner${index}" class="page-panel-gizmo-handle" style="cursor:${cornerCursors[index]};" data-crop-handle="scale" data-corner="${index}" cx="${num(corner[0])}" cy="${num(corner[1])}" r="${num(GIZMO_HANDLE_RADIUS)}" />`
    )
    .join("");
  // sync が柄長/半径を画面基準へ直すために基準点(と反転判定用のページ高)を data 属性で持たせる。
  return `<g id="pagePanelGizmo" class="page-panel-gizmo" data-cx="${num(center[0])}" data-cy="${num(center[1])}" data-tmx="${num(topMid[0])}" data-tmy="${num(topMid[1])}" data-upx="${num(up[0])}" data-upy="${num(up[1])}" data-ph="${num(pageHeight)}">
    <polygon id="pagePanelGizmoOutline" class="page-panel-gizmo-outline" points="${outlinePoints}" />
    <line id="pagePanelGizmoStick" class="page-panel-gizmo-stick" x1="${num(topMid[0])}" y1="${num(topMid[1])}" x2="${num(rotateHandle[0])}" y2="${num(rotateHandle[1])}" />
    ${cornerHandles}
    <circle id="pagePanelGizmoRotate" class="page-panel-gizmo-handle page-panel-gizmo-rotate" style="cursor:grab;" data-crop-handle="rotate" cx="${num(rotateHandle[0])}" cy="${num(rotateHandle[1])}" r="${num(GIZMO_HANDLE_RADIUS)}" />
  </g>`;
}

/** 未割り当てコマの中央に小さなドットを描き、「ここに生成できる」ことを示す控えめなヒント。 */
function renderEmptyPanelHint(panel: LayoutPanel): string {
  const center = shapeCenter(panel.shape);
  if (!center) {
    return "";
  }
  return `<circle class="page-panel-hint-dot" cx="${num(center[0])}" cy="${num(center[1])}" r="0.016" />`;
}

export function renderCropToolbar(): string {
  return `
    <footer class="page-panel-toolbar">
      <p class="page-panel-hint-text">ドラッグで移動・コーナーで拡大縮小・上のハンドルで回転(ホイールでズーム)</p>
      <div class="page-panel-toolbar-actions">
        <button class="button-secondary compact" type="button" data-action="reset-panel-crop">リセット</button>
        <button class="button-primary compact" type="button" data-action="close-panel-crop">選択に戻る</button>
      </div>
    </footer>
  `;
}
