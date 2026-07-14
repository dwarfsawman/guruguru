/**
 * Book（複数ページ）のページ一覧グリッド。各ページタイルをクリックすると既存の1枚生成 UI へ移り、
 * ドラッグで並び替えできる。色・ボタン・トークンは既存 UI（Home の .panel / round-grid のタイル）に合わせる。
 * state は引数で受け取るため main.ts への逆依存を持たない。DnD は bookController が担当する。
 */
import type { BookPages, Character, PageSummary } from "../../shared/apiTypes";
import type { CharacterReferenceImageView, CharacterReferenceSetView, ReferenceModelFamily } from "../../shared/referenceSets";
import { escapeAttr, escapeHtml } from "../format";
import {
  iconCheck,
  iconClose,
  iconDownload,
  iconImage,
  iconLayers,
  iconMangaPanelImport,
  iconOpenBook,
  iconPlus,
  iconScript,
  iconSettings,
  iconSparkle,
  iconTrash
} from "../icons";
import { renderPageLayoutSvg } from "./pageLayoutSvg";

export function renderBookView(
  book: BookPages,
  selectionMode = false,
  selectedPageIds: readonly string[] = [],
  referenceCorner: {
    characters: Character[];
    referenceSets: CharacterReferenceSetView[];
    open: boolean;
    selectedCharacterId: string | null;
    busyId: string | null;
  } = { characters: [], referenceSets: [], open: false, selectedCharacterId: null, busyId: null }
): string {
  const { project, pages } = book;
  const selectedSet = new Set(selectedPageIds);
  const selectedCount = pages.filter((page) => selectedSet.has(page.id)).length;
  return `
    <main class="book-layout">
      <section class="panel">
        <div class="panel-heading">
          <div class="book-heading-copy">
            <p class="section-kicker">Book · ページ一覧</p>
            <h1>${escapeHtml(project.name)}</h1>
            <p class="book-subtitle">画像をクリックすると拡大表示します(コマ割りのページはコマ選択画面)。拡大画面の「画像生成」またはカード右上の✨から1枚生成画面へ移動できます。ドラッグで並び替えできます。</p>
          </div>
          <div class="book-heading-actions-shell">
            <div class="book-heading-actions">
              <span class="panel-count"><b>${pages.length}</b> pages</span>
              <button class="button-secondary compact book-action-button" type="button" data-action="open-script-screen" aria-label="脚本" title="Fountain脚本の取り込み・キャラクター管理・セリフ配置">${iconScript()}${renderBookActionLabel("脚本", "")}</button>
              <button class="button-secondary compact book-action-button" type="button" data-action="open-book-settings" aria-label="Book共通設定" title="新規ページの既定設定(LoRA/プロンプト/生成パラメータ)を設定">${iconSettings()}${renderBookActionLabel("Book共通", "設定")}</button>
              <button class="button-secondary compact book-action-button" type="button" data-action="export-book" aria-label="Book全体をエクスポート" title="Book全体をエクスポート(PNG/JPEG/ORA/PPTX)" ${pages.length === 0 ? "disabled" : ""}>${iconDownload()}${renderBookActionLabel("Book全体を", "エクスポート")}</button>
              <button class="button-secondary compact book-action-button" type="button" data-action="open-layout-picker" aria-label="テンプレから追加" title="コマ割りテンプレートを選んでページ追加">${iconMangaPanelImport()}${renderBookActionLabel("テンプレから", "追加")}</button>
              <label class="button-secondary compact source-upload-button book-action-button" aria-label="画像をインポート" title="画像を新規ページとして取り込む(複数選択可)">
                ${iconImage()}${renderBookActionLabel("画像を", "インポート")}
                <input data-image-import="1" type="file" accept="image/png,image/jpeg,image/webp" multiple />
              </label>
              <button class="button-secondary compact book-action-button" type="button" data-action="add-page" aria-label="ページを追加" title="空のページを追加">${iconPlus()}${renderBookActionLabel("ページを", "追加")}</button>
              <button class="button-primary book-action-button book-reader-button" type="button" data-action="open-book-reader" aria-label="読む" title="漫画ビューアで読む" ${pages.length === 0 ? "disabled" : ""}>${iconOpenBook()}<span class="book-action-text book-action-text-single">読む</span></button>
            </div>
          </div>
        </div>
        ${renderReferenceCorner(referenceCorner)}
        ${renderSelectionToolbar(selectionMode, selectedCount, pages.length)}
        <div class="image-grid page-grid">
          ${pages.map((page, index) => renderPageCard(page, index, selectionMode, selectedSet.has(page.id))).join("")}
          ${selectionMode ? "" : renderAddPageCard()}
        </div>
      </section>
      ${renderReferenceCornerModal(referenceCorner)}
    </main>
  `;
}

