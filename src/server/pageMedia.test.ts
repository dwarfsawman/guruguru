import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPage, getPageDetail, updatePageObjects } from "./pages.ts";
import { createProject } from "./projects.ts";
import { createSourceAsset } from "./sourceAssets.ts";
import { createPageMedia, missingPageMediaIds } from "./pageMedia.ts";
import { createId, getRow, initializeDb, runSql } from "./db.ts";
import { deleteRoundTree, restoreRounds } from "./rounds.ts";
import { discardRoundTrashSnapshot } from "./roundTrash.ts";
import { createImageObject } from "../shared/pageObjects.ts";

// 1x1 の最小 PNG(dataUrl アップロード用)。src/server/pages.test.ts と同一。
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

function createDummyWorkflowTemplate(): string {
  initializeDb();
  const id = createId("template");
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Dummy', '', 'txt2img', 1, '{}', '{}', 'hash')`,
    [id]
  );
  return id;
}

async function createProjectPageWithAsset() {
  const templateId = createDummyWorkflowTemplate();
  const project = createProject({ name: "S2 page-media", mode: "book" });
  assert.ok(project);
  const page = createPage(project!.id as string, undefined);
  const { round, asset } = await createSourceAsset(project!.id as string, {
    templateId,
    pageId: page.id,
    dataUrl: TINY_PNG_DATA_URL,
    filename: "source.png"
  });
  assert.ok(round);
  assert.ok(asset);
  return { projectId: project!.id as string, page, round: round!, asset: asset! };
}

test("createPageMedia: copies the asset file into page_media and returns a mediaId", async () => {
  const { projectId, asset } = await createProjectPageWithAsset();
  const result = await createPageMedia(projectId, { assetId: asset.id });
  assert.ok(result.mediaId.startsWith("media_"));
  assert.equal(result.url, `/api/page-media/${result.mediaId}`);

  const row = getRow<{ file_path: string; source_asset_id: string | null; project_id: string }>(
    "SELECT file_path, source_asset_id, project_id FROM page_media WHERE id = ?",
    [result.mediaId]
  );
  assert.ok(row);
  assert.equal(row!.source_asset_id, asset.id);
  assert.equal(row!.project_id, projectId);
  assert.ok(existsSync(row!.file_path));
  // コピー先は元の asset ファイルと別パス(独立したファイル)。
  assert.notEqual(row!.file_path, asset.imagePath);
});

test("createPageMedia: 404s for an unknown assetId", async () => {
  const { projectId } = await createProjectPageWithAsset();
  await assert.rejects(() => createPageMedia(projectId, { assetId: "asset_does_not_exist" }));
});

test("missingPageMediaIds: page_media 行が無い mediaId を missing として返す", () => {
  initializeDb();
  const objects = [createImageObject("img_1", { x: 0.5, y: 0.3 }, "media_does_not_exist", { x: 0.2, y: 0.2 })];
  assert.deepEqual(missingPageMediaIds(objects), ["media_does_not_exist"]);
});

test("missingPageMediaIds: page_media 行はあるがファイルが実在しなければ missing", async () => {
  const { projectId, asset } = await createProjectPageWithAsset();
  const result = await createPageMedia(projectId, { assetId: asset.id });
  const row = getRow<{ file_path: string }>("SELECT file_path FROM page_media WHERE id = ?", [result.mediaId]);
  await rm(row!.file_path, { force: true });

  const objects = [createImageObject("img_1", { x: 0.5, y: 0.3 }, result.mediaId, { x: 0.2, y: 0.2 })];
  assert.deepEqual(missingPageMediaIds(objects), [result.mediaId]);
});

test("missingPageMediaIds: ファイルが実在すれば missing に含まれない", async () => {
  const { projectId, asset } = await createProjectPageWithAsset();
  const result = await createPageMedia(projectId, { assetId: asset.id });
  const objects = [createImageObject("img_1", { x: 0.5, y: 0.3 }, result.mediaId, { x: 0.2, y: 0.2 })];
  assert.deepEqual(missingPageMediaIds(objects), []);
});

// Docs/Feature-ScriptToManga.md S2 の受け入れ条件: 「元 Round 削除→ゴミ箱復元を跨いでも ImageObject が
// 壊れない(page_media コピー方式の検証)」。page_media は Asset とは独立したファイルコピーを持つため、
// Round のゴミ箱削除(DB行削除、ファイルは温存)/復元/確定削除(discard、Asset ファイルのみ削除)の
// いずれを経ても ImageObject の参照先(page_media ファイル)は生き続けることを確認する。
test("page_media survives round delete -> restore -> discard (ImageObject stays resolvable)", async () => {
  const { projectId, page, round, asset } = await createProjectPageWithAsset();
  const media = await createPageMedia(projectId, { assetId: asset.id });
  updatePageObjects(projectId, page.id, {
    objects: [createImageObject("img_1", { x: 0.5, y: 0.3 }, media.mediaId, { x: 0.2, y: 0.2 })]
  });

  const mediaRowBefore = getRow<{ file_path: string }>("SELECT file_path FROM page_media WHERE id = ?", [media.mediaId]);
  assert.ok(existsSync(mediaRowBefore!.file_path));

  // 1. ゴミ箱削除(DB 行は消えるがファイルは温存)。page_media は Round と無関係なので row も残る。
  deleteRoundTree(round.id);
  assert.equal(getRow("SELECT id FROM generation_rounds WHERE id = ?", [round.id]), null);
  assert.equal(getRow("SELECT id FROM assets WHERE id = ?", [asset.id]), null);
  let detail = getPageDetail(projectId, page.id);
  assert.deepEqual(detail.missingPageMediaIds, []);
  assert.ok(existsSync(mediaRowBefore!.file_path));

  // 2. ゴミ箱復元。
  restoreRounds({ rootId: round.id });
  assert.ok(getRow("SELECT id FROM generation_rounds WHERE id = ?", [round.id]));
  assert.ok(getRow("SELECT id FROM assets WHERE id = ?", [asset.id]));
  detail = getPageDetail(projectId, page.id);
  assert.deepEqual(detail.missingPageMediaIds, []);

  // 3. 再度削除して確定(discard) -- Asset の画像ファイルは消えるが、page_media は独立コピーなので無事。
  deleteRoundTree(round.id);
  discardRoundTrashSnapshot(round.id);
  assert.ok(!existsSync(asset.imagePath), "asset image file should be gone after discard");
  assert.ok(existsSync(mediaRowBefore!.file_path), "page_media file must survive Asset deletion");

  const mediaRowAfter = getRow<{ source_asset_id: string | null }>(
    "SELECT source_asset_id FROM page_media WHERE id = ?",
    [media.mediaId]
  );
  assert.ok(mediaRowAfter, "page_media row itself must survive Asset deletion");
  assert.equal(mediaRowAfter!.source_asset_id, null, "source_asset_id should be SET NULL via FK");

  detail = getPageDetail(projectId, page.id);
  assert.deepEqual(detail.missingPageMediaIds, [], "ImageObject must still resolve after Asset is fully gone");
});
