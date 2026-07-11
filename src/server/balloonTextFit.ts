import { balloonContentMaxWidth, balloonInscribedFactor } from "../shared/balloonShape";
import { CONTENT_PADDING_RATIO, normalizePageObjects, type BalloonObject } from "../shared/pageObjects";
import { getRow, runSql } from "./db";
import { HttpError } from "./http";
import { computeTextLayoutForContent } from "./textLayoutApi";

interface PageRow {
  objects_json: string | null;
}

export interface BalloonTextFitResult {
  fitted: number;
  unchanged: number;
  minFontSizeReached: number;
}

const MIN_AUTO_FONT_SIZE = 0.008;
const FIT_TOLERANCE = 1e-6;

/** 実際の書き出しと同じ折返し幅/bboxで、文字が形状の内接矩形へ収まるまで縮小する。 */
export function fitPageBalloonText(projectId: string, pageId: string): BalloonTextFitResult {
  const page = getRow<PageRow>("SELECT objects_json FROM pages WHERE id = ? AND project_id = ?", [pageId, projectId]);
  if (!page) throw new HttpError(404, "Page was not found in this project");
  const objects = normalizePageObjects(page.objects_json ? JSON.parse(page.objects_json) : []);
  let fitted = 0;
  let unchanged = 0;
  let minFontSizeReached = 0;

  for (const object of objects) {
    if (object.kind !== "balloon" || !object.content?.text) continue;
    if (fitBalloonText(object)) fitted += 1;
    else unchanged += 1;
    if ((object.content.style.size ?? 0) <= MIN_AUTO_FONT_SIZE + FIT_TOLERANCE) minFontSizeReached += 1;
  }
  runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?", [
    JSON.stringify(objects),
    pageId,
    projectId
  ]);
  return { fitted, unchanged, minFontSizeReached };
}

export function fitBalloonText(object: BalloonObject): boolean {
  const content = object.content;
  if (!content?.text) return false;
  const factor = balloonInscribedFactor(object.shape);
  const availableWidth = object.size.x * (1 - CONTENT_PADDING_RATIO) * factor;
  const availableHeight = object.size.y * (1 - CONTENT_PADDING_RATIO) * factor;
  const originalSize = content.style.size;
  let size = originalSize;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    content.style.size = size;
    const maxWidth = balloonContentMaxWidth(object.shape, object.size, content.style.direction);
    const layout = computeTextLayoutForContent(content, maxWidth);
    const width = Math.max(0, layout.bbox.maxX - layout.bbox.minX);
    const height = Math.max(0, layout.bbox.maxY - layout.bbox.minY);
    if (width <= availableWidth + FIT_TOLERANCE && height <= availableHeight + FIT_TOLERANCE) {
      return size < originalSize - FIT_TOLERANCE;
    }
    const widthRatio = availableWidth / Math.max(width, FIT_TOLERANCE);
    const heightRatio = availableHeight / Math.max(height, FIT_TOLERANCE);
    const ratio = Math.min(0.92, widthRatio, heightRatio);
    size = Math.max(MIN_AUTO_FONT_SIZE, size * Math.max(0.5, ratio * 0.96));
    if (size <= MIN_AUTO_FONT_SIZE + FIT_TOLERANCE) {
      content.style.size = MIN_AUTO_FONT_SIZE;
    }
  }
  return content.style.size < originalSize - FIT_TOLERANCE;
}
