/**
 * Book モードのページ CRUD とページ絞り込みの詳細取得。
 * ページは1プロジェクト内の「順序付きの独立した1枚生成コンテキスト」で、`generation_rounds.page_id`
 * でラウンド/アセットが各ページに紐づく。並び順は `page_index` の昇順(= 読書順)。
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { BookPages, PageDetail, PageRow, PageSummary, ProjectRow, RecentReferenceImage } from "../shared/apiTypes";
import type { GenerationRequest } from "../shared/types";
import type { Asset } from "../shared/apiTypes";
import { createId, dataRoot, getRow, getRows, runSql, toApiRow, toApiRows } from "./db";
import { HttpError } from "./http";
import { resolveLayoutTemplate } from "./layoutTemplates";
import { listPanelAssignments, upsertPanelAssignment } from "./panelAssignments";
import { isPathInside } from "./paths";
import { getProjectDetail } from "./projects";
import { deleteRoundTree, roundAttachmentPathFromRequest } from "./rounds";
import { discardRoundTrashSnapshot } from "./roundTrash";
import { createSourceAsset } from "./sourceAssets";
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

  // `pg.*` に含まれる layout_json は toApiRow が `layout`(parse 済み)へ変換する(db.ts の jsonColumnNames)。
  const pages = rows.map((row) => {
    const item = toApiRow(row)!;
    if (typeof item.representativeAssetId === "string") {
      const id = item.representativeAssetId;
      item.representativeThumbnailUrl = `/api/assets/${id}/thumbnail?size=small`;
      item.representativeImageUrl = `/api/assets/${id}/image`;
    }
    return item as unknown as PageSummary;
  });

  return { project, pages };
}

/**
 * 末尾に新規ページを追加する。`body.layoutTemplateId` があればコマ割りテンプレを解決して
 * `layout_json` に保存する(通常の空ページは NULL)。
 */
export function createPage(projectId: string, body?: unknown): PageRow {
  requireProject(projectId);
  const layoutJson = resolveLayoutJsonFromBody(body);
  const nextIndex =
    getRow<{ next_index: number }>(
      "SELECT COALESCE(MAX(page_index), -1) + 1 AS next_index FROM pages WHERE project_id = ?",
      [projectId]
    )?.next_index ?? 0;
  const id = createId("page");
  runSql("INSERT INTO pages (id, project_id, page_index, title, layout_json) VALUES (?, ?, ?, '', ?)", [
    id,
    projectId,
    nextIndex,
    layoutJson
  ]);
  runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [projectId]);
  return toApiRow(getRow("SELECT * FROM pages WHERE id = ?", [id])) as unknown as PageRow;
}

/** body から layoutTemplateId を解決し、保存する layout_json(未指定/未解決は null)を返す。 */
function resolveLayoutJsonFromBody(body: unknown): string | null {
  if (body === undefined || body === null) {
    return null;
  }
  const input = objectBody(body);
  const templateId = stringOr(input.layoutTemplateId ?? input.layout_template_id, "");
  if (!templateId) {
    return null;
  }
  const layout = resolveLayoutTemplate(templateId);
  if (!layout) {
    throw new HttpError(400, "指定されたコマ割りテンプレートが見つかりません。");
  }
  return JSON.stringify(layout);
}

/**
 * 画像を新規ページとして取り込む(複数インポートの1枚分)。空ページを作り、既存の source-asset
 * 経路(ファイルコピー、ComfyUI 不要)でその画像を代表アセットにする。ワークフローテンプレは
 * project の default、無ければ最初の非削除テンプレを流用する(生成はしないのでパラメータは既定値)。
 */
export async function importImageAsPage(projectId: string, body: unknown): Promise<{ page: PageRow; asset: Asset }> {
  requireProject(projectId);
  const input = objectBody(body);
  const templateId = pickImportTemplateId(projectId);
  const page = createPage(projectId);
  try {
    const result = await createSourceAsset(projectId, {
      templateId,
      dataUrl: input.dataUrl ?? input.data_url,
      filename: stringOr(input.filename, "imported"),
      pageId: page.id
    });
    return { page, asset: result.asset };
  } catch (error) {
    // 画像取り込みに失敗したら、作ったばかりの空ページを片付ける。
    runSql("DELETE FROM pages WHERE id = ? AND project_id = ?", [page.id, projectId]);
    throw error;
  }
}

/** 画像取り込みに使うワークフローテンプレ id(project default → 最初の非削除)。無ければ 400。 */
function pickImportTemplateId(projectId: string): string {
  const project = getRow<{ default_template_id: string | null }>(
    "SELECT default_template_id FROM projects WHERE id = ?",
    [projectId]
  );
  if (project?.default_template_id) {
    const ok = getRow("SELECT id FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [
      project.default_template_id
    ]);
    if (ok) {
      return project.default_template_id;
    }
  }
  const first = getRow<{ id: string }>(
    "SELECT id FROM workflow_templates WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1"
  );
  if (first) {
    return first.id;
  }
  throw new HttpError(400, "画像を取り込むにはワークフローテンプレートが必要です。先にテンプレートを登録してください。");
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

