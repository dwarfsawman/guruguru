/**
 * ページ編集 lightbox(Docs/Feature-CGCollectionSuite.md P1 でモードタブ付きに拡張)。
 * 「コマ」モード(コマ内生成。Docs/Feature-PanelGeneration.md): シングルクリックでコマ選択 →
 *   「選択コマを生成」で生成 UI へ。ダブルクリックは補助導線(未生成コマ→生成 UI、生成済みコマ→クロップ編集)。
 *   クロップ編集モード: 対象コマの画像をパン/拡大縮小/回転でき(他コマは非活性で dimmed)、pointerup で保存する。
 *   参照画像貼り付け(Paste & Transform)と同型の UX。編集中は「スポットライト」表示にする
 *   -- 元画像全体を薄く(ghost)出し、コマ形状にクリップした明画像を重ねて「コマ領域だけ濃く」見せ、
 *   その上に paste 風ギズモ(コーナー=拡縮 / 上のハンドル=回転)を描く。
 *   **この「コマ」モードの描画/挙動は P1 で一切変更していない**(既存コードをそのまま関数抽出しただけ)。
 * 「オブジェクト」モード: box(P1)/text(P2)/balloon(P3)オブジェクトの追加/選択/移動/拡縮/回転/削除/
 *   z順/プロパティ編集。`page.layout` が無いページ(1枚絵)でも開け、その場合はタブ自体を出さず
 *   オブジェクトモード固定にする。
 * 座標は pageLayoutSvg.ts と同じ width-relative 正規化(x∈[0,1], y∈[0,page.height])。
 */
import type { Asset, DialogueLine, DialogueProposal, DialogueProposalItem, FontSummary, PagePanelAssignment, PageSummary } from "../../shared/apiTypes";
import type { LayoutPanel, PageLayout, PanelCrop } from "../../shared/pageLayout";
import { panelBounds, panelBoundsSize } from "../../shared/pageLayout";
import {
  PAGE_OBJECT_MIN_SIZE,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  contentMaxWidth,
  type BalloonObject,
  type BalloonShape,
  type BoxObject,
  type ImageObject,
  type PageObject,
  type PageVec,
  type TextContent,
  type TextObject,
  type TextStyle
} from "../../shared/pageObjects";
import { balloonContentMaxWidth, renderBalloonSvg } from "../../shared/balloonShape";
import { renderTextSvg } from "../../shared/textSvg";
import {
  MOSAIC_GRANULARITY_MAX,
  MOSAIC_GRANULARITY_MIN,
  regionBoundsPage,
  type MosaicRegion
} from "../../shared/mosaicRegion";
import { gizmoBoxCorners, gizmoRotateHandlePoint, gizmoTopMid, gizmoUpVector, rotatePointAround } from "../svgGizmo";
import { gizmoBoxForPageObject } from "../pageObjectGizmoBox";
import { getCachedTextLayout } from "../textLayoutClient";
import type { PagePanelLightboxState } from "../appState";
import { escapeAttr, escapeHtml } from "../format";
import { iconClose, iconPlus, iconScript, iconSparkle, iconTrash } from "../icons";
import { num, panelShapeElement, shapeCenter } from "./pageLayoutSvg";
import { renderChronicleBar, type ChronicleBarViewState } from "./chronicleBarView";

const VIEWBOX_SCALE = 1000;

/** ギズモのハンドル半径 / 回転ハンドルの柄長さ(正規化座標の初期値。sync が画面基準へ再計算)。 */
const GIZMO_HANDLE_RADIUS = 0.014;
const GIZMO_ROTATE_STICK = 0.07;

/** コマ形状編集(P5)モードの表示用状態。lightbox を開いている間の作業ドラフト+選択/分割状態をまとめる。 */
export interface PanelShapeEditViewState {
  layout: PageLayout | null;
  selectedPanelId: string | null;
  selectedVertexIndex: number | null;
  splitMode: boolean;
  splitDraft: { start: [number, number]; current: [number, number] } | null;
  gutter: number;
}

/** モザイク編集(P6)モードの表示用状態。追加モード/作業ドラフト/選択状態をまとめる。 */
export interface MosaicEditViewState {
  regions: MosaicRegion[];
  selectedRegionId: string | null;
  selectedVertexIndex: number | null;
  addMode: "rect" | "polygon" | null;
  rectDraft: { start: [number, number]; current: [number, number] } | null;
  polygonDraft: [number, number][] | null;
}

/**
 * 「オブジェクト」モードのうち画像オブジェクト(Docs/Feature-ScriptToManga.md S2)に関する表示用状態。
 * 「画像追加」ピッカーの候補・欠損 mediaId・ピッカー開閉をまとめる(shapeEdit/mosaicEdit と同じ束ね方)。
 */
export interface ImageObjectViewState {
  /** 「画像追加」ピッカーの候補(PageDetail.assets)。 */
  pickerAssets: Asset[];
  /** page_media 行/ファイルが欠損している mediaId(プレースホルダ表示用)。 */
  missingMediaIds: string[];
  /** 「画像追加」/「メディア差し替え」ピッカーの開閉。null=閉。 */
  picker: { mode: "add" | "replace" } | null;
}

/**
 * 「セリフ」ドロワー(Docs/Feature-ScriptToManga.md S3 UI 2)の表示用状態。`lines` はそのプロジェクトの
 * active なセリフ行(script 横断)。行クリックで placement 作成+吹き出し生成を行う(同じ行を複数回
 * クリックすれば分割配置になる -- 既に配置済みの行も一覧に残し「配置済み ×N」を添えて再クリック可能にする)。
 */
export interface DialogueDrawerViewState {
  open: boolean;
  lines: DialogueLine[];
  /** 構造化 LLM セリフ提案(Docs/Feature-ScriptToManga.md S4)。 */
  llmConfigured: boolean;
  /** このページの提案一覧(新しい順)。 */
  proposals: DialogueProposal[];
  /** LLM 提案リクエスト送信中か(ボタン disabled + スピナー表示、llmImproving 同型)。 */
  busy: boolean;
}

