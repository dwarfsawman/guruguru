import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { initializeDb, runSql } from "./db.ts";
import { createOpenRasterExport } from "./openRasterExport.ts";
import type { PageLayout } from "../shared/pageLayout.ts";

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
  assert.ok(zip.file("mergedimage.png"));
  assert.ok(zip.file("Thumbnails/thumbnail.png"));

  const stackXml = await zip.file("stack.xml")!.async("string");
  assert.match(stackXml, /<image version="0\.0\.3" w="256" h="256"/);
  assert.match(stackXml, /<layer name="Panels" src="data\/layer-001\.png"/);
});
