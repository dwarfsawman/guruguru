import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import sharp from "sharp";
import type { PageRow } from "../shared/apiTypes";
import {
  DEFAULT_PANEL_FRAME,
  FULL_PANEL_CROP,
  normalizePanelCrop,
  panelBounds,
  panelImageRect,
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
  type ImageObject,
  type PageObject,
  type PageVec,
  type TextContent,
  type TextObject,
  type ToneObject
} from "../shared/pageObjects";
import { escapeHtml } from "../shared/htmlEscape";
import { mosaicBlockSizePx, regionBoundsPage, type MosaicRegion, type MosaicShape } from "../shared/mosaicRegion";
import { balloonContentMaxWidth, renderBalloonSvg } from "../shared/balloonShape";
import { renderTextSvg } from "../shared/textSvg";
import { renderToneSvg } from "../shared/toneSvg";
import { getRow, getRows, toApiRow } from "./db";
import {
  finalizeFileExport,
  withMeasuredFileExport,
  type FileExportMetrics,
  type FileExportResult
} from "./fileExport";
import { HttpError } from "./http";
import { packArchiveWithRust, type ArchivePackEntry } from "./projectArchive";
import { ensureAssetThumbnail } from "./storage";
import { computeTextLayoutForContent } from "./textLayoutApi";
import { objectBody } from "./validate";

const OPENRASTER_MIME = "image/openraster";
const DEFAULT_CANVAS_WIDTH = 1024;
const DEFAULT_CANVAS_HEIGHT = 1446;
const DEFAULT_RESOLUTION = 300;
/** レイアウト/代表アセットどちらからも解決できない時のページ高さフォールバック(pageLayout.ts の resolveHeight と同じ値)。 */
const FALLBACK_OBJECTS_PAGE_HEIGHT = 1.4142;

export interface ExportProjectRow {
  id: string;
  name: string;
  canvas_width: number | null;
  canvas_height: number | null;
}

export interface ExportCanvas {
  width: number;
  height: number;
}

/**
 * JPEG 書き出しのフラット化背景色(白)。透過は使えないため合成前にこの色で塗り潰す。
 * imageExport.ts(P4 画像一括書き出し、format="jpeg")が使う。PPTX への埋め込みは PNG のため
 * pptxExport.ts はこの定数を使わない(埋め込みが PNG である旨は pptxExport.ts のファイル冒頭コメントを参照)。
 */
export const JPEG_FLATTEN_BACKGROUND = { r: 255, g: 255, b: 255 };

/**
 * pixelWidth(幅) と pageHeightRatio(ページ座標系での高さ。page-width=1 単位)から、
 * その比率を保った書き出し用 canvas 解像度を計算する(高さは切り上げ最小1px)。
 * imageExport.ts(P4)と pptxExport.ts が共用する(pptxExport.ts が imageExport.ts を import すると
 * createImageExport→createPptxExport の呼び出しと循環 import になるため、共用先はここに置く)。
 */
export function computeExportCanvas(pixelWidth: number, pageHeightRatio: number): ExportCanvas {
  return { width: pixelWidth, height: Math.max(1, Math.round(pixelWidth * pageHeightRatio)) };
}

interface ExportAssetRow {
  id: string;
  image_path: string;
  thumbnail_small_path: string;
  thumbnail_medium_path: string;
  width: number | null;
  height: number | null;
}

type RasterAssetSource = "original" | "thumbnail-small" | "thumbnail-medium";

interface CreatePageLayersOptions {
  assetSource?: RasterAssetSource;
  /** preview 時だけ ImageObject の page_media もこの最大辺まで縮小してから SVG へ埋め込む。 */
  mediaMaxDimension?: number;
}

interface PanelAssignmentAssetRow extends ExportAssetRow {
  panel_id: string;
  crop_json: string;
}

export interface RasterLayer {
  name: string;
  src: string;
  png: Buffer;
}

export type OpenRasterExportResult = FileExportResult;

export async function withOpenRasterExport<T>(
  projectId: string,
  body: unknown,
  operation: (artifact: OpenRasterExportResult) => Promise<T>
): Promise<T> {
  return withMeasuredFileExport(
    "openraster",
    "openraster",
    "ora",
    (tempDir, metrics) => createOpenRasterExport(projectId, body, tempDir, metrics),
    operation
  );
}