export function renderPagePanelLightbox(
  page: PageSummary,
  lightbox: PagePanelLightboxState,
  assignments: PagePanelAssignment[],
  objects: PageObject[],
  selectedObjectId: string | null,
  fonts: FontSummary[],
  shapeEdit: PanelShapeEditViewState,
  mosaicEdit: MosaicEditViewState,
  imageObjects: ImageObjectViewState,
  dialogueDrawer: DialogueDrawerViewState,
  chronicleBar: ChronicleBarViewState
): string {
  if (lightbox.pageId !== page.id) {
    return "";
  }
  const layout = page.layout ?? null;
  // レイアウトの無いページ(1枚絵)は "objects"/"mosaic" のみ開ける(呼び出し側が open 時に決める)。
  const mode = layout ? lightbox.mode : lightbox.mode === "mosaic" ? "mosaic" : "objects";
  const label = page.title.trim() || "ページ";
  const pageHeight = lightbox.pageHeight;

  const stageContent =
    mode === "panels" && layout
      ? renderPanelsStageContent(layout, lightbox, assignments)
      : mode === "shapes" && layout
        ? renderShapesStageContent(shapeEdit, pageHeight)
        : mode === "mosaic"
          ? renderMosaicStageContent(mosaicEdit, pageHeight)
          : renderObjectsStageContent(
              objects,
              selectedObjectId,
              pageHeight,
              layout,
              assignments,
              imageObjects.missingMediaIds,
              chronicleBar.preview?.objects ?? []
            );
  const toolbar =
    mode === "panels" && layout
      ? layout.panels.some((panel) => panel.id === lightbox.cropPanelId)
        ? renderCropToolbar()
        : renderSelectToolbar(lightbox)
      : mode === "shapes" && layout
        ? renderShapesToolbar(shapeEdit)
        : mode === "mosaic"
          ? renderMosaicToolbar(mosaicEdit)
          : renderObjectsToolbar(objects, selectedObjectId, fonts, layout, imageObjects, dialogueDrawer);

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
        ${renderChronicleBar(chronicleBar)}
      </section>
    </div>
  `;
}

/**
 * コマ/オブジェクト/コマ枠/モザイクのモードタブ。レイアウト無しページは「オブジェクト」「モザイク」の
 * 2つだけを出す(P1/P6: 1枚絵ページでもオブジェクト/モザイク編集は必要)。
 */
function renderModeTabs(lightbox: PagePanelLightboxState, hasLayout: boolean): string {
  const tab = (mode: "panels" | "objects" | "shapes" | "mosaic", labelText: string) =>
    `<button type="button" class="page-panel-mode-tab${lightbox.mode === mode ? " is-active" : ""}" data-action="set-page-panel-mode" data-id="${mode}" role="tab" aria-selected="${lightbox.mode === mode ? "true" : "false"}">${escapeHtml(labelText)}</button>`;
  if (!hasLayout) {
    return `<div class="page-panel-mode-tabs" role="tablist">${tab("objects", "オブジェクト")}${tab("mosaic", "モザイク")}</div>`;
  }
  return `<div class="page-panel-mode-tabs" role="tablist">${tab("panels", "コマ")}${tab("objects", "オブジェクト")}${tab("shapes", "コマ枠")}${tab("mosaic", "モザイク")}</div>`;
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

// --- 「コマ枠」モード(Docs/Feature-CGCollectionSuite.md P5: 頂点編集・分割) ---

/** 頂点ハンドルの半径 / 辺中点マーカーの半径(正規化座標の初期値)。 */
const SHAPE_VERTEX_RADIUS = 0.012;
const SHAPE_EDGE_MARKER_RADIUS = 0.008;

function renderShapesStageContent(shapeEdit: PanelShapeEditViewState, pageHeight: number): string {
  const layout = shapeEdit.layout;
  if (!layout) {
    return `<g transform="scale(${VIEWBOX_SCALE})"><rect x="0" y="0" width="1" height="${num(pageHeight)}" class="page-panel-paper" /></g>`;
  }
  const selectedPanel = shapeEdit.selectedPanelId ? layout.panels.find((panel) => panel.id === shapeEdit.selectedPanelId) ?? null : null;
  const panelsHtml = layout.panels.map((panel) => renderShapePanelOutline(panel, panel.id === shapeEdit.selectedPanelId)).join("");
  const handles =
    selectedPanel && selectedPanel.shape.type === "polygon" && !shapeEdit.splitMode
      ? renderShapeVertexHandles(selectedPanel.shape.points, shapeEdit.selectedVertexIndex)
      : "";
  const splitPreview = shapeEdit.splitMode && shapeEdit.splitDraft ? renderShapeSplitPreview(shapeEdit.splitDraft) : "";
  return `
    <g id="pageShapeStageRoot" transform="scale(${VIEWBOX_SCALE})" data-shape-stage="1">
      <rect x="0" y="0" width="1" height="${num(layout.page.height)}" class="page-panel-paper" data-shape-background="1" />
      ${panelsHtml}
      ${handles}
      ${splitPreview}
    </g>
  `;
}

function renderShapePanelOutline(panel: LayoutPanel, isSelected: boolean): string {
  const strokeWidth = isSelected ? 0.01 : 0.005;
  return panelShapeElement(
    panel.shape,
    `class="page-shape-outline${isSelected ? " is-selected" : ""}" data-shape-panel-id="${escapeAttr(panel.id)}" fill="transparent" stroke-width="${num(strokeWidth)}" stroke-linejoin="miter"`
  );
}

function renderShapeVertexHandles(points: [number, number][], selectedIndex: number | null): string {
  const n = points.length;
  const edges = points
    .map((point, i) => {
      const next = points[(i + 1) % n]!;
      const mx = (point[0] + next[0]) / 2;
      const my = (point[1] + next[1]) / 2;
      return `<circle class="page-shape-edge-handle" data-shape-edge="${i}" cx="${num(mx)}" cy="${num(my)}" r="${num(SHAPE_EDGE_MARKER_RADIUS)}" />`;
    })
    .join("");
  const vertices = points
    .map(
      ([x, y], i) =>
        `<circle class="page-shape-vertex-handle${i === selectedIndex ? " is-selected" : ""}" data-shape-vertex="${i}" cx="${num(x)}" cy="${num(y)}" r="${num(SHAPE_VERTEX_RADIUS)}" />`
    )
    .join("");
  // 辺マーカーを先に描き頂点ハンドルを上に重ねる(頂点付近をクリックした時に頂点操作を優先させるため)。
  return `<g class="page-shape-handles">${edges}${vertices}</g>`;
}

function renderShapeSplitPreview(splitDraft: { start: [number, number]; current: [number, number] }): string {
  const [x1, y1] = splitDraft.start;
  const [x2, y2] = splitDraft.current;
  return `<line class="page-shape-split-line" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" />`;
}

function renderShapesToolbar(shapeEdit: PanelShapeEditViewState): string {
  const layout = shapeEdit.layout;
  const selectedPanel = layout && shapeEdit.selectedPanelId ? layout.panels.find((panel) => panel.id === shapeEdit.selectedPanelId) ?? null : null;

  if (!selectedPanel) {
    return `
      <footer class="page-panel-toolbar">
        <p class="page-panel-hint-text">コマをクリックして選択してください。</p>
      </footer>
    `;
  }
  if (selectedPanel.shape.type === "path") {
    return `
      <footer class="page-panel-toolbar">
        <p class="page-panel-hint-text">このコマ形状は編集できません。</p>
      </footer>
    `;
  }
  if (selectedPanel.shape.type !== "polygon") {
    return `
      <footer class="page-panel-toolbar">
        <p class="page-panel-hint-text">頂点を編集するには多角形に変換してください。</p>
        <div class="page-panel-toolbar-actions">
          <button class="button-secondary compact" type="button" data-action="convert-panel-shape-to-polygon">多角形に変換して編集</button>
        </div>
      </footer>
    `;
  }
  if (shapeEdit.splitMode) {
    return `
      <footer class="page-panel-toolbar page-shape-split-toolbar">
        <p class="page-panel-hint-text">コマの上をドラッグして分割線を引いてください。</p>
        <div class="page-panel-toolbar-actions">
          <label class="page-object-property-field">ガター幅
            <input type="number" step="0.005" min="0" max="0.1" data-shape-gutter-field="1" value="${num(shapeEdit.gutter)}" />
          </label>
          <button class="button-secondary compact" type="button" data-action="toggle-panel-shape-split-mode">キャンセル</button>
        </div>
      </footer>
    `;
  }
  return `
    <footer class="page-panel-toolbar">
      <p class="page-panel-hint-text">頂点をドラッグで移動・辺の中点クリックで頂点追加・ダブルクリック(または選択+Delete)で頂点削除</p>
      <div class="page-panel-toolbar-actions">
        <button class="button-secondary compact" type="button" data-action="toggle-panel-shape-split-mode">コマを分割</button>
      </div>
    </footer>
  `;
}

// --- 「モザイク」モード(Docs/Feature-CGCollectionSuite.md P6: 非破壊リージョン編集) ---

const MOSAIC_VERTEX_RADIUS = 0.012;
const MOSAIC_EDGE_MARKER_RADIUS = 0.008;

function renderMosaicStageContent(mosaicEdit: MosaicEditViewState, pageHeight: number): string {
  const selected = mosaicEdit.selectedRegionId
    ? mosaicEdit.regions.find((region) => region.id === mosaicEdit.selectedRegionId) ?? null
    : null;
  const regionsHtml = mosaicEdit.regions.map((region) => renderMosaicRegionShape(region, region.id === mosaicEdit.selectedRegionId)).join("");
  const handles = selected ? renderMosaicHandles(selected, mosaicEdit.selectedVertexIndex) : "";
  const rectPreview = mosaicEdit.addMode === "rect" && mosaicEdit.rectDraft ? renderMosaicRectDraftPreview(mosaicEdit.rectDraft) : "";
  const polygonPreview =
    mosaicEdit.addMode === "polygon" && mosaicEdit.polygonDraft && mosaicEdit.polygonDraft.length > 0
      ? renderMosaicPolygonDraftPreview(mosaicEdit.polygonDraft)
      : "";
  return `
    <g id="pageMosaicStageRoot" transform="scale(${VIEWBOX_SCALE})" data-mosaic-stage="1">
      <rect x="0" y="0" width="1" height="${num(pageHeight)}" class="page-panel-paper" data-mosaic-background="1" />
      ${regionsHtml}
      ${handles}
      ${rectPreview}
      ${polygonPreview}
    </g>
  `;
}

