import JSZip from "jszip";
import sharp from "sharp";
import type { PageRow } from "../shared/apiTypes";
import {
  DEFAULT_PANEL_FRAME,
  FULL_PANEL_CROP,
  normalizePanelCrop,
  panelBounds,
  type LayoutPanel,
  type PageLayout,
  type PanelCrop,
  type PanelFrame,
  type PanelShape
} from "../shared/pageLayout";
import {
  contentMaxWidth,
  type BalloonObject,
  type BoxObject,
  type PageObject,
  type PageVec,
  type TextContent,
  type TextObject
} from "../shared/pageObjects";
import { balloonContentMaxWidth, renderBalloonSvg } from "../shared/balloonShape";
import { renderTextSvg } from "../shared/textSvg";
import { getRow, getRows, toApiRow } from "./db";
import { HttpError } from "./http";
import { computeTextLayoutForContent } from "./textLayoutApi";
import { objectBody } from "./validate";

const OPENRASTER_MIME = "image/openraster";
const DEFAULT_CANVAS_WIDTH = 1024;
const DEFAULT_CANVAS_HEIGHT = 1446;
const DEFAULT_RESOLUTION = 300;
/** レイアウト/代表アセットどちらからも解決できない時のページ高さフォールバック(pageLayout.ts の resolveHeight と同じ値)。 */
const FALLBACK_OBJECTS_PAGE_HEIGHT = 1.4142;

interface ExportProjectRow {
  id: string;
  name: string;
  canvas_width: number | null;
  canvas_height: number | null;
}

interface ExportCanvas {
  width: number;
  height: number;
}

interface ExportAssetRow {
  id: string;
  image_path: string;
  width: number | null;
  height: number | null;
}

interface PanelAssignmentAssetRow extends ExportAssetRow {
  panel_id: string;
  crop_json: string;
}

interface RasterLayer {
  name: string;
  src: string;
  png: Buffer;
}

export interface OpenRasterExportResult {
  filename: string;
  contentType: string;
  buffer: Buffer;
  pageCount: number;
}

export async function createOpenRasterExport(projectId: string, body: unknown): Promise<OpenRasterExportResult> {
  const project = requireProject(projectId);
  const input = objectBody(body);
  const rawPageIds = input.pageIds ?? input.page_ids;
  const requestedPageIds = Array.isArray(rawPageIds)
    ? rawPageIds.filter((id): id is string => typeof id === "string")
    : null;
  const pages = loadExportPages(projectId, requestedPageIds);
  if (pages.length === 0) {
    throw new HttpError(400, "OpenRaster export target pages were not found.");
  }

  const canvas = projectCanvas(project);
  const oras: Array<{ filename: string; buffer: Buffer }> = [];
  for (const page of pages) {
    oras.push({
      filename: `${pageFileBase(page)}.ora`,
      buffer: await createPageOra(page, canvas)
    });
  }

  if (oras.length === 1) {
    return {
      filename: oras[0]!.filename,
      contentType: OPENRASTER_MIME,
      buffer: oras[0]!.buffer,
      pageCount: 1
    };
  }

  const zip = new JSZip();
  for (const ora of oras) {
    zip.file(ora.filename, ora.buffer, { compression: "DEFLATE" });
  }
  return {
    filename: `${safeAsciiName(project.name, "guruguru-book")}-openraster.zip`,
    contentType: "application/zip",
    buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    pageCount: oras.length
  };
}

function requireProject(projectId: string): ExportProjectRow {
  const project = getRow<ExportProjectRow>(
    "SELECT id, name, canvas_width, canvas_height FROM projects WHERE id = ?",
    [projectId]
  );
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
  return project;
}

function loadExportPages(projectId: string, pageIds: string[] | null): PageRow[] {
  const rows = getRows<Record<string, unknown>>(
    "SELECT * FROM pages WHERE project_id = ? ORDER BY page_index ASC",
    [projectId]
  );
  const pages = rows.map((row) => toApiRow(row) as unknown as PageRow);
  if (!pageIds) {
    return pages;
  }
  const requested = new Set(pageIds);
  const selected = pages.filter((page) => requested.has(page.id));
  if (selected.length !== requested.size) {
    throw new HttpError(400, "pageIds contains a page that does not belong to this project");
  }
  return selected;
}

