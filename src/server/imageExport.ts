/**
 * 完成品の画像一括書き出し(Docs/Feature-CGCollectionSuite.md P4)。ページを PNG/JPEG へ平坦化して
 * 単体 or zip(連番)で返す。レイヤ合成・スケーリングは openRasterExport.ts の `createPageLayers`/
 * `renderMergedImage` をそのまま再利用する(P1〜P3 のページオブジェクトも同じ経路で反映される)。
 *
 * ORA と違い、ここでは「ページごとに指定 pixelWidth を満たす解像度」で `createPageLayers` を呼ぶ
 * (= project の canvas_width/height は使わない)。これにより SVG 由来のテキスト/形状は常に
 * 目標解像度で直接描かれる(小さい canvas を後から拡大しない)。
 *
 * PPTX(Docs/Feature-PptxExport.md)は同じ `/export-images` エンドポイントの format 選択肢の1つ
 * (エンドポイント新設はしない)。`format === "pptx"` のときはこのファイルではなく `pptxExport.ts` の
 * `createPptxExport` へ丸ごと委譲する(1ページ=1スライドの OOXML デッキを組み立てる処理は性質が
 * 異なるため分離)。
 */
import sharp from "sharp";
import JSZip from "jszip";
import type { PageRow } from "../shared/apiTypes";
import {
  JPEG_FLATTEN_BACKGROUND,
  computeExportCanvas,
  createPageLayers,
  loadExportPages,
  renderMergedImage,
  requireProject,
  resolvePageHeight,
  safeAsciiName
} from "./openRasterExport";
import { createPptxExport } from "./pptxExport";
import { HttpError } from "./http";
import { objectBody } from "./validate";

// computeExportCanvas は openRasterExport.ts で定義(pptxExport.ts との共用のため)。既存テスト
// (imageExport.test.ts)が `from "./imageExport.ts"` で import しているのでここで re-export する。
export { computeExportCanvas };

export type ImageExportFormat = "png" | "jpeg" | "pptx";

export const DEFAULT_PIXEL_WIDTH = 1280;
export const MIN_PIXEL_WIDTH = 256;
export const MAX_PIXEL_WIDTH = 4096;
export const DEFAULT_JPEG_QUALITY = 90;

export interface ImageExportResult {
  filename: string;
  contentType: string;
  buffer: Buffer;
  pageCount: number;
}

export async function createImageExport(projectId: string, body: unknown): Promise<ImageExportResult> {
  const project = requireProject(projectId);
  const input = objectBody(body);
  const format = parseImageExportFormat(input.format);
  const quality = clampJpegQuality(input.quality);
  const pixelWidth = clampPixelWidth(input.pixelWidth);
  const rawPageIds = input.pageIds;
  const requestedPageIds = Array.isArray(rawPageIds)
    ? rawPageIds.filter((id): id is string => typeof id === "string")
    : null;
  const pages = loadExportPages(projectId, requestedPageIds);
  if (pages.length === 0) {
    throw new HttpError(400, "Image export target pages were not found.");
  }

  if (format === "pptx") {
    // PPTX は常に単一デッキ(複数ページでも zip 化しない)。OOXML 手組みは pptxExport.ts に分離。
    return createPptxExport(project, pages, quality, pixelWidth);
  }

  const extension = format === "jpeg" ? "jpg" : "png";
  const images: Array<{ filename: string; buffer: Buffer }> = [];
  for (const page of pages) {
    images.push({
      filename: `${pageImageFileBase(page.pageIndex)}.${extension}`,
      buffer: await renderPageImage(page, format, quality, pixelWidth)
    });
  }

  if (images.length === 1) {
    return {
      filename: images[0]!.filename,
      contentType: contentTypeFor(format),
      buffer: images[0]!.buffer,
      pageCount: 1
    };
  }

  const zip = new JSZip();
  for (const image of images) {
    zip.file(image.filename, image.buffer, { compression: "DEFLATE" });
  }
  return {
    filename: `${safeAsciiName(project.name, "guruguru-book")}_images.zip`,
    contentType: "application/zip",
    buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    pageCount: images.length
  };
}

async function renderPageImage(
  page: PageRow,
  format: ImageExportFormat,
  quality: number,
  pixelWidth: number
): Promise<Buffer> {
  const layout = page.layout ?? null;
  const pageHeight = resolvePageHeight(page, layout);
  const canvas = computeExportCanvas(pixelWidth, pageHeight);
  const layers = await createPageLayers(page, canvas);
  // 将来のモザイク(P6)は「オブジェクトの上・最前面」のレイヤとして layers に追加される想定
  // (createPageLayers 側に足す)。ここでの平坦化ロジックはレイヤ枚数に依存しないのでそのまま使える。
  const merged = await renderMergedImage(layers, canvas);
  if (format === "png") {
    return merged;
  }
  return sharp(merged).flatten({ background: JPEG_FLATTEN_BACKGROUND }).jpeg({ quality }).toBuffer();
}

function contentTypeFor(format: ImageExportFormat): string {
  return format === "jpeg" ? "image/jpeg" : "image/png";
}

/** `format` の妥当性検証。png/jpeg/pptx 以外は 400。 */
export function parseImageExportFormat(value: unknown): ImageExportFormat {
  if (value === "png" || value === "jpeg" || value === "pptx") {
    return value;
  }
  throw new HttpError(400, `format must be "png", "jpeg", or "pptx"`);
}

/** JPEG の quality(1-100 整数)。未指定/不正値は既定 90。 */
export function clampJpegQuality(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_JPEG_QUALITY;
  return Math.min(100, Math.max(1, Math.round(n)));
}

/** 書き出し解像度の幅(px)。未指定/不正値は既定 1280、256〜4096 に clamp。 */
export function clampPixelWidth(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_PIXEL_WIDTH;
  return Math.min(MAX_PIXEL_WIDTH, Math.max(MIN_PIXEL_WIDTH, Math.round(n)));
}

/** ページ連番のファイル名本体(拡張子なし)。page_index+1 を3桁ゼロ詰め(例: 0 → "001")。 */
export function pageImageFileBase(pageIndex: number): string {
  return String(Math.max(0, Math.trunc(pageIndex)) + 1).padStart(3, "0");
}