/** リージョン1件の形状(半透明ハッチ塗り+枠)。実際のピクセル化プレビューは preview.png 側で確認する(ライブ canvas ピクセル化は省略)。 */
function renderMosaicRegionShape(region: MosaicRegion, isSelected: boolean): string {
  const stateClass = `page-mosaic-region${isSelected ? " is-selected" : ""}`;
  const attrs = `class="${stateClass}" data-mosaic-region-id="${escapeAttr(region.id)}" stroke-width="${num(isSelected ? 0.01 : 0.005)}"`;
  if (region.shape.type === "rect") {
    const [x, y, w, h] = region.shape.bounds;
    return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" ${attrs} />`;
  }
  const points = region.shape.points.map(([x, y]) => `${num(x)},${num(y)}`).join(" ");
  return `<polygon points="${points}" ${attrs} />`;
}

function renderMosaicHandles(region: MosaicRegion, selectedVertexIndex: number | null): string {
  if (region.shape.type === "rect") {
    const [x, y, w, h] = region.shape.bounds;
    const corners: [number, number][] = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h]
    ];
    const edgeMids: [number, number][] = [
      [x + w / 2, y],
      [x + w, y + h / 2],
      [x + w / 2, y + h],
      [x, y + h / 2]
    ];
    const cornerHandles = corners
      .map(([cx, cy], i) => `<circle class="page-mosaic-rect-handle" data-mosaic-rect-corner="${i}" cx="${num(cx)}" cy="${num(cy)}" r="${num(MOSAIC_VERTEX_RADIUS)}" />`)
      .join("");
    const edgeHandles = edgeMids
      .map(([ex, ey], i) => `<circle class="page-mosaic-rect-edge-handle" data-mosaic-rect-edge="${i}" cx="${num(ex)}" cy="${num(ey)}" r="${num(MOSAIC_EDGE_MARKER_RADIUS)}" />`)
      .join("");
    return `<g class="page-mosaic-handles">${edgeHandles}${cornerHandles}</g>`;
  }
  const points = region.shape.points;
  const n = points.length;
  const edges = points
    .map((point, i) => {
      const next = points[(i + 1) % n]!;
      const mx = (point[0] + next[0]) / 2;
      const my = (point[1] + next[1]) / 2;
      return `<circle class="page-mosaic-edge-handle" data-mosaic-edge="${i}" cx="${num(mx)}" cy="${num(my)}" r="${num(MOSAIC_EDGE_MARKER_RADIUS)}" />`;
    })
    .join("");
  const vertices = points
    .map(
      ([x, y], i) =>
        `<circle class="page-mosaic-vertex-handle${i === selectedVertexIndex ? " is-selected" : ""}" data-mosaic-vertex="${i}" cx="${num(x)}" cy="${num(y)}" r="${num(MOSAIC_VERTEX_RADIUS)}" />`
    )
    .join("");
  return `<g class="page-mosaic-handles">${edges}${vertices}</g>`;
}

function renderMosaicRectDraftPreview(draft: { start: [number, number]; current: [number, number] }): string {
  const x = Math.min(draft.start[0], draft.current[0]);
  const y = Math.min(draft.start[1], draft.current[1]);
  const w = Math.abs(draft.current[0] - draft.start[0]);
  const h = Math.abs(draft.current[1] - draft.start[1]);
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" class="page-mosaic-draft-preview page-mosaic-draft-rect" />`;
}

function renderMosaicPolygonDraftPreview(points: [number, number][]): string {
  const pointsAttr = points.map(([x, y]) => `${num(x)},${num(y)}`).join(" ");
  const vertices = points.map(([x, y]) => `<circle class="page-mosaic-draft-vertex" cx="${num(x)}" cy="${num(y)}" r="${num(MOSAIC_EDGE_MARKER_RADIUS)}" />`).join("");
  return `<g class="page-mosaic-draft-polygon"><polyline points="${pointsAttr}" class="page-mosaic-draft-preview page-mosaic-draft-line" />${vertices}</g>`;
}

function renderMosaicToolbar(mosaicEdit: MosaicEditViewState): string {
  const selected = mosaicEdit.selectedRegionId
    ? mosaicEdit.regions.find((region) => region.id === mosaicEdit.selectedRegionId) ?? null
    : null;
  const addButtons = `
    <button class="button-secondary compact${mosaicEdit.addMode === "rect" ? " is-active" : ""}" type="button" data-action="set-mosaic-add-mode" data-id="rect">${iconPlus()}矩形を追加</button>
    <button class="button-secondary compact${mosaicEdit.addMode === "polygon" ? " is-active" : ""}" type="button" data-action="set-mosaic-add-mode" data-id="polygon">${iconPlus()}多角形を追加</button>
  `;

  if (mosaicEdit.addMode === "rect") {
    return `
      <footer class="page-panel-toolbar page-mosaic-toolbar">
        <div class="page-object-toolbar-row">${addButtons}</div>
        <p class="page-panel-hint-text">ステージ上をドラッグして矩形リージョンを作成(もう一度ボタンを押すとキャンセル)</p>
      </footer>
    `;
  }
  if (mosaicEdit.addMode === "polygon") {
    return `
      <footer class="page-panel-toolbar page-mosaic-toolbar">
        <div class="page-object-toolbar-row">${addButtons}</div>
        <p class="page-panel-hint-text">クリックで頂点を追加、ダブルクリックまたは始点クリックで確定(もう一度ボタンを押すとキャンセル)</p>
      </footer>
    `;
  }

  const [minX, minY, maxX, maxY] = selected ? regionBoundsPage(selected) : [0, 0, 0, 0];
  const hasGranularity = Boolean(selected?.granularity);

  return `
    <footer class="page-panel-toolbar page-mosaic-toolbar">
      <div class="page-object-toolbar-row">
        ${addButtons}
        ${selected ? `<button class="button-danger compact" type="button" data-action="delete-selected-mosaic-region" title="削除(Delete キー)">${iconTrash()}削除</button>` : ""}
      </div>
      ${
        selected
          ? `
            <div class="page-object-property-row">
              <span class="page-panel-hint-text">範囲: (${num(minX)}, ${num(minY)}) - (${num(maxX)}, ${num(maxY)})</span>
              <label class="page-object-property-field page-object-checkbox-field">
                <input type="checkbox" data-mosaic-field="granularityEnabled" ${hasGranularity ? "checked" : ""} /> 粒度を指定
              </label>
              ${
                hasGranularity
                  ? `
                    <label class="page-object-property-field">粒度(長辺比)
                      <input type="number" step="0.001" min="${MOSAIC_GRANULARITY_MIN}" max="${MOSAIC_GRANULARITY_MAX}" data-mosaic-field="granularity" value="${num(selected!.granularity ?? 0)}" />
                    </label>
                  `
                  : ""
              }
            </div>
            <p class="page-panel-hint-text">${
              selected.shape.type === "rect"
                ? "4隅で自由リサイズ・辺の中点で1軸リサイズ"
                : "頂点をドラッグで移動・辺の中点クリックで頂点追加・ダブルクリック(または選択+Delete)で頂点削除"
            }。粒度は未指定(自動)でも規定の最小粒度が書き出し時に適用されます -- 実際のモザイク画像はページ一覧のプレビューや書き出しでご確認ください。</p>
          `
          : `<p class="page-panel-hint-text">リージョンをクリックして選択(Delete で削除)。「矩形を追加」「多角形を追加」で新規作成できます。</p>`
      }
    </footer>
  `;
}

