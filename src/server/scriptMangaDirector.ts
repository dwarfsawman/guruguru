import type { FountainDoc } from "../shared/fountain";
import { planScriptManga, type ScriptMangaPagePlan, type ScriptMangaPlan, type ScriptMangaPlanOptions } from "../shared/scriptMangaPlan";
import { generateStructuredJson } from "./llmStructured";
import { getLlmSettings } from "./llm";

interface DirectedPanel {
  id: string;
  shot: string;
  subject: string;
  action: string;
  emotion: string;
  composition: string;
  prompt: string;
}

interface DirectedPage {
  index: number;
  layoutTemplateId: string;
  pageIntent: string;
  panels: DirectedPanel[];
}

interface DirectedBatch { pages: DirectedPage[] }

const LAYOUTS_BY_COUNT: Record<number, string[]> = {
  1: ["builtin:splash"],
  2: ["builtin:two-horizontal", "builtin:two-vertical"],
  3: ["builtin:three-horizontal", "builtin:three-hero-top"],
  4: ["builtin:four-grid", "builtin:four-hero-bottom", "builtin:four-vertical-hero"]
};

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
              required: ["id", "shot", "subject", "action", "emotion", "composition", "prompt"],
              properties: {
                id: { type: "string" }, shot: { type: "string" }, subject: { type: "string" },
                action: { type: "string" }, emotion: { type: "string" }, composition: { type: "string" },
                prompt: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
} as const;

function validateBatch(raw: unknown, sourcePages: ScriptMangaPagePlan[]): DirectedBatch | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as DirectedBatch).pages)) return null;
  const pages = (raw as DirectedBatch).pages;
  if (pages.length !== sourcePages.length) return null;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const source = sourcePages[i];
    if (!page || !source || page.index !== source.index || !Array.isArray(page.panels) || page.panels.length !== source.panels.length) return null;
    if (!(LAYOUTS_BY_COUNT[source.panels.length] ?? []).includes(page.layoutTemplateId)) return null;
    for (let p = 0; p < page.panels.length; p += 1) {
      const panel = page.panels[p];
      if (!panel || panel.id !== source.panels[p]!.id || !panel.prompt?.trim()) return null;
    }
  }
  return { pages };
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
  for (let offset = 0; offset < base.pages.length; offset += 4) batches.push(base.pages.slice(offset, offset + 4));

  const directedPages: ScriptMangaPagePlan[] = [];
  for (const batch of batches) {
    const compact = batch.map((page) => ({
      index: page.index,
      title: page.title,
      allowedLayouts: LAYOUTS_BY_COUNT[page.panels.length],
      panels: page.panels.map((panel) => ({ id: panel.id, scene: panel.sceneHeading, source: panel.sourceText }))
    }));
    const result = await generateStructuredJson<DirectedBatch>({
      settings,
      systemPrompt: [
        "あなたは商業SF漫画のネーム監督です。右綴じ・右から左へ読む日本漫画として、視線誘導と緩急を設計してください。",
        "各コマは一つの瞬間、一つの主行動だけに絞り、誰が何をしてどう感じているかが静止画だけで判別できるようにします。",
        "同じ画角を連続させず、導入はwide、反応はclose-up、決めはlow angle/splashなど意図的に変化させます。",
        "promptは英語で、人物数、左右位置、視線、手足の動作、背景、カメラ距離を具体化してください。文字・吹き出しは描かせません。",
        fixedIdentity ? `以下のキャラクター固定票を一字も矛盾させないでください: ${fixedIdentity}` : "同名人物の髪型・服・年齢・体格は全コマで固定してください。",
        `登場話者: ${speakerNames(doc).join(", ")}`
      ].join("\n"),
      userPrompt: `次のページ群を演出してください。ページ数、index、panel id、コマ数は変更禁止です。\n${JSON.stringify(compact)}`,
      schema,
      validate: (raw) => validateBatch(raw, batch),
      temperature: 0.35,
      timeoutMs: 180000
    });
    for (let i = 0; i < batch.length; i += 1) {
      const source = batch[i]!;
      const directed = result.value.pages[i]!;
      directedPages.push({
        ...source,
        layoutTemplateId: directed.layoutTemplateId,
        panels: source.panels.map((panel, panelIndex) => ({
          ...panel,
          prompt: `${options.stylePrompt?.trim() || "Japanese monochrome science fiction manga, professional ink line art, screentone"}. ${directed.panels[panelIndex]!.prompt}. consistent character design, readable silhouette, no text, no letters, no speech bubbles, no watermark`
        }))
      });
    }
  }
  return { ...base, pages: directedPages };
}
