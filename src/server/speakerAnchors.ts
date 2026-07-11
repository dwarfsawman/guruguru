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
      return [{ mouth: { x: mouth.x, y: mouth.y }, score: finite(candidate.score) ? candidate.score : 1 }];
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
    const mouths = panelInput.faces
      .filter((face) => face.score >= 0.25)
      .map((face) => assetPointToPage(face.mouth, bounds, crop))
      .sort((a, b) => layout.readingDirection === "rtl" ? b.x - a.x : a.x - b.x);
    detectedFaces += mouths.length;
    if (mouths.length === 0) continue;
    const lines = getRows<{ line_id: string }>(
      `SELECT dp.line_id FROM dialogue_placements dp JOIN dialogue_lines dl ON dl.id = dp.line_id
       WHERE dp.page_id = ? AND dp.panel_id = ? AND dp.balloon_object_id IS NOT NULL ORDER BY dl.order_index ASC`,
      [pageId, panel.id]
    );
    lines.forEach((line, index) => {
      const balloon = objectByLine.get(line.line_id);
      if (!balloon || balloon.shape === "thought") return;
      const mouth = mouths[index % mouths.length]!;
      balloon.tail = {
        tip: { x: mouth.x - balloon.position.x, y: mouth.y - balloon.position.y },
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
