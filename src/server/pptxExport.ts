/**
 * 完成品の PPTX 書き出し(Docs/Feature-PptxExport.md)。`imageExport.ts` の `/export-images`
 * エンドポイント(format="pptx")から委譲される -- 独自エンドポイントは持たない。
 *
 * 各ページを `computeExportCanvas`(openRasterExport.ts)の解像度で `createPageLayers` +
 * `renderMergedImage` により平坦化し、その PNG バッファをそのまま PPTX の1スライド=1画像として
 * 埋め込む(ページは Paper 層があるため常に不透明で、追加のフラット化・再エンコードは不要)。
 * ライブラリ(pptxgenjs 等)は使わず、JSZip で OOXML(Office Open XML)パッケージを直接手組みする。
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
import JSZip from "jszip";
import type { PageRow } from "../shared/apiTypes";
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
import type { ImageExportResult } from "./imageExport";

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
}

/**
 * PPTX デッキを1本組み立てて返す。常に単一 .pptx(複数ページでも zip 化しない、design point 5)。
 * `pixelWidth` は呼び出し元(`createImageExport`)で既に clamp 済みのものを渡す。
 */
export async function createPptxExport(
  project: ExportProjectRow,
  pages: PageRow[],
  pixelWidth: number
): Promise<ImageExportResult> {
  const rendered: RenderedSlidePage[] = [];
  for (const page of pages) {
    rendered.push(await renderSlidePage(page, pixelWidth));
  }

  const slideSize = computeSlideSize(rendered[0]!.canvas);
  const zip = new JSZip();

  zip.file("[Content_Types].xml", renderContentTypesXml(rendered.length), { compression: "DEFLATE" });
  zip.file("_rels/.rels", renderRootRelsXml(), { compression: "DEFLATE" });
  zip.file("docProps/core.xml", renderCorePropsXml(project.name), { compression: "DEFLATE" });
  zip.file("docProps/app.xml", renderAppPropsXml(rendered.length), { compression: "DEFLATE" });

  zip.file("ppt/presentation.xml", renderPresentationXml(rendered.length, slideSize), { compression: "DEFLATE" });
  zip.file("ppt/_rels/presentation.xml.rels", renderPresentationRelsXml(rendered.length), { compression: "DEFLATE" });
  zip.file("ppt/presProps.xml", renderPresPropsXml(), { compression: "DEFLATE" });
  zip.file("ppt/viewProps.xml", renderViewPropsXml(), { compression: "DEFLATE" });
  zip.file("ppt/tableStyles.xml", renderTableStylesXml(), { compression: "DEFLATE" });

  zip.file("ppt/theme/theme1.xml", renderThemeXml(), { compression: "DEFLATE" });
  zip.file("ppt/slideMasters/slideMaster1.xml", renderSlideMasterXml(), { compression: "DEFLATE" });
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", renderSlideMasterRelsXml(), { compression: "DEFLATE" });
  zip.file("ppt/slideLayouts/slideLayout1.xml", renderSlideLayoutXml(), { compression: "DEFLATE" });
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", renderSlideLayoutRelsXml(), { compression: "DEFLATE" });

  rendered.forEach((slide, index) => {
    const slideNumber = index + 1;
    const rect = computeSlidePicRect(slideSize, slide.canvas);
    zip.file(`ppt/slides/slide${slideNumber}.xml`, renderSlideXml(rect), { compression: "DEFLATE" });
    zip.file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`, renderSlideRelsXml(slideNumber), {
      compression: "DEFLATE"
    });
    zip.file(`ppt/media/image${slideNumber}.png`, slide.png, { compression: "DEFLATE" });
  });

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return {
    filename: `${safeAsciiName(project.name, "guruguru-book")}.pptx`,
    contentType: PPTX_CONTENT_TYPE,
    buffer,
    pageCount: rendered.length
  };
}

/** ページ1件を PPTX 埋め込み用 PNG にラスタライズする(埋め込みは常に PNG。`renderMergedImage` の出力をそのまま使う)。 */
async function renderSlidePage(page: PageRow, pixelWidth: number): Promise<RenderedSlidePage> {
  const layout = page.layout ?? null;
  const pageHeight = resolvePageHeight(page, layout);
  const canvas = computeExportCanvas(pixelWidth, pageHeight);
  const layers = await createPageLayers(page, canvas);
  const png = await renderMergedImage(layers, canvas);
  return { png, canvas };
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

function renderSlideXml(rect: { x: number; y: number; cx: number; cy: number }): string {
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
