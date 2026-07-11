import { normalizeEditedPageLayout, panelBounds, type PageLayout } from "../shared/pageLayout";
import { normalizePageObjects, type BalloonObject, type PageObject, type PageVec } from "../shared/pageObjects";
import { getRow, getRows, runSql } from "./db";
import { HttpError } from "./http";
import { objectBody } from "./validate";

interface PageRow {
  layout_json: string | null;
  objects_json: string | null;
}

interface FaceInput {
  mouth: PageVec;
  score: number;
  /** asset 正規化座標。しっぽを唇へ密着させず、顔サイズ比例の余白を取るために使う。 */
  bbox?: { x: number; y: number; width: number; height: number };
}

interface PanelFacesInput {
  panelId: string;
  faces: FaceInput[];
}

interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parsePanels(value: unknown): PanelFacesInput[] {
  if (!Array.isArray(value)) throw new HttpError(400, "panels must be an array");
  return value.flatMap((raw): PanelFacesInput[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.panelId !== "string" || !Array.isArray(item.faces)) return [];
    const faces = item.faces.flatMap((face): FaceInput[] => {
      if (!face || typeof face !== "object") return [];
      const candidate = face as Record<string, unknown>;
      const mouth = candidate.mouth as Record<string, unknown> | undefined;
      if (!mouth || !finite(mouth.x) || !finite(mouth.y)) return [];
      const rawBbox = candidate.bbox as Record<string, unknown> | undefined;
      const bbox = rawBbox && finite(rawBbox.x) && finite(rawBbox.y) && finite(rawBbox.width) && finite(rawBbox.height)
        ? { x: rawBbox.x, y: rawBbox.y, width: rawBbox.width, height: rawBbox.height }
        : undefined;
      return [{ mouth: { x: mouth.x, y: mouth.y }, score: finite(candidate.score) ? candidate.score : 1, ...(bbox ? { bbox } : {}) }];
    });
    return [{ panelId: item.panelId, faces }];
  });
}

/** asset 正規化座標を、crop(cover)を介してページ座標へ写す。回転cropは現在の自動生成では使わない。 */
export function assetPointToPage(point: PageVec, bounds: [number, number, number, number], crop: Crop): PageVec {
  return {
    x: bounds[0] + ((point.x - crop.x) / crop.width) * (bounds[2] - bounds[0]),
    y: bounds[1] + ((point.y - crop.y) / crop.height) * (bounds[3] - bounds[1])
  };
}

export function speakerTailTarget(mouth: PageVec, balloonCenter: PageVec, faceExtent: number): PageVec {
  const dx = balloonCenter.x - mouth.x;
  const dy = balloonCenter.y - mouth.y;
  const distance = Math.hypot(dx, dy);
  const gap = Math.max(0.012, Math.min(0.055, faceExtent * 0.28));
  return distance > 1e-6
    ? { x: mouth.x + (dx / distance) * gap, y: mouth.y + (dy / distance) * gap }
    : mouth;
}

/**
 * アニメ顔検出後処理。各コマの顔(画像正規化 mouth 座標)を読書方向に並べ、同じコマの発話順へ割当。
 * 吹き出し本体は既存の衝突回避位置を維持し、尻尾先端だけを推定口元へ向ける。
 */
export function applySpeakerAnchors(projectId: string, pageId: string, body: unknown): { updated: number; detectedFaces: number } {
  const input = objectBody(body);
  const panelsInput = parsePanels(input.panels);
  const page = getRow<PageRow>("SELECT layout_json, objects_json FROM pages WHERE id = ? AND project_id = ?", [pageId, projectId]);
  if (!page) throw new HttpError(404, "Page was not found in this project");
  if (!page.layout_json) throw new HttpError(400, "Page has no panel layout");
  const layout = normalizeEditedPageLayout(JSON.parse(page.layout_json)) as PageLayout | null;
  if (!layout) throw new HttpError(400, "Page layout is invalid");
  const objects = normalizePageObjects(page.objects_json ? JSON.parse(page.objects_json) : []);
  const objectByLine = new Map(objects.filter((object): object is BalloonObject => object.kind === "balloon" && Boolean(object.sourceDialogueLineId)).map((object) => [object.sourceDialogueLineId!, object]));
  let updated = 0;
  let detectedFaces = 0;

  for (const panelInput of panelsInput) {
    const panel = layout.panels.find((candidate) => candidate.id === panelInput.panelId);
    if (!panel || panelInput.faces.length === 0) continue;
    const assignment = getRow<{ crop_json: string }>(
      "SELECT crop_json FROM page_panel_assignments WHERE page_id = ? AND panel_id = ?",
      [pageId, panel.id]
    );
    if (!assignment) continue;
    const crop = JSON.parse(assignment.crop_json) as Crop;
    if (!(crop.width > 0 && crop.height > 0)) continue;
    const bounds = panelBounds(panel.shape);
    const anchors = panelInput.faces
      .filter((face) => face.score >= 0.25)
      .map((face) => {
        const mouth = assetPointToPage(face.mouth, bounds, crop);
        if (!face.bbox) return { mouth, faceExtent: 0 };
        const topLeft = assetPointToPage({ x: face.bbox.x, y: face.bbox.y }, bounds, crop);
        const bottomRight = assetPointToPage(
          { x: face.bbox.x + face.bbox.width, y: face.bbox.y + face.bbox.height },
          bounds,
          crop
        );
        return { mouth, faceExtent: Math.max(Math.abs(bottomRight.x - topLeft.x), Math.abs(bottomRight.y - topLeft.y)) };
      })
      .sort((a, b) => layout.readingDirection === "rtl" ? b.mouth.x - a.mouth.x : a.mouth.x - b.mouth.x);
    detectedFaces += anchors.length;
    if (anchors.length === 0) continue;
    const lines = getRows<{ line_id: string }>(
      `SELECT dp.line_id FROM dialogue_placements dp JOIN dialogue_lines dl ON dl.id = dp.line_id
       WHERE dp.page_id = ? AND dp.panel_id = ? AND dp.balloon_object_id IS NOT NULL ORDER BY dl.order_index ASC`,
      [pageId, panel.id]
    );
    lines.forEach((line, index) => {
      const balloon = objectByLine.get(line.line_id);
      if (!balloon || balloon.shape === "thought") return;
      const anchor = anchors[index % anchors.length]!;
      // 唇へ接触させず、顔の大きさに比例した余白を吹き出し側へ取る。極端な遠景でも最低余白を確保。
      const target = speakerTailTarget(anchor.mouth, balloon.position, anchor.faceExtent);
      balloon.tail = {
        tip: { x: target.x - balloon.position.x, y: target.y - balloon.position.y },
        width: Math.max(0.008, Math.min(balloon.size.x, balloon.size.y) * 0.16)
      };
      updated += 1;
    });
  }

  runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?", [
    JSON.stringify(objects as PageObject[]),
    pageId,
    projectId
  ]);
  return { updated, detectedFaces };
}
