import { getRow } from "./db";

export type BranchAssignment = { colorIndex: number; reason: string; key: string };

export function nextRoundIndex(projectId: string) {
  return getRow<{ next_index: number }>(
    "SELECT COALESCE(MAX(round_index), 0) + 1 AS next_index FROM generation_rounds WHERE project_id = ?",
    [projectId]
  )?.next_index ?? 1;
}

export function branchAssignmentForRound(
  projectId: string,
  parentAsset: Record<string, unknown> | null,
  roundId: string,
  rootReason: string
): BranchAssignment {
  if (parentAsset) {
    const key = `asset:${parentAsset.id}`;
    const existing = getRow<{ branch_color_index: number }>(
      `SELECT branch_color_index
       FROM generation_rounds
       WHERE project_id = ? AND branch_key = ?
       ORDER BY round_index ASC
       LIMIT 1`,
      [projectId, key]
    );
    if (existing) {
      return {
        colorIndex: Number(existing.branch_color_index) || 0,
        reason: "parent_asset",
        key
      };
    }
    return {
      colorIndex: nextBranchColorIndex(projectId),
      reason: "parent_asset",
      key
    };
  }

  return {
    colorIndex: nextBranchColorIndex(projectId),
    reason: rootReason,
    key: `root:${roundId}`
  };
}

function nextBranchColorIndex(projectId: string) {
  return getRow<{ next_index: number }>(
    "SELECT COALESCE(MAX(branch_color_index), -1) + 1 AS next_index FROM generation_rounds WHERE project_id = ?",
    [projectId]
  )?.next_index ?? 0;
}
