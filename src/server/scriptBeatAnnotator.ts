/**
 * LLM ビート注釈ステージ(ネームv4 D2)。N1 ページネームより前に走り、atomic unit 列を
 * 物語ビート(kind/importance/pageTurnAffinity/keepAlone/desiredScale)へ束ねる。
 *
 * - 検証は決定的(`validateBeatAnnotation`: 全 unit 一度ずつ・順序保存・シーン純度・enum)。
 * - 成功結果は script revision 単位で `script_beat_annotations` へキャッシュする(D3 の
 *   候補複数生成でも注釈は1回)。フォールバック(1要素=1ビート)はキャッシュしない。
 * - LLM 失敗時は決定的フォールバックへ倒し、生成は止めない。
 */
import type { FountainDoc } from "../shared/fountain";
import {
  type AnnotatedBeat,
  BEAT_KINDS,
  BEAT_SCALES,
  buildPreLayoutUnits,
  fallbackBeatAnnotation,
  type PreLayoutUnit,
  validateBeatAnnotation
} from "../shared/preLayoutBeat";
import { createId, getRow, runSql } from "./db";
import { getLlmSettings } from "./llm";
import { generateStructuredJson } from "./llmStructured";

export const BEAT_ANNOTATOR_VERSION = "beat-annotator-v1";

export interface BeatAnnotationResult {
  units: PreLayoutUnit[];
  beats: AnnotatedBeat[];
  /** true = LLM 不通/検証失敗による決定的フォールバック(キャッシュされない)。 */
  fallback: boolean;
  /** キャッシュヒット(このプロセスで LLM を呼んでいない)。 */
  cached: boolean;
  provenance?: { model: string; rawOutput: string; messages: Array<{ role: string; content: string }> };
}

export const BEAT_ANNOTATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["beats"],
  properties: {
    beats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "unitIds", "kind", "importance", "pageTurnAffinity", "keepAlone", "desiredScale"],
        properties: {
          id: { type: "string" },
          unitIds: { type: "array", minItems: 1, items: { type: "string" } },
          kind: { type: "string", enum: [...BEAT_KINDS] },
          importance: { type: "number", minimum: 0, maximum: 1 },
          pageTurnAffinity: { type: "number", minimum: 0, maximum: 1 },
          keepAlone: { type: "boolean" },
          desiredScale: { type: "string", enum: [...BEAT_SCALES] }
        }
      }
    }
  }
} as const;

interface AnnotationRow {
  beats_json: string;
}

/** 保存済み注釈をそのまま返す(unit 整合が崩れていれば null = キャッシュ不成立)。 */
export function readCachedBeatAnnotation(scriptRevisionId: string, units: readonly PreLayoutUnit[]): AnnotatedBeat[] | null {
  const row = getRow<AnnotationRow>(
    "SELECT beats_json FROM script_beat_annotations WHERE script_revision_id = ? AND annotator_version = ?",
    [scriptRevisionId, BEAT_ANNOTATOR_VERSION]
  );
  if (!row) return null;
  try {
    return validateBeatAnnotation({ beats: JSON.parse(row.beats_json) }, units);
  } catch {
    return null;
  }
}

export function persistBeatAnnotation(
  scriptRevisionId: string,
  beats: AnnotatedBeat[],
  provenance: unknown
): void {
  runSql(
    `INSERT INTO script_beat_annotations (id, script_revision_id, annotator_version, beats_json, provenance_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (script_revision_id, annotator_version)
       DO UPDATE SET beats_json = excluded.beats_json, provenance_json = excluded.provenance_json`,
    [createId("beat_ann"), scriptRevisionId, BEAT_ANNOTATOR_VERSION, JSON.stringify(beats), JSON.stringify(provenance ?? null)]
  );
}

function compactUnits(units: readonly PreLayoutUnit[]): Array<Record<string, unknown>> {
  return units.map((unit) => ({
    id: unit.id,
    scene: unit.sceneIndex,
    type: unit.type,
    ...(unit.speaker ? { speaker: unit.speaker } : {}),
    text: unit.text.length > 160 ? `${unit.text.slice(0, 160)}…` : unit.text,
    ...(unit.dialogueCharacters > 0 ? { dialogueChars: unit.dialogueCharacters } : {})
  }));
}

const ANNOTATOR_SYSTEM_PROMPT = [
  "You are a manga story-beat annotator. Group the given atomic units into narrative beats before any panel layout exists.",
  "Rules: cover every unitId exactly once, keep the original order, and never mix units from different scenes in one beat.",
  "kind: setup(context), action(someone does something), reaction(a character responds), reveal(new information lands), decision(a choice is made), transition(time/place shift), pause(a breath, mood).",
  "importance: 0..1 story weight — be sparing above 0.7. pageTurnAffinity: 0..1 desire to sit right before/after a page turn (high for reveals and cliffhanger-worthy actions).",
  "keepAlone: true when the beat deserves its own panel. desiredScale: small/normal/hero/splash — hero and splash are rare peaks.",
  "Prefer beats of 1-3 units. A beat is one dramatic moment, not a summary."
].join("\n");

/**
 * ビート注釈を取得する(キャッシュ → LLM → 決定的フォールバックの順)。
 * scriptRevisionId が無い場合はキャッシュを使わない(テスト・アドホック呼び出し)。
 */
export async function annotateScriptBeats(doc: FountainDoc, scriptRevisionId?: string): Promise<BeatAnnotationResult> {
  const units = buildPreLayoutUnits(doc);
  if (units.length === 0) {
    return { units, beats: [], fallback: false, cached: false };
  }
  if (scriptRevisionId) {
    const cached = readCachedBeatAnnotation(scriptRevisionId, units);
    if (cached) return { units, beats: cached, fallback: false, cached: true };
  }
  const settings = getLlmSettings();
  try {
    const scenes = doc.scenes.map((scene, index) => ({ index, heading: scene.heading }));
    const result = await generateStructuredJson<AnnotatedBeat[]>({
      settings,
      systemPrompt: ANNOTATOR_SYSTEM_PROMPT,
      userPrompt: `Scenes: ${JSON.stringify(scenes)}\nUnits (in order): ${JSON.stringify(compactUnits(units))}`,
      schema: BEAT_ANNOTATION_SCHEMA,
      validate: (raw) => validateBeatAnnotation(raw, units),
      temperature: 0.2,
      timeoutMs: 180000
    });
    const provenance = { model: settings.model, rawOutput: result.rawOutput, messages: result.messages };
    if (scriptRevisionId) persistBeatAnnotation(scriptRevisionId, result.value, provenance);
    return { units, beats: result.value, fallback: false, cached: false, provenance };
  } catch (error) {
    return {
      units,
      beats: fallbackBeatAnnotation(units),
      fallback: true,
      cached: false,
      provenance: {
        model: settings.model,
        rawOutput: error instanceof Error ? error.message : String(error),
        messages: []
      }
    };
  }
}
