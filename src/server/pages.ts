/**
 * Book モードのページ CRUD とページ絞り込みの詳細取得。
 * ページは1プロジェクト内の「順序付きの独立した1枚生成コンテキスト」で、`generation_rounds.page_id`
 * でラウンド/アセットが各ページに紐づく。並び順は `page_index` の昇順(= 読書順)。
 */
import type { BookPages, PageDetail, PageRow, PageSummary, ProjectRow, RecentReferenceImage } from "../shared/apiTypes";
import type { GenerationRequest } from "../shared/types";
import { createId, getRow, getRows, runSql, toApiRow, toApiRows } from "./db";
import { HttpError } from "./http";
import { getProjectDetail } from "./projects";
import { deleteRoundTree, roundAttachmentPathFromRequest } from "./rounds";
import { discardRoundTrashSnapshot } from "./roundTrash";
import { objectBody, stringOr } from "./validate";

type PageDetailOptions = {
  ensureRoundMonitor?: (roundId: string) => void;
};

function requireProject(projectId: string): ProjectRow {
  const project = toApiRow(getRow("SELECT * FROM projects WHERE id = ?", [projectId])) as unknown as ProjectRow | null;
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
  return project;
}

function requirePage(projectId: string, pageId: string): PageRow {
  const page = toApiRow(
    getRow("SELECT * FROM pages WHERE id = ? AND project_id = ?", [pageId, projectId])
  ) as unknown as PageRow | null;
  if (!page) {
    throw new HttpError(404, "Page was not found");
  }
  return page;
}

/** ページ一覧(代表サムネ+アセット枚数付き)と、所属プロジェクトのメタを返す。 */
export function listPagesWithProject(projectId: string): BookPages {
  const project = requireProject(projectId);

  const rows = getRows<Record<string, unknown>>(
    `SELECT
       pg.*,
       (SELECT COUNT(*) FROM assets a JOIN generation_rounds r ON r.id = a.round_id WHERE r.page_id = pg.id) AS asset_count,
       COALESCE(
         (SELECT a.id FROM assets a JOIN generation_rounds r ON r.id = a.round_id
           WHERE r.page_id = pg.id AND a.status IN ('selected', 'favorite') ORDER BY a.created_at DESC LIMIT 1),
         (SELECT a.id FROM assets a JOIN generation_rounds r ON r.id = a.round_id
           WHERE r.page_id = pg.id ORDER BY a.created_at DESC LIMIT 1)
       ) AS representative_asset_id
     FROM pages pg
     WHERE pg.project_id = ?
     ORDER BY pg.page_index ASC`,
    [projectId]
  );

  const pages = rows.map((row) => {
    const item = toApiRow(row)!;
    if (typeof item.representativeAssetId === "string") {
      item.representativeThumbnailUrl = `/api/assets/${item.representativeAssetId}/thumbnail?size=small`;
    }
    return item as unknown as PageSummary;
  });

  return { project, pages };
}

/** 末尾に新規ページを追加する。 */
export function createPage(projectId: string): PageRow {
  requireProject(projectId);
  const nextIndex =
    getRow<{ next_index: number }>(
      "SELECT COALESCE(MAX(page_index), -1) + 1 AS next_index FROM pages WHERE project_id = ?",
      [projectId]
    )?.next_index ?? 0;
  const id = createId("page");
  runSql("INSERT INTO pages (id, project_id, page_index, title) VALUES (?, ?, ?, '')", [id, projectId, nextIndex]);
  runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [projectId]);
  return toApiRow(getRow("SELECT * FROM pages WHERE id = ?", [id])) as unknown as PageRow;
}

/** ページのタイトルを更新する。 */
export function updatePage(projectId: string, pageId: string, body: unknown): PageRow {
  requirePage(projectId, pageId);
  const input = objectBody(body);
  const title = stringOr(input.title, "");
  runSql(
    "UPDATE pages SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?",
    [title, pageId, projectId]
  );
  return toApiRow(getRow("SELECT * FROM pages WHERE id = ?", [pageId])) as unknown as PageRow;
}

