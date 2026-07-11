import type { FountainDoc } from "../shared/fountain";
import { planScriptManga, type ScriptMangaPlanOptions } from "../shared/scriptMangaPlan";
import { normalizeEditedPageLayout, panelBounds, panelBoundsSize, type PageLayout } from "../shared/pageLayout";
import type { GenerationRequest, StyleLoraSelection } from "../shared/types";
import { updateAssetStatus } from "./assets";
import { createId, getRow, getRows, runSql } from "./db";
import { allocateDialoguePages } from "./dialogueAllocation";
import { applyDialogueLayout } from "./dialogueAutoLayoutApi";
import { HttpError } from "./http";
import { createPage, updatePage } from "./pages";
import { createGenerationRound } from "./rounds";
import { objectBody, requiredString, stringOr } from "./validate";
import { planScriptMangaWithDirector } from "./scriptMangaDirector";
import { validateProvidedScriptMangaPlan } from "../shared/scriptMangaProvidedPlan";
import { fitPageBalloonText } from "./balloonTextFit";
import { constrainBalloonTailTipToBounds, initialBalloonTailTip } from "../shared/balloonTailAim";
import { normalizePageObjects } from "../shared/pageObjects";
import { orderPanelsByReadingDirection } from "../shared/dialogueAutoLayout";

interface RunRow {
  id: string;
  project_id: string;
  script_id: string;
  status: string;
  page_count: number;
  panel_count: number;
  completed_count: number;
  failed_count: number;
  config_json: string;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface TaskRow {
  id: string;
  run_id: string;
  page_id: string;
  panel_id: string;
  round_id: string | null;
  status: string;
  asset_id: string | null;
}

/** 商業漫画の本文に近い視認性を確保する自動漫画専用倍率(基準0.04→0.0352 page-width)。 */
const SCRIPT_MANGA_FONT_SCALE = 0.88;

export interface ScriptMangaRunView {
  id: string;
  projectId: string;
  scriptId: string;
  status: string;
  pageCount: number;
  panelCount: number;
  completedCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function errorJson(error: unknown): string {
  return JSON.stringify({ message: error instanceof Error ? error.message : String(error) });
}

function requireScript(projectId: string, scriptId: string): void {
  if (!getRow("SELECT id FROM manga_scripts WHERE id = ? AND project_id = ?", [scriptId, projectId])) {
    throw new HttpError(404, "Script was not found in this project");
  }
}

/** Book 新規作成時のスターター1枚が完全に未使用なら、自動漫画ページの前に残さない。 */
function removeUnusedStarterPage(projectId: string): void {
  const pages = getRows<{ id: string; title: string; layout_json: string | null; objects_json: string | null }>(
    "SELECT id, title, layout_json, objects_json FROM pages WHERE project_id = ? ORDER BY page_index ASC",
    [projectId]
  );
  if (pages.length !== 1) return;
  const page = pages[0]!;
  const hasRound = getRow("SELECT id FROM generation_rounds WHERE page_id = ? LIMIT 1", [page.id]);
  const hasPlacement = getRow("SELECT id FROM dialogue_placements WHERE page_id = ? LIMIT 1", [page.id]);
  if (!page.title && !page.layout_json && !page.objects_json && !hasRound && !hasPlacement) {
    runSql("DELETE FROM pages WHERE id = ?", [page.id]);
  }
}

function latestDoc(scriptId: string): FountainDoc {
  const row = getRow<{ parsed_json: string }>(
    "SELECT parsed_json FROM script_revisions WHERE script_id = ? ORDER BY revision DESC LIMIT 1",
    [scriptId]
  );
  if (!row) throw new HttpError(400, "Script has no Fountain revision");
  try {
    return JSON.parse(row.parsed_json) as FountainDoc;
  } catch {
    throw new HttpError(500, "Stored Fountain revision is invalid");
  }
}

function roundTo64(value: number): number {
  return Math.max(256, Math.round(value / 64) * 64);
}

/** コマの縦横比を保ち、長辺を 768px(≈800px)にする。 */
function panelGenerationSize(layout: PageLayout, panelId: string, longEdge = 1024): { width: number; height: number } {
  const edge = Math.max(512, Math.min(1536, roundTo64(longEdge)));
  const panel = layout.panels.find((item) => item.id === panelId);
  if (!panel) return { width: edge, height: edge };
  const [panelWidth, panelHeight] = panelBoundsSize(panelBounds(panel.shape));
  if (panelWidth <= 0 || panelHeight <= 0) return { width: edge, height: edge };
  if (panelWidth >= panelHeight) {
    return { width: edge, height: roundTo64((edge * panelHeight) / panelWidth) };
  }
  return { width: roundTo64((edge * panelWidth) / panelHeight), height: edge };
}

function runView(row: RunRow): ScriptMangaRunView {
  return {
    id: row.id,
    projectId: row.project_id,
    scriptId: row.script_id,
    status: row.status,
    pageCount: row.page_count,
    panelCount: row.panel_count,
    completedCount: row.completed_count,
    failedCount: row.failed_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function requireRun(runId: string): RunRow {
  const row = getRow<RunRow>("SELECT * FROM script_manga_runs WHERE id = ?", [runId]);
  if (!row) throw new HttpError(404, "Script manga run was not found");
  return row;
}

/**
 * 自動漫画では配置不能を人手待ちにしない。まず全件を seed 違いで試し、収まらなければ
 * 発話順を保った小グループへ分割する。各 apply はトランザクションなので失敗試行はDB非破壊。
 */
function applyDialogueLayoutWithFallback(projectId: string, pageId: string, placementIds: string[], baseSeed: number): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      applyDialogueLayout(projectId, pageId, { placementIds, seed: baseSeed * 100 + attempt, fontScale: SCRIPT_MANGA_FONT_SCALE });
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof HttpError) || error.statusCode !== 422) throw error;
    }
  }

  // 全件同時探索が詰まる場合は最大2件ずつ。既に確定した group は次 group の障害物となる。
  for (let offset = 0; offset < placementIds.length; offset += 2) {
    const group = placementIds.slice(offset, offset + 2);
    let placed = false;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      try {
        applyDialogueLayout(projectId, pageId, { placementIds: group, seed: baseSeed * 1000 + offset * 31 + attempt, fontScale: SCRIPT_MANGA_FONT_SCALE });
        placed = true;
        break;
      } catch (error) {
        lastError = error;
        if (!(error instanceof HttpError) || error.statusCode !== 422) throw error;
      }
    }
    if (!placed) throw lastError;
  }
}

