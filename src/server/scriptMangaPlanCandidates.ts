/**
 * プラン候補(ネームv4 D3)。候補 = N1結果(ページ割り+importance/turnHook+事前選択レイアウト)。
 * 「1呼び出しで複数案」はやらず、ビート注釈1回(キャッシュ共有)+N1をk回で候補を貯める。
 * 監督・画像生成は採用後に1回だけ(createScriptMangaRun の planCandidateId ルート)。
 */
import { createHash } from "node:crypto";
import type { FountainDoc } from "../shared/fountain";
import { buildPanelDemand, rankLayouts } from "../shared/layoutMatcher";
import { resolveScriptMangaLayout } from "../shared/layoutPresets";
import type {
  CreateScriptMangaPlanCandidatesRequest,
  ImportScriptMangaPlanCandidateRequest,
  ImportScriptMangaPlanCandidateResponse,
  ScriptMangaPlanCandidateDirectorMode,
  ScriptMangaPlanCandidateOrigin,
  ScriptMangaPlanCandidatesResponse,
  ScriptMangaPlanCandidateView,
  SetCandidateCustomLayoutRequest,
  SetCandidateCustomLayoutResponse,
  SetCandidateLayoutResponse
} from "../shared/scriptMangaApi";
import {
  applyCustomNameLayouts,
  applyLayoutOverrides,
  normalizeScriptMangaPlanScales,
  scriptMangaPlanStructureSignature,
  stripCustomNameLayouts,
  type ScriptMangaPlan,
  type ScriptMangaPlanOptions
} from "../shared/scriptMangaPlan";
import { normalizeEditedPageLayout, type PageLayout } from "../shared/pageLayout";
import { toEditableNameLayout, validateEditedNameLayout } from "../shared/nameLayoutEdit";
import { validateProvidedScriptMangaPlan } from "../shared/scriptMangaProvidedPlan";
import { buildPreLayoutUnits } from "../shared/preLayoutBeat";
import { createId, getRow, getRows, runSql } from "./db";
import { HttpError } from "./http";
import { objectBody, requiredString } from "./validate";
import { readCachedBeatAnnotation } from "./scriptBeatAnnotator";
import { generateScriptMangaN1Plan } from "./scriptMangaDirector";
import { resolveLayoutTemplate } from "./layoutTemplates";

export interface PlanCandidateRow {
  id: string;
  project_id: string;
  script_id: string;
  script_revision_id: string;
  group_id: string;
  profile: string | null;
  temperature: number | null;
  plan_json: string;
  provenance_json: string | null;
  status: string;
  adopted_run_id: string | null;
  layout_overrides_json: string | null;
  custom_layouts_json: string | null;
  balloon_hints_json: string | null;
  edit_version: number;
  created_at: string;
}

interface PlanCandidateProvenance {
  origin?: ScriptMangaPlanCandidateOrigin;
  directorMode?: ScriptMangaPlanCandidateDirectorMode;
  pageNaming?: { mode?: string; fallback?: boolean; beatAnnotatorFallback?: boolean };
  profile?: string;
  temperature?: number;
  external?: { agent?: string; model?: string; notes?: string };
  direction?: { inputHash: string; model: string | null };
}

/** 候補毎の演出プロファイル(D3.1)。システムプロンプトへ1行だけ足す。 */
const PROFILE_INSTRUCTIONS: Record<string, string> = {
  readability: "Profile: readability — favor steady 3-5 panel pages and calm, legible pacing; reserve hero panels for true peaks.",
  cinematic: "Profile: cinematic — favor bold hero and splash usage, dramatic page turns, and fewer panels per page.",
  tempo: "Profile: tempo — vary panel counts page to page for rhythm; dense conversation pages followed by sparse impact pages."
};
const DEFAULT_PROFILE_CYCLE = ["readability", "cinematic", "tempo"] as const;

function requireScript(projectId: string, scriptId: string): void {
  if (!getRow("SELECT id FROM manga_scripts WHERE id = ? AND project_id = ?", [scriptId, projectId])) {
    throw new HttpError(404, "Script was not found in this project");
  }
}

function latestRevision(scriptId: string): { id: string; doc: FountainDoc } {
  const row = getRow<{ id: string; parsed_json: string }>(
    "SELECT id, parsed_json FROM script_revisions WHERE script_id = ? ORDER BY revision DESC LIMIT 1",
    [scriptId]
  );
  if (!row) throw new HttpError(400, "Script has no Fountain revision");
  try {
    return { id: row.id, doc: JSON.parse(row.parsed_json) as FountainDoc };
  } catch {
    throw new HttpError(500, "Stored Fountain revision is invalid");
  }
}

export function requirePlanCandidate(candidateId: string): PlanCandidateRow {
  const row = getRow<PlanCandidateRow>("SELECT * FROM script_manga_plan_candidates WHERE id = ?", [candidateId]);
  if (!row) throw new HttpError(404, "Plan candidate was not found");
  return row;
}

