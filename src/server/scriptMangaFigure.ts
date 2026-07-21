import { panelBounds } from "../shared/pageLayout";
import { normalizePageObjects, type ImageObject } from "../shared/pageObjects";
import type { PageRow } from "../shared/apiTypes";
import { getRow, runSql, toApiRow } from "./db";
import { cutoutFigure } from "./figureCutout";
import { createPageMediaFromBuffer, deletePageMedia } from "./pageMedia";
import { upsertPanelAssignment } from "./panelAssignments";
import { reflowLetteringAroundFigure } from "./scriptMangaLettering";
import { pageLayout, parseJson, requireRun, type TaskRow } from "./scriptMangaRows";

/** run の evaluation_json へ figure 切り抜きの結果(成功/フォールバック/失敗)を記録する。 */
export function recordFigureResult(runId: string, taskId: string, value: unknown): void {
  const evaluation = parseJson<Record<string, unknown>>(requireRun(runId).evaluation_json, {});
  const figures = { ...((evaluation.figures as Record<string, unknown>) ?? {}), [taskId]: value };
  runSql("UPDATE script_manga_runs SET evaluation_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify({ ...evaluation, figures }),
    runId
  ]);
}

/**
 * 採用候補がぶち抜き立ち絵スロット(layout panel role:"figure")のものなら、背景除去+白フチの
 * 切り抜きを page_media 化し、`figure_<panelId>` の ImageObject(band:"front"、クリップ無し)として
 * コマ枠の前面へ重ねる。切り抜きが成立しない画像(無地背景でない等)は通常のコマ画像割当へ
 * フォールバックする。再採用時は同 id のオブジェクトと旧メディアを差し替える。
 */
export async function materializeFigureForTask(
  task: TaskRow,
  assetId: string,
  options: { canCommit?: () => boolean } = {}
): Promise<{ committed: boolean; mode: "cutout" | "fallback" | null }> {
  const run = requireRun(task.run_id);
  const layout = pageLayout(task.page_id);
  const layoutPanel = layout.panels.find((panel) => panel.id === task.panel_id);
  if (layoutPanel?.role !== "figure") return { committed: false, mode: null };
  const asset = getRow<{ image_path: string }>("SELECT image_path FROM assets WHERE id = ?", [assetId]);
  if (!asset) return { committed: false, mode: null };

  const cutout = await cutoutFigure(asset.image_path);
  if (options.canCommit && !options.canCommit()) return { committed: false, mode: null };
  if (!cutout) {
    // 無地背景でない等で切り抜き不成立 → 枠なしコマとして通常割当(絵は出るがぶち抜きにはならない)。
    const page = toApiRow(getRow("SELECT * FROM pages WHERE id = ?", [task.page_id])) as unknown as PageRow | null;
    let assigned = false;
    if (page?.layout) {
      try {
        upsertPanelAssignment(page, task.panel_id, { assetId });
        assigned = true;
      } catch {
        // 候補採用は成立させるが、successor 継承では失敗として生成へ戻す。
      }
    }
    recordFigureResult(run.id, task.id, { state: assigned ? "fallback-panel-assignment" : "fallback-panel-assignment-failed", assetId });
    return { committed: assigned, mode: assigned ? "fallback" : null };
  }

  const media = await createPageMediaFromBuffer(run.project_id, cutout.png, assetId);
  if (options.canCommit && !options.canCommit()) {
    deletePageMedia(media.mediaId);
    return { committed: false, mode: null };
  }
  const [px0, py0, px1, py1] = panelBounds(layoutPanel.shape);
  const slotWidth = Math.max(1e-6, px1 - px0);
  const slotHeight = Math.max(1e-6, py1 - py0);
  const aspect = cutout.width / Math.max(1, cutout.height);
  let height = slotHeight;
  let width = height * aspect;
  const maxWidth = slotWidth * 1.25; // ぶち抜き: 横はスロット幅の 25% まで隣へ張り出してよい。
  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspect;
  }
  const objectId = `figure_${task.panel_id}`;
  const figureObject: ImageObject = {
    id: objectId,
    kind: "image",
    mediaId: media.mediaId,
    position: { x: (px0 + px1) / 2, y: py1 - height / 2 },
    size: { x: width, y: height },
    rotation: 0,
    opacity: 1,
    band: "front",
    clipPanelId: null
  };
  const pageRow = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [task.page_id]);
  const objects = normalizePageObjects(pageRow?.objects_json ? JSON.parse(pageRow.objects_json) : []);
  const previous = objects.find((object): object is ImageObject => object.kind === "image" && object.id === objectId);
  // 万一 figure スロットに旧来の矩形割当が残っていたら取り除く(切り抜きの下に敷かれるのを防ぐ)。
  runSql("DELETE FROM page_panel_assignments WHERE page_id = ? AND panel_id = ?", [task.page_id, task.panel_id]);
  const nextObjects = normalizePageObjects([...objects.filter((object) => object.id !== objectId), figureObject]);
  runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify(nextObjects),
    task.page_id
  ]);
  if (previous && previous.mediaId !== media.mediaId) {
    deletePageMedia(previous.mediaId);
  }
  recordFigureResult(run.id, task.id, {
    state: "cutout",
    assetId,
    mediaId: media.mediaId,
    foregroundRatio: Number(cutout.foregroundRatio.toFixed(4))
  });
  reflowLetteringAroundFigure(run, task);
  return { committed: true, mode: "cutout" };
}
