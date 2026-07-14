/**
 * 完成品の PPTX 書き出し(Docs/Feature-PptxExport.md)。`imageExport.ts` の `/export-images`
 * エンドポイント(format="pptx")から委譲される -- 独自エンドポイントは持たない。
 *
 * ページの画像・コマ枠・画像オブジェクトだけを背景 PNG に平坦化し、balloon/box/text は
 * PowerPoint の図形とテキストとして重ねる。吹き出し本体・しっぽ・文字はそれぞれ独立した
 * オブジェクトなので、書き出し後も PowerPoint 上で選択・移動・編集できる。
 * ライブラリ(pptxgenjs 等)は使わず、OOXML(Office Open XML)を直接手組みし、Rust helperでpackする。
 *
 * OOXML の最小構成と罠(監督レビュー済み):
 * - `[Content_Types].xml` に png の Default と、各 xml パートの Override を漏らさず列挙する。
 * - `_rels/.rels` → docProps/core.xml, docProps/app.xml, ppt/presentation.xml の3本。
 * - `ppt/presentation.xml` の `p:sldIdLst` の id は 256 以上で一意(ここでは 256+pageIndex)。
 * - `ppt/_rels/presentation.xml.rels` の r:id は `sldIdLst`/`sldMasterIdLst` の r:id と厳密一致させる。
 * - master(slideMaster1) → layout(slideLayout1) → 各 slide という rels の連鎖を1本でも欠かすと
 *   PowerPoint は開けず「修復」ダイアログを出す。各 slideN.xml.rels は「画像」だけでなく
 *   「所属する slideLayout」への relationship も持たせる(スキーマ上必須)。
 * - `a:ext` の cx/cy(EMU)は正の整数であること。
 * - `a:blip` の `r:embed` は同じ slideN.xml.rels 内の画像 relationship Id と一致させる。
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PageRow } from "../shared/apiTypes";
import type { BalloonObject, BoxObject, PageObject, TextContent, TextObject } from "../shared/pageObjects";
import {
  computeExportCanvas,
  createPageLayers,
  escapeXml,
  renderMergedImage,
  resolvePageHeight,
  safeAsciiName,
  type ExportCanvas,
  type ExportProjectRow
} from "./openRasterExport";
import { finalizeFileExport, type FileExportMetrics, type FileExportResult } from "./fileExport";
import { packArchiveWithRust, type ArchivePackEntry } from "./projectArchive";

const PPTX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** スライド幅(EMU)。デッキ全体で1つに固定し、高さは先頭ページのアスペクト比から決める。 */
const SLIDE_WIDTH_EMU = 9_144_000;
/** PowerPoint が受け付けるスライド1辺の範囲(EMU)。1インチ〜56インチ。 */
const MIN_SLIDE_EMU = 914_400;
const MAX_SLIDE_EMU = 51_206_400;

interface SlideSize {
  cx: number;
  cy: number;
}

interface RenderedSlidePage {
  png: Buffer;
  canvas: ExportCanvas;
  pageHeight: number;
  editableObjects: PageObject[];
}

/**
 * PPTX デッキを1本組み立てて返す。常に単一 .pptx(複数ページでも zip 化しない、design point 5)。
 * `pixelWidth` は呼び出し元(`createImageExport`)で既に clamp 済みのものを渡す。
 */
