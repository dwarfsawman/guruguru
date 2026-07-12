import type { FountainDoc } from "../shared/fountain";
import { scriptMangaLayoutCandidates } from "../shared/layoutPresets";
import {
  planScriptManga,
  type ScriptMangaPagePlan,
  type ScriptMangaPanelDirection,
  type ScriptMangaPlan,
  type ScriptMangaPlanOptions
} from "../shared/scriptMangaPlan";
import { generateStructuredJson } from "./llmStructured";
import { getLlmSettings } from "./llm";

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

export function validateDirectedMangaBatch(raw: unknown, sourcePages: ScriptMangaPagePlan[], entityNames: string[] = []): DirectedBatch | null {

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
    if (!scriptMangaLayoutCandidates(source.panels.length).includes(page.layoutTemplateId)) return null;
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
  const directed = validateDirectedMangaBatch(raw, sourcePages);
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

/**
 * 決定的プランを安全網にしつつ、LLMを「ネーム監督」として画角・主役・感情・レイアウトを具体化する。
 * 台詞対応とページ/コマ数は変更させないため、全発話保持の既存保証は維持される。
 */
export async function planScriptMangaWithDirector(doc: FountainDoc, options: ScriptMangaPlanOptions = {}): Promise<ScriptMangaPlan> {
  const base = planScriptManga(doc, options);
  const settings = getLlmSettings();
  const fixedIdentity = options.characterBible?.trim() ?? "";
  const batches: ScriptMangaPagePlan[][] = [];
  const provenanceBatches: Array<{ rawOutput: string; messages: Array<{ role: string; content: string }> }> = [];
  for (let offset = 0; offset < base.pages.length; offset += 4) batches.push(base.pages.slice(offset, offset + 4));

  const directedPages: ScriptMangaPagePlan[] = [];
  for (const batch of batches) {
    const compact = batch.map((page) => ({
      index: page.index,
      title: page.title,
      allowedLayouts: scriptMangaLayoutCandidates(page.panels.length),
      panels: page.panels.map((panel) => ({ id: panel.id, scene: panel.sceneHeading, source: panel.sourceText }))
    }));
    const result = await generateStructuredJson<ScriptMangaPagePlan[]>({
      settings,
      systemPrompt: [
        "あなたは商業SF漫画のネーム監督です。右綴じ・右から左へ読む日本漫画として、視線誘導と緩急を設計してください。",
        "各コマは一つの瞬間、一つの主行動だけに絞り、誰が何をしてどう感じているかが静止画だけで判別できるようにします。",
        "同じ画角を連続させず、導入はwide、反応はclose-up、決めはlow angle/splashなど意図的に変化させます。",
        "台詞本文はpromptへ転記せず、speech act、表情、身振り、視線、口の状態という視覚化可能な演出へ変換してください。",
        "This is naming contract v3.0. Use only the fixed shot, angle, and position enum values from the schema.",
        "Write prompt in English with panel-specific visual facts only. Never include appearance/style attributes, dialogue, non-English text, or the words no/not/without/never. Put exclusions in avoid as English noun phrases.",
        fixedIdentity ? `以下のキャラクター固定票を一字も矛盾させないでください: ${fixedIdentity}` : "同名人物の髪型・服・年齢・体格は全コマで固定してください。",
        `登場話者: ${speakerNames(doc).join(", ")}`
      ].join("\n"),
      userPrompt: `Direct these pages. Do not change page count, index, panel id, or panel count. Previous page intents: ${JSON.stringify(directedPages.slice(-4).map((page) => page.pageIntent))}\n${JSON.stringify(compact)}`,
      schema,
      validate: (raw) => applyScriptMangaDirectorBatch(raw, batch, options.stylePrompt),
      temperature: 0.35,
      timeoutMs: 180000
    });
    provenanceBatches.push({ rawOutput: result.rawOutput, messages: result.messages });
    directedPages.push(...result.value);
  }
  return {
    ...base,
    pages: directedPages,
    plannerProvenance: {
      kind: "llm-director",
      model: settings.model,
      batches: provenanceBatches
    }
  };
}
