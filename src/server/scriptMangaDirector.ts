import type { FountainDoc } from "../shared/fountain";
import { deriveSceneBibles } from "./storyGraphBuilder";
import { describeScriptMangaLayouts } from "../shared/layoutPresets";
import {
  DEFAULT_MAX_DIALOGUES_PER_PANEL,
  planScriptManga,
  type ScriptMangaPagePlan,
  type ScriptMangaPanelDirection,
  type ScriptMangaPlan,
  type ScriptMangaPlanOptions
} from "../shared/scriptMangaPlan";
import { generateStructuredJson } from "./llmStructured";
import { getLlmSettings } from "./llm";
import {
  applyBeatPageNaming,
  createBeatPageNamingSchema,
  packAnnotatedBeatsDeterministically
} from "./scriptMangaPageNaming";
import { annotateScriptBeats, type BeatAnnotationResult } from "./scriptBeatAnnotator";

interface DirectedPanel {
  id: string;
  shot: string;
  angle: string;
  subjects: Array<{ ref: string; position: string; action: string; expression: string; gaze?: string }>;
  action: string;
  emotion: string;
  composition: string;
  prompt: string;
  avoid?: string[];
}

/** V5 X3: レイアウトは監督の出力から削除(人間/rankLayoutsが決めた値を監督は変更できない)。 */
interface DirectedPage {
  index: number;
  pageIntent: string;
  panels: DirectedPanel[];
}

interface DirectedBatch { pages: DirectedPage[] }

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["pages"],
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "pageIntent", "panels"],
        properties: {
          index: { type: "integer" },
          pageIntent: { type: "string" },
          panels: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "shot", "angle", "subjects", "action", "emotion", "composition", "prompt"],
              properties: {
                id: { type: "string" },
                shot: { type: "string", enum: ["extreme-wide", "wide", "full", "medium", "bust", "close-up", "extreme-close-up", "insert"] },
                angle: { type: "string", enum: ["eye-level", "low", "high", "overhead", "dutch", "pov"] },
                subjects: { type: "array", items: { type: "object", additionalProperties: false,
                  required: ["ref", "position", "action", "expression"], properties: {
                    ref: { type: "string" }, position: { type: "string", enum: ["upper-left", "upper-center", "upper-right", "middle-left", "middle-center", "middle-right", "lower-left", "lower-center", "lower-right"] },
                    action: { type: "string" }, expression: { type: "string" }, gaze: { type: "string" }
                  } } },
                action: { type: "string" }, emotion: { type: "string" }, composition: { type: "string" },
                prompt: { type: "string" }, avoid: { type: "array", maxItems: 8, items: { type: "string" } }
              }
            }
          }
        }
      }
    }
  }
} as const;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function directionFrom(panel: DirectedPanel): ScriptMangaPanelDirection {
  return {
    shot: panel.shot.trim(),
    angle: panel.angle.trim(),
    subject: panel.subjects.map((item) => item.ref).join(", "),
    subjects: panel.subjects,
    avoid: panel.avoid,
    action: panel.action.trim(),
    emotion: panel.emotion.trim(),
    composition: panel.composition.trim()
  };
}

const SHOTS = new Set(["extreme-wide", "wide", "full", "medium", "bust", "close-up", "extreme-close-up", "insert"]);
const ANGLES = new Set(["eye-level", "low", "high", "overhead", "dutch", "pov"]);
const POSITIONS = new Set(["upper-left", "upper-center", "upper-right", "middle-left", "middle-center", "middle-right", "lower-left", "lower-center", "lower-right"]);
const NON_ENGLISH_OR_NEGATION = /[\u3040-\u30ff\u3400-\u9fff]|\b(?:no|not|without|never)\b/iu;