async function createOpenRasterExport(
  projectId: string,
  body: unknown,
  tempDir: string,
  metrics: FileExportMetrics
): Promise<OpenRasterExportResult> {
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
  const oras: Array<{ filename: string; path: string }> = [];
  for (const [index, page] of pages.entries()) {
    oras.push(await createPageOra(page, canvas, tempDir, index, metrics));
  }

  if (oras.length === 1) {
    return finalizeFileExport(
      {
        filename: oras[0]!.filename,
        contentType: OPENRASTER_MIME,
        artifactPath: oras[0]!.path,
        pageCount: 1,
        metrics
      },
      "OpenRasterの作成結果が空です。"
    );
  }

  const artifactPath = join(tempDir, "openraster.zip");
  const zipStartedAt = performance.now();
  await packArchiveWithRust(
    oras.map((ora) => ({ source: ora.path, archivePath: ora.filename, compression: "store" })),
    artifactPath,
    join(tempDir, "openraster-entries.json")
  );
  metrics.zipMs += performance.now() - zipStartedAt;
  return finalizeFileExport(
    {
      filename: `${safeAsciiName(project.name, "guruguru-book")}-openraster.zip`,
      contentType: "application/zip",
      artifactPath,
      pageCount: oras.length,
      metrics
    },
    "OpenRaster ZIPの作成結果が空です。"
  );
}

export function requireProject(projectId: string): ExportProjectRow {
  const project = getRow<ExportProjectRow>(
    "SELECT id, name, canvas_width, canvas_height FROM projects WHERE id = ?",
    [projectId]
  );
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
  return project;
}

