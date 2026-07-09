/**
 * ページ編集 lightbox(Docs/Feature-CGCollectionSuite.md P1 でモードタブ付きに拡張)。
 * 「コマ」モード(コマ内生成。Docs/Feature-PanelGeneration.md): シングルクリックでコマ選択 →
 *   「選択コマを生成」で生成 UI へ。ダブルクリックは補助導線(未生成コマ→生成 UI、生成済みコマ→クロップ編集)。
 *   クロップ編集モード: 対象コマの画像をパン/拡大縮小/回転でき(他コマは非活性で dimmed)、pointerup で保存する。
 *   参照画像貼り付け(Paste & Transform)と同型の UX。編集中は「スポットライト」表示にする
 *   -- 元画像全体を薄く(ghost)出し、コマ形状にクリップした明画像を重ねて「コマ領域だけ濃く」見せ、
 *   その上に paste 風ギズモ(コーナー=拡縮 / 上のハンドル=回転)を描く。
 *   **この「コマ」モードの描画/挙動は P1 で一切変更していない**(既存コードをそのまま関数抽出しただけ)。
 * 「オブジェクト」モード(P1 新規): box オブジェクトの追加/選択/移動/拡縮/回転/削除/z順/プロパティ編集。
 *   `page.layout` が無いページ(1枚絵)でも開け、その場合はタブ自体を出さずオブジェクトモード固定にする。
 * 座標は pageLayoutSvg.ts と同じ width-relative 正規化(x∈[0,1], y∈[0,page.height])。
 */
import type { PagePanelAssignment, PageSummary } from "../../shared/apiTypes";
import type { LayoutPanel, PageLayout, PanelCrop } from "../../shared/pageLayout";
import { panelBounds, panelBoundsSize } from "../../shared/pageLayout";
import type { BoxObject, PageObject } from "../../shared/pageObjects";
import { gizmoBoxCorners, gizmoRotateHandlePoint, gizmoTopMid, gizmoUpVector, type GizmoBox } from "../svgGizmo";
import type { PagePanelLightboxState } from "../appState";
import { escapeAttr, escapeHtml } from "../format";
import { iconClose, iconPlus, iconSparkle, iconTrash } from "../icons";
import { num, panelShapeElement, shapeCenter } from "./pageLayoutSvg";

const VIEWBOX_SCALE = 1000;

/** ギズモのハンドル半径 / 回転ハンドルの柄長さ(正規化座標の初期値。sync が画面基準へ再計算)。 */
const GIZMO_HANDLE_RADIUS = 0.014;
const GIZMO_ROTATE_STICK = 0.07;

export function renderPagePanelLightbox(
  page: PageSummary,
  lightbox: PagePanelLightboxState,
  assignments: PagePanelAssignment[],
  objects: PageObject[],
  selectedObjectId: string | null
): string {
  if (lightbox.pageId !== page.id) {
    return "";
  }
  const layout = page.layout ?? null;
  // レイアウトの無いページ(1枚絵)は常にオブジェクトモード扱い(タブ自体を出さない)。
  const mode = layout ? lightbox.mode : "objects";
  const label = page.title.trim() || "ページ";
  const pageHeight = lightbox.pageHeight;

  const stageContent =
    mode === "panels" && layout
      ? renderPanelsStageContent(layout, lightbox, assignments)
      : renderObjectsStageContent(objects, selectedObjectId, pageHeight);
  const toolbar =
    mode === "panels" && layout
      ? layout.panels.some((panel) => panel.id === lightbox.cropPanelId)
        ? renderCropToolbar()
        : renderSelectToolbar(lightbox)
      : renderObjectsToolbar(objects, selectedObjectId);

  return `
    <div class="workflow-modal page-panel-lightbox" role="dialog" aria-modal="true" aria-label="${escapeAttr(label)} のページ編集">
      <section class="workflow-dialog page-panel-dialog">
        <header class="workflow-dialog-header">
          <div>
            <p class="section-kicker">Book · ページ編集</p>
            <h2>${escapeHtml(label)}</h2>
          </div>
          <button class="icon-button" type="button" data-action="close-page-panels" aria-label="閉じる" title="閉じる">${iconClose()}</button>
        </header>
        ${renderModeTabs(lightbox, Boolean(layout))}
        <div class="page-panel-stage" style="aspect-ratio: 1 / ${num(pageHeight)}">
          <svg class="page-panel-svg" viewBox="0 0 ${VIEWBOX_SCALE} ${num(VIEWBOX_SCALE * pageHeight)}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"${mode === "objects" ? ` data-page-object-stage="1"` : ""}>
            ${stageContent}
          </svg>
        </div>
        ${toolbar}
      </section>
    </div>
  `;
}