export async function createPptxExport(
  project: ExportProjectRow,
  pages: PageRow[],
  pixelWidth: number,
  tempDir: string,
  metrics: FileExportMetrics
): Promise<FileExportResult> {
  const rendered: Array<Omit<RenderedSlidePage, "png"> & { pngPath: string }> = [];
  const renderStartedAt = performance.now();
  for (const [index, page] of pages.entries()) {
    const slide = await renderSlidePage(page, pixelWidth);
    const pngPath = join(tempDir, `pptx-slide-${String(index + 1).padStart(4, "0")}.png`);
    await writeFile(pngPath, slide.png, { flag: "wx" });
    metrics.inputBytes += slide.png.byteLength;
    rendered.push({ pngPath, canvas: slide.canvas, pageHeight: slide.pageHeight, editableObjects: slide.editableObjects });
  }
  metrics.renderMs += performance.now() - renderStartedAt;

  const slideSize = computeSlideSize(rendered[0]!.canvas);
  const entries: ArchivePackEntry[] = [];
  let textEntryIndex = 0;
  const addTextEntry = async (archivePath: string, content: string) => {
    textEntryIndex += 1;
    const source = join(tempDir, `pptx-text-${String(textEntryIndex).padStart(4, "0")}.xml`);
    await writeFile(source, content, { encoding: "utf8", flag: "wx" });
    metrics.inputBytes += Buffer.byteLength(content);
    entries.push({ source, archivePath, compression: "deflate" });
  };

  const zipStartedAt = performance.now();
  await addTextEntry("[Content_Types].xml", renderContentTypesXml(rendered.length));
  await addTextEntry("_rels/.rels", renderRootRelsXml());
  await addTextEntry("docProps/core.xml", renderCorePropsXml(project.name));
  await addTextEntry("docProps/app.xml", renderAppPropsXml(rendered.length));
  await addTextEntry("ppt/presentation.xml", renderPresentationXml(rendered.length, slideSize));
  await addTextEntry("ppt/_rels/presentation.xml.rels", renderPresentationRelsXml(rendered.length));
  await addTextEntry("ppt/presProps.xml", renderPresPropsXml());
  await addTextEntry("ppt/viewProps.xml", renderViewPropsXml());
  await addTextEntry("ppt/tableStyles.xml", renderTableStylesXml());
  await addTextEntry("ppt/theme/theme1.xml", renderThemeXml());
  await addTextEntry("ppt/slideMasters/slideMaster1.xml", renderSlideMasterXml());
  await addTextEntry("ppt/slideMasters/_rels/slideMaster1.xml.rels", renderSlideMasterRelsXml());
  await addTextEntry("ppt/slideLayouts/slideLayout1.xml", renderSlideLayoutXml());
  await addTextEntry("ppt/slideLayouts/_rels/slideLayout1.xml.rels", renderSlideLayoutRelsXml());

  for (const [index, slide] of rendered.entries()) {
    const slideNumber = index + 1;
    const rect = computeSlidePicRect(slideSize, slide.canvas);
    await addTextEntry(
      `ppt/slides/slide${slideNumber}.xml`,
      renderSlideXml(rect, slide.pageHeight, slide.editableObjects)
    );
    await addTextEntry(`ppt/slides/_rels/slide${slideNumber}.xml.rels`, renderSlideRelsXml(slideNumber));
    // PNGは圧縮済みなのでSTOREし、再DEFLATEのCPUと一時メモリを使わない。
    entries.push({ source: slide.pngPath, archivePath: `ppt/media/image${slideNumber}.png`, compression: "store" });
  }

  const artifactPath = join(tempDir, "export.pptx");
  await packArchiveWithRust(entries, artifactPath, join(tempDir, "pptx-entries.json"));
  metrics.zipMs += performance.now() - zipStartedAt;
  return finalizeFileExport(
    {
      filename: `${safeAsciiName(project.name, "guruguru-book")}.pptx`,
      contentType: PPTX_CONTENT_TYPE,
      artifactPath,
      pageCount: rendered.length,
      metrics
    },
    "PPTXの作成結果が空です。"
  );
}

/**
 * 背景 PNG には画像オブジェクトだけを残し、編集可能オブジェクトは slide XML へ分離する。
 * トーン(Docs/Feature-ScreenTones.md)は image と同じく背景側に残す -- `editableObjectsXml` は
 * balloon/box/text しか PowerPoint 図形化できず(seed 付き PRNG で生成するドット/線パターンを
 * ネイティブ図形として表現する手段が無い)、ここで除外し忘れると背景にも slide 図形にも現れず
 * 静かに消える(pptxExport.test.ts の回帰テストで確認)。
 */
async function renderSlidePage(page: PageRow, pixelWidth: number): Promise<RenderedSlidePage> {
  const layout = page.layout ?? null;
  const pageHeight = resolvePageHeight(page, layout);
  const canvas = computeExportCanvas(pixelWidth, pageHeight);
  const editableObjects = (page.objects ?? []).filter((object) => object.kind !== "image" && object.kind !== "tone");
  const backgroundPage: PageRow = {
    ...page,
    objects: (page.objects ?? []).filter((object) => object.kind === "image" || object.kind === "tone")
  };
  const layers = await createPageLayers(backgroundPage, canvas);
  const png = await renderMergedImage(layers, canvas);
  return { png, canvas, pageHeight, editableObjects };
}

/** デッキ全体のスライドサイズ(EMU)。幅は固定、高さは先頭ページのアスペクト比から算出して clamp する。 */
function computeSlideSize(firstCanvas: ExportCanvas): SlideSize {
  const ratio = firstCanvas.height / firstCanvas.width;
  const cy = clampEmu(Math.round(SLIDE_WIDTH_EMU * ratio));
  return { cx: SLIDE_WIDTH_EMU, cy };
}

function clampEmu(value: number): number {
  return Math.min(MAX_SLIDE_EMU, Math.max(MIN_SLIDE_EMU, value));
}