export function loadExportPages(projectId: string, pageIds: string[] | null): PageRow[] {
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

async function createPageOra(
  page: PageRow,
  canvas: ExportCanvas,
  tempDir: string,
  pageIndex: number,
  metrics: FileExportMetrics
): Promise<{ filename: string; path: string }> {
  const renderStartedAt = performance.now();
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
  const prefix = `ora-${String(pageIndex + 1).padStart(4, "0")}`;
  let sourceIndex = 0;
  const entries: ArchivePackEntry[] = [];
  const writeEntry = async (
    archivePath: string,
    bytes: string | Buffer,
    compression: ArchivePackEntry["compression"]
  ) => {
    sourceIndex += 1;
    const source = join(tempDir, `${prefix}-source-${String(sourceIndex).padStart(4, "0")}`);
    await writeFile(source, bytes, typeof bytes === "string" ? { encoding: "utf8", flag: "wx" } : { flag: "wx" });
    metrics.inputBytes += typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
    entries.push({ source, archivePath, compression });
  };

  // OpenRaster仕様上、mimetypeは必ず先頭かつSTORE。
  await writeEntry("mimetype", OPENRASTER_MIME, "store");
  await writeEntry("stack.xml", stackXml, "deflate");
  for (const layer of indexed) {
    await writeEntry(layer.src, layer.png, "store");
  }
  await writeEntry("mergedimage.png", merged, "store");
  await writeEntry("Thumbnails/thumbnail.png", thumbnail, "store");
  metrics.renderMs += performance.now() - renderStartedAt;

  const path = join(tempDir, `${prefix}.ora`);
  const zipStartedAt = performance.now();
  await packArchiveWithRust(entries, path, join(tempDir, `${prefix}-entries.json`));
  metrics.zipMs += performance.now() - zipStartedAt;
  return { filename: `${pageFileBase(page)}.ora`, path };
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
  const sourceCanvas = projectCanvas(project);
  const size = safeDimension(options.size, 512);
  const scale = Math.min(1, size / Math.max(sourceCanvas.width, sourceCanvas.height));
  const canvas = {
    width: Math.max(1, Math.round(sourceCanvas.width * scale)),
    height: Math.max(1, Math.round(sourceCanvas.height * scale))
  };
  const layers = await createPageLayers(page, canvas, {
    assetSource: size <= 320 ? "thumbnail-small" : size <= 768 ? "thumbnail-medium" : "original",
    mediaMaxDimension: size
  });
  const merged = await renderMergedImage(layers, canvas);
  return merged;
}

/**
 * ページ1件分のレイヤー配列を、指定した `canvas` 解像度でラスタライズする。ORA 出力・preview.png・
 * 画像一括書き出し(P4)がすべてこの関数を通る -- `canvas` は呼び出し側が渡す任意の解像度でよく
 * (project の canvas_width/height である必要はない)、mapPoint 等はすべて canvas.width/height 基準で
 * スケールするため、そのまま高解像度書き出しに転用できる。
 */
export async function createPageLayers(
  page: PageRow,
  canvas: ExportCanvas,
  options: CreatePageLayersOptions = {}
): Promise<RasterLayer[]> {
  const assetSource = options.assetSource ?? "original";
  const paperLayer: RasterLayer = { name: "Paper", src: "", png: await paperPng(canvas) };
  const layout = page.layout ?? null;
  if (!layout) {
    const representative = representativeAsset(page.id);
    const layers: RasterLayer[] = [
      paperLayer,
      {
        name: "Page image",
        src: "",
        png: representative ? await renderFullImageLayer(representative, canvas, assetSource) : await transparentPng(canvas)
      }
    ];
    // 描画順(Docs/Feature-ScriptToManga.md S2、全経路共通): Paper → コマ画像 → [image back帯] →
    // コマ枠(レイアウト無しページには無い)→ [front帯] → Mosaic。
    await appendObjectsLayer(layers, page, null, canvas, "back", options.mediaMaxDimension);
    await appendObjectsLayer(layers, page, null, canvas, "front", options.mediaMaxDimension);
    await appendMosaicLayer(layers, page, null, canvas);
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
      png: await renderPanelImageLayer(assignment, panel, layout, canvas, assetSource)
    });
  }

  if (layers.length === 0) {
    const representative = representativeAsset(page.id);
    if (representative) {
      layers.push({ name: "Page image", src: "", png: await renderFullImageLayer(representative, canvas, assetSource) });
    }
  }

  // image オブジェクトの back 帯(Docs/Feature-ScriptToManga.md S2): コマ画像の後・コマ枠の前
  // (ぶち抜き立ち絵がコマ枠に隠れず、コマ画像より手前に見える)。
  await appendObjectsLayer(layers, page, layout, canvas, "back", options.mediaMaxDimension);

  const frameLayer = await renderPanelFrameLayer(layout, canvas);
  if (frameLayer) {
    layers.push({ name: "Panels", src: "", png: frameLayer });
  }
  if (layers.length === 0) {
    layers.push({ name: "Blank page", src: "", png: await transparentPng(canvas) });
  }
  // ページオブジェクト(Docs/Feature-CGCollectionSuite.md P1)。コマ枠より前面、配列順(先頭=背面)。
  await appendObjectsLayer(layers, page, layout, canvas, "front", options.mediaMaxDimension);
  // モザイク(Docs/Feature-CGCollectionSuite.md P6)。最前面・必須で最後。
  await appendMosaicLayer(layers, page, layout, canvas);
  return layers;
}

/** image オブジェクトのうち back 帯に属するか(既定は front)。 */
function isBackBandObject(object: PageObject): boolean {
  return object.kind === "image" && object.band === "back";
}

/**
 * ページオブジェクトレイヤーを帯(back/front、Docs/Feature-ScriptToManga.md S2)でフィルタして最大2回
 * 追加する。何も描く物が無ければ何もしない(空の透明レイヤーを作って合成コストをかけない)。
 * レイヤー名は back 帯が "Objects (back)"、front 帯(text/balloon/box は常にここ)が "Objects"。
 */
async function appendObjectsLayer(
  layers: RasterLayer[],
  page: PageRow,
  layout: PageLayout | null,
  canvas: ExportCanvas,
  band: "back" | "front",
  mediaMaxDimension?: number
): Promise<void> {
  const pageHeight = resolvePageHeight(page, layout);
  const list = (page.objects ?? []).filter((object) => (band === "back" ? isBackBandObject(object) : !isBackBandObject(object)));
  const png = await renderObjectsLayer(list, pageHeight, canvas, layout, mediaMaxDimension);
  if (png) {
    layers.push({ name: band === "back" ? "Objects (back)" : "Objects", src: "", png });
  }
}

/**
 * ページオブジェクト座標系での「ページの高さ」(page-width=1 単位)。レイアウトが有ればコマ座標系の
 * 高さ(layoutHeight)、無ければ代表アセットのアスペクト比 → フォールバック順。
 * 画像一括書き出し(P4)がページごとの解像度(pixelWidth × この値)を計算する時にも使う。
 */
