import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import sharp from "sharp";
import { initializeDb, runSql } from "./db.ts";
import { createImageExport, parseImageExportFormat } from "./imageExport.ts";
import { HttpError } from "./http.ts";
import { DEFAULT_PANEL_FRAME, type PageLayout } from "../shared/pageLayout.ts";

// pptxExport.ts のプライベート定数と同じ値(監督レビュー済み設計、pptxExport.ts と重複させて
// 「実装と同じ式で丸めを再現する」ことをテスト側で担保する)。
const SLIDE_WIDTH_EMU = 9_144_000;
const MIN_SLIDE_EMU = 914_400;
const MAX_SLIDE_EMU = 51_206_400;

function clampEmu(value: number): number {
  return Math.min(MAX_SLIDE_EMU, Math.max(MIN_SLIDE_EMU, value));
}

/** pptxExport.ts の computeExportCanvas と同じ式。 */
function exportCanvasSize(pixelWidth: number, pageHeightRatio: number): { width: number; height: number } {
  return { width: pixelWidth, height: Math.max(1, Math.round(pixelWidth * pageHeightRatio)) };
}

/** pptxExport.ts の computeSlideSize と同じ式。 */
function expectedSlideSize(firstCanvas: { width: number; height: number }): { cx: number; cy: number } {
  const ratio = firstCanvas.height / firstCanvas.width;
  return { cx: SLIDE_WIDTH_EMU, cy: clampEmu(Math.round(SLIDE_WIDTH_EMU * ratio)) };
}

/** pptxExport.ts の computeSlidePicRect と同じ式。 */
function expectedSlidePicRect(
  slideSize: { cx: number; cy: number },
  canvas: { width: number; height: number }
): { x: number; y: number; cx: number; cy: number } {
  const pageAspect = canvas.width / canvas.height;
  const slideAspect = slideSize.cx / slideSize.cy;
  let cx: number;
  let cy: number;
  if (pageAspect > slideAspect) {
    cx = slideSize.cx;
    cy = Math.max(1, Math.round(slideSize.cx / pageAspect));
  } else {
    cy = slideSize.cy;
    cx = Math.max(1, Math.round(slideSize.cy * pageAspect));
  }
  const x = Math.round((slideSize.cx - cx) / 2);
  const y = Math.round((slideSize.cy - cy) / 2);
  return { x, y, cx, cy };
}

interface PageSpec {
  height: number;
  panelBounds?: [number, number, number, number];
}