export function validateDirectedMangaBatch(
  raw: unknown,
  sourcePages: ScriptMangaPagePlan[],
  entityNames: string[] = []
): DirectedBatch | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as DirectedBatch).pages)) return null;
  const pages = (raw as DirectedBatch).pages;
  if (pages.length !== sourcePages.length) return null;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const source = sourcePages[i];
    if (
      !page ||
      !source ||
      page.index !== source.index ||
      !nonEmpty(page.pageIntent) ||
      !Array.isArray(page.panels) ||
      page.panels.length !== source.panels.length
    ) return null;
    for (let p = 0; p < page.panels.length; p += 1) {
      const panel = page.panels[p];
      if (
        !panel ||
        panel.id !== source.panels[p]!.id ||
        !nonEmpty(panel.shot) ||
        !SHOTS.has(panel.shot) ||
        !ANGLES.has(panel.angle) ||
        !Array.isArray(panel.subjects) ||
        !nonEmpty(panel.action) ||
        !nonEmpty(panel.emotion) ||
        !nonEmpty(panel.composition) ||
        !nonEmpty(panel.prompt) || NON_ENGLISH_OR_NEGATION.test(panel.prompt)
      ) return null;
      for (const subject of panel.subjects) {
        if (!subject || !nonEmpty(subject.ref) || !POSITIONS.has(subject.position) || !nonEmpty(subject.action) || !nonEmpty(subject.expression)) return null;
        if (entityNames.length > 0 && !entityNames.includes(subject.ref)) return null;
      }
      if (panel.avoid !== undefined && (!Array.isArray(panel.avoid) || panel.avoid.length > 8 || panel.avoid.some((item) => !nonEmpty(item) || item.trim().split(/\s+/).length > 6 || NON_ENGLISH_OR_NEGATION.test(item)))) return null;
    }
  }
  return { pages };
}

/** LLM監督の構造化応答を検証し、元planの追跡情報を保ったまま演出を合成する純関数。 */
export function applyScriptMangaDirectorBatch(
  raw: unknown,
  sourcePages: ScriptMangaPagePlan[],
  stylePrompt?: string
): ScriptMangaPagePlan[] | null {
  const directed = validateDirectedMangaBatch(raw, sourcePages, []);
  if (!directed) return null;
  return sourcePages.map((source, pageIndex) => {
    const directedPage = directed.pages[pageIndex]!;
    return {
      ...source,
      // V5 X3: layoutTemplateId は source(人間/rankLayoutsの選択)のまま。監督は演出のみ。
      pageIntent: directedPage.pageIntent.trim(),
      panels: source.panels.map((panel, panelIndex) => {
        const directedPanel = directedPage.panels[panelIndex]!;
        return {
          ...panel,
          direction: directionFrom(directedPanel),
          prompt: directedPanel.prompt.trim()
        };
      })
    };
  });
}

function speakerNames(doc: FountainDoc): string[] {
  const names = new Set<string>();
  for (const scene of doc.scenes) for (const element of scene.elements) if (element.type === "dialogue") names.add(element.speaker);
  return [...names];
}

export function buildScriptMangaDirectorSystemPrompt(input: {
  fixedIdentity?: string;
  speakers?: string[];
} = {}): string {
  const fixedIdentity = input.fixedIdentity?.trim() ?? "";
  return [
    "あなたは商業漫画のネーム監督です。右綴じ・右から左へ読む日本漫画として、視線誘導と緩急を設計してください。",
    "各コマは一つの瞬間、一つの主行動だけに絞り、誰が何をしてどう感じているかが静止画だけで判別できるようにします。",
    "同じ画角を連続させず、導入はwide、反応はclose-up、決めはlow angle/splashなど意図的に変化させます。",
    "台詞本文はpromptへ転記せず、speech act、表情、身振り、視線、口の状態という視覚化可能な演出へ変換してください。",
    "This is naming contract v3.0. Use only the fixed shot, angle, and position enum values from the schema.",
    "Write prompt in English with panel-specific visual facts only. Never include appearance/style attributes, dialogue, non-English text, or the words no/not/without/never. Put exclusions in avoid as English noun phrases.",
    "Character names and aliases are narrative metadata only. Never copy them into visual-generation fields: prompt, action, emotion, composition, avoid, or any subjects[] string (ref, action, expression, gaze). Use neutral visual roles such as 'primary character', 'second character', 'foreground character', or 'background character' instead. Names may remain in pageIntent and other non-visual metadata.",
    "Layout ids containing 'bleed' extend panels past the page edge (borderless art) — pick them for climactic, atmospheric, or montage pages instead of always using framed grids.",
    "Layouts with a figureSlot render that reading position as a borderless full-body character cut-out standing over the page (punch-out). Panels are mapped to layout slots in reading order, so the panel at that position becomes the figure: give it a single character-defining beat, set its subject to full body, and keep its dialogue minimal.",
    "Each page's layout is already decided and read-only (see the layout guide). Panels map to layout slots in reading order — direct each panel to fit its slot: visualScale=large panels sit on the biggest slots, so stage them as the page's visual peak.",
    "On pages with turnHook=reveal, stage the final panel as a tease and leave the disclosure to the next page's first panel. On turnHook=cliffhanger pages, end at peak tension mid-action.",
    fixedIdentity ? `以下のキャラクター固定票を一字も矛盾させないでください: ${fixedIdentity}` : "同名人物の髪型・服・年齢・体格は全コマで固定してください。",
    `登場話者: ${(input.speakers ?? []).join(", ")}`
  ].join("\n");
}