/** ページ画像をスライドへ「中央 contain」配置した矩形(EMU)。アスペクト比が異なる場合は左右または上下に余白ができる。 */
function computeSlidePicRect(slideSize: SlideSize, canvas: ExportCanvas): { x: number; y: number; cx: number; cy: number } {
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

function renderContentTypesXml(pageCount: number): string {
  const slideOverrides = Array.from(
    { length: pageCount },
    (_, index) =>
      `  <Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
${slideOverrides}
</Types>
`;
}

function renderRootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
`;
}

function renderCorePropsXml(projectName: string): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const title = escapeXml(projectName || "guruguru-book");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${title}</dc:title>
  <dc:creator>guruguru</dc:creator>
  <cp:lastModifiedBy>guruguru</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>
`;
}

function renderAppPropsXml(pageCount: number): string {
  const titles = Array.from({ length: pageCount }, (_, index) => `      <vt:lpstr>Slide ${index + 1}</vt:lpstr>`).join(
    "\n"
  );
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>guruguru</Application>
  <PresentationFormat>Custom</PresentationFormat>
  <Slides>${pageCount}</Slides>
  <TitlesOfParts>
    <vt:vector size="${pageCount}" baseType="lpstr">
${titles}
    </vt:vector>
  </TitlesOfParts>
  <Company></Company>
</Properties>
`;
}

function renderPresentationXml(pageCount: number, slideSize: SlideSize): string {
  const sldIds = Array.from(
    { length: pageCount },
    (_, index) => `    <p:sldId id="${256 + index}" r:id="rIdSlide${index + 1}"/>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rIdMaster1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
${sldIds}
  </p:sldIdLst>
  <p:sldSz cx="${slideSize.cx}" cy="${slideSize.cy}"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>
`;
}

function renderPresentationRelsXml(pageCount: number): string {
  const slideRels = Array.from(
    { length: pageCount },
    (_, index) =>
      `  <Relationship Id="rIdSlide${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slideRels}
  <Relationship Id="rIdPresProps" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
  <Relationship Id="rIdViewProps" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
  <Relationship Id="rIdTableStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
</Relationships>
`;
}

function renderPresPropsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>
`;
}

function renderViewPropsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:normalViewPr>
    <p:restoredLeft sz="15620"/>
    <p:restoredTop sz="94660"/>
  </p:normalViewPr>
  <p:slideViewPr>
    <p:cSldViewPr>
      <p:cViewPr varScale="1">
        <p:origin x="0" y="0"/>
        <p:scale>
          <a:sx n="1" d="1"/>
          <a:sy n="1" d="1"/>
        </p:scale>
      </p:cViewPr>
    </p:cSldViewPr>
  </p:slideViewPr>
</p:viewPr>
`;
}

function renderTableStylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>
`;
}

function renderThemeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="guruguru">
  <a:themeElements>
    <a:clrScheme name="guruguru">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F1F1F"/></a:dk2>
      <a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
      <a:accent1><a:srgbClr val="4F81BD"/></a:accent1>
      <a:accent2><a:srgbClr val="C0504D"/></a:accent2>
      <a:accent3><a:srgbClr val="9BBB59"/></a:accent3>
      <a:accent4><a:srgbClr val="8064A2"/></a:accent4>
      <a:accent5><a:srgbClr val="4BACC6"/></a:accent5>
      <a:accent6><a:srgbClr val="F79646"/></a:accent6>
      <a:hlink><a:srgbClr val="0000FF"/></a:hlink>
      <a:folHlink><a:srgbClr val="800080"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="guruguru">
      <a:majorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="guruguru">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>
`;
}

function renderSlideMasterXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg>
      <p:bgRef idx="1001">
        <a:schemeClr val="bg1"/>
      </p:bgRef>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rIdLayout1"/>
  </p:sldLayoutIdLst>
</p:sldMaster>
`;
}

function renderSlideMasterRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>
`;
}

function renderSlideLayoutXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sldLayout>
`;
}

function renderSlideLayoutRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>
`;
}

interface SlideRect { x: number; y: number; cx: number; cy: number }

function colorHex(value: string | undefined, fallback: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(value ?? "");
  return (match?.[1] ?? fallback).toUpperCase();
}

function objectRect(position: { x: number; y: number }, size: { x: number; y: number }, pageHeight: number, rect: SlideRect): SlideRect {
  return {
    x: Math.round(rect.x + (position.x - size.x / 2) * rect.cx),
    y: Math.round(rect.y + ((position.y - size.y / 2) / pageHeight) * rect.cy),
    cx: Math.max(1, Math.round(size.x * rect.cx)),
    cy: Math.max(1, Math.round((size.y / pageHeight) * rect.cy))
  };
}

function shapeXml(id: number, name: string, geometry: string, box: SlideRect, fill: string, stroke: string, strokeWidth: number, rotation = 0, adjustments: Array<[string, number]> = []): string {
  const rot = Math.round((rotation * 180 / Math.PI) * 60000);
  const lineWidth = Math.max(1, Math.round(strokeWidth * box.cx));
  const avLst = adjustments.length ? `<a:avLst>${adjustments.map(([key, value]) => `<a:gd name="${key}" fmla="val ${Math.round(value)}"/>`).join("")}</a:avLst>` : "<a:avLst/>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${rot ? ` rot="${rot}"` : ""}><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm><a:prstGeom prst="${geometry}">${avLst}</a:prstGeom><a:solidFill><a:srgbClr val="${colorHex(fill, "FFFFFF")}"/></a:solidFill><a:ln w="${lineWidth}"><a:solidFill><a:srgbClr val="${colorHex(stroke, "000000")}"/></a:solidFill></a:ln></p:spPr></p:sp>`;
}

function textXml(id: number, name: string, content: TextContent, box: SlideRect, pageWidthEmu: number, rotation = 0): string {
  const rot = Math.round((rotation * 180 / Math.PI) * 60000);
  // guruguru の TextStyle.size は「ページ幅比」。テキスト枠幅ではなくページ配置幅から pt へ変換する。
  const fontSize = Math.max(500, Math.round((content.style.size * pageWidthEmu / 12700) * 100));
  const vertical = content.style.direction === "vertical" ? ` vert="eaVert"` : "";
  const align = content.style.align === "start" ? "l" : content.style.align === "end" ? "r" : "ctr";
  const lines = content.text.split(/\r?\n/).map((line) => `<a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="ja-JP" sz="${fontSize}"><a:solidFill><a:srgbClr val="${colorHex(content.style.color, "000000")}"/></a:solidFill></a:rPr><a:t>${escapeXml(line)}</a:t></a:r><a:endParaRPr lang="ja-JP" sz="${fontSize}"/></a:p>`).join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${rot ? ` rot="${rot}"` : ""}><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="ctr"${vertical}/><a:lstStyle/>${lines}</p:txBody></p:sp>`;
}

/** PowerPoint 上で吹き出し本体と文字を一操作で移動・拡縮できるグループ図形。 */
function balloonGroupXml(
  groupId: number,
  shapeId: number,
  textId: number,
  balloon: BalloonObject,
  geometry: string,
  box: SlideRect,
  textBox: SlideRect,
  pageWidthEmu: number,
  adjustments: Array<[string, number]>
): string {
  const left = Math.min(box.x, textBox.x);
  const top = Math.min(box.y, textBox.y);
  const right = Math.max(box.x + box.cx, textBox.x + textBox.cx);
  const bottom = Math.max(box.y + box.cy, textBox.y + textBox.cy);
  const bounds = { x: left, y: top, cx: Math.max(1, right - left), cy: Math.max(1, bottom - top) };
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${groupId}" name="${escapeXml(`${balloon.id} balloon and text`)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${bounds.x}" y="${bounds.y}"/><a:ext cx="${bounds.cx}" cy="${bounds.cy}"/><a:chOff x="${bounds.x}" y="${bounds.y}"/><a:chExt cx="${bounds.cx}" cy="${bounds.cy}"/></a:xfrm></p:grpSpPr>${shapeXml(shapeId, `${balloon.id} balloon`, geometry, box, balloon.fill, balloon.strokeColor, balloon.strokeWidth, balloon.rotation, adjustments)}${textXml(textId, `${balloon.id} text`, balloon.content!, textBox, pageWidthEmu, balloon.rotation)}</p:grpSp>`;
}

function effectGroupKey(object: PageObject): string | null {
  if (object.kind !== "box") return null;
  const match = /^(effect:[^:]+:(?:focus-lines|speed-lines)):\d+$/.exec(object.id);
  return match?.[1] ?? null;
}

