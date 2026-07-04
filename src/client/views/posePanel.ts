/**
 * ポーズタブ（アセット詳細モーダル右サイドバー「スマート選択」パネル内）の render helper。
 * `assetModal.ts` / `paintPanel.ts` と同様、state は引数で受け取るため main.ts への逆依存を持たない。
 * モデルカード・進捗バーは WebSAM パネル（`.websam-panel` 系 CSS）を再利用して同じ見た目にする。
 */
import type { Asset } from "../../shared/apiTypes";
import { escapeHtml, formatCssNumber, formatNumber } from "../format";
import { iconLoopArrows, iconPlay, iconReset } from "../icons";
import { POSE_MODELS, defaultPoseModel, formatModelBytes, poseModelById } from "../pose/models";
import type { PoseModelStatus } from "../pose/types";
import { defaultPoseDraft } from "../poseDraft";
import type { PoseDraft } from "../poseTypes";
import { OPENPOSE_BONE_COLORS, OPENPOSE_BONES, OPENPOSE_JOINT_COLORS } from "../poseTypes";

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function poseStatusLabel(status: PoseModelStatus) {
  if (status === "idle") return "未取得";
  if (status === "missing-url") return "URL未設定";
  if (status === "not-cached") return "未取得";
  if (status === "downloading") return "ダウンロード中";
  if (status === "cached") return "キャッシュ済み";
  if (status === "initializing") return "初期化中";
  if (status === "ready") return "Ready";
  if (status === "detecting") return "検出中";
  return "Error";
}

export function renderPosePanelSection(poseDraft: PoseDraft | null, assetId: string | null = null) {
  const draft = poseDraft ?? defaultPoseDraft(assetId ?? "");
  const model = poseModelById(draft.modelId) ?? defaultPoseModel();
  const statusClass = draft.modelStatus === "ready"
    ? "active"
    : draft.modelStatus === "error" || draft.modelStatus === "missing-url"
      ? "error"
      : "";
  const busy = draft.modelStatus === "downloading" || draft.modelStatus === "initializing" || draft.modelStatus === "detecting";
  const detected = !!draft.points;
  return `
    <div class="pose-panel websam-panel">
      <div class="websam-model-card">
        <div>
          <select class="workflow-select" data-pose-field="modelId" ${busy ? "disabled" : ""} aria-label="ポーズ検出モデル">
            ${POSE_MODELS.map(
              (item) =>
                `<option value="${escapeHtml(item.id)}" ${item.id === model.id ? "selected" : ""}>${escapeHtml(item.label)}</option>`
            ).join("")}
          </select>
          <small>${escapeHtml(`${model.description} / ${formatModelBytes(model.totalSize)}`)}</small>
        </div>
        <span class="mask-status ${statusClass}">${escapeHtml(poseStatusLabel(draft.modelStatus))}</span>
      </div>
      <div class="websam-progress"><span style="width: ${formatCssNumber(clamp01(draft.modelDownloadProgress) * 100)}%"></span></div>
      <div class="websam-status-line">
        <span>${escapeHtml(draft.modelStatusText || poseStatusLabel(draft.modelStatus))}</span>
        <button class="button-secondary compact mini-button" type="button" data-action="pose-load-model">${iconLoopArrows()}再試行</button>
      </div>
      ${draft.modelError ? `<p class="websam-error">${escapeHtml(draft.modelError)}</p>` : ""}
      <div class="websam-actions">
        <button class="button-secondary compact" type="button" data-action="pose-detect" ${busy ? "disabled" : ""}>${iconPlay()}ポーズ検出</button>
        <button class="button-secondary compact" type="button" data-action="pose-reset" ${detected && !busy ? "" : "disabled"}>${iconReset()}リセット（再検出）</button>
      </div>
      <label class="pose-attach-toggle">
        <input type="checkbox" data-pose-field="enabled" ${draft.enabled ? "checked" : ""} ${detected ? "" : "disabled"} />
        <span>次回生成に添付する</span>
      </label>
      ${renderPoseRange("strength", "Strength", draft.strength, 0, 2, 0.05, "poseStrengthValue")}
      ${renderPoseRange("startPercent", "Start percent", draft.startPercent, 0, 1, 0.05, "poseStartValue")}
      ${renderPoseRange("endPercent", "End percent", draft.endPercent, 0, 1, 0.05, "poseEndValue")}
      <div class="websam-counts">
        <span>${detected ? `関節 ${draft.points!.filter((point) => point.visible).length}/${draft.points!.length}` : "未検出"}</span>
        <span>${escapeHtml(draft.source === "edited" ? "編集済み" : "検出結果")}</span>
      </div>
    </div>
  `;
}

function renderPoseRange(field: string, label: string, value: number, min: number, max: number, step: number, valueId: string) {
  return `
    <div class="range-control smart-mask-range">
      <div class="range-label"><span>${escapeHtml(label)}</span><strong id="${valueId}">${formatNumber(value)}</strong></div>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${formatCssNumber(value)}" data-value-target="${valueId}" data-pose-field="${field}" />
    </div>
  `;
}

/**
 * 中央プレビューへ重ねるポーズスケルトンの SVG オーバーレイ（フェーズ3では表示のみ・編集なし）。
 * `renderWebSamPromptOverlay` と同型で、viewBox は画像 natural size に一致させる。
 */
export function renderPoseOverlay(draft: PoseDraft, asset: Asset) {
  const width = draft.imageWidth ?? assetDimension(asset, "width") ?? 1;
  const height = draft.imageHeight ?? assetDimension(asset, "height") ?? 1;
  const points = draft.points;
  if (!points) {
    return `<svg class="pose-overlay" viewBox="0 0 ${formatCssNumber(width)} ${formatCssNumber(height)}" aria-hidden="true"></svg>`;
  }
  const strokeWidth = Math.max(2, Math.min(width, height) / 200);
  const jointRadius = Math.max(4, Math.min(width, height) / 128);
  const bones = OPENPOSE_BONES.map((bone, index) => {
    const from = points[bone[0]];
    const to = points[bone[1]];
    if (!from || !to || !from.visible || !to.visible) {
      return "";
    }
    const [r, g, b] = OPENPOSE_BONE_COLORS[index] ?? [255, 255, 255];
    return `<line class="pose-bone" data-bone-index="${index}" data-bone-from="${bone[0]}" data-bone-to="${bone[1]}" x1="${formatCssNumber(from.x)}" y1="${formatCssNumber(from.y)}" x2="${formatCssNumber(to.x)}" y2="${formatCssNumber(to.y)}" stroke="rgb(${r},${g},${b})" stroke-width="${formatCssNumber(strokeWidth)}"></line>`;
  }).join("");
  const joints = points.map((point, index) => {
    const [r, g, b] = OPENPOSE_JOINT_COLORS[index] ?? [255, 255, 255];
    return `<circle class="pose-joint ${point.visible ? "" : "hidden-joint"}" data-joint-index="${index}" cx="${formatCssNumber(point.x)}" cy="${formatCssNumber(point.y)}" r="${formatCssNumber(jointRadius)}" fill="rgb(${r},${g},${b})"></circle>`;
  }).join("");
  return `
    <svg class="pose-overlay" viewBox="0 0 ${formatCssNumber(width)} ${formatCssNumber(height)}" aria-hidden="true">
      ${bones}
      ${joints}
    </svg>
  `;
}

function assetDimension(asset: Asset | null, key: "width" | "height") {
  const value = asset?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
