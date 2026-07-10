import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createId, initializeDb, runSql } from "./db.ts";
import { createOpenRasterExport } from "./openRasterExport.ts";
import type { PageLayout } from "../shared/pageLayout.ts";
import { createImageObject } from "../shared/pageObjects.ts";

// 1x1 の最小 PNG(page_media ファイル用)。src/server/pages.test.ts と同一。
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

test("createOpenRasterExport: single layout page produces a baseline ORA with panel layer first", async () => {
  initializeDb();
  const projectId = `project_ora_${Date.now()}`;
  const pageId = `page_ora_${Date.now()}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-ora-test-"));
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1], height: 1 },
    readingDirection: "rtl",
    panels: [
      {
        id: "panel_1",
        order: 1,
        shape: { type: "rect", bounds: [0.1, 0.1, 0.9, 0.9] }
      }
    ]
  };

  runSql(
    `INSERT INTO projects (id, name, description, mode, storage_dir, canvas_width, canvas_height)
     VALUES (?, ?, '', 'book', ?, 256, 256)`,
    [projectId, "ORA Test", storageDir]
  );
  runSql(
    "INSERT INTO pages (id, project_id, page_index, title, layout_json) VALUES (?, ?, 0, 'Spread', ?)",
    [pageId, projectId, JSON.stringify(layout)]
  );

  const result = await createOpenRasterExport(projectId, { pageIds: [pageId] });
  assert.equal(result.contentType, "image/openraster");
  assert.equal(result.filename, "001-Spread.ora");

  const zip = await JSZip.loadAsync(result.buffer);
  assert.equal(await zip.file("mimetype")?.async("string"), "image/openraster");
  assert.ok(zip.file("stack.xml"));
  assert.ok(zip.file("data/layer-001.png"));
  assert.ok(zip.file("data/layer-002.png"));
  assert.ok(zip.file("mergedimage.png"));
  assert.ok(zip.file("Thumbnails/thumbnail.png"));

  const stackXml = await zip.file("stack.xml")!.async("string");
  assert.match(stackXml, /<image version="0\.0\.3" w="256" h="256"/);
  assert.match(stackXml, /<layer name="Panels" src="data\/layer-002\.png"/);
  assert.match(stackXml, /<layer name="Paper" src="data\/layer-001\.png"/);
});

// Docs/Feature-ScriptToManga.md S2: ImageObject の back/front 帯。back はコマ画像の後・コマ枠の前、
// front(box/text/balloon と同じ帯)はコマ枠の後に来ること(ORA レイヤー順で検証)。
test("createOpenRasterExport: back-band ImageObject layers before Panels, front-band after", async () => {
  initializeDb();
  const projectId = `project_ora_img_${Date.now()}`;
  const pageId = `page_ora_img_${Date.now()}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-ora-image-test-"));
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1], height: 1 },
    readingDirection: "rtl",
    panels: [{ id: "panel_1", order: 1, shape: { type: "rect", bounds: [0.1, 0.1, 0.9, 0.9] } }]
  };

  const pageMediaDir = join(storageDir, "projects", projectId, "page_media");
  await mkdir(pageMediaDir, { recursive: true });
  const backMediaId = createId("media");
  const frontMediaId = createId("media");
  const backMediaPath = join(pageMediaDir, `${backMediaId}.png`);
  const frontMediaPath = join(pageMediaDir, `${frontMediaId}.png`);
  await writeFile(backMediaPath, Buffer.from(TINY_PNG_BASE64, "base64"));
  await writeFile(frontMediaPath, Buffer.from(TINY_PNG_BASE64, "base64"));

  runSql(
    `INSERT INTO projects (id, name, description, mode, storage_dir, canvas_width, canvas_height)
     VALUES (?, ?, '', 'book', ?, 256, 256)`,
    [projectId, "ORA Image Test", storageDir]
  );
  runSql(
    "INSERT INTO page_media (id, project_id, file_path, width, height) VALUES (?, ?, ?, 1, 1)",
    [backMediaId, projectId, backMediaPath]
  );
  runSql(
    "INSERT INTO page_media (id, project_id, file_path, width, height) VALUES (?, ?, ?, 1, 1)",
    [frontMediaId, projectId, frontMediaPath]
  );

  const backObject = { ...createImageObject("img_back", { x: 0.5, y: 0.5 }, backMediaId, { x: 0.3, y: 0.3 }), band: "back" as const };
  const frontObject = createImageObject("img_front", { x: 0.5, y: 0.5 }, frontMediaId, { x: 0.3, y: 0.3 });
  runSql(
    "INSERT INTO pages (id, project_id, page_index, title, layout_json, objects_json) VALUES (?, ?, 0, 'Spread', ?, ?)",
    [pageId, projectId, JSON.stringify(layout), JSON.stringify([backObject, frontObject])]
  );

  const result = await createOpenRasterExport(projectId, { pageIds: [pageId] });
  const zip = await JSZip.loadAsync(result.buffer);
  const stackXml = await zip.file("stack.xml")!.async("string");

  const backIndex = stackXml.indexOf('name="Objects (back)"');
  const panelsIndex = stackXml.indexOf('name="Panels"');
  const frontIndex = stackXml.lastIndexOf('name="Objects"');
  assert.ok(backIndex >= 0, "expected an 'Objects (back)' layer");
  assert.ok(panelsIndex >= 0, "expected a 'Panels' layer");
  assert.ok(frontIndex >= 0, "expected an 'Objects' (front) layer");
  // stack.xml lists layers top-first (renderStackXml reverses paint order), so the layer that
  // paints LAST (front-most) appears FIRST in the XML. Paint order is back -> Panels -> front,
  // so in the XML listing: front comes before Panels, which comes before back.
  assert.ok(frontIndex < panelsIndex, "front-band Objects layer should paint after (list before) Panels");
  assert.ok(panelsIndex < backIndex, "Panels should paint after (list before) the back-band Objects layer");
});

// Docs/Feature-ScriptToManga.md S2: file/media 行欠損は書き出しをスキップして警告ログ(黙って落とさない)。
test("createOpenRasterExport: missing page_media is skipped without throwing", async () => {
  initializeDb();
  const projectId = `project_ora_missing_${Date.now()}`;
  const pageId = `page_ora_missing_${Date.now()}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-ora-missing-test-"));
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1], height: 1 },
    readingDirection: "rtl",
    panels: [{ id: "panel_1", order: 1, shape: { type: "rect", bounds: [0.1, 0.1, 0.9, 0.9] } }]
  };

  runSql(
    `INSERT INTO projects (id, name, description, mode, storage_dir, canvas_width, canvas_height)
     VALUES (?, ?, '', 'book', ?, 256, 256)`,
    [projectId, "ORA Missing Test", storageDir]
  );
  const orphanObject = createImageObject("img_orphan", { x: 0.5, y: 0.5 }, "media_does_not_exist", { x: 0.3, y: 0.3 });
  runSql(
    "INSERT INTO pages (id, project_id, page_index, title, layout_json, objects_json) VALUES (?, ?, 0, 'Spread', ?, ?)",
    [pageId, projectId, JSON.stringify(layout), JSON.stringify([orphanObject])]
  );

  const result = await createOpenRasterExport(projectId, { pageIds: [pageId] });
  const zip = await JSZip.loadAsync(result.buffer);
  const stackXml = await zip.file("stack.xml")!.async("string");
  // 欠損オブジェクトしか無いのでレイヤー自体が追加されない(空レイヤーは作らない規約)。
  assert.ok(!stackXml.includes('name="Objects'));
});