/** 集中線・スピード線を構成する複数の細長いBoxをPowerPoint上の単一グループにする。 */
function effectGroupXml(groupId: number, firstShapeId: number, key: string, effects: BoxObject[], pageHeight: number, rect: SlideRect): string {
  const boxes = effects.map((effect) => objectRect(effect.position, effect.size, pageHeight, rect));
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.cx));
  const bottom = Math.max(...boxes.map((box) => box.y + box.cy));
  const cx = Math.max(1, right - left);
  const cy = Math.max(1, bottom - top);
  const children = effects.map((effect, index) => shapeXml(
    firstShapeId + index,
    effect.id,
    effect.cornerRadius ? "roundRect" : "rect",
    boxes[index]!,
    effect.fill,
    effect.strokeColor,
    effect.strokeWidth,
    effect.rotation
  )).join("");
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${groupId}" name="${escapeXml(key)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${left}" y="${top}"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="${left}" y="${top}"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></p:grpSpPr>${children}</p:grpSp>`;
}

function editableObjectsXml(objects: PageObject[], pageHeight: number, rect: SlideRect): string {
  let id = 3;
  const xml: string[] = [];
  const groupedEffects = new Set<string>();
  for (const object of objects) {
    const effectKey = effectGroupKey(object);
    if (effectKey) {
      if (groupedEffects.has(effectKey)) continue;
      groupedEffects.add(effectKey);
      const effects = objects.filter((candidate): candidate is BoxObject => effectGroupKey(candidate) === effectKey);
      xml.push(effectGroupXml(id++, id, effectKey, effects, pageHeight, rect));
      id += effects.length;
      continue;
    }
    if (object.kind === "balloon") {
      const balloon = object as BalloonObject;
      const box = objectRect(balloon.position, balloon.size, pageHeight, rect);
      const geometry = balloon.tail
        ? balloon.shape === "rounded" ? "wedgeRoundRectCallout" : balloon.shape === "cloud" || balloon.shape === "thought" ? "cloudCallout" : balloon.shape === "jagged" ? "wedgeRectCallout" : "wedgeEllipseCallout"
        : balloon.shape === "rounded" ? "roundRect" : balloon.shape === "cloud" || balloon.shape === "thought" ? "cloud" : balloon.shape === "jagged" ? "irregularSeal1" : "ellipse";
      const adjustments: Array<[string, number]> = balloon.tail ? [["adj1", balloon.tail.tip.x / balloon.size.x * 100000], ["adj2", balloon.tail.tip.y / balloon.size.y * 100000]] : [];
      if (balloon.content?.text) {
        const textBox = objectRect(balloon.position, { x: balloon.size.x * 0.78, y: balloon.size.y * 0.72 }, pageHeight, rect);
        xml.push(balloonGroupXml(id++, id++, id++, balloon, geometry, box, textBox, rect.cx, adjustments));
      } else {
        xml.push(shapeXml(id++, `${balloon.id} balloon`, geometry, box, balloon.fill, balloon.strokeColor, balloon.strokeWidth, balloon.rotation, adjustments));
      }
    } else if (object.kind === "box") {
      const boxObject = object as BoxObject;
      const box = objectRect(boxObject.position, boxObject.size, pageHeight, rect);
      xml.push(shapeXml(id++, `${boxObject.id} box`, boxObject.cornerRadius ? "roundRect" : "rect", box, boxObject.fill, boxObject.strokeColor, boxObject.strokeWidth, boxObject.rotation));
      if (boxObject.content?.text) xml.push(textXml(id++, `${boxObject.id} text`, boxObject.content, objectRect(boxObject.position, { x: boxObject.size.x * 0.88, y: boxObject.size.y * 0.82 }, pageHeight, rect), rect.cx, boxObject.rotation));
    } else if (object.kind === "text") {
      const textObject = object as TextObject;
      const size = { x: textObject.maxWidth ?? Math.max(0.08, textObject.content.style.size * 4), y: Math.max(0.08, textObject.content.style.size * 6) };
      xml.push(textXml(id++, `${textObject.id} text`, textObject.content, objectRect(textObject.position, size, pageHeight, rect), rect.cx, textObject.rotation));
    }
  }
  return xml.join("\n      ");
}

function renderSlideXml(rect: SlideRect, pageHeight: number, objects: PageObject[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="2" name="Page image"/>
          <p:cNvPicPr>
            <a:picLocks noChangeAspect="1"/>
          </p:cNvPicPr>
          <p:nvPr/>
        </p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="rIdImage1"/>
          <a:stretch>
            <a:fillRect/>
          </a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm>
            <a:off x="${rect.x}" y="${rect.y}"/>
            <a:ext cx="${rect.cx}" cy="${rect.cy}"/>
          </a:xfrm>
          <a:prstGeom prst="rect">
            <a:avLst/>
          </a:prstGeom>
        </p:spPr>
      </p:pic>
      ${editableObjectsXml(objects, pageHeight, rect)}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sld>
`;
}

function renderSlideRelsXml(slideNumber: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${slideNumber}.png"/>
</Relationships>
`;
}
