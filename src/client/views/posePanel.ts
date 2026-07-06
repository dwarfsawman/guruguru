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
import type { PoseDraft, PosePoint } from "../poseTypes";
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
  const detected = !!draft.poses && draft.poses.length > 0;
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
      ${detected ? `<p class="pose-edit-hint">関節ドラッグ=移動 / Shift=1ボーン回転 / Alt=FK(子孫も回転)<br>空き地ドラッグ=範囲選択(Shiftで追加) / 選択をドラッグ=一括移動・Shift/Altで回転<br>エッジをクリックで選択 / ×またはDeleteで削除 / Ctrl+Zで戻す</p>` : ""}
      ${renderPoseRange("keypointThreshold", "Keypoint threshold", draft.keypointThreshold, 0, 1, 0.05, "poseKeypointThresholdValue")}
      ${renderPoseRange("strength", "Strength", draft.strength, 0, 2, 0.05, "poseStrengthValue")}
      ${renderPoseRange("startPercent", "Start percent", draft.startPercent, 0, 1, 0.05, "poseStartValue")}
      ${renderPoseRange("endPercent", "End percent", draft.endPercent, 0, 1, 0.05, "poseEndValue")}
      <div class="websam-counts">
        <span>${detected ? poseCountsLabel(draft.poses!) : "未検出"}</span>
        <span>${escapeHtml(draft.source === "edited" ? "編集済み" : "検出結果")}</span>
      </div>
    </div>
  `;
}

function poseCountsLabel(poses: PosePoint[][]) {
  const visible = poses.reduce((sum, pose) => sum + pose.filter((point) => point.visible).length, 0);
  const total = poses.reduce((sum, pose) => sum + pose.length, 0);
  const people = poses.length > 1 ? `${poses.length}人 · ` : "";
  return `${people}関節 ${visible}/${total}`;
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
export function renderPoseOverlay(
  draft: PoseDraft,
  asset: Asset,
  selectedEdges: ReadonlyArray<{ poseIndex: number; boneIndex: number }> = []
) {
  const width = draft.imageWidth ?? assetDimension(asset, "width") ?? 1;
  const height = draft.imageHeight ?? assetDimension(asset, "height") ?? 1;
  const poses = draft.poses;
  if (!poses || poses.length === 0) {
    return `<svg class="pose-overlay" viewBox="0 0 ${formatCssNumber(width)} ${formatCssNumber(height)}" aria-hidden="true"></svg>`;
  }
  const removedBones = draft.removedBones;
  const strokeWidth = Math.max(2, Math.min(width, height) / 200);
  const jointRadius = Math.max(4, Math.min(width, height) / 128);
  // エッジ選択用の透明な当たり判定線幅（表示線より太く）と、削除×ボタンの半径。
  const hitWidth = Math.max(strokeWidth * 4, Math.min(width, height) / 45);
  const deleteRadius = Math.max(jointRadius * 2, Math.min(width, height) / 42);
  const isSelected = (poseIndex: number, boneIndex: number) =>
    selectedEdges.some((edge) => edge.poseIndex === poseIndex && edge.boneIndex === boneIndex);
  // 選択ボーン中点の重心（× を1つだけそこに出す）
  const selectedMidpoints: Array<{ x: number; y: number }> = [];
  // マルチ選択時の当たり判定を広げるため、背景 rect を最初に置く（joint/bone より背面）
  const backgroundRect = `<rect class="pose-overlay-bg" x="0" y="0" width="${formatCssNumber(width)}" height="${formatCssNumber(height)}" fill="transparent"></rect>`;
  const body = poses
    .map((points, poseIndex) => {
      const removed = removedBones?.[poseIndex];
      const visibleBones: string[] = [];
      const hitBones: string[] = [];
      OPENPOSE_BONES.forEach((bone, index) => {
        if (removed?.includes(index)) {
          return;
        }
        const from = points[bone[0]];
        const to = points[bone[1]];
        if (!from || !to || !from.visible || !to.visible) {
          return;
        }
        const [r, g, b] = OPENPOSE_BONE_COLORS[index] ?? [255, 255, 255];
        const selected = isSelected(poseIndex, index);
        const dataAttrs = `data-pose-index="${poseIndex}" data-bone-index="${index}" data-bone-from="${bone[0]}" data-bone-to="${bone[1]}"`;
        const coords = `x1="${formatCssNumber(from.x)}" y1="${formatCssNumber(from.y)}" x2="${formatCssNumber(to.x)}" y2="${formatCssNumber(to.y)}"`;
        visibleBones.push(
          `<line class="pose-bone${selected ? " selected" : ""}" ${dataAttrs} ${coords} stroke="rgb(${r},${g},${b})" stroke-width="${formatCssNumber(strokeWidth)}"></line>`
        );
        hitBones.push(
          `<line class="pose-bone-hit${selected ? " selected" : ""}" ${dataAttrs} ${coords} stroke="transparent" stroke-width="${formatCssNumber(hitWidth)}"></line>`
        );
        if (selected) {
          selectedMidpoints.push({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
        }
      });
      const joints = points.map((point, index) => {
        const [r, g, b] = OPENPOSE_JOINT_COLORS[index] ?? [255, 255, 255];
        return `<circle class="pose-joint ${point.visible ? "" : "hidden-joint"}" data-pose-index="${poseIndex}" data-joint-index="${index}" cx="${formatCssNumber(point.x)}" cy="${formatCssNumber(point.y)}" r="${formatCssNumber(jointRadius)}" fill="rgb(${r},${g},${b})"></circle>`;
      }).join("");
      // 重ね順: 表示ボーン → 透明ヒット線 → 関節（関節ドラッグをエッジ選択より優先）
      return visibleBones.join("") + hitBones.join("") + joints;
    })
    .join("");
  let deleteButton = "";
  if (selectedMidpoints.length > 0) {
    const cx = selectedMidpoints.reduce((sum, point) => sum + point.x, 0) / selectedMidpoints.length;
    const cy = selectedMidpoints.reduce((sum, point) => sum + point.y, 0) / selectedMidpoints.length;
    const cross = deleteRadius * 0.45;
    const stroke = strokeWidth * 1.2;
    deleteButton =
      `<g class="pose-edge-delete" transform="translate(${formatCssNumber(cx)} ${formatCssNumber(cy)})">` +
      `<circle class="pose-edge-delete-bg" r="${formatCssNumber(deleteRadius)}"></circle>` +
      `<line class="pose-edge-delete-x" x1="${formatCssNumber(-cross)}" y1="${formatCssNumber(-cross)}" x2="${formatCssNumber(cross)}" y2="${formatCssNumber(cross)}" stroke-width="${formatCssNumber(stroke)}"></line>` +
      `<line class="pose-edge-delete-x" x1="${formatCssNumber(-cross)}" y1="${formatCssNumber(cross)}" x2="${formatCssNumber(cross)}" y2="${formatCssNumber(-cross)}" stroke-width="${formatCssNumber(stroke)}"></line>` +
      `</g>`;
  }
  return `
    <svg class="pose-overlay" viewBox="0 0 ${formatCssNumber(width)} ${formatCssNumber(height)}">
      ${backgroundRect}
      ${body}
      ${deleteButton}
    </svg>
  `;
}

function assetDimension(asset: Asset | null, key: "width" | "height") {
  const value = asset?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * グリッドタイル用の静的ポーズスケルトンプレビュー(編集・当たり判定なし)。
 * `renderPoseOverlay` と違い、当たり判定線・背景 rect・削除ボタンは持たない。
 * `width`/`height` 属性を asset の intrinsic size に固定し、CSS の object-fit: cover で
 * `.gen-image`(グリッドサムネイル)のクロップと一致させる。
 */
export function renderPoseGridOverlay(draft: PoseDraft | null, asset: Asset) {
  if (!draft || !draft.poses || draft.poses.length === 0) {
    return "";
  }
  const width = draft.imageWidth ?? assetDimension(asset, "width") ?? 1;
  const height = draft.imageHeight ?? assetDimension(asset, "height") ?? 1;
  const removedBones = draft.removedBones;
  const strokeWidth = Math.max(2, Math.min(width, height) / 200);
  const jointRadius = Math.max(4, Math.min(width, height) / 128);
  const body = draft.poses
    .map((points, poseIndex) => {
      const removed = removedBones?.[poseIndex];
      const bones = OPENPOSE_BONES.map((bone, index) => {
        if (removed?.includes(index)) {
          return "";
        }
        const from = points[bone[0]];
        const to = points[bone[1]];
        if (!from || !to || !from.visible || !to.visible) {
          return "";
        }
        const [r, g, b] = OPENPOSE_BONE_COLORS[index] ?? [255, 255, 255];
        return `<line class="pose-grid-bone" x1="${formatCssNumber(from.x)}" y1="${formatCssNumber(from.y)}" x2="${formatCssNumber(to.x)}" y2="${formatCssNumber(to.y)}" stroke="rgb(${r},${g},${b})" stroke-width="${formatCssNumber(strokeWidth)}"></line>`;
      }).join("");
      const joints = points
        .map((point, index) => {
          if (!point.visible) {
            return "";
          }
          const [r, g, b] = OPENPOSE_JOINT_COLORS[index] ?? [255, 255, 255];
          return `<circle class="pose-grid-joint" cx="${formatCssNumber(point.x)}" cy="${formatCssNumber(point.y)}" r="${formatCssNumber(jointRadius)}" fill="rgb(${r},${g},${b})"></circle>`;
        })
        .join("");
      return bones + joints;
    })
    .join("");
  return `<svg class="pose-grid-overlay" width="${formatCssNumber(width)}" height="${formatCssNumber(height)}" viewBox="0 0 ${formatCssNumber(width)} ${formatCssNumber(height)}" aria-hidden="true">${body}</svg>`;
}
