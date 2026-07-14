import type { FountainDoc, FountainElement } from "./fountain";
import { scriptMangaLayoutCandidates } from "./layoutPresets";
import type { MangaPageTurnHook, MangaPanelImportance } from "./mangaPlanV2";

export interface ScriptMangaPanelDirection {
  shot: string;
  angle?: string;
  subject: string;
  subjects?: Array<{
    ref: string;
    position: string;
    action: string;
    expression: string;
    gaze?: string;
  }>;
  avoid?: string[];
  action: string;
  emotion: string;
  composition: string;
}

export interface ScriptMangaPanelPlan {
  id: string;
  sceneIndex: number;
  sceneHeading: string;
  sourceElementIds: string[];
  prompt: string;
  sourceText: string;
  dialogueOrderIndexes: number[];
  direction?: ScriptMangaPanelDirection;
  /** N1ページネームのコマ重み(ネームv4 D1)。決定的プランナーでは未設定。 */
  importance?: MangaPanelImportance;
  /** ビート化N1(ネームv4 D2)がこのコマへ割り当てた注釈ビート id。従来経路では未設定。 */
  sourceBeatIds?: string[];
}

export interface ScriptMangaPagePlan {
  index: number;
  title: string;
  layoutTemplateId: string;
  panels: ScriptMangaPanelPlan[];
  pageIntent?: string;
  /** N1ページネームのページめくり演出(ネームv4 D1)。決定的プランナーでは未設定。 */
  turnHook?: MangaPageTurnHook;
}

export interface ScriptMangaPlan {
  title: string;
  pages: ScriptMangaPagePlan[];
  panelCount: number;
  dialogueCount: number;
  /** Exact structured-director exchanges used to create this plan (absent for deterministic planning). */
  plannerProvenance?: {
    kind: "llm-director";
    model: string;
    batches: Array<{
      rawOutput: string;
      messages: Array<{ role: string; content: string }>;
    }>;
    pageNaming?: {
      rawOutput: string;
      messages: Array<{ role: string; content: string }>;
      fallback: boolean;
      /** ネームv4 D2: どの N1 経路が成立したか(beats=ビート化N1 / panels=従来N1 / deterministic=決定的)。 */
      mode?: "beats" | "panels" | "deterministic";
      /** ビート注釈が決定的フォールバック(1要素=1ビート)だったか。 */
      beatAnnotatorFallback?: boolean;
    };
  };
}

export interface ScriptMangaPlanOptions {
  panelsPerPage?: number;
  maxElementsPerPanel?: number;
  maxDialoguesPerPanel?: number;
  maxSourceCharactersPerPanel?: number;
  stylePrompt?: string;
  /** LLMネーム監督が全バッチへ再注入する人物固定票。決定的プランナーでは未使用。 */
  characterBible?: string;
  /** N1ページネームの目標ページ数。省略時は発話量と決定的packerから算出。 */
  targetPageCount?: number;
  /** ビート注釈キャッシュ(script_beat_annotations)のキー。未指定はキャッシュ不使用。 */
  scriptRevisionId?: string;
}

export const DEFAULT_SCRIPT_MANGA_STYLE =
  "Japanese monochrome science fiction manga, cinematic composition, expressive characters, detailed ink line art, screentone, no text, no speech bubbles";
const DEFAULT_STYLE = DEFAULT_SCRIPT_MANGA_STYLE;

/** 要素の「読める」テキスト(sourceText 用)。ビート層(preLayoutBeat)と共有する。 */
export function elementVisibleText(element: FountainElement): string {
  return visibleText(element);
}

/** 要素の視覚化テキスト(画像プロンプト用)。ビート層(preLayoutBeat)と共有する。 */
export function elementVisualText(element: FountainElement): string {
  return visualText(element);
}

function visibleText(element: FountainElement): string {
  switch (element.type) {
    case "dialogue":
      return `${element.speaker}: ${element.text}`;
    case "action":
    case "transition":
    case "synopsis":
      return element.text;
    case "section":
      return "";
  }
}

function visualText(element: FountainElement): string {
  switch (element.type) {
    case "dialogue": {
      const speechAct = /[?？]/.test(element.text) ? "question" : /[!！]/.test(element.text) ? "exclamation" : "statement";
      const emotion = speechAct === "question" ? "inquisitive" : speechAct === "exclamation" ? "emphatic" : "focused";
      const delivery = element.parenthetical?.trim() ? `, deliveryDirection=${element.parenthetical.trim()}` : "";
      return `${element.speaker} speaking, speechAct=${speechAct}, emotion=${emotion}, mouthState=speaking, gazeTarget=conversation partner, gesture=natural conversational gesture${delivery}`;
    }
    case "action":
    case "synopsis":
      return element.text;
    case "transition":
    case "section":
      return "";
  }
}

