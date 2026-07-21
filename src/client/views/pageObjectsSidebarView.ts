/**
 * ページ編集 lightbox「オブジェクト」モードのサイドバー(pagePanelLightboxView.ts から分割)。
 * レイヤ一覧・SETTINGS(選択オブジェクトのプロパティパネル群)・画像ピッカー・テキストスタイル欄など。
 * セリフドロワー本体は dialogueDrawerView.ts、クロップツールバーは pagePanelCropView.ts を参照する。
 */
import type { Asset, FontSummary, PagePanelAssignment } from "../../shared/apiTypes";
import type { LayoutPanel, PageLayout } from "../../shared/pageLayout";
import {
  DEFAULT_TONE_SNOW_BACK_COLOR,
  PAGE_OBJECT_MAX_SIZE,
  PAGE_OBJECT_MIN_SIZE,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  TONE_COUNT_MAX,
  TONE_KINDS,
  TONE_NOISE_GRAIN_MAX,
  TONE_NOISE_GRAIN_MIN,
  TONE_SNOW_BLUR_MAX,
  TONE_SNOW_SIZE_MAX,
  TONE_SNOW_SIZE_MIN,
  type BalloonObject,
  type BalloonShape,
  type BoxObject,
  type ImageObject,
  type PageObject,
  type TextContent,
  type TextObject,
  type TextStyle,
  type ToneKind,
  type ToneObject,
  type ToneParams
} from "../../shared/pageObjects";
import { hasOptionalGradient } from "../../shared/toneSvg";
import type { PagePanelLightboxState } from "../appState";
import { escapeAttr, escapeHtml } from "../format";
import { iconEye, iconEyeOff, iconGrip, iconPlus, iconScript, iconShuffle, iconSparkle, iconTrash } from "../icons";
import { pageLayerBand } from "../pageLayers";
import { num } from "./pageLayoutSvg";
import type { ChronicleBarViewState } from "./chronicleBarView";
import type { PageLayerViewState } from "./lightboxViewShared";
import { renderCropToolbar } from "./pagePanelCropView";
import { renderDialogueDrawer, type DialogueDrawerViewState } from "./dialogueDrawerView";

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

