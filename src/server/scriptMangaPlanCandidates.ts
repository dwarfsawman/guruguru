/**
 * プラン候補(ネームv4 D3)。候補 = N1結果(ページ割り+importance/turnHook+事前選択レイアウト)。
 * 「1呼び出しで複数案」はやらず、ビート注釈1回(キャッシュ共有)+N1をk回で候補を貯める。
 * 監督・画像生成は採用後に1回だけ(createScriptMangaRun の planCandidateId ルート)。
 */
import type { FountainDoc } from "../shared/fountain";
import type {
  CreateScriptMangaPlanCandidatesRequest,
  ScriptMangaPlanCandidatesResponse,
  ScriptMangaPlanCandidateView
} from "../shared/scriptMangaApi";
import { normalizeScriptMangaPlanScales, type ScriptMangaPlan, type ScriptMangaPlanOptions } from "../shared/scriptMangaPlan";
import { buildPreLayoutUnits } from "../shared/preLayoutBeat";
import { createId, getRow, getRows, runSql } from "./db";
import { HttpError } from "./http";
import { objectBody, requiredString } from "./validate";
import { readCachedBeatAnnotation } from "./scriptBeatAnnotator";
import { generateScriptMangaN1Plan } from "./scriptMangaDirector";

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
  created_at: string;
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

function candidateView(row: PlanCandidateRow): ScriptMangaPlanCandidateView {
  const provenance = row.provenance_json ? safeParse(row.provenance_json) : null;
  const pageNaming = provenance && typeof provenance === "object" && provenance !== null
    ? (provenance as { pageNaming?: { mode?: string; fallback?: boolean; beatAnnotatorFallback?: boolean } }).pageNaming
    : undefined;
  const mode = pageNaming?.mode === "beats" || pageNaming?.mode === "panels" || pageNaming?.mode === "deterministic"
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
    status: row.status === "adopted" || row.status === "archived" ? row.status : "active",
    adoptedRunId: row.adopted_run_id,
    plan: parseCandidatePlan(row),
    pageNaming: mode ? { mode, fallback: pageNaming?.fallback === true, ...(pageNaming?.beatAnnotatorFallback !== undefined ? { beatAnnotatorFallback: pageNaming.beatAnnotatorFallback } : {}) } : null,
    createdAt: row.created_at
  };
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
  let groupId = typeof input.groupId === "string" && input.groupId.trim() ? input.groupId.trim() : null;
  if (groupId) {
    const existing = getRow<{ script_id: string }>(
      "SELECT script_id FROM script_manga_plan_candidates WHERE group_id = ? LIMIT 1",
      [groupId]
    );
    if (existing && existing.script_id !== scriptId) throw new HttpError(400, "groupId belongs to another script");
  } else {
    groupId = createId("cand_group");
  }
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
  let deterministicStored = existingCount > 0
    ? Boolean(getRow(
        "SELECT id FROM script_manga_plan_candidates WHERE group_id = ? AND json_extract(provenance_json, '$.pageNaming.mode') = 'deterministic'",
        [groupId]
      ))
    : false;
  for (let index = 0; index < count; index += 1) {
    const serial = existingCount + index;
    const profile = profiles.length > 0 ? profiles[index % profiles.length]! : DEFAULT_PROFILE_CYCLE[serial % DEFAULT_PROFILE_CYCLE.length]!;
    const temperature = Math.round((0.2 + (serial % 4) * 0.15) * 100) / 100;
    const n1 = await generateScriptMangaN1Plan(revision.doc, planOptions, {
      temperature,
      profileInstruction: PROFILE_INSTRUCTIONS[profile]
    });
    if (n1.pageNaming.mode === "deterministic") {
      // LLM全滅時は全候補が同一の決定的プランになる。グループに1つだけ残す。
      if (deterministicStored) continue;
      deterministicStored = true;
    }
    const id = createId("plan_cand");
    runSql(
      `INSERT INTO script_manga_plan_candidates
         (id, project_id, script_id, script_revision_id, group_id, profile, temperature, plan_json, provenance_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        id, projectId, scriptId, revision.id, groupId,
        profile, temperature,
        JSON.stringify(n1.plan),
        JSON.stringify({ pageNaming: n1.pageNaming, profile, temperature })
      ]
    );
    created.push(candidateView(requirePlanCandidate(id)));
  }
  return candidateEnvelope(created, revision.id, revision.doc);
}

/** 候補の破棄(archive)。採用済みは破棄できるが履歴(adopted_run_id)は残る。 */
export function archiveScriptMangaPlanCandidate(candidateId: string): { archived: true; id: string } {
  const row = requirePlanCandidate(candidateId);
  runSql("UPDATE script_manga_plan_candidates SET status = 'archived' WHERE id = ?", [row.id]);
  return { archived: true, id: row.id };
}

/** 採用処理(createScriptMangaRun から呼ぶ): 候補の検証と plan の取り出し。 */
export function adoptablePlanCandidate(
  candidateId: string,
  projectId: string,
  scriptId: string,
  latestRevisionId: string
): { row: PlanCandidateRow; plan: ScriptMangaPlan } {
  const row = requirePlanCandidate(candidateId);
  if (row.project_id !== projectId || row.script_id !== scriptId) {
    throw new HttpError(404, "Plan candidate does not belong to this script");
  }
  if (row.status === "archived") throw new HttpError(409, "Archived plan candidates cannot be adopted");
  if (row.script_revision_id !== latestRevisionId) {
    throw new HttpError(409, "Plan candidate was made for an older script revision; regenerate candidates");
  }
  return { row, plan: parseCandidatePlan(row) };
}

/** 採用成立の記録(run 作成成功後に呼ぶ)。 */
export function markPlanCandidateAdopted(candidateId: string, runId: string): void {
  runSql(
    "UPDATE script_manga_plan_candidates SET status = 'adopted', adopted_run_id = ? WHERE id = ?",
    [runId, candidateId]
  );
}