export function resolvePageHeight(page: PageRow, layout: PageLayout | null): number {
  return layout ? layoutHeight(layout) : resolveObjectsPageHeight(page);
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
 * モザイク(Docs/Feature-CGCollectionSuite.md P6)レイヤーを最前面に追加する。リージョンが1つも無ければ
 * 何もしない(空の透明レイヤーを作って合成コストをかけない、`appendObjectsLayer` と同じ規約)。
 * モザイク化には「そのページの下層(Paper〜Objects)を合成した結果」が要る(透明レイヤーをモザイク化
 * しても無意味なため) -- ここまでに積んだ `layers` を一度 `renderMergedImage` でマージしてから使う。
 */
async function appendMosaicLayer(layers: RasterLayer[], page: PageRow, layout: PageLayout | null, canvas: ExportCanvas): Promise<void> {
  const regions = page.mosaic ?? [];
  if (regions.length === 0) {
    return;
  }
  const pageHeight = resolvePageHeight(page, layout);
  const merged = await renderMergedImage(layers, canvas);
  const png = await renderMosaicLayerPng(merged, regions, pageHeight, canvas);
  if (png) {
    layers.push({ name: "Mosaic", src: "", png });
  }
}

/** リージョンの外接矩形(page 座標)を canvas ピクセル矩形へ変換する。canvas 範囲内に収まらなければ null。 */
function regionPixelBox(
  region: MosaicRegion,
  pageHeight: number,
  canvas: ExportCanvas
): { left: number; top: number; width: number; height: number } | null {
  const [minX, minY, maxX, maxY] = regionBoundsPage(region);
  const [x1, y1] = mapPoint([minX, minY], pageHeight, canvas);
  const [x2, y2] = mapPoint([maxX, maxY], pageHeight, canvas);
  const left = Math.max(0, Math.floor(Math.min(x1, x2)));
  const top = Math.max(0, Math.floor(Math.min(y1, y2)));
  const right = Math.min(canvas.width, Math.ceil(Math.max(x1, x2)));
  const bottom = Math.min(canvas.height, Math.ceil(Math.max(y1, y2)));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { left, top, width, height };
}

/**
 * モザイクレイヤーの本体。リージョンごとに「下層の合成結果」から bbox を切り出し、ブロック単位で
 * 平均色に量子化(`pixelateRegionBuffer`) → 形状マスクで dest-in(rect は bbox=形状なので実質無効化、
 * polygon は bbox 内の形状外を透明化)→ 透明キャンバスへ合成、を積み重ねる。何も描けなければ null。
 */
async function renderMosaicLayerPng(
  mergedSoFar: Buffer,
  regions: MosaicRegion[],
  pageHeight: number,
  canvas: ExportCanvas
): Promise<Buffer | null> {
  let composed: Buffer | null = null;
  const longSide = Math.max(canvas.width, canvas.height);
  for (const region of regions) {
    const bbox = regionPixelBox(region, pageHeight, canvas);
    if (!bbox) {
      continue;
    }
    const blockSize = mosaicBlockSizePx(longSide, region.granularity);
    const pixelated = await pixelateRegionBuffer(mergedSoFar, bbox, blockSize);
    const maskExtract = await sharp(Buffer.from(renderMosaicMaskSvg(region, pageHeight, canvas)))
      .extract(bbox)
      .png()
      .toBuffer();
    const masked = await sharp(pixelated)
      .composite([{ input: maskExtract, blend: "dest-in" }])
      .png()
      .toBuffer();
    const base: Buffer = composed ?? (await transparentPng(canvas));
    composed = await sharp(base)
      .composite([{ input: masked, left: bbox.left, top: bbox.top }])
      .png()
      .toBuffer();
  }
  return composed;
}

/**
 * `bbox` 範囲を `blockSize`px 四方のブロックへ量子化する(各ブロックは平均色で塗り潰す)。sharp の
 * resize(縮小)→resize(拡大, nearest) ではブロック境界が非整数倍率で±1px ずれ得るため、規定の
 * 「1粒 ≧ 規定値」を確実に満たすよう生ピクセルを直接処理する(末端の欠けブロックのみ規定サイズ未満になり得るが、
 * それは bbox 境界の必然的な端数であり規定違反ではない)。
 */
async function pixelateRegionBuffer(
  source: Buffer,
  bbox: { left: number; top: number; width: number; height: number },
  blockSize: number
): Promise<Buffer> {
  const { data, info } = await sharp(source).extract(bbox).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const out = Buffer.alloc(data.length);
  const block = Math.max(1, Math.round(blockSize));
  for (let by = 0; by < height; by += block) {
    const cellH = Math.min(block, height - by);
    for (let bx = 0; bx < width; bx += block) {
      const cellW = Math.min(block, width - bx);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const count = cellW * cellH;
      for (let y = 0; y < cellH; y += 1) {
        const rowOffset = (by + y) * width * channels;
        for (let x = 0; x < cellW; x += 1) {
          const idx = rowOffset + (bx + x) * channels;
          r += data[idx]!;
          g += data[idx + 1]!;
          b += data[idx + 2]!;
          a += data[idx + 3]!;
        }
      }
      const avgR = Math.round(r / count);
      const avgG = Math.round(g / count);
      const avgB = Math.round(b / count);
      const avgA = Math.round(a / count);
      for (let y = 0; y < cellH; y += 1) {
        const rowOffset = (by + y) * width * channels;
        for (let x = 0; x < cellW; x += 1) {
          const idx = rowOffset + (bx + x) * channels;
          out[idx] = avgR;
          out[idx + 1] = avgG;
          out[idx + 2] = avgB;
          out[idx + 3] = avgA;
        }
      }
    }
  }
  return sharp(out, { raw: { width, height, channels } }).png().toBuffer();
}

/** モザイクリージョン形状のマスク SVG(白塗り・背景透明)。canvas フルサイズで描き、呼び出し側が bbox で extract する。 */
function renderMosaicMaskSvg(region: MosaicRegion, pageHeight: number, canvas: ExportCanvas): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">${renderMosaicShapeElement(region.shape, pageHeight, canvas, `fill="#fff" stroke="none"`)}</svg>`;
}