/** N1 の多様化オプション(ネームv4 D3: 候補生成が温度・プロファイルを振る)。 */
export interface ScriptMangaN1Options {
  temperature?: number;
  /** システムプロンプトへ1行追加する演出プロファイル指示(readability / cinematic / tempo)。 */
  profileInstruction?: string;
}

export interface ScriptMangaN1Result {
  plan: ScriptMangaPlan;
  /** ビート注釈(V5では空脚本の縮退を除き常に非null。V2 の beats 引き継ぎに使う)。 */
  beatAnnotation: BeatAnnotationResult | null;
  pageNaming: {
    /** V5 D2: beats=ビート化N1 / deterministic=決定的ビートパッカー(または空脚本の縮退)。 */
    mode: "beats" | "deterministic";
    rawOutput: string;
    messages: Array<{ role: string; content: string }>;
    fallback: boolean;
    beatAnnotatorFallback?: boolean;
  };
}

const N1_COMMON_PROMPT_LINES = [
  "Mark at most one or two panels per page as importance=hero (the page's visual peak); use importance=splash only for a full-page single-panel moment.",
  // ネームv4 D1: めくりパリティ(未決#1)はソフト指示に留める。右綴じ・表紙別で奇数indexがめくり直前になる想定。
  "Set turnHook=reveal or cliffhanger only on pages that end right before a physical page turn (assume odd page indexes in this right-bound book), and put the disclosure at the top of the next page."
];

function beatCompact(annotation: BeatAnnotationResult): Array<Record<string, unknown>> {
  const unitById = new Map(annotation.units.map((unit) => [unit.id, unit]));
  return annotation.beats.map((beat) => {
    const units = beat.unitIds.flatMap((unitId) => { const unit = unitById.get(unitId); return unit ? [unit] : []; });
    return {
      id: beat.id,
      kind: beat.kind,
      importance: beat.importance,
      pageTurnAffinity: beat.pageTurnAffinity,
      keepAlone: beat.keepAlone,
      desiredScale: beat.desiredScale,
      scene: units[0]?.sceneIndex ?? 0,
      units: units.map((unit) => ({
        type: unit.type,
        ...(unit.speaker ? { speaker: unit.speaker } : {}),
        text: unit.text.length > 120 ? `${unit.text.slice(0, 120)}…` : unit.text,
        ...(unit.dialogueCharacters > 0 ? { dialogueChars: unit.dialogueCharacters } : {})
      }))
    };
  });
}

/**
 * N1 ページネーム(V5 D2)。ビート注釈(キャッシュ付き)→ ビート化 N1 →
 * 失敗時は決定的ビートパッカー、の二段フォールバック。パッカーもビートを入力にするため、
 * どの経路でもビート情報(preferredScale/keepAlone)とシーン純度が保たれ、
 * 「全台詞一度ずつ」契約と ScriptMangaPlan の形は不変。
 */
