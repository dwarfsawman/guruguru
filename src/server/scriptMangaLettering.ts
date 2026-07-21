import {
  type DialoguePolicy,
  type FrozenDialogueLine,
  type MangaPlanV2,
  type NormalizedBox
} from "../shared/mangaPlanV2";
import { normalizeEditedPageLayout, panelBounds, type PageLayout } from "../shared/pageLayout";
import type { DialogueBalloonStyle, DialogueSemanticKind } from "../shared/apiTypes";
import { constrainBalloonTailTipToBounds, initialBalloonTailTip } from "../shared/balloonTailAim";
import { balloonContentMaxWidth, balloonInscribedFactor } from "../shared/balloonShape";
import { CONTENT_PADDING_RATIO } from "../shared/pageObjects";
import { computeTextLayoutForContent } from "./textLayoutApi";
import { orderPanelsByReadingDirection } from "../shared/dialogueAutoLayout";
import { normalizePageObjects, type BalloonObject } from "../shared/pageObjects";
import { splitDialogueUnits, type DialogueUnit } from "../shared/dialogueAdaptation";
import { auditLettering } from "../shared/letteringQuality";
import { fitPageBalloonText } from "./balloonTextFit";
import { createId, getRow, getRows, runSql } from "./db";
import { allocateDialoguePages } from "./dialogueAllocation";
import { applyDialogueLayout, reflowDialogueLayout } from "./dialogueAutoLayoutApi";
import { HttpError } from "./http";
import { resolveMangaFontId } from "./fonts";
import {
  pageLayout,
  parseJson,
  planFromRow,
  requirePlan,
  requireRun,
  type RunRow,
  type TaskRow
} from "./scriptMangaRows";

const SCRIPT_MANGA_FONT_SCALE = 0.88;
// The 0.02 hard gate rejected even 7-16 character balloons in narrow/telecom
// shapes after fitting. 0.016 remained comfortably legible at the default B5
// export size; 0.014 keeps the same tolerance philosophy while letting the
// fitter's real glyph bbox decide whether a short line fits (2026-07-18).
const SCRIPT_MANGA_MIN_FONT_SIZE = 0.014;
/**
 * 自動レタリングでの「吹き出し等がコマ外接矩形を占有してよい面積比」の上限
 * (Docs/Reference-MangaCompositions.md)。preserve の長台詞は relax パスで超過を許すが警告が残る。
 * 0.45では絵の見える面積が痩せすぎたため0.35へ縮小(2026-07-18)。
 */
const SCRIPT_MANGA_MAX_BALLOON_COVERAGE = 0.35;
/** plan の cast bbox から顔領域とみなす高さ比(bbox 上端からこの割合)。auditLettering と共有。 */
const CAST_FACE_HEIGHT_RATIO = 0.38;

/**
 * plan の cast bbox(コマ内正規化)を page 座標の全身ボックスへ写像する共通ヘルパ。
 * 顔領域(CAST_FACE_HEIGHT_RATIO)への縮小やラベル付与など呼び出し側ごとの差分は
 * project コールバックで表現する(回避領域と lettering 監査の二重実装を一本化)。
 */
function mapPlanCastToPageBoxes<T>(
  pageSpec: MangaPlanV2["pages"][number],
  layoutPanels: PageLayout["panels"],
  project: (bodyBox: { x: number; y: number; width: number; height: number }, layoutPanel: PageLayout["panels"][number]) => T
): T[] {
  return pageSpec.panels.flatMap((panel, index) => {
    const layoutPanel = layoutPanels[index];
    if (!layoutPanel) return [];
    const [x0, y0, x1, y1] = panelBounds(layoutPanel.shape);
    return panel.cast.map((member) => project({
      x: x0 + member.bbox.x * (x1 - x0),
      y: y0 + member.bbox.y * (y1 - y0),
      width: member.bbox.width * (x1 - x0),
      height: member.bbox.height * (y1 - y0)
    }, layoutPanel));
  });
}

/**
 * plan の cast bbox(コマ内正規化)を page 座標へ写像した回避領域を作る。head=true なら顔領域
 * (bbox 上端から CAST_FACE_HEIGHT_RATIO)、false なら全身。ぶち抜き立ち絵スロット
 * (layoutPanel.role === "figure")は吹き出しで隠したくないため全身を返す。
 */
