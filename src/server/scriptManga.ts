import type { FountainDoc } from "../shared/fountain";
import {
  type DialoguePolicy,
  type FrozenDialogueLine,
  type MangaPlanV2,
  type MangaPlanValidationReport,
  type NormalizedBox,
  normalizeMangaPlanV2Scales,
  type PanelSpec,
  validateMangaPlanV2
} from "../shared/mangaPlanV2";
import { normalizeEditedPageLayout, panelBounds, panelBoundsSize, type PageLayout } from "../shared/pageLayout";
import { DEFAULT_MAX_DIALOGUES_PER_PANEL, applyCustomNameLayouts, planScriptManga, type ScriptMangaPlan, type ScriptMangaPlanOptions } from "../shared/scriptMangaPlan";
import { validateProvidedScriptMangaPlan } from "../shared/scriptMangaProvidedPlan";
import type { GenerationRequest, StyleLoraSelection } from "../shared/types";
import type {
  RecordExternalScriptMangaTaskAuditResponse,
  ScriptMangaExternalAuditReport,
  ScriptMangaPlanView,
  ScriptMangaRunView,
  ScriptMangaTaskView
} from "../shared/scriptMangaApi";
import type { DialogueBalloonStyle, DialogueSemanticKind, PageRow } from "../shared/apiTypes";
import {
  actionTextEstablishesVisibleActor,
  dialogueEstablishesVisibleSpeaker,
  stripClausesContainingCharacterLabels,
  textContainsCharacterLabel
} from "../shared/dialoguePresentation";
import type { ReferenceModelFamily, ScriptMangaReferenceSnapshot } from "../shared/referenceSets";
import { referenceSnapshotKey } from "../shared/referenceSets";
import { updateAssetStatus } from "./assets";
import { constrainBalloonTailTipToBounds, initialBalloonTailTip } from "../shared/balloonTailAim";
import { balloonContentMaxWidth, balloonInscribedFactor } from "../shared/balloonShape";
import { CONTENT_PADDING_RATIO } from "../shared/pageObjects";
import { computeTextLayoutForContent } from "./textLayoutApi";
import { orderPanelsByReadingDirection } from "../shared/dialogueAutoLayout";
import { normalizePageObjects, type BalloonObject, type ImageObject } from "../shared/pageObjects";
import { splitDialogueUnits, type DialogueUnit } from "../shared/dialogueAdaptation";
import { auditLettering } from "../shared/letteringQuality";
import { isMangaEffectObject } from "../shared/mangaEffects";
import { fitPageBalloonText } from "./balloonTextFit";
import { compilePanelConditioning } from "./panelPromptCompiler";
import { inferPromptProfile } from "./templates";
import { releaseComfyModelsForAudit } from "./comfy";
import { createId, dataRoot, getRow, getRows, runSql, toApiRow } from "./db";
import { allocateDialoguePages } from "./dialogueAllocation";
import { applyDialogueLayout, reflowDialogueLayout } from "./dialogueAutoLayoutApi";
import { cutoutFigure } from "./figureCutout";
import { createPageMediaFromBuffer, deletePageMedia } from "./pageMedia";
import { upsertPanelAssignment } from "./panelAssignments";
import { HttpError } from "./http";
import { latestRevision, requireScript } from "./scriptRevisions";
import { resolveLayoutTemplate } from "./layoutTemplates";
import { createPage, updatePage } from "./pages";
import { validatePanelPreflight, type PanelPreflightReport } from "./panelPreflightValidator";
import { evaluatePanelCandidate } from "./panelVisualEvaluator";
import { evaluateDeterministicPanelQuality } from "./deterministicPanelQuality";
import { resolvePanelReferences } from "./referenceResolver";
import { createGenerationRound, ensureRoundMonitor, interruptRound } from "./rounds";
import { resolveRoundAttachmentPath, type RoundAttachmentKind } from "./roundAttachments";
import { withImageExport, type ImageExportResult } from "./imageExport";
import { withOpenRasterExport, type OpenRasterExportResult } from "./openRasterExport";
import sharp from "sharp";
import { renderPoseSkeletonSvg } from "../shared/poseSkeletonSvg";
import { OPENPOSE_JOINT_COUNT, type PosePoint } from "../shared/poseTypes";
import { visibleJointsForPoseMode } from "../shared/posePresetLibrary";
import { reconstructPanelPoses, type PoseControlMode } from "./panelPoseReconstructor";
import { directAdoptedCandidatePlan, planScriptMangaWithDirectorDetailed } from "./scriptMangaDirector";
import { readCachedBeatAnnotation, type BeatAnnotationResult } from "./scriptBeatAnnotator";
import { buildPreLayoutUnits } from "../shared/preLayoutBeat";
import {
  adoptablePlanCandidate,
  beginPlanCandidateAdoption,
  fixedEmbeddedCandidateDirection,
  isExternallyDirectedPlanCandidate,
  isFixedDirectedPlanCandidate,
  markPlanCandidateAdopted,
  revertPlanCandidateAdoption,
  scriptMangaCandidateDirectionInputHash
} from "./scriptMangaPlanCandidates";
import { buildMangaPlanV2 } from "./scriptMangaPlanV2";
import {
  computeScriptMangaReuseFingerprint,
  matchScriptMangaReuseCandidatesWithReservations,
  SCRIPT_MANGA_REUSE_FINGERPRINT_VERSION
} from "./scriptMangaInheritance";
import { acquireVlmModel, getVlmAuditSettings, releaseVlmModel } from "./vlmAudit";
import type { StoryGraphCharacterInput, StoryGraphDialogueInput } from "./storyGraphBuilder";
import { objectBody, requiredString, stringOr } from "./validate";
import { createHash } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { hashJson } from "./workflowGraph";
import { normalizeGenerationRequest } from "./generationRequest";
import { isPathInside } from "./paths";
import { resolveMangaFontId } from "./fonts";
import {
  buildScriptMangaRepairGenerationRequest,
  parseScriptMangaRepairRequest
} from "./scriptMangaRepair";

interface RunRow {
  id: string;
  predecessor_run_id: string | null;
  project_id: string;
  script_id: string;
  script_revision_id: string | null;
  plan_id: string | null;
  plan_version: number;
  planner_version: string;
  prompt_compiler_version: string;
  status: string;
  phase: string;
  approval_status: string;
  page_count: number;
  panel_count: number;
  completed_count: number;
  failed_count: number;
  config_json: string;
  evaluation_json: string | null;
  export_manifest_json: string | null;
  generation_budget_json: string;
  reference_snapshot_json: string | null;
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
  prompt: string;
  panel_spec_json: string | null;
  reference_manifest_json: string;
  candidate_asset_ids_json: string;
  selected_asset_id: string | null;
  scores_json: string | null;
  attempt_count: number;
  repair_parent_task_id: string | null;
  inherited_from_task_id: string | null;
  reuse_fingerprint: string | null;
  reuse_source_json: string | null;
  dependency_task_ids_json: string;
  status: string;
  asset_id: string | null;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  id: string;
  project_id: string;
  script_id: string;
  script_revision_id: string;
  plan_version: number;
  planner_version: string;
  prompt_compiler_version: string;
  dialogue_policy: string;
  status: string;
  plan_json: string;
  validation_json: string;
  edit_version: number;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

/** 棒人間ControlNet(ネームv4 D4)。既定OFF・弱め/早期終了(骨格で漫画的デフォルメを殺さない)。 */
interface PoseControlConfig {
  enabled: boolean;
  mode: PoseControlMode;
  strength: number;
  endPercent: number;
}

interface ScriptMangaRunConfig {
  templateId: string;
  providerId: string;
  batchSize: 1;
  planningMode: "heuristic" | "llm" | "provided";
  pageLimit: number;
  maxPanelCount: number;
  loras: StyleLoraSelection[];
  generateImages: boolean;
  candidateSelectionPolicy: "review" | "metadata";
  auditMode: "manual" | "vlm";
  longEdge: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  planOptions: ScriptMangaPlanOptions;
  requireReferenceSets: boolean;
  allowReferenceFallback: boolean;
  poseControl?: PoseControlConfig;
  /** Persisted before materialization so startup can reconcile a crash after candidate claim. */
  planCandidateId?: string;
}

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
const activeTaskSubmissions = new Set<string>();
const activeTaskInheritances = new Set<string>();
const activeTaskSelections = new Set<string>();
const activeAuditRuns = new Map<string, Promise<void>>();
let visualAuditQueue: Promise<void> = Promise.resolve();

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function errorJson(error: unknown): string {
  return JSON.stringify({ message: error instanceof Error ? error.message : String(error) });
}

function revisionById(scriptId: string, revisionId: string): { id: string; doc: FountainDoc } {
  const row = getRow<{ id: string; parsed_json: string }>(
    "SELECT id, parsed_json FROM script_revisions WHERE id = ? AND script_id = ?",
    [revisionId, scriptId]
  );
  if (!row) throw new HttpError(409, "The predecessor's pinned Fountain revision is unavailable");
  try {
    return { id: row.id, doc: JSON.parse(row.parsed_json) as FountainDoc };
  } catch {
    throw new HttpError(500, "Stored Fountain revision is invalid");
  }
}

function requireRun(runId: string): RunRow {
  const row = getRow<RunRow>("SELECT * FROM script_manga_runs WHERE id = ?", [runId]);
  if (!row) throw new HttpError(404, "Script manga run was not found");
  return row;
}

function requirePlan(planId: string): PlanRow {
  const row = getRow<PlanRow>("SELECT * FROM script_manga_plans WHERE id = ?", [planId]);
  if (!row) throw new HttpError(404, "Script manga plan was not found");
  return row;
}

function requireTask(taskId: string): TaskRow {
  const row = getRow<TaskRow>("SELECT * FROM script_manga_tasks WHERE id = ?", [taskId]);
  if (!row) throw new HttpError(404, "Script manga task was not found");
  return row;
}

function planFromRow(row: PlanRow): MangaPlanV2 {
  const plan = parseJson<MangaPlanV2>(row.plan_json, null as unknown as MangaPlanV2);
  // V5 D1: 旧語彙(importance)だけの旧planへ visualScale を補完する入力adapter。
  return plan ? normalizeMangaPlanV2Scales(plan) : plan;
}

function planView(row: PlanRow): ScriptMangaPlanView {
  return {
    id: row.id,
    projectId: row.project_id,
    scriptId: row.script_id,
    scriptRevisionId: row.script_revision_id,
    status: row.status,
    plan: planFromRow(row),
    validation: parseJson<MangaPlanValidationReport>(row.validation_json, { ok: false, issues: [] }),
    editVersion: row.edit_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at
  };
}

function taskView(row: TaskRow): ScriptMangaTaskView {
  const selectedId = row.selected_asset_id ?? row.asset_id;
  const selectedAssetId = selectedId && getRow("SELECT id FROM assets WHERE id = ?", [selectedId]) ? selectedId : null;
  return {
    id: row.id,
    pageId: row.page_id,
    panelId: row.panel_id,
    roundId: row.round_id,
    status: row.status,
    attemptCount: row.attempt_count,
    candidateAssetIds: parseJson<string[]>(row.candidate_asset_ids_json, []),
    selectedAssetId,
    inheritedFromTaskId: row.inherited_from_task_id,
    reuseFingerprint: row.reuse_fingerprint,
    scores: parseJson<unknown>(row.scores_json, null),
    lastError: parseJson<unknown>(row.last_error_json, null)
  };
}

function runView(row: RunRow): ScriptMangaRunView {
  const planRow = row.plan_id ? getRow<PlanRow>("SELECT * FROM script_manga_plans WHERE id = ?", [row.plan_id]) : null;
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at ASC", [row.id]);
  return {
    id: row.id,
    predecessorRunId: row.predecessor_run_id,
    projectId: row.project_id,
    scriptId: row.script_id,
    scriptRevisionId: row.script_revision_id,
    planId: row.plan_id,
    planVersion: row.plan_version,
    status: row.status,
    phase: row.phase,
    approvalStatus: row.approval_status,
    pageCount: row.page_count,
    panelCount: row.panel_count,
    completedCount: row.completed_count,
    failedCount: row.failed_count,
    evaluation: parseJson<unknown>(row.evaluation_json, null),
    exportManifest: parseJson<unknown>(row.export_manifest_json, null),
    generationBudget: parseJson<unknown>(row.generation_budget_json, {}),
    referenceSnapshot: parseJson<ScriptMangaReferenceSnapshot | null>(row.reference_snapshot_json, null),
    auditMode: parseConfig(row).auditMode,
    lastError: parseJson<unknown>(row.last_error_json, null),
    plan: planRow ? planFromRow(planRow) : null,
    planEditVersion: planRow ? planRow.edit_version : null,
    validation: planRow ? parseJson<MangaPlanValidationReport>(planRow.validation_json, { ok: false, issues: [] }) : null,
    tasks: tasks.map(taskView),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

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
    const bucket = SDXL_BUCKETS.reduce((best, candidate) =>
      Math.abs(Math.log(candidate[0] / candidate[1]) - Math.log(ratio)) < Math.abs(Math.log(best[0] / best[1]) - Math.log(ratio)) ? candidate : best
    );
    return { width: bucket[0], height: bucket[1] };
  }
  const clampedRatio = Math.max(0.5, Math.min(2, ratio));
  if (clampedRatio >= 1) return { width: edge, height: roundTo64(edge / clampedRatio) };
  return { width: roundTo64(edge * clampedRatio), height: edge };
}

function removeUnusedStarterPage(projectId: string): void {
  const pages = getRows<{ id: string; title: string; layout_json: string | null; objects_json: string | null }>(
    "SELECT id, title, layout_json, objects_json FROM pages WHERE project_id = ? ORDER BY page_index ASC",
    [projectId]
  );
  if (pages.length !== 1) return;
  const page = pages[0]!;
  const owned = getRow("SELECT page_id FROM script_manga_run_pages WHERE page_id = ?", [page.id]);
  const hasRound = getRow("SELECT id FROM generation_rounds WHERE page_id = ? LIMIT 1", [page.id]);
  const hasPlacement = getRow("SELECT id FROM dialogue_placements WHERE page_id = ? LIMIT 1", [page.id]);
  if (!owned && !page.title && !page.layout_json && !page.objects_json && !hasRound && !hasPlacement) {
    runSql("DELETE FROM pages WHERE id = ?", [page.id]);
  }
}

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

function actualTextSafeZones(pageId: string, layout: PageLayout, panelId: string): NormalizedBox[] {
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

function loadCharacters(projectId: string): StoryGraphCharacterInput[] {
  return getRows<{ id: string; name: string; aliases_json: string | null; notes: string; color: string | null }>(
    "SELECT id, name, aliases_json, notes, color FROM characters WHERE project_id = ? ORDER BY created_at ASC",
    [projectId]
  ).map((row) => ({
    id: row.id,
    name: row.name,
    aliases: parseJson<string[]>(row.aliases_json, []),
    notes: row.notes,
    color: row.color
  }));
}

function loadActiveDialogues(scriptId: string): StoryGraphDialogueInput[] {
  return getRows<{
    id: string;
    order_index: number;
    scene_index: number | null;
    character_id: string | null;
    speaker_label: string;
    text: string;
    semantic_kind: string;
    balloon_style: string;
  }>(
    `SELECT id, order_index, scene_index, character_id, speaker_label, text, semantic_kind, balloon_style
     FROM dialogue_lines WHERE script_id = ? AND status = 'active' ORDER BY order_index ASC`,
    [scriptId]
  ).map((row) => ({
    id: row.id,
    orderIndex: row.order_index,
    sceneIndex: row.scene_index ?? 0,
    characterId: row.character_id,
    speakerLabel: row.speaker_label,
    text: row.text,
    semanticKind: row.semantic_kind,
    balloonStyle: row.balloon_style
  }));
}

function loadDialoguesByIds(ids: string[], projectId: string, scriptId: string): StoryGraphDialogueInput[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return getRows<{
    id: string;
    order_index: number;
    scene_index: number | null;
    character_id: string | null;
    speaker_label: string;
    text: string;
    semantic_kind: string;
    balloon_style: string;
  }>(
    `SELECT id, order_index, scene_index, character_id, speaker_label, text, semantic_kind, balloon_style
     FROM dialogue_lines WHERE project_id = ? AND script_id = ? AND id IN (${placeholders})`,
    [projectId, scriptId, ...ids]
  ).map((row) => ({
    id: row.id,
    orderIndex: row.order_index,
    sceneIndex: row.scene_index ?? 0,
    characterId: row.character_id,
    speakerLabel: row.speaker_label,
    text: row.text,
    semanticKind: row.semantic_kind,
    balloonStyle: row.balloon_style
  }));
}

function templatePromptProfile(templateId: string) {
  const row = getRow<{ workflow_json: string; prompt_dialect: string; quality_tags: string; negative_base: string }>(
    "SELECT workflow_json, prompt_dialect, quality_tags, negative_base FROM workflow_templates WHERE id = ?",
    [templateId]
  );
  const inferred = inferPromptProfile(row?.workflow_json ? JSON.parse(row.workflow_json) : {}, row?.prompt_dialect);
  return {
    dialect: inferred.promptDialect,
    qualityTags: row?.quality_tags || inferred.qualityTags,
    negativeBase: row?.negative_base || inferred.negativeBase,
    workflowJson: row?.workflow_json ?? ""
  };
}

function referenceModelFamily(templateId: string): ReferenceModelFamily | null {
  const workflowJson = templatePromptProfile(templateId).workflowJson;
  if (!workflowJson) return null;
  if (/anima|qwen_3_06b_base/iu.test(workflowJson)) return "anima";
  if (/chroma|auraflow|ModelSamplingAuraFlow/iu.test(workflowJson)) return "chroma";
  return null;
}

function frozenReferenceSnapshot(run: RunRow): ScriptMangaReferenceSnapshot | null {
  return parseJson<ScriptMangaReferenceSnapshot | null>(run.reference_snapshot_json, null);
}

function collectReferenceSnapshot(run: RunRow, plan: MangaPlanV2, config: ScriptMangaRunConfig): ScriptMangaReferenceSnapshot | null {
  const modelFamily = referenceModelFamily(config.templateId);
  if (!modelFamily) return null;
  const sets = new Map<string, ScriptMangaReferenceSnapshot["sets"][number]>();
  const missing = new Set<string>();
  const dialogueById = new Map(plan.dialogueSnapshots.map((line) => [line.id, line]));
  for (const panel of plan.pages.flatMap((page) => page.panels)) {
    const normalized = normalizePanelCast(panel, dialogueById, sourceGroundedCharacterIds(panel, plan.narrativeGraph));
    const resolved = resolvePanelReferences({
      projectId: run.project_id,
      providerId: config.providerId,
      cast: normalized.cast,
      focalSubjectId: panel.shot.focalSubjectId,
      globalLoras: config.loras,
      modelFamily
    });
    for (const set of resolved.appearances) sets.set(referenceSnapshotKey(set.characterId, set.variantId), set);
    const appearanceKeys = new Set(resolved.appearances.map((set) => referenceSnapshotKey(set.characterId, set.variantId)));
    for (const member of normalized.cast) {
      if (!appearanceKeys.has(referenceSnapshotKey(member.characterId, member.variantId))) missing.add(member.characterId);
    }
    for (const characterId of resolved.missingReferenceIds) missing.add(characterId);
  }
  if (config.requireReferenceSets && missing.size > 0 && !config.allowReferenceFallback) {
    throw new HttpError(422, `Approved ${modelFamily} Reference Set is required for: ${[...missing].join(", ")}`);
  }
  return {
    modelFamily,
    approvedAt: new Date().toISOString(),
    allowFallback: config.allowReferenceFallback,
    sets: [...sets.values()]
  };
}

function layoutPanelCount(layoutTemplateId: string): number | null {
  return resolveLayoutTemplate(layoutTemplateId)?.panels.length ?? null;
}

function validatePlan(plan: MangaPlanV2): MangaPlanValidationReport {
  return validateMangaPlanV2(plan);
}

function clonePageLayout(layout: PageLayout): PageLayout {
  return JSON.parse(JSON.stringify(layout)) as PageLayout;
}

function parseDialoguePolicy(value: unknown): DialoguePolicy {
  const policy = typeof value === "string" ? value : "preserve";
  if (policy === "preserve" || policy === "adapt" || policy === "fill") return policy;
  if (policy === "generate") throw new HttpError(400, "dialoguePolicy generate requires a future lexical-similarity gate");
  throw new HttpError(400, 'dialoguePolicy must be "preserve", "adapt", "fill", or "generate"');
}

function parseConfig(run: RunRow): ScriptMangaRunConfig {
  const parsed = parseJson<Partial<ScriptMangaRunConfig>>(run.config_json, {});
  return {
    ...parsed,
    auditMode: parsed.auditMode === "vlm" ? "vlm" : "manual",
    maxPanelCount: typeof parsed.maxPanelCount === "number" ? parsed.maxPanelCount : 0
  } as ScriptMangaRunConfig;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value)))
    : fallback;
}