export async function generateScriptMangaN1Plan(
  doc: FountainDoc,
  options: ScriptMangaPlanOptions = {},
  n1Options: ScriptMangaN1Options = {}
): Promise<ScriptMangaN1Result> {
  const settings = getLlmSettings();
  const maxPanelsPerPage = Math.max(1, Math.min(6, Math.trunc(options.panelsPerPage ?? 4)));
  const maxDialoguesPerPanel = Math.max(1, Math.min(8, Math.trunc(options.maxDialoguesPerPanel ?? DEFAULT_MAX_DIALOGUES_PER_PANEL)));
  const temperature = n1Options.temperature ?? 0.3;
  const profileLines = n1Options.profileInstruction?.trim() ? [n1Options.profileInstruction.trim()] : [];

  const annotation = await annotateScriptBeats(doc, options.scriptRevisionId);
  // 可視要素ゼロの縮退(units空 → beats空)。パッカーは空入力を扱わないので、
  // 旧決定的プランナーの空プラン挙動へそのまま倒す。
  if (annotation.beats.length === 0) {
    return {
      plan: planScriptManga(doc, options),
      beatAnnotation: null,
      pageNaming: { mode: "deterministic", rawOutput: "[empty-units]", messages: [], fallback: true }
    };
  }

  // V5 D2: ビート経路の既定値も units 由来にし、旧プランナーへの依存を断つ。
  const title = doc.titlePage.Title || "Manga";
  const packed = packAnnotatedBeatsDeterministically({
    units: annotation.units,
    beats: annotation.beats,
    title,
    stylePrompt: options.stylePrompt,
    targetPageCount: options.targetPageCount,
    maxPanelsPerPage,
    maxDialoguesPerPanel,
    maxDialogueCharactersPerPanel: options.maxSourceCharactersPerPanel
  });
  const targetPageCount = Math.max(1, Math.trunc(options.targetPageCount ?? Math.max(packed.pages.length, packed.dialogueCount / 5)));

  try {
    const named = await generateStructuredJson<ScriptMangaPlan>({
      settings,
      systemPrompt: [
        "You are the N1 manga page-naming editor. Build pages and panels from the annotated story beats.",
        "Cover every beat id exactly once and in order via panels[].sourceBeatIds. A panel usually bundles 1-3 consecutive beats; never mix scenes in one panel.",
        `Use 1-${maxPanelsPerPage} panels per page; this is a hard maximum. Splash means exactly one panel on its page.`,
        "Respect the annotations: give keepAlone beats their own panel; map preferredScale large/splash to panel importance hero/splash; put beats with high pageTurnAffinity at a page's final panel (tease) or a page's first panel (payoff).",
        `No panel may contain more than ${maxDialoguesPerPanel} scripted dialogue elements; this is not a rendered-balloon target.`,
        `Keep each panel's total dialogue below ${Math.max(40, Math.trunc(options.maxSourceCharactersPerPanel ?? 260))} characters.`,
        ...N1_COMMON_PROMPT_LINES,
        ...profileLines
      ].join("\n"),
      userPrompt: `Target page count: ${targetPageCount} (accepted range ±20%). Story beats (in order): ${JSON.stringify(beatCompact(annotation))}`,
      schema: createBeatPageNamingSchema(maxPanelsPerPage),
      validate: (raw) => applyBeatPageNaming(raw, {
        title,
        units: annotation.units,
        beats: annotation.beats,
        targetPageCount,
        stylePrompt: options.stylePrompt,
        maxDialogueCharactersPerPanel: options.maxSourceCharactersPerPanel,
        maxDialoguesPerPanel,
        maxPanelsPerPage
      }),
      temperature,
      timeoutMs: 180000
    });
    return {
      plan: named.value,
      beatAnnotation: annotation,
      pageNaming: {
        mode: "beats", rawOutput: named.rawOutput, messages: named.messages,
        fallback: false, beatAnnotatorFallback: annotation.fallback
      }
    };
  } catch (error) {
    // V5 D2: 最終フォールバックはビート入力の決定的パッカー(ビート情報を捨てない)。
    return {
      plan: packed,
      beatAnnotation: annotation,
      pageNaming: {
        mode: "deterministic",
        rawOutput: error instanceof Error ? error.message : String(error),
        messages: [],
        fallback: true,
        beatAnnotatorFallback: annotation.fallback
      }
    };
  }
}

/**
 * 決定的プランを安全網にしつつ、LLMを「ネーム監督」として画角・主役・感情・レイアウトを具体化する。
 * 台詞対応とページ/コマ数は変更させないため、全発話保持の既存保証は維持される。
 */
export async function planScriptMangaWithDirector(doc: FountainDoc, options: ScriptMangaPlanOptions = {}): Promise<ScriptMangaPlan> {
  return (await planScriptMangaWithDirectorDetailed(doc, options)).plan;
}

/** planScriptMangaWithDirector の詳細版: ビート注釈も返す(V2 の beats 引き継ぎ用)。 */
export async function planScriptMangaWithDirectorDetailed(
  doc: FountainDoc,
  options: ScriptMangaPlanOptions = {}
): Promise<{ plan: ScriptMangaPlan; beatAnnotation: BeatAnnotationResult | null }> {
  const settings = getLlmSettings();
  const n1 = await generateScriptMangaN1Plan(doc, options);
  const base = n1.plan;
  const directed = await directScriptMangaPages(doc, base.pages, options);
  return {
    plan: {
      ...base,
      pages: directed.pages,
      plannerProvenance: {
        kind: "llm-director",
        model: settings.model,
        batches: directed.batches,
        pageNaming: n1.pageNaming
      }
    },
    beatAnnotation: n1.beatAnnotation
  };
}

/**
 * 採用済みプラン候補へ監督を適用する。V5 X3: 監督スキーマにレイアウトが無いので、
 * 「採用後レイアウト不変」は構造的に保証される(旧 lockLayouts は不要になった)。
 */