function planCastAvoidZones(
  pageSpec: MangaPlanV2["pages"][number],
  layoutPanels: PageLayout["panels"]
): Array<{ x: number; y: number; width: number; height: number; label?: string }> {
  return mapPlanCastToPageBoxes(pageSpec, layoutPanels, (bodyBox, layoutPanel) => {
    const fullBody = layoutPanel.role === "figure";
    return {
      x: bodyBox.x,
      y: bodyBox.y,
      width: bodyBox.width,
      height: bodyBox.height * (fullBody ? 1 : CAST_FACE_HEIGHT_RATIO),
      label: fullBody ? "立ち絵" : "顔"
    };
  });
}

interface LetteringConstraints {
  avoidZones: Array<{ x: number; y: number; width: number; height: number; label?: string }>;
  maxPanelCoverageRatio: number;
  /** 人間ゲートの吹き出し中心ヒント(lineId → page 座標)。 */
  preferredCentersByLineId?: Record<string, { x: number; y: number }>;
}

function applyDialogueLayoutWithFallback(
  projectId: string,
  pageId: string,
  placementIds: string[],
  baseSeed: number,
  constraints?: LetteringConstraints
): void {
  let lastError: unknown;
  const constraintBody = constraints
    ? {
        avoidZones: constraints.avoidZones,
        maxPanelCoverageRatio: constraints.maxPanelCoverageRatio,
        ...(constraints.preferredCentersByLineId && Object.keys(constraints.preferredCentersByLineId).length > 0
          ? { preferredCentersByLineId: constraints.preferredCentersByLineId }
          : {})
      }
    : {};
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      applyDialogueLayout(projectId, pageId, {
        placementIds,
        seed: baseSeed * 100 + attempt,
        fontScale: SCRIPT_MANGA_FONT_SCALE,
        ...constraintBody
      });
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof HttpError) || error.statusCode !== 422) throw error;
    }
  }
  for (let offset = 0; offset < placementIds.length; offset += 1) {
    const group = placementIds.slice(offset, offset + 1);
    let placed = false;
    for (const fontScale of [SCRIPT_MANGA_FONT_SCALE, 0.75, 0.62, 0.5, 0.42, 0.35]) {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        try {
          applyDialogueLayout(projectId, pageId, {
            placementIds: group,
            seed: baseSeed * 1000 + offset * 31 + attempt,
            fontScale,
            ...constraintBody
          });
          placed = true;
          break;
        } catch (error) {
          lastError = error;
          if (!(error instanceof HttpError) || error.statusCode !== 422) throw error;
        }
      }
      if (placed) break;
    }
    if (!placed) throw lastError;
  }
}

function aimInitialBalloonTails(pageId: string): void {
  const row = getRow<{ objects_json: string | null; layout_json: string | null }>("SELECT objects_json, layout_json FROM pages WHERE id = ?", [pageId]);
  const objects = normalizePageObjects(row?.objects_json ? JSON.parse(row.objects_json) : []);
  const layout = normalizeEditedPageLayout(row?.layout_json ? JSON.parse(row.layout_json) : null);
  const panelById = new Map(layout?.panels.map((panel) => [panel.id, panel]) ?? []);
  const assignedPanelByObjectId = new Map(
    getRows<{ balloon_object_id: string; panel_id: string | null }>(
      "SELECT balloon_object_id, panel_id FROM dialogue_placements WHERE page_id = ? AND balloon_object_id IS NOT NULL",
      [pageId]
    ).map((placement) => [placement.balloon_object_id, placement.panel_id])
  );
  let order = 0;
  for (const object of objects) {
    if (object.kind !== "balloon" || !object.tail) continue;
    const initialTip = initialBalloonTailTip(object.position, object.size, order);
    const panelId = assignedPanelByObjectId.get(object.id);
    const panel = panelId ? panelById.get(panelId) : undefined;
    object.tail.tip = panel ? constrainBalloonTailTipToBounds(object.position, initialTip, panelBounds(panel.shape)) : initialTip;
    order += 1;
  }
  runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [JSON.stringify(objects), pageId]);
}

