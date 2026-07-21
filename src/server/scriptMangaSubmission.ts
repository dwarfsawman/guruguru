import type { MangaPlanV2, PanelSpec } from "../shared/mangaPlanV2";
import { panelBounds, panelBoundsSize, type PageLayout } from "../shared/pageLayout";
import type { GenerationRequest } from "../shared/types";
import { compilePanelConditioning } from "./panelPromptCompiler";
import { getRow, getRows, runSql } from "./db";
import { deletePageMedia } from "./pageMedia";
import { normalizePageObjects, type ImageObject } from "../shared/pageObjects";
import { resolvePanelReferences } from "./referenceResolver";
import { createGenerationRound, ensureRoundMonitor, interruptRound } from "./rounds";
import sharp from "sharp";
import { renderPoseSkeletonSvg } from "../shared/poseSkeletonSvg";
import type { PosePoint } from "../shared/poseTypes";
import { visibleJointsForPoseMode } from "../shared/posePresetLibrary";
import { reconstructPanelPoses, type PoseControlMode } from "./panelPoseReconstructor";
import {
  errorJson,
  frozenReferenceSnapshot,
  pageLayout,
  parseConfig,
  parseJson,
  planFromRow,
  referenceModelFamily,
  requireGenerationConfig,
  requirePlan,
  requireRun,
  requireTask,
  templatePromptProfile,
  type PoseControlConfig,
  type RunRow,
  type ScriptMangaRunConfig,
  type TaskRow
} from "./scriptMangaRows";

/**
 * poseControl 入力の正規化。UI は文字列("off"|"full"|"upper"|"face")、API 直叩きは
 * `{ enabled, mode, strength?, endPercent? }` オブジェクトも受け付ける。不正は undefined(OFF)。
 */
