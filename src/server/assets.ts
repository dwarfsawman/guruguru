import type { ServerResponse } from "node:http";
import type { Asset } from "../shared/apiTypes";
import type { AssetStatus, SelectionAction } from "../shared/types";
import { createId, getRow, runSql, toApiRow } from "./db";
import { streamFile } from "./files";
import { HttpError, sendJson } from "./http";
import { autoAssignPanelForSelectedAsset } from "./panelAssignments";
import { ensureAssetThumbnail } from "./storage";
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

  // コマ内生成(Docs/Feature-PanelGeneration.md): 「選択」にした画像は、その生成が特定コマ向け
  // (target_panel_id)なら自動でそのコマへ割り当てる。
  if (status === "selected") {
    autoAssignPanelForSelectedAsset(assetId, String(asset.round_id));
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
  const imagePath = String(asset.image_path);
  let path = kind === "image"
    ? imagePath
    : size === "medium"
      ? String(asset.thumbnail_medium_path)
      : String(asset.thumbnail_small_path);

  if (kind !== "image") {
    try {
      path = await ensureAssetThumbnail(imagePath, path, size);
    } catch (error) {
      // 原本が読めない場合も、既存サムネイルが残っていれば従来どおり配信を試みる。
      console.warn(`[assets] thumbnail repair failed for asset=${assetId}:`, error);
    }
  }

  res.setHeader("cache-control", "private, max-age=31536000, immutable");
  streamFile(res, path);
}

export function decorateAsset(asset: Record<string, unknown>): Asset {
  return {
    ...asset,
    imageUrl: `/api/assets/${asset.id}/image`,
    thumbnailUrl: `/api/assets/${asset.id}/thumbnail?size=small`,
    thumbnailMediumUrl: `/api/assets/${asset.id}/thumbnail?size=medium`
  } as unknown as Asset;
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