function requireReadableBalloonText(pageId: string): void {
  const row = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  const balloons = normalizePageObjects(row?.objects_json ? JSON.parse(row.objects_json) : []).filter(
    (object): object is BalloonObject => object.kind === "balloon"
  );
  const tooSmall: BalloonObject[] = [];
  let adjusted = false;
  for (const balloon of balloons) {
    if (!balloon.content || balloon.content.style.size >= SCRIPT_MANGA_MIN_FONT_SIZE) continue;
    const trial = { ...balloon.content, style: { ...balloon.content.style, size: SCRIPT_MANGA_MIN_FONT_SIZE } };
    const layout = computeTextLayoutForContent(trial, balloonContentMaxWidth(balloon.shape, balloon.size, trial.style.direction));
    const factor = balloonInscribedFactor(balloon.shape) * (1 - CONTENT_PADDING_RATIO);
    const fits = layout.bbox.maxX - layout.bbox.minX <= balloon.size.x * factor + 1e-6 &&
      layout.bbox.maxY - layout.bbox.minY <= balloon.size.y * factor + 1e-6;
    if (fits) { balloon.content.style.size = SCRIPT_MANGA_MIN_FONT_SIZE; adjusted = true; }
    else tooSmall.push(balloon);
  }
  if (adjusted) runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [JSON.stringify(normalizePageObjects(row?.objects_json ? JSON.parse(row.objects_json) : []).map((object) => balloons.find((balloon) => balloon.id === object.id) ?? object)), pageId]);
  if (tooSmall.length > 0) {
    throw new HttpError(
      422,
      `Dialogue does not fit at the minimum readable size (${SCRIPT_MANGA_MIN_FONT_SIZE}); split dialogue or re-plan the page: ${tooSmall.map((balloon) => `${balloon.sourceDialogueLineId ?? balloon.id}(${Array.from(balloon.content?.text ?? "").length} chars)`).join(", ")}`
    );
  }
}

export function actualTextSafeZones(pageId: string, layout: PageLayout, panelId: string): NormalizedBox[] {
  const page = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  const objects = normalizePageObjects(page?.objects_json ? JSON.parse(page.objects_json) : []);
  const objectById = new Map(objects.filter((object): object is BalloonObject => object.kind === "balloon").map((object) => [object.id, object]));
  const objectIds = getRows<{ balloon_object_id: string }>(
    "SELECT balloon_object_id FROM dialogue_placements WHERE page_id = ? AND panel_id = ? AND balloon_object_id IS NOT NULL",
    [pageId, panelId]
  ).map((row) => row.balloon_object_id);
  const panel = layout.panels.find((candidate) => candidate.id === panelId);
  if (!panel) return [];
  const [px1, py1, px2, py2] = panelBounds(panel.shape);
  const width = px2 - px1;
  const height = py2 - py1;
  if (width <= 0 || height <= 0) return [];
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return objectIds.flatMap((id) => {
    const balloon = objectById.get(id);
    if (!balloon) return [];
    const padding = 0.01;
    const x1 = clamp((balloon.position.x - balloon.size.x / 2 - padding - px1) / width);
    const y1 = clamp((balloon.position.y - balloon.size.y / 2 - padding - py1) / height);
    const x2 = clamp((balloon.position.x + balloon.size.x / 2 + padding - px1) / width);
    const y2 = clamp((balloon.position.y + balloon.size.y / 2 + padding - py1) / height);
    return x2 > x1 && y2 > y1 ? [{ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }] : [];
  });
}