export function parsePoseControlInput(value: unknown): PoseControlConfig | undefined {
  const defaults = { strength: 0.5, endPercent: 0.6 } as const;
  if (typeof value === "string") {
    if (value === "off") return undefined;
    if (value === "full" || value === "upper" || value === "face") {
      return { enabled: true, mode: value, ...defaults };
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.enabled !== true) return undefined;
  const mode = raw.mode === "upper" || raw.mode === "face" ? raw.mode : "full";
  const strength = typeof raw.strength === "number" && Number.isFinite(raw.strength)
    ? Math.max(0, Math.min(2, raw.strength))
    : defaults.strength;
  const endPercent = typeof raw.endPercent === "number" && Number.isFinite(raw.endPercent)
    ? Math.max(0.05, Math.min(1, raw.endPercent))
    : defaults.endPercent;
  return { enabled: true, mode, strength, endPercent };
}

/**
 * 保存済みネームポーズレイヤ(panel.castPoses)を生成 px 空間へ展開する。
 * depth 昇順(奥→手前)に並べ、手前キャラのボーン/関節が奥キャラを上書きすることで
 * オクルージョンが ControlNet 画像に現れる。poseControl の mode マスクは交差適用。
 */
function storedPanelPoses(
  panel: PanelSpec,
  width: number,
  height: number,
  mode: PoseControlMode
): { poses: PosePoint[][]; presetIds: string[] } | null {
  const castPoses = panel.castPoses;
  if (!castPoses || castPoses.length === 0) return null;
  const modeVisible = visibleJointsForPoseMode(mode);
  const ordered = [...castPoses].sort((a, b) => a.depth - b.depth);
  const poses = ordered.map((pose) =>
    pose.joints.map((joint, index) => ({
      x: joint.x * width,
      y: joint.y * height,
      visible: joint.visible && (modeVisible === null || modeVisible.has(index))
    }))
  );
  if (!poses.some((pose) => pose.some((joint) => joint.visible))) return null;
  return { poses, presetIds: ordered.map((pose) => pose.presetId ?? "stored") };
}

/**
 * panel から ControlNet 添付(骨格 data URL)を組み立てる。保存済みネームポーズレイヤが
 * あればそれを優先(人間編集・LLMアンカーが反映される)、無い旧planはオンザフライ復元。
 * 骨格を用意できないコマ(insert/無人/5人以上)や不正サイズは null(添付なしで通常生成)。
 */
export async function buildPoseControlAttachment(
  panel: PanelSpec,
  width: number,
  height: number,
  poseControl: PoseControlConfig
): Promise<{ poseImageDataUrl: string; strength: number; startPercent: number; endPercent: number; presetIds: string[] } | null> {
  const material = (width > 0 && height > 0 ? storedPanelPoses(panel, width, height, poseControl.mode) : null)
    ?? reconstructPanelPoses(panel, width, height, poseControl.mode);
  if (!material) return null;
  const svg = renderPoseSkeletonSvg(material.poses, width, height);
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return {
    poseImageDataUrl: `data:image/png;base64,${png.toString("base64")}`,
    strength: poseControl.strength,
    startPercent: 0,
    endPercent: poseControl.endPercent,
    presetIds: material.presetIds
  };
}

export const activeTaskSubmissions = new Set<string>();
export const activeTaskInheritances = new Set<string>();
export const activeTaskSelections = new Set<string>();

function roundTo64(value: number): number {
  return Math.max(256, Math.round(value / 64) * 64);
}

const SDXL_BUCKETS = [[1024, 1024], [1152, 896], [896, 1152], [1216, 832], [832, 1216], [1344, 768], [768, 1344], [1536, 640], [640, 1536]] as const;

export function panelGenerationSize(layout: PageLayout, panelId: string, longEdge = 1024, family: "sdxl" | "chroma" = "sdxl"): { width: number; height: number } {
  const edge = Math.max(512, Math.min(1536, roundTo64(longEdge)));
  const panel = layout.panels.find((item) => item.id === panelId);
  if (!panel) return { width: edge, height: edge };
  const [panelWidth, panelHeight] = panelBoundsSize(panelBounds(panel.shape));
  if (panelWidth <= 0 || panelHeight <= 0) return { width: edge, height: edge };
  const ratio = panelWidth / panelHeight;
  if (family === "sdxl") {
    // 意図的仕様: SDXL は学習済み解像度バケット固定が最も安定するため、config.longEdge は無視する
    // (longEdge が効くのは chroma 系のみ。監査 SL7 の仕様確認に対する明文化)。
    const bucket = SDXL_BUCKETS.reduce((best, candidate) =>
      Math.abs(Math.log(candidate[0] / candidate[1]) - Math.log(ratio)) < Math.abs(Math.log(best[0] / best[1]) - Math.log(ratio)) ? candidate : best
    );
    return { width: bucket[0], height: bucket[1] };
  }
  const clampedRatio = Math.max(0.5, Math.min(2, ratio));
  if (clampedRatio >= 1) return { width: edge, height: roundTo64(edge / clampedRatio) };
  return { width: roundTo64(edge * clampedRatio), height: edge };
}

/**
 * コマ生成の GenerationRequest 組み立て。再利用フィンガープリント計算
 * (taskReuseFingerprintForTarget)と実生成 submit(submitTasks)の両方がここを通る。
 * 同一入力から必ず同一構造を生むことが reuse 継承の前提なので、片側だけに分岐を足すことは禁止。
 *
 * - poseControlWorkflowJson: ControlNetApplyAdvanced 検査に使う workflow JSON。fingerprint 側は
 *   reuseTemplateSnapshot(削除済みテンプレを除外)のスナップショットを渡す。省略時は
 *   templatePromptProfile の workflow JSON(submit 側の従来挙動)を使う。
 * - providerId: submit 側だけが request へ埋め込む(canonical 化では別入力として扱われるため
 *   fingerprint には影響しない)。
 */
export async function buildPanelGenerationRequest(input: {
  run: RunRow;
  plan: MangaPlanV2;
  config: ScriptMangaRunConfig;
  panel: PanelSpec;
  layout: PageLayout;
  panelId: string;
  poseControlWorkflowJson?: string;
  providerId?: string;
}): Promise<{
  request: GenerationRequest & { providerId?: string };
  references: ReturnType<typeof resolvePanelReferences>;
  conditioning: ReturnType<typeof compilePanelConditioning>;
  size: { width: number; height: number };
}> {
  const { run, plan, config, panel } = input;
  const promptProfile = templatePromptProfile(config.templateId);
  const modelFamily = referenceModelFamily(config.templateId);
  const references = resolvePanelReferences({
    projectId: run.project_id,
    providerId: config.providerId,
    cast: panel.cast,
    focalSubjectId: panel.shot.focalSubjectId,
    globalLoras: config.loras,
    modelFamily: modelFamily ?? "chroma",
    frozenSnapshot: frozenReferenceSnapshot(run)
  });
  const conditioning = compilePanelConditioning({
    panel,
    basePrompt: panel.promptBase,
    entities: plan.narrativeGraph.entities,
    dialogueById: new Map(),
    narrativeMetadata: "english-directed",
    dialect: promptProfile.dialect,
    qualityTags: promptProfile.qualityTags,
    negativeBase: promptProfile.negativeBase,
    sceneBible: plan.narrativeGraph.sceneBibles?.find((bible) => bible.settingId === panel.settingId),
    referenceAppearances: references.appearances
  });
  const size = panelGenerationSize(input.layout, input.panelId, config.longEdge, modelFamily ? "chroma" : "sdxl");
  const request: GenerationRequest & { providerId?: string } = {
    templateId: config.templateId,
    prompt: conditioning.positive,
    negativePrompt: conditioning.negative,
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
    loras: references.loras,
    reference: references.primaryReferenceSet
      ? {
          referenceSet: references.primaryReferenceSet,
          face: { enabled: modelFamily === "chroma" },
          animaInContext: { enabled: modelFamily === "anima" },
          strict: true
        }
      : references.primaryCharacterBinding
        ? {
            characterBinding: references.primaryCharacterBinding,
            face: { enabled: true },
            animaInContext: { enabled: true }
          }
        : null,
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {})
  };
  // ネームv4 D4: 棒人間骨格の ControlNet 条件付け(既定OFF)。テンプレに
  // ControlNetApplyAdvanced が無い場合は黙ってスキップ(prune済み経路と整合)。
  const poseWorkflowJson = input.poseControlWorkflowJson ?? promptProfile.workflowJson;
  if (config.poseControl?.enabled && poseWorkflowJson.includes("ControlNetApplyAdvanced")) {
    try {
      const attachment = await buildPoseControlAttachment(panel, size.width, size.height, config.poseControl);
      if (attachment) {
        request.controlnet = {
          poseImageDataUrl: attachment.poseImageDataUrl,
          strength: attachment.strength,
          startPercent: attachment.startPercent,
          endPercent: attachment.endPercent
        };
      }
    } catch {
      // 骨格添付は補助条件。失敗しても生成は止めず、fingerprint 側も同様に ControlNet 無しへフォールバックする。
    }
  }
  return { request, references, conditioning, size };
}

