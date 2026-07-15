import type { FountainDoc } from "../shared/fountain";
import { deriveSceneBibles } from "./storyGraphBuilder";
import {
  describeScriptMangaLayouts,
  scriptMangaLayoutAlignsImportance,
  scriptMangaLayoutCandidates
} from "../shared/layoutPresets";
import {
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
  applyPageNaming,
  createBeatPageNamingSchema,
  createPageNamingSchema
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

interface DirectedPage {
  index: number;
  layoutTemplateId: string;
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
        required: ["index", "layoutTemplateId", "pageIntent", "panels"],
        properties: {
          index: { type: "integer" },
          layoutTemplateId: { type: "string" },
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

export interface DirectedBatchValidationOptions {
  /** ネームv4 D3: 採用候補のレイアウトを固定(監督はレイアウト変更不可)。 */
  lockLayouts?: boolean;
}

export function validateDirectedMangaBatch(
  raw: unknown,
  sourcePages: ScriptMangaPagePlan[],
  entityNames: string[] = [],
  validationOptions: DirectedBatchValidationOptions = {}
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
    if (validationOptions.lockLayouts) {
      // 採用候補のレイアウトは人間が見比べて選んだもの。監督には変更させない。
      if (page.layoutTemplateId !== source.layoutTemplateId) return null;
    } else {
      if (!scriptMangaLayoutCandidates(source.panels.length).includes(page.layoutTemplateId)) return null;
      // ネームv4 D1: 監督がレイアウトを差し替える場合も hero×強調スロット整合を守らせる。
      // 整合可能な候補が1つも無い importance 構成では強制しない(判定はどの候補でも false になるため)。
      const importances = source.panels.map((panel) => panel.importance ?? "normal");
      if (!scriptMangaLayoutAlignsImportance(page.layoutTemplateId, importances)) {
        const anyAligned = scriptMangaLayoutCandidates(source.panels.length)
          .some((candidateId) => scriptMangaLayoutAlignsImportance(candidateId, importances));
        if (anyAligned) return null;
      }
    }
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
  stylePrompt?: string,
  validationOptions: DirectedBatchValidationOptions = {}
): ScriptMangaPagePlan[] | null {
  const directed = validateDirectedMangaBatch(raw, sourcePages, [], validationOptions);
  if (!directed) return null;
  return sourcePages.map((source, pageIndex) => {
    const directedPage = directed.pages[pageIndex]!;
    return {
      ...source,
      layoutTemplateId: directedPage.layoutTemplateId,
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

/** N1 の多様化オプション(ネームv4 D3: 候補生成が温度・プロファイルを振る)。 */
export interface ScriptMangaN1Options {
  temperature?: number;
  /** システムプロンプトへ1行追加する演出プロファイル指示(readability / cinematic / tempo)。 */
  profileInstruction?: string;
}

export interface ScriptMangaN1Result {
  plan: ScriptMangaPlan;
  /** ビート注釈(ビート化N1が成立した場合のみ非null。V2 の beats 引き継ぎに使う)。 */
  beatAnnotation: BeatAnnotationResult | null;
  pageNaming: {
    mode: "beats" | "panels" | "deterministic";
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
 * N1 ページネーム(ネームv4 D2)。ビート注釈(キャッシュ付き)→ ビート化 N1 →
 * 失敗時は従来のコマ束ね N1 → それも失敗なら決定的プラン、の三段フォールバック。
 * どの経路でも「全台詞一度ずつ」契約と ScriptMangaPlan の形は不変。
 */
export async function generateScriptMangaN1Plan(
  doc: FountainDoc,
  options: ScriptMangaPlanOptions = {},
  n1Options: ScriptMangaN1Options = {}
): Promise<ScriptMangaN1Result> {
  const deterministicBase = planScriptManga(doc, options);
  const settings = getLlmSettings();
  const targetPageCount = Math.max(1, Math.trunc(options.targetPageCount ?? Math.max(deterministicBase.pages.length, deterministicBase.dialogueCount / 5)));
  const maxPanelsPerPage = Math.max(1, Math.min(6, Math.trunc(options.panelsPerPage ?? 4)));
  const maxDialoguesPerPanel = Math.max(1, Math.min(8, Math.trunc(options.maxDialoguesPerPanel ?? 4)));
  const temperature = n1Options.temperature ?? 0.3;
  const profileLines = n1Options.profileInstruction?.trim() ? [n1Options.profileInstruction.trim()] : [];

  // 1) ビート化 N1: 物語ビートを入力に、コマ=ビート束としてページを設計する。
  const annotation = await annotateScriptBeats(doc, options.scriptRevisionId);
  if (annotation.beats.length > 0) {
    try {
      const named = await generateStructuredJson<ScriptMangaPlan>({
        settings,
        systemPrompt: [
          "You are the N1 manga page-naming editor. Build pages and panels from the annotated story beats.",
          "Cover every beat id exactly once and in order via panels[].sourceBeatIds. A panel usually bundles 1-3 consecutive beats; never mix scenes in one panel.",
          `Use 1-${maxPanelsPerPage} panels per page; this is a hard maximum. Splash means exactly one panel on its page.`,
          "Respect the annotations: give keepAlone beats their own panel; map desiredScale hero/splash to panel importance; put beats with high pageTurnAffinity at a page's final panel (tease) or a page's first panel (payoff).",
          `No panel may contain more than ${maxDialoguesPerPanel} scripted dialogue elements; this is not a rendered-balloon target.`,
          `Keep each panel's total dialogue below ${Math.max(40, Math.trunc(options.maxSourceCharactersPerPanel ?? 260))} characters.`,
          ...N1_COMMON_PROMPT_LINES,
          ...profileLines
        ].join("\n"),
        userPrompt: `Target page count: ${targetPageCount} (accepted range ±20%). Story beats (in order): ${JSON.stringify(beatCompact(annotation))}`,
        schema: createBeatPageNamingSchema(maxPanelsPerPage),
        validate: (raw) => applyBeatPageNaming(raw, {
          title: deterministicBase.title,
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
    } catch {
      // ビート化 N1 が通らない場合は従来のコマ束ね N1 へ(生成は止めない)。
    }
  }

  // 2) 従来 N1: 決定的束ねのコマを統合のみ許可する再ページ割り。
  try {
    const sourcePanels = deterministicBase.pages.flatMap((page) => page.panels).map((panel) => ({
      id: panel.id, sceneIndex: panel.sceneIndex, sourceElementIds: panel.sourceElementIds,
      dialogueOrderIndexes: panel.dialogueOrderIndexes, source: panel.sourceText
    }));
    const named = await generateStructuredJson<ScriptMangaPlan>({
      settings,
      systemPrompt: [
        `You are the N1 manga page-naming editor. Preserve every sourcePanelId exactly once and in order. Never combine scenes. Use 1-${maxPanelsPerPage} panels per page; this is a hard maximum. Splash means one panel on its page. Design page turns and hero beats.`,
        `No panel may contain more than ${maxDialoguesPerPanel} scripted dialogue elements; this is not a rendered-balloon target.`,
        ...N1_COMMON_PROMPT_LINES,
        ...profileLines
      ].join("\n"),
      userPrompt: `Target page count: ${targetPageCount} (accepted range ±20%). Source panels: ${JSON.stringify(sourcePanels)}`,
      schema: createPageNamingSchema(maxPanelsPerPage),
      validate: (raw) => applyPageNaming(raw, deterministicBase, targetPageCount, maxDialoguesPerPanel, maxPanelsPerPage),
      temperature,
      timeoutMs: 180000
    });
    return {
      plan: named.value,
      beatAnnotation: null,
      pageNaming: { mode: "panels", rawOutput: named.rawOutput, messages: named.messages, fallback: false }
    };
  } catch (error) {
    return {
      plan: deterministicBase,
      beatAnnotation: null,
      pageNaming: {
        mode: "deterministic",
        rawOutput: error instanceof Error ? error.message : String(error),
        messages: [],
        fallback: true
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
 * 採用済みプラン候補(ネームv4 D3)へ監督を適用する。候補のページ割り・レイアウトは
 * 人間が選んだものなので監督は変更できない(lockLayouts)。
 */
export async function directAdoptedCandidatePlan(
  doc: FountainDoc,
  candidatePlan: ScriptMangaPlan,
  options: ScriptMangaPlanOptions = {}
): Promise<ScriptMangaPlan> {
  const settings = getLlmSettings();
  const directed = await directScriptMangaPages(doc, candidatePlan.pages, options, { lockLayouts: true });
  return {
    ...candidatePlan,
    pages: directed.pages,
    plannerProvenance: {
      kind: "llm-director",
      model: settings.model,
      batches: directed.batches,
      pageNaming: candidatePlan.plannerProvenance?.pageNaming
    }
  };
}

interface DirectedPagesResult {
  pages: ScriptMangaPagePlan[];
  batches: Array<{ rawOutput: string; messages: Array<{ role: string; content: string }> }>;
}

/**
 * ネーム監督をページバッチ(4頁毎)で適用する。バッチ単位で失敗時は未演出のまま進める
 * (LLM障害でも生成を止めない、プランの追跡情報は不変)。
 */
async function directScriptMangaPages(
  doc: FountainDoc,
  basePages: ScriptMangaPagePlan[],
  options: ScriptMangaPlanOptions = {},
  validationOptions: DirectedBatchValidationOptions = {}
): Promise<DirectedPagesResult> {
  const settings = getLlmSettings();
  const fixedIdentity = options.characterBible?.trim() ?? "";
  const sceneBibles = deriveSceneBibles(doc, "director-input").map((bible, sceneIndex) => ({ sceneIndex, set: bible.set, lighting: bible.lighting, palette: bible.palette }));
  const batches: ScriptMangaPagePlan[][] = [];
  const provenanceBatches: Array<{ rawOutput: string; messages: Array<{ role: string; content: string }> }> = [];
  for (let offset = 0; offset < basePages.length; offset += 4) batches.push(basePages.slice(offset, offset + 4));

  const directedPages: ScriptMangaPagePlan[] = [];
  for (const batch of batches) {
    const pageAllowedLayouts = (page: ScriptMangaPagePlan): string[] =>
      validationOptions.lockLayouts ? [page.layoutTemplateId] : scriptMangaLayoutCandidates(page.panels.length);
    const compact = batch.map((page) => ({
      index: page.index,
      title: page.title,
      // ネームv4 D1: N1 の意図(pageIntent/turnHook/importance)と事前選択レイアウトを監督にも渡す。
      pageIntent: page.pageIntent,
      turnHook: page.turnHook,
      preselectedLayout: page.layoutTemplateId,
      allowedLayouts: pageAllowedLayouts(page),
      panels: page.panels.map((panel) => ({
        id: panel.id, scene: panel.sceneHeading, importance: panel.importance, source: panel.sourceText
      }))
    }));
    // バッチ内で許可されている全レイアウトの説明(bleed/figure スロットの意味と読み順位置を含む)。
    const layoutGuide = describeScriptMangaLayouts([
      ...new Set(batch.flatMap((page) => pageAllowedLayouts(page)))
    ]);
    try {
      const result = await generateStructuredJson<ScriptMangaPagePlan[]>({
      settings,
      systemPrompt: [
        "あなたは商業漫画のネーム監督です。右綴じ・右から左へ読む日本漫画として、視線誘導と緩急を設計してください。",
        "各コマは一つの瞬間、一つの主行動だけに絞り、誰が何をしてどう感じているかが静止画だけで判別できるようにします。",
        "同じ画角を連続させず、導入はwide、反応はclose-up、決めはlow angle/splashなど意図的に変化させます。",
        "台詞本文はpromptへ転記せず、speech act、表情、身振り、視線、口の状態という視覚化可能な演出へ変換してください。",
        "This is naming contract v3.0. Use only the fixed shot, angle, and position enum values from the schema.",
        "Write prompt in English with panel-specific visual facts only. Never include appearance/style attributes, dialogue, non-English text, or the words no/not/without/never. Put exclusions in avoid as English noun phrases.",
        "Layout ids containing 'bleed' extend panels past the page edge (borderless art) — pick them for climactic, atmospheric, or montage pages instead of always using framed grids.",
        "Layouts with a figureSlot render that reading position as a borderless full-body character cut-out standing over the page (punch-out). Panels are mapped to layout slots in reading order, so the panel at that position becomes the figure: give it a single character-defining beat, set its subject to full body, and keep its dialogue minimal.",
        "Panels marked importance=hero must land on the layout's largest slot (panels map to slots in reading order). Keep preselectedLayout unless another allowedLayout also keeps every hero on an emphasized slot.",
        "On pages with turnHook=reveal, stage the final panel as a tease and leave the disclosure to the next page's first panel. On turnHook=cliffhanger pages, end at peak tension mid-action.",
        fixedIdentity ? `以下のキャラクター固定票を一字も矛盾させないでください: ${fixedIdentity}` : "同名人物の髪型・服・年齢・体格は全コマで固定してください。",
        `登場話者: ${speakerNames(doc).join(", ")}`
      ].join("\n"),
      userPrompt: `Direct these pages. Do not change page count, index, panel id, or panel count. ${validationOptions.lockLayouts ? "The layoutTemplateId of every page is locked — echo it back unchanged. " : ""}Do not contradict these scene bibles: ${JSON.stringify(sceneBibles)}. Layout guide: ${JSON.stringify(layoutGuide)}. Previous page intents: ${JSON.stringify(directedPages.slice(-4).map((page) => page.pageIntent))}\n${JSON.stringify(compact)}`,
      schema,
      validate: (raw) => applyScriptMangaDirectorBatch(raw, batch, options.stylePrompt, validationOptions),
      temperature: 0.35,
      timeoutMs: 180000
      });
      provenanceBatches.push({ rawOutput: result.rawOutput, messages: result.messages });
      directedPages.push(...result.value);
    } catch (error) {
      // 監督のどこで失敗しても生成は止めない: このバッチは未演出(N1/候補のまま)で進める。
      provenanceBatches.push({
        rawOutput: `[director-batch-fallback] ${error instanceof Error ? error.message : String(error)}`,
        messages: []
      });
      directedPages.push(...batch);
    }
  }
  return { pages: directedPages, batches: provenanceBatches };
}
