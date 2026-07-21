import type { MangaPlanV2, PanelSpec } from "../shared/mangaPlanV2";
import type { PageLayout } from "../shared/pageLayout";
import type { GenerationRequest } from "../shared/types";
import type { PageRow } from "../shared/apiTypes";
import type { ScriptMangaReferenceSnapshot } from "../shared/referenceSets";
import { dataRoot, getRow, getRows, runSql, toApiRow } from "./db";
import { upsertPanelAssignment } from "./panelAssignments";
import sharp from "sharp";
import {
  computeScriptMangaReuseFingerprint,
  matchScriptMangaReuseCandidatesWithReservations,
  SCRIPT_MANGA_REUSE_FINGERPRINT_VERSION
} from "./scriptMangaInheritance";
import { createHash } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { hashJson } from "./workflowGraph";
import { normalizeGenerationRequest } from "./generationRequest";
import { isPathInside } from "./paths";
import { activeTaskInheritances, buildPanelGenerationRequest } from "./scriptMangaSubmission";
import { materializeFigureForTask } from "./scriptMangaFigure";
import {
  errorJson,
  frozenReferenceSnapshot,
  pageLayout,
  parseConfig,
  parseJson,
  planFromRow,
  requirePlan,
  requireRun,
  requireTask,
  type RunRow,
  type ScriptMangaRunConfig,
  type TaskRow
} from "./scriptMangaRows";

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
    const built = await buildPanelGenerationRequest({
      run,
      plan,
      config,
      panel: context.panel,
      layout: context.layout,
      panelId: task.panel_id,
      poseControlWorkflowJson: template.workflowJson
    });
    const generation = await canonicalGenerationMaterial({
      providerId: config.providerId,
      template: { id: template.id, version: template.version, workflowHash: template.workflowHash },
      request: built.request,
      referenceSnapshot: frozenReferenceSnapshot(run)
    });
    if (!generation) return null;
    const normalizedPanel: PanelSpec = {
      ...context.panel,
      referenceManifest: built.references.manifest,
      compiledPrompt: built.conditioning.positive
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

export async function taskReuseSourceFromAsset(
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

export async function inheritSelectedTasks(runId: string): Promise<void> {
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