export async function submitTasks(runId: string, taskIds?: string[]): Promise<void> {
  const run = requireRun(runId);
  const config = requireGenerationConfig(run);
  const params: unknown[] = [run.id];
  const taskFilter = taskIds && taskIds.length > 0 ? ` AND id IN (${taskIds.map(() => "?").join(", ")})` : "";
  if (taskIds) params.push(...taskIds);
  const tasks = getRows<TaskRow>(`SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'pending'${taskFilter} ORDER BY created_at ASC`, params);
  for (const task of tasks) {
    const panel = parseJson<PanelSpec>(task.panel_spec_json, null as unknown as PanelSpec);
    if (!panel) {
      runSql("UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
        JSON.stringify({ message: "PanelSpec is missing" }),
        task.id
      ]);
      continue;
    }
    const layout = pageLayout(task.page_id);
    const frozenPlan = planFromRow(requirePlan(run.plan_id!));
    const built = await buildPanelGenerationRequest({
      run,
      plan: frozenPlan,
      config,
      panel,
      layout,
      panelId: task.panel_id,
      providerId: config.providerId
    });
    const references = built.references;
    panel.referenceManifest = references.manifest;
    panel.compiledPrompt = built.conditioning.positive;
    const request = built.request;
    const claimed = runSql(
      `UPDATE script_manga_tasks SET status = 'submitting', panel_spec_json = ?, reference_manifest_json = ?,
         attempt_count = attempt_count + 1, last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending'`,
      [JSON.stringify(panel), JSON.stringify(references.manifest), task.id]
    ) as { changes?: number };
    if (claimed.changes !== 1) continue;
    activeTaskSubmissions.add(task.id);
    try {
      const created = await createGenerationRound(run.project_id, request, task.page_id, task.panel_id, task.id);
      if (!created.round) throw new Error("Generation round was not created");
      const latestRun = requireRun(run.id);
      const latestTask = requireTask(task.id);
      if (latestRun.status === "canceled" || latestTask.status === "canceled") {
        try {
          await interruptRound(created.round.id);
        } catch {
          // Cancellation state remains authoritative; provider cleanup is best effort.
        }
      } else {
        runSql(
          `UPDATE script_manga_tasks SET round_id = ?, status = 'running', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'submitting'`,
          [created.round.id, task.id]
        );
      }
    } catch (error) {
      runSql(
        `UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'submitting'`,
        [errorJson(error), task.id]
      );
    } finally {
      activeTaskSubmissions.delete(task.id);
    }
  }
  runSql(
    `UPDATE script_manga_runs SET status = 'running', phase = 'rendering', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status <> 'canceled'`,
    [run.id]
  );
}