/** 顔検出前でも真下固定に見えないよう、読書方向に沿う斜めの仮しっぽを付ける。 */
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
    object.tail.tip = panel
      ? constrainBalloonTailTipToBounds(object.position, initialTip, panelBounds(panel.shape))
      : initialTip;
    order += 1;
  }
  runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [JSON.stringify(objects), pageId]);
}

/**
 * Fountain revision からページ/コマを作り、台詞を吹き出し化して各コマの ComfyUI generation を投入する。
 * 画像は batch=1、長辺768px固定。進捗と各 round の対応は DB に永続化する。
 */
export async function createScriptMangaRun(projectId: string, body: unknown): Promise<ScriptMangaRunView> {
  const input = objectBody(body);
  const scriptId = requiredString(input.scriptId, "scriptId");
  const templateId = requiredString(input.templateId, "templateId");
  const providerId = stringOr(input.providerId, "comfy");
  requireScript(projectId, scriptId);
  if (!getRow("SELECT id FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [templateId])) {
    throw new HttpError(404, "Workflow template was not found");
  }

  const planOptions: ScriptMangaPlanOptions = {
    panelsPerPage: typeof input.panelsPerPage === "number" ? input.panelsPerPage : 4,
    maxElementsPerPanel: typeof input.maxElementsPerPanel === "number" ? input.maxElementsPerPanel : 6,
    maxDialoguesPerPanel: typeof input.maxDialoguesPerPanel === "number" ? input.maxDialoguesPerPanel : 2,
    stylePrompt: stringOr(input.stylePrompt, "") || undefined
  };
  const planningMode = stringOr(input.planningMode, "heuristic");
  if (planningMode !== "heuristic" && planningMode !== "llm" && planningMode !== "provided") {
    throw new HttpError(400, 'planningMode must be "heuristic", "llm", or "provided"');
  }
  const doc = latestDoc(scriptId);
  const fullPlan = planningMode === "llm"
    ? await planScriptMangaWithDirector(doc, { ...planOptions, characterBible: stringOr(input.characterBible, "") || undefined })
    : planningMode === "provided"
      ? validateProvidedScriptMangaPlan(doc, input.directorPlan)
      : planScriptManga(doc, planOptions);
  if (!fullPlan) throw new HttpError(400, "directorPlan is invalid or does not preserve every dialogue exactly once");
  const pageLimit = typeof input.pageLimit === "number" ? Math.max(1, Math.min(fullPlan.pages.length, Math.trunc(input.pageLimit))) : fullPlan.pages.length;
  const limitedPages = fullPlan.pages.slice(0, pageLimit);
  const plan = {
    ...fullPlan,
    pages: limitedPages,
    panelCount: limitedPages.reduce((sum, page) => sum + page.panels.length, 0),
    dialogueCount: new Set(limitedPages.flatMap((page) => page.panels.flatMap((panel) => panel.dialogueOrderIndexes))).size
  };
  const loras: StyleLoraSelection[] = Array.isArray(input.loras)
    ? input.loras.flatMap((raw) => raw && typeof raw === "object"
      ? [{ name: stringOr((raw as Record<string, unknown>).name, ""), strength: typeof (raw as Record<string, unknown>).strength === "number" ? (raw as Record<string, number>).strength : 1 }]
      : []).filter((item) => item.name.trim()).slice(0, 4)
    : [];
  const generateImages = input.generateImages !== false;
  removeUnusedStarterPage(projectId);
  const runId = createId("manga");
  const config = {
    templateId,
    providerId,
    batchSize: 1,
    planningMode,
    pageLimit,
    loras,
    generateImages,
    longEdge: typeof input.longEdge === "number" ? input.longEdge : 1024,
    steps: typeof input.steps === "number" ? input.steps : 20,
    cfg: typeof input.cfg === "number" ? input.cfg : 5,
    sampler: stringOr(input.sampler, "euler"),
    scheduler: stringOr(input.scheduler, "beta"),
    planOptions
  };
  runSql(
    `INSERT INTO script_manga_runs (id, project_id, script_id, status, page_count, panel_count, config_json)
     VALUES (?, ?, ?, 'preparing', ?, ?, ?)`,
    [runId, projectId, scriptId, plan.pages.length, plan.panelCount, JSON.stringify(config)]
  );

  try {
    const lines = getRows<{ id: string; order_index: number }>(
      "SELECT id, order_index FROM dialogue_lines WHERE script_id = ? AND status = 'active' ORDER BY order_index ASC",
      [scriptId]
    );
    const lineByOrder = new Map(lines.map((line) => [line.order_index, line.id]));

    for (const pagePlan of plan.pages) {
      const page = createPage(projectId, { layoutTemplateId: pagePlan.layoutTemplateId });
      updatePage(projectId, page.id, { title: pagePlan.title });
      const layout = page.layout as PageLayout;
      // 吹き出し自動配置と同じ読書順へ揃える。layout の order は描画順であり、
      // 非対称レイアウトでは右→左の読書順と一致しないことがある。
      const layoutPanels = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);

      const lineIds = pagePlan.panels.flatMap((panel) =>
        panel.dialogueOrderIndexes.map((order) => lineByOrder.get(order)).filter((id): id is string => Boolean(id))
      );
      if (lineIds.length > 0) {
        allocateDialoguePages(projectId, page.id, { lineIds, existingPlacementPolicy: "skip" });
        // 監督プランが指定した発話→コマ対応を placement に固定する。ページ単位の自動分配だけに
        // 任せると、無言コマを挟んだときに後続の台詞が手前のコマへ詰められてしまう。
        for (let panelIndex = 0; panelIndex < pagePlan.panels.length; panelIndex += 1) {
          const layoutPanel = layoutPanels[panelIndex];
          if (!layoutPanel) throw new HttpError(500, `Page ${page.id} has fewer panels than planned`);
          for (const orderIndex of pagePlan.panels[panelIndex]!.dialogueOrderIndexes) {
            const lineId = lineByOrder.get(orderIndex);
            if (!lineId) continue;
            runSql(
              `UPDATE dialogue_placements SET panel_id = ?, updated_at = CURRENT_TIMESTAMP
               WHERE page_id = ? AND line_id = ? AND balloon_object_id IS NULL`,
              [layoutPanel.id, page.id, lineId]
            );
          }
        }
        const placementIds = getRows<{ id: string }>(
          `SELECT dp.id FROM dialogue_placements dp
           JOIN dialogue_lines dl ON dl.id = dp.line_id
           WHERE dp.page_id = ? AND dl.script_id = ? AND dp.balloon_object_id IS NULL
           ORDER BY dl.order_index ASC`,
          [page.id, scriptId]
        ).map((row) => row.id);
        if (placementIds.length > 0) {
          applyDialogueLayoutWithFallback(projectId, page.id, placementIds, pagePlan.index + 1);
          // ページを開いた直後から読める状態にする。完了時/PPTX直前まで後回しにすると、
          // 自動生成中のUIでは縦書きが吹き出し外へはみ出したまま見えてしまう。
          fitPageBalloonText(projectId, page.id);
          aimInitialBalloonTails(page.id);
        }
      }

      for (let index = 0; index < pagePlan.panels.length; index += 1) {
        const panelPlan = pagePlan.panels[index]!;
        const layoutPanel = layoutPanels[index];
        if (!layoutPanel) throw new HttpError(500, `Page ${page.id} has fewer panels than planned`);
        if (!generateImages) continue;
        const taskId = createId("manga_task");
        runSql(
          `INSERT INTO script_manga_tasks (id, run_id, page_id, panel_id, prompt, status)
           VALUES (?, ?, ?, ?, ?, 'submitting')`,
          [taskId, runId, page.id, layoutPanel.id, panelPlan.prompt]
        );
        const size = panelGenerationSize(layout, layoutPanel.id, config.longEdge);
        const request: GenerationRequest & { providerId?: string } = {
          templateId,
          prompt: panelPlan.prompt,
          negativePrompt: "text, letters, words, typography, captions, subtitles, speech bubbles, manga sound effects, signage, labels, logos, watermarks, UI overlays, model sheet, character sheet, reference sheet, split screen, multiple views, collage, comic page inside panel, low quality, blurry, deformed",
          seed: null,
          seedMode: "random",
          batchSize: 1,
          steps: config.steps,
          cfg: config.cfg,
          sampler: config.sampler,
          scheduler: config.scheduler,
          denoise: 1,
          width: size.width,
          height: size.height,
          generationMode: "txt2img",
          loras,
          providerId
        };
        try {
          const created = await createGenerationRound(projectId, request, page.id, layoutPanel.id);
          if (!created.round) throw new Error("Generation round was not created");
          runSql("UPDATE script_manga_tasks SET round_id = ?, status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
            created.round.id,
            taskId
          ]);
        } catch (error) {
          runSql(
            "UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [errorJson(error), taskId]
          );
        }
      }
    }
    runSql("UPDATE script_manga_runs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [generateImages ? "running" : "prepared", runId]);
  } catch (error) {
    runSql(
      "UPDATE script_manga_runs SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [errorJson(error), runId]
    );
    throw error;
  }
  return runView(requireRun(runId));
}