function renderReferenceCorner(input: {
  characters: Character[];
  referenceSets: CharacterReferenceSetView[];
  open: boolean;
  selectedCharacterId: string | null;
  busyId: string | null;
}): string {
  const readyCharacters = input.characters.filter((character) => referenceCharacterReady(character.id, input.referenceSets)).length;
  const needsSetup = input.characters.length - readyCharacters;
  const summary = input.characters.length === 0
    ? "キャラクター未登録"
    : `${input.characters.length} characters · 準備済み ${readyCharacters}${needsSetup > 0 ? ` · 要設定 ${needsSetup}` : ""}`;
  return `
    <section class="reference-corner" aria-label="レファレンスコーナー">
      <div class="reference-corner-heading">
        <span class="reference-corner-copy"><b>レファレンスコーナー</b><small>${escapeHtml(summary)}</small></span>
        <div class="reference-corner-actions">
          <button class="button-secondary compact" type="button" data-action="refresh-reference-corner">更新</button>
          <button class="button-primary compact" type="button" data-action="open-reference-corner">開く</button>
        </div>
      </div>
    </section>
  `;
}

function referenceCharacterReady(characterId: string, sets: readonly CharacterReferenceSetView[]): boolean {
  const approvedFamilies = new Set(
    sets.filter((set) => set.characterId === characterId && set.status === "approved").map((set) => set.modelFamily)
  );
  return approvedFamilies.has("chroma") && approvedFamilies.has("anima");
}

function renderReferenceCornerModal(input: {
  characters: Character[];
  referenceSets: CharacterReferenceSetView[];
  open: boolean;
  selectedCharacterId: string | null;
  busyId: string | null;
}): string {
  if (!input.open) return "";
  const latest = new Map<string, CharacterReferenceSetView>();
  const adoptedVersions = new Map<string, number>();
  for (const set of input.referenceSets) {
    const key = `${set.characterId}:${set.variantId}:${set.modelFamily}`;
    if (!latest.has(key)) latest.set(key, set);
    if (set.approvedAt && !adoptedVersions.has(key)) adoptedVersions.set(key, set.version);
  }
  const activeCharacter = input.characters.find((character) => character.id === input.selectedCharacterId) ?? input.characters[0] ?? null;
  const tabs = input.characters.map((character) => {
    const active = character.id === activeCharacter?.id;
    const ready = referenceCharacterReady(character.id, input.referenceSets);
    return `<button class="reference-character-tab${active ? " is-active" : ""}" type="button" role="tab"
      data-action="select-reference-character" data-id="${escapeAttr(character.id)}" aria-selected="${active}">
      <span>${escapeHtml(character.name)}</span><small>${ready ? "Ready" : "要設定"}</small>
    </button>`;
  }).join("");
  const content = activeCharacter
    ? (() => {
        const variants = new Set(input.referenceSets.filter((set) => set.characterId === activeCharacter.id).map((set) => set.variantId));
        if (variants.size === 0) variants.add(`${activeCharacter.id}:default`);
        return [...variants].map((variantId) =>
          renderReferenceCharacter(activeCharacter, variantId, latest, adoptedVersions, input.busyId)
        ).join("");
      })()
    : `<p class="reference-empty">脚本画面でキャラクターを追加すると、ここでReference Setを作成できます。</p>`;
  return `
    <div class="workflow-modal reference-corner-modal" role="presentation">
      <section class="workflow-dialog reference-corner-dialog" role="dialog" aria-modal="true" aria-label="レファレンスコーナー詳細">
        <header class="workflow-dialog-header">
          <div><p class="section-kicker">Book · Reference Sets</p><h2>レファレンスコーナー</h2></div>
          <button class="icon-button" type="button" data-action="close-reference-corner" aria-label="閉じる" title="閉じる">${iconClose()}</button>
        </header>
        <div class="reference-character-tabs" role="tablist" aria-label="キャラクターを選択">${tabs}</div>
        <div class="reference-corner-modal-body" role="tabpanel">${content}</div>
      </section>
    </div>
  `;
}

