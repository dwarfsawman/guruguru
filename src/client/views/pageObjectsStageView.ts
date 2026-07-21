/**
 * ページ編集 lightbox「オブジェクト」モードのステージ描画(pagePanelLightboxView.ts から分割)。
 * box/text/balloon/image/tone オブジェクトの SVG 描画、コマ画像+枠の非活性背景、選択ギズモ、
 * Chronicle 配置案ゴーストを含む。座標は scale(1000) group 内の width-relative 正規化。
 */
import type { PagePanelAssignment } from "../../shared/apiTypes";
import type { LayoutPanel, PageLayout } from "../../shared/pageLayout";
import { panelBounds } from "../../shared/pageLayout";
import {
  contentMaxWidth,
  type BalloonObject,
  type BoxObject,
  type ImageObject,
  type PageObject,
  type PageVec,
  type TextContent,
  type TextObject,
  type ToneObject
} from "../../shared/pageObjects";
import { balloonContentMaxWidth, renderBalloonSvg } from "../../shared/balloonShape";
import { renderTextSvg } from "../../shared/textSvg";
import { effectiveGradientPoints, hasOptionalGradient, renderToneSvg } from "../../shared/toneSvg";
import { gizmoBoxCorners, gizmoRotateHandlePoint, gizmoTopMid, gizmoUpVector, rotatePointAround } from "../svgGizmo";
import { gizmoBoxForPageObject } from "../pageObjectGizmoBox";
import { getCachedTextLayout } from "../textLayoutClient";
import { escapeAttr, escapeHtml } from "../format";
import { visiblePageObjects } from "../pageLayers";
import { num, panelShapeElement } from "./pageLayoutSvg";
import {
  GIZMO_HANDLE_RADIUS,
  GIZMO_ROTATE_STICK,
  VIEWBOX_SCALE,
  boxCenter,
  imageRectForCrop,
  panelClipId,
  renderPanelClipPath,
  rotationTransformAttr,
  type PageLayerViewState
} from "./lightboxViewShared";

// --- 「オブジェクト」モード(Docs/Feature-CGCollectionSuite.md P1: box / P2: text / P3: balloon、
//      Docs/Feature-ScriptToManga.md S2: image + back/front 帯) ---

/** ギズモで動かせるオブジェクトの型(box/text/balloon/image/tone)。 */
type EditablePageObject = BoxObject | TextObject | BalloonObject | ImageObject | ToneObject;

