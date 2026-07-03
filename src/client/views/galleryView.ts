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
import { hasActiveMaskData } from "../maskDraft";
import { poseDraftHasAttachment } from "../poseDraft";
import { escapeHtml } from "../format";
import {
  iconCheck,
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
import { renderIterationTracker } from "./iterationTree";

function generationModeLabel(mode: string) {
  return mode === "manual_upload" ? "source" : mode;
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
  showMaskGridTag: boolean,
  copiedSeedAssetId: string | null
) {
  const mode = activeRound?.generationMode ?? "txt2img";

  return `
    <div class="studio-shell">
      <div class="sidebar-overlay ${sidebarOpen ? "active" : ""}" data-action="toggle-sidebar"></div>
      <aside class="studio-sidebar ${sidebarOpen ? "open" : ""}">
        ${generationPanelHtml}
      </aside>
      <main class="studio-main">
        <div class="round-toolbar">
          <div>
            <h1>イテレーション ${activeRound ? `#${activeRound.roundIndex}` : ""}<span class="tag">${iconDot()}${escapeHtml(generationModeLabel(mode))}</span></h1>
            <p>${activeRound ? `${activeRound.assetCount ?? 0}枚生成・${selectedAssets.length}枚選択中・${escapeHtml(activeRound.status)}` : "新規Roundを生成してください。"}</p>
          </div>
          <div class="toolbar-actions">
            <button class="button-secondary compact" type="button" data-action="select-all">全選択</button>
            <button class="button-secondary compact" type="button" data-action="clear-selection">選択解除</button>
            <button class="button-secondary compact" type="button" data-action="invert-selection">選択反転</button>
            <span class="toolbar-divider"></span>
            <select id="grid-cols" class="compact-select" aria-label="グリッド列数">
              <option value="4" ${gridCols === 4 ? "selected" : ""}>4x4</option>
              <option value="3" ${gridCols === 3 ? "selected" : ""}>3列</option>
              <option value="2" ${gridCols === 2 ? "selected" : ""}>2列</option>
            </select>
            ${roundActive ? `<button class="button-danger compact" type="button" data-action="interrupt-round" data-id="${activeRound!.id}">${iconStop()}停止</button>` : ""}
            ${activeRound ? `<button class="button-secondary compact" type="button" data-action="collect-round" data-id="${activeRound.id}">${iconDownload()}生成結果取得</button>` : ""}
          </div>
        </div>
        <div class="gallery-scroll">
          <div class="image-grid cols-${gridCols}">
            ${assets.length ? assets.map((asset) => renderAssetTile(asset, getInpaintDraft, getPoseDraft, showMaskGridTag, copiedSeedAssetId)).join("") : renderEmptyGallery(activeRound)}
          </div>
        </div>
        ${renderIterationTracker(detail.rounds, activeRoundId, deletePreviewRoundId)}
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
  showMaskGridTag: boolean,
  copiedSeedAssetId: string | null
) {
  const selected = asset.status === "selected";
  const favorite = asset.status === "favorite";
  const rejected = asset.status === "rejected";
  const masked = assetHasMaskIndicator(asset, getInpaintDraft);
  const posed = poseDraftHasAttachment(getPoseDraft(asset.id));
  return `
    <article class="image-card ${selected ? "selected" : ""} ${favorite ? "favorite" : ""} ${rejected ? "rejected" : ""} ${masked ? "masked" : ""} ${posed ? "posed" : ""}">
      <button class="asset-card-main" data-id="${asset.id}" type="button" aria-label="Asset #${asset.batchIndex + 1}">
        <img class="gen-image" src="${asset.thumbnailMediumUrl || asset.thumbnailUrl}" alt="" loading="lazy" />
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
      ${masked ? `<button class="mask-badge ${showMaskGridTag ? "active" : "inactive"}" type="button" data-action="toggle-mask-grid-tag" aria-label="マスクタグ表示切替">${iconMask()}MASK</button>` : ""}
      ${posed ? `<button class="pose-badge ${showMaskGridTag ? "active" : "inactive"}" type="button" data-action="toggle-mask-grid-tag" aria-label="ポーズタグ表示切替">${iconPose()}POSE</button>` : ""}
      <span class="seed-chip" data-action="copy-seed" data-id="${asset.id}" data-seed="${asset.seed ?? ""}">${copiedSeedAssetId === asset.id ? "copied" : `seed ${asset.seed ?? "-"}`}</span>
    </article>
  `;
}

export function assetHasMaskIndicator(asset: Asset, getInpaintDraft: (assetId: string) => InpaintDraft | null) {
  return hasActiveMaskData(getInpaintDraft(asset.id));
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
            ${selectedAssets.slice(0, 5).map((asset) => `<img src="${asset.thumbnailUrl}" alt="" />`).join("")}
            ${selectedAssets.length > 5 ? `<span>+${selectedAssets.length - 5}</span>` : ""}
          </div>
          <span class="selected-label">${selectedAssets.length}枚の画像を次のブランチングに使用</span>
        `}
      </div>
      <div class="bottom-actions">
        <button class="button-danger" type="button" data-action="reset-session">${iconTrash()}リセット</button>
        <button class="button-secondary" type="button" data-action="export-selected">${iconDownload()}保存</button>
        <button class="button-primary" type="button" data-action="generate-round">${iconPlay()}${activeRound ? "画像無しで生成" : "初回生成"}</button>
        <button class="button-primary" type="button" data-action="img2img-next" ${selectedAssets.length === 0 ? "disabled" : ""}>
          ${iconLoopArrows()}選択画像でブランチング <span class="button-count">${selectedAssets.length}</span>
        </button>
      </div>
    </div>
  `;
}