/** round 状態を取り込み、完成assetを selected にして対象コマへ自動割り当てする。GET polling は冪等。 */
export function getScriptMangaRun(runId: string): ScriptMangaRunView {
  const run = requireRun(runId);
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ?", [runId]);
  for (const task of tasks) {
    if (!task.round_id || task.status === "completed" || task.status === "failed") continue;
    const round = getRow<{ status: string; last_error_json: string | null }>("SELECT status, last_error_json FROM generation_rounds WHERE id = ?", [
      task.round_id
    ]);
    if (round?.status === "completed") {
      const asset = getRow<{ id: string }>("SELECT id FROM assets WHERE round_id = ? ORDER BY batch_index ASC LIMIT 1", [task.round_id]);
      if (asset) {
        updateAssetStatus(asset.id, { status: "selected", note: `script manga run ${runId}` });
        runSql(
          "UPDATE script_manga_tasks SET status = 'completed', asset_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [asset.id, task.id]
        );
      }
    } else if (round?.status === "failed" || round?.status === "interrupted") {
      runSql(
        "UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [round.last_error_json, task.id]
      );
    }
  }

  const counts = getRow<{ completed: number; failed: number }>(
    `SELECT
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM script_manga_tasks WHERE run_id = ?`,
    [runId]
  ) ?? { completed: 0, failed: 0 };
  const terminal = counts.completed + counts.failed >= run.panel_count;
  const status = terminal ? (counts.failed > 0 ? "completed_with_errors" : "completed") : run.status;
  runSql(
    `UPDATE script_manga_runs SET status = ?, completed_count = ?, failed_count = ?, updated_at = CURRENT_TIMESTAMP,
       completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE id = ?`,
    [status, counts.completed, counts.failed, terminal ? 1 : 0, runId]
  );
  return runView(requireRun(runId));
}