function isEditablePageObject(object: PageObject): object is EditablePageObject {
  return (
    object.kind === "box" || object.kind === "text" || object.kind === "balloon" || object.kind === "image" || object.kind === "tone"
  );
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
function renderObjectsPanelBackgroundImage(panel: LayoutPanel, assignment: PagePanelAssignment | null, hidden: boolean): string {
  if (!assignment || hidden) {
    return "";
  }
  const crop = assignment.crop;
  const bounds = panelBounds(panel.shape);
  const rect = imageRectForCrop(bounds, crop, assignment);
  const transform = rotationTransformAttr(crop, boxCenter(bounds));
  const image = `<image href="${escapeAttr(assignment.assetImageUrl)}" x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" preserveAspectRatio="none" class="page-object-panel-bg-image"${transform} />`;
  return `<g clip-path="url(#${panelClipId(panel.id)})" pointer-events="none">${image}</g>`;
}

function renderObjectsPanelBackgroundOutline(panel: LayoutPanel, selected: boolean): string {
  return panelShapeElement(
    panel.shape,
    `class="page-object-panel-bg-outline${selected ? " is-selected" : ""}" data-panel-id="${escapeAttr(panel.id)}" fill="transparent"`
  );
}

/**
 * オブジェクトモードの `<svg>` 中身。scale(1000) group 内に正規化座標で描く(注意: group 外に置くと実質不可視)。
 * S2: コマ画像+コマ枠を非活性背景として、back帯image → 枠 → front帯(image含む text/balloon/box)の順で
 * 重ねる(受け入れ条件: ぶち抜き位置を見ながら編集できること)。
 */
export function renderObjectsStageContent(
  objects: PageObject[],
  selectedObjectIds: string[],
  pageHeight: number,
  layout: PageLayout | null,
  assignments: PagePanelAssignment[],
  missingMediaIds: string[],
  selectedPanelId: string | null,
  layerView: PageLayerViewState,
  chroniclePreviewObjects: PageObject[] = []
): string {
  const visibleObjects = visiblePageObjects(objects, layerView.hiddenObjectIds, layerView.hideNonImage);
  const selectedSet = new Set(selectedObjectIds);
  const selectedEditableObjects = visibleObjects.filter(
    (object): object is EditablePageObject => selectedSet.has(object.id) && isEditablePageObject(object)
  );
  const backObjects = visibleObjects.filter(isBackBandObject);
  const frontObjects = visibleObjects.filter((object) => !isBackBandObject(object));
  const assignmentByPanel = new Map(assignments.map((assignment) => [assignment.panelId, assignment]));
  const panels = layout ? [...layout.panels].sort((a, b) => a.order - b.order) : [];
  const hiddenPanels = new Set(layerView.hiddenPanelIds);
  const panelBackground = layout
    ? `<g class="page-object-panel-background">${panels.map((panel) => renderObjectsPanelBackgroundImage(panel, assignmentByPanel.get(panel.id) ?? null, hiddenPanels.has(panel.id))).join("")}</g>`
    : "";
  const panelFrame = layout
    ? `<g class="page-object-panel-frame">${panels.map((panel) => renderObjectsPanelBackgroundOutline(panel, panel.id === selectedPanelId)).join("")}</g>`
    : "";
  // 選択枠+ギズモ(C-3): 単一選択時のみ拡縮/回転ハンドル付きの通常ギズモ、複数選択時はハンドル無しの
  // 選択枠だけを各オブジェクトへ重ねる(結合外接枠ではなく個別選択枠を選んだ -- gizmoBoxForPageObject を
  // そのまま使い回せて実装が単純、かつ「どれが選択中か」が見た目でも明確になるため)。
  const selectionOverlay =
    selectedEditableObjects.length === 1
      ? renderPageObjectGizmo(selectedEditableObjects[0]!, pageHeight)
      : renderPageObjectMultiSelectionOutlines(selectedEditableObjects);
  return `
    <defs>${panels.map(renderPanelClipPath).join("")}</defs>
    <g id="pageObjectStageRoot" transform="scale(${VIEWBOX_SCALE})">
      <rect x="0" y="0" width="1" height="${num(pageHeight)}" class="page-panel-paper" data-page-object-background="1" />
      ${panelBackground}
      ${backObjects.map((object) => renderPageObjectShape(object, selectedSet.has(object.id), missingMediaIds)).join("")}
      ${panelFrame}
      ${frontObjects.map((object) => renderPageObjectShape(object, selectedSet.has(object.id), missingMediaIds)).join("")}
      ${selectionOverlay}
      ${layerView.hideNonImage ? "" : renderChroniclePreviewGhosts(chroniclePreviewObjects)}
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
  // Chronicle の一括配置は balloon/box/text(sfx)しか生成しないため tone がここに来ることは実運用上無いが、
  // size を持つ kind なので box/balloon/image と同じ扱いにしておく(型の網羅性・将来の呼び出し元変化への防御)。
  if (object.kind === "box" || object.kind === "balloon" || object.kind === "image" || object.kind === "tone") {
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
  if (object.kind === "tone") {
    return renderToneObjectShape(object, isSelected);
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
 * トーンオブジェクト1件(Docs/Feature-ScreenTones.md)。描画本体は `renderToneSvg`(クライアント/サーバ
 * 共用の純ロジック)にそのまま任せる -- balloon と同じく本体は pointer-events なしにし、透明な外接矩形を
 * 選択/ドラッグの当たり判定にする(`fill="transparent"`、`"none"` はヒットテスト対象外になるため使わない)。
 * clipPanelId があればコマ形状の clipPath(コマモードと共有の defs、`panelClipId`)で外側から重ねてクリップ
 * する(ImageObject と同じ二重クリップ構成 -- renderToneSvg 自身の領域クリップは常に別途掛かる)。
 */
function renderToneObjectShape(object: ToneObject, isSelected: boolean): string {
  const x = object.position.x - object.size.x / 2;
  const y = object.position.y - object.size.y / 2;
  const deg = (object.rotation * 180) / Math.PI;
  const transform = deg ? ` transform="rotate(${num(deg)} ${num(object.position.x)} ${num(object.position.y)})"` : "";
  const stateClass = isSelected ? " is-selected" : "";
  const hitArea = `<rect data-page-object="${escapeAttr(object.id)}" class="page-object-hit-area${stateClass}" x="${num(x)}" y="${num(y)}" width="${num(object.size.x)}" height="${num(object.size.y)}" fill="transparent" stroke="none"${transform} />`;
  const shape = renderToneSvg(object, object.position, object.rotation);
  const clipped = object.clipPanelId ? `<g clip-path="url(#${panelClipId(object.clipPanelId)})">${shape}</g>` : shape;
  return `<g class="page-object-tone">${hitArea}${clipped}</g>`;
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
 * トーン(focus/flash)の中心ハンドルの世界(ページ)座標。params.center はローカル座標(オブジェクト
 * 中心=原点、回転前)なので、balloon の tail tip ハンドルと全く同じ変換(回転を掛けてから position を
 * 足す)を使う。
 */
function toneCenterHandlePoint(object: ToneObject): { x: number; y: number } {
  const center = object.params.center ?? { x: 0, y: 0 };
  const rotated = rotatePointAround(center, { x: 0, y: 0 }, object.rotation);
  return { x: object.position.x + rotated.x, y: object.position.y + rotated.y };
}

/**
 * グラデ/線トーンの始点/終点ハンドルの世界(ページ)座標(2026-07-15。lines は同日追補2)。ローカル座標は
 * `effectiveGradientPoints`(gradStart/gradEnd 未指定時は angle から導出した領域両端。フォールバック
 * 方向は種別依存なので toneType を渡す)を使うので、ハンドル位置と実際の濃度遷移が常に一致する。
 * 世界座標への変換は toneCenterHandlePoint と同じ。
 */
function toneGradHandlePoints(object: ToneObject): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const local = effectiveGradientPoints(object.toneType, object.params, Math.max(1e-6, object.size.x / 2), Math.max(1e-6, object.size.y / 2));
  const toWorld = (point: PageVec) => {
    const rotated = rotatePointAround(point, { x: 0, y: 0 }, object.rotation);
    return { x: object.position.x + rotated.x, y: object.position.y + rotated.y };
  };
  return { start: toWorld(local.start), end: toWorld(local.end) };
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
  // トーン(focus/flash)の中心ハンドル(Docs/Feature-ScreenTones.md)。tail ハンドルと同じパターンで
  // "tone-center" ジェスチャを追加する(色は tail のオレンジと区別する)。
  const toneCenterHandle =
    object.kind === "tone" && (object.toneType === "focus" || object.toneType === "flash")
      ? (() => {
          const point = toneCenterHandlePoint(object);
          return `<circle id="pageObjectGizmoToneCenter" class="page-object-gizmo-handle page-object-gizmo-tone-center-handle" style="cursor:move;" data-page-object-handle="tone-center" data-page-object-owner="${escapeAttr(object.id)}" cx="${num(point.x)}" cy="${num(point.y)}" r="${num(GIZMO_HANDLE_RADIUS)}" />`;
        })()
      : "";
  // グラデ/線トーンの始点/終点ハンドル(2026-07-15。lines は同日追補2)。緑=始点(tone-center と同色)/
  // 青=終点。gradStart/gradEnd 未指定でも実効位置(angle 由来)に常に出し、最初のドラッグで controller
  // 側が materialize する。2点間には遷移方向を可視化する破線の軸線を敷く(pointer-events はハンドルのみ)。
  // lines は濃度グラデ有効時のみ(mask を掛ける toneSvg.ts と同じ hasOptionalGradient 判定 -- グラデ無し
  // なら操作対象の遷移が存在せず、「動かせるのに効かない」ハンドルになるため出さない)。
  const toneGradHandles =
    object.kind === "tone" && (object.toneType === "gradient" || (object.toneType === "lines" && hasOptionalGradient(object.params)))
      ? (() => {
          const { start, end } = toneGradHandlePoints(object);
          return `<line id="pageObjectGizmoGradAxis" class="page-object-gizmo-grad-axis" x1="${num(start.x)}" y1="${num(start.y)}" x2="${num(end.x)}" y2="${num(end.y)}" />
    <circle id="pageObjectGizmoGradStart" class="page-object-gizmo-handle page-object-gizmo-tone-center-handle" style="cursor:move;" data-page-object-handle="tone-grad-start" data-page-object-owner="${escapeAttr(object.id)}" cx="${num(start.x)}" cy="${num(start.y)}" r="${num(GIZMO_HANDLE_RADIUS)}" />
    <circle id="pageObjectGizmoGradEnd" class="page-object-gizmo-handle page-object-gizmo-tone-grad-end-handle" style="cursor:move;" data-page-object-handle="tone-grad-end" data-page-object-owner="${escapeAttr(object.id)}" cx="${num(end.x)}" cy="${num(end.y)}" r="${num(GIZMO_HANDLE_RADIUS)}" />`;
        })()
      : "";
  // sync が柄長/半径を画面基準へ直すために基準点と反転判定用のページ高(data-ph)を data 属性で持たせる。
  return `<g id="pageObjectGizmo" class="page-object-gizmo" data-tmx="${num(topMid.x)}" data-tmy="${num(topMid.y)}" data-upx="${num(up.x)}" data-upy="${num(up.y)}" data-ph="${num(pageHeight)}">
    <polygon id="pageObjectGizmoOutline" class="page-object-gizmo-outline" points="${outlinePoints}" />
    <line id="pageObjectGizmoStick" class="page-object-gizmo-stick" x1="${num(topMid.x)}" y1="${num(topMid.y)}" x2="${num(rotateHandle.x)}" y2="${num(rotateHandle.y)}" />
    ${cornerHandles}
    ${tailHandle}
    ${toneCenterHandle}
    ${toneGradHandles}
    <circle id="pageObjectGizmoRotate" class="page-object-gizmo-handle page-object-gizmo-rotate" style="cursor:grab;" data-page-object-handle="rotate" data-page-object-owner="${escapeAttr(object.id)}" cx="${num(rotateHandle.x)}" cy="${num(rotateHandle.y)}" r="${num(GIZMO_HANDLE_RADIUS)}" />
  </g>`;
}

/**
 * 複数選択時の選択枠(C-3): ハンドル無し。各オブジェクトの外接矩形(`gizmoBoxForPageObject`)を
 * 通常ギズモと同じ破線スタイル(`.page-object-gizmo-outline`)で個別に描くだけにする(結合外接枠は
 * 採らなかった -- 個別の枠のほうが「どれが選択中か」を見た目でも明確にできるため)。
 * pointer-events は持たせない(クリック/ドラッグは既存の hit-area 側に素通しする)。
 */
function renderPageObjectMultiSelectionOutlines(objects: EditablePageObject[]): string {
  if (objects.length < 2) {
    return "";
  }
  const outlines = objects
    .map((object) => {
      const box = gizmoBoxForPageObject(object);
      const points = gizmoBoxCorners(box)
        .map((corner) => `${num(corner.x)},${num(corner.y)}`)
        .join(" ");
      return `<polygon class="page-object-gizmo-outline page-object-multi-select-outline" points="${points}" />`;
    })
    .join("");
  return `<g class="page-object-multi-selection" pointer-events="none">${outlines}</g>`;
}
