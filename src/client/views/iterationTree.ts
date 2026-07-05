/**
 * イテレーションツリー（round tree）の render helper。
 * `src/client/main.ts` から抽出。state は引数で受け取るため main.ts への逆依存を持たない（circular import なし）。
 * UI 文言・HTML 構造・CSS class・data-action・selector は移動前と同一。
 *
 * `generationModeLabel` は `generationPanel.ts` にも同名の export があるが、
 * `generationPanel.ts` は `galleryView.ts`（本 module の依存先）を import するため、
 * ここから直接 import すると循環 import になる。関数本体が完全に同一の小さい pure helper
 * のため、循環を避けてこのモジュール内に複製している。
 */
import type { Round } from "../../shared/apiTypes";
import { escapeAttr, escapeHtml, formatNumber } from "../format";
import { iconClose } from "../icons";

const ROOT_HUE_STEP = 57;
const CHILD_HUE_STEP_MAX = 40;

/** エッジ hover ポップアウトに表示するプロンプト synopsis の最大文字数。 */
const PROMPT_SYNOPSIS_MAX = 140;

function normalizeHue(h: number) {
  return ((h % 360) + 360) % 360;
}

function clampDenoise(denoise: number) {
  return Math.min(1, Math.max(0, denoise));
}

function sortRoundsAsc(rounds: Round[]) {
  return [...rounds].sort((a, b) => a.roundIndex - b.roundIndex);
}

function generationModeLabel(mode: string) {
  return mode === "manual_upload" ? "source" : mode;
}

/** UX改善#5: ComfyUI の現在のサンプラー step。roundId をキーに持つ round のみ生成中。 */
export type RoundProgressMap = Record<string, { value: number; max: number }>;

export function renderIterationTracker(
  rounds: Round[],
  activeRoundId: string | null,
  deletePreviewRoundId: string | null,
  roundProgress: RoundProgressMap = {}
) {
  const sortedRounds = sortRoundsAsc(rounds);
  if (!sortedRounds.length) {
    return `<div class="iteration-tracker empty-tracker"><span class="iteration-empty">No iterations</span></div>`;
  }
  const forest = buildRoundForest(sortedRounds);
  const deleteTargetIds = deletePreviewRoundId
    ? collectRoundSubtreeIds(deletePreviewRoundId, forest.children)
    : new Set<string>();
  return `
    <div class="iteration-tracker" aria-label="イテレーション">
      <div class="iteration-forest">
        <svg class="iteration-edges" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"></svg>
        ${forest.roots.map((round) => renderRoundTreeNode(round, forest.children, deleteTargetIds, activeRoundId, deletePreviewRoundId, roundProgress)).join("")}
      </div>
    </div>
  `;
}

