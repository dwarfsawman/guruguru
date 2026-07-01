/**
 * イテレーションツリー（round tree）の render helper。
 * `src/client/main.ts` から抽出。state は引数で受け取るため main.ts への逆依存を持たない（circular import なし）。
 * UI 文言・HTML 構造・CSS class・data-action・selector は移動前と同一。
 *
 * `generationModeLabel` は第16フェーズのモジュール4 (`generationPanel.ts`) 抽出までの一時的な
 * ローカル複製。モジュール4のコミットで `generationPanel.ts` からの import に切り替える。
 */
import type { Round } from "../../shared/apiTypes";
import { escapeAttr } from "../format";
import { iconClose } from "../icons";

function sortRoundsAsc(rounds: Round[]) {
  return [...rounds].sort((a, b) => a.roundIndex - b.roundIndex);
}

function generationModeLabel(mode: string) {
  return mode === "manual_upload" ? "source" : mode;
}

export function renderIterationTracker(rounds: Round[], activeRoundId: string | null, deletePreviewRoundId: string | null) {
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
        ${forest.roots.map((round) => renderRoundTreeNode(round, forest.children, deleteTargetIds, activeRoundId, deletePreviewRoundId)).join("")}
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
  deletePreviewRoundId: string | null
): string {
  const childRounds = children.get(round.id) ?? [];
  const active = round.id === activeRoundId;
  const completed = round.status === "completed";
  const dotClass = active ? "active" : completed ? "completed" : "pending";
  const hue = branchHue(round);
  const isDeleteRoot = deletePreviewRoundId === round.id;
  const isDeleteTarget = deleteTargetIds.has(round.id);
  return `
    <div class="iteration-node ${childRounds.length ? "has-children" : ""} ${isDeleteRoot ? "delete-preview-root" : ""} ${isDeleteTarget ? "delete-preview-target" : ""}" style="--branch-hue: ${hue}">
      <button class="iteration-dot ${dotClass}" data-action="select-round" data-id="${round.id}" type="button" title="${escapeAttr(iterationTitle(round))}">
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
              ${renderRoundTreeNode(child, children, deleteTargetIds, activeRoundId, deletePreviewRoundId)}
            </div>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

export function branchHue(round: Round) {
  return ((round.branchColorIndex ?? 0) * 57) % 360;
}

export function iterationTitle(round: Round) {
  const parent = round.parentRoundId ? ` / parent ${round.parentRoundId}` : " / root";
  return `Round ${round.roundIndex} / ${generationModeLabel(round.generationMode)} / ${round.status}${parent}`;
}