function renderReferenceCharacter(
  character: Character,
  variantId: string,
  latest: Map<string, CharacterReferenceSetView>,
  adoptedVersions: Map<string, number>,
  busyId: string | null
): string {
  const chromaKey = `${character.id}:${variantId}:chroma`;
  const animaKey = `${character.id}:${variantId}:anima`;
  const chroma = latest.get(chromaKey) ?? null;
  const anima = latest.get(animaKey) ?? null;
  const chromaAdopted = adoptedVersions.get(chromaKey) ?? null;
  const animaAdopted = adoptedVersions.get(animaKey) ?? null;
  return `
    <article class="reference-character-card">
      <header><div><h2>${escapeHtml(character.name)}</h2><span>variant: ${escapeHtml(variantId)}</span></div>
        <div class="reference-readiness">${statusBadge(chroma, "chroma", chromaAdopted)}${statusBadge(anima, "anima", animaAdopted)}</div></header>
      <div class="reference-family-grid">
        ${renderReferenceFamily(character, variantId, "chroma", chroma, chromaAdopted, busyId)}
        ${renderReferenceFamily(character, variantId, "anima", anima, animaAdopted, busyId)}
      </div>
    </article>
  `;
}

function statusBadge(set: CharacterReferenceSetView | null, family: ReferenceModelFamily, adoptedVersion: number | null): string {
  const needsRegeneration = Boolean(set && adoptedVersion && set.version > adoptedVersion && set.status === "draft");
  const label = !set ? "未設定"
    : set.status === "approved" ? `${family === "chroma" ? "Chroma" : "Anima"} Ready`
      : set.status === "generating" ? "生成中"
        : set.status === "review" ? "確認待ち"
          : set.status === "stale" || needsRegeneration ? "要再生成"
            : "未設定";
  return `<span class="reference-status is-${set?.status ?? "unset"}">${escapeHtml(label)}</span>`;
}

function renderReferenceFamily(
  character: Character,
  variantId: string,
  family: ReferenceModelFamily,
  set: CharacterReferenceSetView | null,
  adoptedVersion: number | null,
  busyId: string | null
): string {
  const busy = Boolean(busyId && (busyId === set?.id || busyId === character.id));
  const face = set?.images.find((image) => image.role === "face") ?? null;
  const fullBody = set?.images.find((image) => image.role === "full_body") ?? null;
  return `
    <section class="reference-family-card" data-reference-family-card data-character-id="${escapeAttr(character.id)}" data-model-family="${family}">
      <div class="reference-family-title"><b>${family === "chroma" ? "Chroma · PuLID(face)" : "Anima · face + full body"}</b>${set ? `<span>v${set.version}${adoptedVersion ? ` · 採用 v${adoptedVersion}` : ""}</span>` : ""}</div>
      <label>variant ID<input name="variantId" value="${escapeAttr(variantId)}" /></label>
      <label>外見設定（日本語）<textarea name="appearanceJa" rows="2" placeholder="髪、顔、年齢、衣装、装飾">${escapeHtml(set?.appearanceJa ?? "")}</textarea></label>
      <label>Appearance prompt (English)<textarea name="appearancePromptEn" rows="2" placeholder="silver bob hair, blue eyes…">${escapeHtml(set?.appearancePromptEn ?? "")}</textarea></label>
      <label>Must not change（1行1条件）<textarea name="mustNotChange" rows="2" placeholder="hair color&#10;left-eye scar">${escapeHtml(set?.mustNotChange.join("\n") ?? "")}</textarea></label>
      ${set && (set.status === "stale" || Boolean(adoptedVersion && set.version > adoptedVersion)) ? `<p class="reference-stale-note">採用後に設定が変わりました。新しいversionの生成・承認が必要です。</p>` : ""}
      <div class="reference-slot-grid">
        ${renderReferenceSlot(set, "顔", face, "face", busy)}
        ${renderReferenceSlot(set, "全身", fullBody, "full_body", busy, family === "chroma")}
      </div>
      <div class="reference-family-actions">
        <button class="button-secondary compact" type="button" data-action="create-reference-set" data-character-id="${escapeAttr(character.id)}" data-model-family="${family}" ${busy ? "disabled" : ""}>${set ? "設定変更を新versionへ" : "設定を保存"}</button>
        ${set ? `<button class="button-secondary compact" type="button" data-action="${set.status === "draft" ? "generate-reference-set" : "regenerate-reference-set"}" data-id="${escapeAttr(set.id)}" data-character-id="${escapeAttr(character.id)}" ${busy ? "disabled" : ""}>${set.status === "draft" ? "自動生成" : "再生成"}</button>
          <button class="button-primary compact" type="button" data-action="approve-reference-set" data-id="${escapeAttr(set.id)}" ${busy || set.status === "generating" || set.status === "approved" ? "disabled" : ""}>承認</button>` : ""}
      </div>
      ${busy ? `<p class="reference-busy">処理中…</p>` : ""}
    </section>
  `;
}