/** そのページの rounds/assets に絞った ProjectDetail + ページのメタ + コマ割り当て。 */
export function getPageDetail(projectId: string, pageId: string, options: PageDetailOptions = {}): PageDetail {
  const page = requirePage(projectId, pageId);
  const detail = getProjectDetail(projectId, options, pageId);
  const panelAssignments = page.layout ? listPanelAssignments(pageId) : [];
  return { ...detail, page, panelAssignments };
}

/** コマ内生成(Docs/Feature-PanelGeneration.md): コマへの画像割り当て/クロップを更新する。 */
export function updatePagePanelAssignment(projectId: string, pageId: string, panelId: string, body: unknown) {
  const page = requirePage(projectId, pageId);
  return upsertPanelAssignment(page, panelId, body);
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

/** 参照候補の走査上限(古い再試行が大量にあっても I/O を抑える)。 */
const RECENT_REFERENCE_SCAN_LIMIT = 40;
/** 重複排除後に採用する distinct 参照画像の上限(これ以上は古いので打ち切る)。 */
const RECENT_REFERENCE_DISTINCT_LIMIT = 12;
/** 混在させる生成画像の走査上限。 */
const RECENT_ASSET_SCAN_LIMIT = 30;
/** 内容シグネチャ計算で読む先頭バイト数(同一画像は完全一致、別画像は衝突しない)。 */
const REFERENCE_SIGNATURE_PREFIX_BYTES = 64 * 1024;

/**
 * 参照画像ファイルの内容シグネチャ(サイズ + 先頭数十KB の hash)。「最近使った画像」から
 * 再利用したり同じ顔で再試行したラウンドは参照ファイルがバイト一致するため、これで重複排除できる。
 * ファイルが読めない/dataRoot 外なら null(その候補はスキップ)。
 */
async function referenceContentSignature(imagePath: string): Promise<string | null> {
  const resolved = resolve(imagePath);
  if (!isPathInside(resolved, resolve(dataRoot))) {
    return null;
  }
  try {
    const handle = await open(resolved, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, REFERENCE_SIGNATURE_PREFIX_BYTES);
      const buffer = Buffer.alloc(length);
      if (length > 0) {
        await handle.read(buffer, 0, length, 0);
      }
      return `${stat.size}:${createHash("sha1").update(buffer).digest("hex")}`;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** createdAt 降順でマージし `limit` 件に切る純関数(重複排除は呼び出し側で済ませておく)。 */
export function mergeRecentImages(
  references: RecentReferenceImage[],
  assets: RecentReferenceImage[],
  limit: number
): RecentReferenceImage[] {
  return [...references, ...assets]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, Math.max(0, limit));
}

/**
 * 「最近使った画像」。過去に使った顔参照画像(内容で重複排除)と生成画像を新しい順で混在させて返す。
 * Book のページ間で同じキャラ顔や過去の生成物を1クリックで再利用する用途。
 */
export async function listRecentImages(projectId: string, limit = 24): Promise<RecentReferenceImage[]> {
  // --- 参照画像: 新しい順ラウンドを走査し、内容シグネチャで重複排除して最新の1件だけ残す ---
  const roundRows = getRows<{ id: string; request_json: string; created_at: string }>(
    "SELECT id, request_json, created_at FROM generation_rounds WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
    [projectId, RECENT_REFERENCE_SCAN_LIMIT]
  );
  const references: RecentReferenceImage[] = [];
  const seenSignatures = new Set<string>();
  for (const row of roundRows) {
    if (references.length >= RECENT_REFERENCE_DISTINCT_LIMIT) {
      break;
    }
    let request: GenerationRequest;
    try {
      request = JSON.parse(row.request_json) as GenerationRequest;
    } catch {
      continue;
    }
    const imagePath = roundAttachmentPathFromRequest(request, "reference");
    if (!imagePath) {
      continue;
    }
    const signature = await referenceContentSignature(imagePath);
    if (!signature || seenSignatures.has(signature)) {
      continue;
    }
    seenSignatures.add(signature);
    const url = `/api/rounds/${row.id}/attachments/reference`;
    references.push({ kind: "reference", url, thumbnailUrl: url, createdAt: String(row.created_at) });
  }

  // --- 生成画像: 却下以外の新しい順アセット(サムネ表示・クリックでフル画像を参照採用) ---
  const assetRows = getRows<{ id: string; created_at: string }>(
    "SELECT id, created_at FROM assets WHERE project_id = ? AND status != 'rejected' ORDER BY created_at DESC LIMIT ?",
    [projectId, RECENT_ASSET_SCAN_LIMIT]
  );
  const assets: RecentReferenceImage[] = assetRows.map((row) => ({
    kind: "asset",
    url: `/api/assets/${row.id}/image`,
    thumbnailUrl: `/api/assets/${row.id}/thumbnail?size=small`,
    createdAt: String(row.created_at)
  }));

  return mergeRecentImages(references, assets, limit);
}