// --- 「オブジェクト」モード(Docs/Feature-CGCollectionSuite.md P1: box / P2: text / P3: balloon、
//      Docs/Feature-ScriptToManga.md S2: image + back/front 帯) ---

/** ギズモで動かせるオブジェクトの型(box/text/balloon/image)。 */
type EditablePageObject = BoxObject | TextObject | BalloonObject | ImageObject;

function isEditablePageObject(object: PageObject): object is EditablePageObject {
  return object.kind === "box" || object.kind === "text" || object.kind === "balloon" || object.kind === "image";
}

/** image オブジェクトのうち back 帯に属するか(既定は front)。サーバ側 openRasterExport.ts と同じ判定。 */
function isBackBandObject(object: PageObject): boolean {
  return object.kind === "image" && object.band === "back";
}

/**
 * 対象コマの非活性背景1件(画像 + 枠)。objects モードでは pointer-events を一切拾わせず、
 * コマ画像の下に敷いて「ぶち抜き位置を見ながら編集できる」ようにする(受け入れ条件)。
 * clip は panels モードと同じ `panelClipId` を再利用する(defs も共有)。
 */
function renderObjectsPanelBackgroundImage(panel: LayoutPanel, assignment: PagePanelAssignment | null): string {
  if (!assignment) {
    return "";
  }
  const crop = assignment.crop;
  const bounds = panelBounds(panel.shape);
  const rect = imageRectForCrop(bounds, crop);
  const transform = rotationTransformAttr(crop, boxCenter(bounds));
  const image = `<image href="${escapeAttr(assignment.assetImageUrl)}" x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" preserveAspectRatio="none" class="page-object-panel-bg-image"${transform} />`;
  return `<g clip-path="url(#${panelClipId(panel.id)})" pointer-events="none">${image}</g>`;
}

function renderObjectsPanelBackgroundOutline(panel: LayoutPanel): string {
  return panelShapeElement(panel.shape, `class="page-object-panel-bg-outline" fill="none" pointer-events="none"`);
}

/**
 * オブジェクトモードの `<svg>` 中身。scale(1000) group 内に正規化座標で描く(注意: group 外に置くと実質不可視)。
 * S2: コマ画像+コマ枠を非活性背景として、back帯image → 枠 → front帯(image含む text/balloon/box)の順で
 * 重ねる(受け入れ条件: ぶち抜き位置を見ながら編集できること)。
 */
function renderObjectsStageContent(
  objects: PageObject[],
  selectedObjectId: string | null,
  pageHeight: number,
  layout: PageLayout | null,
  assignments: PagePanelAssignment[],
  missingMediaIds: string[],
  chroniclePreviewObjects: PageObject[] = []
): string {
  const selected = objects.find((object) => object.id === selectedObjectId);
  const selectedEditable = selected && isEditablePageObject(selected) ? selected : null;
  const backObjects = objects.filter(isBackBandObject);
  const frontObjects = objects.filter((object) => !isBackBandObject(object));
  const assignmentByPanel = new Map(assignments.map((assignment) => [assignment.panelId, assignment]));
  const panels = layout ? [...layout.panels].sort((a, b) => a.order - b.order) : [];
  const panelBackground = layout
    ? `<g class="page-object-panel-background">${panels.map((panel) => renderObjectsPanelBackgroundImage(panel, assignmentByPanel.get(panel.id) ?? null)).join("")}</g>`
    : "";
  const panelFrame = layout
    ? `<g class="page-object-panel-frame" pointer-events="none">${panels.map(renderObjectsPanelBackgroundOutline).join("")}</g>`
    : "";
  return `
    <defs>${panels.map(renderPanelClipPath).join("")}</defs>
    <g id="pageObjectStageRoot" transform="scale(${VIEWBOX_SCALE})">
      <rect x="0" y="0" width="1" height="${num(pageHeight)}" class="page-panel-paper" data-page-object-background="1" />
      ${panelBackground}
      ${backObjects.map((object) => renderPageObjectShape(object, object.id === selectedObjectId, missingMediaIds)).join("")}
      ${panelFrame}
      ${frontObjects.map((object) => renderPageObjectShape(object, object.id === selectedObjectId, missingMediaIds)).join("")}
      ${selectedEditable ? renderPageObjectGizmo(selectedEditable, pageHeight) : ""}
      ${renderChroniclePreviewGhosts(chroniclePreviewObjects)}
    </g>
  `;
}

/**
 * Chronicle 一括配置(Docs/Done/Feature-ChroniclePageFlow.md §2.3 フェーズIII)の配置案プレビュー。
 * DB へは保存しない仮の PageObject 群を、半透明・破線のゴーストとしてステージ最前面へ重ねて描く
 * (`pointer-events: none` -- クリック/ドラッグは既存オブジェクトへ素通しする)。正確な吹き出し曲線
 * (`renderBalloonSvg`)ではなく簡易矩形で近似する(ゴーストは「だいたいの位置・サイズ」を見せれば十分、
 * かつ text/sfx オブジェクトはサイズを持たないため矩形近似のほうが kind によらず一貫して描ける)。
 */
function renderChroniclePreviewGhosts(objects: PageObject[]): string {
  if (objects.length === 0) {
    return "";
  }
  return `<g class="chronicle-preview-ghost-layer" pointer-events="none">${objects.map(renderChroniclePreviewGhost).join("")}</g>`;
}

function chroniclePreviewGhostBox(object: PageObject): { x: number; y: number; w: number; h: number } {
  if (object.kind === "box" || object.kind === "balloon" || object.kind === "image") {
    return { x: object.position.x - object.size.x / 2, y: object.position.y - object.size.y / 2, w: object.size.x, h: object.size.y };
  }
  // text(sfx): size を持たないので文字数からの概算(ゴースト表示専用、正確なレイアウトではない)。
  const length = Math.max(1, object.content.text.length);
  const w = Math.min(0.6, 0.05 + length * 0.02);
  const h = 0.06;
  return { x: object.position.x - w / 2, y: object.position.y - h / 2, w, h };
}

function chroniclePreviewGhostLabel(object: PageObject): string {
  if (object.kind === "balloon" || object.kind === "box") {
    return object.content?.text ?? "";
  }
  if (object.kind === "text") {
    return object.content.text;
  }
  return "";
}

function renderChroniclePreviewGhost(object: PageObject): string {
  const box = chroniclePreviewGhostBox(object);
  const label = chroniclePreviewGhostLabel(object);
  const kindClass = object.kind === "balloon" ? " is-balloon" : object.kind === "text" ? " is-sfx" : " is-box";
  const radius = object.kind === "balloon" ? Math.min(box.w, box.h) / 2 : Math.min(box.w, box.h) * 0.15;
  const fontSize = Math.max(0.012, Math.min(0.026, box.h * 0.4));
  const text = label
    ? `<text x="${num(object.position.x)}" y="${num(object.position.y)}" font-size="${num(fontSize)}" text-anchor="middle" dominant-baseline="central">${escapeHtml(label.length > 20 ? `${label.slice(0, 20)}…` : label)}</text>`
    : "";
  return `
    <g class="chronicle-preview-ghost-item${kindClass}">
      <rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" rx="${num(radius)}" />
      ${text}
    </g>
  `;
}

function renderPageObjectShape(object: PageObject, isSelected: boolean, missingMediaIds: string[] = []): string {
  if (object.kind === "box") {
    return renderBoxObjectShape(object, isSelected);
  }
  if (object.kind === "text") {
    return renderTextObjectShape(object, isSelected);
  }
  if (object.kind === "image") {
    return renderImageObjectShape(object, isSelected, missingMediaIds.includes(object.mediaId));
  }
  return renderBalloonObjectShape(object, isSelected);
}

/**
 * 画像オブジェクト1件(Docs/Feature-ScriptToManga.md S2)。ヒットは「透明外接矩形 `fill="transparent"`
 * (`"none"` 禁止)+表示要素 pointer-events:none」パターン踏襲。clipPanelId があれば `panelClipId` の
 * clipPath(コマモードと共有の defs)でクリップする。欠損時(missing)はプレースホルダ(破線枠+media id)を表示する
 * (Docs/Feature-ScriptToManga.md S2: 「file/media 行欠損は編集画面ではプレースホルダ表示。黙って落とさない」)。
 */