export function renderObjectsToolbar(
  objects: PageObject[],
  selectedObjectIds: string[],
  fonts: FontSummary[],
  layout: PageLayout | null,
  assignments: PagePanelAssignment[],
  lightbox: PagePanelLightboxState,
  imageObjects: ImageObjectViewState,
  dialogueDrawer: DialogueDrawerViewState,
  layerView: PageLayerViewState,
  chronicleBar: ChronicleBarViewState
): string {
  const selectedCount = selectedObjectIds.length;
  // 個別プロパティパネルは単一選択時のみ narrowing する(複数選択時は C-3 の専用パネルを出す)。
  const selected = selectedCount === 1 ? objects.find((object) => object.id === selectedObjectIds[0]) : undefined;
  const selectedBox = selected && selected.kind === "box" ? selected : null;
  const selectedText = selected && selected.kind === "text" ? selected : null;
  const selectedBalloon = selected && selected.kind === "balloon" ? selected : null;
  const selectedImage = selected && selected.kind === "image" ? selected : null;
  const selectedTone = selected && selected.kind === "tone" ? selected : null;
  const hasSelection = selectedCount > 0;
  // "replace" ピッカーは対象(選択中の image オブジェクト、単一選択時のみ)が無くなったら表示しない
  // (選択解除後もピッカーが浮いたままにならないようにする。state 自体はここではリセットしない)。
  const rawPickerMode = imageObjects.picker?.mode ?? null;
  const pickerMode = rawPickerMode === "replace" && !selectedImage ? null : rawPickerMode;
  const selectedPanel = layout?.panels.find((panel) => panel.id === lightbox.selectedPanelId) ?? null;
  const selectedPanelAssignment = selectedPanel
    ? assignments.find((assignment) => assignment.panelId === selectedPanel.id) ?? null
    : null;
  return `
    <section class="page-object-toolbar">
      <div class="page-sidebar-tabs" role="tablist" aria-label="サイドバー表示">
        <button class="page-sidebar-tab${dialogueDrawer.open ? "" : " is-active"}" type="button"${dialogueDrawer.open ? ` data-action="toggle-dialogue-drawer"` : ""} role="tab" aria-selected="${dialogueDrawer.open ? "false" : "true"}">レイヤ</button>
        <button class="page-sidebar-tab${dialogueDrawer.open ? " is-active" : ""}" type="button" data-action="toggle-dialogue-drawer" role="tab" aria-selected="${dialogueDrawer.open ? "true" : "false"}">${iconScript()}セリフ</button>
      </div>
      ${
        dialogueDrawer.open
          ? renderDialogueDrawer(dialogueDrawer, objects, chronicleBar)
          : `
            <div class="page-object-add-grid" aria-label="レイヤを追加">
              <button class="button-secondary compact" type="button" data-action="add-page-object-balloon">${iconPlus()}吹き出し</button>
              <button class="button-secondary compact" type="button" data-action="add-page-object-text">${iconPlus()}テキスト</button>
              <button class="button-secondary compact" type="button" data-action="add-page-object-box">${iconPlus()}ボックス</button>
              <button class="button-secondary compact${pickerMode === "add" ? " is-active" : ""}" type="button" data-action="toggle-page-object-image-picker" data-id="add">${iconPlus()}画像</button>
              <button class="button-secondary compact" type="button" data-action="add-page-object-tone">${iconPlus()}トーン</button>
            </div>
            ${pickerMode ? renderImageObjectPicker(imageObjects.pickerAssets) : ""}
            <div class="page-layer-visibility-actions">
              <button class="button-secondary compact${layerView.hideNonImage ? " is-active" : ""}" type="button" data-action="toggle-page-layer-hide-non-image" aria-pressed="${layerView.hideNonImage ? "true" : "false"}">
                ${layerView.hideNonImage ? iconEyeOff() : iconEye()}画像以外を${layerView.hideNonImage ? "表示" : "隠す"}
              </button>
              <button class="button-secondary compact" type="button" data-action="show-all-page-layers">すべて表示</button>
            </div>
            ${renderPageLayerList(objects, selectedObjectIds, layout, assignments, lightbox.selectedPanelId, layerView)}
            <section class="page-layer-settings" aria-label="選択レイヤの設定">
              <div class="page-layer-settings-header">
                <div>
                  <p class="section-kicker">Settings</p>
                  ${
                    selectedCount > 1
                      ? `<h3>${selectedCount}個選択中</h3>`
                      : selectedPanel
                        ? `<h3>コマ ${selectedPanel.order}</h3>`
                        : selectedBox
                          ? renderSettingsHeadingField("box", selectedBox.content?.text ?? "")
                          : selectedBalloon
                            ? renderSettingsHeadingField("balloon", selectedBalloon.content?.text ?? "")
                            : selectedText
                              ? renderSettingsHeadingField("text", selectedText.content.text)
                              : selected
                                ? `<h3>${escapeHtml(pageObjectLayerName(selected).title)}</h3>`
                                : `<h3>レイヤを選択</h3>`
                  }
                </div>
                ${
                  hasSelection
                    ? `<button class="page-layer-delete-button" type="button" data-action="delete-selected-page-object" title="削除(Delete キー)" aria-label="選択レイヤを削除">${iconTrash()}</button>`
                    : ""
                }
              </div>
              ${
                selectedCount > 1
                  ? renderMultiSelectionPanel(selectedCount)
                  : selectedPanel
                    ? renderPanelLayerPropertyPanel(selectedPanel, selectedPanelAssignment, lightbox.cropPanelId === selectedPanel.id)
                    : selectedBox
                      ? renderBoxPropertyPanel(selectedBox, fonts)
                      : selectedBalloon
                        ? renderBalloonPropertyPanel(selectedBalloon, fonts)
                        : selectedText
                          ? renderTextObjectPanel(selectedText, fonts)
                          : selectedImage
                            ? renderImageObjectPropertyPanel(selectedImage, layout, imageObjects.missingMediaIds.includes(selectedImage.mediaId))
                            : selectedTone
                              ? renderTonePropertyPanel(selectedTone, layout)
                              : `<p class="page-panel-hint-text">紙面またはレイヤ一覧から対象を選択してください。ドラッグで移動、コーナーで拡縮、上のハンドルで回転できます。</p>`
              }
            </section>
          `
      }
    </section>
  `;
}