export function ensureDialogueLettering(
  run: RunRow,
  pageId: string,
  pageSpec: MangaPlanV2["pages"][number],
  layoutPanels: PageLayout["panels"],
  dialogueSnapshots: Map<string, FrozenDialogueLine>,
  dialoguePolicy: DialoguePolicy,
  fillUnits: Map<string, DialogueUnit>
): void {
  const pageFillIds = pageSpec.panels.flatMap((panel) => panel.fillUnitIds ?? []);
  for (const unitId of pageFillIds) {
    const unit = fillUnits.get(unitId);
    if (!unit) throw new HttpError(422, `Frozen fill unit is missing: ${unitId}`);
    runSql(
      `INSERT OR IGNORE INTO dialogue_lines
         (id, project_id, script_id, character_id, speaker_label, text, semantic_kind, balloon_style,
          order_index, scene_index, source_hash, status, source)
       VALUES (?, ?, ?, NULL, '', ?, ?, ?, ?, NULL, ?, 'active', 'llm')`,
      [unit.id, run.project_id, run.script_id, unit.text, unit.semanticKind, unit.balloonStyle, 1_000_000 + fillUnits.size,
        unit.sourceElementId ?? unit.id]
    );
    dialogueSnapshots.set(unit.id, {
      id: unit.id, orderIndex: 1_000_000 + unit.part, sceneIndex: 0, characterId: null, speakerLabel: "",
      text: unit.text, semanticKind: unit.semanticKind, balloonStyle: unit.balloonStyle
    });
  }
  const lineIds = pageSpec.panels.flatMap((panel) => [...panel.dialogueLineIds, ...(panel.fillUnitIds ?? [])]);
  if (lineIds.length === 0) return;
  // Separate runs own separate pages/balloons, even when the same source line was already used by
  // another run. `copy` remains idempotent because allocation itself skips a placement on this page.
  allocateDialoguePages(run.project_id, pageId, { lineIds, existingPlacementPolicy: "copy" });
  for (let index = 0; index < pageSpec.panels.length; index += 1) {
    const layoutPanel = layoutPanels[index];
    if (!layoutPanel) throw new HttpError(500, `Page ${pageId} has fewer panels than planned`);
    for (const lineId of [...pageSpec.panels[index]!.dialogueLineIds, ...(pageSpec.panels[index]!.fillUnitIds ?? [])]) {
      const snapshot = dialogueSnapshots.get(lineId);
      if (!snapshot) throw new HttpError(422, `Frozen dialogue snapshot is missing: ${lineId}`);
      if (dialoguePolicy === "adapt" || dialoguePolicy === "fill") {
        const existing = getRows<{ id: string; part_index: number; balloon_object_id: string | null }>(
          "SELECT id, part_index, balloon_object_id FROM dialogue_placements WHERE page_id = ? AND line_id = ? ORDER BY part_index",
          [pageId, lineId]
        );
        if (existing.length === 1 && !existing[0]!.balloon_object_id) {
          const units = splitDialogueUnits({ lineId, text: snapshot.text, semanticKind: snapshot.semanticKind as DialogueSemanticKind,
            balloonStyle: (snapshot.balloonStyle as DialogueBalloonStyle | undefined) ?? "normal" });
          if (units.length > 1) {
            runSql("DELETE FROM dialogue_placements WHERE id = ?", [existing[0]!.id]);
            for (const unit of units) {
              const unitPanel = layoutPanels[Math.min(layoutPanels.length - 1, index + unit.part - 1)] ?? layoutPanel;
              runSql(
                `INSERT INTO dialogue_placements
                   (id, line_id, page_id, panel_id, part_index, render_kind, balloon_object_id, text_override,
                    semantic_kind_override, speaker_label_override, order_index_override)
                 VALUES (?, ?, ?, ?, ?, 'balloon', NULL, ?, ?, ?, ?)`,
                [createId("place"), lineId, pageId, unitPanel.id, unit.part - 1, unit.text, unit.semanticKind,
                  snapshot.speakerLabel, snapshot.orderIndex * 100 + unit.part]
              );
            }
          }
        }
        const splitCount = getRow<{ count: number }>(
          "SELECT COUNT(*) AS count FROM dialogue_placements WHERE page_id = ? AND line_id = ?",
          [pageId, lineId]
        )?.count ?? 0;
        if (splitCount > 1) continue;
      }
      runSql(
        `UPDATE dialogue_placements SET panel_id = ?, text_override = ?, semantic_kind_override = ?,
           speaker_label_override = ?, order_index_override = ?, updated_at = CURRENT_TIMESTAMP
         WHERE page_id = ? AND line_id = ?`,
        [
          layoutPanel.id,
          snapshot.text,
          snapshot.semanticKind,
          snapshot.speakerLabel,
          snapshot.orderIndex,
          pageId,
          lineId
        ]
      );
    }
  }
  const placementIds = getRows<{ id: string }>(
    `SELECT id FROM dialogue_placements
     WHERE page_id = ? AND balloon_object_id IS NULL AND line_id IN (${lineIds.map(() => "?").join(", ")})`,
    [pageId, ...lineIds]
  ).map((row) => row.id);
  if (placementIds.length > 0) {
    applyDialogueLayoutWithFallback(run.project_id, pageId, placementIds, pageSpec.index + 1, {
      avoidZones: planCastAvoidZones(pageSpec, layoutPanels),
      maxPanelCoverageRatio: SCRIPT_MANGA_MAX_BALLOON_COVERAGE,
      preferredCentersByLineId: Object.fromEntries(
        (pageSpec.balloonCenterHints ?? []).map((hint) => [hint.lineId, { x: hint.x, y: hint.y }])
      )
    });
  }
  const fontChanged = applyMangaDialogueFont(pageId, lineIds);
  if (placementIds.length > 0 || fontChanged) {
    fitPageBalloonText(run.project_id, pageId);
  }
  if (placementIds.length > 0) {
    aimInitialBalloonTails(pageId);
  }
  requireReadableBalloonText(pageId);
  const pageRow = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  const objects = normalizePageObjects(pageRow?.objects_json ? JSON.parse(pageRow.objects_json) : []);
  const faceBoxes = mapPlanCastToPageBoxes(pageSpec, layoutPanels, (bodyBox) => ({
    x: bodyBox.x,
    y: bodyBox.y,
    width: bodyBox.width,
    height: bodyBox.height * CAST_FACE_HEIGHT_RATIO
  }));
  const letteringReport = auditLettering(pageSpec.layoutSnapshot, objects, faceBoxes);
  const evaluation = parseJson<Record<string, unknown>>(requireRun(run.id).evaluation_json, {});
  runSql("UPDATE script_manga_runs SET evaluation_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify({ ...evaluation, lettering: { ...(evaluation.lettering as Record<string, unknown> ?? {}), [pageId]: letteringReport } }),
    run.id
  ]);
}