function parseCandidatePlan(row: PlanCandidateRow): ScriptMangaPlan {
  try {
    // V5 D1: 旧語彙(importance)だけの旧候補へ visualScale を補完する入力adapter。
    return normalizeScriptMangaPlanScales(JSON.parse(row.plan_json) as ScriptMangaPlan);
  } catch {
    throw new HttpError(500, "Stored plan candidate is invalid JSON");
  }
}

/** 人間のページ別レイアウト選択(V5 D5)。壊れたJSON・不正キーは黙って捨てる。 */
function parseOverrides(row: PlanCandidateRow): Record<number, string> {
  if (!row.layout_overrides_json) return {};
  const parsed = safeParse(row.layout_overrides_json);
  if (!parsed || typeof parsed !== "object") return {};
  const overrides: Record<number, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && typeof value === "string" && value) overrides[index] = value;
  }
  return overrides;
}

/** 人間ゲートのコマ割り修正(pageIndex → 編集済み PageLayout)。壊れたJSON・不正エントリは黙って捨てる。 */
export function parseCandidateCustomLayouts(
  row: Pick<PlanCandidateRow, "custom_layouts_json">
): Record<number, PageLayout> {
  if (!row.custom_layouts_json) return {};
  const parsed = safeParse(row.custom_layouts_json);
  if (!parsed || typeof parsed !== "object") return {};
  const layouts: Record<number, PageLayout> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    const layout = normalizeEditedPageLayout(value);
    if (layout) layouts[index] = layout;
  }
  return layouts;
}

/** 吹き出し位置ヒント(pageIndex → dialogue orderIndex → page 座標)。 */
export function parseCandidateBalloonHints(
  row: Pick<PlanCandidateRow, "balloon_hints_json">
): Record<number, Record<number, { x: number; y: number }>> {
  if (!row.balloon_hints_json) return {};
  const parsed = safeParse(row.balloon_hints_json);
  if (!parsed || typeof parsed !== "object") return {};
  const hints: Record<number, Record<number, { x: number; y: number }>> = {};
  for (const [pageKey, pageValue] of Object.entries(parsed as Record<string, unknown>)) {
    const pageIndex = Number(pageKey);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || !pageValue || typeof pageValue !== "object") continue;
    const pageHints: Record<number, { x: number; y: number }> = {};
    for (const [orderKey, position] of Object.entries(pageValue as Record<string, unknown>)) {
      const orderIndex = Number(orderKey);
      if (!Number.isInteger(orderIndex) || orderIndex < 0 || !position || typeof position !== "object") continue;
      const { x, y } = position as { x?: unknown; y?: unknown };
      if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
        pageHints[orderIndex] = { x, y };
      }
    }
    if (Object.keys(pageHints).length > 0) hints[pageIndex] = pageHints;
  }
  return hints;
}

function parseCandidateProvenance(row: Pick<PlanCandidateRow, "provenance_json">): PlanCandidateProvenance {
  if (!row.provenance_json) return {};
  const parsed = safeParse(row.provenance_json);
  return parsed && typeof parsed === "object" ? parsed as PlanCandidateProvenance : {};
}

/** createScriptMangaRun側が組み込み監督LLMを省略できる、server-owned provenance判定。 */
export function isExternallyDirectedPlanCandidate(
  row: Pick<PlanCandidateRow, "provenance_json">
): boolean {
  const provenance = parseCandidateProvenance(row);
  return provenance.origin === "external" && provenance.directorMode === "provided";
}

/** provided/fixed候補はoriginを問わず採用時に同じplanを使い、監督を再実行しない。 */
export function isFixedDirectedPlanCandidate(
  row: Pick<PlanCandidateRow, "provenance_json">
): boolean {
  return parseCandidateProvenance(row).directorMode === "provided";
}

/** Bind an embedded fixed plan to the direction-affecting settings that produced it. */
export function fixedEmbeddedCandidateDirection(
  row: Pick<PlanCandidateRow, "provenance_json">,
  expectedInputHash: string
): { inputHash: string; model: string | null } | null {
  const provenance = parseCandidateProvenance(row);
  if (provenance.origin !== "embedded" || provenance.directorMode !== "provided") return null;
  if (!provenance.direction || provenance.direction.inputHash !== expectedInputHash) {
    throw new HttpError(
      409,
      "Direction-affecting candidate settings differ from the successful preflight; use the same settings or regenerate the candidate"
    );
  }
  return provenance.direction;
}