/** Recover the only non-atomic boundary left by an external provider call after a process restart. */
export function recoverSubmittingTasks(runId: string): void {
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'submitting'", [runId]);
  for (const task of tasks) {
    if (activeTaskSubmissions.has(task.id)) continue;
    if (!task.round_id) {
      // createGenerationRound links the round before provider submission. No link means no provider
      // call occurred, so the claimed attempt must be returned. A repair claim retains reviewed
      // candidates; restore that review (and its latest candidate round) instead of turning it into
      // a fresh txt2img submission after restart.
      const candidateIds = parseJson<string[]>(task.candidate_asset_ids_json, []);
      const latestCandidateRound = candidateIds.length > 0
        ? getRow<{ round_id: string }>(
            `SELECT a.round_id
             FROM assets a
             JOIN generation_rounds r ON r.id = a.round_id
             WHERE a.id IN (${candidateIds.map(() => "?").join(", ")})
               AND r.script_manga_task_id = ?
             ORDER BY r.round_index DESC, a.batch_index DESC
             LIMIT 1`,
            [...candidateIds, task.id]
          )
        : null;
      runSql(
        `UPDATE script_manga_tasks
         SET status = ?, round_id = ?, attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
             last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'submitting'`,
        [latestCandidateRound ? "awaiting_review" : "pending", latestCandidateRound?.round_id ?? null, task.id]
      );
      continue;
    }
    const round = getRow<{ status: string; last_error_json: string | null }>(
      "SELECT status, last_error_json FROM generation_rounds WHERE id = ? AND script_manga_task_id = ?",
      [task.round_id, task.id]
    );
    const jobCount = getRow<{ count: number }>("SELECT COUNT(*) AS count FROM generation_jobs WHERE round_id = ?", [task.round_id])?.count ?? 0;
    if (round?.status === "failed" || round?.status === "interrupted") {
      runSql(
        "UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [round.last_error_json, task.id]
      );
    } else if (jobCount > 0 || round?.status === "completed") {
      runSql("UPDATE script_manga_tasks SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [task.id]);
      ensureRoundMonitor(task.round_id);
    } else {
      const failure = JSON.stringify({
        message: "Generation submission outcome is unknown after restart; inspect the provider queue before retrying"
      });
      runSql(
        "UPDATE generation_rounds SET status = 'failed', last_error_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
        [failure, task.round_id]
      );
      runSql(
        "UPDATE script_manga_tasks SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [failure, task.id]
      );
    }
  }
}

/** Remove page mutations that may have landed immediately before a task-claim completion CAS. */
function cleanupRecoveredTaskPageEffects(task: TaskRow, candidateAssetIds: ReadonlySet<string>): void {
  if (candidateAssetIds.size === 0) return;
  const assignment = getRow<{ asset_id: string }>(
    "SELECT asset_id FROM page_panel_assignments WHERE page_id = ? AND panel_id = ?",
    [task.page_id, task.panel_id]
  );
  if (assignment && candidateAssetIds.has(assignment.asset_id)) {
    runSql(
      "DELETE FROM page_panel_assignments WHERE page_id = ? AND panel_id = ? AND asset_id = ?",
      [task.page_id, task.panel_id, assignment.asset_id]
    );
  }

  const page = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [task.page_id]);
  const objects = normalizePageObjects(page?.objects_json ? parseJson(page.objects_json, []) : []);
  const figureObjectId = `figure_${task.panel_id}`;
  const figure = objects.find((object): object is ImageObject => object.kind === "image" && object.id === figureObjectId);
  if (figure) {
    const media = getRow<{ source_asset_id: string | null }>("SELECT source_asset_id FROM page_media WHERE id = ?", [figure.mediaId]);
    if (media?.source_asset_id && candidateAssetIds.has(media.source_asset_id)) {
      runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
        JSON.stringify(normalizePageObjects(objects.filter((object) => object.id !== figureObjectId))),
        task.page_id
      ]);
      deletePageMedia(figure.mediaId);
    }
  }

  const run = requireRun(task.run_id);
  const evaluation = parseJson<Record<string, unknown>>(run.evaluation_json, {});
  const figures = { ...((evaluation.figures as Record<string, unknown>) ?? {}) };
  const record = figures[task.id] as { assetId?: unknown } | undefined;
  if (record && typeof record.assetId === "string" && candidateAssetIds.has(record.assetId)) {
    delete figures[task.id];
    runSql("UPDATE script_manga_runs SET evaluation_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
      JSON.stringify({ ...evaluation, figures }),
      run.id
    ]);
  }
}

