/**
 * page_media(Docs/Feature-ScriptToManga.md S2): ImageObject が参照する page 所有メディア。
 * 配置時に元 Asset のファイルをコピーする方式で、Round/Asset 削除で ImageObject が孤児化する
 * (Asset 寿命問題)のを避ける。来歴(どの生成から来たか)は source_asset_id で追える。
 */
import { existsSync, unlinkSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { PageObject } from "../shared/pageObjects";
import { createId, dataRoot, getRow, runSql } from "./db";
import { streamFile } from "./files";
import { HttpError } from "./http";
import { isPathInside } from "./paths";
import { storePageMediaBuffer, storePageMediaImage } from "./storage";
import { objectBody, requiredString } from "./validate";

interface AssetImageRow {
  id: string;
  image_path: string;
  width: number | null;
  height: number | null;
}

export interface CreatePageMediaResult {
  mediaId: string;
  width: number | null;
  height: number | null;
  url: string;
}

/**
 * `POST /api/projects/:id/page-media { assetId }`: そのプロジェクトの Asset 画像を
 * `page_media` へコピーし、以後 ImageObject から参照できる `mediaId` を返す。
 */
export async function createPageMedia(projectId: string, body: unknown): Promise<CreatePageMediaResult> {
  const project = getRow("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
  const input = objectBody(body);
  const assetId = requiredString(input.assetId, "assetId");
  const asset = getRow<AssetImageRow>(
    "SELECT id, image_path, width, height FROM assets WHERE id = ? AND project_id = ?",
    [assetId, projectId]
  );
  if (!asset) {
    throw new HttpError(404, "Asset was not found");
  }

  const mediaId = createId("media");
  const stored = await storePageMediaImage(projectId, mediaId, asset.image_path);
  runSql(
    `INSERT INTO page_media (id, project_id, file_path, width, height, source_asset_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [mediaId, projectId, stored.filePath, stored.width, stored.height, assetId]
  );

  return { mediaId, width: stored.width, height: stored.height, url: `/api/page-media/${mediaId}` };
}

/**
 * 加工済みバイト列(ぶち抜き立ち絵の切り抜き PNG 等)を page_media として登録する
 * (Docs/Feature-MangaCompositions.md)。来歴は `source_asset_id` で追える。
 */
export async function createPageMediaFromBuffer(
  projectId: string,
  bytes: Buffer,
  sourceAssetId: string | null
): Promise<CreatePageMediaResult> {
  const mediaId = createId("media");
  const stored = await storePageMediaBuffer(projectId, mediaId, bytes, ".png");
  runSql(
    `INSERT INTO page_media (id, project_id, file_path, width, height, source_asset_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [mediaId, projectId, stored.filePath, stored.width, stored.height, sourceAssetId]
  );
  return { mediaId, width: stored.width, height: stored.height, url: `/api/page-media/${mediaId}` };
}

/**
 * page_media の行とファイルを削除する(ぶち抜き立ち絵の差し替え時、旧切り抜きの掃除に使う)。
 * ファイル欠損・data root 外は行削除だけ行い黙って続行する(表示側は missing 扱いで安全)。
 */
export function deletePageMedia(mediaId: string): void {
  const row = getRow<{ file_path: string }>("SELECT file_path FROM page_media WHERE id = ?", [mediaId]);
  if (row) {
    const resolved = resolve(row.file_path);
    if (isPathInside(resolved, resolve(dataRoot)) && existsSync(resolved)) {
      try {
        unlinkSync(resolved);
      } catch {
        // 使用中などで消せなくても行削除は行う(孤児ファイルは無害)。
      }
    }
  }
  runSql("DELETE FROM page_media WHERE id = ?", [mediaId]);
}

function resolvePageMediaPath(mediaId: string): string {
  const row = getRow<{ file_path: string }>("SELECT file_path FROM page_media WHERE id = ?", [mediaId]);
  if (!row) {
    throw new HttpError(404, "Page media was not found");
  }
  const resolved = resolve(row.file_path);
  if (!isPathInside(resolved, resolve(dataRoot))) {
    throw new HttpError(404, "Page media was not found");
  }
  return resolved;
}

/** `GET /api/page-media/:id`(streamFile、serveRoundAttachment と同型の isPathInside ガード)。 */
export function servePageMedia(res: ServerResponse, mediaId: string) {
  streamFile(res, resolvePageMediaPath(mediaId));
}

/**
 * 編集画面のプレースホルダ判定・書き出しのスキップ+警告判定に使う共通ヘルパ(Docs/Feature-ScriptToManga.md
 * S2: 「file/media 行欠損は編集画面ではプレースホルダ、書き出しはスキップして警告ログ。黙って落とさない」)。
 * `page.objects` が参照する mediaId のうち、page_media 行が無い/ファイルが実在しないものを返す。
 */
export function missingPageMediaIds(objects: readonly PageObject[]): string[] {
  const mediaIds = new Set<string>();
  for (const object of objects) {
    if (object.kind === "image") {
      mediaIds.add(object.mediaId);
    }
  }
  const missing: string[] = [];
  for (const mediaId of mediaIds) {
    const row = getRow<{ file_path: string }>("SELECT file_path FROM page_media WHERE id = ?", [mediaId]);
    if (!row || !existsSync(row.file_path)) {
      missing.push(mediaId);
    }
  }
  return missing;
}