function renderMosaicShapeElement(shape: MosaicShape, pageHeight: number, canvas: ExportCanvas, attrs: string): string {
  if (shape.type === "rect") {
    const [x, y, w, h] = shape.bounds;
    const [x1, y1] = mapPoint([x, y], pageHeight, canvas);
    const [x2, y2] = mapPoint([x + w, y + h], pageHeight, canvas);
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    return `<rect x="${fmt(left)}" y="${fmt(top)}" width="${fmt(Math.abs(x2 - x1))}" height="${fmt(Math.abs(y2 - y1))}" ${attrs}/>`;
  }
  const points = shape.points.map((point) => mapPoint(point, pageHeight, canvas).map(fmt).join(",")).join(" ");
  return `<polygon points="${points}" ${attrs}/>`;
}

/**
 * ページオブジェクトを SVG でラスタライズしたレイヤー。何も描く物が無ければ null
 * (パネル枠と同じ「無ければ null」規約)。box は P1、text は P2、balloon(本体+しっぽ+content)は P3、
 * image は S2(Docs/Feature-ScriptToManga.md)。image は asset 読み込みが async なので、事前に
 * mediaId→dataURI マップを解決してから(`resolveImageMediaDataUris`)同期レンダリングに渡す。
 */
async function renderObjectsLayer(
  objects: PageObject[] | null | undefined,
  pageHeight: number,
  canvas: ExportCanvas,
  layout: PageLayout | null,
  mediaMaxDimension?: number
): Promise<Buffer | null> {
  const list = objects ?? [];
  if (list.length === 0) {
    return null;
  }
  const mediaDataUris = await resolveImageMediaDataUris(list, mediaMaxDimension);
  const elements = list
    .map((object) => renderPageObjectElement(object, pageHeight, canvas, layout, mediaDataUris))
    .filter(Boolean)
    .join("");
  if (!elements) {
    return null;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">${elements}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function renderPageObjectElement(
  object: PageObject,
  pageHeight: number,
  canvas: ExportCanvas,
  layout: PageLayout | null,
  mediaDataUris: Map<string, string | null>
): string {
  if (object.kind === "box") {
    return renderBoxObjectElement(object, pageHeight, canvas) + renderContentElement(object.content, object.position, object.rotation, object.size, pageHeight, canvas);
  }
  if (object.kind === "text") {
    return renderTextObjectElement(object, pageHeight, canvas);
  }
  if (object.kind === "image") {
    return renderImageObjectElement(object, pageHeight, canvas, layout, mediaDataUris);
  }
  if (object.kind === "tone") {
    return renderToneObjectElement(object, pageHeight, canvas, layout);
  }
  return renderBalloonObjectElement(object, pageHeight, canvas);
}

/**
 * `page.objects` が参照する mediaId を dataURI へ解決する(Docs/Feature-ScriptToManga.md S2)。
 * page_media 行が無い/ファイルが読めない場合は null を入れ、警告ログを出してスキップする
 * (`renderImageObjectElement` が null なら要素を描かない)。黙って落とさない。
 */
async function resolveImageMediaDataUris(
  objects: PageObject[],
  maxDimension?: number
): Promise<Map<string, string | null>> {
  const mediaIds = new Set<string>();
  for (const object of objects) {
    if (object.kind === "image") {
      mediaIds.add(object.mediaId);
    }
  }
  const map = new Map<string, string | null>();
  for (const mediaId of mediaIds) {
    const row = getRow<{ file_path: string }>("SELECT file_path FROM page_media WHERE id = ?", [mediaId]);
    if (!row) {
      console.warn(`[openRasterExport] page_media row not found for mediaId=${mediaId}; skipping ImageObject`);
      map.set(mediaId, null);
      continue;
    }
    try {
      if (maxDimension) {
        const bytes = await sharp(row.file_path, { failOn: "none" })
          .rotate()
          .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
          .png()
          .toBuffer();
        map.set(mediaId, `data:image/png;base64,${bytes.toString("base64")}`);
      } else {
        const bytes = await readFile(row.file_path);
        map.set(mediaId, `data:${mimeTypeFor(row.file_path)};base64,${bytes.toString("base64")}`);
      }
    } catch {
      console.warn(`[openRasterExport] page_media file missing for mediaId=${mediaId} (${row.file_path}); skipping ImageObject`);
      map.set(mediaId, null);
    }
  }
  return map;
}

function mimeTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  return "image/png";
}

