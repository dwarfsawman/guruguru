/**
 * Project detail のギャラリー（画像グリッド・下部アクションバー）の render helper。
 * `src/client/main.ts` から抽出。state は引数で受け取るため main.ts への逆依存を持たない（circular import なし）。
 * UI 文言・HTML 構造・CSS class・data-action・selector は移動前と同一。
 *
 * `generationPanelHtml` は main.ts が `renderGenerationPanel()`（`generationPanel.ts`）で
 * 事前に render した HTML 文字列を渡す形にしている。`generationPanel.ts` 側が
 * `renderSourceUploadButton`（本 module）に依存するため、本 module から `generationPanel.ts` を
 * 直接 import すると循環 import になる。そのため意図的にこの間接呼び出しを維持している。
 * `generationModeLabel` も同じ理由で `generationPanel.ts` の export と同一内容をローカルに複製している。
 */
import type { Asset, ProjectDetail, Round } from "../../shared/apiTypes";
import type { InpaintDraft } from "../maskTypes";
import type { PoseDraft } from "../poseTypes";
import { hasMaskData } from "../maskDraft";
import { hasPoseData } from "../poseDraft";
import { escapeHtml } from "../format";
import {
  iconCheck,
  iconChevronDouble,
  iconDot,
  iconDownload,
  iconLoopArrows,
  iconImage,
  iconMask,
  iconPlay,
  iconPose,
  iconStar,
  iconStop,
  iconTrash,
  iconZoom
} from "../icons";
import { renderIterationTracker, type RoundProgressMap } from "./iterationTree";
import { renderPoseGridOverlay } from "./posePanel";

function generationModeLabel(mode: string) {
  return mode === "manual_upload" ? "source" : mode;
}

/**
 * 生成サイドバー(`.studio-sidebar`)の共通 shell。折りたたみトグル + 生成パネル + 右端の
 * ドラッグリサイザ。ProjectDetail と Book共通設定ビューの両方で使う(挙動を揃えるため共有)。
 * 幅は inline の `--studio-sidebar-width` で反映し、リサイズ中は sidebarResizeController が
 * この要素へ直接同変数を書き込む(render を通さない)。
 */
export function renderStudioSidebar(
  generationPanelHtml: string,
  sidebarOpen: boolean,
  sidebarCollapsed: boolean,
  sidebarWidth: number
): string {
  return `
      <aside class="studio-sidebar ${sidebarOpen ? "open" : ""} ${sidebarCollapsed ? "collapsed" : ""}" style="--studio-sidebar-width:${sidebarWidth}px">
        <button class="sidebar-collapse-toggle" type="button" data-action="toggle-sidebar-collapse" aria-label="${sidebarCollapsed ? "サイドバーを展開" : "サイドバーを折りたたむ"}" title="${sidebarCollapsed ? "サイドバーを展開" : "サイドバーを折りたたむ"}" aria-pressed="${sidebarCollapsed}">${iconChevronDouble()}</button>
        <div class="studio-sidebar-content">${generationPanelHtml}</div>
        <div class="sidebar-resizer" data-sidebar-resizer aria-hidden="true" title="ドラッグで幅を変更"></div>
      </aside>`;
}

