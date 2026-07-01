import type { ServerResponse } from "node:http";
import type { AssetStatus, SelectionAction } from "../shared/types";
import { createId, getRow, runSql, toApiRow } from "./db";
import { streamFile } from "./files";
import { HttpError, sendJson } from "./http";
import { objectBody, requiredString, stringOrNull } from "./validate";

export function updateAssetStatus(assetId: string, body: unknown) {
  const input = objectBody(body);
  const status = requiredString(input.status, "status") as AssetStatus;
  if (!["generated", "selected", "rejected", "favorite", "archived"].includes(status)) {
    throw new HttpError(400, "Unsupported Asset status");
  }

  const asset = getRow<Record<string, unknown>>("SELECT * FROM assets WHERE id = ?", [assetId]);
  if (!asset) {
    throw new HttpError(404, "Asset was not found");
  }

  runSql("UPDATE assets SET status = ? WHERE id = ?", [status, assetId]);
  runSql("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [asset.project_id]);

  const action = selectionActionFor(status, String(asset.status));
  if (action) {
    runSql(
      `INSERT INTO selection_events (id, project_id, round_id, asset_id, action, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [createId("selection"), asset.project_id, asset.round_id, assetId, action, stringOrNull(input.note)]
    );
  }

  return {
    asset: decorateAsset(toApiRow(getRow("SELECT * FROM assets WHERE id = ?", [assetId]))!)
  };
}

export async function serveAssetFile(res: ServerResponse, assetId: string, kind: string, url: URL) {
  const asset = getRow<Record<string, unknown>>("SELECT * FROM assets WHERE id = ?", [assetId]);
  if (!asset) {
    sendJson(res, 404, { error: "Asset was not found" });
    return;
  }

  const size = url.searchParams.get("size") === "medium" ? "medium" : "small";
  const path = kind === "image"
    ? String(asset.image_path)
    : size === "medium"
      ? String(asset.thumbnail_medium_path)
      : String(asset.thumbnail_small_path);

  streamFile(res, path);
}

export function decorateAsset(asset: Record<string, unknown>) {
  return {
    ...asset,
    imageUrl: `/api/assets/${asset.id}/image`,
    thumbnailUrl: `/api/assets/${asset.id}/thumbnail?size=small`,
    thumbnailMediumUrl: `/api/assets/${asset.id}/thumbnail?size=medium`
  };
}

function selectionActionFor(newStatus: string, previousStatus: string): SelectionAction | null {
  if (newStatus === "selected") {
    return "select";
  }
  if (newStatus === "rejected") {
    return "reject";
  }
  if (newStatus === "favorite") {
    return "favorite";
  }
  if (previousStatus === "selected") {
    return "unselect";
  }
  if (previousStatus === "rejected") {
    return "unreject";
  }
  if (previousStatus === "favorite") {
    return "unfavorite";
  }
  return null;
}