/** ドラッグ並び替えの確定。`orderedIds` の並び順で page_index を 0..N-1 に振り直す。 */
export function reorderPages(projectId: string, body: unknown): BookPages {
  requireProject(projectId);
  const input = objectBody(body);
  const rawIds = Array.isArray(input.orderedIds) ? input.orderedIds : [];
  const orderedIds = rawIds.filter((id): id is string => typeof id === "string");

  const existing = getRows<{ id: string }>("SELECT id FROM pages WHERE project_id = ?", [projectId]).map((row) => row.id);
  const existingSet = new Set(existing);
  for (const id of orderedIds) {
    if (!existingSet.has(id)) {
      throw new HttpError(400, "orderedIds contains a page that does not belong to this project");
    }
  }

  // orderedIds に含まれないページ(理論上は起きない)は末尾へ回して index の欠番を防ぐ。
  const seen = new Set(orderedIds);
  const finalOrder = [...orderedIds, ...existing.filter((id) => !seen.has(id))];

  runSql("BEGIN");
  try {
    finalOrder.forEach((id, index) => {
      runSql("UPDATE pages SET page_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?", [
        index,
        id,
        projectId
      ]);
    });
    runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [projectId]);
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    throw error;
  }

  return listPagesWithProject(projectId);
}

/** そのページの rounds/assets に絞った ProjectDetail + ページのメタ。 */
export function getPageDetail(projectId: string, pageId: string, options: PageDetailOptions = {}): PageDetail {
  const page = requirePage(projectId, pageId);
  const detail = getProjectDetail(projectId, options, pageId);
  return { ...detail, page };
}

/**
 * ページ削除。ページの root ラウンドごとに既存の `deleteRoundTree`(ゴミ箱スナップショット→サブツリー削除)を
 * 呼び、直後に `discardRoundTrashSnapshot` で画像ファイルも即削除する(復元不要)。残ラウンドは念のため直接掃除。
 * mask/pose/reference 等の添付ファイルの残置は既存の round 削除と同じ挙動(範囲外)。
 */
export function deletePage(projectId: string, pageId: string) {
  requirePage(projectId, pageId);

  const rootRounds = getRows<{ id: string }>(
    "SELECT id FROM generation_rounds WHERE project_id = ? AND page_id = ? AND parent_round_id IS NULL",
    [projectId, pageId]
  );
  for (const root of rootRounds) {
    deleteRoundTree(root.id);
    try {
      discardRoundTrashSnapshot(root.id);
    } catch {
      // ファイル掃除はベストエフォート。残骸はサーバ再起動時の全パージで消える。
    }
  }

  // 念のため(cross-page 親などで root から辿れない残ラウンドがあれば)DB からも掃除する。
  runSql("UPDATE generation_rounds SET parent_round_id = NULL WHERE page_id = ?", [pageId]);
  runSql("DELETE FROM generation_rounds WHERE page_id = ?", [pageId]);
  runSql("DELETE FROM pages WHERE id = ? AND project_id = ?", [pageId, projectId]);
  runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [projectId]);

  return { deleted: true, pageId };
}

/**
 * 「最近使った参照画像」。プロジェクトの新しい順のラウンドから request_json に reference.imagePath を
 * 持つものを拾い、最大 `limit` 件返す。顔スタイル参照(PuLID)の再利用ピッカー用。
 */
export function listRecentReferenceImages(projectId: string, limit = 12): RecentReferenceImage[] {
  const rows = getRows<{ id: string; request_json: string; created_at: string }>(
    "SELECT id, request_json, created_at FROM generation_rounds WHERE project_id = ? ORDER BY created_at DESC LIMIT 60",
    [projectId]
  );
  const out: RecentReferenceImage[] = [];
  for (const row of rows) {
    if (out.length >= limit) {
      break;
    }
    let request: GenerationRequest;
    try {
      request = JSON.parse(row.request_json) as GenerationRequest;
    } catch {
      continue;
    }
    if (!roundAttachmentPathFromRequest(request, "reference")) {
      continue;
    }
    out.push({
      roundId: row.id,
      url: `/api/rounds/${row.id}/attachments/reference`,
      createdAt: String(row.created_at)
    });
  }
  return out;
}