export function scriptMangaCandidateDirectionInputHash(options: ScriptMangaPlanOptions): string {
  const canonical = {
    scriptRevisionId: options.scriptRevisionId ?? null,
    panelsPerPage: options.panelsPerPage ?? null,
    maxElementsPerPanel: options.maxElementsPerPanel ?? null,
    maxDialoguesPerPanel: options.maxDialoguesPerPanel ?? null,
    targetPageCount: options.targetPageCount ?? null,
    stylePrompt: options.stylePrompt ?? null,
    characterBible: options.characterBible ?? null
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function candidateView(row: PlanCandidateRow): ScriptMangaPlanCandidateView {
  const provenance = parseCandidateProvenance(row);
  const pageNaming = provenance.pageNaming;
  // V5 D2: 旧値 "panels"(従来N1)は未知値としてnull化する(旧provenance行はバッジ無し表示)。
  const mode = pageNaming?.mode === "beats" || pageNaming?.mode === "deterministic"
    ? pageNaming.mode
    : null;
  return {
    id: row.id,
    projectId: row.project_id,
    scriptId: row.script_id,
    scriptRevisionId: row.script_revision_id,
    groupId: row.group_id,
    profile: row.profile,
    temperature: row.temperature,
    origin: provenance.origin === "external" ? "external" : "embedded",
    directorMode: provenance.directorMode === "provided" ? "provided" : "embedded",
    status: row.status === "adopted" || row.status === "archived" || row.status === "adopting" ? row.status : "active",
    adoptedRunId: row.adopted_run_id,
    plan: parseCandidatePlan(row),
    layoutOverrides: parseOverrides(row),
    customLayouts: parseCandidateCustomLayouts(row),
    balloonHints: parseCandidateBalloonHints(row),
    editVersion: row.edit_version,
    pageNaming: mode ? { mode, fallback: pageNaming?.fallback === true, ...(pageNaming?.beatAnnotatorFallback !== undefined ? { beatAnnotatorFallback: pageNaming.beatAnnotatorFallback } : {}) } : null,
    createdAt: row.created_at
  };
}

/** 専用adopt APIがstatus/run identityを同じ応答で返すための単体ビュー。 */
export function getScriptMangaPlanCandidate(candidateId: string): ScriptMangaPlanCandidateView {
  return candidateView(requirePlanCandidate(candidateId));
}

/**
 * embedded候補を監督済みplanへ一度だけ固定する。full preflight成功時に本番候補へ反映し、
 * 以後のadoptが同じ成果物を使う。ページ/コマ/source/dialogue構造の変更は拒否する。
 */
export function freezeEmbeddedDirectedPlanCandidate(
  candidateId: string,
  expectedVersion: number,
  directedPlan: ScriptMangaPlan,
  direction: { inputHash: string; model: string | null }
): ScriptMangaPlanCandidateView {
  const row = requirePlanCandidate(candidateId);
  const provenance = parseCandidateProvenance(row);
  if (row.status !== "active") throw new HttpError(409, "Only an active candidate can freeze directed output");
  if (row.edit_version !== expectedVersion) {
    throw new HttpError(409, "Plan candidate was modified while its directed preflight was running");
  }
  if (provenance.origin === "external" || provenance.directorMode === "provided") {
    throw new HttpError(409, "Plan candidate direction is already fixed");
  }
  const effectivePlan = applyLayoutOverrides(parseCandidatePlan(row), parseOverrides(row));
  if (scriptMangaPlanStructureSignature(effectivePlan) !== scriptMangaPlanStructureSignature(directedPlan)) {
    throw new HttpError(422, "Directed candidate changed the fixed page/panel/source/dialogue structure");
  }
  const version = row.edit_version + 1;
  const updated = runSql(
    `UPDATE script_manga_plan_candidates
        SET plan_json = ?, provenance_json = ?, layout_overrides_json = NULL, edit_version = ?
      WHERE id = ? AND status = 'active' AND edit_version = ?`,
    [
      // customLayout は in-memory 注釈(custom_layouts_json が唯一の永続層)なので plan_json へ焼き込まない。
      JSON.stringify(stripCustomNameLayouts(directedPlan)),
      JSON.stringify({
        ...provenance,
        origin: "embedded",
        directorMode: "provided",
        direction,
        directionFrozenAt: new Date().toISOString()
      }),
      version,
      row.id,
      row.edit_version
    ]
  ) as { changes?: number };
  if (updated.changes !== 1) {
    throw new HttpError(409, "Plan candidate changed before directed output could be frozen");
  }
  return candidateView(requirePlanCandidate(candidateId));
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** ワイヤーフレーム用の共有情報(ビートkind辞書と台詞文字数)を組み立てる。 */
function candidateEnvelope(
  candidates: ScriptMangaPlanCandidateView[],
  scriptRevisionId: string | null,
  doc: FountainDoc | null
): ScriptMangaPlanCandidatesResponse {
  let beatKinds: Record<string, string> = {};
  const dialogueCharsByOrderIndex: number[] = [];
  if (doc) {
    const units = buildPreLayoutUnits(doc);
    for (const unit of units) {
      if (unit.dialogueOrderIndex !== undefined) dialogueCharsByOrderIndex[unit.dialogueOrderIndex] = unit.dialogueCharacters;
    }
    if (scriptRevisionId) {
      const cached = readCachedBeatAnnotation(scriptRevisionId, units);
      if (cached) beatKinds = Object.fromEntries(cached.map((beat) => [beat.id, beat.kind]));
    }
  }
  return { candidates, beatKinds, dialogueCharsByOrderIndex: [...dialogueCharsByOrderIndex].map((chars) => chars ?? 0) };
}

interface CandidateStoreInput {
  projectId: string;
  scriptId: string;
  scriptRevisionId: string;
  groupId: string;
  profile: string | null;
  temperature: number | null;
  plan: ScriptMangaPlan;
  provenance: PlanCandidateProvenance;
}

interface CandidateStoreResult {
  row: PlanCandidateRow;
  imported: boolean;
  duplicateOf: string | null;
}

function resolveCandidateGroupId(
  projectId: string,
  scriptId: string,
  scriptRevisionId: string,
  requestedGroupId: unknown
): string {
  const groupId = typeof requestedGroupId === "string" && requestedGroupId.trim()
    ? requestedGroupId.trim()
    : createId("cand_group");
  if (groupId.length > 200) throw new HttpError(400, "groupId is too long");
  const existing = getRows<{
    project_id: string;
    script_id: string;
    script_revision_id: string;
  }>(
    `SELECT DISTINCT project_id, script_id, script_revision_id
       FROM script_manga_plan_candidates WHERE group_id = ?`,
    [groupId]
  );
  if (existing.some((row) =>
    row.project_id !== projectId || row.script_id !== scriptId || row.script_revision_id !== scriptRevisionId
  )) {
    throw new HttpError(409, "groupId belongs to another project, script, or script revision");
  }
  return groupId;
}

function structurallyDuplicateCandidate(input: CandidateStoreInput): PlanCandidateRow | null {
  const signature = scriptMangaPlanStructureSignature(input.plan);
  const rows = getRows<PlanCandidateRow>(
    `SELECT * FROM script_manga_plan_candidates
      WHERE project_id = ? AND script_id = ? AND script_revision_id = ? AND group_id = ? AND status != 'archived'
      ORDER BY created_at ASC, id ASC`,
    [input.projectId, input.scriptId, input.scriptRevisionId, input.groupId]
  );
  return rows.find((row) =>
    scriptMangaPlanStructureSignature(parseCandidatePlan(row), parseOverrides(row)) === signature
  ) ?? null;
}

/**
 * 全候補経路で使う構造dedup。embedded生成はduplicateを残さず、外部importは同じactive行を
 * 演出済みplanへupsertしてcandidate id/deep linkを安定させる。
 */
function storeCandidate(input: CandidateStoreInput, duplicateMode: "skip" | "upsert"): CandidateStoreResult {
  // embedded生成はLLM awaitを跨ぐため、caller指定groupのownerをINSERT直前にも再検証する。
  resolveCandidateGroupId(input.projectId, input.scriptId, input.scriptRevisionId, input.groupId);
  const duplicate = structurallyDuplicateCandidate(input);
  if (duplicate) {
    if (duplicateMode === "skip") {
      return { row: duplicate, imported: false, duplicateOf: duplicate.id };
    }
    if (duplicate.status !== "active") {
      throw new HttpError(409, "A structurally identical candidate is already being adopted or adopted");
    }
    const existingProvenance = parseCandidateProvenance(duplicate);
    const existingOverrides = parseOverrides(duplicate);
    const isIdenticalReplay =
      duplicate.profile === input.profile &&
      duplicate.temperature === input.temperature &&
      JSON.stringify(parseCandidatePlan(duplicate)) === JSON.stringify(input.plan) &&
      JSON.stringify(existingProvenance) === JSON.stringify(input.provenance) &&
      Object.keys(existingOverrides).length === 0;
    if (isIdenticalReplay) {
      return { row: duplicate, imported: false, duplicateOf: duplicate.id };
    }
    runSql(
      `UPDATE script_manga_plan_candidates
          SET profile = ?, temperature = ?, plan_json = ?, provenance_json = ?,
              layout_overrides_json = NULL, custom_layouts_json = NULL, balloon_hints_json = NULL,
              edit_version = edit_version + 1
        WHERE id = ? AND status = 'active'`,
      [
        input.profile,
        input.temperature,
        JSON.stringify(input.plan),
        JSON.stringify(input.provenance),
        duplicate.id
      ]
    );
    return { row: requirePlanCandidate(duplicate.id), imported: false, duplicateOf: duplicate.id };
  }
  const id = createId("plan_cand");
  runSql(
    `INSERT INTO script_manga_plan_candidates
       (id, project_id, script_id, script_revision_id, group_id, profile, temperature, plan_json, provenance_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      id,
      input.projectId,
      input.scriptId,
      input.scriptRevisionId,
      input.groupId,
      input.profile,
      input.temperature,
      JSON.stringify(input.plan),
      JSON.stringify(input.provenance)
    ]
  );
  return { row: requirePlanCandidate(id), imported: true, duplicateOf: null };
}

function optionalMetadata(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new HttpError(400, `${field} is too long`);
  return normalized || null;
}

/** validateProvidedScriptMangaPlanが正規化したplanへ、任意の注釈beat idだけ安全に戻す。 */
function preserveProvidedSourceBeatIds(plan: ScriptMangaPlan, raw: unknown): ScriptMangaPlan {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { pages?: unknown }).pages)) return plan;
  const rawPages = (raw as { pages: unknown[] }).pages;
  for (let pageIndex = 0; pageIndex < plan.pages.length; pageIndex += 1) {
    const rawPage = rawPages[pageIndex];
    if (!rawPage || typeof rawPage !== "object" || !Array.isArray((rawPage as { panels?: unknown }).panels)) continue;
    const rawPanels = (rawPage as { panels: unknown[] }).panels;
    for (let panelIndex = 0; panelIndex < plan.pages[pageIndex]!.panels.length; panelIndex += 1) {
      const rawPanel = rawPanels[panelIndex];
      if (!rawPanel || typeof rawPanel !== "object") continue;
      const rawIds = (rawPanel as { sourceBeatIds?: unknown }).sourceBeatIds;
      if (!Array.isArray(rawIds)) continue;
      const ids = rawIds.map((value) => typeof value === "string" ? value.trim() : "");
      if (ids.length > 0 && ids.every(Boolean) && new Set(ids).size === ids.length) {
        plan.pages[pageIndex]!.panels[panelIndex]!.sourceBeatIds = ids;
      }
    }
  }
  return plan;
}

/** 外部agentの演出済みplanを、明示されたlatest revisionのName Studio groupへimportする。 */
export function importScriptMangaPlanCandidate(
  projectId: string,
  body: unknown
): ImportScriptMangaPlanCandidateResponse {
  const input = objectBody(body) as Partial<ImportScriptMangaPlanCandidateRequest> & Record<string, unknown>;
  const scriptId = requiredString(input.scriptId, "scriptId");
  const scriptRevisionId = requiredString(input.scriptRevisionId, "scriptRevisionId");
  requireScript(projectId, scriptId);
  const revision = latestRevision(scriptId);
  if (revision.id !== scriptRevisionId) {
    throw new HttpError(409, "scriptRevisionId is not the script's latest fixed revision");
  }
  const groupId = resolveCandidateGroupId(projectId, scriptId, scriptRevisionId, input.groupId);
  const validated = validateProvidedScriptMangaPlan(
    revision.doc,
    input.plan,
    (layoutTemplateId) => resolveLayoutTemplate(layoutTemplateId)?.panels.length ?? null
  );
  if (!validated) {
    throw new HttpError(422, "External plan is invalid or does not preserve every dialogue exactly once");
  }
  const plan = preserveProvidedSourceBeatIds(validated, input.plan);
  if (!plan.pages.every((page) => page.panels.every((panel) => panel.direction))) {
    throw new HttpError(422, "External directed candidates must provide structured direction for every panel");
  }
  const profile = optionalMetadata(input.profile, "profile", 80);
  const agent = optionalMetadata(input.agent, "agent", 160);
  const model = optionalMetadata(input.model, "model", 240);
  const notes = optionalMetadata(input.notes, "notes", 2000);
  const external = {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(notes ? { notes } : {})
  };
  const stored = storeCandidate({
    projectId,
    scriptId,
    scriptRevisionId,
    groupId,
    profile,
    temperature: null,
    plan,
    provenance: {
      origin: "external",
      directorMode: "provided",
      ...(profile ? { profile } : {}),
      ...(Object.keys(external).length > 0 ? { external } : {})
    }
  }, "upsert");
  return {
    candidate: candidateView(stored.row),
    imported: stored.imported,
    duplicateOf: stored.duplicateOf
  };
}

/** 候補一覧(最新 revision かつ非 archived のみ。stale 候補は採用できないため出さない)。 */
export function listScriptMangaPlanCandidates(projectId: string, scriptId: string): ScriptMangaPlanCandidatesResponse {
  requireScript(projectId, scriptId);
  const revision = latestRevision(scriptId);
  const rows = getRows<PlanCandidateRow>(
    `SELECT * FROM script_manga_plan_candidates
     WHERE project_id = ? AND script_id = ? AND script_revision_id = ? AND status != 'archived'
     ORDER BY created_at ASC, id ASC`,
    [projectId, scriptId, revision.id]
  );
  return candidateEnvelope(rows.map(candidateView), revision.id, revision.doc);
}

/** 候補生成: ビート注釈(キャッシュ利用)+ N1 × count。1候補あたり LLM 呼び出しは N1 の1回。 */
export async function createScriptMangaPlanCandidates(
  projectId: string,
  body: unknown
): Promise<ScriptMangaPlanCandidatesResponse> {
  const input = objectBody(body) as Partial<CreateScriptMangaPlanCandidatesRequest> & Record<string, unknown>;
  const scriptId = requiredString(input.scriptId, "scriptId");
  requireScript(projectId, scriptId);
  const revision = latestRevision(scriptId);
  const count = Math.max(1, Math.min(6, Math.trunc(typeof input.count === "number" ? input.count : 3)));
  const groupId = resolveCandidateGroupId(projectId, scriptId, revision.id, input.groupId);
  const profiles = Array.isArray(input.profiles)
    ? input.profiles.filter((profile): profile is string => typeof profile === "string" && profile in PROFILE_INSTRUCTIONS)
    : [];
  const planOptions: ScriptMangaPlanOptions = {
    scriptRevisionId: revision.id,
    targetPageCount: typeof input.targetPageCount === "number" && input.targetPageCount > 0
      ? Math.min(200, Math.trunc(input.targetPageCount))
      : undefined,
    panelsPerPage: typeof input.panelsPerPage === "number"
      ? Math.max(1, Math.min(6, Math.trunc(input.panelsPerPage)))
      : undefined,
    maxDialoguesPerPanel: typeof input.maxDialoguesPerPanel === "number"
      ? Math.max(1, Math.min(8, Math.trunc(input.maxDialoguesPerPanel)))
      : undefined
  };
  const existingCount = getRow<{ count: number }>(
    "SELECT COUNT(*) AS count FROM script_manga_plan_candidates WHERE group_id = ?",
    [groupId]
  )?.count ?? 0;
  const created: ScriptMangaPlanCandidateView[] = [];
  for (let index = 0; index < count; index += 1) {
    const serial = existingCount + index;
    const profile = profiles.length > 0 ? profiles[index % profiles.length]! : DEFAULT_PROFILE_CYCLE[serial % DEFAULT_PROFILE_CYCLE.length]!;
    const temperature = Math.round((0.2 + (serial % 4) * 0.15) * 100) / 100;
    const n1 = await generateScriptMangaN1Plan(revision.doc, planOptions, {
      temperature,
      profileInstruction: PROFILE_INSTRUCTIONS[profile]
    });
    if (latestRevision(scriptId).id !== revision.id) {
      throw new HttpError(409, "Script revision changed while plan candidates were being generated; retry on the latest revision");
    }
    const stored = storeCandidate({
      projectId,
      scriptId,
      scriptRevisionId: revision.id,
      groupId,
      profile,
      temperature,
      plan: n1.plan,
      provenance: {
        origin: "embedded",
        directorMode: "embedded",
        pageNaming: n1.pageNaming,
        profile,
        temperature
      }
    }, "skip");
    if (stored.imported) created.push(candidateView(stored.row));
  }
  return candidateEnvelope(created, revision.id, revision.doc);
}

/** 候補の破棄(archive)。採用済みは破棄できるが履歴(adopted_run_id)は残る。 */
export function archiveScriptMangaPlanCandidate(candidateId: string): { archived: true; id: string } {
  const row = requirePlanCandidate(candidateId);
  if (row.status === "adopting") {
    throw new HttpError(409, "Candidate is currently being adopted and cannot be archived");
  }
  runSql("UPDATE script_manga_plan_candidates SET status = 'archived' WHERE id = ?", [row.id]);
  return { archived: true, id: row.id };
}

/**
 * 採用処理(createScriptMangaRun から呼ぶ): 候補の検証と**実効プラン**(基礎プラン+人間の
 * レイアウト選択)の取り出し。expectedVersion 指定時は楽観ロック検査も行う(V5 D5)。
 */
export function adoptablePlanCandidate(
  candidateId: string,
  projectId: string,
  scriptId: string,
  latestRevisionId: string,
  expectedVersion?: number
): {
  row: PlanCandidateRow;
  plan: ScriptMangaPlan;
  customLayouts: Record<number, PageLayout>;
  balloonHints: Record<number, Record<number, { x: number; y: number }>>;
} {
  const row = requirePlanCandidate(candidateId);
  if (row.project_id !== projectId || row.script_id !== scriptId) {
    throw new HttpError(404, "Plan candidate does not belong to this script");
  }
  if (row.status === "archived") throw new HttpError(409, "Archived plan candidates cannot be adopted");
  if (row.status === "adopting") throw new HttpError(409, "Plan candidate is already being adopted");
  if (row.script_revision_id !== latestRevisionId) {
    throw new HttpError(409, "Plan candidate was made for an older script revision; regenerate candidates");
  }
  if (expectedVersion !== undefined && expectedVersion !== row.edit_version) {
    throw new HttpError(409, "Plan candidate was modified concurrently; reload and retry");
  }
  const customLayouts = parseCandidateCustomLayouts(row);
  return {
    row,
    plan: applyCustomNameLayouts(applyLayoutOverrides(parseCandidatePlan(row), parseOverrides(row)), customLayouts),
    customLayouts,
    balloonHints: parseCandidateBalloonHints(row)
  };
}

/**
 * 採用ウィンドウの開始(V5 D5)。採用は監督LLM実行を挟んで数分かかるため、この間の
 * set-layout を 409 にして「受理されたように見えて run に反映されない」lost update を防ぐ。
 */
export function beginPlanCandidateAdoption(candidateId: string): void {
  const claimed = runSql(
    "UPDATE script_manga_plan_candidates SET status = 'adopting' WHERE id = ? AND status = 'active'",
    [candidateId]
  ) as { changes?: number };
  if (claimed.changes !== 1) {
    throw new HttpError(409, "Plan candidate is no longer active for adoption");
  }
}

/** 採用失敗時の巻き戻し(adopting → active)。 */
export function revertPlanCandidateAdoption(candidateId: string): void {
  runSql("UPDATE script_manga_plan_candidates SET status = 'active' WHERE id = ? AND status = 'adopting'", [candidateId]);
}

/** 採用成立の記録(run 作成成功後に呼ぶ)。 */
export function markPlanCandidateAdopted(candidateId: string, runId: string): void {
  const completed = runSql(
    `UPDATE script_manga_plan_candidates SET status = 'adopted', adopted_run_id = ?
      WHERE id = ? AND status = 'adopting'`,
    [runId, candidateId]
  ) as { changes?: number };
  if (completed.changes !== 1) {
    throw new HttpError(409, "Plan candidate adoption claim was lost before completion");
  }
}

/**
 * ページ別レイアウトフリップ(V5 D5、本計画唯一の新エンドポイント)。基礎プランは不変で、
 * 人間の選択は layout_overrides_json に版数つきで持つ(undo/リセット・競合検出・選好ログ)。
 */
export function setCandidateLayoutOverride(candidateId: string, body: unknown): SetCandidateLayoutResponse {
  const input = objectBody(body);
  const row = requirePlanCandidate(candidateId);
  if (row.status === "archived") throw new HttpError(409, "Archived plan candidates cannot be edited");
  if (row.status === "adopting" || row.status === "adopted") {
    throw new HttpError(409, "Candidate is being adopted or already adopted; the layout can no longer change");
  }
  const revision = latestRevision(row.script_id);
  if (row.script_revision_id !== revision.id) {
    throw new HttpError(409, "Plan candidate was made for an older script revision; regenerate candidates");
  }
  const pageIndex = typeof input.pageIndex === "number" && Number.isInteger(input.pageIndex) && input.pageIndex >= 0
    ? input.pageIndex
    : null;
  if (pageIndex === null) throw new HttpError(400, "pageIndex must be a non-negative integer");
  const layoutTemplateId = requiredString(input.layoutTemplateId, "layoutTemplateId");
  if (typeof input.expectedVersion !== "number" || !Number.isInteger(input.expectedVersion)) {
    throw new HttpError(400, "expectedVersion is required (optimistic lock)");
  }
  if (input.expectedVersion !== row.edit_version) {
    throw new HttpError(409, "Plan candidate was modified concurrently; reload and retry");
  }
  const basePlan = parseCandidatePlan(row);
  const page = basePlan.pages.find((candidatePage) => candidatePage.index === pageIndex);
  if (!page) throw new HttpError(400, "pageIndex is out of range");
  const layout = resolveScriptMangaLayout(layoutTemplateId);
  if (!layout) throw new HttpError(422, `Layout template could not be resolved: ${layoutTemplateId}`);
  if (layout.panels.length !== page.panels.length) {
    throw new HttpError(400, "Layout panel count does not match the page");
  }
  // 実現可能性(hard constraint)検査: 台詞収容の絶対下限・figureスロットの要不要。
  const units = buildPreLayoutUnits(revision.doc);
  const charsByOrder: number[] = [];
  for (const unit of units) {
    if (unit.dialogueOrderIndex !== undefined) charsByOrder[unit.dialogueOrderIndex] = unit.dialogueCharacters;
  }
  const demands = page.panels.map((panel) => buildPanelDemand({
    visualScale: panel.visualScale,
    totalCharacters: panel.dialogueOrderIndexes.reduce((sum, orderIndex) => sum + (charsByOrder[orderIndex] ?? 0), 0),
    balloonCount: panel.dialogueOrderIndexes.length
  }));
  const ranked = rankLayouts(demands, { candidateIds: [layoutTemplateId] });
  if (ranked.length === 0 || ranked[0]!.hardViolations.length > 0) {
    throw new HttpError(422, "Layout is not feasible for this page (capacity/figure constraints)");
  }
  const overrides = parseOverrides(row);
  if (layoutTemplateId === page.layoutTemplateId) {
    delete overrides[pageIndex]; // 基礎プランと同じ選択 = リセット(元のLLM案へ戻す)
  } else {
    overrides[pageIndex] = layoutTemplateId;
  }
  // テンプレを切り替えたページのコマ割り修正・吹き出しヒントは旧テンプレ基準なので破棄する。
  const customLayouts = parseCandidateCustomLayouts(row);
  const balloonHints = parseCandidateBalloonHints(row);
  delete customLayouts[pageIndex];
  delete balloonHints[pageIndex];
  const version = row.edit_version + 1;
  runSql(
    `UPDATE script_manga_plan_candidates
        SET layout_overrides_json = ?, custom_layouts_json = ?, balloon_hints_json = ?, edit_version = ?
      WHERE id = ? AND edit_version = ?`,
    [
      Object.keys(overrides).length > 0 ? JSON.stringify(overrides) : null,
      Object.keys(customLayouts).length > 0 ? JSON.stringify(customLayouts) : null,
      Object.keys(balloonHints).length > 0 ? JSON.stringify(balloonHints) : null,
      version,
      row.id,
      row.edit_version
    ]
  );
  return { version, candidate: candidateView(requirePlanCandidate(row.id)) };
}

/**
 * 人間ゲートのコマ割り修正の保存(set-custom-layout)。編集済みレイアウトはテンプレ選択
 * (set-layout)より優先される別レイヤーとして pageIndex 毎に持ち、基礎プランは不変のまま。
 * `layout`/`balloonHints` は undefined=変更しない / null=削除 / 値=置き換え の三値。
 */
export function setCandidateCustomLayout(candidateId: string, body: unknown): SetCandidateCustomLayoutResponse {
  const input = objectBody(body) as Partial<SetCandidateCustomLayoutRequest> & Record<string, unknown>;
  const row = requirePlanCandidate(candidateId);
  if (row.status === "archived") throw new HttpError(409, "Archived plan candidates cannot be edited");
  if (row.status === "adopting" || row.status === "adopted") {
    throw new HttpError(409, "Candidate is being adopted or already adopted; the layout can no longer change");
  }
  const revision = latestRevision(row.script_id);
  if (row.script_revision_id !== revision.id) {
    throw new HttpError(409, "Plan candidate was made for an older script revision; regenerate candidates");
  }
  const pageIndex = typeof input.pageIndex === "number" && Number.isInteger(input.pageIndex) && input.pageIndex >= 0
    ? input.pageIndex
    : null;
  if (pageIndex === null) throw new HttpError(400, "pageIndex must be a non-negative integer");
  if (typeof input.expectedVersion !== "number" || !Number.isInteger(input.expectedVersion)) {
    throw new HttpError(400, "expectedVersion is required (optimistic lock)");
  }
  if (input.expectedVersion !== row.edit_version) {
    throw new HttpError(409, "Plan candidate was modified concurrently; reload and retry");
  }
  const basePlan = parseCandidatePlan(row);
  const overrides = parseOverrides(row);
  const page = basePlan.pages.find((candidatePage) => candidatePage.index === pageIndex);
  if (!page) throw new HttpError(400, "pageIndex is out of range");
  if (input.layout === undefined && input.balloonHints === undefined) {
    throw new HttpError(400, "layout or balloonHints is required");
  }

  const customLayouts = parseCandidateCustomLayouts(row);
  if (input.layout !== undefined) {
    if (input.layout === null) {
      delete customLayouts[pageIndex];
    } else {
      const edited = normalizeEditedPageLayout(input.layout);
      if (!edited) throw new HttpError(400, "layout is not a valid PageLayout");
      // 検証の基準は「そのページの現在の実効テンプレレイアウト」(編集セッションの開始点)。
      const baseTemplateId = overrides[pageIndex] ?? page.layoutTemplateId;
      const baseLayout = resolveScriptMangaLayout(baseTemplateId);
      if (!baseLayout) throw new HttpError(422, `Layout template could not be resolved: ${baseTemplateId}`);
      if (baseLayout.panels.length !== page.panels.length) {
        throw new HttpError(422, "Base layout panel count does not match the page");
      }
      const validation = validateEditedNameLayout(edited, toEditableNameLayout(baseLayout));
      if (!validation.ok) {
        throw new HttpError(422, `編集済みコマ割りが検証に通りません: ${validation.issues.map((issue) => issue.message).join(" / ")}`);
      }
      customLayouts[pageIndex] = edited;
    }
  }

  const balloonHints = parseCandidateBalloonHints(row);
  if (input.balloonHints !== undefined) {
    if (input.balloonHints === null) {
      delete balloonHints[pageIndex];
    } else {
      if (typeof input.balloonHints !== "object") throw new HttpError(400, "balloonHints must be an object");
      const pageOrderIndexes = new Set(page.panels.flatMap((panel) => panel.dialogueOrderIndexes));
      const pageHints: Record<number, { x: number; y: number }> = {};
      for (const [orderKey, position] of Object.entries(input.balloonHints as Record<string, unknown>)) {
        const orderIndex = Number(orderKey);
        if (!Number.isInteger(orderIndex) || !pageOrderIndexes.has(orderIndex)) {
          throw new HttpError(400, `balloonHints key ${orderKey} is not a dialogue orderIndex on page ${pageIndex + 1}`);
        }
        const { x, y } = (position ?? {}) as { x?: unknown; y?: unknown };
        if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
          throw new HttpError(400, `balloonHints[${orderKey}] must be a finite {x, y}`);
        }
        pageHints[orderIndex] = { x, y };
      }
      if (Object.keys(pageHints).length > 0) balloonHints[pageIndex] = pageHints;
      else delete balloonHints[pageIndex];
    }
  }

  const version = row.edit_version + 1;
  runSql(
    `UPDATE script_manga_plan_candidates
        SET custom_layouts_json = ?, balloon_hints_json = ?, edit_version = ?
      WHERE id = ? AND edit_version = ?`,
    [
      Object.keys(customLayouts).length > 0 ? JSON.stringify(customLayouts) : null,
      Object.keys(balloonHints).length > 0 ? JSON.stringify(balloonHints) : null,
      version,
      row.id,
      row.edit_version
    ]
  );
  return { version, candidate: candidateView(requirePlanCandidate(row.id)) };
}
