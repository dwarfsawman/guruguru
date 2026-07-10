import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { initializeDb, runSql } from "./db.ts";
import { createImageExport, parseImageExportFormat } from "./imageExport.ts";
import { HttpError } from "./http.ts";
import type { PageLayout } from "../shared/pageLayout.ts";

async function setupProject(pageCount: number): Promise<{ projectId: string; pageIds: string[] }> {
  initializeDb();
  const suffix = `${Date.now()}_${Math.round(Math.random() * 1e6)}`;
  const projectId = `project_pptx_${suffix}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-pptx-test-"));
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1], height: 1.5 },
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
     VALUES (?, ?, '', 'book', ?, 256, 384)`,
    [projectId, "PPTX Test 日本語", storageDir]
  );

  const pageIds: string[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    const pageId = `page_pptx_${suffix}_${i}`;
    pageIds.push(pageId);
    runSql(
      "INSERT INTO pages (id, project_id, page_index, title, layout_json) VALUES (?, ?, ?, ?, ?)",
      [pageId, projectId, i, `Page ${i + 1}`, JSON.stringify(layout)]
    );
  }
  return { projectId, pageIds };
}

test("parseImageExportFormat: pptx を通す", () => {
  assert.equal(parseImageExportFormat("pptx"), "pptx");
  assert.throws(
    () => parseImageExportFormat("gif"),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});

test("createImageExport(format=pptx): 単一ページでも .pptx 単体で返る", async () => {
  const { projectId, pageIds } = await setupProject(1);
  const result = await createImageExport(projectId, { pageIds, format: "pptx" });
  assert.equal(result.contentType, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.equal(result.pageCount, 1);
  assert.match(result.filename, /\.pptx$/);
});

test("createImageExport(format=pptx): OOXML 構造(Content_Types/rels/スライド数/EMU)が揃う", async () => {
  const { projectId, pageIds } = await setupProject(2);
  const result = await createImageExport(projectId, { pageIds, format: "pptx" });
  const zip = await JSZip.loadAsync(result.buffer);

  // (a) [Content_Types].xml: jpeg Default と slide Override が揃う
  const contentTypesXml = await zip.file("[Content_Types].xml")!.async("string");
  assert.match(contentTypesXml, /<Default Extension="jpeg" ContentType="image\/jpeg"\/>/);
  assert.match(contentTypesXml, /PartName="\/ppt\/slides\/slide1\.xml"/);
  assert.match(contentTypesXml, /PartName="\/ppt\/slides\/slide2\.xml"/);

  // (b) presentation.xml のスライド数=ページ数、sldId が256以上で一意
  const presentationXml = await zip.file("ppt/presentation.xml")!.async("string");
  const sldIdMatches = [...presentationXml.matchAll(/<p:sldId id="(\d+)" r:id="(rIdSlide\d+)"\/>/g)];
  assert.equal(sldIdMatches.length, 2);
  const ids = sldIdMatches.map((m) => Number(m[1]));
  assert.ok(ids.every((id) => id >= 256));
  assert.equal(new Set(ids).size, ids.length);

  // (c) presentation.xml.rels と sldIdLst の r:id 整合
  const presentationRelsXml = await zip.file("ppt/_rels/presentation.xml.rels")!.async("string");
  for (const match of sldIdMatches) {
    const rId = match[2]!;
    const relRegex = new RegExp(`Id="${rId}"[^>]*Type="[^"]*relationships/slide"`);
    assert.match(presentationRelsXml, relRegex, `${rId} が presentation.xml.rels に見つからない`);
  }
  assert.match(presentationRelsXml, /Id="rIdMaster1"[^>]*Type="[^"]*relationships\/slideMaster"/);

  // (d) 各 slideN.xml.rels が media を指し、media バイト列が JPEG マジックで始まる
  for (const n of [1, 2]) {
    const slideRelsXml = await zip.file(`ppt/slides/_rels/slide${n}.xml.rels`)!.async("string");
    assert.match(slideRelsXml, new RegExp(`Target="\\.\\./media/image${n}\\.jpeg"`));
    assert.match(slideRelsXml, /Type="[^"]*relationships\/slideLayout"/);
    const media = await zip.file(`ppt/media/image${n}.jpeg`)!.async("nodebuffer");
    assert.ok(media.length > 4);
    assert.equal(media[0], 0xff);
    assert.equal(media[1], 0xd8);

    const slideXml = await zip.file(`ppt/slides/slide${n}.xml`)!.async("string");
    assert.match(slideXml, /r:embed="rIdImage1"/);
  }

  // master → layout → slide の rels 連鎖
  assert.ok(zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels"));
  assert.ok(zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels"));
  const masterRelsXml = await zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels")!.async("string");
  assert.match(masterRelsXml, /Target="\.\.\/slideLayouts\/slideLayout1\.xml"/);
  assert.match(masterRelsXml, /Target="\.\.\/theme\/theme1\.xml"/);
  const layoutRelsXml = await zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels")!.async("string");
  assert.match(layoutRelsXml, /Target="\.\.\/slideMasters\/slideMaster1\.xml"/);

  // (g) スライド cx/cy が clamp 範囲(914400〜51206400)内
  const sldSzMatch = presentationXml.match(/<p:sldSz cx="(\d+)" cy="(\d+)"\/>/);
  assert.ok(sldSzMatch);
  const cx = Number(sldSzMatch![1]);
  const cy = Number(sldSzMatch![2]);
  assert.ok(cx >= 914_400 && cx <= 51_206_400);
  assert.ok(cy >= 914_400 && cy <= 51_206_400);
  assert.equal(cx, 9_144_000);
});

test("createImageExport(format=pptx): 不正な format は 400", async () => {
  const { projectId, pageIds } = await setupProject(1);
  await assert.rejects(
    () => createImageExport(projectId, { pageIds, format: "docx" }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});
