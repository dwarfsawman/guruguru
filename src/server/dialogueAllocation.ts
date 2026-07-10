/**
 * Chronicle Page Flow(S5、Docs/Feature-ChroniclePageFlow.md §3・§6 フェーズII)。
 * Chronicle バーで選択した行をページへ一括 placement 化する/解除する。既存の個別配置 API
 * (`dialogueLines.ts` の `createDialoguePlacement`/`deleteDialoguePlacement`)とは別経路 --
 * こちらは常に `balloon_object_id=NULL` の placement だけを作る(吹き出し生成はフェーズIIIの apply)。
 * `pages.ts` の `reorderPages`(BEGIN/COMMIT トランザクション)が手本。
 */
import type {
  DialogueAllocationRemovalResult,
  DialogueAllocationResult,
  ExistingPlacementPolicy
} from "../shared/chronicle";
import { createId, getRow, getRows, runSql } from "./db";
import { HttpError } from "./http";
import { objectBody } from "./validate";

function requireProject(projectId: string) {
  const project = getRow("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
}

function requirePageInProject(projectId: string, pageId: string) {
  const page = getRow("SELECT id FROM pages WHERE id = ? AND project_id = ?", [pageId, projectId]);
  if (!page) {
    throw new HttpError(404, "Page was not found in this project");
  }
}

function parseLineIds(input: Record<string, unknown>): string[] {
  if (!Array.isArray(input.lineIds) || input.lineIds.length === 0 || input.lineIds.some((id) => typeof id !== "string")) {
    throw new HttpError(400, "lineIds must be a non-empty array of strings");
  }
  return input.lineIds as string[];
}

interface LineRow {
  id: string;
}

/** lineIds が全てこのプロジェクトに実在するか検証する(不正なら 404)。 */
function requireLinesInProject(projectId: string, lineIds: string[]): void {
  const distinctIds = Array.from(new Set(lineIds));
  const placeholders = distinctIds.map(() => "?").join(",");
  const rows = getRows<LineRow>(`SELECT id FROM dialogue_lines WHERE project_id = ? AND id IN (${placeholders})`, [
    projectId,
    ...distinctIds
  ]);
  const found = new Set(rows.map((row) => row.id));
  const missing = distinctIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new HttpError(404, `Dialogue line(s) were not found in this project: ${missing.join(", ")}`);
  }
}

interface PlacementRow {
  id: string;
  line_id: string;
  page_id: string;
  panel_id: string | null;
  part_index: number;
  render_kind: string;
  balloon_object_id: string | null;
}

const POLICIES: ReadonlySet<ExistingPlacementPolicy> = new Set(["skip", "move", "copy"]);

function parsePolicy(input: Record<string, unknown>): ExistingPlacementPolicy {
  return POLICIES.has(input.existingPlacementPolicy as ExistingPlacementPolicy)
    ? (input.existingPlacementPolicy as ExistingPlacementPolicy)
    : "skip";
}

/**
 * `POST /api/projects/:projectId/pages/:pageId/dialogue-allocation`(§3・§6 フェーズII)。
 * 選択行を当該ページへ placement 化する(balloon_object_id=NULL、吹き出し生成は行わない)。
 * 冪等: 既に当該ページに配置済みの行は無視する(繰り返し実行しても placement は増えない)。
 * 他ページ配置済みの行は `existingPlacementPolicy`(既定 "skip")に従う。
 * トランザクション(BEGIN/COMMIT、失敗時 ROLLBACK で全件戻す)。
 */