/**
 * SETTINGS パネルの複数選択時表示(C-3): 個別プロパティ・見出し編集フィールドは出さず、
 * 「グループ化」「グループ解除」「削除」の3ボタンのみ(削除はヘッダーの trash アイコンボタンと機能重複
 * するが、複数選択時の操作を1箇所で見渡せるようここにも明示する)。
 */
function renderMultiSelectionPanel(count: number): string {
  return `
    <p class="page-panel-hint-text">${count}個選択中です。紙面でドラッグするとまとめて移動します。</p>
    <div class="page-object-add-grid" aria-label="複数選択の操作">
      <button class="button-secondary compact" type="button" data-action="group-selected-page-objects">グループ化</button>
      <button class="button-secondary compact" type="button" data-action="ungroup-selected-page-objects">グループ解除</button>
      <button class="button-secondary compact" type="button" data-action="delete-selected-page-object">${iconTrash()}削除</button>
    </div>
  `;
}

/**
 * SETTINGS 見出し(A-1: Docs/Feature-PageEditSidebarUx.md 課題A)。balloon/box/text 選択時は、静的な
 * `<h3>` の代わりに本文編集を兼ねる見出し風 textarea を返す -- 本文編集をここへ一本化し(A-2 で下部
 * textarea は撤去)、既存の input 委譲(`data-page-object-text="1"` → `updatePageObjectTextFromInput`、
 * main.ts に配線済み)をそのまま再利用する。domMorph がフォーカス中要素の value を保護するので、
 * タイピング中の再描画で編集(カーソル位置含む)が壊れない。
 */
function renderSettingsHeadingField(kind: "box" | "balloon" | "text", text: string): string {
  const placeholder = kind === "balloon" ? "セリフを入力" : "テキストを入力";
  return `<textarea class="page-layer-settings-heading" data-page-object-text="1" rows="1" placeholder="${escapeAttr(placeholder)}">${escapeHtml(text)}</textarea>`;
}

function pageObjectLayerName(object: PageObject): { title: string; type: string } {
  const text =
    object.kind === "text"
      ? object.content.text
      : object.kind === "balloon" || object.kind === "box"
        ? object.content?.text ?? ""
        : "";
  const compactText = text.replace(/\s+/g, " ").trim();
  if (object.kind === "image") {
    return { title: "画像", type: object.band === "back" ? "背景画像" : "前景画像" };
  }
  if (object.kind === "tone") {
    return { title: "トーン", type: TONE_TYPE_LABEL[object.toneType] };
  }
  if (object.kind === "balloon") {
    return { title: compactText || "吹き出し", type: "吹き出し" };
  }
  if (object.kind === "text") {
    return { title: compactText || "テキスト", type: "テキスト" };
  }
  return { title: compactText || "ボックス", type: "ボックス" };
}

/** グループ所属バッジ(C-4)。控えめな小アイコンをツールチップ付きで出す(専用のグループ行 UI は v1 スコープ外)。 */
function renderPageLayerGroupBadge(object: PageObject): string {
  if (!object.groupId) {
    return "";
  }
  // groupId(ランダム文字列)の先頭8桁をそのままツールチップに出す -- 同じ文字列 = 同じグループと
  // 視認できれば十分(専用のグループ一覧 UI は v1 スコープ外)。
  return `<span class="page-layer-group-badge" title="グループ: ${escapeAttr(object.groupId.slice(0, 8))}" aria-hidden="true">🔗</span>`;
}