async function setupCustomProject(specs: PageSpec[]): Promise<{ projectId: string; pageIds: string[] }> {
  initializeDb();
  const suffix = `${Date.now()}_${Math.round(Math.random() * 1e6)}`;
  const projectId = `project_pptx_${suffix}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-pptx-test-"));

  runSql(
    `INSERT INTO projects (id, name, description, mode, storage_dir, canvas_width, canvas_height)
     VALUES (?, ?, '', 'book', ?, 256, 384)`,
    [projectId, "PPTX Test 日本語", storageDir]
  );

  const pageIds: string[] = [];
  specs.forEach((spec, index) => {
    const pageId = `page_pptx_${suffix}_${index}`;
    pageIds.push(pageId);
    const layout: PageLayout = {
      version: 1,
      page: { aspectRatio: [1, spec.height], height: spec.height },
      readingDirection: "rtl",
      panels: spec.panelBounds
        ? [
            {
              id: `panel_${suffix}_${index}_1`,
              order: 1,
              shape: { type: "rect", bounds: spec.panelBounds }
            }
          ]
        : []
    };
    runSql(
      "INSERT INTO pages (id, project_id, page_index, title, layout_json) VALUES (?, ?, ?, ?, ?)",
      [pageId, projectId, index, `Page ${index + 1}`, JSON.stringify(layout)]
    );
  });
  return { projectId, pageIds };
}

async function setupProject(pageCount: number): Promise<{ projectId: string; pageIds: string[] }> {
  return setupCustomProject(
    Array.from({ length: pageCount }, () => ({ height: 1.5, panelBounds: [0.1, 0.1, 0.9, 0.9] as [number, number, number, number] }))
  );
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

  // (a) [Content_Types].xml: png Default と slide Override が揃う
  const contentTypesXml = await zip.file("[Content_Types].xml")!.async("string");
  assert.match(contentTypesXml, /<Default Extension="png" ContentType="image\/png"\/>/);
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

  // (d) 各 slideN.xml.rels が media を指し、media バイト列が PNG マジックで始まる
  for (const n of [1, 2]) {
    const slideRelsXml = await zip.file(`ppt/slides/_rels/slide${n}.xml.rels`)!.async("string");
    assert.match(slideRelsXml, new RegExp(`Target="\\.\\./media/image${n}\\.png"`));
    assert.match(slideRelsXml, /Type="[^"]*relationships\/slideLayout"/);
    const media = await zip.file(`ppt/media/image${n}.png`)!.async("nodebuffer");
    assert.ok(media.length > 8);
    assert.equal(media[0], 0x89);
    assert.equal(media[1], 0x50);
    assert.equal(media[2], 0x4e);
    assert.equal(media[3], 0x47);

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

test("createImageExport(format=pptx): PowerPoint標準の吹き出し図形と編集可能文字を出力する", async () => {
  const { projectId, pageIds } = await setupProject(1);
  runSql("UPDATE pages SET objects_json = ? WHERE id = ?", [JSON.stringify([{ id: "speech_1", kind: "balloon", position: { x: 0.5, y: 0.45 }, rotation: 0, shape: "ellipse", size: { x: 0.3, y: 0.2 }, tail: { tip: { x: 0.12, y: 0.22 }, width: 0.04 }, fill: "#ffffff", strokeColor: "#000000", strokeWidth: 0.004, content: { text: "編集できます", style: { fontId: "default", size: 0.03, direction: "vertical", color: "#000000" } } }]), pageIds[0]!]);
  const result = await createImageExport(projectId, { pageIds, format: "pptx" });
  const zip = await JSZip.loadAsync(result.buffer);
  const slideXml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  assert.match(slideXml, /name="speech_1 balloon"/);
  assert.match(slideXml, /name="speech_1 text"/);
  assert.match(slideXml, /prst="wedgeEllipseCallout"/);
  assert.match(slideXml, /name="adj1"/);
  assert.doesNotMatch(slideXml, /prst="triangle"/);
  assert.match(slideXml, /<a:t>編集できます<\/a:t>/);
  assert.match(slideXml, /vert="eaVert"/);
});

test("createImageExport(format=pptx): パイプライン同一性 -- format=png 単体書き出しと pptx 内 media がバイト一致", async () => {
  const pixelWidth = 512;
  const { projectId, pageIds } = await setupCustomProject([{ height: 1.5, panelBounds: [0.1, 0.1, 0.9, 0.9] }]);

  const pngResult = await createImageExport(projectId, { pageIds, format: "png", pixelWidth });
  const pptxResult = await createImageExport(projectId, { pageIds, format: "pptx", pixelWidth });
  const zip = await JSZip.loadAsync(pptxResult.buffer);
  const media = await zip.file("ppt/media/image1.png")!.async("nodebuffer");

  assert.ok(pngResult.buffer.equals(media), "format=png の単体書き出しと pptx 内 image1.png がバイト一致しない");
});

test("createImageExport(format=pptx): スライド配置矩形(同アスペクト=先頭ページは全面、異アスペクト=中央contain)", async () => {
  const pixelWidth = 512;
  const heights = [1.5, 0.75];
  const { projectId, pageIds } = await setupCustomProject(heights.map((height) => ({ height })));

  const result = await createImageExport(projectId, { pageIds, format: "pptx", pixelWidth });
  const zip = await JSZip.loadAsync(result.buffer);

  const presentationXml = await zip.file("ppt/presentation.xml")!.async("string");
  const sldSzMatch = presentationXml.match(/<p:sldSz cx="(\d+)" cy="(\d+)"\/>/);
  assert.ok(sldSzMatch);
  const slideSize = { cx: Number(sldSzMatch![1]), cy: Number(sldSzMatch![2]) };

  const firstCanvas = exportCanvasSize(pixelWidth, heights[0]!);
  const expectedSize = expectedSlideSize(firstCanvas);
  assert.equal(slideSize.cx, expectedSize.cx);
  assert.equal(slideSize.cy, expectedSize.cy);

  // (b) 先頭ページはスライドサイズの基準なので全面配置(off=0,0 / ext=スライドサイズ)
  const slide1Xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const rect1Match = slide1Xml.match(/<a:off x="(\d+)" y="(\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  assert.ok(rect1Match, "slide1.xml に a:off/a:ext が見つからない");
  assert.equal(Number(rect1Match![1]), 0);
  assert.equal(Number(rect1Match![2]), 0);
  assert.equal(Number(rect1Match![3]), slideSize.cx);
  assert.equal(Number(rect1Match![4]), slideSize.cy);

  // (c) 2ページ目は height=0.75 の横長ページなので中央 contain(レターボックス)
  const secondCanvas = exportCanvasSize(pixelWidth, heights[1]!);
  const expectedRect = expectedSlidePicRect(slideSize, secondCanvas);
  const slide2Xml = await zip.file("ppt/slides/slide2.xml")!.async("string");
  const rect2Match = slide2Xml.match(/<a:off x="(\d+)" y="(\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  assert.ok(rect2Match, "slide2.xml に a:off/a:ext が見つからない");
  assert.equal(Number(rect2Match![1]), expectedRect.x);
  assert.equal(Number(rect2Match![2]), expectedRect.y);
  assert.equal(Number(rect2Match![3]), expectedRect.cx);
  assert.equal(Number(rect2Match![4]), expectedRect.cy);

  // 横長ページ→縦に短い(cx=スライド幅、cy=round(cx×0.75)、y=中央寄せ、x=0)であることも明示的に確認
  assert.equal(expectedRect.x, 0);
  assert.equal(expectedRect.cx, slideSize.cx);
  assert.equal(expectedRect.cy, Math.round(slideSize.cx * 0.75));
  assert.equal(expectedRect.y, Math.round((slideSize.cy - expectedRect.cy) / 2));
});

test("createImageExport(format=pptx): ピクセル位置検証 -- コマ枠線が期待座標に実在し、内部/外部は Paper 色", async () => {
  const pixelWidth = 512;
  const pageHeight = 1.5;
  const panelBounds: [number, number, number, number] = [0.25, 0.25, 0.75, 0.75];
  const { projectId, pageIds } = await setupCustomProject([{ height: pageHeight, panelBounds }]);

  const result = await createImageExport(projectId, { pageIds, format: "pptx", pixelWidth });
  const zip = await JSZip.loadAsync(result.buffer);
  const media = await zip.file("ppt/media/image1.png")!.async("nodebuffer");

  const canvas = exportCanvasSize(pixelWidth, pageHeight);
  assert.equal(canvas.width, 512);
  assert.equal(canvas.height, 768);

  const { data, info } = await sharp(media).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, canvas.width);
  assert.equal(info.height, canvas.height);
  const { width, channels } = info;

  const pixelAt = (x: number, y: number): [number, number, number, number] => {
    const idx = (y * width + x) * channels;
    return [data[idx]!, data[idx + 1]!, data[idx + 2]!, channels > 3 ? data[idx + 3]! : 255];
  };

  const hasDarkPixelNear = (cx: number, cy: number, radius: number): boolean => {
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy += 1) {
      const y = Math.round(cy) + dy;
      if (y < 0 || y >= info.height) continue;
      for (let dx = -r; dx <= r; dx += 1) {
        const x = Math.round(cx) + dx;
        if (x < 0 || x >= width) continue;
        const [pr, pg, pb] = pixelAt(x, y);
        if (pr < 80 && pg < 80 && pb < 80) {
          return true;
        }
      }
    }
    return false;
  };

  const assertPaperColor = (x: number, y: number, label: string) => {
    const [pr, pg, pb] = pixelAt(x, y);
    assert.equal(pr, 245, `${label}: R が Paper 色でない (got ${pr},${pg},${pb} at ${x},${y})`);
    assert.equal(pg, 242, `${label}: G が Paper 色でない (got ${pr},${pg},${pb} at ${x},${y})`);
    assert.equal(pb, 234, `${label}: B が Paper 色でない (got ${pr},${pg},${pb} at ${x},${y})`);
  };

  // コマ境界(page座標系: x∈[0,1], y∈[0,pageHeight])を canvas ピクセルへ写像(openRasterExport.ts の mapPoint と同じ式)。
  const toPxX = (nx: number) => nx * canvas.width;
  const toPxY = (ny: number) => (ny / pageHeight) * canvas.height;
  const left = toPxX(panelBounds[0]);
  const right = toPxX(panelBounds[2]);
  const top = toPxY(panelBounds[1]);
  const bottom = toPxY(panelBounds[3]);
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;

  assert.equal(left, 128);
  assert.equal(right, 384);
  assert.equal(top, 128);
  assert.equal(bottom, 384);

  // frame.strokeWidth(page-width単位)を canvas ピクセルへ変換(openRasterExport.ts の renderFrameElement と同じ式)。
  const strokeWidthPx = Math.max(1, DEFAULT_PANEL_FRAME.strokeWidth * canvas.width);
  const tolerance = strokeWidthPx + 2;

  assert.ok(hasDarkPixelNear(left, centerY, tolerance), `左辺(x=${left}, y=${centerY})付近に枠線が見つからない`);
  assert.ok(hasDarkPixelNear(right, centerY, tolerance), `右辺(x=${right}, y=${centerY})付近に枠線が見つからない`);
  assert.ok(hasDarkPixelNear(centerX, top, tolerance), `上辺(x=${centerX}, y=${top})付近に枠線が見つからない`);
  assert.ok(hasDarkPixelNear(centerX, bottom, tolerance), `下辺(x=${centerX}, y=${bottom})付近に枠線が見つからない`);

  // コマ内部中央(境界から十分離れた点)と、コマの外(左上隅寄り)は Paper 色のまま(アセット割り当てが無い panel は
  // レイヤーがスキップされ、frameLayer の外は Paper が透けるため)。
  assertPaperColor(Math.round(centerX), Math.round(centerY), "コマ内部中央");
  assertPaperColor(20, 20, "コマ外");
});