/**
 * 画像オブジェクト1件(Docs/Feature-ScriptToManga.md S2)。data URI 埋め込み `<image>`
 * (前例: renderRotatedPanelImageLayer)。clipPanelId があればコマ形状の clipPath を defs に出し、
 * 外側 g=clip / 内側 image=rotate の二層にする(renderAssignmentImage と同じ理由)。
 * mediaDataUris に無い(欠損)場合は空文字を返す(呼び出し側が既に警告ログを出している)。
 */
function renderImageObjectElement(
  object: ImageObject,
  pageHeight: number,
  canvas: ExportCanvas,
  layout: PageLayout | null,
  mediaDataUris: Map<string, string | null>
): string {
  const dataUri = mediaDataUris.get(object.mediaId);
  if (!dataUri) {
    return "";
  }
  const [x1, y1] = mapPoint([object.position.x - object.size.x / 2, object.position.y - object.size.y / 2], pageHeight, canvas);
  const [x2, y2] = mapPoint([object.position.x + object.size.x / 2, object.position.y + object.size.y / 2], pageHeight, canvas);
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  const [cx, cy] = mapPoint([object.position.x, object.position.y], pageHeight, canvas);
  const deg = (object.rotation * 180) / Math.PI;
  const opacity = object.opacity ?? 1;
  const transform = deg ? ` transform="rotate(${fmt(deg)} ${fmt(cx)} ${fmt(cy)})"` : "";
  const image = `<image href="${dataUri}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="none" opacity="${fmt(opacity)}"${transform} />`;

  const clipPanel = object.clipPanelId && layout ? layout.panels.find((panel) => panel.id === object.clipPanelId) : null;
  if (!clipPanel) {
    return image;
  }
  const clipId = `image-object-clip-${object.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return `<defs><clipPath id="${clipId}">${renderShapeElement(clipPanel.shape, layout!, canvas, `fill="#fff"`)}</clipPath></defs><g clip-path="url(#${clipId})">${image}</g>`;
}

/**
 * トーン1件(Docs/Feature-ScreenTones.md)。本体は `renderToneSvg`(クライアント/サーバ共用の純ロジック)に
 * ローカル単位(anchor=0,0/rotation=0)で描かせ、外側の `<g>` で pixel 空間へ translate→rotate→scale する
 * -- `renderBalloonObjectElement` と全く同じパターン。clipPanelId があればコマ形状の clipPath を defs に
 * 出し、外側 g=clip / 内側 g=トーン本体(renderToneSvg 自身の領域 clipPath を内包)の二層にする
 * (`renderImageObjectElement` と同じ理由・同じ構成 -- outer の `<g clip-path>` 自身には transform を
 * 付けないので、clipPath の座標系(canvas pixel 空間)と wrapped 側の外側 transform 適用後の見た目が
 * 正しく重なる)。
 */
function renderToneObjectElement(object: ToneObject, pageHeight: number, canvas: ExportCanvas, layout: PageLayout | null): string {
  const [anchorX, anchorY] = mapPoint([object.position.x, object.position.y], pageHeight, canvas);
  const deg = (object.rotation * 180) / Math.PI;
  const scaleX = canvas.width;
  const scaleY = canvas.height / pageHeight;
  const shape = renderToneSvg(object, { x: 0, y: 0 }, 0);
  const wrapped = `<g transform="translate(${fmt(anchorX)} ${fmt(anchorY)})${deg ? ` rotate(${fmt(deg)})` : ""} scale(${fmt(scaleX)} ${fmt(scaleY)})">${shape}</g>`;

  const clipPanel = object.clipPanelId && layout ? layout.panels.find((panel) => panel.id === object.clipPanelId) : null;
  if (!clipPanel) {
    return wrapped;
  }
  const clipId = `tone-object-clip-${object.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return `<defs><clipPath id="${clipId}">${renderShapeElement(clipPanel.shape, layout!, canvas, `fill="#fff"`)}</clipPath></defs><g clip-path="url(#${clipId})">${wrapped}</g>`;
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
    `SELECT a.id, a.image_path, a.thumbnail_small_path, a.thumbnail_medium_path, a.width, a.height
     FROM assets a JOIN generation_rounds r ON r.id = a.round_id
     WHERE r.page_id = ? AND a.status IN ('selected', 'favorite')
     ORDER BY a.created_at DESC LIMIT 1`,
    [pageId]
  );
  if (selected) {
    return selected;
  }
  return getRow<ExportAssetRow>(
    `SELECT a.id, a.image_path, a.thumbnail_small_path, a.thumbnail_medium_path, a.width, a.height
     FROM assets a JOIN generation_rounds r ON r.id = a.round_id
     WHERE r.page_id = ?
     ORDER BY a.created_at DESC LIMIT 1`,
    [pageId]
  );
}