function renderPageObjectLayerRow(
  object: PageObject,
  index: number,
  count: number,
  selectedObjectIds: string[],
  layerView: PageLayerViewState,
  multiSelectActive: boolean
): string {
  const band = pageLayerBand(object);
  const individuallyHidden = layerView.hiddenObjectIds.includes(object.id);
  const globallyHidden = layerView.hideNonImage && object.kind !== "image";
  const hidden = individuallyHidden || globallyHidden;
  const name = pageObjectLayerName(object);
  // z順(↑↓)は複数選択時は無効にする(C-3: どの基準で動かすか曖昧になるため)。
  const orderDisabled = multiSelectActive;
  return `
    <div class="page-layer-row${selectedObjectIds.includes(object.id) ? " is-selected" : ""}${hidden ? " is-hidden" : ""}"
      draggable="true" data-page-layer-object-id="${escapeAttr(object.id)}" data-page-layer-band="${band}">
      ${renderPageLayerGroupBadge(object)}
      <span class="page-layer-grip" title="ドラッグして並べ替え">${iconGrip()}</span>
      <button class="page-layer-visibility" type="button" data-action="toggle-page-layer-visibility" data-id="object:${escapeAttr(object.id)}"
        aria-label="${escapeAttr(name.type)}を${individuallyHidden ? "表示" : "非表示"}" title="${globallyHidden ? "画像以外を一括非表示中" : hidden ? "表示" : "非表示"}"${globallyHidden ? " disabled" : ""}>
        ${hidden ? iconEyeOff() : iconEye()}
      </button>
      <button class="page-layer-select" type="button" data-action="select-page-layer" data-id="object:${escapeAttr(object.id)}">
        <span class="page-layer-name">${escapeHtml(name.title)}</span>
        <span class="page-layer-type">${escapeHtml(name.type)}</span>
      </button>
      <div class="page-layer-order-actions" aria-label="重なり順">
        <button type="button" data-action="move-page-layer-up" data-id="${escapeAttr(object.id)}" title="1つ前面へ" aria-label="1つ前面へ"${index === 0 || orderDisabled ? " disabled" : ""}>↑</button>
        <button type="button" data-action="move-page-layer-down" data-id="${escapeAttr(object.id)}" title="1つ背面へ" aria-label="1つ背面へ"${index === count - 1 || orderDisabled ? " disabled" : ""}>↓</button>
      </div>
    </div>
  `;
}

function renderPanelLayerRow(
  panel: LayoutPanel,
  assignment: PagePanelAssignment | null,
  selectedPanelId: string | null,
  hidden: boolean
): string {
  return `
    <div class="page-layer-row page-layer-panel-row${selectedPanelId === panel.id ? " is-selected" : ""}${hidden ? " is-hidden" : ""}">
      <span class="page-layer-fixed-mark" title="コマ枠の順序はコマ枠タブで管理">固定</span>
      <button class="page-layer-visibility" type="button" data-action="toggle-page-layer-visibility" data-id="panel:${escapeAttr(panel.id)}"
        aria-label="コマ ${panel.order} の画像を${hidden ? "表示" : "非表示"}" title="${hidden ? "表示" : "非表示"}"${assignment ? "" : " disabled"}>
        ${hidden || !assignment ? iconEyeOff() : iconEye()}
      </button>
      <button class="page-layer-select" type="button" data-action="select-page-layer" data-id="panel:${escapeAttr(panel.id)}">
        ${assignment ? `<img class="page-layer-thumbnail" src="${escapeAttr(assignment.assetImageUrl)}" alt="" loading="lazy" draggable="false" />` : `<span class="page-layer-thumbnail is-empty"></span>`}
        <span class="page-layer-name">コマ ${panel.order}</span>
        <span class="page-layer-type">${assignment ? "コマ画像" : "未生成"}</span>
      </button>
    </div>
  `;
}