function renderImageObjectShape(object: ImageObject, isSelected: boolean, isMissing: boolean): string {
  const x = object.position.x - object.size.x / 2;
  const y = object.position.y - object.size.y / 2;
  const deg = (object.rotation * 180) / Math.PI;
  const transform = deg ? ` transform="rotate(${num(deg)} ${num(object.position.x)} ${num(object.position.y)})"` : "";
  const stateClass = isSelected ? " is-selected" : "";
  const hitArea = `<rect data-page-object="${escapeAttr(object.id)}" class="page-object-hit-area${stateClass}" x="${num(x)}" y="${num(y)}" width="${num(object.size.x)}" height="${num(object.size.y)}" fill="transparent" stroke="none"${transform} />`;

  if (isMissing) {
    const placeholder = `<rect class="page-object-image-missing" x="${num(x)}" y="${num(y)}" width="${num(object.size.x)}" height="${num(object.size.y)}" fill="none" pointer-events="none"${transform} />`;
    // font-size は他の SVG 要素(pageLayoutSvg.ts の page-layout-order)と同じく scale(1000) group 内の
    // 正規化単位で指定する(CSS px は ambient transform の影響を受けて巨大化するため使わない)。
    const fontSize = Math.max(0.012, Math.min(0.03, object.size.y * 0.12));
    const label = `<text class="page-object-image-missing-label" x="${num(object.position.x)}" y="${num(object.position.y)}" font-size="${num(fontSize)}" text-anchor="middle" dominant-baseline="central" pointer-events="none">${escapeHtml(object.mediaId)}</text>`;
    return `<g class="page-object-image is-missing">${hitArea}${placeholder}${label}</g>`;
  }

  const opacity = object.opacity ?? 1;
  const href = `/api/page-media/${encodeURIComponent(object.mediaId)}`;
  const image = `<image href="${escapeAttr(href)}" x="${num(x)}" y="${num(y)}" width="${num(object.size.x)}" height="${num(object.size.y)}" preserveAspectRatio="none" class="page-object-image-el" opacity="${num(opacity)}" pointer-events="none"${transform} />`;
  const clipped = object.clipPanelId ? `<g clip-path="url(#${panelClipId(object.clipPanelId)})">${image}</g>` : image;
  return `<g class="page-object-image">${hitArea}${clipped}</g>`;
}

/**
 * box/balloon の内包テキスト(content)のグリフ描画。`getCachedTextLayout` が未着(初回・サイズ変更直後)
 * の間は何も出さない(box/balloon 本体の枠だけは常に見えているので、text オブジェクトのような
 * プレースホルダ点線は不要)。maxWidth は呼び出し側(box は `contentMaxWidth`、balloon は形状の内接矩形
 * 係数を含む `balloonContentMaxWidth`)が渡す -- ここでは共通のグリフ描画だけを担う。
 */
function renderInlineContentGlyphs(content: TextContent | null | undefined, maxWidth: number, position: PageVec, rotation: number): string {
  if (!content) {
    return "";
  }
  const layout = getCachedTextLayout(content, maxWidth);
  return layout ? renderTextSvg(layout, position, rotation, content.style) : "";
}

function renderBoxObjectShape(object: BoxObject, isSelected: boolean): string {
  const x = object.position.x - object.size.x / 2;
  const y = object.position.y - object.size.y / 2;
  const deg = (object.rotation * 180) / Math.PI;
  const transform = deg ? ` transform="rotate(${num(deg)} ${num(object.position.x)} ${num(object.position.y)})"` : "";
  const radius = object.cornerRadius ? ` rx="${num(object.cornerRadius)}"` : "";
  const stateClass = isSelected ? " is-selected" : "";
  const rect = `<rect data-page-object="${escapeAttr(object.id)}" class="page-object-shape${stateClass}" x="${num(x)}" y="${num(y)}" width="${num(object.size.x)}" height="${num(object.size.y)}"${radius} fill="${escapeAttr(object.fill)}" stroke="${escapeAttr(object.strokeColor)}" stroke-width="${num(object.strokeWidth)}"${transform} />`;
  const maxWidth = object.content ? contentMaxWidth(object.size, object.content.style.direction) : 0;
  const content = renderInlineContentGlyphs(object.content, maxWidth, object.position, object.rotation);
  return content ? `<g class="page-object-box">${rect}${content}</g>` : rect;
}

/**
 * 吹き出し1件。本体+しっぽは `renderBalloonSvg`(クライアント/サーバ共用の純ロジック)にそのまま任せる
 * -- 見た目(継ぎ目の消え方含む)を書き出しと一致させる P3 の核方針。本体パスは pointer-events なし
 * (`.page-object-balloon-shape`)にし、box/text と同じく「透明な当たり判定矩形」を選択/ドラッグに使う
 * (吹き出し形状の凹凸で当たり判定が抜けるのを避けるため、雲形/フラッシュも含め常に外接矩形をヒット領域にする)。
 */
function renderBalloonObjectShape(object: BalloonObject, isSelected: boolean): string {
  const deg = (object.rotation * 180) / Math.PI;
  const transform = deg ? ` transform="rotate(${num(deg)} ${num(object.position.x)} ${num(object.position.y)})"` : "";
  const hitX = object.position.x - object.size.x / 2;
  const hitY = object.position.y - object.size.y / 2;
  const stateClass = isSelected ? " is-selected" : "";
  const hitArea = `<rect data-page-object="${escapeAttr(object.id)}" class="page-object-hit-area${stateClass}" x="${num(hitX)}" y="${num(hitY)}" width="${num(object.size.x)}" height="${num(object.size.y)}" fill="transparent" stroke="none"${transform} />`;
  const shape = renderBalloonSvg(object, object.position, object.rotation);
  const maxWidth = object.content ? balloonContentMaxWidth(object.shape, object.size, object.content.style.direction) : 0;
  const content = renderInlineContentGlyphs(object.content, maxWidth, object.position, object.rotation);
  return `<g class="page-object-balloon">${hitArea}${shape}${content}</g>`;
}

/**
 * text オブジェクト1件。グリフは `renderTextSvg`(クライアント/サーバ共用の純ロジック)の出力をそのまま
 * 埋め込む -- プレビューと書き出しの見た目を一致させる P2 の核方針。グリフパスは pointer-events なし
 * (`.page-object-text-glyphs`)なので、選択/ドラッグの当たり判定は別途「透明な矩形」を敷く
 * (**fill="none" は SVG のヒットテスト対象から除外されるため使わない** -- panel クロップの既知の罠と同じ)。
 * レイアウト未着(初回・サイズ変更直後)は破線のプレースホルダ枠だけを出す。
 */
