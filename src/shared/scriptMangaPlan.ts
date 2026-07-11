import type { FountainDoc, FountainElement } from "./fountain";

export interface ScriptMangaPanelPlan {
  id: string;
  sceneIndex: number;
  sceneHeading: string;
  prompt: string;
  sourceText: string;
  dialogueOrderIndexes: number[];
}

export interface ScriptMangaPagePlan {
  index: number;
  title: string;
  layoutTemplateId: string;
  panels: ScriptMangaPanelPlan[];
}

export interface ScriptMangaPlan {
  title: string;
  pages: ScriptMangaPagePlan[];
  panelCount: number;
  dialogueCount: number;
}

export interface ScriptMangaPlanOptions {
  panelsPerPage?: number;
  maxElementsPerPanel?: number;
  maxDialoguesPerPanel?: number;
  maxSourceCharactersPerPanel?: number;
  stylePrompt?: string;
  /** LLMネーム監督が全バッチへ再注入する人物固定票。決定的プランナーでは未使用。 */
  characterBible?: string;
}

const DEFAULT_STYLE =
  "Japanese monochrome science fiction manga, cinematic composition, expressive characters, detailed ink line art, screentone, no text, no speech bubbles";

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
    case "dialogue":
      return `${element.speaker} is speaking, ${element.text}`;
    case "action":
    case "synopsis":
      return element.text;
    case "transition":
    case "section":
      return "";
  }
}

function layoutForPanelCount(count: number): string {
  if (count <= 1) return "builtin:splash";
  if (count === 2) return "builtin:two-horizontal";
  if (count === 3) return "builtin:three-horizontal";
  return "builtin:four-grid";
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
    let elements: FountainElement[] = [];
    let dialogueIndexes: number[] = [];
    let characterCount = 0;

    const flush = () => {
      const sourceParts = elements.map(visibleText).filter(Boolean);
      const visualParts = elements.map(visualText).filter(Boolean);
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
        prompt: `${stylePrompt}. ${sceneContext} ${visualParts.join(" ")}`.replace(/\s+/g, " ").trim(),
        sourceText: sourceParts.join("\n"),
        dialogueOrderIndexes: [...dialogueIndexes]
      });
      elements = [];
      dialogueIndexes = [];
      characterCount = 0;
    };

    for (const element of scene.elements) {
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
      elements.push(element);
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