function planningOptionsFromInput(
  input: Record<string, unknown>,
  fallback: ScriptMangaPlanOptions = {}
): ScriptMangaPlanOptions {
  const requestedTarget = input.targetPageCount;
  const targetPageCount = typeof requestedTarget === "number" && Number.isFinite(requestedTarget)
    ? Math.trunc(requestedTarget) > 0
      ? Math.max(1, Math.min(200, Math.trunc(requestedTarget)))
      : undefined
    : fallback.targetPageCount;
  const requestedStyle = typeof input.stylePrompt === "string" ? input.stylePrompt.trim() : null;
  return {
    panelsPerPage: boundedInteger(input.panelsPerPage, fallback.panelsPerPage ?? 4, 1, 6),
    maxElementsPerPanel: boundedInteger(input.maxElementsPerPanel, fallback.maxElementsPerPanel ?? 6, 1, 24),
    targetPageCount,
    maxDialoguesPerPanel: boundedInteger(input.maxDialoguesPerPanel, fallback.maxDialoguesPerPanel ?? DEFAULT_MAX_DIALOGUES_PER_PANEL, 1, 8),
    stylePrompt: requestedStyle === null ? fallback.stylePrompt : requestedStyle || undefined
  };
}

/** Candidate preflight and adoption must hash the exact same direction-affecting options. */
export function scriptMangaCandidateDirectionOptionsFromInput(
  input: Record<string, unknown>,
  scriptRevisionId: string
): ScriptMangaPlanOptions {
  const options = planningOptionsFromInput(input);
  const dialoguePolicy = parseDialoguePolicy(input.dialoguePolicy);
  if ((dialoguePolicy === "adapt" || dialoguePolicy === "fill") && input.panelsPerPage === undefined) {
    options.panelsPerPage = 2;
  }
  return {
    ...options,
    scriptRevisionId,
    characterBible: stringOr(input.characterBible, "") || undefined
  };
}

function styleLorasFromInput(value: unknown, fallback: StyleLoraSelection[] = []): StyleLoraSelection[] {
  if (!Array.isArray(value)) return fallback.map((item) => ({ ...item }));
  return value.flatMap((raw) =>
    raw && typeof raw === "object"
      ? [{
          name: stringOr((raw as Record<string, unknown>).name, ""),
          strength: typeof (raw as Record<string, unknown>).strength === "number"
            ? (raw as Record<string, number>).strength
            : 1
        }]
      : []
  ).filter((item) => item.name.trim()).slice(0, 4);
}

function restoreFrozenPlanSources(candidate: MangaPlanV2, original: MangaPlanV2): void {
  candidate.narrativeGraph = {
    ...candidate.narrativeGraph,
    sourceElements: structuredClone(original.narrativeGraph.sourceElements),
    entities: structuredClone(original.narrativeGraph.entities),
    warnings: structuredClone(original.narrativeGraph.warnings)
  };
  candidate.fillUnits = original.fillUnits ? structuredClone(original.fillUnits) : undefined;
}

function completeSuccessorPlan(raw: unknown, original: MangaPlanV2, planId: string): MangaPlanV2 {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "successorPlan must be a complete MangaPlanV2 object");
  let candidate: MangaPlanV2;
  try {
    candidate = JSON.parse(JSON.stringify(raw)) as MangaPlanV2;
  } catch {
    throw new HttpError(400, "successorPlan must be valid JSON");
  }
  if (candidate.version !== 2 || !Array.isArray(candidate.pages) || !candidate.narrativeGraph) {
    throw new HttpError(400, "successorPlan must be a complete MangaPlanV2 object");
  }
  // V5 D1: successorPlan はDB非経由の生API入力 = 旧語彙adapterの適用境界(3箇所のうちの1つ)。
  normalizeMangaPlanV2Scales(candidate);
  const originalPages = new Map(original.pages.map((page) => [page.index, page]));
  try {
    candidate.pages = candidate.pages.map((page) => {
      if (!page || typeof page !== "object" || !Array.isArray(page.panels) || typeof page.layoutTemplateId !== "string") {
        throw new HttpError(400, "successorPlan contains a malformed page");
      }
      const originalPage = originalPages.get(page.index);
      const snapshot = originalPage?.layoutTemplateId === page.layoutTemplateId
        ? originalPage.layoutSnapshot
        : resolveLayoutTemplate(page.layoutTemplateId);
      if (!snapshot) throw new HttpError(422, `Layout template could not be resolved: ${page.layoutTemplateId}`);
      return { ...page, layoutSnapshot: clonePageLayout(snapshot) };
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "successorPlan contains malformed pages");
  }
  candidate.id = planId;
  candidate.scriptId = original.scriptId;
  candidate.scriptRevisionId = original.scriptRevisionId;
  candidate.sourceDialogueLineIds = [...original.sourceDialogueLineIds];
  candidate.dialogueSnapshots = original.dialogueSnapshots.map((snapshot) => ({ ...snapshot }));
  candidate.dialoguePolicy = original.dialoguePolicy;
  candidate.plannerVersion = original.plannerVersion;
  candidate.promptCompilerVersion = original.promptCompilerVersion;
  candidate.plannerProvenance = original.plannerProvenance;
  restoreFrozenPlanSources(candidate, original);
  candidate.title = typeof candidate.title === "string" && candidate.title.trim() ? candidate.title : original.title;
  candidate.panelCount = candidate.pages.reduce((sum, page) => sum + page.panels.length, 0);
  candidate.dialogueCount = new Set(candidate.pages.flatMap((page) => page.panels.flatMap((panel) => panel.dialogueLineIds))).size;
  candidate.createdAt = new Date().toISOString();
  return candidate;
}

function requirePanelBudget(plan: MangaPlanV2, maxPanelCount: number): void {
  if (maxPanelCount > 0 && plan.panelCount > maxPanelCount) {
    throw new HttpError(
      422,
      `MangaPlanV2 has ${plan.panelCount} panels, exceeding maxPanelCount ${maxPanelCount}; revise the name before generation`
    );
  }
}

function requireDialogueBudget(plan: MangaPlanV2, maxDialoguesPerPanel: number): void {
  const maximum = Math.max(1, Math.min(8, Math.trunc(maxDialoguesPerPanel)));
  const oversized = plan.pages
    .flatMap((page) => page.panels.map((panel) => ({ pageIndex: page.index, panel })))
    .find(({ panel }) => panel.dialogueLineIds.length > maximum);
  if (oversized) {
    throw new HttpError(
      422,
      `Panel ${oversized.panel.id} on page ${oversized.pageIndex + 1} has ${oversized.panel.dialogueLineIds.length} dialogue elements, exceeding maxDialoguesPerPanel ${maximum}`
    );
  }
}

function requirePagePanelBudget(plan: MangaPlanV2, panelsPerPage: number): void {
  const maximum = Math.max(1, Math.min(6, Math.trunc(panelsPerPage)));
  const oversized = plan.pages.find((page) => page.panels.length > maximum);
  if (oversized) {
    throw new HttpError(
      422,
      `Page ${oversized.index + 1} has ${oversized.panels.length} panels, exceeding panelsPerPage ${maximum}`
    );
  }
}

function requireRunPanelBudget(run: RunRow, plan: MangaPlanV2): void {
  const config = parseConfig(run);
  requirePanelBudget(plan, config.maxPanelCount);
  requireDialogueBudget(plan, config.planOptions?.maxDialoguesPerPanel ?? DEFAULT_MAX_DIALOGUES_PER_PANEL);
  requirePagePanelBudget(plan, config.planOptions?.panelsPerPage ?? 4);
}