function renderPageLayerList(
  objects: PageObject[],
  selectedObjectIds: string[],
  layout: PageLayout | null,
  assignments: PagePanelAssignment[],
  selectedPanelId: string | null,
  layerView: PageLayerViewState
): string {
  const assignmentByPanel = new Map(assignments.map((assignment) => [assignment.panelId, assignment]));
  const front = objects.filter((object) => pageLayerBand(object) === "front").reverse();
  const back = objects.filter((object) => pageLayerBand(object) === "back").reverse();
  const panels = layout ? [...layout.panels].sort((a, b) => b.order - a.order) : [];
  const multiSelectActive = selectedObjectIds.length > 1;
  const group = (label: string, content: string, count: number) =>
    count > 0
      ? `<div class="page-layer-group"><div class="page-layer-group-label"><span>${escapeHtml(label)}</span><span>${count}</span></div>${content}</div>`
      : "";
  return `
    <div class="page-layer-list" aria-label="レイヤ一覧">
      ${group("前景", front.map((object, index) => renderPageObjectLayerRow(object, index, front.length, selectedObjectIds, layerView, multiSelectActive)).join(""), front.length)}
      ${group(
        "コマ画像",
        panels
          .map((panel) => renderPanelLayerRow(panel, assignmentByPanel.get(panel.id) ?? null, selectedPanelId, layerView.hiddenPanelIds.includes(panel.id)))
          .join(""),
        panels.length
      )}
      ${group("背景", back.map((object, index) => renderPageObjectLayerRow(object, index, back.length, selectedObjectIds, layerView, multiSelectActive)).join(""), back.length)}
      ${objects.length === 0 && panels.length === 0 ? `<p class="page-panel-hint-text">レイヤはまだありません。</p>` : ""}
    </div>
  `;
}

