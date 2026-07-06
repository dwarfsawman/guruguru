/**
 * 画像貼り付け(Paste & Transform)のサーバ永続化 API。
 *
 * - paste-sources: 貼り付け元画像(添付ソース)のアップロードと配信。
 *   `POST /api/projects/:projectId/paste-sources` / `GET /api/projects/:projectId/paste-sources/:sourceId`
 * - paste-attachments: アセットに紐づく貼り付けオブジェクト(配置つき)の取得/保存。
 *   `GET /api/assets/:assetId/paste-attachments` / `PUT /api/assets/:assetId/paste-attachments`
 *
 * 貼り付けは元画像アセットを一切変更しない「エッジに添付」モデル
 * (Docs/Feature-ImagePaste.md)。
 *
 * ソースファイルの掃除(GC)はサーバ起動時のみ行う(`purgeOrphanPasteSources`、
 * `purgeAllRoundTrash` と同じ起動時パージの流儀)。オブジェクト削除の瞬間に消さないのは
 * (1) 削除は Ctrl+Z で取り消せる(統合 undo)、(2) 過去ラウンドの request_json
 * (pasteComposite.objects)が sourceId を参照し続ける(エッジポップアウトの添付表示)ため。
 * 起動時なら undo 履歴を持つクライアントは存在せず、「現在の添付 ∪ 全ラウンド履歴」の
 * どこからも参照されないファイルだけを安全に消せる。
 */
import type { ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { createId, dataRoot, getRow, getRows, runSql } from "./db";
import { HttpError, sendJson } from "./http";
import { objectBody } from "./validate";
import { decodeImageDataUrl } from "./uploadDataUrl";
import { storePasteSourceImage } from "./storage";
import { streamFile } from "./files";
import { isPathInside } from "./paths";
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

/**
 * JSON 値から参照されている sourceId 群を集める(pure、テスト対象)。
 * - `asset_paste_attachments.objects_json`: `PastedObject[]`
 * - `generation_rounds.request_json`: `GenerationRequest`(`pasteComposite.objects`)
 * 破損 JSON や想定外の形は空として扱う(掃除をブロックしない)。
 */
export function collectPasteSourceIds(parsed: unknown): string[] {
  const objects = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? (parsed as { pasteComposite?: { objects?: unknown } }).pasteComposite?.objects
      : null;
  if (!Array.isArray(objects)) {
    return [];
  }
  const sourceIds: string[] = [];
  for (const entry of objects) {
    const sourceId = typeof entry === "object" && entry !== null ? (entry as { sourceId?: unknown }).sourceId : null;
    if (typeof sourceId === "string" && sourceId.trim() !== "") {
      sourceIds.push(sourceId);
    }
  }
  return sourceIds;
}

/**
 * どこからも参照されていない貼り付けソースファイル+DB 行を削除する(サーバ起動時のみ)。
 * 参照元 = 現在の添付(asset_paste_attachments)∪ 全ラウンドの request_json。
 * ラウンド削除で request_json ごと参照が消えるため、次回起動時にその分も回収される。
 */
export function purgeOrphanPasteSources(): number {
  const referenced = new Set<string>();
  const collect = (jsonText: unknown) => {
    try {
      for (const sourceId of collectPasteSourceIds(JSON.parse(String(jsonText)))) {
        referenced.add(sourceId);
      }
    } catch {
      // JSON はすべてサーバが書いたものなので破損は実質発生しない。万一の破損行は無視する。
    }
  };
  for (const row of getRows<{ objects_json: string }>("SELECT objects_json FROM asset_paste_attachments")) {
    collect(row.objects_json);
  }
  for (const row of getRows<{ request_json: string }>("SELECT request_json FROM generation_rounds")) {
    collect(row.request_json);
  }

  let purged = 0;
  for (const row of getRows<{ id: string; file_path: string }>("SELECT id, file_path FROM paste_sources")) {
    if (referenced.has(row.id)) {
      continue;
    }
    const resolved = resolve(String(row.file_path));
    if (isPathInside(resolved, dataRoot)) {
      try {
        rmSync(resolved, { force: true });
      } catch {
        // ファイル削除に失敗しても DB 行は消さず、次回起動時に再試行する。
        continue;
      }
    }
    runSql("DELETE FROM paste_sources WHERE id = ?", [row.id]);
    purged += 1;
  }
  return purged;
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