function projectCanvas(project: ExportProjectRow): ExportCanvas {
  const width = safeDimension(project.canvas_width, DEFAULT_CANVAS_WIDTH);
  const height = safeDimension(project.canvas_height, DEFAULT_CANVAS_HEIGHT);
  return { width, height };
}

function safeDimension(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.trunc(value) : fallback;
}

async function createPageOra(page: PageRow, canvas: ExportCanvas): Promise<Buffer> {
  const layers = await createPageLayers(page, canvas);
  const indexed = layers.map((layer, index) => ({
    ...layer,
    src: `data/layer-${String(index + 1).padStart(3, "0")}.png`
  }));
  const merged = await renderMergedImage(indexed, canvas);
  const thumbnail = await sharp(merged)
    .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const stackXml = renderStackXml(canvas, indexed);

  const zip = new JSZip();
  zip.file("mimetype", OPENRASTER_MIME, { compression: "STORE" });
  zip.file("stack.xml", stackXml, { compression: "DEFLATE" });
  for (const layer of indexed) {
    zip.file(layer.src, layer.png, { compression: "DEFLATE" });
  }
  zip.file("mergedimage.png", merged, { compression: "DEFLATE" });
  zip.file("Thumbnails/thumbnail.png", thumbnail, { compression: "DEFLATE" });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function createPagePreviewPng(
  projectId: string,
  pageId: string,
  options: { size?: number } = {}
): Promise<Buffer> {
  const project = requireProject(projectId);
  const page = toApiRow(
    getRow("SELECT * FROM pages WHERE id = ? AND project_id = ?", [pageId, projectId])
  ) as unknown as PageRow | null;
  if (!page) {
    throw new HttpError(404, "Page was not found");
  }
  const canvas = projectCanvas(project);
  const layers = await createPageLayers(page, canvas);
  const merged = await renderMergedImage(layers, canvas);
  const size = safeDimension(options.size, 512);
  return sharp(merged)
    .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

async function createPageLayers(page: PageRow, canvas: ExportCanvas): Promise<RasterLayer[]> {
  const paperLayer: RasterLayer = { name: "Paper", src: "", png: await paperPng(canvas) };
  const layout = page.layout ?? null;
  if (!layout) {
    const representative = representativeAsset(page.id);
    const layers: RasterLayer[] = [
      paperLayer,
      {
        name: "Page image",
        src: "",
        png: representative ? await renderFullImageLayer(representative, canvas) : await transparentPng(canvas)
      }
    ];
    await appendObjectsLayer(layers, page, null, canvas);
    return layers;
  }

  const layers: RasterLayer[] = [paperLayer];
  const assignments = new Map(panelAssignmentAssets(page.id).map((assignment) => [assignment.panel_id, assignment]));
  const panels = [...layout.panels].sort((a, b) => a.order - b.order);
  for (const panel of panels) {
    const assignment = assignments.get(panel.id);
    if (!assignment) {
      continue;
    }
    layers.push({
      name: `Panel ${panel.order || layers.length + 1}`,
      src: "",
      png: await renderPanelImageLayer(assignment, panel, layout, canvas)
    });
  }

  if (layers.length === 0) {
    const representative = representativeAsset(page.id);
    if (representative) {
      layers.push({ name: "Page image", src: "", png: await renderFullImageLayer(representative, canvas) });
    }
  }

  const frameLayer = await renderPanelFrameLayer(layout, canvas);
  if (frameLayer) {
    layers.push({ name: "Panels", src: "", png: frameLayer });
  }
  if (layers.length === 0) {
    layers.push({ name: "Blank page", src: "", png: await transparentPng(canvas) });
  }
  // ページオブジェクト(Docs/Feature-CGCollectionSuite.md P1)。コマ枠より前面、配列順(先頭=背面)。
  await appendObjectsLayer(layers, page, layout, canvas);
  return layers;
}

/**
 * ページオブジェクト(P1: box のみ)レイヤーを最前面に追加する。box が1つも無ければ何もしない
 * (空の透明レイヤーを作って合成コストをかけない)。
 */
async function appendObjectsLayer(layers: RasterLayer[], page: PageRow, layout: PageLayout | null, canvas: ExportCanvas): Promise<void> {
  const pageHeight = layout ? layoutHeight(layout) : resolveObjectsPageHeight(page);
  const png = await renderObjectsLayer(page.objects, pageHeight, canvas);
  if (png) {
    layers.push({ name: "Objects", src: "", png });
  }
}

/** レイアウトの無いページのオブジェクト座標系の高さ。代表アセットのアスペクト比 → フォールバック順。 */
function resolveObjectsPageHeight(page: PageRow): number {
  const asset = representativeAsset(page.id);
  if (asset?.width && asset?.height && asset.width > 0 && asset.height > 0) {
    return asset.height / asset.width;
  }
  return FALLBACK_OBJECTS_PAGE_HEIGHT;
}

/**
 * ページオブジェクトを SVG でラスタライズしたレイヤー。何も描く物が無ければ null
 * (パネル枠と同じ「無ければ null」規約)。box は P1、text は P2、balloon(本体+しっぽ+content)は P3。
 */
async function renderObjectsLayer(
  objects: PageObject[] | null | undefined,
  pageHeight: number,
  canvas: ExportCanvas
): Promise<Buffer | null> {
  const list = objects ?? [];
  if (list.length === 0) {
    return null;
  }
  const elements = list.map((object) => renderPageObjectElement(object, pageHeight, canvas)).filter(Boolean).join("");
  if (!elements) {
    return null;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">${elements}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function renderPageObjectElement(object: PageObject, pageHeight: number, canvas: ExportCanvas): string {
  if (object.kind === "box") {
    return renderBoxObjectElement(object, pageHeight, canvas) + renderContentElement(object.content, object.position, object.rotation, object.size, pageHeight, canvas);
  }
  if (object.kind === "text") {
    return renderTextObjectElement(object, pageHeight, canvas);
  }
  return renderBalloonObjectElement(object, pageHeight, canvas);
}

/**
 * 吹き出し1件(本体+しっぽ+content)。本体+しっぽは `renderBalloonSvg`(クライアント/サーバ共用の
 * 純ロジック)にローカル単位(anchor=0,0/rotation=0)で描かせ、外側の `<g>` で pixel 空間へ
 * translate→rotate→scale する -- `renderTextBlockElement` と全く同じパターン(box の回転と同じ
 * 「キャンバスとページのアスペクト比がズレる場合のみプレビューと微差」という既知の割り切りを踏襲)。
 */
function renderBalloonObjectElement(object: BalloonObject, pageHeight: number, canvas: ExportCanvas): string {
  const [anchorX, anchorY] = mapPoint([object.position.x, object.position.y], pageHeight, canvas);
  const deg = (object.rotation * 180) / Math.PI;
  const scaleX = canvas.width;
  const scaleY = canvas.height / pageHeight;
  const shape = renderBalloonSvg(object, { x: 0, y: 0 }, 0);
  const wrapped = `<g transform="translate(${fmt(anchorX)} ${fmt(anchorY)})${deg ? ` rotate(${fmt(deg)})` : ""} scale(${fmt(scaleX)} ${fmt(scaleY)})">${shape}</g>`;
  if (!object.content) {
    return wrapped;
  }
  const maxWidth = balloonContentMaxWidth(object.shape, object.size, object.content.style.direction);
  return wrapped + renderTextBlockElement(object.content, object.position, object.rotation, maxWidth, pageHeight, canvas);
}

function renderContentElement(
  content: TextContent | null | undefined,
  position: PageVec,
  rotation: number,
  size: PageVec,
  pageHeight: number,
  canvas: ExportCanvas
): string {
  if (!content) {
    return "";
  }
  const maxWidth = contentMaxWidth(size, content.style.direction);
  return renderTextBlockElement(content, position, rotation, maxWidth, pageHeight, canvas);
}

function renderTextObjectElement(object: TextObject, pageHeight: number, canvas: ExportCanvas): string {
  return renderTextBlockElement(object.content, object.position, object.rotation, object.maxWidth, pageHeight, canvas);
}

/**
 * テキストブロック1件(TextObject 本体、または box/balloon の内包テキスト)。`textLayout.ts`/`textSvg.ts`
 * はクライアントのプレビュー(`pagePanelLightboxView.ts`)と全く同じ関数 -- ここではその出力を canvas
 * ピクセル空間へ配置するだけ。box の回転(`renderBoxObjectElement`)と同じ規約に合わせ、位置は x/y
 * 独立スケールで pixel へマップした上で、回転は「マップ後の pixel 空間での剛体回転」として掛ける
 * (`transform="translate(pixelAnchor) rotate(deg) scale(scaleX scaleY)"` の適用順は
 * scale→rotate→translate なので、回転はスケール後=pixel 空間で効く)。
 */
function renderTextBlockElement(
  content: TextContent,
  position: PageVec,
  rotation: number,
  maxWidth: number | undefined,
  pageHeight: number,
  canvas: ExportCanvas
): string {
  const layout = computeTextLayoutForContent(content, maxWidth);
  if (layout.glyphs.length === 0) {
    return "";
  }
  const [anchorX, anchorY] = mapPoint([position.x, position.y], pageHeight, canvas);
  const deg = (rotation * 180) / Math.PI;
  const scaleX = canvas.width;
  const scaleY = canvas.height / pageHeight;
  // renderTextSvg は「ブロック中心=原点」の page 単位で自己完結するので、anchor(0,0)/rotation(0)で
  // 呼び、平行移動・回転・非等方スケールは外側の <g> でまとめて掛ける。
  const glyphs = renderTextSvg(layout, { x: 0, y: 0 }, 0, content.style);
  return `<g transform="translate(${fmt(anchorX)} ${fmt(anchorY)})${deg ? ` rotate(${fmt(deg)})` : ""} scale(${fmt(scaleX)} ${fmt(scaleY)})">${glyphs}</g>`;
}

/** box 1件の SVG `<rect>`。回転は中心まわりの rotate transform(ライブ編集の SVG と同じ見た目)。 */
function renderBoxObjectElement(object: BoxObject, pageHeight: number, canvas: ExportCanvas): string {
  const [x1, y1] = mapPoint([object.position.x - object.size.x / 2, object.position.y - object.size.y / 2], pageHeight, canvas);
  const [x2, y2] = mapPoint([object.position.x + object.size.x / 2, object.position.y + object.size.y / 2], pageHeight, canvas);
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  const cornerRadius = object.cornerRadius ?? 0;
  const radiusAttr = cornerRadius
    ? ` rx="${fmt(cornerRadius * canvas.width)}" ry="${fmt((cornerRadius / pageHeight) * canvas.height)}"`
    : "";
  const strokeWidthPx = Math.max(0, object.strokeWidth * canvas.width);
  const [cx, cy] = mapPoint([object.position.x, object.position.y], pageHeight, canvas);
  const deg = (object.rotation * 180) / Math.PI;
  const transform = deg ? ` transform="rotate(${fmt(deg)} ${fmt(cx)} ${fmt(cy)})"` : "";
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}"${radiusAttr} fill="${escapeXml(object.fill)}" stroke="${escapeXml(object.strokeColor)}" stroke-width="${fmt(strokeWidthPx)}"${transform}/>`;
}

function representativeAsset(pageId: string): ExportAssetRow | null {
  const selected = getRow<ExportAssetRow>(
    `SELECT a.id, a.image_path, a.width, a.height
     FROM assets a JOIN generation_rounds r ON r.id = a.round_id
     WHERE r.page_id = ? AND a.status IN ('selected', 'favorite')
     ORDER BY a.created_at DESC LIMIT 1`,
    [pageId]
  );
  if (selected) {
    return selected;
  }
  return getRow<ExportAssetRow>(
    `SELECT a.id, a.image_path, a.width, a.height
     FROM assets a JOIN generation_rounds r ON r.id = a.round_id
     WHERE r.page_id = ?
     ORDER BY a.created_at DESC LIMIT 1`,
    [pageId]
  );
}

function panelAssignmentAssets(pageId: string): PanelAssignmentAssetRow[] {
  return getRows<PanelAssignmentAssetRow>(
    `SELECT ppa.panel_id, ppa.crop_json, a.id, a.image_path, a.width, a.height
     FROM page_panel_assignments ppa
     JOIN assets a ON a.id = ppa.asset_id
     WHERE ppa.page_id = ?
     ORDER BY ppa.updated_at ASC`,
    [pageId]
  );
}

async function renderFullImageLayer(asset: ExportAssetRow, canvas: ExportCanvas): Promise<Buffer> {
  return sharp(asset.image_path, { failOn: "none" })
    .rotate()
    .resize(canvas.width, canvas.height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function renderPanelImageLayer(
  assignment: PanelAssignmentAssetRow,
  panel: LayoutPanel,
  layout: PageLayout,
  canvas: ExportCanvas
): Promise<Buffer> {
  const crop = parseCrop(assignment.crop_json);
  // 回転ありは、コマ内生成プレビュー(pagePanelLightboxView)と同じ SVG transform で描き、見た目を一致させる。
  if (crop.rotation && Math.abs(crop.rotation) > 1e-6) {
    return renderRotatedPanelImageLayer(assignment, panel, layout, canvas, crop);
  }
  const metadata = await sharp(assignment.image_path, { failOn: "none" }).rotate().metadata();
  const sourceWidth = assignment.width ?? metadata.width ?? 1;
  const sourceHeight = assignment.height ?? metadata.height ?? 1;
  const extract = cropToExtract(crop, sourceWidth, sourceHeight);
  const box = panelPixelBounds(panel, layout, canvas);
  const panelImage = await sharp(assignment.image_path, { failOn: "none" })
    .rotate()
    .extract(extract)
    .resize(box.width, box.height, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();
  const layer = await sharp(blankInput(canvas))
    .composite([{ input: panelImage, left: box.left, top: box.top }])
    .png()
    .toBuffer();
  return sharp(layer)
    .composite([{ input: Buffer.from(renderShapeMaskSvg(panel.shape, layout, canvas)), blend: "dest-in" }])
    .png()
    .toBuffer();
}

/** cover 窓(正規化)をコマ外接矩形へマップした `<image>` の x/y/width/height(pagePanelLightboxView と同式)。 */
function imageRectForCropNorm(bounds: [number, number, number, number], crop: PanelCrop) {
  const boxWidth = Math.max(1e-9, bounds[2] - bounds[0]);
  const boxHeight = Math.max(1e-9, bounds[3] - bounds[1]);
  const width = boxWidth / crop.width;
  const height = boxHeight / crop.height;
  return { x: bounds[0] - crop.x * width, y: bounds[1] - crop.y * height, width, height };
}

/**
 * 回転あり crop のパネルレイヤー。プレビューと同型に「clip を持つ外側 `<g>` + 回転する内側 `<image>`」
 * の SVG を canvas 解像度でラスタライズする。ソース画像は auto-orient 済み PNG を data URI で埋め込む。
 */
async function renderRotatedPanelImageLayer(
  assignment: PanelAssignmentAssetRow,
  panel: LayoutPanel,
  layout: PageLayout,
  canvas: ExportCanvas,
  crop: PanelCrop
): Promise<Buffer> {
  const oriented = await sharp(assignment.image_path, { failOn: "none" }).rotate().png().toBuffer();
  const dataUri = `data:image/png;base64,${oriented.toString("base64")}`;
  const bounds = panelBounds(panel.shape);
  const rect = imageRectForCropNorm(bounds, crop);
  const h = layoutHeight(layout);
  const toPxX = (nx: number) => nx * canvas.width;
  const toPxY = (ny: number) => (ny / h) * canvas.height;
  const centerX = toPxX((bounds[0] + bounds[2]) / 2);
  const centerY = toPxY((bounds[1] + bounds[3]) / 2);
  const deg = ((crop.rotation ?? 0) * 180) / Math.PI;
  const clipId = `panel-clip-${panel.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const image = `<image href="${dataUri}" x="${fmt(toPxX(rect.x))}" y="${fmt(toPxY(rect.y))}" width="${fmt(
    toPxX(rect.width)
  )}" height="${fmt(toPxY(rect.height))}" preserveAspectRatio="none" transform="rotate(${fmt(deg)} ${fmt(
    centerX
  )} ${fmt(centerY)})" />`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><defs><clipPath id="${clipId}">${renderShapeElement(
    panel.shape,
    layout,
    canvas,
    `fill="#fff"`
  )}</clipPath></defs><g clip-path="url(#${clipId})">${image}</g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function parseCrop(raw: string): PanelCrop {
  try {
    return normalizePanelCrop(JSON.parse(raw)) ?? { ...FULL_PANEL_CROP };
  } catch {
    return { ...FULL_PANEL_CROP };
  }
}

function cropToExtract(crop: PanelCrop, sourceWidth: number, sourceHeight: number) {
  const left = Math.min(sourceWidth - 1, Math.max(0, Math.floor(crop.x * sourceWidth)));
  const top = Math.min(sourceHeight - 1, Math.max(0, Math.floor(crop.y * sourceHeight)));
  const width = Math.max(1, Math.min(sourceWidth - left, Math.round(crop.width * sourceWidth)));
  const height = Math.max(1, Math.min(sourceHeight - top, Math.round(crop.height * sourceHeight)));
  return { left, top, width, height };
}

function panelPixelBounds(panel: LayoutPanel, layout: PageLayout, canvas: ExportCanvas) {
  const [minX, minY, maxX, maxY] = panelBounds(panel.shape);
  const h = layoutHeight(layout);
  const left = Math.max(0, Math.floor(minX * canvas.width));
  const top = Math.max(0, Math.floor((minY / h) * canvas.height));
  const right = Math.min(canvas.width, Math.ceil(maxX * canvas.width));
  const bottom = Math.min(canvas.height, Math.ceil((maxY / h) * canvas.height));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

async function renderPanelFrameLayer(layout: PageLayout, canvas: ExportCanvas): Promise<Buffer | null> {
  const elements = layout.panels
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((panel) => renderFrameElement(panel, layout, canvas))
    .filter(Boolean);
  if (elements.length === 0) {
    return null;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">${elements.join("")}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function renderFrameElement(panel: LayoutPanel, layout: PageLayout, canvas: ExportCanvas): string {
  const frame = resolveFrame(panel.frame);
  if (!frame.visible || frame.style === "none") {
    return "";
  }
  const strokeWidth = Math.max(1, frame.strokeWidth * canvas.width);
  const attrs = [
    `fill="none"`,
    `stroke="${escapeXml(frame.strokeColor || DEFAULT_PANEL_FRAME.strokeColor)}"`,
    `stroke-width="${fmt(strokeWidth)}"`,
    `stroke-linecap="round"`,
    `stroke-linejoin="round"`,
    `vector-effect="non-scaling-stroke"`
  ].join(" ");
  return renderShapeElement(panel.shape, layout, canvas, attrs);
}

function resolveFrame(frame: PanelFrame | undefined): PanelFrame {
  if (!frame) {
    return DEFAULT_PANEL_FRAME;
  }
  return {
    visible: frame.visible,
    style: frame.style,
    strokeWidth: Number.isFinite(frame.strokeWidth) ? frame.strokeWidth : DEFAULT_PANEL_FRAME.strokeWidth,
    strokeColor: frame.strokeColor || DEFAULT_PANEL_FRAME.strokeColor
  };
}

function renderShapeMaskSvg(shape: PanelShape, layout: PageLayout, canvas: ExportCanvas): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">${renderShapeElement(shape, layout, canvas, `fill="#fff" stroke="none"`)}</svg>`;
}

function renderShapeElement(shape: PanelShape, layout: PageLayout, canvas: ExportCanvas, attrs: string): string {
  const h = layoutHeight(layout);
  if (shape.type === "polygon") {
    const points = shape.points.map((point) => mapPoint(point, h, canvas).map(fmt).join(",")).join(" ");
    return `<polygon points="${points}" ${attrs}/>`;
  }
  if (shape.type === "rect") {
    const [p1x, p1y] = mapPoint([shape.bounds[0], shape.bounds[1]], h, canvas);
    const [p2x, p2y] = mapPoint([shape.bounds[2], shape.bounds[3]], h, canvas);
    const x = Math.min(p1x, p2x);
    const y = Math.min(p1y, p2y);
    const width = Math.abs(p2x - p1x);
    const height = Math.abs(p2y - p1y);
    const radius = typeof shape.cornerRadius === "number"
      ? ` rx="${fmt(shape.cornerRadius * canvas.width)}" ry="${fmt((shape.cornerRadius / h) * canvas.height)}"`
      : "";
    return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}"${radius} ${attrs}/>`;
  }
  if (shape.type === "ellipse") {
    const [cx, cy] = mapPoint(shape.center, h, canvas);
    const rx = shape.radius[0] * canvas.width;
    const ry = (shape.radius[1] / h) * canvas.height;
    return `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(rx)}" ry="${fmt(ry)}" ${attrs}/>`;
  }
  const sx = canvas.width;
  const sy = canvas.height / h;
  return `<path d="${escapeXml(shape.d)}" transform="scale(${fmt(sx)} ${fmt(sy)})" ${attrs}/>`;
}

function mapPoint(point: [number, number], layoutH: number, canvas: ExportCanvas): [number, number] {
  return [point[0] * canvas.width, (point[1] / layoutH) * canvas.height];
}

function layoutHeight(layout: PageLayout): number {
  const height = layout.page.height;
  return Number.isFinite(height) && height > 0 ? height : layout.page.aspectRatio[1] / layout.page.aspectRatio[0];
}

async function renderMergedImage(layers: RasterLayer[], canvas: ExportCanvas): Promise<Buffer> {
  return sharp(blankInput(canvas))
    .composite(layers.map((layer) => ({ input: layer.png, left: 0, top: 0 })))
    .png()
    .toBuffer();
}

function renderStackXml(canvas: ExportCanvas, layers: RasterLayer[]): string {
  const stackLayers = [...layers].reverse();
  return `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.3" w="${canvas.width}" h="${canvas.height}" xres="${DEFAULT_RESOLUTION}" yres="${DEFAULT_RESOLUTION}">
  <stack>
${stackLayers.map((layer) => `    <layer name="${escapeXml(layer.name)}" src="${escapeXml(layer.src)}" x="0" y="0" opacity="1" visibility="visible" composite-op="svg:src-over"/>`).join("\n")}
  </stack>
</image>
`;
}

function blankInput(canvas: ExportCanvas) {
  return {
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4 as const,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  };
}

async function transparentPng(canvas: ExportCanvas): Promise<Buffer> {
  return sharp(blankInput(canvas)).png().toBuffer();
}

async function paperPng(canvas: ExportCanvas): Promise<Buffer> {
  return sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4 as const,
      background: { r: 245, g: 242, b: 234, alpha: 1 }
    }
  }).png().toBuffer();
}

function pageFileBase(page: PageRow): string {
  const number = String(page.pageIndex + 1).padStart(3, "0");
  const title = safeAsciiName(page.title, `page-${number}`);
  return `${number}-${title}`;
}

function safeAsciiName(value: string, fallback: string): string {
  const safe = value
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return safe || fallback;
}

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function fmt(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0";
}
