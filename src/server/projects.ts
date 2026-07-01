import type { AssetParent, ProjectDetail, ProjectRow, ProjectSummary, Round } from "../shared/apiTypes";
import { createId, getRow, getRows, runSql, toApiRow, toApiRows } from "./db";
import { decorateAsset } from "./assets";
import { HttpError } from "./http";
import { deleteProjectStorage, ensureProjectStorage } from "./storage";
import { listTemplates } from "./templates";
import { objectBody, requiredString, stringOr, stringOrNull } from "./validate";

type ProjectDetailOptions = {
  ensureRoundMonitor?: (roundId: string) => void;
};

export function listProjects(): ProjectSummary[] {
  const rows = getRows<Record<string, unknown>>(
    `SELECT
       p.*,
       (SELECT COUNT(*) FROM generation_rounds r WHERE r.project_id = p.id) AS round_count,
       (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id) AS asset_count,
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
  const defaultTemplateId = stringOrNull(input.defaultTemplateId ?? input.default_template_id);
  if (defaultTemplateId) {
    const template = getRow("SELECT id FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [defaultTemplateId]);
    if (!template) {
      throw new HttpError(400, "Default WorkflowTemplate was not found");
    }
  }
  const storage = ensureProjectStorage(id);

  runSql(
    `INSERT INTO projects (id, name, description, default_template_id, storage_dir)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, description, defaultTemplateId, storage.projectRoot]
  );

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

export function getProjectDetail(projectId: string, options: ProjectDetailOptions = {}): ProjectDetail {
  const project = toApiRow(getRow("SELECT * FROM projects WHERE id = ?", [projectId])) as unknown as ProjectRow | null;
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }

  const rounds = toApiRows(
    getRows(
      `SELECT r.*,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id) AS asset_count,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id AND a.status = 'selected') AS selected_count,
        (SELECT COUNT(*) FROM assets a WHERE a.round_id = r.id AND a.status = 'rejected') AS rejected_count
       FROM generation_rounds r
       WHERE r.project_id = ?
       ORDER BY r.round_index DESC`,
      [projectId]
    )
  ) as unknown as Round[];

  const assets = toApiRows(
    getRows("SELECT * FROM assets WHERE project_id = ? ORDER BY round_id ASC, batch_index ASC", [projectId])
  ).map(decorateAsset);

  const parents = toApiRows(
    getRows(
      `SELECT ap.*
       FROM asset_parents ap
       JOIN assets child ON child.id = ap.child_asset_id
       WHERE child.project_id = ?
       ORDER BY ap.created_at ASC`,
      [projectId]
    )
  ) as unknown as AssetParent[];

  for (const round of rounds) {
    if ((round.status === "running" || round.status === "pending") && typeof round.id === "string") {
      options.ensureRoundMonitor?.(round.id);
    }
  }

  return {
    project,
    rounds,
    assets,
    assetParents: parents,
    templates: listTemplates()
  };
}