/**
 * script-mangaが自動配置した文字だけへ漫画用fontを明示する。一般ページの`default`解決順や、
 * ユーザーが明示選択済みのfontは変更しない。
 */
function applyMangaDialogueFont(pageId: string, lineIds: string[]): boolean {
  if (lineIds.length === 0) return false;
  const objectIds = new Set(getRows<{ balloon_object_id: string | null }>(
    `SELECT balloon_object_id FROM dialogue_placements
     WHERE page_id = ? AND line_id IN (${lineIds.map(() => "?").join(", ")}) AND balloon_object_id IS NOT NULL`,
    [pageId, ...lineIds]
  ).flatMap((row) => row.balloon_object_id ? [row.balloon_object_id] : []));
  if (objectIds.size === 0) return false;
  const pageRow = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  const objects = normalizePageObjects(pageRow?.objects_json ? JSON.parse(pageRow.objects_json) : []);
  const fontId = resolveMangaFontId();
  let changed = false;
  const updated = objects.map((object) => {
    if (!objectIds.has(object.id)) return object;
    if (object.kind === "text" && object.content.style.fontId === "default" && fontId !== "default") {
      changed = true;
      return { ...object, content: { ...object.content, style: { ...object.content.style, fontId } } };
    }
    if ((object.kind === "balloon" || object.kind === "box") && object.content?.style.fontId === "default" && fontId !== "default") {
      changed = true;
      return { ...object, content: { ...object.content, style: { ...object.content.style, fontId } } };
    }
    return object;
  });
  if (changed) {
    runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [JSON.stringify(updated), pageId]);
  }
  return changed;
}

/**
 * ぶち抜き立ち絵(Docs/Reference-MangaCompositions.md)の再レタリング。立ち絵 ImageObject が
 * 障害物として増えた後、ロックされていない吹き出しを顔・立ち絵回避と専有率制約付きで
 * 組み直す。失敗しても既存配置を維持する(切り抜き自体は成功している)best effort。
 */
export function reflowLetteringAroundFigure(run: RunRow, task: TaskRow): void {
  try {
    if (!run.plan_id) return;
    const plan = planFromRow(requirePlan(run.plan_id));
    const pageIndex = getRow<{ page_index: number }>(
      "SELECT page_index FROM script_manga_run_pages WHERE run_id = ? AND page_id = ?",
      [run.id, task.page_id]
    )?.page_index;
    const pageSpec = typeof pageIndex === "number" ? plan.pages[pageIndex] : undefined;
    if (!pageSpec) return;
    const layout = pageLayout(task.page_id);
    const layoutPanels = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
    reflowDialogueLayout(run.project_id, task.page_id, {
      seed: (pageSpec.index + 1) * 7919 + 17,
      fontScale: SCRIPT_MANGA_FONT_SCALE,
      avoidZones: planCastAvoidZones(pageSpec, layoutPanels),
      maxPanelCoverageRatio: SCRIPT_MANGA_MAX_BALLOON_COVERAGE
    });
    fitPageBalloonText(run.project_id, task.page_id);
    aimInitialBalloonTails(task.page_id);
  } catch {
    // 再配置できないページはそのまま(手動の再配置・ロック解除で調整できる)。
  }
}