function renderTextObjectShape(object: TextObject, isSelected: boolean): string {
  const box = gizmoBoxForPageObject(object);
  const deg = (object.rotation * 180) / Math.PI;
  const transform = deg ? ` transform="rotate(${num(deg)} ${num(object.position.x)} ${num(object.position.y)})"` : "";
  const hitX = box.center.x - box.size.x / 2;
  const hitY = box.center.y - box.size.y / 2;
  const stateClass = isSelected ? " is-selected" : "";
  const hitArea = `<rect data-page-object="${escapeAttr(object.id)}" class="page-object-hit-area${stateClass}" x="${num(hitX)}" y="${num(hitY)}" width="${num(box.size.x)}" height="${num(box.size.y)}" fill="transparent" stroke="none"${transform} />`;
  const layout = getCachedTextLayout(object.content, object.maxWidth);
  const content = layout
    ? renderTextSvg(layout, object.position, object.rotation, object.content.style)
    : `<rect class="page-object-text-placeholder" x="${num(hitX)}" y="${num(hitY)}" width="${num(box.size.x)}" height="${num(box.size.y)}" fill="none"${transform} />`;
  return `<g class="page-object-text">${hitArea}${content}</g>`;
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

/**
 * balloon のしっぽ tip ハンドルの世界(ページ)座標。tip はローカル座標(中心=原点、回転前)なので、
 * オブジェクトの回転を掛けてから position を足す(`rotatePointAround` を原点まわりの回転として使う)。
 */
function balloonTailHandlePoint(object: BalloonObject): { x: number; y: number } {
  if (!object.tail) {
    return object.position;
  }
  const rotated = rotatePointAround(object.tail.tip, { x: 0, y: 0 }, object.rotation);
  return { x: object.position.x + rotated.x, y: object.position.y + rotated.y };
}

/**
 * paste/crop 風ギズモ(コーナー=拡縮 / 上のハンドル=回転)。選択中の box/text/balloon オブジェクトの
 * 外接矩形まわりに描く。矩形自体は `gizmoBoxForPageObject`(box/balloon は size そのまま、text は
 * レイアウト bbox)。balloon にしっぽがあれば、専用の tip ドラッグハンドル(別色)も追加する。
 */
function renderPageObjectGizmo(object: EditablePageObject, pageHeight: number): string {
  const box = gizmoBoxForPageObject(object);
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
  const tailHandle =
    object.kind === "balloon" && object.tail
      ? (() => {
          const point = balloonTailHandlePoint(object);
          return `<circle id="pageObjectGizmoTail" class="page-object-gizmo-handle page-object-gizmo-tail-handle" style="cursor:move;" data-page-object-handle="tail" data-page-object-owner="${escapeAttr(object.id)}" cx="${num(point.x)}" cy="${num(point.y)}" r="${num(GIZMO_HANDLE_RADIUS)}" />`;
        })()
      : "";
  // sync が柄長/半径を画面基準へ直すために基準点と反転判定用のページ高(data-ph)を data 属性で持たせる。
  return `<g id="pageObjectGizmo" class="page-object-gizmo" data-tmx="${num(topMid.x)}" data-tmy="${num(topMid.y)}" data-upx="${num(up.x)}" data-upy="${num(up.y)}" data-ph="${num(pageHeight)}">
    <polygon id="pageObjectGizmoOutline" class="page-object-gizmo-outline" points="${outlinePoints}" />
    <line id="pageObjectGizmoStick" class="page-object-gizmo-stick" x1="${num(topMid.x)}" y1="${num(topMid.y)}" x2="${num(rotateHandle.x)}" y2="${num(rotateHandle.y)}" />
    ${cornerHandles}
    ${tailHandle}
    <circle id="pageObjectGizmoRotate" class="page-object-gizmo-handle page-object-gizmo-rotate" style="cursor:grab;" data-page-object-handle="rotate" data-page-object-owner="${escapeAttr(object.id)}" cx="${num(rotateHandle.x)}" cy="${num(rotateHandle.y)}" r="${num(GIZMO_HANDLE_RADIUS)}" />
  </g>`;
}

function renderObjectsToolbar(
  objects: PageObject[],
  selectedObjectId: string | null,
  fonts: FontSummary[],
  layout: PageLayout | null,
  imageObjects: ImageObjectViewState,
  dialogueDrawer: DialogueDrawerViewState
): string {
  const selected = objects.find((object) => object.id === selectedObjectId);
  const selectedBox = selected && selected.kind === "box" ? selected : null;
  const selectedText = selected && selected.kind === "text" ? selected : null;
  const selectedBalloon = selected && selected.kind === "balloon" ? selected : null;
  const selectedImage = selected && selected.kind === "image" ? selected : null;
  const hasSelection = Boolean(selectedBox || selectedText || selectedBalloon || selectedImage);
  // "replace" ピッカーは対象(選択中の image オブジェクト)が無くなったら表示しない
  // (選択解除後もピッカーが浮いたままにならないようにする。state 自体はここではリセットしない)。
  const rawPickerMode = imageObjects.picker?.mode ?? null;
  const pickerMode = rawPickerMode === "replace" && !selectedImage ? null : rawPickerMode;
  return `
    <footer class="page-panel-toolbar page-object-toolbar">
      <div class="page-object-toolbar-row">
        <button class="button-secondary compact" type="button" data-action="add-page-object-box">${iconPlus()}ボックス追加</button>
        <button class="button-secondary compact" type="button" data-action="add-page-object-balloon">${iconPlus()}吹き出し追加</button>
        <button class="button-secondary compact" type="button" data-action="add-page-object-text">${iconPlus()}テキスト追加</button>
        <button class="button-secondary compact${pickerMode === "add" ? " is-active" : ""}" type="button" data-action="toggle-page-object-image-picker" data-id="add">${iconPlus()}画像追加</button>
        <button class="button-secondary compact${dialogueDrawer.open ? " is-active" : ""}" type="button" data-action="toggle-dialogue-drawer">${iconScript()}セリフ</button>
        ${
          hasSelection
            ? `
              <button class="button-secondary compact" type="button" data-action="page-object-bring-front" title="最前面へ">前面へ</button>
              <button class="button-secondary compact" type="button" data-action="page-object-send-back" title="最背面へ">背面へ</button>
              <button class="button-danger compact" type="button" data-action="delete-selected-page-object" title="削除(Delete キー)">${iconTrash()}削除</button>
            `
            : ""
        }
      </div>
      ${dialogueDrawer.open ? renderDialogueDrawer(dialogueDrawer, objects) : ""}
      ${pickerMode ? renderImageObjectPicker(imageObjects.pickerAssets) : ""}
      ${
        selectedBox
          ? renderBoxPropertyPanel(selectedBox, fonts)
          : selectedBalloon
            ? renderBalloonPropertyPanel(selectedBalloon, fonts)
            : selectedText
              ? renderTextObjectPanel(selectedText, fonts)
              : selectedImage
                ? renderImageObjectPropertyPanel(selectedImage, layout, imageObjects.missingMediaIds.includes(selectedImage.mediaId))
                : `<p class="page-panel-hint-text">ボックス/吹き出し/テキスト/画像をクリックして選択(ドラッグで移動・コーナーで拡縮・上のハンドルで回転・Delete で削除)</p>`
      }
    </footer>
  `;
}

const SEMANTIC_KIND_LABEL: Record<DialogueLine["semanticKind"], string> = {
  dialogue: "台詞",
  monologue: "心の声",
  narration: "ナレーション",
  sfx: "SFX"
};

/**
 * 「セリフ」ドロワー(Docs/Feature-ScriptToManga.md S3 UI 2)。行クリックで placement 作成+
 * 吹き出し生成が対で行われる(同じ行を複数回クリックすれば1台詞を複数吹き出しへ分割配置できる)。
 * 既に配置済みの行も一覧からは消さず「配置済み ×N」を添えて残す(設計書の逸脱: サーバ側に
 * dialogue_lines.page_id が無く「ページ割当済み・未配置」の中間状態を持たないため、
 * 「このページの PageObject.sourceDialogueLineId」から配置回数を数える方式にしている)。
 */
function renderDialogueDrawer(dialogueDrawer: DialogueDrawerViewState, objects: PageObject[]): string {
  const { lines, llmConfigured, proposals, busy } = dialogueDrawer;
  const placedCounts = new Map<string, number>();
  for (const object of objects) {
    if (object.sourceDialogueLineId) {
      placedCounts.set(object.sourceDialogueLineId, (placedCounts.get(object.sourceDialogueLineId) ?? 0) + 1);
    }
  }
  const listContent =
    lines.length === 0
      ? `<p class="page-panel-hint-text">配置できるセリフがありません。先に脚本画面で取り込んでください。</p>`
      : `
        <p class="page-panel-hint-text">行をクリックすると、このページ(選択中のコマがあればそのコマ中心)に吹き出しを配置します。</p>
        <div class="dialogue-drawer-list">
          ${lines
            .map((line) => {
              const placedCount = placedCounts.get(line.id) ?? 0;
              const orphaned = line.status === "orphaned";
              return `
                <button class="dialogue-drawer-item${orphaned ? " is-orphaned" : ""}" type="button" data-action="place-dialogue-line" data-id="${escapeAttr(line.id)}" ${orphaned ? "disabled" : ""}>
                  <span class="dialogue-drawer-item-speaker">${escapeHtml(line.speakerLabel || "(話者不明)")}</span>
                  <span class="dialogue-drawer-item-kind">${SEMANTIC_KIND_LABEL[line.semanticKind]}</span>
                  <span class="dialogue-drawer-item-text">${escapeHtml(line.text)}</span>
                  ${placedCount > 0 ? `<span class="dialogue-drawer-item-badge">配置済み ×${placedCount}</span>` : ""}
                  ${orphaned ? `<span class="dialogue-drawer-item-badge">⚠ orphaned</span>` : ""}
                </button>
              `;
            })
            .join("")}
        </div>
      `;
  return `
    <div class="dialogue-drawer">
      ${renderDialogueProposalSection(llmConfigured, proposals, busy)}
      ${listContent}
    </div>
  `;
}

const PROPOSAL_STATUS_LABEL: Record<DialogueProposal["status"], string> = {
  proposed: "提案中",
  resolved: "処理済み",
  failed: "失敗"
};

const PROPOSAL_ITEM_STATUS_LABEL: Record<DialogueProposalItem["itemStatus"], string> = {
  proposed: "未処理",
  adopted: "採用済み",
  rejected: "却下",
  replaced: "置換済み"
};

/**
 * 構造化 LLM セリフ提案(Docs/Feature-ScriptToManga.md S4)。「AIセリフ提案」ボタンは llmConfigured
 * (state.llmSettings の baseUrl/model が設定済み)の時だけ表示する。busy は llmImproving と同型の
 * リクエスト送信中フラグ。
 */
function renderDialogueProposalSection(llmConfigured: boolean, proposals: DialogueProposal[], busy: boolean): string {
  if (!llmConfigured) {
    return "";
  }
  return `
    <div class="dialogue-proposal-section">
      <button class="button-secondary compact" type="button" data-action="request-dialogue-proposal" ${busy ? "disabled" : ""}>
        ${iconSparkle()}${busy ? "AI提案を生成中…" : "AIセリフ提案"}
      </button>
      ${proposals.length > 0 ? `<div class="dialogue-proposal-list">${proposals.map(renderDialogueProposal).join("")}</div>` : ""}
    </div>
  `;
}

function renderDialogueProposal(proposal: DialogueProposal): string {
  const items = proposal.items ?? [];
  return `
    <div class="dialogue-proposal">
      <div class="dialogue-proposal-header">
        <span class="dialogue-proposal-model">${escapeHtml(proposal.model)}</span>
        <span class="dialogue-proposal-status is-${proposal.status}">${PROPOSAL_STATUS_LABEL[proposal.status]}</span>
        ${proposal.isStale ? `<span class="dialogue-drawer-item-badge">⚠ 脚本が更新されています</span>` : ""}
      </div>
      ${
        proposal.status === "failed"
          ? `<p class="page-panel-hint-text dialogue-proposal-error">${escapeHtml(proposal.error ?? "生成に失敗しました。")}</p>`
          : ""
      }
      ${
        items.length > 0
          ? `<div class="dialogue-proposal-items">${items.map((item, index) => renderDialogueProposalItem(proposal.id, item, index)).join("")}</div>`
          : ""
      }
    </div>
  `;
}

function renderDialogueProposalItem(proposalId: string, item: DialogueProposalItem, index: number): string {
  const isPending = item.itemStatus === "proposed";
  return `
    <div class="dialogue-proposal-item${isPending ? "" : " is-resolved"}" data-dialogue-proposal-item>
      <div class="dialogue-proposal-item-meta">
        <span class="dialogue-drawer-item-speaker">${escapeHtml(item.speakerName || "(話者不明)")}</span>
        <span class="dialogue-drawer-item-kind">${SEMANTIC_KIND_LABEL[item.semanticKind]}</span>
        ${item.panelId ? `<span class="dialogue-proposal-item-panel">panel: ${escapeHtml(item.panelId)}</span>` : ""}
        ${!isPending ? `<span class="dialogue-drawer-item-badge">${PROPOSAL_ITEM_STATUS_LABEL[item.itemStatus]}</span>` : ""}
      </div>
      ${
        isPending
          ? `
            <textarea class="dialogue-proposal-item-edit" data-dialogue-proposal-edit rows="2">${escapeHtml(item.text)}</textarea>
            <div class="dialogue-proposal-item-actions">
              <button class="button-primary compact" type="button" data-action="adopt-dialogue-proposal-item" data-id="${escapeAttr(proposalId)}" data-item-index="${index}">採用</button>
              <button class="button-secondary compact" type="button" data-action="reject-dialogue-proposal-item" data-id="${escapeAttr(proposalId)}" data-item-index="${index}">却下</button>
            </div>
          `
          : `<p class="dialogue-proposal-item-text">${escapeHtml(item.editedText ?? item.text)}</p>`
      }
    </div>
  `;
}

/** 「画像追加」/「メディア差し替え」ピッカー(PageDetail.assets からのサムネ選択、reference-recent-* を再利用)。 */
function renderImageObjectPicker(assets: Asset[]): string {
  if (assets.length === 0) {
    return `<p class="page-panel-hint-text">このページにはまだ画像がありません。先に生成 or 取り込みしてください。</p>`;
  }
  return `
    <div class="reference-recent page-object-image-picker">
      <p class="reference-recent-label">画像を選択</p>
      <div class="reference-recent-strip">
        ${assets
          .map(
            (asset) =>
              `<button class="reference-recent-item" type="button" data-action="pick-page-object-image" data-id="${escapeAttr(asset.id)}" aria-label="この画像を使う" title="この画像を使う"><img src="${escapeAttr(asset.thumbnailUrl)}" alt="" loading="lazy" draggable="false" /></button>`
          )
          .join("")}
      </div>
      <button class="button-secondary compact" type="button" data-action="toggle-page-object-image-picker" data-id="cancel">キャンセル</button>
    </div>
  `;
}

/** 画像オブジェクトのプロパティパネル(帯トグル・不透明度・クリップ先コマ選択・メディア差し替え)。 */
function renderImageObjectPropertyPanel(object: ImageObject, layout: PageLayout | null, isMissing: boolean): string {
  const band = object.band ?? "front";
  const panelOptions = (layout?.panels ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((panel) => `<option value="${escapeAttr(panel.id)}"${object.clipPanelId === panel.id ? " selected" : ""}>コマ ${panel.order}</option>`)
    .join("");
  return `
    ${isMissing ? `<p class="page-panel-hint-text page-object-image-missing-hint">メディアが見つかりません(media id: ${escapeHtml(object.mediaId)})。「メディア差し替え」で選び直せます。</p>` : ""}
    <div class="page-object-property-row">
      <label class="page-object-property-field">レイヤー帯
        <select data-page-object-field="band">
          <option value="front"${band === "front" ? " selected" : ""}>前面(コマ枠より前)</option>
          <option value="back"${band === "back" ? " selected" : ""}>背面(コマ枠より後ろ)</option>
        </select>
      </label>
      <label class="page-object-property-field">不透明度
        <input type="range" min="0" max="1" step="0.01" data-page-object-field="opacity" value="${num(object.opacity ?? 1)}" />
      </label>
    </div>
    <div class="page-object-property-row">
      <label class="page-object-property-field page-object-property-field-wide">クリップ先のコマ
        <select data-page-object-field="clipPanelId"${panelOptions ? "" : " disabled"}>
          <option value=""${object.clipPanelId ? "" : " selected"}>クリップしない(ぶち抜き)</option>
          ${panelOptions}
        </select>
      </label>
      <button class="button-secondary compact" type="button" data-action="toggle-page-object-image-picker" data-id="replace">メディア差し替え</button>
    </div>
  `;
}

/** box/balloon 共通の「テキストを載せる」トグル+本文 textarea+スタイル欄。 */
function renderContentSection(content: TextContent | null | undefined, fonts: FontSummary[]): string {
  return `
    <div class="page-object-property-row">
      <label class="page-object-property-field page-object-checkbox-field">
        <input type="checkbox" data-page-object-field="hasContent" ${content ? "checked" : ""} /> テキストを載せる
      </label>
    </div>
    ${
      content
        ? `
          <textarea class="page-object-textarea" data-page-object-text="1" rows="2" placeholder="テキストを入力">${escapeHtml(content.text)}</textarea>
          ${renderTextStyleFields(content.style, fonts, "data-page-object-content-field")}
        `
        : ""
    }
  `;
}

function renderBoxPropertyPanel(object: BoxObject, fonts: FontSummary[]): string {
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
    ${renderContentSection(object.content, fonts)}
  `;
}

const BALLOON_SHAPE_LABELS: Record<BalloonShape, string> = {
  ellipse: "楕円",
  rounded: "角丸",
  cloud: "雲形",
  jagged: "フラッシュ",
  thought: "思考"
};

/** balloon オブジェクトのプロパティパネル(形状/塗り/線/しっぽ トグル+幅、content は box と共通)。 */
function renderBalloonPropertyPanel(object: BalloonObject, fonts: FontSummary[]): string {
  const hasTail = Boolean(object.tail);
  const shapeOptions = (Object.keys(BALLOON_SHAPE_LABELS) as BalloonShape[])
    .map((shape) => `<option value="${shape}"${object.shape === shape ? " selected" : ""}>${escapeHtml(BALLOON_SHAPE_LABELS[shape])}</option>`)
    .join("");
  return `
    <div class="page-object-property-row">
      <label class="page-object-property-field page-object-property-field-wide">形状
        <select data-page-object-field="shape">${shapeOptions}</select>
      </label>
      <label class="page-object-property-field">塗り
        <input type="color" data-page-object-field="fill" value="${escapeAttr(object.fill)}" />
      </label>
      <label class="page-object-property-field">線色
        <input type="color" data-page-object-field="strokeColor" value="${escapeAttr(object.strokeColor)}" />
      </label>
      <label class="page-object-property-field">線幅
        <input type="number" step="0.001" min="0" max="0.2" data-page-object-field="strokeWidth" value="${num(object.strokeWidth)}" />
      </label>
    </div>
    <div class="page-object-property-row">
      <label class="page-object-property-field page-object-checkbox-field">
        <input type="checkbox" data-page-object-field="tailEnabled" ${hasTail ? "checked" : ""} /> しっぽ
      </label>
      ${
        hasTail
          ? `
            <label class="page-object-property-field">しっぽ幅
              <input type="number" step="0.005" min="0" data-page-object-field="tailWidth" value="${num(object.tail?.width ?? 0)}" />
            </label>
            <p class="page-panel-hint-text">オレンジのハンドルをドラッグでしっぽの先端を動かせます</p>
          `
          : ""
      }
    </div>
    ${renderContentSection(object.content, fonts)}
  `;
}

/** text オブジェクト本体のプロパティパネル(本文 textarea + スタイル欄 + 折り返し幅)。 */
function renderTextObjectPanel(object: TextObject, fonts: FontSummary[]): string {
  const hasMaxWidth = object.maxWidth !== undefined;
  return `
    <textarea class="page-object-textarea" data-page-object-text="1" rows="3" placeholder="テキストを入力">${escapeHtml(object.content.text)}</textarea>
    ${renderTextStyleFields(object.content.style, fonts, "data-page-object-field")}
    <div class="page-object-property-row">
      <label class="page-object-property-field page-object-checkbox-field">
        <input type="checkbox" data-page-object-field="maxWidthEnabled" ${hasMaxWidth ? "checked" : ""} /> 折り返し幅を指定
      </label>
      ${
        hasMaxWidth
          ? `
            <label class="page-object-property-field">折り返し幅
              <input type="number" step="0.01" min="${PAGE_OBJECT_MIN_SIZE}" data-page-object-field="maxWidth" value="${num(object.maxWidth ?? 0)}" />
            </label>
          `
          : ""
      }
    </div>
  `;
}

function fontOptionsHtml(fonts: FontSummary[], currentFontId: string): string {
  const options = fonts.map((font) => {
    const label = font.subfamilyName && font.subfamilyName !== "Regular" ? `${font.familyName} ${font.subfamilyName}` : font.familyName;
    return `<option value="${escapeAttr(font.id)}"${font.id === currentFontId ? " selected" : ""}>${escapeHtml(label)}</option>`;
  });
  if (currentFontId && !fonts.some((font) => font.id === currentFontId) && currentFontId !== "default") {
    options.unshift(`<option value="${escapeAttr(currentFontId)}" selected>${escapeHtml(currentFontId)}</option>`);
  }
  // 新規テキストの既定は fontId="default"(サーバが Noto Sans JP → 游ゴシック → メイリオへ解決する)。
  // value="default" のオプションが無いとブラウザが一覧先頭のフォントを表示してしまい、
  // 実際に使われる既定フォントと select の表示が食い違う。常に先頭へ置く。
  options.unshift(`<option value="default"${currentFontId === "default" ? " selected" : ""}>既定フォント</option>`);
  return options.join("");
}

/**
 * TextStyle の編集欄(フォント/縦横/サイズ/文字色/行間/字間/揃え/フチ)。TextObject 自身にも
 * box/balloon の内包テキストにも使う共通パーツ(`fieldAttr` で `data-page-object-field` /
 * `data-page-object-content-field` を切り替える)。フォントのライセンス注意もここに出す。
 */
function renderTextStyleFields(style: TextStyle, fonts: FontSummary[], fieldAttr: string): string {
  const hasOutline = Boolean(style.outlineColor && style.outlineWidth);
  return `
    <div class="page-object-property-row">
      <label class="page-object-property-field page-object-property-field-wide">フォント
        <select ${fieldAttr}="fontId">${fontOptionsHtml(fonts, style.fontId)}</select>
      </label>
      <label class="page-object-property-field">向き
        <select ${fieldAttr}="direction">
          <option value="vertical"${style.direction === "vertical" ? " selected" : ""}>縦書き</option>
          <option value="horizontal"${style.direction === "horizontal" ? " selected" : ""}>横書き</option>
        </select>
      </label>
    </div>
    <div class="page-object-property-row">
      <label class="page-object-property-field">サイズ
        <input type="number" step="0.005" min="${TEXT_SIZE_MIN}" max="${TEXT_SIZE_MAX}" ${fieldAttr}="size" value="${num(style.size)}" />
      </label>
      <label class="page-object-property-field">文字色
        <input type="color" ${fieldAttr}="color" value="${escapeAttr(style.color)}" />
      </label>
      <label class="page-object-property-field">行間
        <input type="number" step="0.1" min="0.5" max="4" ${fieldAttr}="lineSpacing" value="${num(style.lineSpacing ?? 1.6)}" />
      </label>
      <label class="page-object-property-field">字間
        <input type="number" step="0.1" min="0.2" max="4" ${fieldAttr}="letterSpacing" value="${num(style.letterSpacing ?? 1.0)}" />
      </label>
    </div>
    <div class="page-object-property-row">
      <label class="page-object-property-field">揃え
        <select ${fieldAttr}="align">
          <option value="start"${(style.align ?? "start") === "start" ? " selected" : ""}>先頭</option>
          <option value="center"${style.align === "center" ? " selected" : ""}>中央</option>
          <option value="end"${style.align === "end" ? " selected" : ""}>末尾</option>
        </select>
      </label>
      <label class="page-object-property-field page-object-checkbox-field">
        <input type="checkbox" ${fieldAttr}="outlineEnabled" ${hasOutline ? "checked" : ""} /> フチ
      </label>
      ${
        hasOutline
          ? `
            <label class="page-object-property-field">フチ色
              <input type="color" ${fieldAttr}="outlineColor" value="${escapeAttr(style.outlineColor ?? "#ffffff")}" />
            </label>
            <label class="page-object-property-field">フチ太さ
              <input type="number" step="0.01" min="0" max="1" ${fieldAttr}="outlineWidth" value="${num(style.outlineWidth ?? 0)}" />
            </label>
          `
          : ""
      }
    </div>
    <p class="page-object-font-license-note">⚠ 頒布時はフォントのライセンスをご確認ください</p>
  `;
}
