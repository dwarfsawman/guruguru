/**
 * 画像貼り付け(Paste & Transform)のサーバ永続化 API。
 *
 * - paste-sources: 貼り付け元画像(添付ソース)のアップロードと配信。
 *   `POST /api/projects/:projectId/paste-sources` / `GET /api/projects/:projectId/paste-sources/:sourceId`
 * - paste-attachments: アセットに紐づく貼り付けオブジェクト(配置つき)の取得/保存。
 *   `GET /api/assets/:assetId/paste-attachments` / `PUT /api/assets/:assetId/paste-attachments`
 *
 * 貼り付けは元画像アセットを一切変更しない「エッジに添付」モデル
 * (Docs/Feature-ImagePaste.md)。ソースファイルの GC は初期スコープ外 —
 * 過去ラウンドの request_json(pasteComposite.objects)が sourceId を参照し続けるため、
 * 参照ゼロ判定なしに消してはならない。
 */
import type { ServerResponse } from "node:http";
import { createId, getRow, runSql } from "./db";
import { HttpError, sendJson } from "./http";
import { objectBody } from "./validate";
import { decodeImageDataUrl } from "./uploadDataUrl";
import { storePasteSourceImage } from "./storage";
import { streamFile } from "./files";
import { pastedObjectsValidationError, sanitizePastedObjects, type PastedObject } from "../shared/pasteAttachments";

/** MIME → 保存拡張子。`decodeImageDataUrl` が許容する 3 種のみ。 */
export function pasteSourceExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  return ".png";
}

export function pasteSourceUrl(projectId: string, sourceId: string): string {
  return `/api/projects/${projectId}/paste-sources/${sourceId}`;
}

export async function createPasteSource(projectId: string, body: unknown) {
  const input = objectBody(body);
  const project = getRow<{ id: string }>("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }

  const { mimeType, bytes } = decodeImageDataUrl(input.dataUrl);
  const sourceId = createId("pastesrc");
  const stored = await storePasteSourceImage(projectId, sourceId, pasteSourceExtension(mimeType), bytes);

  runSql(
    `INSERT INTO paste_sources (id, project_id, file_path, mime_type, width, height)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sourceId, projectId, stored.filePath, mimeType, stored.width, stored.height]
  );

  return {
    sourceId,
    url: pasteSourceUrl(projectId, sourceId),
    width: stored.width,
    height: stored.height
  };
}

export function servePasteSource(res: ServerResponse, projectId: string, sourceId: string) {
  const row = getRow<{ file_path: string }>(
    "SELECT file_path FROM paste_sources WHERE id = ? AND project_id = ?",
    [sourceId, projectId]
  );
  if (!row) {
    sendJson(res, 404, { error: "Paste source was not found" });
    return;
  }
  streamFile(res, String(row.file_path));
}

export function getPasteAttachments(assetId: string) {
  const asset = getRow<{ id: string }>("SELECT id FROM assets WHERE id = ?", [assetId]);
  if (!asset) {
    throw new HttpError(404, "Asset was not found");
  }
  const row = getRow<{ objects_json: string }>(
    "SELECT objects_json FROM asset_paste_attachments WHERE asset_id = ?",
    [assetId]
  );
  if (!row) {
    return { objects: [] as PastedObject[] };
  }
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(row.objects_json);
  } catch {
    // 破損した JSON は空扱い(次の PUT で上書きされる)。
  }
  return { objects: sanitizePastedObjects(parsed) };
}

export function putPasteAttachments(assetId: string, body: unknown) {
  const input = objectBody(body);
  const asset = getRow<{ id: string; project_id: string }>("SELECT id, project_id FROM assets WHERE id = ?", [assetId]);
  if (!asset) {
    throw new HttpError(404, "Asset was not found");
  }

  const validationError = pastedObjectsValidationError(input.objects);
  if (validationError) {
    throw new HttpError(400, validationError);
  }
  const objects = sanitizePastedObjects(input.objects);

  const missingSourceId = findMissingSourceId(objects, String(asset.project_id));
  if (missingSourceId) {
    throw new HttpError(400, `Paste source '${missingSourceId}' was not found in this project.`);
  }

  runSql(
    `INSERT INTO asset_paste_attachments (asset_id, objects_json, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(asset_id) DO UPDATE SET objects_json = excluded.objects_json, updated_at = CURRENT_TIMESTAMP`,
    [assetId, JSON.stringify(objects)]
  );

  return { objects };
}

function findMissingSourceId(objects: ReadonlyArray<PastedObject>, projectId: string): string | null {
  const uniqueSourceIds = [...new Set(objects.map((object) => object.sourceId))];
  for (const sourceId of uniqueSourceIds) {
    const row = getRow<{ id: string }>(
      "SELECT id FROM paste_sources WHERE id = ? AND project_id = ?",
      [sourceId, projectId]
    );
    if (!row) {
      return sourceId;
    }
  }
  return null;
}