function persistPlan(projectId: string, plan: MangaPlanV2, validation: MangaPlanValidationReport): void {
  runSql(
    `INSERT INTO script_manga_plans
       (id, project_id, script_id, script_revision_id, plan_version, planner_version, prompt_compiler_version,
        dialogue_policy, status, plan_json, validation_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [
      plan.id,
      projectId,
      plan.scriptId,
      plan.scriptRevisionId,
      plan.version,
      plan.plannerVersion,
      plan.promptCompilerVersion,
      plan.dialoguePolicy,
      JSON.stringify(plan),
      JSON.stringify(validation)
    ]
  );
}

function existingRunPage(runId: string, pageIndex: number): { page_id: string } | null {
  return getRow<{ page_id: string }>("SELECT page_id FROM script_manga_run_pages WHERE run_id = ? AND page_index = ?", [runId, pageIndex]);
}

interface ReusableRunPageRow {
  page_id: string;
  previous_run_id: string;
  objects_json: string | null;
}

function planOnlyRunPage(run: RunRow, candidate: ReusableRunPageRow): boolean {
  const hasGeneration = getRow(
    "SELECT id FROM generation_rounds WHERE page_id = ? LIMIT 1",
    [candidate.page_id]
  );
  const hasAssignment = getRow(
    "SELECT page_id FROM page_panel_assignments WHERE page_id = ? LIMIT 1",
    [candidate.page_id]
  );
  if (hasGeneration || hasAssignment) return false;

  const placements = getRows<{ balloon_object_id: string | null; script_id: string | null }>(
    `SELECT dp.balloon_object_id, dl.script_id
     FROM dialogue_placements dp
     LEFT JOIN dialogue_lines dl ON dl.id = dp.line_id
     WHERE dp.page_id = ?`,
    [candidate.page_id]
  );
  if (placements.some((placement) => placement.script_id !== run.script_id)) return false;
  const ownedBalloonIds = new Set(
    placements.flatMap((placement) => placement.balloon_object_id ? [placement.balloon_object_id] : [])
  );
  const rawObjects = parseJson<unknown>(candidate.objects_json, []);
  if (!Array.isArray(rawObjects)) return false;
  return rawObjects.every((object) => {
    if (!object || typeof object !== "object") return false;
    const record = object as Record<string, unknown>;
    return record.kind === "balloon" && typeof record.id === "string" && ownedBalloonIds.has(record.id);
  });
}

function reusableRunPage(run: RunRow, pageIndex: number): ReusableRunPageRow | null {
  const candidates = getRows<ReusableRunPageRow>(
    `SELECT rp.page_id, previous.id AS previous_run_id, page.objects_json
     FROM script_manga_run_pages rp
     JOIN script_manga_runs previous ON previous.id = rp.run_id
     JOIN pages page ON page.id = rp.page_id
     WHERE previous.project_id = ? AND previous.script_id = ? AND previous.id <> ?
       AND previous.status IN ('canceled', 'failed') AND rp.page_index = ?
     ORDER BY previous.updated_at DESC`,
    [run.project_id, run.script_id, run.id, pageIndex]
  );
  return candidates.find((candidate) => planOnlyRunPage(run, candidate)) ?? null;
}

function pageLayout(pageId: string): PageLayout {
  const row = getRow<{ layout_json: string | null }>("SELECT layout_json FROM pages WHERE id = ?", [pageId]);
  const layout = normalizeEditedPageLayout(row?.layout_json ? JSON.parse(row.layout_json) : null);
  if (!layout) throw new HttpError(500, `Page ${pageId} has no executable layout`);
  return layout;
}

function ensureRunPage(run: RunRow, pageSpec: MangaPlanV2["pages"][number]): { pageId: string; layout: PageLayout } {
  const existing = existingRunPage(run.id, pageSpec.index);
  if (existing) {
    const layout = pageLayout(existing.page_id);
    if (JSON.stringify(layout) !== JSON.stringify(pageSpec.layoutSnapshot)) {
      throw new HttpError(409, `Run-owned page ${pageSpec.index + 1} no longer matches its approved layout snapshot`);
    }
    return { pageId: existing.page_id, layout };
  }
  runSql("SAVEPOINT script_manga_page_create");
  try {
    const reusable = reusableRunPage(run, pageSpec.index);
    const page = reusable ? { id: reusable.page_id } : createPage(run.project_id);
    const layout = clonePageLayout(pageSpec.layoutSnapshot);
    if (reusable) {
      runSql("DELETE FROM script_manga_tasks WHERE run_id = ? AND page_id = ?", [reusable.previous_run_id, page.id]);
      runSql("DELETE FROM dialogue_placements WHERE page_id = ?", [page.id]);
      runSql("DELETE FROM script_manga_run_pages WHERE run_id = ? AND page_id = ?", [reusable.previous_run_id, page.id]);
    }
    runSql("UPDATE pages SET layout_json = ?, objects_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
      JSON.stringify(layout),
      page.id
    ]);
    updatePage(run.project_id, page.id, { title: pageSpec.title });
    runSql(
      "INSERT INTO script_manga_run_pages (run_id, page_id, page_index, layout_template_id) VALUES (?, ?, ?, ?)",
      [run.id, page.id, pageSpec.index, pageSpec.layoutTemplateId]
    );
    runSql("RELEASE script_manga_page_create");
    return { pageId: page.id, layout };
  } catch (error) {
    runSql("ROLLBACK TO script_manga_page_create");
    runSql("RELEASE script_manga_page_create");
    throw error;
  }
}

function ensureDialogueLettering(
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

function upsertPreparedTask(input: {
  runId: string;
  pageId: string;
  layoutPanelId: string;
  panel: PanelSpec;
  preflight: PanelPreflightReport;
}): void {
  const existing = getRow<{ id: string; status: string }>(
    "SELECT id, status FROM script_manga_tasks WHERE run_id = ? AND page_id = ? AND panel_id = ?",
    [input.runId, input.pageId, input.layoutPanelId]
  );
  if (existing) {
    if (existing.status === "pending" || existing.status === "blocked") {
      runSql(
        `UPDATE script_manga_tasks SET prompt = ?, panel_spec_json = ?, reference_manifest_json = ?, scores_json = ?,
           status = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [
          input.panel.compiledPrompt,
          JSON.stringify(input.panel),
          JSON.stringify(input.panel.referenceManifest),
          JSON.stringify({ preflight: input.preflight }),
          input.preflight.passed ? "pending" : "blocked",
          input.preflight.passed ? null : JSON.stringify({ message: "Panel preflight failed", violations: input.preflight.violations }),
          existing.id
        ]
      );
    }
    return;
  }
  runSql(
    `INSERT INTO script_manga_tasks
       (id, run_id, page_id, panel_id, prompt, panel_spec_json, reference_manifest_json, scores_json, status, last_error_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createId("manga_task"),
      input.runId,
      input.pageId,
      input.layoutPanelId,
      input.panel.compiledPrompt,
      JSON.stringify(input.panel),
      JSON.stringify(input.panel.referenceManifest),
      JSON.stringify({ preflight: input.preflight }),
      input.preflight.passed ? "pending" : "blocked",
      input.preflight.passed ? null : JSON.stringify({ message: "Panel preflight failed", violations: input.preflight.violations })
    ]
  );
}

function sourceGroundedCharacterIds(panel: PanelSpec, graph: MangaPlanV2["narrativeGraph"]): Set<string> {
  const sourceIds = new Set(panel.sourceElementIds);
  const visualSources = graph.sourceElements.filter((source) =>
    sourceIds.has(source.id) &&
    source.sceneIndex === panel.sceneIndex &&
    (source.type === "action" || source.type === "synopsis")
  );
  return new Set(graph.entities
    .filter((entity) => entity.kind === "character" &&
      visualSources.some((source) => actionTextEstablishesVisibleActor(source.text, [entity.name, ...entity.aliases])))
    .map((entity) => entity.id));
}

function normalizePanelCast(
  panel: PanelSpec,
  dialogueById: Map<string, StoryGraphDialogueInput>,
  sourceGroundedIds: ReadonlySet<string>
): {
  cast: PanelSpec["cast"];
  excludedOffscreenIds: string[];
} {
  const excludedOffscreenIds: string[] = [];
  const byKey = new Map<string, PanelSpec["cast"][number]>();
  for (const member of panel.cast) {
    // A provided plan may omit speakingLineIds. Reconstruct the member's actual panel lines from
    // the frozen dialogue assignment instead of trusting that denormalized convenience field.
    const lineIds = [...new Set([...member.speakingLineIds, ...panel.dialogueLineIds])];
    const lines = lineIds
      .map((id) => dialogueById.get(id))
      .filter((line): line is StoryGraphDialogueInput => line !== undefined && line.characterId === member.characterId);
    const dialogueGroundsSpeaker = lines.some((line) => dialogueEstablishesVisibleSpeaker(line));
    const explicitlyVisible = sourceGroundedIds.has(member.characterId);
    if (!dialogueGroundsSpeaker && !explicitlyVisible) {
      excludedOffscreenIds.push(member.characterId);
      continue;
    }
    const key = referenceSnapshotKey(member.characterId, member.variantId);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...member, speakingLineIds: lines.map((line) => line.id) });
      continue;
    }
    existing.speakingLineIds = [...new Set([...existing.speakingLineIds, ...member.speakingLineIds])];
  }
  for (const lineId of panel.dialogueLineIds) {
    const line = dialogueById.get(lineId);
    if (line?.characterId && !dialogueEstablishesVisibleSpeaker(line) && !sourceGroundedIds.has(line.characterId)) {
      excludedOffscreenIds.push(line.characterId);
    }
  }
  const explicitAbsentIds = new Set(panel.mustNotShow
    .filter((constraint) => constraint.kind === "entity-absent" && constraint.entityId)
    .map((constraint) => constraint.entityId!));
  for (const characterId of sourceGroundedIds) {
    if (explicitAbsentIds.has(characterId) && !panel.cast.some((member) => member.characterId === characterId)) {
      excludedOffscreenIds.push(characterId);
    }
  }
  return { cast: [...byKey.values()], excludedOffscreenIds: [...new Set(excludedOffscreenIds)] };
}

function materializeRun(runId: string): void {
  const run = requireRun(runId);
  if (!run.plan_id) throw new HttpError(409, "Run has no persisted MangaPlanV2");
  const planRow = requirePlan(run.plan_id);
  const plan = planFromRow(planRow);
  const config = parseConfig(run);
  const liveDialogueRows = loadDialoguesByIds(plan.sourceDialogueLineIds, run.project_id, run.script_id);
  if (liveDialogueRows.length !== plan.sourceDialogueLineIds.length) {
    throw new HttpError(422, "One or more frozen dialogue lines no longer belong to this project/script");
  }
  const dialogueRows: StoryGraphDialogueInput[] = plan.dialogueSnapshots.map((snapshot) => ({
    id: snapshot.id,
    orderIndex: snapshot.orderIndex,
    sceneIndex: snapshot.sceneIndex,
    characterId: snapshot.characterId,
    speakerLabel: snapshot.speakerLabel,
    text: snapshot.text,
    semanticKind: snapshot.semanticKind,
    balloonStyle: snapshot.balloonStyle
  }));
  const dialogueById = new Map(dialogueRows.map((line) => [line.id, line]));
  const dialogueSnapshots = new Map(plan.dialogueSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const promptProfile = templatePromptProfile(config.templateId);
  const modelFamily = referenceModelFamily(config.templateId);
  const referenceSnapshot = frozenReferenceSnapshot(run);
  // A prepared run must exist before Reference Sets can be created for the adopted plan's actual
  // visible cast. Required-reference errors therefore become blocking only after run approval,
  // when approveScriptMangaRun has frozen the approved sets into reference_snapshot_json.
  const enforceRequiredReferences = config.requireReferenceSets && run.approval_status === "approved";
  removeUnusedStarterPage(run.project_id);

  for (const pageSpec of plan.pages) {
    const { pageId, layout } = ensureRunPage(run, pageSpec);
    const layoutPanels = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
    if (layoutPanels.length !== pageSpec.panels.length) {
      throw new HttpError(422, `Layout ${pageSpec.layoutTemplateId} has ${layoutPanels.length} panels but plan requires ${pageSpec.panels.length}`);
    }
    const pageObjectRow = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
    const existingPageObjects = normalizePageObjects(pageObjectRow?.objects_json ? JSON.parse(pageObjectRow.objects_json) : []);
    const pageObjectsWithoutMangaEffects = existingPageObjects.filter((object) => !isMangaEffectObject(object));
    if (pageObjectsWithoutMangaEffects.length !== existingPageObjects.length) {
      runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
        JSON.stringify(pageObjectsWithoutMangaEffects), pageId
      ]);
    }
    ensureDialogueLettering(run, pageId, pageSpec, layoutPanels, dialogueSnapshots, plan.dialoguePolicy,
      new Map((plan.fillUnits ?? []).map((unit) => [unit.id, unit])));
    for (let index = 0; index < pageSpec.panels.length; index += 1) {
      const panel = pageSpec.panels[index]!;
      const layoutPanel = layoutPanels[index]!;
      // 役割の正は layout snapshot 側(provided plan が role を書き忘れても立ち絵仕様になる)。
      if (layoutPanel.role === "figure") panel.role = "figure";
      else delete panel.role;
      const castNormalization = normalizePanelCast(panel, dialogueById, sourceGroundedCharacterIds(panel, plan.narrativeGraph));
      panel.cast = castNormalization.cast;
      // ネームポーズレイヤ: cast 正規化で外れたキャラの骨格はタスクスナップショットから間引く
      // (plan_json 側のレイヤは保持される。validateMangaPlanV2 の cast-pose-reference warning と対)。
      if (panel.castPoses) {
        const castIdsForPoses = new Set(panel.cast.map((member) => member.characterId));
        panel.castPoses = panel.castPoses.filter((pose) => castIdsForPoses.has(pose.characterId));
        if (panel.castPoses.length === 0) delete panel.castPoses;
      }
      const excludedCharacterIds = new Set(castNormalization.excludedOffscreenIds);
      if (excludedCharacterIds.size > 0) {
        const excludedLabels = plan.narrativeGraph.entities
          .filter((entity) => excludedCharacterIds.has(entity.id))
          .flatMap((entity) => [entity.name, ...entity.aliases]);
        panel.mustShow = panel.mustShow.filter((constraint) =>
          !(constraint.entityId && excludedCharacterIds.has(constraint.entityId)) &&
          !textContainsCharacterLabel(constraint.description, excludedLabels)
        );
        panel.promptBase = stripClausesContainingCharacterLabels(panel.promptBase, excludedLabels) ||
          "Depict only the source-grounded setting, props, and planned visible cast in one coherent moment";
        panel.shot.compositionIntent = stripClausesContainingCharacterLabels(panel.shot.compositionIntent, excludedLabels) ||
          "single clear action with only the planned visible cast";
        if (panel.postStateDelta.characterStates) {
          panel.postStateDelta.characterStates = Object.fromEntries(
            Object.entries(panel.postStateDelta.characterStates)
              .filter(([characterId]) => !excludedCharacterIds.has(characterId))
          );
        }
        if (excludedCharacterIds.has(panel.shot.focalSubjectId)) {
          panel.shot.focalSubjectId = panel.cast[0]?.characterId ?? panel.settingId;
        }
      }
      for (const characterId of castNormalization.excludedOffscreenIds) {
        if (panel.mustNotShow.some((constraint) => constraint.kind === "entity-absent" && constraint.entityId === characterId)) continue;
        const entity = plan.narrativeGraph.entities.find((candidate) => candidate.id === characterId);
        const identity = entity?.attributes.tags?.trim() || entity?.name || characterId;
        panel.mustNotShow.push({
          kind: "entity-absent",
          entityId: characterId,
          description: panel.cast.length === 0
            ? `off-screen speaker ${identity}; people, human figures, faces, crowds, reflections, or silhouettes`
            : `off-screen speaker ${identity}; extra people, extra faces, crowds, background characters, reflections, or silhouettes beyond the planned visible cast`
        });
      }
      panel.textSafeZones = actualTextSafeZones(pageId, layout, layoutPanel.id);
      const references = resolvePanelReferences({
        projectId: run.project_id,
        providerId: config.providerId,
        cast: panel.cast,
        focalSubjectId: panel.shot.focalSubjectId,
        globalLoras: config.loras,
        modelFamily: modelFamily ?? "chroma",
        frozenSnapshot: referenceSnapshot
      });
      panel.referenceManifest = references.manifest;
      panel.compiledPrompt = compilePanelConditioning({
        panel,
        basePrompt: panel.promptBase,
        entities: plan.narrativeGraph.entities,
        dialogueById,
        narrativeMetadata: config.planningMode === "provided"
          ? "base-only"
          : plan.plannerProvenance?.kind === "llm-director"
            ? "english-directed"
            : "append",
        dialect: promptProfile.dialect,
        qualityTags: promptProfile.qualityTags,
        negativeBase: promptProfile.negativeBase,
        sceneBible: plan.narrativeGraph.sceneBibles?.find((bible) => bible.settingId === panel.settingId),
        referenceAppearances: references.appearances
      }).positive;
      const preflight = validatePanelPreflight({
        panel,
        layout,
        layoutPanelId: layoutPanel.id,
        dialogueTexts: panel.dialogueLineIds.map((lineId) => dialogueById.get(lineId)?.text ?? ""),
        requireReferences: enforceRequiredReferences && Boolean(modelFamily) && !config.allowReferenceFallback,
        missingReferenceIds: references.missingReferenceIds,
        castNormalized: true,
        visibleSpeakerIds: panel.dialogueLineIds.flatMap((lineId) => {
          const line = dialogueById.get(lineId);
          return line?.characterId && dialogueEstablishesVisibleSpeaker(line) ? [line.characterId] : [];
        }),
        offscreenSpeakerIds: castNormalization.excludedOffscreenIds
      });
      upsertPreparedTask({ runId: run.id, pageId, layoutPanelId: layoutPanel.id, panel, preflight });
    }
  }
  const validation = validatePlan(plan);
  runSql(
    `UPDATE script_manga_plans SET plan_json = ?, validation_json = ?, edit_version = edit_version + 1,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [JSON.stringify(plan), JSON.stringify(validation), plan.id]
  );
  if (!validation.ok) throw new HttpError(422, "Materialized MangaPlanV2 failed validation");
  const blocked = getRow<{ count: number }>(
    "SELECT COUNT(*) AS count FROM script_manga_tasks WHERE run_id = ? AND status = 'blocked'",
    [run.id]
  )?.count ?? 0;
  if (blocked > 0) throw new HttpError(422, `${blocked} panel task(s) failed deterministic preflight`);
  runSql(
    `UPDATE script_manga_runs SET status = CASE WHEN approval_status = 'approved' THEN 'approved' ELSE 'prepared' END,
       phase = CASE WHEN approval_status = 'approved' THEN 'preparing_references' ELSE 'awaiting_approval' END,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [run.id]
  );
}

interface WorkflowTemplateReuseRow {
  version: number;
  workflow_hash: string;
  workflow_json: string;
}

interface ScriptMangaReuseTemplateSnapshot {
  id: string;
  version: number;
  workflowHash: string;
}

interface ScriptMangaReuseRoundRow {
  id: string;
  parent_round_id: string | null;
  template_id: string;
  provider_id: string;
  status: string;
  request_json: string;
  intent_json: string | null;
  patched_workflow_json: string | null;
  script_manga_task_id: string | null;
}

interface ScriptMangaReuseAssetRow {
  id: string;
  project_id: string;
  round_id: string;
  workflow_template_id: string;
  workflow_template_version: number;
  workflow_snapshot_hash: string;
  image_path: string;
}

interface StoredTaskReuseSource {
  version: typeof SCRIPT_MANGA_REUSE_FINGERPRINT_VERSION;
  fingerprint: string;
  /** The root txt2img signature used to compare this reviewed result with a successor target. */
  matchFingerprint: string;
  /** SHA-256 of the reviewed image bytes; protects reuse from path-stable file replacement. */
  assetContentHash: string;
  assetWidth: number;
  assetHeight: number;
  roundId: string;
  providerId: string;
  template: ScriptMangaReuseTemplateSnapshot;
  requestHash: string;
  intentHash: string;
  workflowSnapshotHash: string;
  generationMode: "txt2img" | "repair-img2img";
  parentLineage?: {
    parentAssetId: string;
    parentFingerprint: string;
    /** Exact parent bytes used by the reviewed repair, not merely its generation recipe. */
    parentAssetContentHash: string;
    parentAssetWidth: number;
    parentAssetHeight: number;
    relationType: "img2img";
  };
  maskContentHash?: string;
}

interface TaskReusePlanContext {
  panel: PanelSpec;
  layout: PageLayout;
  layoutPanel: PageLayout["panels"][number];
  resolvedBeats: MangaPlanV2["narrativeGraph"]["beats"];
  resolvedPreState: MangaPlanV2["narrativeGraph"]["worldStates"][number] | null;
  resolvedContinuityPanels: PanelSpec[];
}

function taskReusePlanContext(
  run: RunRow,
  plan: MangaPlanV2,
  task: TaskRow,
  materializedPanels: ReadonlyMap<string, PanelSpec>
): TaskReusePlanContext | null {
  try {
    const panel = parseJson<PanelSpec | null>(task.panel_spec_json, null);
    if (!panel) return null;
    const pageIndex = getRow<{ page_index: number }>(
      "SELECT page_index FROM script_manga_run_pages WHERE run_id = ? AND page_id = ?",
      [run.id, task.page_id]
    )?.page_index;
    if (typeof pageIndex !== "number") return null;
    const pageSpec = plan.pages.find((page) => page.index === pageIndex);
    if (!pageSpec) return null;
    const layout = pageLayout(task.page_id);
    const layoutPanel = layout.panels.find((item) => item.id === task.panel_id);
    if (!layoutPanel) return null;
    const beatsById = new Map(plan.narrativeGraph.beats.map((beat) => [beat.id, beat]));
    const statesById = new Map(plan.narrativeGraph.worldStates.map((state) => [state.id, state]));
    const planPanelsById = new Map(plan.pages.flatMap((page) => page.panels).map((item) => [item.id, item]));
    return {
      panel,
      layout,
      layoutPanel,
      resolvedBeats: panel.beatIds.flatMap((id) => {
        const beat = beatsById.get(id);
        return beat ? [beat] : [];
      }),
      resolvedPreState: statesById.get(panel.preStateId) ?? null,
      resolvedContinuityPanels: panel.continuityFromPanelIds.flatMap((id) => {
        const prior = materializedPanels.get(id) ?? planPanelsById.get(id);
        return prior ? [prior] : [];
      })
    };
  } catch {
    return null;
  }
}

function computeTaskReuseFingerprint(
  run: RunRow,
  plan: MangaPlanV2,
  context: TaskReusePlanContext,
  panel: PanelSpec,
  generation: unknown
): string {
  return computeScriptMangaReuseFingerprint({
    scriptRevisionId: run.script_revision_id!,
    panel,
    resolvedBeats: context.resolvedBeats,
    resolvedPreState: context.resolvedPreState,
    resolvedContinuityPanels: context.resolvedContinuityPanels,
    layoutPanel: context.layoutPanel,
    generation: { promptCompilerVersion: plan.promptCompilerVersion, ...generation as Record<string, unknown> },
    referenceSnapshot: frozenReferenceSnapshot(run)
  });
}

function parsedJsonSnapshot(raw: string | null): { value: unknown; hash: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null) return null;
    return { value, hash: hashJson(value) };
  } catch {
    return null;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function frozenImageContentHash(dataUrl: unknown, rawPath: unknown): Promise<string | null> {
  if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
    const separator = dataUrl.indexOf(",");
    if (separator < 0) return null;
    try {
      return sha256(Buffer.from(dataUrl.slice(separator + 1), "base64"));
    } catch {
      return null;
    }
  }
  if (typeof rawPath === "string" && rawPath.trim()) {
    const path = resolve(rawPath);
    if (!isPathInside(path, resolve(dataRoot))) return null;
    try {
      return sha256(await readFile(path));
    } catch {
      return null;
    }
  }
  return null;
}

async function controlImageHash(control: GenerationRequest["controlnet"]): Promise<string | null> {
  if (!control) return null;
  return frozenImageContentHash(control.poseImageDataUrl, control.poseImagePath);
}

function canonicalReference(
  reference: GenerationRequest["reference"],
  snapshot: ScriptMangaReferenceSnapshot | null
): unknown | undefined {
  if (!reference) return null;
  const setId = reference.referenceSet?.setId?.trim();
  const version = reference.referenceSet?.version;
  // A mutable character binding has no immutable content checksum in the run snapshot.
  if (!setId || typeof version !== "number" || !snapshot?.sets.some((set) => set.setId === setId && set.version === version)) {
    return undefined;
  }
  return {
    referenceSet: { setId, version },
    strict: reference.strict === true,
    face: { enabled: reference.face?.enabled === true },
    animaInContext: reference.animaInContext
      ? {
          enabled: reference.animaInContext.enabled === true,
          strength: reference.animaInContext.strength ?? 1,
          startPercent: reference.animaInContext.startPercent ?? 0,
          endPercent: reference.animaInContext.endPercent ?? 1
        }
      : null
  };
}

async function canonicalGenerationMaterial(input: {
  providerId: string;
  template: ScriptMangaReuseTemplateSnapshot;
  request: GenerationRequest;
  referenceSnapshot: ScriptMangaReferenceSnapshot | null;
}): Promise<Record<string, unknown> | null> {
  const request = normalizeGenerationRequest(input.request);
  if (request.generationMode !== "txt2img" || request.parentAssetId || input.request.inpaint || input.request.pasteComposite) return null;
  const common = await canonicalGenerationRequestMaterial(input.request, input.referenceSnapshot);
  if (!common) return null;
  return {
    providerId: input.providerId,
    template: input.template,
    request: common
  };
}

async function canonicalGenerationRequestMaterial(
  rawRequest: GenerationRequest,
  referenceSnapshot: ScriptMangaReferenceSnapshot | null
): Promise<Record<string, unknown> | null> {
  const request = normalizeGenerationRequest(rawRequest);
  const reference = canonicalReference(rawRequest.reference, referenceSnapshot);
  if (reference === undefined) return null;
  const controlHash = await controlImageHash(rawRequest.controlnet);
  if (rawRequest.controlnet && !controlHash) return null;
  return {
    templateId: request.templateId,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    batchSize: request.batchSize,
    steps: request.steps,
    cfg: request.cfg,
    sampler: request.sampler,
    scheduler: request.scheduler,
    denoise: request.denoise,
    width: request.width,
    height: request.height,
    generationMode: request.generationMode,
    loras: request.loras ?? [],
    reference,
    controlnet: rawRequest.controlnet
      ? {
          contentHash: controlHash,
          strength: rawRequest.controlnet.strength,
          startPercent: rawRequest.controlnet.startPercent,
          endPercent: rawRequest.controlnet.endPercent
        }
      : null
  };
}

async function canonicalRepairGenerationMaterial(input: {
  providerId: string;
  template: ScriptMangaReuseTemplateSnapshot;
  request: GenerationRequest;
  referenceSnapshot: ScriptMangaReferenceSnapshot | null;
  parentLineage: NonNullable<StoredTaskReuseSource["parentLineage"]>;
  frozenRound: Pick<StoredTaskReuseSource, "requestHash" | "intentHash" | "workflowSnapshotHash">;
}): Promise<{ generation: Record<string, unknown>; maskContentHash: string } | null> {
  const request = normalizeGenerationRequest(input.request);
  const inpaint = input.request.inpaint;
  if (
    request.generationMode !== "img2img" ||
    request.parentAssetId !== input.parentLineage.parentAssetId ||
    request.relationType !== "img2img" ||
    !inpaint ||
    input.request.pasteComposite
  ) return null;
  const common = await canonicalGenerationRequestMaterial(input.request, input.referenceSnapshot);
  const maskContentHash = await frozenImageContentHash(inpaint.maskDataUrl, inpaint.maskPath);
  if (!common || !maskContentHash) return null;
  return {
    maskContentHash,
    generation: {
      providerId: input.providerId,
      template: input.template,
      request: {
        ...common,
        parentAssetId: request.parentAssetId,
        relationType: request.relationType,
        inpaint: {
          contentHash: maskContentHash,
          maskWidth: inpaint.maskWidth ?? null,
          maskHeight: inpaint.maskHeight ?? null,
          maskedContent: inpaint.maskedContent,
          inpaintArea: inpaint.inpaintArea,
          onlyMaskedPadding: inpaint.onlyMaskedPadding,
          featherRadius: inpaint.featherRadius ?? 0
        }
      },
      parentLineage: input.parentLineage,
      frozenRound: input.frozenRound
    }
  };
}

function reuseTemplateSnapshot(templateId: string): (ScriptMangaReuseTemplateSnapshot & { workflowJson: string }) | null {
  const template = getRow<WorkflowTemplateReuseRow>(
    "SELECT version, workflow_hash, workflow_json FROM workflow_templates WHERE id = ? AND deleted_at IS NULL",
    [templateId]
  );
  return template
    ? { id: templateId, version: template.version, workflowHash: template.workflow_hash, workflowJson: template.workflow_json }
    : null;
}

async function taskReuseFingerprintForTarget(
  run: RunRow,
  plan: MangaPlanV2,
  config: ScriptMangaRunConfig,
  task: TaskRow,
  materializedPanels: ReadonlyMap<string, PanelSpec>
): Promise<string | null> {
  try {
    const context = taskReusePlanContext(run, plan, task, materializedPanels);
    const template = reuseTemplateSnapshot(config.templateId);
    if (!context || !template) return null;
    const promptProfile = templatePromptProfile(config.templateId);
    const modelFamily = referenceModelFamily(config.templateId);
    const references = resolvePanelReferences({
      projectId: run.project_id,
      providerId: config.providerId,
      cast: context.panel.cast,
      focalSubjectId: context.panel.shot.focalSubjectId,
      globalLoras: config.loras,
      modelFamily: modelFamily ?? "chroma",
      frozenSnapshot: frozenReferenceSnapshot(run)
    });
    const conditioning = compilePanelConditioning({
      panel: context.panel,
      basePrompt: context.panel.promptBase,
      entities: plan.narrativeGraph.entities,
      dialogueById: new Map(),
      narrativeMetadata: "english-directed",
      dialect: promptProfile.dialect,
      qualityTags: promptProfile.qualityTags,
      negativeBase: promptProfile.negativeBase,
      sceneBible: plan.narrativeGraph.sceneBibles?.find((bible) => bible.settingId === context.panel.settingId),
      referenceAppearances: references.appearances
    });
    const size = panelGenerationSize(context.layout, task.panel_id, config.longEdge, modelFamily ? "chroma" : "sdxl");
    const request: GenerationRequest = {
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
          : null
    };
    if (config.poseControl?.enabled && template.workflowJson.includes("ControlNetApplyAdvanced")) {
      try {
        const attachment = await buildPoseControlAttachment(context.panel, size.width, size.height, config.poseControl);
        if (attachment) {
          request.controlnet = {
            poseImageDataUrl: attachment.poseImageDataUrl,
            strength: attachment.strength,
            startPercent: attachment.startPercent,
            endPercent: attachment.endPercent
          };
        }
      } catch {
        // Generation also falls back to no ControlNet when pose construction fails.
      }
    }
    const generation = await canonicalGenerationMaterial({
      providerId: config.providerId,
      template: { id: template.id, version: template.version, workflowHash: template.workflowHash },
      request,
      referenceSnapshot: frozenReferenceSnapshot(run)
    });
    if (!generation) return null;
    const normalizedPanel: PanelSpec = {
      ...context.panel,
      referenceManifest: references.manifest,
      compiledPrompt: conditioning.positive
    };
    return computeTaskReuseFingerprint(run, plan, context, normalizedPanel, generation);
  } catch {
    return null;
  }
}

function parseStoredReuseSource(task: TaskRow): StoredTaskReuseSource | null {
  const source = parseJson<StoredTaskReuseSource | null>(task.reuse_source_json, null);
  if (
    !source ||
    source.version !== SCRIPT_MANGA_REUSE_FINGERPRINT_VERSION ||
    !source.fingerprint ||
    !source.matchFingerprint ||
    !source.assetContentHash ||
    !Number.isFinite(source.assetWidth) || source.assetWidth <= 0 ||
    !Number.isFinite(source.assetHeight) || source.assetHeight <= 0 ||
    !source.roundId ||
    !source.providerId ||
    (source.generationMode !== "txt2img" && source.generationMode !== "repair-img2img")
  ) return null;
  if (
    source.generationMode === "repair-img2img" &&
    (
      !source.parentLineage?.parentAssetId ||
      !source.parentLineage.parentFingerprint ||
      !source.parentLineage.parentAssetContentHash ||
      !Number.isFinite(source.parentLineage.parentAssetWidth) || source.parentLineage.parentAssetWidth <= 0 ||
      !Number.isFinite(source.parentLineage.parentAssetHeight) || source.parentLineage.parentAssetHeight <= 0 ||
      source.parentLineage.relationType !== "img2img"
    )
  ) return null;
  return source;
}

function taskReuseLineageIncludes(task: TaskRow, sourceTaskId: string | null): boolean {
  if (!sourceTaskId) return false;
  let current: TaskRow | null = getRow<TaskRow>("SELECT * FROM script_manga_tasks WHERE id = ?", [task.id]) ?? task;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === sourceTaskId) return true;
    visited.add(current.id);
    if (current.status !== "completed" || !current.selected_asset_id || !current.inherited_from_task_id) return false;
    const parentTask: TaskRow | null = getRow<TaskRow>(
      "SELECT * FROM script_manga_tasks WHERE id = ?",
      [current.inherited_from_task_id]
    );
    if (
      !parentTask ||
      parentTask.status !== "completed" ||
      parentTask.selected_asset_id !== current.selected_asset_id
    ) return false;
    const [currentRun, parentRun] = [
      getRow<RunRow>("SELECT * FROM script_manga_runs WHERE id = ?", [current.run_id]),
      getRow<RunRow>("SELECT * FROM script_manga_runs WHERE id = ?", [parentTask.run_id])
    ];
    if (
      !currentRun ||
      !parentRun ||
      currentRun.predecessor_run_id !== parentRun.id ||
      currentRun.project_id !== parentRun.project_id ||
      currentRun.script_id !== parentRun.script_id ||
      currentRun.script_revision_id !== parentRun.script_revision_id
    ) return false;
    current = parentTask;
  }
  return false;
}

async function reusableAssetImageSnapshot(
  projectId: string,
  rawPath: string
): Promise<{ contentHash: string; width: number; height: number } | null> {
  try {
    const project = getRow<{ storage_dir: string }>("SELECT storage_dir FROM projects WHERE id = ?", [projectId]);
    if (!project?.storage_dir) return null;
    const [imagePath, projectRoot] = await Promise.all([
      realpath(resolve(rawPath)),
      realpath(resolve(project.storage_dir))
    ]);
    if (!isPathInside(imagePath, projectRoot)) return null;
    const handle = await open(imagePath, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size <= 0) return null;
    } finally {
      await handle.close();
    }
    // metadata() performs an actual image decode/header validation. Hash the exact reviewed bytes
    // afterwards so a different, still-valid image at the same path cannot inherit approval.
    const metadata = await sharp(imagePath).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) return null;
    const bytes = await readFile(imagePath);
    return { contentHash: createHash("sha256").update(bytes).digest("hex"), width, height };
  } catch {
    return null;
  }
}

async function taskReuseSourceFromAsset(
  run: RunRow,
  plan: MangaPlanV2,
  task: TaskRow,
  assetId: string,
  materializedPanels: ReadonlyMap<string, PanelSpec>,
  visitedAssetIds = new Set<string>()
): Promise<StoredTaskReuseSource | null> {
  try {
    if (visitedAssetIds.has(assetId)) return null;
    const nextVisited = new Set(visitedAssetIds).add(assetId);
    const asset = getRow<ScriptMangaReuseAssetRow>(
      `SELECT id, project_id, round_id, workflow_template_id, workflow_template_version, workflow_snapshot_hash, image_path
       FROM assets WHERE id = ? AND project_id = ?`,
      [assetId, run.project_id]
    );
    if (!asset) return null;
    const assetSnapshot = await reusableAssetImageSnapshot(run.project_id, asset.image_path);
    if (!assetSnapshot) return null;
    const round = getRow<ScriptMangaReuseRoundRow>(
      `SELECT id, parent_round_id, template_id, provider_id, status, request_json, intent_json, patched_workflow_json,
              script_manga_task_id
       FROM generation_rounds WHERE id = ? AND project_id = ?`,
      [asset.round_id, run.project_id]
    );
    if (
      !round ||
      round.status !== "completed" ||
      round.template_id !== asset.workflow_template_id ||
      !taskReuseLineageIncludes(task, round.script_manga_task_id)
    ) return null;
    const requestSnapshot = parsedJsonSnapshot(round.request_json);
    const intentSnapshot = parsedJsonSnapshot(round.intent_json);
    const workflowSnapshot = parsedJsonSnapshot(round.patched_workflow_json);
    if (!requestSnapshot || !intentSnapshot || !workflowSnapshot) return null;
    const intent = intentSnapshot.value as { recipe?: { providerId?: unknown; recipeId?: unknown; revision?: unknown } };
    if (
      intent.recipe?.providerId !== round.provider_id ||
      intent.recipe?.recipeId !== asset.workflow_template_id ||
      String(intent.recipe?.revision ?? "") !== String(asset.workflow_template_version)
    ) return null;
    const context = taskReusePlanContext(run, plan, task, materializedPanels);
    if (!context) return null;
    const template = {
      id: asset.workflow_template_id,
      version: asset.workflow_template_version,
      workflowHash: asset.workflow_snapshot_hash
    };
    const request = requestSnapshot.value as GenerationRequest;
    const normalizedPanel: PanelSpec = {
      ...context.panel,
      compiledPrompt: request.prompt
    };
    const frozenRound = {
      requestHash: requestSnapshot.hash,
      intentHash: intentSnapshot.hash,
      workflowSnapshotHash: workflowSnapshot.hash
    };
    const normalizedRequest = normalizeGenerationRequest(request);
    if (normalizedRequest.generationMode === "txt2img") {
      if (round.parent_round_id !== null) return null;
      const generation = await canonicalGenerationMaterial({
        providerId: round.provider_id,
        template,
        request,
        referenceSnapshot: frozenReferenceSnapshot(run)
      });
      if (!generation) return null;
      const fingerprint = computeTaskReuseFingerprint(run, plan, context, normalizedPanel, generation);
      return {
        version: SCRIPT_MANGA_REUSE_FINGERPRINT_VERSION,
        fingerprint,
        matchFingerprint: fingerprint,
        assetContentHash: assetSnapshot.contentHash,
        assetWidth: assetSnapshot.width,
        assetHeight: assetSnapshot.height,
        roundId: asset.round_id,
        providerId: round.provider_id,
        template,
        ...frozenRound,
        generationMode: "txt2img"
      };
    }
    if (normalizedRequest.generationMode !== "img2img" || !normalizedRequest.parentAssetId) return null;
    const parentLinks = getRows<{ parent_asset_id: string; relation_type: string }>(
      "SELECT parent_asset_id, relation_type FROM asset_parents WHERE child_asset_id = ?",
      [asset.id]
    );
    if (
      parentLinks.length !== 1 ||
      parentLinks[0]!.parent_asset_id !== normalizedRequest.parentAssetId ||
      parentLinks[0]!.relation_type !== "img2img"
    ) return null;
    const parentSource = await taskReuseSourceFromAsset(
      run,
      plan,
      task,
      normalizedRequest.parentAssetId,
      materializedPanels,
      nextVisited
    );
    if (!parentSource) return null;
    if (round.parent_round_id !== parentSource.roundId) return null;
    if (
      round.provider_id !== parentSource.providerId ||
      hashJson(template) !== hashJson(parentSource.template)
    ) return null;
    const parentRound = getRow<Pick<ScriptMangaReuseRoundRow, "request_json">>(
      "SELECT request_json FROM generation_rounds WHERE id = ? AND project_id = ?",
      [parentSource.roundId, run.project_id]
    );
    const parentRequestSnapshot = parsedJsonSnapshot(parentRound?.request_json ?? null);
    const [parentCommon, childCommon] = await Promise.all([
      parentRequestSnapshot
        ? canonicalGenerationRequestMaterial(
            parentRequestSnapshot.value as GenerationRequest,
            frozenReferenceSnapshot(run)
          )
        : null,
      canonicalGenerationRequestMaterial(request, frozenReferenceSnapshot(run))
    ]);
    if (!parentCommon || !childCommon) return null;
    const {
      generationMode: _parentMode,
      denoise: _parentDenoise,
      width: _parentRequestWidth,
      height: _parentRequestHeight,
      ...parentFrozenCommon
    } = parentCommon;
    const {
      generationMode: _childMode,
      denoise: _childDenoise,
      width: childWidth,
      height: childHeight,
      ...childFrozenCommon
    } = childCommon;
    if (
      childWidth !== parentSource.assetWidth ||
      childHeight !== parentSource.assetHeight ||
      hashJson(parentFrozenCommon) !== hashJson(childFrozenCommon)
    ) return null;
    const parentLineage: NonNullable<StoredTaskReuseSource["parentLineage"]> = {
      parentAssetId: normalizedRequest.parentAssetId,
      parentFingerprint: parentSource.fingerprint,
      parentAssetContentHash: parentSource.assetContentHash,
      parentAssetWidth: parentSource.assetWidth,
      parentAssetHeight: parentSource.assetHeight,
      relationType: "img2img"
    };
    const repair = await canonicalRepairGenerationMaterial({
      providerId: round.provider_id,
      template,
      request,
      referenceSnapshot: frozenReferenceSnapshot(run),
      parentLineage,
      frozenRound
    });
    if (!repair) return null;
    const fingerprint = computeTaskReuseFingerprint(run, plan, context, normalizedPanel, repair.generation);
    return {
      version: SCRIPT_MANGA_REUSE_FINGERPRINT_VERSION,
      fingerprint,
      matchFingerprint: parentSource.matchFingerprint,
      assetContentHash: assetSnapshot.contentHash,
      assetWidth: assetSnapshot.width,
      assetHeight: assetSnapshot.height,
      roundId: asset.round_id,
      providerId: round.provider_id,
      template,
      ...frozenRound,
      generationMode: "repair-img2img",
      parentLineage,
      maskContentHash: repair.maskContentHash
    };
  } catch {
    return null;
  }
}

async function verifiedStoredTaskReuseFingerprint(
  run: RunRow,
  plan: MangaPlanV2,
  task: TaskRow,
  materializedPanels: ReadonlyMap<string, PanelSpec>
): Promise<string | null> {
  const assetId = task.selected_asset_id;
  if (!assetId) return null;
  const stored = parseStoredReuseSource(task);
  // Older reviewed tasks predate reuse_source_json. Reconstruct and persist only from the
  // immutable asset/round snapshots; never consult the current mutable workflow template.
  if (!stored) {
    if (task.reuse_source_json?.trim()) return null;
    const reconstructed = await taskReuseSourceFromAsset(run, plan, task, assetId, materializedPanels);
    if (!reconstructed) return null;
    const raw = JSON.stringify(reconstructed);
    const updated = runSql(
      `UPDATE script_manga_tasks SET reuse_fingerprint = ?, reuse_source_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'completed' AND selected_asset_id = ?`,
      [reconstructed.fingerprint, raw, task.id, assetId]
    ) as { changes?: number };
    if (updated.changes !== 1) return null;
    task.reuse_fingerprint = reconstructed.fingerprint;
    task.reuse_source_json = raw;
    return reconstructed.matchFingerprint;
  }
  if (stored.fingerprint !== task.reuse_fingerprint) return null;
  const reconstructed = await taskReuseSourceFromAsset(run, plan, task, assetId, materializedPanels);
  if (!reconstructed) return null;
  if (hashJson(reconstructed) !== hashJson(stored)) return null;
  return stored.matchFingerprint;
}

async function inheritSelectedTasks(runId: string): Promise<void> {
  const run = requireRun(runId);
  if (!run.predecessor_run_id || !run.plan_id) return;
  const predecessor = requireRun(run.predecessor_run_id);
  if (!predecessor.plan_id || predecessor.script_revision_id !== run.script_revision_id) return;
  const plan = planFromRow(requirePlan(run.plan_id));
  const predecessorPlan = planFromRow(requirePlan(predecessor.plan_id));
  const config = parseConfig(run);
  const predecessorTasks = getRows<TaskRow>(
    `SELECT * FROM script_manga_tasks
     WHERE run_id = ? AND status = 'completed' AND selected_asset_id IS NOT NULL ORDER BY created_at ASC, id ASC`,
    [predecessor.id]
  ).filter((task) => Boolean(getRow("SELECT id FROM assets WHERE id = ?", [task.selected_asset_id])));
  const successorTasks = getRows<TaskRow>(
    "SELECT * FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at ASC, id ASC",
    [run.id]
  );
  const predecessorPanels = new Map(getRows<TaskRow>(
    "SELECT * FROM script_manga_tasks WHERE run_id = ?",
    [predecessor.id]
  ).flatMap((task) => {
    const panel = parseJson<PanelSpec | null>(task.panel_spec_json, null);
    return panel ? [[panel.id, panel] as const] : [];
  }));
  const successorPanels = new Map(getRows<TaskRow>(
    "SELECT * FROM script_manga_tasks WHERE run_id = ?",
    [run.id]
  ).flatMap((task) => {
    const panel = parseJson<PanelSpec | null>(task.panel_spec_json, null);
    return panel ? [[panel.id, panel] as const] : [];
  }));

  const predecessorCandidates = (await Promise.all(predecessorTasks.map(async (task) => ({
    fingerprint: await verifiedStoredTaskReuseFingerprint(predecessor, predecessorPlan, task, predecessorPanels),
    value: task
  })))).filter((candidate) => Boolean(candidate.fingerprint));
  const successorCandidates = await Promise.all(successorTasks.map(async (task) => {
    if (task.status !== "pending") return { fingerprint: task.reuse_fingerprint, value: task };
    const fingerprint = await taskReuseFingerprintForTarget(run, plan, config, task, successorPanels);
    const recorded = runSql(
      `UPDATE script_manga_tasks SET reuse_fingerprint = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending'`,
      [fingerprint, task.id]
    ) as { changes?: number };
    if (recorded.changes === 1) {
      task.reuse_fingerprint = fingerprint;
      return { fingerprint, value: task };
    }
    // Another overlapping start/resume may already have inherited (and possibly completed) this
    // task. Re-read instead of overwriting the selected repair's material fingerprint.
    const latest = requireTask(task.id);
    return { fingerprint: latest.reuse_fingerprint, value: latest };
  }));
  // Reserve exact sources already claimed by this successor before matching duplicate
  // fingerprints. Repair assets store a material fingerprint different from their root match
  // fingerprint, so matching every non-pending task by reuse_fingerprint can otherwise consume
  // the same predecessor again after a restart.
  const predecessorIndexByTaskId = new Map(predecessorCandidates.map((candidate, index) => [candidate.value.id, index] as const));
  const matches = matchScriptMangaReuseCandidatesWithReservations(predecessorCandidates, successorCandidates.map((candidate) => {
    const target = candidate.value;
    if ((target.status !== "completed" && target.status !== "inheriting") || !target.inherited_from_task_id) return candidate;
    const predecessorIndex = predecessorIndexByTaskId.get(target.inherited_from_task_id);
    if (predecessorIndex === undefined) return candidate;
    const source = predecessorCandidates[predecessorIndex];
    if (!source || (target.status === "completed" && target.selected_asset_id !== source.value.selected_asset_id)) return candidate;
    return { ...candidate, reservedPredecessorIndex: predecessorIndex };
  }));
  const sourcePanelByTaskId = new Map(predecessorTasks.flatMap((task) => {
    const panel = parseJson<PanelSpec | null>(task.panel_spec_json, null);
    return panel ? [[task.id, panel] as const] : [];
  }));
  const targetPanelByTaskId = new Map(successorTasks.flatMap((task) => {
    const panel = parseJson<PanelSpec | null>(task.panel_spec_json, null);
    return panel ? [[task.id, panel] as const] : [];
  }));
  const matchBySourcePanelId = new Map(matches.flatMap((match) => {
    const panel = sourcePanelByTaskId.get(match.predecessor.id);
    return panel ? [[panel.id, match] as const] : [];
  }));
  const matchByTargetPanelId = new Map(matches.flatMap((match) => {
    const panel = targetPanelByTaskId.get(match.successor.id);
    return panel ? [[panel.id, match] as const] : [];
  }));
  // Panels whose predecessor task holds a reviewed selection, even when that selection is no
  // longer reusable (missing/corrupt asset, unverifiable material). A dependent approved next to
  // such a selection stays coupled to it; a dependent approved while its upstream was never
  // selected was reviewed without a settled neighbor, so regenerating that upstream leaves the
  // reviewer in the same position and must not discard the dependent's approval.
  const selectedPredecessorPanelIds = new Set(getRows<Pick<TaskRow, "panel_spec_json">>(
    `SELECT panel_spec_json FROM script_manga_tasks
     WHERE run_id = ? AND status = 'completed' AND selected_asset_id IS NOT NULL`,
    [predecessor.id]
  ).flatMap((task) => {
    const panel = parseJson<PanelSpec | null>(task.panel_spec_json, null);
    return panel ? [panel.id] : [];
  }));
  const dependencyMatches = (match: typeof matches[number]): Array<typeof matches[number]> | null => {
    const sourcePanel = sourcePanelByTaskId.get(match.predecessor.id);
    const targetPanel = targetPanelByTaskId.get(match.successor.id);
    if (!sourcePanel || !targetPanel || sourcePanel.continuityFromPanelIds.length !== targetPanel.continuityFromPanelIds.length) return null;
    const dependencies: Array<typeof matches[number]> = [];
    for (let index = 0; index < sourcePanel.continuityFromPanelIds.length; index += 1) {
      const sourceDependency = matchBySourcePanelId.get(sourcePanel.continuityFromPanelIds[index]!);
      const targetDependency = matchByTargetPanelId.get(targetPanel.continuityFromPanelIds[index]!);
      if (!selectedPredecessorPanelIds.has(sourcePanel.continuityFromPanelIds[index]!)) {
        // The upstream will regenerate from semantics this panel's own fingerprint already
        // verified (resolvedContinuityPanels). Fail closed if the successor side somehow paired
        // that upstream with a different predecessor selection.
        if (targetDependency) return null;
        continue;
      }
      if (!sourceDependency || sourceDependency !== targetDependency) return null;
      dependencies.push(sourceDependency);
    }
    return dependencies;
  };
  // A dependent panel is reusable only when the exact predecessor→successor dependency mapping is
  // reusable too. Iteration propagates a missing root through the whole continuity chain.
  const continuityEligible = new Set(matches);
  let closureChanged = true;
  while (closureChanged) {
    closureChanged = false;
    for (const match of [...continuityEligible]) {
      const dependencies = dependencyMatches(match);
      if (!dependencies || dependencies.some((dependency) => !continuityEligible.has(dependency))) {
        continuityEligible.delete(match);
        closureChanged = true;
      }
    }
  }
  let assignmentFailures = 0;
  let continuitySkipped = matches.length - continuityEligible.size;
  const remaining = new Set([...continuityEligible].filter((match) => match.successor.status === "pending"));
  let madeProgress = true;
  while (remaining.size > 0 && madeProgress) {
    madeProgress = false;
    for (const match of [...remaining]) {
      const dependencies = dependencyMatches(match) ?? [];
      if (dependencies.some((dependency) => remaining.has(dependency))) continue;
      const dependencySatisfied = dependencies.every((dependency) => {
        const source = dependency.predecessor;
        const target = requireTask(dependency.successor.id);
        return target.status === "completed" &&
          target.inherited_from_task_id === source.id &&
          target.selected_asset_id === source.selected_asset_id;
      });
      remaining.delete(match);
      madeProgress = true;
      if (!dependencySatisfied) {
        continuitySkipped += 1;
        continue;
      }
      const source = match.predecessor;
      const target = requireTask(match.successor.id);
      const assetId = source.selected_asset_id;
      if (!assetId || target.status !== "pending") continue;
      // Claim the task before mutating the page. start/resume can overlap, and figure
      // materialization has asynchronous work before it writes page media/objects.
      const claimed = runSql(
        `UPDATE script_manga_tasks SET status = 'inheriting', inherited_from_task_id = ?, last_error_json = NULL,
         updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`,
        [source.id, target.id]
      ) as { changes?: number };
      if (claimed.changes !== 1) continue;
      activeTaskInheritances.add(target.id);
      try {
        const layout = pageLayout(target.page_id);
        const layoutPanel = layout.panels.find((panel) => panel.id === target.panel_id);
        if (layoutPanel?.role === "figure") {
          const figureResult = await materializeFigureForTask(target, assetId, {
            canCommit: () => {
              const latestRun = requireRun(run.id);
              const latestTask = requireTask(target.id);
              return latestRun.status !== "canceled" && latestTask.status === "inheriting";
            }
          });
          if (!figureResult.committed) {
            throw new Error("Successor figure materialization failed");
          }
        } else {
          const page = toApiRow(getRow("SELECT * FROM pages WHERE id = ?", [target.page_id])) as unknown as PageRow | null;
          if (!page?.layout) throw new Error("Successor page layout is unavailable");
          upsertPanelAssignment(page, target.panel_id, { assetId });
        }
        const scores = parseJson<Record<string, unknown>>(target.scores_json, {});
        const completed = runSql(
          `UPDATE script_manga_tasks SET status = 'completed', asset_id = ?, selected_asset_id = ?,
           candidate_asset_ids_json = ?, inherited_from_task_id = ?, reuse_fingerprint = ?, reuse_source_json = ?, scores_json = ?,
           round_id = NULL, last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'inheriting'`,
          [
            assetId,
            assetId,
            JSON.stringify([assetId]),
            source.id,
            source.reuse_fingerprint,
            source.reuse_source_json,
            JSON.stringify({
              ...scores,
              inheritance: {
                predecessorRunId: predecessor.id,
                predecessorTaskId: source.id,
                fingerprintVersion: SCRIPT_MANGA_REUSE_FINGERPRINT_VERSION
              }
            }),
            target.id
          ]
        ) as { changes?: number };
        if (completed.changes !== 1) throw new Error("Successor inheritance claim was lost");
      } catch (error) {
        assignmentFailures += 1;
        runSql(
          `UPDATE script_manga_tasks SET status = 'pending', inherited_from_task_id = NULL,
           last_error_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'inheriting'`,
          [errorJson(error), target.id]
        );
      } finally {
        activeTaskInheritances.delete(target.id);
      }
    }
  }
  // Cyclic or otherwise unsatisfied dependencies fail closed and remain pending for generation.
  continuitySkipped += remaining.size;
  const taskCount = getRow<{ count: number }>(
    "SELECT COUNT(*) AS count FROM script_manga_tasks WHERE run_id = ?",
    [run.id]
  )?.count ?? 0;
  const inherited = getRow<{ count: number }>(
    "SELECT COUNT(*) AS count FROM script_manga_tasks WHERE run_id = ? AND inherited_from_task_id IS NOT NULL",
    [run.id]
  )?.count ?? 0;
  const evaluation = parseJson<Record<string, unknown>>(requireRun(run.id).evaluation_json, {});
  runSql("UPDATE script_manga_runs SET evaluation_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify({
      ...evaluation,
      inheritance: {
        predecessorRunId: predecessor.id,
        fingerprintVersion: SCRIPT_MANGA_REUSE_FINGERPRINT_VERSION,
        eligiblePredecessorTasks: predecessorCandidates.length,
        checkedSuccessorTasks: taskCount,
        inherited,
        skipped: Math.max(0, taskCount - inherited),
        continuitySkipped,
        assignmentFailures,
        checkedAt: new Date().toISOString()
      }
    }),
    run.id
  ]);
}