function renderPanelLayerPropertyPanel(
  panel: LayoutPanel,
  assignment: PagePanelAssignment | null,
  cropActive: boolean
): string {
  if (cropActive) {
    return `<div class="page-panel-crop-sidebar"><p class="page-panel-hint-text">ドラッグで移動、コーナーで拡大縮小、上のハンドルで回転できます。</p>${renderCropToolbar()}</div>`;
  }
  return `
    <div class="page-panel-layer-actions">
      <button class="button-primary compact" type="button" data-action="generate-selected-panel">${iconSparkle()}${assignment ? "コマを再生成" : "コマを生成"}</button>
      <button class="button-secondary compact" type="button" data-action="edit-selected-panel-crop"${assignment ? "" : " disabled"}>切り抜きを調整</button>
    </div>
    <p class="page-panel-hint-text">紙面上のコマをダブルクリックしても生成／切り抜き調整を開けます。</p>
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

const TONE_TYPE_LABEL: Record<ToneKind, string> = {
  halftone: "網点",
  gradient: "グラデ",
  lines: "線",
  speed: "スピード線",
  focus: "集中線",
  flash: "フラッシュ",
  noise: "ノイズ",
  snow: "雪"
};

/**
 * トーンオブジェクトのプロパティパネル(Docs/Feature-ScreenTones.md)。種別 select・色・不透明度・
 * 種別ごとのパラメータ欄・クリップ先コマ select(image と同じ)・「シャッフル」ボタン(speed/focus/flash
 * の seed 振り直し)。種別切替は `updateToneOwnField`(controller)側で params を既定値へリセットする。
 */
function renderTonePropertyPanel(object: ToneObject, layout: PageLayout | null): string {
  const typeOptions = TONE_KINDS.map(
    (kind) => `<option value="${kind}"${object.toneType === kind ? " selected" : ""}>${escapeHtml(TONE_TYPE_LABEL[kind])}</option>`
  ).join("");
  const panelOptions = (layout?.panels ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((panel) => `<option value="${escapeAttr(panel.id)}"${object.clipPanelId === panel.id ? " selected" : ""}>コマ ${panel.order}</option>`)
    .join("");
  // ノイズ/雪も seed 付き乱数(粒の配置)を使うため、シャッフル対象に含める(2026-07-14 追補)。
  const needsShuffle =
    object.toneType === "speed" ||
    object.toneType === "focus" ||
    object.toneType === "flash" ||
    object.toneType === "noise" ||
    object.toneType === "snow";
  return `
    <div class="page-object-property-row">
      <label class="page-object-property-field page-object-property-field-wide">種別
        <select data-page-object-field="toneType">${typeOptions}</select>
      </label>
      <label class="page-object-property-field">色
        <input type="color" data-page-object-field="color" value="${escapeAttr(object.color)}" />
      </label>
      <label class="page-object-property-field">不透明度
        <input type="range" min="0" max="1" step="0.01" data-page-object-field="opacity" value="${num(object.opacity ?? 1)}" />
      </label>
    </div>
    ${renderToneParamsFields(object)}
    <div class="page-object-property-row">
      <label class="page-object-property-field page-object-property-field-wide">クリップ先のコマ
        <select data-page-object-field="clipPanelId"${panelOptions ? "" : " disabled"}>
          <option value=""${object.clipPanelId ? "" : " selected"}>クリップしない</option>
          ${panelOptions}
        </select>
      </label>
      ${needsShuffle ? `<button class="button-secondary compact" type="button" data-action="shuffle-tone-seed">${iconShuffle()}シャッフル</button>` : ""}
    </div>
  `;
}

/**
 * 中心ドラッグハンドルを使う focus/flash の共通パラメータ欄(center 自体はハンドルのみ、数値入力は設けない)。
 * outerRadius(2026-07-14 追補)は focus のみの optional パラメータなので、チェックボックスで
 * 有無を切り替える(`maxWidthEnabled`/`tailEnabled` と同じトグルパターン)。
 */
function renderCenterBasedToneFields(object: ToneObject): string {
  const params = object.params;
  const hasOuterRadius = object.toneType === "focus" && typeof params.outerRadius === "number";
  return `
    <div class="page-object-property-row">
      <label class="page-object-property-field">中心の空白半径
        <input type="number" step="0.005" min="0" max="${PAGE_OBJECT_MAX_SIZE}" data-page-object-tone-param="innerRadius" value="${num(params.innerRadius ?? 0)}" />
      </label>
      <label class="page-object-property-field">本数
        <input type="number" step="1" min="1" max="${TONE_COUNT_MAX}" data-page-object-tone-param="count" value="${num(params.count ?? 0)}" />
      </label>
      <label class="page-object-property-field">${object.toneType === "flash" ? "棘の長さ" : "線幅"}
        <input type="number" step="${object.toneType === "flash" ? "0.005" : "0.001"}" min="0" max="1" data-page-object-tone-param="lineWidth" value="${num(params.lineWidth ?? 0)}" />
      </label>
      <label class="page-object-property-field">ゆらぎ
        <input type="number" step="0.05" min="0" max="1" data-page-object-tone-param="jitter" value="${num(params.jitter ?? 0)}" />
      </label>
    </div>
    ${
      object.toneType === "focus"
        ? `
          <div class="page-object-property-row">
            <label class="page-object-property-field page-object-checkbox-field">
              <input type="checkbox" data-page-object-field="outerRadiusEnabled" ${hasOuterRadius ? "checked" : ""} /> 最大半径を指定
            </label>
            ${
              hasOuterRadius
                ? `
                  <label class="page-object-property-field">最大半径
                    <input type="number" step="0.005" min="0" max="${PAGE_OBJECT_MAX_SIZE}" data-page-object-tone-param="outerRadius" value="${num(params.outerRadius ?? 0)}" />
                  </label>
                `
                : ""
            }
          </div>
        `
        : ""
    }
    <p class="page-panel-hint-text">緑のハンドルをドラッグで中心を動かせます</p>
  `;
}

/**
 * lines/noise の任意グラデ(startRatio/endRatio)欄。両方 undefined なら「無効」チェックボックスのみ表示し、
 * ON にすると数値入力が現れる(`maxWidthEnabled`/`tailEnabled` と同じトグルパターン)。noise は角度も
 * グラデ有効時のみ意味を持つ optional パラメータなので、withAngle=true の時だけ角度欄も併記する
 * (lines は縞の angle が常に別欄で必須表示済みのため withAngle=false)。
 */
function renderOptionalGradientFields(params: ToneParams, withAngle: boolean = false): string {
  const hasGradient = typeof params.startRatio === "number" || typeof params.endRatio === "number";
  return `
    <div class="page-object-property-row">
      <label class="page-object-property-field page-object-checkbox-field">
        <input type="checkbox" data-page-object-field="gradientEnabled" ${hasGradient ? "checked" : ""} /> 濃度グラデを使う
      </label>
      ${
        hasGradient
          ? `
            ${
              withAngle
                ? `
                  <label class="page-object-property-field">角度
                    <input type="number" step="1" data-page-object-tone-param="angle" value="${num(params.angle ?? 0)}" />
                  </label>
                `
                : ""
            }
            <label class="page-object-property-field">開始濃度
              <input type="number" step="0.05" min="0" max="1" data-page-object-tone-param="startRatio" value="${num(params.startRatio ?? 0)}" />
            </label>
            <label class="page-object-property-field">終了濃度
              <input type="number" step="0.05" min="0" max="1" data-page-object-tone-param="endRatio" value="${num(params.endRatio ?? 0)}" />
            </label>
          `
          : ""
      }
    </div>
  `;
}

function renderToneParamsFields(object: ToneObject): string {
  const params = object.params;
  switch (object.toneType) {
    case "halftone":
    case "gradient":
      return `
        <div class="page-object-property-row">
          <label class="page-object-property-field">間隔
            <input type="number" step="0.001" min="0.004" max="0.1" data-page-object-tone-param="pitch" value="${num(params.pitch ?? 0)}" />
          </label>
          <label class="page-object-property-field">濃度
            <input type="number" step="0.05" min="0" max="1" data-page-object-tone-param="dotRatio" value="${num(params.dotRatio ?? 0)}" />
          </label>
          <label class="page-object-property-field">角度
            <input type="number" step="1" data-page-object-tone-param="angle" value="${num(params.angle ?? 0)}" />
          </label>
        </div>
        ${
          object.toneType === "gradient"
            ? `
              <div class="page-object-property-row">
                <label class="page-object-property-field">開始濃度
                  <input type="number" step="0.05" min="0" max="1" data-page-object-tone-param="startRatio" value="${num(params.startRatio ?? 0)}" />
                </label>
                <label class="page-object-property-field">終了濃度
                  <input type="number" step="0.05" min="0" max="1" data-page-object-tone-param="endRatio" value="${num(params.endRatio ?? 0)}" />
                </label>
              </div>
              <p class="page-panel-hint-text">緑=始点 / 青=終点のハンドルをドラッグでグラデの向きと範囲を指定できます(角度を入力するとハンドル指定はリセット)</p>
            `
            : ""
        }
      `;
    case "lines":
      return `
        <div class="page-object-property-row">
          <label class="page-object-property-field">間隔
            <input type="number" step="0.001" min="0.004" max="0.1" data-page-object-tone-param="pitch" value="${num(params.pitch ?? 0)}" />
          </label>
          <label class="page-object-property-field">線幅比
            <input type="number" step="0.05" min="0" max="1" data-page-object-tone-param="lineRatio" value="${num(params.lineRatio ?? 0)}" />
          </label>
          <label class="page-object-property-field">角度
            <input type="number" step="1" data-page-object-tone-param="angle" value="${num(params.angle ?? 0)}" />
          </label>
        </div>
        ${renderOptionalGradientFields(params)}
        ${
          hasOptionalGradient(params)
            ? `<p class="page-panel-hint-text">緑=始点 / 青=終点のハンドルをドラッグでグラデの向きと範囲を指定できます(縞は軸と直交に追従、角度を入力するとハンドル指定はリセット)</p>`
            : ""
        }
      `;
    case "noise":
      return `
        <div class="page-object-property-row">
          <label class="page-object-property-field">密度
            <input type="number" step="0.05" min="0" max="1" data-page-object-tone-param="density" value="${num(params.density ?? 0)}" />
          </label>
          <label class="page-object-property-field">粒サイズ
            <input type="number" step="0.001" min="${TONE_NOISE_GRAIN_MIN}" max="${TONE_NOISE_GRAIN_MAX}" data-page-object-tone-param="grain" value="${num(params.grain ?? 0)}" />
          </label>
        </div>
        ${renderOptionalGradientFields(params, /* withAngle */ true)}
      `;
    case "snow":
      return `
        <div class="page-object-property-row">
          <label class="page-object-property-field">本数(合計)
            <input type="number" step="1" min="1" max="${TONE_COUNT_MAX}" data-page-object-tone-param="count" value="${num(params.count ?? 0)}" />
          </label>
          <label class="page-object-property-field">前面比率
            <input type="number" step="0.05" min="0" max="1" data-page-object-tone-param="frontRatio" value="${num(params.frontRatio ?? 0)}" />
          </label>
          <label class="page-object-property-field">角度
            <input type="number" step="1" data-page-object-tone-param="angle" value="${num(params.angle ?? 0)}" />
          </label>
        </div>
        <div class="page-object-property-row">
          <label class="page-object-property-field">前面サイズ
            <input type="number" step="0.001" min="${TONE_SNOW_SIZE_MIN}" max="${TONE_SNOW_SIZE_MAX}" data-page-object-tone-param="frontSize" value="${num(params.frontSize ?? 0)}" />
          </label>
          <label class="page-object-property-field">背面サイズ
            <input type="number" step="0.001" min="${TONE_SNOW_SIZE_MIN}" max="${TONE_SNOW_SIZE_MAX}" data-page-object-tone-param="backSize" value="${num(params.backSize ?? 0)}" />
          </label>
        </div>
        <div class="page-object-property-row">
          <label class="page-object-property-field">前面ぼかし
            <input type="number" step="0.05" min="0" max="${TONE_SNOW_BLUR_MAX}" data-page-object-tone-param="frontBlur" value="${num(params.frontBlur ?? 0)}" />
          </label>
          <label class="page-object-property-field">背面ぼかし
            <input type="number" step="0.05" min="0" max="${TONE_SNOW_BLUR_MAX}" data-page-object-tone-param="backBlur" value="${num(params.backBlur ?? 0)}" />
          </label>
          <label class="page-object-property-field">背面色
            <input type="color" data-page-object-field="backColor" value="${escapeAttr(params.backColor ?? DEFAULT_TONE_SNOW_BACK_COLOR)}" />
          </label>
        </div>
      `;
    case "speed":
      return `
        <div class="page-object-property-row">
          <label class="page-object-property-field">角度
            <input type="number" step="1" data-page-object-tone-param="angle" value="${num(params.angle ?? 0)}" />
          </label>
          <label class="page-object-property-field">本数
            <input type="number" step="1" min="1" max="${TONE_COUNT_MAX}" data-page-object-tone-param="count" value="${num(params.count ?? 0)}" />
          </label>
          <label class="page-object-property-field">平均長
            <input type="number" step="0.05" min="0" max="1" data-page-object-tone-param="length" value="${num(params.length ?? 0)}" />
          </label>
        </div>
        <div class="page-object-property-row">
          <label class="page-object-property-field">線幅
            <input type="number" step="0.001" min="0" max="1" data-page-object-tone-param="lineWidth" value="${num(params.lineWidth ?? 0)}" />
          </label>
          <label class="page-object-property-field">ゆらぎ
            <input type="number" step="0.05" min="0" max="1" data-page-object-tone-param="jitter" value="${num(params.jitter ?? 0)}" />
          </label>
        </div>
      `;
    case "focus":
    case "flash":
      return renderCenterBasedToneFields(object);
    default:
      return "";
  }
}

/**
 * box/balloon 共通のスタイル欄。A-2(Docs/Feature-PageEditSidebarUx.md 課題A)で「テキストを載せる」
 * (hasContent)トグルと本文 textarea を撤去した -- 本文編集は SETTINGS 見出しフィールド
 * (`renderSettingsHeadingField`)に一本化済み。表示条件は変更前と同じ「content がある時」のまま
 * (balloon は生成時から content を持つ。box は見出しフィールドへの入力で content が新規作成された時)。
 */
function renderContentSection(content: TextContent | null | undefined, fonts: FontSummary[]): string {
  return content ? renderTextStyleFields(content.style, fonts, "data-page-object-content-field") : "";
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
  thought: "思考",
  compound: "連結(長台詞)",
  spike: "通信(ギザギザ)",
  roundRect: "機械音声(角丸)",
  caption: "キャプション"
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

/**
 * text オブジェクト本体のプロパティパネル(スタイル欄 + 折り返し幅)。A-2 で先頭の本文 textarea は
 * 撤去し、SETTINGS 見出しフィールド(`renderSettingsHeadingField`)へ一本化した。
 */
function renderTextObjectPanel(object: TextObject, fonts: FontSummary[]): string {
  const hasMaxWidth = object.maxWidth !== undefined;
  return `
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