/** コマ/オブジェクトのモードタブ。切替先が1つしか無ければ(レイアウト無しページ)タブ自体を出さない。 */
function renderModeTabs(lightbox: PagePanelLightboxState, hasLayout: boolean): string {
  if (!hasLayout) {
    return "";
  }
  const tab = (mode: "panels" | "objects", labelText: string) =>
    `<button type="button" class="page-panel-mode-tab${lightbox.mode === mode ? " is-active" : ""}" data-action="set-page-panel-mode" data-id="${mode}" role="tab" aria-selected="${lightbox.mode === mode ? "true" : "false"}">${escapeHtml(labelText)}</button>`;
  return `<div class="page-panel-mode-tabs" role="tablist">${tab("panels", "コマ")}${tab("objects", "オブジェクト")}</div>`;
}

/** 「コマ」モードの `<svg>` 中身。P1 以前と完全に同一の内容(関数抽出のみ、ロジック変更なし)。 */
function renderPanelsStageContent(layout: PageLayout, lightbox: PagePanelLightboxState, assignments: PagePanelAssignment[]): string {
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

function panelClipId(panelId: string): string {
  return `page-panel-clip-${panelId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function renderPanelClipPath(panel: LayoutPanel): string {
  return `<clipPath id="${panelClipId(panel.id)}">${panelShapeElement(panel.shape)}</clipPath>`;
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

/** crop(asset 画像座標系で正規化)をパネル外接矩形へ cover フィットさせた `<image>` の x/y/width/height。 */
function imageRectForCrop(bounds: [number, number, number, number], crop: PanelCrop) {
  const [boxWidth, boxHeight] = panelBoundsSize(bounds);
  const width = boxWidth / crop.width;
  const height = boxHeight / crop.height;
  const x = bounds[0] - crop.x * width;
  const y = bounds[1] - crop.y * height;
  return { x, y, width, height };
}

/** パネル外接矩形の中心(回転の軸・ギズモの基準)。 */
function boxCenter(bounds: [number, number, number, number]): [number, number] {
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
}

/**
 * `crop.rotation` を `<image>` の rotate transform 文字列へ(窓中心=外接矩形中心まわりに回す)。
 * 無回転なら空文字を返し、従来と同一の出力にする。回転は clip を持つ要素と**別の要素**に付ける
 * こと(同一要素だと clip も一緒に回るため)。
 */
function rotationTransformAttr(crop: PanelCrop, center: [number, number]): string {
  const rotation = crop.rotation ?? 0;
  if (!rotation) {
    return "";
  }
  const deg = (rotation * 180) / Math.PI;
  return ` transform="rotate(${num(deg)} ${num(center[0])} ${num(center[1])})"`;
}

/** 割り当て画像1枚(パネル形状クリップ + 回転)。他コマ用(pointer-events なしの純表示)。 */
function renderAssignmentImage(panel: LayoutPanel, assignment: PagePanelAssignment, crop: PanelCrop): string {
  const bounds = panelBounds(panel.shape);
  const rect = imageRectForCrop(bounds, crop);
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
  const rect = imageRectForCrop(bounds, crop);
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

function renderSelectToolbar(lightbox: PagePanelLightboxState): string {
  const disabled = !lightbox.selectedPanelId;
  return `
    <footer class="page-panel-toolbar">
      <p class="page-panel-hint-text">コマをクリックして選択(ダブルクリックで生成 / クロップ編集)</p>
      <button class="button-primary page-panel-generate-button" type="button" data-action="generate-selected-panel" ${disabled ? "disabled" : ""}>${iconSparkle()}選択コマを生成</button>
    </footer>
  `;
}

function renderCropToolbar(): string {
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

// --- 「オブジェクト」モード(Docs/Feature-CGCollectionSuite.md P1: box オブジェクトの追加/選択/変形/削除/z順) ---

/** オブジェクトモードの `<svg>` 中身。scale(1000) group 内に正規化座標で描く(注意: group 外に置くと実質不可視)。 */
function renderObjectsStageContent(objects: PageObject[], selectedObjectId: string | null, pageHeight: number): string {
  const selected = objects.find((object) => object.id === selectedObjectId);
  const selectedBox = selected && selected.kind === "box" ? selected : null;
  return `
    <g id="pageObjectStageRoot" transform="scale(${VIEWBOX_SCALE})">
      <rect x="0" y="0" width="1" height="${num(pageHeight)}" class="page-panel-paper" data-page-object-background="1" />
      ${objects.map((object) => renderPageObjectShape(object, object.id === selectedObjectId)).join("")}
      ${selectedBox ? renderPageObjectGizmo(selectedBox, pageHeight) : ""}
    </g>
  `;
}

function renderPageObjectShape(object: PageObject, isSelected: boolean): string {
  // P1 で編集/表示するのは box のみ(text/balloon は将来フェーズ。データとしては保持・往復するが未描画)。
  if (object.kind !== "box") {
    return "";
  }
  const x = object.position.x - object.size.x / 2;
  const y = object.position.y - object.size.y / 2;
  const deg = (object.rotation * 180) / Math.PI;
  const transform = deg ? ` transform="rotate(${num(deg)} ${num(object.position.x)} ${num(object.position.y)})"` : "";
  const radius = object.cornerRadius ? ` rx="${num(object.cornerRadius)}"` : "";
  const stateClass = isSelected ? " is-selected" : "";
  return `<rect data-page-object="${escapeAttr(object.id)}" class="page-object-shape${stateClass}" x="${num(x)}" y="${num(y)}" width="${num(object.size.x)}" height="${num(object.size.y)}"${radius} fill="${escapeAttr(object.fill)}" stroke="${escapeAttr(object.strokeColor)}" stroke-width="${num(object.strokeWidth)}"${transform} />`;
}

/**
 * オブジェクトギズモの回転ハンドル反転判定に使うステージ可視域(SVG は viewBox 外をクリップするため、
 * ここを外れたハンドルは掴めない)。render(初期値)と sync(`syncPageObjectsGizmo` が画面基準の柄長で
 * 再計算)の両方が**同じ bounds でこの判定を通る**こと -- 片方だけだと「render では内向き→sync で
 * 外向きに戻って画面外」になる(crop 編集の cropRotateHandlePoint と同種の既知バグ)。
 */
export function pageObjectGizmoViewBounds(pageHeight: number): { minX: number; minY: number; maxX: number; maxY: number } {
  return { minX: 0, minY: 0, maxX: 1, maxY: pageHeight };
}

/** paste/crop 風ギズモ(コーナー=拡縮 / 上のハンドル=回転)。選択中の box オブジェクトの外接矩形まわりに描く。 */
function renderPageObjectGizmo(object: BoxObject, pageHeight: number): string {
  const box: GizmoBox = { center: object.position, size: object.size, rotation: object.rotation };
  const corners = gizmoBoxCorners(box);
  const topMid = gizmoTopMid(box);
  const up = gizmoUpVector(box.rotation);
  const rotateHandle = gizmoRotateHandlePoint(topMid, up, GIZMO_ROTATE_STICK, pageObjectGizmoViewBounds(pageHeight));
  const outlinePoints = corners.map((corner) => `${num(corner.x)},${num(corner.y)}`).join(" ");
  const cornerCursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"];
  const cornerHandles = corners
    .map(
      (corner, index) =>
        `<circle id="pageObjectGizmoCorner${index}" class="page-object-gizmo-handle" style="cursor:${cornerCursors[index]};" data-page-object-handle="scale" data-page-object-owner="${escapeAttr(object.id)}" cx="${num(corner.x)}" cy="${num(corner.y)}" r="${num(GIZMO_HANDLE_RADIUS)}" />`
    )
    .join("");
  // sync が柄長/半径を画面基準へ直すために基準点と反転判定用のページ高(data-ph)を data 属性で持たせる。
  return `<g id="pageObjectGizmo" class="page-object-gizmo" data-tmx="${num(topMid.x)}" data-tmy="${num(topMid.y)}" data-upx="${num(up.x)}" data-upy="${num(up.y)}" data-ph="${num(pageHeight)}">
    <polygon id="pageObjectGizmoOutline" class="page-object-gizmo-outline" points="${outlinePoints}" />
    <line id="pageObjectGizmoStick" class="page-object-gizmo-stick" x1="${num(topMid.x)}" y1="${num(topMid.y)}" x2="${num(rotateHandle.x)}" y2="${num(rotateHandle.y)}" />
    ${cornerHandles}
    <circle id="pageObjectGizmoRotate" class="page-object-gizmo-handle page-object-gizmo-rotate" style="cursor:grab;" data-page-object-handle="rotate" data-page-object-owner="${escapeAttr(object.id)}" cx="${num(rotateHandle.x)}" cy="${num(rotateHandle.y)}" r="${num(GIZMO_HANDLE_RADIUS)}" />
  </g>`;
}

function renderObjectsToolbar(objects: PageObject[], selectedObjectId: string | null): string {
  const selected = objects.find((object) => object.id === selectedObjectId);
  const selectedBox = selected && selected.kind === "box" ? selected : null;
  return `
    <footer class="page-panel-toolbar page-object-toolbar">
      <div class="page-object-toolbar-row">
        <button class="button-secondary compact" type="button" data-action="add-page-object-box">${iconPlus()}ボックス追加</button>
        ${
          selectedBox
            ? `
              <button class="button-secondary compact" type="button" data-action="page-object-bring-front" title="最前面へ">前面へ</button>
              <button class="button-secondary compact" type="button" data-action="page-object-send-back" title="最背面へ">背面へ</button>
              <button class="button-danger compact" type="button" data-action="delete-selected-page-object" title="削除(Delete キー)">${iconTrash()}削除</button>
            `
            : ""
        }
      </div>
      ${selectedBox ? renderBoxPropertyPanel(selectedBox) : `<p class="page-panel-hint-text">ボックスをクリックして選択(ドラッグで移動・コーナーで拡縮・上のハンドルで回転・Delete で削除)</p>`}
    </footer>
  `;
}

function renderBoxPropertyPanel(object: BoxObject): string {
  return `
    <div class="page-object-property-row">
      <label class="page-object-property-field">塗り
        <input type="color" data-page-object-field="fill" value="${escapeAttr(object.fill)}" />
      </label>
      <label class="page-object-property-field">線色
        <input type="color" data-page-object-field="strokeColor" value="${escapeAttr(object.strokeColor)}" />
      </label>
      <label class="page-object-property-field">線幅
        <input type="number" step="0.001" min="0" max="0.2" data-page-object-field="strokeWidth" value="${num(object.strokeWidth)}" />
      </label>
      <label class="page-object-property-field">角丸
        <input type="number" step="0.005" min="0" data-page-object-field="cornerRadius" value="${num(object.cornerRadius ?? 0)}" />
      </label>
    </div>
  `;
}