/** Recover a predecessor-asset claim left behind if the process stopped during page materialization. */
export function recoverInheritingTasks(runId: string): void {
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'inheriting'", [runId]);
  for (const task of tasks) {
    if (activeTaskInheritances.has(task.id)) continue;
    const source = task.inherited_from_task_id
      ? getRow<Pick<TaskRow, "selected_asset_id">>("SELECT selected_asset_id FROM script_manga_tasks WHERE id = ?", [task.inherited_from_task_id])
      : null;
    cleanupRecoveredTaskPageEffects(task, new Set(source?.selected_asset_id ? [source.selected_asset_id] : []));
    runSql(
      `UPDATE script_manga_tasks SET status = 'pending', inherited_from_task_id = NULL, last_error_json = NULL,
       updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'inheriting'`,
      [task.id]
    );
  }
}

/** Recover a candidate-selection claim left behind before its synchronous completion CAS. */
export function recoverSelectingTasks(runId: string): void {
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'selecting'", [runId]);
  for (const task of tasks) {
    if (activeTaskSelections.has(task.id)) continue;
    cleanupRecoveredTaskPageEffects(task, new Set(parseJson<string[]>(task.candidate_asset_ids_json, [])));
    runSql(
      `UPDATE script_manga_tasks SET status = 'awaiting_review', inherited_from_task_id = NULL,
       reuse_fingerprint = NULL, reuse_source_json = NULL, last_error_json = NULL,
       updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'selecting'`,
      [task.id]
    );
  }
}