export function allocateDialoguePages(projectId: string, pageId: string, body: unknown): DialogueAllocationResult {
  requireProject(projectId);
  requirePageInProject(projectId, pageId);
  const input = objectBody(body);
  const lineIds = parseLineIds(input);
  requireLinesInProject(projectId, lineIds);
  const policy = parsePolicy(input);

  let created = 0;
  let skipped = 0;
  let moved = 0;
  const warnings: string[] = [];

  runSql("BEGIN");
  try {
    for (const lineId of Array.from(new Set(lineIds))) {
      const placements = getRows<PlacementRow>("SELECT * FROM dialogue_placements WHERE line_id = ?", [lineId]);
      const onTargetPage = placements.filter((row) => row.page_id === pageId);
      const onOtherPages = placements.filter((row) => row.page_id !== pageId);

      if (onTargetPage.length > 0) {
        // 既にこのページに配置済み(冪等: 何もしない)。
        skipped += 1;
        continue;
      }

      if (onOtherPages.length === 0) {
        runSql(
          `INSERT INTO dialogue_placements (id, line_id, page_id, panel_id, part_index, render_kind, balloon_object_id)
           VALUES (?, ?, ?, NULL, 0, 'balloon', NULL)`,
          [createId("place"), lineId, pageId]
        );
        created += 1;
        continue;
      }

      // ここから: 他ページに配置済み(かつ当該ページには未配置)の行。
      if (policy === "copy") {
        const partIndex = placements.length;
        runSql(
          `INSERT INTO dialogue_placements (id, line_id, page_id, panel_id, part_index, render_kind, balloon_object_id)
           VALUES (?, ?, ?, NULL, ?, 'balloon', NULL)`,
          [createId("place"), lineId, pageId, partIndex]
        );
        created += 1;
        continue;
      }

      if (policy === "move") {
        const materialized = onOtherPages.filter((row) => row.balloon_object_id);
        const movable = onOtherPages.filter((row) => !row.balloon_object_id);
        if (movable.length === 0) {
          // 全ての他ページ配置が吹き出し化済み: 移動できないので skip 扱い。
          skipped += 1;
          warnings.push(`行 ${lineId} は他ページで吹き出し化済みのため移動できませんでした。`);
          continue;
        }
        for (const row of movable) {
          runSql("UPDATE dialogue_placements SET page_id = ?, panel_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
            pageId,
            row.id
          ]);
        }
        moved += 1;
        if (materialized.length > 0) {
          warnings.push(`行 ${lineId} は一部の吹き出し化済み配置(${materialized.length}件)を移動できませんでした。`);
        }
        continue;
      }

      // skip(既定)。
      skipped += 1;
      warnings.push(`行 ${lineId} は他ページに配置済みのためスキップしました。`);
    }
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    throw error;
  }

  return { created, skipped, moved, warnings };
}

/**
 * `POST /api/projects/:projectId/pages/:pageId/dialogue-allocation/remove`(§3・§6 フェーズII)。
 * 選択行のうち当該ページへの placement を解除する。`balloon_object_id` が付いた placement
 * (吹き出し化済み)は対象外とし、warnings に記録する(吹き出し削除はフェーズIVの領域)。
 * 元々当該ページに配置が無い行は無視する(冪等)。トランザクション化。
 */
export function removeDialogueAllocation(projectId: string, pageId: string, body: unknown): DialogueAllocationRemovalResult {
  requireProject(projectId);
  requirePageInProject(projectId, pageId);
  const input = objectBody(body);
  const lineIds = parseLineIds(input);
  requireLinesInProject(projectId, lineIds);

  let removed = 0;
  let skipped = 0;
  const warnings: string[] = [];

  runSql("BEGIN");
  try {
    for (const lineId of Array.from(new Set(lineIds))) {
      const placements = getRows<PlacementRow>("SELECT * FROM dialogue_placements WHERE line_id = ? AND page_id = ?", [
        lineId,
        pageId
      ]);
      for (const row of placements) {
        if (row.balloon_object_id) {
          skipped += 1;
          warnings.push(`行 ${lineId} は吹き出し化済みのため解除できませんでした。`);
          continue;
        }
        runSql("DELETE FROM dialogue_placements WHERE id = ?", [row.id]);
        removed += 1;
      }
    }
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    throw error;
  }

  return { removed, skipped, warnings };
}