export async function directAdoptedCandidatePlan(
  doc: FountainDoc,
  candidatePlan: ScriptMangaPlan,
  options: ScriptMangaPlanOptions = {}
): Promise<ScriptMangaPlan> {
  return (await directAdoptedCandidatePlanDetailed(doc, candidatePlan, options)).plan;
}

/** preflight uses fallback to avoid permanently freezing a candidate after an LLM outage. */
export async function directAdoptedCandidatePlanDetailed(
  doc: FountainDoc,
  candidatePlan: ScriptMangaPlan,
  options: ScriptMangaPlanOptions = {}
): Promise<{ plan: ScriptMangaPlan; fallback: boolean }> {
  const settings = getLlmSettings();
  const directed = await directScriptMangaPages(doc, candidatePlan.pages, options);
  return {
    plan: {
      ...candidatePlan,
      pages: directed.pages,
      plannerProvenance: {
        kind: "llm-director",
        model: settings.model,
        batches: directed.batches,
        pageNaming: candidatePlan.plannerProvenance?.pageNaming
      }
    },
    fallback: directed.fallback
  };
}

interface DirectedPagesResult {
  pages: ScriptMangaPagePlan[];
  batches: Array<{ rawOutput: string; messages: Array<{ role: string; content: string }> }>;
  fallback: boolean;
}

/**
 * ネーム監督をページバッチ(4頁毎)で適用する。バッチ単位で失敗時は未演出のまま進める
 * (LLM障害でも生成を止めない、プランの追跡情報は不変)。
 */
async function directScriptMangaPages(
  doc: FountainDoc,
  basePages: ScriptMangaPagePlan[],
  options: ScriptMangaPlanOptions = {}
): Promise<DirectedPagesResult> {
  const settings = getLlmSettings();
  const fixedIdentity = options.characterBible?.trim() ?? "";
  const sceneBibles = deriveSceneBibles(doc, "director-input").map((bible, sceneIndex) => ({ sceneIndex, set: bible.set, lighting: bible.lighting, palette: bible.palette }));
  const batches: ScriptMangaPagePlan[][] = [];
  const provenanceBatches: Array<{ rawOutput: string; messages: Array<{ role: string; content: string }> }> = [];
  let fallback = false;
  for (let offset = 0; offset < basePages.length; offset += 4) batches.push(basePages.slice(offset, offset + 4));

  const directedPages: ScriptMangaPagePlan[] = [];
  for (const batch of batches) {
    const compact = batch.map((page) => ({
      index: page.index,
      title: page.title,
      // V5 X3: レイアウトは確定済みの読み取り専用コンテキスト。監督には選択権が無い。
      pageIntent: page.pageIntent,
      turnHook: page.turnHook,
      layout: page.layoutTemplateId,
      panels: page.panels.map((panel) => ({
        id: panel.id, scene: panel.sceneHeading, visualScale: panel.visualScale, source: panel.sourceText
      }))
    }));
    // 確定済みレイアウトの説明(bleed/figure スロットの意味と読み順位置)を読み取り専用情報として渡す。
    const layoutGuide = describeScriptMangaLayouts([
      ...new Set(batch.map((page) => page.layoutTemplateId))
    ]);
    try {
      const result = await generateStructuredJson<ScriptMangaPagePlan[]>({
      settings,
      systemPrompt: buildScriptMangaDirectorSystemPrompt({ fixedIdentity, speakers: speakerNames(doc) }),
      userPrompt: `Direct these pages. Do not change page count, index, panel id, or panel count. Do not contradict these scene bibles: ${JSON.stringify(sceneBibles)}. Layout guide (read-only): ${JSON.stringify(layoutGuide)}. Previous page intents: ${JSON.stringify(directedPages.slice(-4).map((page) => page.pageIntent))}\n${JSON.stringify(compact)}`,
      schema,
      validate: (raw) => applyScriptMangaDirectorBatch(raw, batch, options.stylePrompt),
      temperature: 0.35,
      timeoutMs: 180000
      });
      provenanceBatches.push({ rawOutput: result.rawOutput, messages: result.messages });
      directedPages.push(...result.value);
    } catch (error) {
      // 監督のどこで失敗しても生成は止めない: このバッチは未演出(N1/候補のまま)で進める。
      fallback = true;
      provenanceBatches.push({
        rawOutput: `[director-batch-fallback] ${error instanceof Error ? error.message : String(error)}`,
        messages: []
      });
      directedPages.push(...batch);
    }
  }
  return { pages: directedPages, batches: provenanceBatches, fallback };
}