function panelAssignmentAssets(pageId: string): PanelAssignmentAssetRow[] {
  return getRows<PanelAssignmentAssetRow>(
    `SELECT ppa.panel_id, ppa.crop_json, a.id, a.image_path, a.thumbnail_small_path, a.thumbnail_medium_path, a.width, a.height
     FROM page_panel_assignments ppa
     JOIN assets a ON a.id = ppa.asset_id
     WHERE ppa.page_id = ?
     ORDER BY ppa.updated_at ASC`,
    [pageId]
  );
}

async function renderFullImageLayer(
  asset: ExportAssetRow,
  canvas: ExportCanvas,
  source: RasterAssetSource
): Promise<Buffer> {
  const imagePath = await assetImagePath(asset, source);
  return sharp(imagePath, { failOn: "none" })
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
  canvas: ExportCanvas,
  source: RasterAssetSource
): Promise<Buffer> {
  const imagePath = await assetImagePath(assignment, source);
  const crop = parseCrop(assignment.crop_json);
  const metadata = await sharp(imagePath, { failOn: "none" }).rotate().metadata();
  const sourceWidth = source === "original" ? assignment.width ?? metadata.width ?? 1 : metadata.width ?? 1;
  const sourceHeight = source === "original" ? assignment.height ?? metadata.height ?? 1 : metadata.height ?? 1;
  // 回転ありは、コマ内生成プレビュー(pagePanelLightboxView)と同じ SVG transform で描き、見た目を一致させる。
  if (crop.rotation && Math.abs(crop.rotation) > 1e-6) {
    return renderRotatedPanelImageLayer(imagePath, panel, layout, canvas, crop, sourceWidth, sourceHeight);
  }
  // 等倍描画(panelImageRect): 画像全体を一様スケールで置き、コマを覆えない部分は下の紙面(白)を見せる。
  const bounds = panelBounds(panel.shape);
  const rect = panelImageRect(bounds, crop, sourceWidth, sourceHeight);
  const h = layoutHeight(layout);
  const drawnLeft = Math.round(rect.x * canvas.width);
  const drawnTop = Math.round((rect.y / h) * canvas.height);
  const drawnWidth = Math.max(1, Math.round(rect.width * canvas.width));
  const drawnHeight = Math.max(1, Math.round((rect.height / h) * canvas.height));
  // sharp の composite は負オフセット不可なので、canvas 外へはみ出す分を先に切り落とす。
  const cutLeft = Math.max(0, -drawnLeft);
  const cutTop = Math.max(0, -drawnTop);
  const visibleWidth = Math.min(drawnWidth - cutLeft, canvas.width - Math.max(0, drawnLeft));
  const visibleHeight = Math.min(drawnHeight - cutTop, canvas.height - Math.max(0, drawnTop));
  let layer: Buffer;
  if (visibleWidth < 1 || visibleHeight < 1) {
    layer = await sharp(blankInput(canvas)).png().toBuffer();
  } else {
    const panelImage = await sharp(imagePath, { failOn: "none" })
      .rotate()
      .resize(drawnWidth, drawnHeight, { fit: "fill" })
      .extract({ left: cutLeft, top: cutTop, width: visibleWidth, height: visibleHeight })
      .ensureAlpha()
      .png()
      .toBuffer();
    layer = await sharp(blankInput(canvas))
      .composite([{ input: panelImage, left: Math.max(0, drawnLeft), top: Math.max(0, drawnTop) }])
      .png()
      .toBuffer();
  }
  return sharp(layer)
    .composite([{ input: Buffer.from(renderShapeMaskSvg(panel.shape, layout, canvas)), blend: "dest-in" }])
    .png()
    .toBuffer();
}