function renderReferenceSlot(
  set: CharacterReferenceSetView | null,
  label: string,
  image: CharacterReferenceImageView | null,
  role: "face" | "full_body",
  busy: boolean,
  optional = false
): string {
  const candidates = image?.candidates ?? [];
  return `
    <div class="reference-slot${optional ? " is-optional" : ""}">
      <div class="reference-slot-label"><b>${label}</b>${optional ? "<span>Chromaでは任意</span>" : ""}</div>
      <div class="reference-slot-preview">${image?.imageUrl
        ? `<img src="${escapeAttr(image.imageUrl)}" alt="${escapeAttr(label)}参照" loading="lazy" />`
        : `<span>未設定</span>`}</div>
      ${set ? `<label class="button-secondary compact reference-upload">アップロード<input type="file" accept="image/png,image/jpeg,image/webp" data-reference-upload="${role}" data-reference-set-id="${escapeAttr(set.id)}" ${busy ? "disabled" : ""} /></label>` : ""}
      ${candidates.length > 0 ? `<details class="reference-candidates" open><summary>候補比較 (${candidates.length})</summary><div>${candidates.map((candidate, index) => `
        <label><input type="radio" data-candidate-role="${role}" name="candidate-${escapeAttr(set!.id)}-${role}" value="${escapeAttr(candidate.assetId)}" ${index === 0 ? "checked" : ""} />
          <img src="${escapeAttr(candidate.thumbnailUrl)}" alt="候補${index + 1}" loading="lazy" /><span>${candidate.width ?? "?"}×${candidate.height ?? "?"}</span></label>`).join("")}</div></details>` : ""}
    </div>
  `;
}

function renderBookActionLabel(line1: string, line2: string): string {
  return `<span class="book-action-text"><span>${escapeHtml(line1)}</span><span>${escapeHtml(line2)}</span></span>`;
}

function renderSelectionToolbar(selectionMode: boolean, selectedCount: number, pageCount: number): string {
  if (!selectionMode) {
    return `
      <div class="book-selection-bar">
        <button class="button-secondary compact" type="button" data-action="toggle-page-selection-mode" ${pageCount === 0 ? "disabled" : ""}>
          ${iconCheck()}ページを選択
        </button>
      </div>
    `;
  }
  return `
    <div class="book-selection-bar is-active">
      <div class="book-selection-status">
        <b>${selectedCount}</b><span>/ ${pageCount} pages selected</span>
      </div>
      <div class="book-selection-actions">
        <button class="button-secondary compact" type="button" data-action="select-all-book-pages" ${pageCount === 0 ? "disabled" : ""}>すべて選択</button>
        <button class="button-secondary compact" type="button" data-action="export-selected-pages" ${selectedCount === 0 ? "disabled" : ""}>${iconDownload()}選択ページをエクスポート</button>
        <button class="button-danger compact" type="button" data-action="delete-selected-pages" ${selectedCount === 0 ? "disabled" : ""}>${iconTrash()}選択ページを削除</button>
        <button class="button-secondary compact" type="button" data-action="clear-book-page-selection">${iconClose()}終了</button>
      </div>
    </div>
  `;
}