function sourceElementId(sceneIndex: number, elementIndex: number): string {
  return `scene-${sceneIndex}-element-${elementIndex}`;
}

function layoutForPanelCount(count: number): string {
  const layout = scriptMangaLayoutCandidates(count)[0];
  if (!layout) throw new Error(`No script manga layout supports ${count} panels.`);
  return layout;
}

/**
 * Fountain の連続要素を、画像生成可能な視覚的コマへ決定的に束ねる。
 * シーン境界は跨がず、発話数・文字量にも上限を置くことで、長編脚本でも
 * 1 action = 1 image の過剰生成を避けつつ、全発話を必ずいずれかのコマへ割り当てる。
 */
export function planScriptManga(doc: FountainDoc, options: ScriptMangaPlanOptions = {}): ScriptMangaPlan {
  const panelsPerPage = Math.max(1, Math.min(6, Math.trunc(options.panelsPerPage ?? 4)));
  const maxElements = Math.max(1, Math.trunc(options.maxElementsPerPanel ?? 6));
  const maxDialogues = Math.max(1, Math.trunc(options.maxDialoguesPerPanel ?? 2));
  const maxCharacters = Math.max(40, Math.trunc(options.maxSourceCharactersPerPanel ?? 260));
  const stylePrompt = options.stylePrompt?.trim() || DEFAULT_STYLE;

  const panels: ScriptMangaPanelPlan[] = [];
  let dialogueOrder = 0;

  doc.scenes.forEach((scene, sceneIndex) => {
    let elements: Array<{ element: FountainElement; sourceElementId: string }> = [];
    let dialogueIndexes: number[] = [];
    let characterCount = 0;

    const flush = () => {
      const sourceParts = elements.map(({ element }) => visibleText(element)).filter(Boolean);
      const visualParts = elements.map(({ element }) => visualText(element)).filter(Boolean);
      if (sourceParts.length === 0) {
        elements = [];
        dialogueIndexes = [];
        characterCount = 0;
        return;
      }
      const panelIndex = panels.length;
      const sceneContext = scene.heading ? `Scene: ${scene.heading}.` : "";
      panels.push({
        id: `panel-${panelIndex + 1}`,
        sceneIndex,
        sceneHeading: scene.heading,
        sourceElementIds: elements.map((entry) => entry.sourceElementId),
        prompt: `${stylePrompt}. ${sceneContext} ${visualParts.join(" ")}`.replace(/\s+/g, " ").trim(),
        sourceText: sourceParts.join("\n"),
        dialogueOrderIndexes: [...dialogueIndexes]
      });
      elements = [];
      dialogueIndexes = [];
      characterCount = 0;
    };

    for (const [elementIndex, element] of scene.elements.entries()) {
      if (element.type === "section" || element.type === "transition") continue;
      const text = visibleText(element);
      if (!text) continue;
      const nextDialogueCount = dialogueIndexes.length + (element.type === "dialogue" ? 1 : 0);
      if (
        elements.length > 0 &&
        (elements.length >= maxElements || nextDialogueCount > maxDialogues || characterCount + text.length > maxCharacters)
      ) {
        flush();
      }
      elements.push({ element, sourceElementId: sourceElementId(sceneIndex, elementIndex) });
      characterCount += text.length;
      if (element.type === "dialogue") {
        dialogueIndexes.push(dialogueOrder);
        dialogueOrder += 1;
      }
    }
    flush();
  });

  const pages: ScriptMangaPagePlan[] = [];
  for (let offset = 0; offset < panels.length; offset += panelsPerPage) {
    const pagePanels = panels.slice(offset, offset + panelsPerPage);
    const first = pagePanels[0];
    pages.push({
      index: pages.length,
      title: first?.sceneHeading || `Page ${pages.length + 1}`,
      layoutTemplateId: layoutForPanelCount(pagePanels.length),
      panels: pagePanels
    });
  }

  return {
    title: doc.titlePage.Title || "Manga",
    pages,
    panelCount: panels.length,
    dialogueCount: dialogueOrder
  };
}