/**
 * 回転あり crop のパネルレイヤー。プレビューと同型に「clip を持つ外側 `<g>` + 回転する内側 `<image>`」
 * の SVG を canvas 解像度でラスタライズする。ソース画像は auto-orient 済み PNG を data URI で埋め込む。
 */
async function renderRotatedPanelImageLayer(
  imagePath: string,
  panel: LayoutPanel,
  layout: PageLayout,
  canvas: ExportCanvas,
  crop: PanelCrop,
  sourceWidth: number,
  sourceHeight: number
): Promise<Buffer> {
  const oriented = await sharp(imagePath, { failOn: "none" }).rotate().png().toBuffer();
  const dataUri = `data:image/png;base64,${oriented.toString("base64")}`;
  const bounds = panelBounds(panel.shape);
  const rect = panelImageRect(bounds, crop, sourceWidth, sourceHeight);
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

async function assetImagePath(asset: ExportAssetRow, source: RasterAssetSource): Promise<string> {
  if (source === "original") {
    return asset.image_path;
  }
  const size = source === "thumbnail-small" ? "small" : "medium";
  const thumbnailPath = size === "small" ? asset.thumbnail_small_path : asset.thumbnail_medium_path;
  try {
    return await ensureAssetThumbnail(asset.image_path, thumbnailPath, size);
  } catch (error) {
    console.warn(`[openRasterExport] thumbnail repair failed for asset=${asset.id}; using original`, error);
    return asset.image_path;
  }
}

function parseCrop(raw: string): PanelCrop {
  try {
    return normalizePanelCrop(JSON.parse(raw)) ?? { ...FULL_PANEL_CROP };
  } catch {
    return { ...FULL_PANEL_CROP };
  }
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

/** レイヤー配列を1枚に平坦化した PNG(RGBA)。ORA の mergedimage.png・preview.png・画像一括書き出し(P4)で共用。 */
export async function renderMergedImage(layers: RasterLayer[], canvas: ExportCanvas): Promise<Buffer> {
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

export function safeAsciiName(value: string, fallback: string): string {
  const safe = value
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return safe || fallback;
}

/** XML テキスト/属性値のエスケープ。shared/htmlEscape.ts の escapeHtml と同一挙動のため統合(alias 維持)。 */
export const escapeXml = escapeHtml;

function fmt(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0";
}