async function submitTasks(runId: string, taskIds?: string[]): Promise<void> {
  const run = requireRun(runId);
  const config = parseConfig(run);
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
    const promptProfile = templatePromptProfile(config.templateId);
    const detectedFamily = referenceModelFamily(config.templateId);
    const size = panelGenerationSize(layout, task.panel_id, config.longEdge, detectedFamily ? "chroma" : "sdxl");
    const references = resolvePanelReferences({
      projectId: run.project_id,
      providerId: config.providerId,
      cast: panel.cast,
      focalSubjectId: panel.shot.focalSubjectId,
      globalLoras: config.loras,
      modelFamily: detectedFamily ?? "chroma",
      frozenSnapshot: frozenReferenceSnapshot(run)
    });
    panel.referenceManifest = references.manifest;
    const frozenPlan = planFromRow(requirePlan(run.plan_id!));
    const conditioning = compilePanelConditioning({ panel, basePrompt: panel.promptBase, entities: frozenPlan.narrativeGraph.entities,
      dialogueById: new Map(), narrativeMetadata: "english-directed", dialect: promptProfile.dialect,
      qualityTags: promptProfile.qualityTags, negativeBase: promptProfile.negativeBase,
      sceneBible: frozenPlan.narrativeGraph.sceneBibles?.find((bible) => bible.settingId === panel.settingId),
      referenceAppearances: references.appearances });
    panel.compiledPrompt = conditioning.positive;
    const request: GenerationRequest & { providerId?: string } = {
      templateId: config.templateId,
      prompt: panel.compiledPrompt,
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
            face: { enabled: detectedFamily === "chroma" },
            animaInContext: { enabled: detectedFamily === "anima" },
            strict: true
          }
        : references.primaryCharacterBinding
        ? {
            characterBinding: references.primaryCharacterBinding,
            face: { enabled: true },
            animaInContext: { enabled: true }
          }
        : null,
      providerId: config.providerId
    };
    // ネームv4 D4: 棒人間骨格の ControlNet 条件付け(既定OFF)。テンプレに
    // ControlNetApplyAdvanced が無い場合は黙ってスキップ(prune済み経路と整合)。
    if (config.poseControl?.enabled && promptProfile.workflowJson.includes("ControlNetApplyAdvanced")) {
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
        // 骨格添付は補助条件。失敗してもコマ生成自体は止めない。
      }
    }
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
function recoverSubmittingTasks(runId: string): void {
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
function recoverInheritingTasks(runId: string): void {
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
function recoverSelectingTasks(runId: string): void {
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

interface CandidateScore {
  assetId: string;
  batchIndex: number;
  score: number;
  passedMetadataGate: boolean;
  checks: {
    dimensionsPresent: boolean;
    aspectRatioDelta: number | null;
    visualIdentity: "not-evaluated";
    actionAlignment: "not-evaluated";
    fakeText: "not-evaluated";
    continuity: "not-evaluated";
  };
  violations: string[];
}

function candidateScores(task: TaskRow): CandidateScore[] {
  if (!task.round_id) return [];
  const round = getRow<{ request_json: string }>("SELECT request_json FROM generation_rounds WHERE id = ?", [task.round_id]);
  const request = parseJson<{ width?: number; height?: number }>(round?.request_json, {});
  const expectedRatio = request.width && request.height ? request.width / request.height : null;
  return getRows<{ id: string; batch_index: number; width: number | null; height: number | null }>(
    "SELECT id, batch_index, width, height FROM assets WHERE round_id = ? ORDER BY batch_index ASC",
    [task.round_id]
  ).map((asset) => {
    const dimensionsPresent = Boolean(asset.width && asset.height && asset.width > 0 && asset.height > 0);
    const aspectRatioDelta = dimensionsPresent && expectedRatio ? Math.abs(asset.width! / asset.height! - expectedRatio) / expectedRatio : null;
    const passedMetadataGate = dimensionsPresent && (aspectRatioDelta === null || aspectRatioDelta <= 0.08);
    const violations = [
      ...(dimensionsPresent ? [] : ["missing-dimensions"]),
      ...(aspectRatioDelta !== null && aspectRatioDelta > 0.08 ? ["aspect-ratio-mismatch"] : [])
    ];
    return {
      assetId: asset.id,
      batchIndex: asset.batch_index,
      score: passedMetadataGate ? Math.max(0, 1 - (aspectRatioDelta ?? 0)) : 0,
      passedMetadataGate,
      checks: {
        dimensionsPresent,
        aspectRatioDelta,
        visualIdentity: "not-evaluated",
        actionAlignment: "not-evaluated",
        fakeText: "not-evaluated",
        continuity: "not-evaluated"
      },
      violations
    };
  });
}

function selectTaskCandidateInternal(task: TaskRow, assetId: string, options: { skipPanelAssignment?: boolean } = {}): void {
  const candidate = getRow<{ id: string }>(
    `SELECT a.id FROM assets a
     JOIN generation_rounds r ON r.id = a.round_id
     WHERE a.id = ? AND r.script_manga_task_id = ?`,
    [assetId, task.id]
  );
  if (!candidate) throw new HttpError(400, "Asset is not a candidate for this task");
  runSql("SAVEPOINT script_manga_candidate_select");
  try {
    const completed = runSql(
      `UPDATE script_manga_tasks SET status = 'completed', asset_id = ?, selected_asset_id = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'selecting'
         AND EXISTS (
           SELECT 1 FROM script_manga_runs r
           WHERE r.id = script_manga_tasks.run_id AND r.approval_status = 'approved' AND r.status <> 'canceled'
         )`,
      [assetId, assetId, task.id]
    ) as { changes?: number };
    if (completed.changes !== 1) throw new HttpError(409, "Task stopped accepting the candidate selection");
    updateAssetStatus(
      assetId,
      { status: "selected", note: `script manga run ${task.run_id}; reviewed candidate` },
      { skipAutoAssign: options.skipPanelAssignment === true }
    );
    runSql("RELEASE script_manga_candidate_select");
  } catch (error) {
    runSql("ROLLBACK TO script_manga_candidate_select");
    runSql("RELEASE script_manga_candidate_select");
    throw error;
  }
}

async function persistSelectedTaskReuseSource(task: TaskRow, assetId: string): Promise<void> {
  const run = requireRun(task.run_id);
  const plan = run.plan_id ? planFromRow(requirePlan(run.plan_id)) : null;
  if (!plan) return;
  const panels = new Map(getRows<TaskRow>(
    "SELECT * FROM script_manga_tasks WHERE run_id = ?",
    [run.id]
  ).flatMap((candidate) => {
    const panel = parseJson<PanelSpec | null>(candidate.panel_spec_json, null);
    return panel ? [[panel.id, panel] as const] : [];
  }));
  const source = await taskReuseSourceFromAsset(run, plan, task, assetId, panels);
  runSql(
    `UPDATE script_manga_tasks SET reuse_fingerprint = ?, reuse_source_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'selecting'`,
    [source?.fingerprint ?? null, source ? JSON.stringify(source) : null, task.id]
  );
}

function syncTaskFromRound(task: TaskRow, config: ScriptMangaRunConfig): void {
  if (
    !task.round_id ||
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "blocked" ||
    task.status === "canceled" ||
    task.status === "selecting" ||
    task.status === "awaiting_review" ||
    task.status === "auditing"
  ) return;
  const hasFallbackCandidates = parseJson<string[]>(task.candidate_asset_ids_json, []).length > 0;
  const round = getRow<{ status: string; last_error_json: string | null }>("SELECT status, last_error_json FROM generation_rounds WHERE id = ?", [
    task.round_id
  ]);
  if (!round) {
    runSql(
      "UPDATE script_manga_tasks SET status = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [hasFallbackCandidates ? "awaiting_review" : "failed", JSON.stringify({ message: "Generation round no longer exists" }), task.id]
    );
    return;
  }
  if (round?.status === "completed") {
    const scores = candidateScores(task);
    if (scores.length === 0) {
      runSql(
        "UPDATE script_manga_tasks SET status = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [
          hasFallbackCandidates ? "awaiting_review" : "failed",
          JSON.stringify({ message: "Generation completed without any candidate assets" }),
          task.id
        ]
      );
      return;
    }
    const nextStatus = config.auditMode === "vlm" ? "auditing" : "awaiting_review";
    const previousCandidateIds = parseJson<string[]>(task.candidate_asset_ids_json, []);
    const candidateIds = [...new Set([...previousCandidateIds, ...scores.map((score) => score.assetId)])];
    runSql(
      `UPDATE script_manga_tasks SET status = ?, candidate_asset_ids_json = ?, scores_json = ?,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [
        nextStatus,
        JSON.stringify(candidateIds),
        JSON.stringify({
          ...parseJson<Record<string, unknown>>(task.scores_json, {}),
          candidates: [...(parseJson<{ candidates?: unknown[] }>(task.scores_json, {}).candidates ?? []), ...scores],
          visualAuditRequired: true,
          deterministicAudit: { state: "queued" },
          ...(config.auditMode === "vlm" ? { vlmAudit: { state: "queued" } } : {})
        }),
        task.id
      ]
    );
  } else if (round?.status === "failed" || round?.status === "interrupted") {
    runSql(
      "UPDATE script_manga_tasks SET status = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [hasFallbackCandidates ? "awaiting_review" : "failed", round.last_error_json, task.id]
    );
  }
}

function markVisualAuditUnavailable(runId: string, error: unknown, deferred: boolean): void {
  const detail = error instanceof Error ? error.message : String(error);
  for (const task of getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'auditing'", [runId])) {
    const scores = parseJson<Record<string, unknown>>(task.scores_json, {});
    runSql(
      `UPDATE script_manga_tasks SET status = ?, scores_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'auditing'`,
      [
        deferred ? "auditing" : "awaiting_review",
        JSON.stringify({ ...scores, vlmAudit: { state: deferred ? "deferred" : "unavailable", error: detail.slice(0, 500) } }),
        task.id
      ]
    );
  }
  runSql("UPDATE script_manga_runs SET last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify({ message: detail.slice(0, 500), phase: "vlm-audit", deferred }),
    runId
  ]);
}

async function performRunVisualAudit(runId: string): Promise<void> {
  const run = requireRun(runId);
  if (run.status === "canceled") return;
  const config = parseConfig(run);
  if (config.auditMode !== "vlm") return;
  const allTasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ?", [runId]);
  if (allTasks.some((task) => task.status === "pending" || task.status === "inheriting" || task.status === "submitting" || task.status === "running" || task.status === "selecting")) {
    throw new Error("VLM audit is deferred until every generation task is idle");
  }
  const auditTasks = allTasks.filter((task) => task.status === "auditing");
  if (auditTasks.length === 0) return;

  const settings = getVlmAuditSettings();
  if (config.providerId === "comfy" && settings.releaseComfyBeforeAudit !== false) {
    await releaseComfyModelsForAudit();
  }
  const lease = await acquireVlmModel(settings);
  let releaseError: unknown = null;
  const rerollTaskIds: string[] = [];
  try {
    for (const originalTask of auditTasks) {
      const task = requireTask(originalTask.id);
      if (task.status !== "auditing") continue;
      const panel = parseJson<PanelSpec>(task.panel_spec_json, null as unknown as PanelSpec);
      const assetIds = parseJson<string[]>(task.candidate_asset_ids_json, []);
      if (!panel || assetIds.length === 0) {
        markVisualAuditUnavailable(runId, new Error("PanelSpec or candidate set is missing for VLM audit"), false);
        continue;
      }
      try {
        const deterministicReports = [];
        for (const assetId of assetIds) deterministicReports.push(await safeDeterministicQuality(assetId, panel.cast.map((member) => member.characterId)));
        const budget = parseJson<{ maxAttemptsPerPanel?: number }>(run.generation_budget_json, {});
        if (deterministicReports.every((report) => !report.passed) && task.attempt_count < (budget.maxAttemptsPerPanel ?? 3)) {
          const previous = parseJson<Record<string, unknown>>(task.scores_json, {});
          runSql(
            `UPDATE script_manga_tasks SET status = 'pending', round_id = NULL, scores_json = ?, last_error_json = NULL,
               updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'auditing'`,
            [JSON.stringify({ ...previous, deterministicAudit: { state: "reroll", reports: deterministicReports } }), task.id]
          );
          rerollTaskIds.push(task.id);
          continue;
        }
        const reports = [];
        for (const assetId of assetIds) {
          reports.push(await evaluatePanelCandidate({ assetId, panel, settings: lease.settings }));
        }
        const previous = parseJson<Record<string, unknown>>(task.scores_json, {});
        runSql(
          `UPDATE script_manga_tasks SET status = 'awaiting_review', scores_json = ?, last_error_json = NULL,
             updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'auditing'`,
          [
            JSON.stringify({
              ...previous,
              deterministicAudit: { state: "completed", reports: deterministicReports },
              vlmAudit: {
                state: "completed",
                model: lease.settings.model,
                evaluatedAt: new Date().toISOString(),
                reports
              }
            }),
            task.id
          ]
        );
      } catch (error) {
        const previous = parseJson<Record<string, unknown>>(task.scores_json, {});
        const detail = error instanceof Error ? error.message : String(error);
        runSql(
          `UPDATE script_manga_tasks SET status = 'awaiting_review', scores_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'auditing'`,
          [JSON.stringify({ ...previous, vlmAudit: { state: "unavailable", error: detail.slice(0, 500) } }), task.id]
        );
      }
    }
  } finally {
    try {
      await releaseVlmModel(lease);
    } catch (error) {
      releaseError = error;
    }
  }
  if (releaseError) throw releaseError;
  if (rerollTaskIds.length > 0) await submitTasks(runId, rerollTaskIds);
  runSql("UPDATE script_manga_runs SET last_error_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [runId]);
}

async function performRunDeterministicAudit(runId: string): Promise<void> {
  const run = requireRun(runId);
  const rerollTaskIds: string[] = [];
  for (const task of getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'auditing'", [runId])) {
    const assetIds = parseJson<string[]>(task.candidate_asset_ids_json, []);
    const reports = [];
    for (const assetId of assetIds) reports.push(await safeDeterministicQuality(assetId));
    const previous = parseJson<Record<string, unknown>>(task.scores_json, {});
    const budget = parseJson<{ maxAttemptsPerPanel?: number }>(run.generation_budget_json, {});
    if (reports.length > 0 && reports.every((report) => !report.passed) && task.attempt_count < (budget.maxAttemptsPerPanel ?? 3)) {
      runSql(`UPDATE script_manga_tasks SET status = 'pending', round_id = NULL, scores_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify({ ...previous, deterministicAudit: { state: "reroll", reports } }), task.id]);
      rerollTaskIds.push(task.id);
    } else {
      runSql(`UPDATE script_manga_tasks SET status = 'awaiting_review', scores_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify({ ...previous, deterministicAudit: { state: "completed", reports } }), task.id]);
    }
  }
  if (rerollTaskIds.length > 0) await submitTasks(runId, rerollTaskIds);
}

async function safeDeterministicQuality(assetId: string, characterIds: string[] = []) {
  try {
    return await evaluateDeterministicPanelQuality(assetId, characterIds);
  } catch (error) {
    return {
      assetId, passed: true,
      metrics: { luminanceStdDev: 0, saturationMean: 0, edgeDensity: 0, pseudoTextRisk: 0, ocrTokens: [], identitySimilarity: null },
      violations: [`gate-unavailable: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

function scheduleRunVisualAudit(runId: string): void {
  if (activeAuditRuns.has(runId)) return;
  const run = requireRun(runId);
  const config = parseConfig(run);
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ?", [runId]);
  if (!tasks.some((task) => task.status === "auditing")) return;
  if (tasks.some((task) => task.status === "pending" || task.status === "inheriting" || task.status === "submitting" || task.status === "running" || task.status === "selecting")) return;

  const operation = visualAuditQueue.then(() => config.auditMode === "vlm" ? performRunVisualAudit(runId) : performRunDeterministicAudit(runId));
  visualAuditQueue = operation.catch(() => undefined);
  activeAuditRuns.set(runId, operation);
  void operation
    .catch((error) => markVisualAuditUnavailable(runId, error, /deferred/i.test(error instanceof Error ? error.message : String(error))))
    .finally(() => activeAuditRuns.delete(runId));
}

function refreshRunStatus(runId: string): RunRow {
  const run = requireRun(runId);
  if (run.status === "canceled" || run.status === "exporting" || (run.status === "failed" && run.phase !== "rendering")) return run;
  const tasks = getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ?", [run.id]);
  const completed = tasks.filter((task) => task.status === "completed").length;
  const failed = tasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
  const selecting = tasks.filter((task) => task.status === "selecting").length;
  const awaitingReview = tasks.filter((task) => task.status === "awaiting_review").length + selecting;
  const auditing = tasks.filter((task) => task.status === "auditing").length;
  const active = tasks.filter((task) => task.status === "running" || task.status === "submitting" || task.status === "inheriting").length;
  const pending = tasks.filter((task) => task.status === "pending").length;
  const vlmReports = tasks.flatMap((task) => {
    const scores = parseJson<{ vlmAudit?: { reports?: unknown } }>(task.scores_json, {});
    return Array.isArray(scores.vlmAudit?.reports) ? scores.vlmAudit.reports : [];
  }).filter((report): report is { passed?: unknown; score?: unknown } => Boolean(report) && typeof report === "object");
  const terminal = tasks.length === run.panel_count && completed + failed === run.panel_count;
  let status = run.status;
  let phase = run.phase;
  if (terminal) {
    status = failed > 0 ? "completed_with_errors" : "completed";
    phase = "completed";
  } else if (active > 0) {
    status = "running";
    phase = "rendering";
  } else if (auditing > 0) {
    status = "auditing";
    phase = "auditing";
  } else if (awaitingReview > 0) {
    status = "awaiting_review";
    phase = "reviewing";
  } else if (pending > 0 && run.approval_status === "approved") {
    status = "approved";
    phase = "preparing_references";
  }
  // 集計以外のキー(materialize が書く lettering、候補採用が書く figures)は上書きで消さない。
  const previousEvaluation = parseJson<Record<string, unknown>>(run.evaluation_json, {});
  const evaluation = {
    ...previousEvaluation,
    taskCount: tasks.length,
    completed,
    failed,
    auditing,
    awaitingReview,
    selecting,
    visualAuditRequired: auditing > 0 || awaitingReview > 0,
    vlmAuditedCandidates: vlmReports.length,
    vlmPassedCandidates: vlmReports.filter((report) => report.passed === true).length,
    vlmMeanScore: vlmReports.length > 0
      ? vlmReports.reduce((sum, report) => sum + (typeof report.score === "number" ? report.score : 0), 0) / vlmReports.length
      : null,
    updatedAt: new Date().toISOString()
  };
  runSql(
    `UPDATE script_manga_runs SET status = ?, phase = ?, completed_count = ?, failed_count = ?, evaluation_json = ?,
       updated_at = CURRENT_TIMESTAMP,
       completed_at = CASE WHEN ? THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE completed_at END WHERE id = ?`,
    [status, phase, completed, failed, JSON.stringify(evaluation), terminal ? 1 : 0, run.id]
  );
  return requireRun(run.id);
}

export async function createScriptMangaRun(projectId: string, body: unknown): Promise<ScriptMangaRunView> {
  let claimedCandidateId: string | null = null;
  try {
    return await createScriptMangaRunInternal(projectId, body, (candidateId) => {
      claimedCandidateId = candidateId;
    });
  } catch (error) {
    // この呼び出しがactive→adoptingを取得した場合だけ戻す。並行した別採用のclaimは触らない。
    if (claimedCandidateId) revertPlanCandidateAdoption(claimedCandidateId);
    throw error;
  }
}

async function createScriptMangaRunInternal(
  projectId: string,
  body: unknown,
  onCandidateClaimed: (candidateId: string) => void
): Promise<ScriptMangaRunView> {
  const input = objectBody(body);
  const scriptId = requiredString(input.scriptId, "scriptId");
  requireScript(projectId, scriptId);

  const predecessorRunId = typeof input.predecessorRunId === "string" && input.predecessorRunId.trim()
    ? input.predecessorRunId.trim()
    : null;
  const predecessor = predecessorRunId ? requireRun(predecessorRunId) : null;
  const planningMode = stringOr(input.planningMode, "heuristic");
  if (planningMode !== "heuristic" && planningMode !== "llm" && planningMode !== "provided") {
    throw new HttpError(400, 'planningMode must be "heuristic", "llm", or "provided"');
  }
  if (predecessor) {
    if (predecessor.project_id !== projectId || predecessor.script_id !== scriptId) {
      throw new HttpError(404, "predecessorRunId was not found for this project and script");
    }
    if (!(["canceled", "completed", "completed_with_errors", "failed"] as string[]).includes(predecessor.status)) {
      throw new HttpError(409, "Cancel or finish the predecessor run before creating a successor");
    }
    if (planningMode !== "provided") throw new HttpError(400, 'A successor run requires planningMode "provided"');
    if (!predecessor.plan_id || !predecessor.script_revision_id) {
      throw new HttpError(409, "The predecessor has no pinned MangaPlanV2 revision");
    }
    if (input.successorPlan === undefined) throw new HttpError(400, "A complete successorPlan is required");
    if (input.planCandidateId !== undefined) throw new HttpError(400, "planCandidateId cannot be combined with predecessorRunId");
  } else if (input.successorPlan !== undefined) {
    throw new HttpError(400, "successorPlan requires predecessorRunId");
  }

  const predecessorConfig = predecessor ? parseConfig(predecessor) : null;
  const templateId = typeof input.templateId === "string" && input.templateId.trim()
    ? input.templateId.trim()
    : predecessorConfig?.templateId ?? requiredString(input.templateId, "templateId");
  const providerId = stringOr(input.providerId, predecessorConfig?.providerId ?? "comfy");
  if (!getRow("SELECT id FROM workflow_templates WHERE id = ? AND deleted_at IS NULL", [templateId])) {
    throw new HttpError(404, "Workflow template was not found");
  }
  const planOptions = planningOptionsFromInput(input, predecessorConfig?.planOptions);
  if (input.candidateSelectionPolicy !== undefined && input.candidateSelectionPolicy !== "review") {
    throw new HttpError(400, 'candidateSelectionPolicy must be "review"; generated candidates are never auto-selected');
  }
  const candidateSelectionPolicy = "review" as const;
  if (input.auditMode !== undefined && input.auditMode !== "manual" && input.auditMode !== "vlm") {
    throw new HttpError(400, 'auditMode must be "manual" or "vlm"');
  }
  const auditMode = input.auditMode === "vlm"
    ? "vlm"
    : input.auditMode === "manual"
      ? "manual"
      : predecessorConfig?.auditMode ?? "manual";
  const predecessorPlan = predecessor?.plan_id ? planFromRow(requirePlan(predecessor.plan_id)) : null;
  const dialoguePolicy = predecessorPlan?.dialoguePolicy ?? parseDialoguePolicy(input.dialoguePolicy);
  if (predecessorPlan && input.dialoguePolicy !== undefined && parseDialoguePolicy(input.dialoguePolicy) !== predecessorPlan.dialoguePolicy) {
    throw new HttpError(409, "A successor must preserve the predecessor dialoguePolicy");
  }
  if (!predecessor && (dialoguePolicy === "adapt" || dialoguePolicy === "fill") && input.panelsPerPage === undefined) {
    // 分割unitを可読サイズで置けるよう、既定packerも呼吸単位向けの大きめコマへ切り替える。
    planOptions.panelsPerPage = 2;
  }
  const revision = predecessor
    ? revisionById(scriptId, predecessor.script_revision_id!)
    : latestRevision(scriptId);
  const planCandidateId = typeof input.planCandidateId === "string" && input.planCandidateId.trim()
    ? input.planCandidateId.trim()
    : null;
  let candidatePlanningMode: "llm" | "provided" = "llm";
  const loras = styleLorasFromInput(input.loras, predecessorConfig?.loras);
  const planId = createId("manga_plan");
  let pageLimit: number;
  let plan: MangaPlanV2;
  let candidateBalloonHints: Record<number, Record<number, { x: number; y: number }>> | null = null;
  if (predecessorPlan) {
    plan = completeSuccessorPlan(input.successorPlan, predecessorPlan, planId);
    pageLimit = plan.pages.length;
  } else {
    let beatAnnotation: BeatAnnotationResult | null = null;
    let fullPlan: ScriptMangaPlan | null;
    if (planCandidateId) {
      // V5 D5: 実効プラン(基礎プラン+人間のフリップ)を採用する。監督スキーマにレイアウトは
      // 無いので「採用後レイアウト不変」は構造的に保証される。採用は数分かかるため adopting 状態で
      // フリップを凍結し、失敗時は createScriptMangaRun wrapper が active へ巻き戻す。
      const expectedCandidateVersion = typeof input.expectedCandidateVersion === "number" && Number.isInteger(input.expectedCandidateVersion)
        ? input.expectedCandidateVersion
        : undefined;
      const adoptable = adoptablePlanCandidate(planCandidateId, projectId, scriptId, revision.id, expectedCandidateVersion);
      beginPlanCandidateAdoption(planCandidateId);
      onCandidateClaimed(planCandidateId);
      const directionIsFixed = isFixedDirectedPlanCandidate(adoptable.row);
      candidatePlanningMode = isExternallyDirectedPlanCandidate(adoptable.row) ? "provided" : "llm";
      const candidateDirectionOptions = scriptMangaCandidateDirectionOptionsFromInput(input, revision.id);
      if (directionIsFixed) {
        fixedEmbeddedCandidateDirection(
          adoptable.row,
          scriptMangaCandidateDirectionInputHash(candidateDirectionOptions)
        );
      }
      fullPlan = directionIsFixed
        ? adoptable.plan
        : await directAdoptedCandidatePlan(revision.doc, adoptable.plan, candidateDirectionOptions);
      // 監督はページを再構築するため、人間ゲートのコマ割り修正(in-memory注釈)を再適用する。
      fullPlan = applyCustomNameLayouts(fullPlan, adoptable.customLayouts);
      candidateBalloonHints = adoptable.balloonHints;
      const units = buildPreLayoutUnits(revision.doc);
      const cachedBeats = readCachedBeatAnnotation(revision.id, units);
      beatAnnotation = cachedBeats ? { units, beats: cachedBeats, fallback: false, cached: true } : null;
    } else if (planningMode === "llm") {
      const detailed = await planScriptMangaWithDirectorDetailed(revision.doc, {
        ...planOptions,
        scriptRevisionId: revision.id,
        characterBible: stringOr(input.characterBible, "") || undefined
      });
      fullPlan = detailed.plan;
      beatAnnotation = detailed.beatAnnotation;
    } else if (planningMode === "provided") {
      fullPlan = validateProvidedScriptMangaPlan(revision.doc, input.directorPlan, layoutPanelCount);
    } else {
      fullPlan = planScriptManga(revision.doc, planOptions);
    }
    if (!fullPlan) throw new HttpError(400, "directorPlan is invalid or does not preserve every dialogue exactly once");
    // 候補採用は候補全体を1つのrunへ固定する。部分runをadoptedRunIdに結び付けない。
    pageLimit = !planCandidateId && typeof input.pageLimit === "number"
      ? Math.max(1, Math.min(fullPlan.pages.length, Math.trunc(input.pageLimit)))
      : fullPlan.pages.length;
    const limitedPages = fullPlan.pages.slice(0, pageLimit);
    const legacyPlan = {
      ...fullPlan,
      pages: limitedPages,
      panelCount: limitedPages.reduce((sum, page) => sum + page.panels.length, 0),
      dialogueCount: new Set(limitedPages.flatMap((page) => page.panels.flatMap((panel) => panel.dialogueOrderIndexes))).size
    };
    plan = buildMangaPlanV2({
      id: planId,
      projectId,
      scriptId,
      scriptRevisionId: revision.id,
      doc: revision.doc,
      legacyPlan,
      characters: loadCharacters(projectId),
      dialogues: loadActiveDialogues(scriptId),
      providerId,
      globalLoras: loras,
      dialoguePolicy,
      resolveLayoutTemplate,
      beatAnnotation: beatAnnotation ? { units: beatAnnotation.units, beats: beatAnnotation.beats } : null,
      balloonCenterHints: candidateBalloonHints
    });
  }
  const validation = validatePlan(plan);
  if (!validation.ok) throw new HttpError(422, "Generated MangaPlanV2 failed deterministic validation");
  const maxPanelCount = boundedInteger(input.maxPanelCount, predecessorConfig?.maxPanelCount ?? 0, 0, 800);
  requirePanelBudget(plan, maxPanelCount);
  requireDialogueBudget(plan, planOptions.maxDialoguesPerPanel ?? DEFAULT_MAX_DIALOGUES_PER_PANEL);
  requirePagePanelBudget(plan, planOptions.panelsPerPage ?? 4);
  persistPlan(projectId, plan, validation);

  const generateImages = typeof input.generateImages === "boolean"
    ? input.generateImages
    : predecessorConfig?.generateImages ?? true;
  const poseControl = input.poseControl === undefined
    ? predecessorConfig?.poseControl
    : parsePoseControlInput(input.poseControl);
  const config: ScriptMangaRunConfig = {
    templateId,
    providerId,
    batchSize: 1,
    // 外部agentが演出済みの候補は、そのdirectionを固定して組み込み監督を重ねない。
    planningMode: predecessor
      ? "provided"
      : planCandidateId
        ? candidatePlanningMode
        : planningMode,
    pageLimit,
    maxPanelCount,
    loras,
    generateImages,
    candidateSelectionPolicy,
    auditMode,
    longEdge: typeof input.longEdge === "number" ? input.longEdge : predecessorConfig?.longEdge ?? 1024,
    steps: typeof input.steps === "number" ? input.steps : predecessorConfig?.steps ?? 20,
    cfg: typeof input.cfg === "number" ? input.cfg : predecessorConfig?.cfg ?? 5,
    sampler: stringOr(input.sampler, predecessorConfig?.sampler ?? "euler"),
    scheduler: stringOr(input.scheduler, predecessorConfig?.scheduler ?? "beta"),
    planOptions,
    requireReferenceSets: typeof input.requireReferenceSets === "boolean"
      ? input.requireReferenceSets
      : predecessorConfig?.requireReferenceSets ?? (providerId === "comfy" && generateImages),
    allowReferenceFallback: typeof input.allowReferenceFallback === "boolean"
      ? input.allowReferenceFallback
      : predecessorConfig?.allowReferenceFallback ?? false,
    ...(poseControl ? { poseControl } : {}),
    ...(planCandidateId ? { planCandidateId } : {})
  };
  const predecessorBudget = predecessor
    ? parseJson<{ maxAttemptsPerPanel?: number; maxConcurrentSubmissions?: number }>(predecessor.generation_budget_json, {})
    : {};
  const generationBudget = {
    maxAttemptsPerPanel: predecessorBudget.maxAttemptsPerPanel ?? 3,
    maxConcurrentSubmissions: predecessorBudget.maxConcurrentSubmissions ?? 1,
    candidateSelectionPolicy,
    auditMode
  };
  const runId = createId("manga");
  runSql(
    `INSERT INTO script_manga_runs
       (id, predecessor_run_id, project_id, script_id, script_revision_id, plan_id, plan_version, planner_version,
        prompt_compiler_version, status, phase, approval_status, page_count, panel_count, config_json, generation_budget_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', 'planning', 'pending', ?, ?, ?, ?)`,
    [
      runId,
      predecessor?.id ?? null,
      projectId,
      scriptId,
      revision.id,
      plan.id,
      plan.version,
      plan.plannerVersion,
      plan.promptCompilerVersion,
      plan.pages.length,
      plan.panelCount,
      JSON.stringify(config),
      JSON.stringify(generationBudget)
    ]
  );
  try {
    materializeRun(runId);
    if (generateImages) {
      approveScriptMangaRun(runId);
      await startScriptMangaRun(runId);
    }
  } catch (error) {
    runSql(
      `UPDATE script_manga_runs SET status = 'failed', last_error_json = ?, updated_at = CURRENT_TIMESTAMP,
       completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [errorJson(error), runId]
    );
    throw error;
  }
  // run 準備が成立した時点で候補を採用済みとして記録する(履歴は ranker の学習データにもなる)。
  if (planCandidateId) markPlanCandidateAdopted(planCandidateId, runId);
  return runView(refreshRunStatus(runId));
}

export function getScriptMangaPlan(planId: string): ScriptMangaPlanView {
  return planView(requirePlan(planId));
}

/**
 * V5 D6: スタジオ用のホワイトリスト差分編集(POST /api/script-manga-plans/:id/edits)。
 * クライアント保持のV2全体を送り返させない(ライブ更新+エージェント併走で dialogueSnapshots/
 * provenance まで lost update するため)。サーバー保存済みplanへ差分を適用し、既存の完全更新
 * フロー(凍結復元・決定的再検証・run巻き戻し・同期materialize・edit_version加算)へ委譲する。
 */
export function applyNamePlanEdits(planId: string, body: unknown): ScriptMangaPlanView {
  const input = objectBody(body);
  const row = requirePlan(planId);
  if (typeof input.expectedVersion !== "number" || !Number.isInteger(input.expectedVersion)) {
    throw new HttpError(400, "expectedVersion is required (optimistic lock)");
  }
  if (input.expectedVersion !== row.edit_version) {
    throw new HttpError(409, "Plan was modified concurrently; reload and retry");
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new HttpError(400, "edits must be a non-empty array");
  }
  const plan = planFromRow(row);
  if (!plan) throw new HttpError(500, "Stored plan is invalid JSON");
  const pageByIndex = new Map(plan.pages.map((page) => [page.index, page]));
  const panelById = new Map(plan.pages.flatMap((page) => page.panels.map((panel) => [panel.id, panel] as const)));
  const shotSizes = new Set(["extreme-wide", "wide", "medium", "close-up", "insert"]);
  const editedText = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${field} must be a non-empty string`);
    return value.trim();
  };
  for (const rawEdit of input.edits as unknown[]) {
    if (!rawEdit || typeof rawEdit !== "object") throw new HttpError(400, "edits contains a malformed entry");
    const edit = rawEdit as Record<string, unknown>;
    if (edit.kind === "page") {
      const page = typeof edit.pageIndex === "number" ? pageByIndex.get(edit.pageIndex) : undefined;
      if (!page) throw new HttpError(400, `page ${String(edit.pageIndex)} was not found`);
      page.pageIntent = editedText(edit.pageIntent, "pageIntent");
      continue;
    }
    if (edit.kind === "panel" || edit.kind === "cast") {
      const panel = typeof edit.panelId === "string" ? panelById.get(edit.panelId) : undefined;
      if (!panel) throw new HttpError(400, `panel ${String(edit.panelId)} was not found`);
      if (edit.kind === "panel") {
        if (edit.shotSize !== undefined) {
          if (typeof edit.shotSize !== "string" || !shotSizes.has(edit.shotSize)) {
            throw new HttpError(400, "shotSize must be one of extreme-wide/wide/medium/close-up/insert");
          }
          panel.shot.size = edit.shotSize as PanelSpec["shot"]["size"];
        }
        if (edit.shotAngle !== undefined) panel.shot.angle = editedText(edit.shotAngle, "shotAngle");
        if (edit.compositionIntent !== undefined) panel.shot.compositionIntent = editedText(edit.compositionIntent, "compositionIntent");
        if (edit.promptBase !== undefined) panel.promptBase = editedText(edit.promptBase, "promptBase");
      } else {
        const member = typeof edit.characterId === "string"
          ? panel.cast.find((candidateMember) => candidateMember.characterId === edit.characterId)
          : undefined;
        if (!member) throw new HttpError(400, `cast member ${String(edit.characterId)} was not found on panel ${panel.id}`);
        if (edit.expression !== undefined) member.expression = editedText(edit.expression, "expression");
        if (edit.action !== undefined) member.action = editedText(edit.action, "action");
      }
      panel.directionSource = "human";
      continue;
    }
    if (edit.kind === "pose") {
      const panel = typeof edit.panelId === "string" ? panelById.get(edit.panelId) : undefined;
      if (!panel) throw new HttpError(400, `panel ${String(edit.panelId)} was not found`);
      const characterId = typeof edit.characterId === "string" ? edit.characterId : "";
      if (!panel.cast.some((member) => member.characterId === characterId)) {
        throw new HttpError(400, `cast member ${String(edit.characterId)} was not found on panel ${panel.id}`);
      }
      if (edit.joints === undefined && edit.depth === undefined) {
        throw new HttpError(400, "pose edit requires joints and/or depth");
      }
      const validPoseJoint = (joint: unknown): joint is { x: number; y: number; visible: boolean } => {
        if (!joint || typeof joint !== "object") return false;
        const candidate = joint as { x?: unknown; y?: unknown; visible?: unknown };
        return (
          typeof candidate.x === "number" && Number.isFinite(candidate.x) && candidate.x >= -1 && candidate.x <= 2 &&
          typeof candidate.y === "number" && Number.isFinite(candidate.y) && candidate.y >= -1 && candidate.y <= 2 &&
          typeof candidate.visible === "boolean"
        );
      };
      const poses = panel.castPoses ?? [];
      if (edit.joints === null) {
        // 骨格の削除。depth 併記は無視(消えた骨格に深度は無い)。
        panel.castPoses = poses.filter((pose) => pose.characterId !== characterId);
        if (panel.castPoses.length === 0) delete panel.castPoses;
        panel.directionSource = "human";
        continue;
      }
      let pose = poses.find((candidatePose) => candidatePose.characterId === characterId);
      if (edit.joints !== undefined) {
        const joints = edit.joints;
        if (!Array.isArray(joints) || joints.length !== OPENPOSE_JOINT_COUNT || !joints.every(validPoseJoint)) {
          throw new HttpError(400, `joints must be ${OPENPOSE_JOINT_COUNT} panel-local points with x/y in [-1, 2] and boolean visible`);
        }
        const nextJoints = (joints as Array<{ x: number; y: number; visible: boolean }>)
          .map((joint) => ({ x: joint.x, y: joint.y, visible: joint.visible }));
        if (!pose) {
          pose = { characterId, depth: poses.length, joints: nextJoints, source: "human" };
          poses.push(pose);
          panel.castPoses = poses;
        } else {
          pose.joints = nextJoints;
          pose.source = "human";
        }
      }
      if (edit.depth !== undefined) {
        if (typeof edit.depth !== "number" || !Number.isFinite(edit.depth)) {
          throw new HttpError(400, "depth must be a finite number");
        }
        if (!pose) throw new HttpError(400, `no pose exists for ${characterId} on panel ${panel.id}; send joints to create one`);
        pose.depth = edit.depth;
        pose.source = "human";
      }
      panel.directionSource = "human";
      continue;
    }
    throw new HttpError(400, 'edit.kind must be "page", "panel", "cast", or "pose"');
  }
  return updateScriptMangaPlan(planId, { plan });
}

export function updateScriptMangaPlan(planId: string, body: unknown): ScriptMangaPlanView {
  const row = requirePlan(planId);
  const input = objectBody(body);
  const candidate = (input.plan ?? body) as MangaPlanV2;
  if (!candidate || typeof candidate !== "object" || candidate.version !== 2 || !Array.isArray(candidate.pages) || !candidate.narrativeGraph) {
    throw new HttpError(400, "A complete MangaPlanV2 object is required");
  }
  const runRows = getRows<RunRow>("SELECT * FROM script_manga_runs WHERE plan_id = ?", [planId]);
  if (runRows.some((run) => run.approval_status === "approved" || run.status === "running" || run.status === "awaiting_review")) {
    throw new HttpError(409, "Approved or running plans cannot be edited; create a new run or cancel it first");
  }
  // V5 D1: 完全V2 PATCH もDB非経由の生API入力 = 旧語彙adapterの適用境界。
  normalizeMangaPlanV2Scales(candidate);
  candidate.id = row.id;
  candidate.scriptId = row.script_id;
  candidate.scriptRevisionId = row.script_revision_id;
  const originalPlan = planFromRow(row);
  const originalPages = new Map(originalPlan.pages.map((page) => [page.index, page]));
  candidate.pages = candidate.pages.map((page) => {
    const originalPage = originalPages.get(page.index);
    const snapshot = originalPage?.layoutTemplateId === page.layoutTemplateId
      ? originalPage.layoutSnapshot
      : resolveLayoutTemplate(page.layoutTemplateId);
    if (!snapshot) throw new HttpError(422, `Layout template could not be resolved: ${page.layoutTemplateId}`);
    return { ...page, layoutSnapshot: clonePageLayout(snapshot) };
  });
  candidate.sourceDialogueLineIds = [...originalPlan.sourceDialogueLineIds];
  candidate.dialogueSnapshots = originalPlan.dialogueSnapshots.map((snapshot) => ({ ...snapshot }));
  candidate.dialoguePolicy = originalPlan.dialoguePolicy;
  candidate.plannerVersion = row.planner_version;
  candidate.promptCompilerVersion = row.prompt_compiler_version;
  candidate.plannerProvenance = originalPlan.plannerProvenance;
  restoreFrozenPlanSources(candidate, originalPlan);
  candidate.createdAt = originalPlan.createdAt;
  let validation: MangaPlanValidationReport;
  try {
    validation = validatePlan(candidate);
  } catch {
    throw new HttpError(400, "Malformed MangaPlanV2 object");
  }
  if (!validation.ok) throw new HttpError(422, "Edited MangaPlanV2 failed deterministic validation");
  for (const run of runRows) requireRunPanelBudget(run, candidate);
  runSql("BEGIN IMMEDIATE");
  try {
    runSql(
      `UPDATE script_manga_plans SET plan_json = ?, validation_json = ?, dialogue_policy = ?, status = 'draft',
         approved_at = NULL, edit_version = edit_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [JSON.stringify(candidate), JSON.stringify(validation), candidate.dialoguePolicy, planId]
    );
    for (const run of runRows) {
      const pageIds = getRows<{ page_id: string }>("SELECT page_id FROM script_manga_run_pages WHERE run_id = ?", [run.id]).map((item) => item.page_id);
      for (const pageId of pageIds) runSql("DELETE FROM pages WHERE id = ?", [pageId]);
      runSql(
        `UPDATE script_manga_runs SET status = 'preparing', phase = 'planning', approval_status = 'pending', page_count = ?,
         panel_count = ?, completed_count = 0, failed_count = 0, evaluation_json = NULL, completed_at = NULL,
         last_error_json = NULL, reference_snapshot_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [candidate.pages.length, candidate.panelCount, run.id]
      );
      materializeRun(run.id);
    }
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    throw error;
  }
  return planView(requirePlan(planId));
}

export function approveScriptMangaRun(runId: string): ScriptMangaRunView {
  const run = requireRun(runId);
  if (run.status === "canceled") throw new HttpError(409, "Canceled runs cannot be approved");
  if (!run.plan_id) throw new HttpError(409, "Run has no persisted plan");
  const plan = requirePlan(run.plan_id);
  const validation = parseJson<MangaPlanValidationReport>(plan.validation_json, { ok: false, issues: [] });
  if (!validation.ok) throw new HttpError(422, "Plan validation must pass before approval");
  const mangaPlan = planFromRow(plan);
  requireRunPanelBudget(run, mangaPlan);
  const snapshot = collectReferenceSnapshot(run, mangaPlan, parseConfig(run));
  runSql("BEGIN");
  try {
    runSql("UPDATE script_manga_plans SET status = 'approved', approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [plan.id]);
    runSql(
      `UPDATE script_manga_runs SET status = 'approved', phase = 'preparing_references', approval_status = 'approved',
       reference_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [snapshot ? JSON.stringify(snapshot) : null, run.id]
    );
    // Re-materialize inside the approval transaction so every task is compiled and preflighted
    // against the newly frozen Reference Set snapshot before approval becomes visible.
    materializeRun(run.id);
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    throw error;
  }
  return runView(requireRun(run.id));
}

export async function startScriptMangaRun(runId: string): Promise<ScriptMangaRunView> {
  const run = requireRun(runId);
  if (run.approval_status !== "approved") throw new HttpError(409, "Approve the prepared run before starting generation");
  if (run.status === "canceled") throw new HttpError(409, "Canceled runs cannot be started");
  if (!run.plan_id) throw new HttpError(409, "Run has no persisted plan");
  requireRunPanelBudget(run, planFromRow(requirePlan(run.plan_id)));
  recoverInheritingTasks(run.id);
  recoverSelectingTasks(run.id);
  materializeRun(run.id);
  await inheritSelectedTasks(run.id);
  await submitTasks(run.id);
  return runView(refreshRunStatus(run.id));
}

export async function resumeScriptMangaRun(runId: string): Promise<ScriptMangaRunView> {
  const run = requireRun(runId);
  if (run.status === "canceled") throw new HttpError(409, "Canceled runs cannot be resumed");
  if (run.approval_status === "approved") {
    if (!run.plan_id) throw new HttpError(409, "Run has no persisted plan");
    requireRunPanelBudget(run, planFromRow(requirePlan(run.plan_id)));
  }
  recoverSubmittingTasks(run.id);
  recoverInheritingTasks(run.id);
  recoverSelectingTasks(run.id);
  materializeRun(run.id);
  await inheritSelectedTasks(run.id);
  for (const task of getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ? AND status = 'running'", [run.id])) {
    if (task.round_id) ensureRoundMonitor(task.round_id);
  }
  if (run.approval_status === "approved") await submitTasks(run.id);
  return getScriptMangaRun(run.id);
}

export async function cancelScriptMangaRun(runId: string): Promise<ScriptMangaRunView> {
  const run = requireRun(runId);
  const roundIds = getRows<{ round_id: string }>(
    "SELECT round_id FROM script_manga_tasks WHERE run_id = ? AND status IN ('submitting', 'running') AND round_id IS NOT NULL",
    [run.id]
  ).map((row) => row.round_id);
  // Close every local commit/submit gate before awaiting a provider. An interrupt can take an
  // arbitrary amount of time; leaving the run active during that wait admits new work which was
  // not present in roundIds and therefore would escape this cancellation.
  runSql(
    `UPDATE script_manga_runs SET status = 'canceled', phase = 'canceled', completed_at = CURRENT_TIMESTAMP,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [run.id]
  );
  runSql(
    "UPDATE script_manga_tasks SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE run_id = ? AND status NOT IN ('completed', 'failed')",
    [run.id]
  );
  for (const roundId of roundIds) {
    try {
      await interruptRound(roundId);
    } catch {
      // Run cancellation remains authoritative even if a provider is temporarily unreachable.
    }
  }
  return runView(requireRun(run.id));
}

export async function retryScriptMangaTask(taskId: string): Promise<ScriptMangaRunView> {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  if (run.approval_status !== "approved" || run.status === "canceled") throw new HttpError(409, "Task cannot be retried in the current run state");
  if (task.status !== "failed" && task.status !== "blocked" && task.status !== "awaiting_review") {
    throw new HttpError(409, "Only failed, blocked, or unselected review tasks can be retried");
  }
  const budget = parseJson<{ maxAttemptsPerPanel?: number }>(run.generation_budget_json, {});
  if (task.attempt_count >= (budget.maxAttemptsPerPanel ?? 3)) throw new HttpError(409, "Task generation budget is exhausted");
  const previousScores = parseJson<{ preflight?: unknown }>(task.scores_json, {});
  const reset = runSql(
    `UPDATE script_manga_tasks SET status = 'pending', round_id = NULL, asset_id = NULL, selected_asset_id = NULL,
     inherited_from_task_id = NULL, reuse_fingerprint = NULL, reuse_source_json = NULL,
     candidate_asset_ids_json = '[]', scores_json = ?, last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status IN ('failed', 'blocked', 'awaiting_review')
       AND EXISTS (
         SELECT 1 FROM script_manga_runs r
         WHERE r.id = script_manga_tasks.run_id AND r.approval_status = 'approved' AND r.status <> 'canceled'
       )`,
    [JSON.stringify({ preflight: previousScores.preflight ?? null }), task.id]
  ) as { changes?: number };
  if (reset.changes !== 1) throw new HttpError(409, "Task stopped accepting the retry request");
  runSql(
    `UPDATE script_manga_runs SET status = 'running', phase = 'repairing', completed_at = NULL,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [run.id]
  );
  await submitTasks(run.id, [task.id]);
  return runView(refreshRunStatus(run.id));
}

interface RepairParentAssetRow {
  id: string;
  project_id: string;
  round_id: string;
  width: number | null;
  height: number | null;
  seed: number | null;
  workflow_template_id: string;
  workflow_template_version: number;
  workflow_snapshot_hash: string;
  request_json: string;
  provider_id: string;
}

function attachmentMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function repairAttachmentDataUrl(roundId: string, kind: RoundAttachmentKind): Promise<string> {
  try {
    const path = resolveRoundAttachmentPath(roundId, kind);
    const bytes = await readFile(path);
    return `data:${attachmentMimeType(path)};base64,${bytes.toString("base64")}`;
  } catch {
    throw new HttpError(409, `The parent candidate ${kind} attachment could not be reproduced`);
  }
}

/**
 * Repair one persisted candidate in-place while retaining the old candidate set. The caller may
 * supply only the mask controls; all story and generation conditioning is frozen from the parent.
 */
export async function repairScriptMangaTask(taskId: string, body: unknown): Promise<ScriptMangaRunView> {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  if (run.approval_status !== "approved" || run.status === "canceled") {
    throw new HttpError(409, "Task cannot be repaired in the current run state");
  }
  if (task.status !== "awaiting_review") {
    throw new HttpError(409, "Only an unselected candidate review task can be repaired");
  }
  const repair = parseScriptMangaRepairRequest(body);
  const candidateIds = parseJson<string[]>(task.candidate_asset_ids_json, []);
  if (!candidateIds.includes(repair.assetId)) {
    throw new HttpError(400, "Asset is not in the persisted candidate set");
  }
  const budget = parseJson<{ maxAttemptsPerPanel?: number }>(run.generation_budget_json, {});
  if (task.attempt_count >= (budget.maxAttemptsPerPanel ?? 3)) {
    throw new HttpError(409, "Task generation budget is exhausted");
  }

  const parent = getRow<RepairParentAssetRow>(
    `SELECT a.id, a.project_id, a.round_id, a.width, a.height, a.seed,
            a.workflow_template_id, a.workflow_template_version, a.workflow_snapshot_hash,
            r.request_json, r.provider_id
     FROM assets a
     JOIN generation_rounds r ON r.id = a.round_id
     WHERE a.id = ? AND a.project_id = ? AND r.script_manga_task_id = ?`,
    [repair.assetId, run.project_id, task.id]
  );
  if (!parent) throw new HttpError(400, "Asset is not a candidate generated for this task");
  const currentTemplate = getRow<{ id: string; version: number; workflow_hash: string }>(
    "SELECT id, version, workflow_hash FROM workflow_templates WHERE id = ? AND deleted_at IS NULL",
    [parent.workflow_template_id]
  );
  if (
    !currentTemplate ||
    currentTemplate.version !== parent.workflow_template_version ||
    currentTemplate.workflow_hash !== parent.workflow_snapshot_hash
  ) {
    throw new HttpError(409, "The parent candidate workflow revision is no longer available for exact repair");
  }
  const parentRequest = parseJson<GenerationRequest | null>(parent.request_json, null);
  if (!parentRequest || parentRequest.templateId !== parent.workflow_template_id) {
    throw new HttpError(409, "The parent candidate generation request is not reproducible");
  }

  const poseImageDataUrl = parentRequest.controlnet
    ? typeof parentRequest.controlnet.poseImageDataUrl === "string" && parentRequest.controlnet.poseImageDataUrl
      ? parentRequest.controlnet.poseImageDataUrl
      : await repairAttachmentDataUrl(parent.round_id, "pose")
    : null;
  const hasPinnedReferenceSet = Boolean(
    parentRequest.reference?.referenceSet?.setId && parentRequest.reference.referenceSet.version > 0
  );
  const usesUnpinnedReference = Boolean(
    parentRequest.reference &&
    !hasPinnedReferenceSet &&
    (
      parentRequest.reference.imageDataUrl ||
      parentRequest.reference.imagePath ||
      parentRequest.reference.images?.facePath ||
      parentRequest.reference.characterBinding
    )
  );
  const referenceImageDataUrl = usesUnpinnedReference
    ? typeof parentRequest.reference?.imageDataUrl === "string" && parentRequest.reference.imageDataUrl
      ? parentRequest.reference.imageDataUrl
      : await repairAttachmentDataUrl(parent.round_id, "reference")
    : null;
  const request = buildScriptMangaRepairGenerationRequest({
    assetId: parent.id,
    width: parent.width ?? 0,
    height: parent.height ?? 0,
    seed: parent.seed,
    providerId: parent.provider_id,
    request: parentRequest,
    poseImageDataUrl,
    referenceImageDataUrl
  }, repair);

  const previousScores = parseJson<Record<string, unknown>>(task.scores_json, {});
  const previousRepairs = Array.isArray(previousScores.repairs) ? previousScores.repairs : [];
  const claimed = runSql(
    `UPDATE script_manga_tasks SET status = 'submitting', round_id = NULL,
       attempt_count = attempt_count + 1, last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'awaiting_review'`,
    [task.id]
  ) as { changes?: number };
  if (claimed.changes !== 1) throw new HttpError(409, "Task is no longer awaiting candidate review");
  runSql(
    `UPDATE script_manga_runs SET status = 'running', phase = 'repairing', completed_at = NULL,
       last_error_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'canceled'`,
    [run.id]
  );

  activeTaskSubmissions.add(task.id);
  let createdRoundId: string | null = null;
  try {
    const created = await createGenerationRound(run.project_id, request, task.page_id, task.panel_id, task.id);
    if (!created.round) throw new Error("Repair generation round was not created");
    createdRoundId = created.round.id;
    const latestRun = requireRun(run.id);
    const latestTask = requireTask(task.id);
    if (latestRun.status === "canceled" || latestTask.status === "canceled") {
      try {
        await interruptRound(createdRoundId);
      } catch {
        // Cancellation remains authoritative; provider cleanup is best effort.
      }
      return runView(requireRun(run.id));
    }
    const repairs = [
      ...previousRepairs,
      {
        roundId: createdRoundId,
        parentAssetId: parent.id,
        denoise: repair.denoise,
        maskedContent: repair.inpaint.maskedContent,
        onlyMaskedPadding: repair.inpaint.onlyMaskedPadding,
        featherRadius: repair.inpaint.featherRadius,
        createdAt: new Date().toISOString()
      }
    ];
    const updated = runSql(
      `UPDATE script_manga_tasks SET round_id = ?, status = 'running', scores_json = ?,
         updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'submitting'`,
      [createdRoundId, JSON.stringify({ ...previousScores, repairs }), task.id]
    ) as { changes?: number };
    if (updated.changes !== 1) {
      try {
        await interruptRound(createdRoundId);
      } catch {
        // The task CAS failure is the primary error.
      }
      throw new HttpError(409, "Task stopped accepting the repair generation round");
    }
  } catch (error) {
    runSql(
      `UPDATE script_manga_tasks SET status = 'awaiting_review', round_id = ?, attempt_count = ?,
         scores_json = ?, last_error_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'submitting'`,
      [task.round_id, task.attempt_count, task.scores_json, errorJson(error), task.id]
    );
    runSql(
      "UPDATE script_manga_runs SET last_error_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'canceled'",
      [JSON.stringify({ message: error instanceof Error ? error.message : String(error), phase: "repairing" }), run.id]
    );
    refreshRunStatus(run.id);
    throw error;
  } finally {
    activeTaskSubmissions.delete(task.id);
  }
  return runView(refreshRunStatus(run.id));
}

/** run の evaluation_json へ figure 切り抜きの結果(成功/フォールバック/失敗)を記録する。 */
function recordFigureResult(runId: string, taskId: string, value: unknown): void {
  const evaluation = parseJson<Record<string, unknown>>(requireRun(runId).evaluation_json, {});
  const figures = { ...((evaluation.figures as Record<string, unknown>) ?? {}), [taskId]: value };
  runSql("UPDATE script_manga_runs SET evaluation_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify({ ...evaluation, figures }),
    runId
  ]);
}

/**
 * ぶち抜き立ち絵(Docs/Reference-MangaCompositions.md)の再レタリング。立ち絵 ImageObject が
 * 障害物として増えた後、ロックされていない吹き出しを顔・立ち絵回避と専有率制約付きで
 * 組み直す。失敗しても既存配置を維持する(切り抜き自体は成功している)best effort。
 */
function reflowLetteringAroundFigure(run: RunRow, task: TaskRow): void {
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

/**
 * 採用候補がぶち抜き立ち絵スロット(layout panel role:"figure")のものなら、背景除去+白フチの
 * 切り抜きを page_media 化し、`figure_<panelId>` の ImageObject(band:"front"、クリップ無し)として
 * コマ枠の前面へ重ねる。切り抜きが成立しない画像(無地背景でない等)は通常のコマ画像割当へ
 * フォールバックする。再採用時は同 id のオブジェクトと旧メディアを差し替える。
 */
async function materializeFigureForTask(
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

export async function selectScriptMangaTaskCandidate(taskId: string, body: unknown): Promise<ScriptMangaRunView> {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  const input = objectBody(body);
  const assetId = requiredString(input.assetId, "assetId");
  if (run.approval_status !== "approved" || run.status === "canceled") {
    throw new HttpError(409, "Task cannot accept candidate selection in the current run state");
  }
  if (task.status !== "awaiting_review") throw new HttpError(409, "Task is not awaiting candidate review");
  const candidates = parseJson<string[]>(task.candidate_asset_ids_json, []);
  if (!candidates.includes(assetId)) throw new HttpError(400, "Asset is not in the persisted candidate set");
  const auditMode = parseConfig(run).auditMode;
  if (auditMode === "manual") {
    const scores = parseJson<{
      externalAudit?: { reports?: Array<{ assetId?: string; passed?: boolean }> };
    }>(task.scores_json, {});
    const report = scores.externalAudit?.reports?.find((candidate) => candidate.assetId === assetId);
    if (report?.passed === false) {
      throw new HttpError(409, "The selected candidate failed external audit; repair or regenerate this panel");
    }
  }
  if (auditMode === "vlm") {
    const scores = parseJson<{ vlmAudit?: { state?: string; reports?: Array<{ assetId?: string; passed?: boolean }> } }>(
      task.scores_json,
      {}
    );
    const report = scores.vlmAudit?.reports?.find((candidate) => candidate.assetId === assetId);
    if (scores.vlmAudit?.state !== "completed" || !report) {
      throw new HttpError(409, "The selected candidate must complete VLM audit before selection");
    }
    if (report.passed !== true) {
      throw new HttpError(409, "The selected candidate failed VLM audit; repair or regenerate this panel");
    }
  }
  const claimed = runSql(
    `UPDATE script_manga_tasks SET status = 'selecting', last_error_json = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'awaiting_review'
       AND EXISTS (
         SELECT 1 FROM script_manga_runs r
         WHERE r.id = script_manga_tasks.run_id AND r.approval_status = 'approved' AND r.status <> 'canceled'
       )`,
    [task.id]
  ) as { changes?: number };
  if (claimed.changes !== 1) throw new HttpError(409, "Task is no longer awaiting candidate review");
  activeTaskSelections.add(task.id);
  try {
    await persistSelectedTaskReuseSource(task, assetId);
    const latestTask = requireTask(task.id);
    const layout = pageLayout(latestTask.page_id);
    const layoutPanel = layout.panels.find((panel) => panel.id === latestTask.panel_id);
    let skipPanelAssignment = false;
    if (layoutPanel?.role === "figure") {
      try {
        const result = await materializeFigureForTask(latestTask, assetId, {
          canCommit: () => {
            const latestRun = requireRun(task.run_id);
            const currentTask = requireTask(task.id);
            return latestRun.status !== "canceled" && currentTask.status === "selecting";
          }
        });
        skipPanelAssignment = result.committed && result.mode === "cutout";
      } catch (error) {
        // 切り抜き失敗時も通常のコマ割当で採用できるようにし、原因は evaluation に残す。
        recordFigureResult(task.run_id, task.id, {
          state: "failed",
          assetId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    selectTaskCandidateInternal(task, assetId, { skipPanelAssignment });
  } catch (error) {
    runSql(
      `UPDATE script_manga_tasks SET status = 'awaiting_review', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'selecting'
         AND EXISTS (SELECT 1 FROM script_manga_runs r WHERE r.id = script_manga_tasks.run_id AND r.status <> 'canceled')`,
      [task.id]
    );
    throw error;
  } finally {
    activeTaskSelections.delete(task.id);
  }
  return runView(refreshRunStatus(task.run_id));
}

function requiredExternalAuditText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new HttpError(400, `${name} is too long`);
  return normalized;
}

function externalAuditNotes(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HttpError(400, "notes must be a string");
  const normalized = value.trim();
  if (normalized.length > 2000) throw new HttpError(400, "notes is too long");
  return normalized;
}

function externalAuditChecks(value: unknown): Record<string, "pass" | "fail"> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "checks must be an object");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) throw new HttpError(400, "checks has too many entries");
  const checks: Record<string, "pass" | "fail"> = {};
  for (const [rawName, result] of entries) {
    const name = rawName.trim();
    if (!name || name.length > 80 || (result !== "pass" && result !== "fail")) {
      throw new HttpError(400, "checks must contain short names with pass or fail values");
    }
    checks[name] = result;
  }
  return checks;
}

function externalAuditViolations(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new HttpError(400, "violations must be a bounded string array");
  }
  const violations: string[] = [];
  for (const rawViolation of value) {
    if (typeof rawViolation !== "string" || !rawViolation.trim() || rawViolation.length > 300) {
      throw new HttpError(400, "violations must contain short non-empty strings");
    }
    const violation = rawViolation.trim();
    if (!violations.includes(violation)) violations.push(violation);
  }
  return violations;
}

/**
 * Persist an explicit external-agent review without retaining the caller's raw payload. Manual
 * selection stays backward compatible when no report exists, while an explicit failed report is
 * authoritative for that candidate until it is replaced or the task is retried.
 */
export function recordExternalScriptMangaTaskAudit(
  taskId: string,
  body: unknown
): RecordExternalScriptMangaTaskAuditResponse {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  if (parseConfig(run).auditMode !== "manual") {
    throw new HttpError(409, "Only manual-audit runs accept external audit results");
  }
  if (run.approval_status !== "approved" || run.status === "canceled") {
    throw new HttpError(409, "Task cannot accept external audit in the current run state");
  }
  if (task.status !== "awaiting_review") throw new HttpError(409, "Task is not awaiting candidate review");

  const input = objectBody(body);
  const assetId = requiredString(input.assetId, "assetId");
  const candidates = parseJson<string[]>(task.candidate_asset_ids_json, []);
  if (!candidates.includes(assetId)) throw new HttpError(400, "Asset is not in the persisted candidate set");
  if (typeof input.passed !== "boolean") throw new HttpError(400, "passed must be a boolean");
  if (input.score !== undefined && (
    typeof input.score !== "number" || !Number.isFinite(input.score) || input.score < 0 || input.score > 1
  )) {
    throw new HttpError(400, "score must be between 0 and 1");
  }

  const report: ScriptMangaExternalAuditReport = {
    assetId,
    passed: input.passed,
    ...(typeof input.score === "number" ? { score: input.score } : {}),
    checks: externalAuditChecks(input.checks),
    violations: externalAuditViolations(input.violations),
    reviewer: requiredExternalAuditText(input.reviewer, "reviewer", 160),
    model: requiredExternalAuditText(input.model, "model", 160),
    notes: externalAuditNotes(input.notes),
    evaluatedAt: new Date().toISOString()
  };
  const scores = parseJson<Record<string, unknown>>(task.scores_json, {});
  const previousAudit = scores.externalAudit && typeof scores.externalAudit === "object" && !Array.isArray(scores.externalAudit)
    ? scores.externalAudit as { reports?: unknown }
    : {};
  const previousReports = Array.isArray(previousAudit.reports)
    ? previousAudit.reports.filter((candidate): candidate is Record<string, unknown> => (
        Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)
      ))
    : [];
  const reports = [
    ...previousReports.filter((candidate) => candidate.assetId !== assetId),
    report
  ];
  const updated = runSql(
    `UPDATE script_manga_tasks SET scores_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'awaiting_review'`,
    [JSON.stringify({
      ...scores,
      externalAudit: { state: "completed", reports, updatedAt: report.evaluatedAt }
    }), task.id]
  ) as { changes?: number };
  if (updated.changes !== 1) throw new HttpError(409, "Task stopped accepting the external audit result");
  return { report, run: runView(refreshRunStatus(task.run_id)) };
}

/** Explicitly queue/retry the VLM audit while retaining human review as the final gate. */
export async function auditScriptMangaTask(taskId: string): Promise<ScriptMangaRunView> {
  const task = requireTask(taskId);
  const run = requireRun(task.run_id);
  const config = parseConfig(run);
  if (config.auditMode !== "vlm") throw new HttpError(409, "This run is configured for manual audit only");
  if (task.status !== "auditing" && task.status !== "awaiting_review") {
    throw new HttpError(409, "Only generated, unselected candidates can be audited");
  }
  if (task.status === "awaiting_review") {
    const scores = parseJson<Record<string, unknown>>(task.scores_json, {});
    const claimed = runSql("UPDATE script_manga_tasks SET status = 'auditing', scores_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'awaiting_review'", [
      JSON.stringify({ ...scores, vlmAudit: { state: "queued" } }),
      task.id
    ]) as { changes?: number };
    if (claimed.changes !== 1) throw new HttpError(409, "Task stopped accepting the audit request");
  }
  scheduleRunVisualAudit(run.id);
  await activeAuditRuns.get(run.id)?.catch(() => undefined);
  return runView(refreshRunStatus(run.id));
}

/** Exports only the pages owned by a fully reviewed run and persists a reproducible manifest. */
export async function withScriptMangaRunExport<T>(
  runId: string,
  body: unknown,
  operation: (artifact: ImageExportResult | OpenRasterExportResult) => Promise<T>
): Promise<T> {
  const run = refreshRunStatus(runId);
  if (run.status !== "completed") {
    throw new HttpError(409, "Every panel candidate must be generated and selected before exporting this run");
  }
  const pageIds = getRows<{ page_id: string }>(
    "SELECT page_id FROM script_manga_run_pages WHERE run_id = ? ORDER BY page_index ASC",
    [run.id]
  ).map((row) => row.page_id);
  if (pageIds.length !== run.page_count) throw new HttpError(409, "Run-owned export pages are incomplete");
  const input = objectBody(body);
  const format = stringOr(input.format, "png").toLowerCase();
  runSql(
    "UPDATE script_manga_runs SET status = 'exporting', phase = 'exporting', last_error_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [run.id]
  );
  try {
    const completeExport = async (result: ImageExportResult | OpenRasterExportResult) => {
      const manifest = {
        format,
        filename: result.filename,
        contentType: result.contentType,
        pageCount: result.pageCount,
        pageIds,
        createdAt: new Date().toISOString()
      };
      runSql(
        `UPDATE script_manga_runs SET status = 'completed', phase = 'completed', export_manifest_json = ?,
           last_error_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify(manifest), run.id]
      );
      return operation(result);
    };
    return format === "ora"
      ? await withOpenRasterExport(run.project_id, { pageIds }, completeExport)
      : await withImageExport(
          run.project_id,
          { pageIds, format, pixelWidth: input.pixelWidth, quality: input.quality },
          completeExport
        );
  } catch (error) {
    runSql(
      `UPDATE script_manga_runs SET status = 'completed', phase = 'completed', last_error_json = ?,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [errorJson(error), run.id]
    );
    throw error;
  }
}

/** Pull round state into persisted candidate/audit state. GET polling is idempotent. */
export function getScriptMangaRun(runId: string): ScriptMangaRunView {
  const run = requireRun(runId);
  recoverSubmittingTasks(run.id);
  recoverInheritingTasks(run.id);
  recoverSelectingTasks(run.id);
  const config = parseConfig(run);
  for (const task of getRows<TaskRow>("SELECT * FROM script_manga_tasks WHERE run_id = ?", [run.id])) {
    syncTaskFromRound(task, config);
  }
  scheduleRunVisualAudit(run.id);
  return runView(refreshRunStatus(run.id));
}