function renderPageCard(page: PageSummary, index: number, selectionMode: boolean, selected: boolean): string {
  const number = index + 1;
  const title = page.title.trim();
  const label = title || `ページ${number}`;
  // コマ割りページはクリックでコマ選択 lightbox(pagePanelLightboxController)を開く
  // (data-action="open-page-panels"。代表画像の有無に関係なく、コマが無割り当てでも選べる)。
  // それ以外のページは従来どおり代表画像の汎用 zoom lightbox(無ければズーム不可)。
  const zoomSrc = page.representativeImageUrl || page.representativeThumbnailUrl;
  const panelAttrs = selectionMode
    ? ""
    : page.layout
      ? ` data-action="open-page-panels" data-id="${escapeAttr(page.id)}" title="クリックでコマを選択"`
      : zoomSrc
        ? ` data-image-zoom-src="${escapeAttr(zoomSrc)}" data-image-zoom-label="${escapeAttr(label)}"` +
          ` data-image-zoom-action="open-page" data-image-zoom-action-id="${page.id}" data-image-zoom-action-label="画像生成"` +
          ` title="クリックで拡大"`
        : "";
  const isZoomable = Boolean(page.layout || zoomSrc);
  const selectionAttrs = selectionMode
    ? ` data-action="toggle-book-page-selection" data-id="${escapeAttr(page.id)}" aria-selected="${selected ? "true" : "false"}"`
    : "";
  return `
    <article class="page-card${selectionMode ? " is-selectable" : ""}${selected ? " is-selected" : ""}" data-key="page-${page.id}" data-page-id="${page.id}"${selectionAttrs}>
      ${selectionMode ? `<span class="page-selection-check" aria-hidden="true">${selected ? iconCheck() : ""}</span>` : ""}
      <div class="page-card-body">
        <span class="page-card-thumb${!selectionMode && isZoomable ? " is-zoomable" : ""}"${panelAttrs}>
          ${renderPageThumb(page, label)}
        </span>
        <span class="page-card-index">${number}</span>
      </div>
      <div class="page-card-actions${selectionMode ? " is-hidden" : ""}">
        <button class="page-card-icon" type="button" data-action="open-page-panels" data-id="${page.id}" aria-label="${escapeAttr(label)}のオブジェクト編集を開く" title="オブジェクト編集(テキスト・吹き出し・ボックス)">${iconLayers()}</button>
        <button class="page-card-icon" type="button" data-action="export-page" data-id="${page.id}" aria-label="${escapeAttr(label)}をエクスポート" title="エクスポート(PNG/JPEG/ORA/PPTX)">${iconDownload()}</button>
        <button class="page-card-icon generate" type="button" data-action="open-page" data-id="${page.id}" aria-label="${escapeAttr(label)}の生成画面を開く" title="画像生成画面へ">${iconSparkle()}</button>
        <button class="page-card-icon danger" type="button" data-action="delete-page" data-id="${page.id}" aria-label="ページを削除" title="ページを削除">${iconTrash()}</button>
      </div>
    </article>
  `;
}

/**
 * ページのサムネ。代表画像があれば画像、無ければコマ割りレイアウトの枠サムネ、
 * どちらも無ければ空。レイアウト枠サムネにより一覧がコマ割り表示になる。
 */
function renderPageThumb(page: PageSummary, label: string): string {
  if (page.representativeThumbnailUrl) {
    return `<img class="page-thumb-img" data-lazy-src="${escapeAttr(page.representativeThumbnailUrl)}" alt="${escapeAttr(label)}" loading="lazy" decoding="async" fetchpriority="low" draggable="false" />`;
  }
  if (page.layout) {
    return `<span class="page-thumb-layout">${renderPageLayoutSvg(page.layout, { ariaLabel: "コマ割りプレビュー" })}</span>`;
  }
  return "";
}

function renderAddPageCard(): string {
  return `
    <button class="page-add-card" type="button" data-action="add-page" aria-label="ページを追加">
      <span class="page-add-icon">${iconPlus()}</span>
    </button>
  `;
}