export function buildRoundForest(rounds: Round[]) {
  const byId = new Map(rounds.map((round) => [round.id, round]));
  const children = new Map<string, Round[]>();
  const roots: Round[] = [];

  for (const round of rounds) {
    const parentId = round.parentRoundId && byId.has(round.parentRoundId) ? round.parentRoundId : null;
    if (!parentId) {
      roots.push(round);
      continue;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(round);
    children.set(parentId, siblings);
  }

  return { roots, children };
}

export function collectRoundSubtreeIds(rootRoundId: string, children: Map<string, Round[]>) {
  const ids = new Set<string>();
  const visit = (roundId: string) => {
    ids.add(roundId);
    for (const child of children.get(roundId) ?? []) {
      visit(child.id);
    }
  };
  visit(rootRoundId);
  return ids;
}

export function renderRoundTreeNode(
  round: Round,
  children: Map<string, Round[]>,
  deleteTargetIds: Set<string>,
  activeRoundId: string | null,
  deletePreviewRoundId: string | null,
  roundProgress: RoundProgressMap = {},
  parentHue: number | null = null
): string {
  const childRounds = children.get(round.id) ?? [];
  const active = round.id === activeRoundId;
  const completed = round.status === "completed";
  const running = round.status === "running";
  const dotClass = `${active ? "active" : completed ? "completed" : "pending"}${running ? " running" : ""}`;
  const hue = parentHue == null ? rootHue(round) : childHue(parentHue, round.request?.denoise ?? 1);
  const isDeleteRoot = deletePreviewRoundId === round.id;
  const isDeleteTarget = deleteTargetIds.has(round.id);
  const hasIncomingEdge = parentHue != null;
  const nodeStyle = `--branch-hue: ${hue}${hasIncomingEdge ? `; --parent-hue: ${parentHue}` : ""}`;
  const progress = roundProgress[round.id];
  return `
    <div class="iteration-node ${childRounds.length ? "has-children" : ""} ${isDeleteRoot ? "delete-preview-root" : ""} ${isDeleteTarget ? "delete-preview-target" : ""}" style="${nodeStyle}">
      ${hasIncomingEdge ? `
        <span class="iteration-edge" data-edge-round="${round.id}" aria-label="Round ${round.roundIndex} 生成プロパティ">
          <span class="iteration-edge-popout" role="tooltip">${iterationEdgePopoutHtml(round)}</span>
        </span>
      ` : ""}
      <button class="iteration-dot ${dotClass}" data-action="select-round" data-id="${round.id}" data-round-id="${escapeAttr(round.id)}" data-parent-id="${hasIncomingEdge ? escapeAttr(round.parentRoundId ?? "") : ""}" data-hue="${hue}" type="button" title="${escapeAttr(iterationTitle(round, progress))}">
        <span>${round.roundIndex}</span>
      </button>
      ${isDeleteTarget ? `
        <button class="iteration-delete-mark" type="button" data-action="delete-round" data-id="${deletePreviewRoundId ?? round.id}" title="削除">
          ${iconClose()}
        </button>
      ` : ""}
      ${childRounds.length ? `
        <div class="iteration-children ${childRounds.length > 1 ? "has-siblings" : "single-child"}">
          ${childRounds.map((child, index) => `
            <div class="iteration-child ${index === 0 ? "first" : ""} ${index === childRounds.length - 1 ? "last" : ""}">
              ${renderRoundTreeNode(child, children, deleteTargetIds, activeRoundId, deletePreviewRoundId, roundProgress, hue)}
            </div>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

/**
 * プロンプト文字列を hover ポップアウト用の synopsis に整形する。
 * 文字数（正規化後の可視文字数）と、`PROMPT_SYNOPSIS_MAX` で切り詰めた本文を返す。
 */
export function promptSynopsis(prompt: string) {
  const normalized = (prompt ?? "").replace(/\s+/g, " ").trim();
  const charCount = normalized.length;
  const text = charCount > PROMPT_SYNOPSIS_MAX ? `${normalized.slice(0, PROMPT_SYNOPSIS_MAX)}…` : normalized;
  return { charCount, text };
}

/**
 * イテレーションツリーのエッジ（親→子のリンク）に対応する生成プロパティを
 * ポップアウト内部の HTML として組み立てる。黒背景・白文字は CSS 側で付与する。
 * プロンプト（文字量つき synopsis）、解像度、デノイズ値、ステップ数などを含む。
 */
export function iterationEdgePopoutHtml(round: Round): string {
  const req = round.request;
  const synopsis = promptSynopsis(req?.prompt ?? "");
  const promptBody = synopsis.text
    ? escapeHtml(synopsis.text)
    : `<span class="iteration-edge-empty">(プロンプトなし)</span>`;
  const rows: Array<[string, string]> = [
    ["解像度", `${req.width}×${req.height}`],
    ["デノイズ", formatNumber(req.denoise)],
    ["ステップ数", String(req.steps)],
    ["CFG", formatNumber(req.cfg)],
    ["サンプラー", req.sampler || "-"],
    ["スケジューラ", req.scheduler || "-"],
    ["モード", generationModeLabel(req.generationMode)]
  ];
  return `
    <div class="iteration-edge-prompt">
      <div class="iteration-edge-prompt-head">プロンプト <span class="iteration-edge-count">${synopsis.charCount}文字</span></div>
      <div class="iteration-edge-prompt-body">${promptBody}</div>
    </div>
    <dl class="iteration-edge-grid">
      ${rows
        .map(([label, value]) => `<div class="iteration-edge-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
        .join("")}
    </dl>
  `;
}

export function rootHue(round: Round) {
  return normalizeHue((round.branchColorIndex ?? 0) * ROOT_HUE_STEP);
}

export function childHue(parentHue: number, denoise: number) {
  return normalizeHue(parentHue + CHILD_HUE_STEP_MAX * clampDenoise(denoise));
}

export function iterationTitle(round: Round, progress?: { value: number; max: number }) {
  const parent = round.parentRoundId ? ` / parent ${round.parentRoundId}` : " / root";
  const progressSuffix = progress ? ` (${Math.round((progress.value / progress.max) * 100)}%, step ${progress.value}/${progress.max})` : "";
  return `Round ${round.roundIndex} / ${generationModeLabel(round.generationMode)} / ${round.status}${progressSuffix}${parent}`;
}