export function renderProjectDetail(
  detail: ProjectDetail,
  activeRound: Round | null,
  assets: Asset[],
  selectedAssets: Asset[],
  sidebarOpen: boolean,
  gridCols: 2 | 3 | 4,
  roundActive: boolean,
  activeRoundId: string | null,
  deletePreviewRoundId: string | null,
  busy: boolean,
  generationPanelHtml: string,
  getInpaintDraft: (assetId: string) => InpaintDraft | null,
  getPoseDraft: (assetId: string) => PoseDraft | null,
  getPasteObjectCount: (assetId: string) => number,
  getPasteEnabled: (assetId: string) => boolean,
  copiedSeedAssetId: string | null,
  sidebarCollapsed = false,
  roundProgress: RoundProgressMap = {},
  bookPage: { title: string; number: number } | null = null,
  sidebarWidth = 360
) {
  const mode = activeRound?.generationMode ?? "txt2img";
  // 進捗サフィックスは実際に生成中の Round のみ(stale なエントリが残っていても表示しない)。
  const activeProgress = activeRound?.status === "running" ? roundProgress[activeRound.id] : undefined;
  const progressSuffix = activeProgress
    ? ` (${Math.round((activeProgress.value / activeProgress.max) * 100)}%, step ${activeProgress.value}/${activeProgress.max})`
    : "";

  return `
    <div class="studio-shell">
      <div class="sidebar-overlay ${sidebarOpen ? "active" : ""}" data-action="toggle-sidebar"></div>
      ${renderStudioSidebar(generationPanelHtml, sidebarOpen, sidebarCollapsed, sidebarWidth)}
      <main class="studio-main">
        <div class="round-toolbar">
          <div>
            ${bookPage ? `<div class="book-breadcrumb"><button class="button-secondary compact book-back-button" type="button" data-action="back-to-pages">← ページ一覧</button><span class="book-page-label">Page ${String(bookPage.number).padStart(2, "0")}${bookPage.title.trim() ? ` · ${escapeHtml(bookPage.title.trim())}` : ""}</span></div>` : ""}
            <h1>イテレーション ${activeRound ? `#${activeRound.roundIndex}` : ""}<span class="tag">${iconDot()}${escapeHtml(generationModeLabel(mode))}</span></h1>
            <p>${activeRound ? `<b>${activeRound.assetCount ?? 0}</b>枚生成 · 親画像 <b>${selectedAssets.length ? "#".concat(String(selectedAssets[0]!.batchIndex + 1)) : "-"}</b> · ${escapeHtml(activeRound.status)}${escapeHtml(progressSuffix)}` : "新規Roundを生成してください。"}</p>
          </div>
          <div class="toolbar-actions">
            <div class="segment-group">
              <button class="button-secondary compact" type="button" data-action="clear-selection">選択解除</button>
            </div>
            <span class="toolbar-divider"></span>
            <select id="grid-cols" class="compact-select" aria-label="グリッド列数">
              <option value="4" ${gridCols === 4 ? "selected" : ""}>4列</option>
              <option value="3" ${gridCols === 3 ? "selected" : ""}>3列</option>
              <option value="2" ${gridCols === 2 ? "selected" : ""}>2列</option>
            </select>
            ${roundActive ? `<button class="button-danger compact" type="button" data-action="interrupt-round" data-id="${activeRound!.id}">${iconStop()}停止</button>` : ""}
            ${activeRound ? `<button class="button-secondary compact" type="button" data-action="collect-round" data-id="${activeRound.id}">${iconDownload()}生成結果取得</button>` : ""}
          </div>
        </div>
        <div class="gallery-scroll">
          <div class="image-grid cols-${gridCols}">
            ${assets.length ? assets.map((asset) => renderAssetTile(asset, getInpaintDraft, getPoseDraft, getPasteObjectCount, getPasteEnabled, copiedSeedAssetId)).join("") : renderEmptyGallery(activeRound)}
          </div>
        </div>
        ${renderIterationTracker(detail.rounds, activeRoundId, deletePreviewRoundId, roundProgress)}
        ${renderBottomActionBar(selectedAssets, activeRound, busy)}
      </main>
    </div>
  `;
}

export function renderEmptyGallery(activeRound: Round | null) {
  if (!activeRound) {
    return renderSourceUploadEmptyState();
  }
  if (activeRound.status === "running" || activeRound.status === "pending") {
    return `<div class="empty wide">生成中です。画像ができた順にここへ表示されます。</div>`;
  }
  if (activeRound.status === "failed") {
    return `<div class="empty wide">このイテレーションは失敗しました。接続設定とworkflowを確認してブランチングしてください。</div>`;
  }
  if (activeRound.status === "interrupted") {
    return `<div class="empty wide">停止済みです。保存済みの画像があればここに表示されます。</div>`;
  }
  return `<div class="empty wide">取り込み済みの画像はありません。「生成結果取得」を押すと、完了済み画像だけをグリッド表示します。</div>`;
}

export function renderSourceUploadEmptyState() {
  return `
    <div class="empty wide source-upload-empty">
      <div>
        <strong>画像をアップロードして親画像にする</strong>
        <p>初回生成前でも source asset を登録して、img2img のブランチングを開始できます。</p>
      </div>
      ${renderSourceUploadButton("画像を選択")}
    </div>
  `;
}

export function renderSourceUploadButton(label: string) {
  return `
    <label class="button-secondary compact source-upload-button">
      ${iconImage()}${escapeHtml(label)}
      <input data-source-upload="1" type="file" accept="image/png,image/jpeg,image/webp" />
    </label>
  `;
}

export function renderAssetTile(
  asset: Asset,
  getInpaintDraft: (assetId: string) => InpaintDraft | null,
  getPoseDraft: (assetId: string) => PoseDraft | null,
  getPasteObjectCount: (assetId: string) => number,
  getPasteEnabled: (assetId: string) => boolean,
  copiedSeedAssetId: string | null
) {
  const selected = asset.status === "selected";
  const favorite = asset.status === "favorite";
  const rejected = asset.status === "rejected";
  const inpaintDraft = getInpaintDraft(asset.id);
  const masked = hasMaskData(inpaintDraft);
  const maskAttached = inpaintDraft?.enabled === true;
  const poseDraft = getPoseDraft(asset.id);
  const posed = hasPoseData(poseDraft);
  const poseAttached = poseDraft?.enabled === true;
  const pasted = getPasteObjectCount(asset.id) > 0;
  const pasteAttached = getPasteEnabled(asset.id);
  return `
    <article class="image-card ${selected ? "selected" : ""} ${favorite ? "favorite" : ""} ${rejected ? "rejected" : ""} ${masked ? "masked" : ""} ${posed ? "posed" : ""}" data-key="${asset.id}">
      <button class="asset-card-main" data-id="${asset.id}" type="button" aria-label="Asset #${asset.batchIndex + 1}">
        <img class="gen-image" src="${asset.thumbnailMediumUrl || asset.thumbnailUrl}" alt="" loading="lazy" />
        ${masked && maskAttached ? `<img class="mask-grid-preview" src="${inpaintDraft!.maskDataUrl}" alt="" aria-hidden="true" />` : ""}
        ${pasted && pasteAttached ? `<canvas class="paste-grid-canvas" data-asset-id="${asset.id}" aria-hidden="true"></canvas>` : ""}
        ${posed && poseAttached ? renderPoseGridOverlay(poseDraft, asset) : ""}
      </button>
      <button class="select-badge" data-action="toggle-select" data-id="${asset.id}" type="button" aria-label="選択切替">
        ${iconCheck(selected)}
      </button>
      <button class="star-badge ${favorite ? "starred" : ""}" data-action="toggle-favorite" data-id="${asset.id}" type="button" aria-label="favorite切替">
        ${iconStar(favorite)}
      </button>
      <button class="zoom-btn" data-action="asset-detail" data-id="${asset.id}" type="button" aria-label="拡大">
        ${iconZoom()}
      </button>
      <span class="card-number">#${asset.batchIndex + 1}</span>
      ${masked ? `<button class="mask-badge ${maskAttached ? "active" : "inactive"}" type="button" data-action="toggle-mask-attach" data-id="${asset.id}" aria-label="マスクの添付切替" title="${maskAttached ? "マスクを次回生成に添付中(クリックで外す)" : "マスクを次回生成に添付しない(クリックで添付)"}">${iconMask()}MASK</button>` : ""}
      ${posed ? `<button class="pose-badge ${poseAttached ? "active" : "inactive"}" type="button" data-action="toggle-pose-attach" data-id="${asset.id}" aria-label="ポーズの添付切替" title="${poseAttached ? "ポーズを次回生成に添付中(クリックで外す)" : "ポーズを次回生成に添付しない(クリックで添付)"}">${iconPose()}POSE</button>` : ""}
      ${pasted ? `<button class="paste-badge ${pasteAttached ? "active" : "inactive"}" type="button" data-action="toggle-paste-attach" data-id="${asset.id}" aria-label="貼り付けの添付切替" title="${pasteAttached ? "貼り付けを次回生成に添付中(クリックで外す)" : "貼り付けを次回生成に添付しない(クリックで添付)"}">${iconImage()}PASTE</button>` : ""}
      <div class="card-meta">
        <span class="seed-chip" data-action="copy-seed" data-id="${asset.id}" data-seed="${asset.seed ?? ""}" title="クリックでseedをコピー">${copiedSeedAssetId === asset.id ? "copied" : `seed ${asset.seed ?? "-"}`}</span>
        <span class="card-dims">${asset.width && asset.height ? `${asset.width}×${asset.height}` : ""}</span>
      </div>
    </article>
  `;
}

export function renderBottomActionBar(selectedAssets: Asset[], activeRound: Round | null, busy: boolean) {
  return `
    <div class="bottom-action-bar">
      <div class="bottom-left">
        ${busy ? `
          <div class="progress-wrap">
            <div class="progress-bar"><span style="width: 45%"></span></div>
            <span>生成中...</span>
          </div>
        ` : `
          <div class="selected-thumbs">
            ${selectedAssets.map((asset) => `<img src="${asset.thumbnailUrl}" alt="" />`).join("")}
          </div>
          <span class="selected-label">${selectedAssets.length ? "選択画像を次のブランチングに使用" : "親画像未選択"}</span>
        `}
      </div>
      <div class="bottom-actions">
        <button class="button-danger" type="button" data-action="reset-session">${iconTrash()}リセット</button>
        <button class="button-secondary" type="button" data-action="export-selected">${iconDownload()}保存</button>
        <button class="button-secondary" type="button" data-action="generate-round">${iconPlay()}${activeRound ? "画像無しで生成" : "初回生成"}</button>
        <button class="button-primary" type="button" data-action="img2img-next" ${selectedAssets.length !== 1 ? "disabled" : ""}>
          ${iconLoopArrows()}選択画像でブランチング
        </button>
      </div>
    </div>
  `;
}
