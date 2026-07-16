import type { FountainDoc, FountainElement } from "./fountain";
import { scriptMangaLayoutCandidates } from "./layoutPresets";
import { type MangaPageTurnHook, type MangaVisualScale, normalizeLegacyVisualScale } from "./mangaPlanV2";

/**
 * 人間のページ別レイアウト選択(V5 D5)を不変の基礎プランへ適用した「実効プラン」を返す。
 * 基礎プランは書き換えない(undo/リセット・生成案と人間修正の区別のため)。
 */
export function applyLayoutOverrides(
  plan: ScriptMangaPlan,
  overrides: Record<number, string> | undefined
): ScriptMangaPlan {
  if (!overrides || Object.keys(overrides).length === 0) return plan;
  return {
    ...plan,
    pages: plan.pages.map((page) => {
      const override = overrides[page.index];
      return override && override !== page.layoutTemplateId ? { ...page, layoutTemplateId: override } : page;
    })
  };
}

/**
 * 永続 candidate plan のparse直後に呼ぶ入力adapter(V5 D1)。旧語彙(importance)しか持たない
 * コマへ visualScale を補完する(in-place)。
 */
export function normalizeScriptMangaPlanScales(plan: ScriptMangaPlan): ScriptMangaPlan {
  for (const page of plan.pages) {
    for (const panel of page.panels) {
      if (!panel.visualScale) {
        // 旧語彙の importance は型からは削除済みだが、永続JSONには残っている。
        const scale = normalizeLegacyVisualScale({ importance: (panel as { importance?: unknown }).importance });
        if (scale) panel.visualScale = scale;
      }
    }
  }
  return plan;
}

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
  /** 解決済みコマスケール(ネームスタジオV5 D1)。旧 importance enum の後継。旧経路では未設定。 */
  visualScale?: MangaVisualScale;
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
      /**
       * どの N1 経路が成立したか(V5 D2: beats=ビート化N1 / deterministic=決定的ビートパッカー)。
       * 保存済みprovenanceには旧値 "panels"(従来N1、V5で削除)が残り得るが、読み手は未知値として扱う。
       */
      mode?: "beats" | "deterministic";
      /** ビート注釈が決定的フォールバック(1要素=1ビート)だったか。 */
      beatAnnotatorFallback?: boolean;
    };
  };
}

/**
 * Name Studio 候補の物語構造を比較する安定署名。
 *
 * 文言・prompt・演出 direction・既定 layout の差は同じネーム構造として扱い、ページ/コマ境界、
 * source element/dialogue の割当、visualScale、めくり、人間の layout override が違う時だけ別案にする。
 * sourceBeatIds は注釈器の有無で省略される補助情報なので、署名を環境依存にしないため含めない。
 * panel id は外部 agent が案ごとに振り直せるため署名へ含めない。
 */
export function scriptMangaPlanStructureSignature(
  plan: ScriptMangaPlan,
  layoutOverrides: Readonly<Record<number, string>> = {}
): string {
  return JSON.stringify([
    plan.pages.map((page) => [
      page.index,
      page.turnHook ?? "",
      page.panels.map((panel) => [
        panel.sceneIndex,
        panel.sourceElementIds,
        panel.dialogueOrderIndexes,
        panel.visualScale ?? ""
      ])
    ]),
    Object.entries(layoutOverrides).sort(([a], [b]) => Number(a) - Number(b))
  ]);
}

export interface ScriptMangaPlanOptions {
  panelsPerPage?: number;
  maxElementsPerPanel?: number;
  /** 1コマへ割り当てるFountain dialogue要素数の上限。1〜8、既定4。吹き出し数そのものではない。 */
  maxDialoguesPerPanel?: number;
  maxSourceCharactersPerPanel?: number;
  stylePrompt?: string;
  /** LLMネーム監督が全バッチへ再注入する人物固定票。決定的プランナーでは未使用。 */
  characterBible?: string;
  /** 目標ページ数。決定的packerでは1ページ1コマ〜panelsPerPageの範囲でbest-effort配分する。 */
  targetPageCount?: number;
  /** ビート注釈キャッシュ(script_beat_annotations)のキー。未指定はキャッシュ不使用。 */
  scriptRevisionId?: string;
}

export const DEFAULT_SCRIPT_MANGA_STYLE =
  "Japanese monochrome manga, cinematic composition, expressive characters, detailed ink line art, screentone, no text, no speech bubbles";
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
  const maxDialogues = Math.max(1, Math.min(8, Math.trunc(options.maxDialoguesPerPanel ?? 4)));
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
      // A new action/synopsis paragraph is a conservative moment boundary. Keep the
      // preceding action plus its dialogue exchange together, but never compress a
      // later state-changing action into that same still image merely to save panels.
      if (elements.length > 0 && (element.type === "action" || element.type === "synopsis")) {
        flush();
      }
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

  const requestedPageCount = Number.isFinite(options.targetPageCount) && (options.targetPageCount ?? 0) > 0
    ? Math.max(1, Math.trunc(options.targetPageCount!))
    : null;
  const minimumPageCount = Math.ceil(panels.length / panelsPerPage);
  const pageCount = requestedPageCount === null || panels.length === 0
    ? minimumPageCount
    : Math.min(panels.length, Math.max(minimumPageCount, requestedPageCount));
  const pages: ScriptMangaPagePlan[] = [];
  let offset = 0;
  while (offset < panels.length) {
    const remainingPages = pageCount - pages.length;
    const remainingPanels = panels.length - offset;
    // target指定時は連続順を維持したまま均等配分する。下限はhardなコマ密度制約から決まる。
    const count = requestedPageCount === null
      ? Math.min(panelsPerPage, remainingPanels)
      : Math.min(panelsPerPage, Math.ceil(remainingPanels / remainingPages));
    const pagePanels = panels.slice(offset, offset + count);
    const first = pagePanels[0];
    pages.push({
      index: pages.length,
      title: first?.sceneHeading || `Page ${pages.length + 1}`,
      layoutTemplateId: layoutForPanelCount(pagePanels.length),
      panels: pagePanels
    });
    offset += count;
  }

  return {
    title: doc.titlePage.Title || "Manga",
    pages,
    panelCount: panels.length,
    dialogueCount: dialogueOrder
  };
}
