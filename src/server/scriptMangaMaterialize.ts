import {
  type MangaPlanV2,
  type MangaPlanValidationReport,
  type PanelSpec
} from "../shared/mangaPlanV2";
import type { PageLayout } from "../shared/pageLayout";
import {
  actionTextEstablishesVisibleActor,
  dialogueEstablishesVisibleSpeaker,
  stripClausesContainingCharacterLabels,
  textContainsCharacterLabel
} from "../shared/dialoguePresentation";
import { referenceSnapshotKey } from "../shared/referenceSets";
import { orderPanelsByReadingDirection } from "../shared/dialogueAutoLayout";
import { normalizePageObjects } from "../shared/pageObjects";
import { isMangaEffectObject } from "../shared/mangaEffects";
import { compilePanelConditioning } from "./panelPromptCompiler";
import { createId, getRow, getRows, runSql } from "./db";
import { HttpError } from "./http";
import { createPage, updatePage } from "./pages";
import { validatePanelPreflight, type PanelPreflightReport } from "./panelPreflightValidator";
import { resolvePanelReferences } from "./referenceResolver";
import type { StoryGraphDialogueInput } from "./storyGraphBuilder";
import { actualTextSafeZones, ensureDialogueLettering } from "./scriptMangaLettering";
import {
  clonePageLayout,
  frozenReferenceSnapshot,
  pageLayout,
  parseConfig,
  parseJson,
  planFromRow,
  referenceModelFamily,
  requirePlan,
  requireRun,
  templatePromptProfile,
  validatePlan,
  type RunRow,
  type ScriptMangaRunConfig
} from "./scriptMangaRows";

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

export function persistPlan(projectId: string, plan: MangaPlanV2, validation: MangaPlanValidationReport): void {
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

export function sourceGroundedCharacterIds(panel: PanelSpec, graph: MangaPlanV2["narrativeGraph"]): Set<string> {
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

export function normalizePanelCast(
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

export function materializeRun(runId: string): void {
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
