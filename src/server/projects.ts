import type { AssetParent, ProjectDetail, ProjectRow, ProjectSummary, Round } from "../shared/apiTypes";
import { createId, getRow, getRows, runSql, toApiRow, toApiRows } from "./db";
import { decorateAsset } from "./assets";
import { HttpError } from "./http";
import { deleteProjectStorage, ensureProjectStorage } from "./storage";
import { listTemplates } from "./templates";
import { objectBody, requiredString, stringOr, stringOrNull } from "./validate";
import { sanitizePastedObjects, type PastedObject } from "../shared/pasteAttachments";

type ProjectDetailOptions = {
  ensureRoundMonitor?: (roundId: string) => void;
};

export function listProjects(): ProjectSummary[] {
  const rows = getRows<Record<string, unknown>>(
    `SELECT
       p.*,
       (SELECT COUNT(*) FROM generation_rounds r WHERE r.project_id = p.id) AS round_count,
       (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id) AS asset_count,
       (SELECT COUNT(*) FROM pages pg WHERE pg.project_id = p.id) AS page_count,
       (SELECT a.id FROM assets a WHERE a.project_id = p.id AND a.status IN ('selected', 'favorite') ORDER BY a.created_at DESC LIMIT 1) AS representative_asset_id
     FROM projects p
     ORDER BY p.updated_at DESC`
  );

  return rows.map((row) => {
    const item = toApiRow(row)!;
    if (typeof item.representativeAssetId === "string") {
      item.representativeThumbnailUrl = `/api/assets/${item.representativeAssetId}/thumbnail?size=small`;
    }
    return item as unknown as ProjectSummary;
  });
}

export function createProject(body: unknown): ProjectRow | null {
  const input = objectBody(body);
  const id = createId("project");
  const name = requiredString(input.name, "name");
  const description = stringOr(input.description, "");
  const mode = input.mode === "book" ? "book" : "single";
  const defaultTemplateId = stringOrNull(input.defaultTemplateId ?? input.default_template_id);
  if (defaultTemplateId) {
    const template = getRow("SELECT id FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [defaultTemplateId]);
    if (!template) {
      throw new HttpError(400, "Default WorkflowTemplate was not found");
    }
  }
  const storage = ensureProjectStorage(id);

  runSql(
    `INSERT INTO projects (id, name, description, mode, default_template_id, storage_dir)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, description, mode, defaultTemplateId, storage.projectRoot]
  );

  // Book はページを1件以上持つ前提。作成直後から使えるよう初期ページ(#01)を1枚用意する。
  if (mode === "book") {
    runSql(
      "INSERT INTO pages (id, project_id, page_index, title) VALUES (?, ?, 0, '')",
      [createId("page"), id]
    );
  }

  return toApiRow(getRow("SELECT * FROM projects WHERE id = ?", [id])) as unknown as ProjectRow | null;
}

export async function deleteProject(projectId: string) {
  const project = getRow<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }

  runSql("UPDATE generation_rounds SET parent_round_id = NULL WHERE project_id = ?", [projectId]);
  runSql("DELETE FROM projects WHERE id = ?", [projectId]);

  let storageDeleted = false;
  let storageError: string | undefined;
  if (typeof project.storage_dir === "string" && project.storage_dir.trim()) {
    try {
      await deleteProjectStorage(project.storage_dir);
      storageDeleted = true;
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    deleted: true,
    projectId,
    storageDeleted,
    storageError
  };
}

/**
 * `pageId` を渡すとそのページの rounds/assets だけに絞り込む(Book モード)。渡さない(single)
 * 場合は page_id が NULL のラウンド = 従来の1枚生成分だけを返す。round/asset id は全体一意なので
 * クライアントの reconciliation はページ絞りでもそのまま機能する(監査済み)。
 */
export function getProjectDetail(
  projectId: string,
  options: ProjectDetailOptions = {},
  pageId?: string | null
): ProjectDetail {
  const project = toApiRow(getRow("SELECT * FROM projects WHERE id = ?", [projectId])) as unknown as ProjectRow | null;
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }

  // ページ絞り込み句。pageId 有り=そのページ、無し=page_id IS NULL(single 相当)。
  const pageFilterAliased = pageId ? "r.page_id = ?" : "r.page_id IS NULL";
  const roundParams = pageId ? [projectId, pageId] : [projectId];
  // assets/parents/pasteAttachments は round 経由でページに絞る(assets に page_id 列は無い)。
  const pageFilterBare = pageId ? "page_id = ?" : "page_id IS NULL";
  const scopeParams = pageId ? [projectId, projectId, pageId] : [projectId, projectId];
  const roundScopeSubquery = `round_id IN (SELECT id FROM generation_rounds WHERE project_id = ? AND ${pageFilterBare})`;

  const rounds = toApiRows(
    getRows(
      `SELECT r.*,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id) AS asset_count,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id AND a.status = 'selected') AS selected_count,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id AND a.status = 'rejected') AS rejected_count
       FROM generation_rounds r
       WHERE r.project_id = ? AND ${pageFilterAliased}
       ORDER BY r.round_index DESC`,
      roundParams
    )
  ) as unknown as Round[];

  const assets = toApiRows(
    getRows(
      `SELECT * FROM assets WHERE project_id = ? AND ${roundScopeSubquery} ORDER BY round_id ASC, batch_index ASC`,
      scopeParams
    )
  ).map(decorateAsset);

  const parents = toApiRows(
    getRows(
      `SELECT ap.*
       FROM asset_parents ap
       JOIN assets child ON child.id = ap.child_asset_id
       WHERE child.project_id = ? AND child.${roundScopeSubquery}
       ORDER BY ap.created_at ASC`,
      scopeParams
    )
  ) as unknown as AssetParent[];

  for (const round of rounds) {
    if ((round.status === "running" || round.status === "pending") && typeof round.id === "string") {
      options.ensureRoundMonitor?.(round.id);
    }
  }

  // グリッドのプレビュー合成/PASTE バッジ用に、貼り付け添付を assetId → { objects, enabled } で同梱する。
  const pasteAttachments: Record<string, { objects: PastedObject[]; enabled: boolean }> = {};
  const attachmentRows = getRows<{ asset_id: string; objects_json: string; enabled: number }>(
    `SELECT apa.asset_id, apa.objects_json, apa.enabled
     FROM asset_paste_attachments apa
     JOIN assets a ON a.id = apa.asset_id
     WHERE a.project_id = ? AND a.${roundScopeSubquery}`,
    scopeParams
  );
  for (const row of attachmentRows) {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(String(row.objects_json));
    } catch {
      // 破損した JSON は空扱い(getPasteAttachments と同じ縮退)。
    }
    const objects = sanitizePastedObjects(parsed);
    if (objects.length > 0) {
      pasteAttachments[String(row.asset_id)] = { objects, enabled: row.enabled !== 0 };
    }
  }

  return {
    project,
    rounds,
    assets,
    assetParents: parents,
    templates: listTemplates(),
    pasteAttachments
  };
}
