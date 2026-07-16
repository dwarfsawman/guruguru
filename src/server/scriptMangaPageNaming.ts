import { scriptMangaLayoutCandidates, selectScriptMangaLayoutId } from "../shared/layoutPresets";
import { type MangaPageTurnHook, type MangaPanelImportance, visualScaleFromImportance } from "../shared/mangaPlanV2";
import type { AnnotatedBeat, PreLayoutUnit } from "../shared/preLayoutBeat";
import {
  DEFAULT_SCRIPT_MANGA_STYLE,
  type ScriptMangaPagePlan,
  type ScriptMangaPanelPlan,
  type ScriptMangaPlan
} from "../shared/scriptMangaPlan";

export type PanelImportance = MangaPanelImportance;
export type TurnHook = MangaPageTurnHook;
export interface PageNamingPanel { id: string; importance: PanelImportance; sourcePanelIds: string[] }
export interface PageNamingPage { index: number; pageIntent: string; turnHook?: TurnHook; panels: PageNamingPanel[] }
export interface PageNamingResult { pages: PageNamingPage[] }

function flatten(plan: ScriptMangaPlan): ScriptMangaPanelPlan[] { return plan.pages.flatMap((page) => page.panels); }

/** UI/API と同じ有効範囲へ正規化した、1ページあたりのコマ数上限。 */
function normalizeMaxPanelsPerPage(value: number | undefined): number {
  return Math.max(1, Math.min(6, Math.trunc(value ?? 6)));
}

/** N1契約を検証してScriptMangaPlanへ適用する。失敗時はnullで決定的packerへ戻せる。 */
export function applyPageNaming(
  raw: unknown,
  source: ScriptMangaPlan,
  targetPageCount: number,
  maxDialoguesPerPanel = 4,
  maxPanelsPerPage = 6
): ScriptMangaPlan | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as PageNamingResult).pages)) return null;
  const named = raw as PageNamingResult;
  const sourcePanels = flatten(source);
  const byId = new Map(sourcePanels.map((panel) => [panel.id, panel]));
  const expectedIds = sourcePanels.map((panel) => panel.id);
  const observedIds: string[] = [];
  const minPages = Math.max(1, Math.floor(targetPageCount * 0.8));
  const maxPages = Math.max(minPages, Math.ceil(targetPageCount * 1.2));
  const panelLimit = normalizeMaxPanelsPerPage(maxPanelsPerPage);
  if (named.pages.length < minPages || named.pages.length > maxPages) return null;
  const pages: ScriptMangaPagePlan[] = [];
  for (let pageIndex = 0; pageIndex < named.pages.length; pageIndex += 1) {
    const page = named.pages[pageIndex];
    if (!page || page.index !== pageIndex || !page.pageIntent?.trim() || !Array.isArray(page.panels) || page.panels.length < 1 || page.panels.length > panelLimit) return null;
    if (page.turnHook !== undefined && !["reveal", "cliffhanger", "none"].includes(page.turnHook)) return null;
    if (page.panels.some((panel) => panel.importance === "splash") && page.panels.length !== 1) return null;
    if (!scriptMangaLayoutCandidates(page.panels.length).length) return null;
    const panels: ScriptMangaPanelPlan[] = [];
    for (const namedPanel of page.panels) {
      if (!namedPanel?.id || !["splash", "hero", "normal"].includes(namedPanel.importance) || !Array.isArray(namedPanel.sourcePanelIds) || namedPanel.sourcePanelIds.length === 0) return null;
      const parts = namedPanel.sourcePanelIds.map((id) => byId.get(id));
      if (parts.some((panel) => !panel)) return null;
      const concrete = parts as ScriptMangaPanelPlan[];
      if (new Set(concrete.map((panel) => panel.sceneIndex)).size !== 1) return null;
      const dialogueOrderIndexes = concrete.flatMap((panel) => panel.dialogueOrderIndexes);
      if (dialogueOrderIndexes.length > Math.max(1, Math.min(8, Math.trunc(maxDialoguesPerPanel)))) return null;
      observedIds.push(...namedPanel.sourcePanelIds);
      panels.push({
        ...concrete[0]!, id: namedPanel.id,
        sourceElementIds: concrete.flatMap((panel) => panel.sourceElementIds),
        sourceText: concrete.map((panel) => panel.sourceText).join("\n"),
        prompt: concrete.map((panel) => panel.prompt).join(" "),
        dialogueOrderIndexes,
        importance: namedPanel.importance,
        // V5 D1 P1a: 旧N1が生きている間は LLM の importance 出力を新語彙へ写すシム。
        visualScale: visualScaleFromImportance(namedPanel.importance)
      });
    }
    // ネームv4 D1: 候補先頭固定をやめ、importance 構成(hero×強調スロット/splash→裁ち切り)で事前選択する。
    const layoutTemplateId = selectScriptMangaLayoutId(panels.map((panel) => panel.importance ?? "normal"))
      ?? scriptMangaLayoutCandidates(panels.length)[0]!;
    pages.push({ index: pageIndex, title: panels[0]!.sceneHeading || `Page ${pageIndex + 1}`,
      layoutTemplateId, pageIntent: page.pageIntent.trim(),
      ...(page.turnHook !== undefined ? { turnHook: page.turnHook } : {}), panels });
  }
  if (observedIds.length !== expectedIds.length || observedIds.some((id, index) => id !== expectedIds[index])) return null;
  return { ...source, pages, panelCount: pages.reduce((sum, page) => sum + page.panels.length, 0) };
}

// --- ビート化 N1(ネームv4 D2): beats を入力に、コマ = ビート束としてページ設計する ---

export interface BeatPageNamingPanel { id: string; importance: PanelImportance; sourceBeatIds: string[] }
export interface BeatPageNamingPage { index: number; pageIntent: string; turnHook?: TurnHook; panels: BeatPageNamingPanel[] }
export interface BeatPageNamingResult { pages: BeatPageNamingPage[] }

export interface BeatPageNamingContext {
  title: string;
  units: readonly PreLayoutUnit[];
  beats: readonly AnnotatedBeat[];
  targetPageCount: number;
  stylePrompt?: string;
  /** コマあたりの台詞文字量上限(ローカル計算)。既定 260。 */
  maxDialogueCharactersPerPanel?: number;
  /** コマあたりの台詞要素数上限。既定 4、最大 8。 */
  maxDialoguesPerPanel?: number;
  /** 1ページあたりのコマ数上限。既定 6。 */
  maxPanelsPerPage?: number;
}

/**
 * ビート化 N1 の出力を検証し、beat→unit→element の決定的展開で ScriptMangaPlan を組み立てる。
 * 検証: 全ビート一度ずつ・順序保存・シーン純度・splash 単独・コマ内台詞文字量上限。
 * 展開により既存の「全台詞一度ずつ」契約と ScriptMangaPlan の形は不変に保たれる。
 * 失敗時は null(呼び出し側が再試行 → 従来 N1 → 決定的プランナーへフォールバック)。
 */
export function applyBeatPageNaming(raw: unknown, context: BeatPageNamingContext): ScriptMangaPlan | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as BeatPageNamingResult).pages)) return null;
  const named = raw as BeatPageNamingResult;
  const beatById = new Map(context.beats.map((beat) => [beat.id, beat]));
  const unitById = new Map(context.units.map((unit) => [unit.id, unit]));
  const expectedBeatIds = context.beats.map((beat) => beat.id);
  const observedBeatIds: string[] = [];
  const maxDialogueCharacters = Math.max(40, Math.trunc(context.maxDialogueCharactersPerPanel ?? 260));
  const maxDialogues = Math.max(1, Math.min(8, Math.trunc(context.maxDialoguesPerPanel ?? 4)));
  const panelLimit = normalizeMaxPanelsPerPage(context.maxPanelsPerPage);
  const minPages = Math.max(1, Math.floor(context.targetPageCount * 0.8));
  const maxPages = Math.max(minPages, Math.ceil(context.targetPageCount * 1.2));
  if (named.pages.length < minPages || named.pages.length > maxPages) return null;
  const stylePrompt = context.stylePrompt?.trim() || DEFAULT_SCRIPT_MANGA_STYLE;
  const panelIds = new Set<string>();
  const pages: ScriptMangaPagePlan[] = [];
  let dialogueCount = 0;
  for (let pageIndex = 0; pageIndex < named.pages.length; pageIndex += 1) {
    const page = named.pages[pageIndex];
    if (!page || page.index !== pageIndex || !page.pageIntent?.trim() || !Array.isArray(page.panels) || page.panels.length < 1 || page.panels.length > panelLimit) return null;
    if (page.turnHook !== undefined && !["reveal", "cliffhanger", "none"].includes(page.turnHook)) return null;
    if (page.panels.some((panel) => panel.importance === "splash") && page.panels.length !== 1) return null;
    if (!scriptMangaLayoutCandidates(page.panels.length).length) return null;
    const panels: ScriptMangaPanelPlan[] = [];
    for (const namedPanel of page.panels) {
      if (!namedPanel?.id || panelIds.has(namedPanel.id) || !["splash", "hero", "normal"].includes(namedPanel.importance)) return null;
      if (!Array.isArray(namedPanel.sourceBeatIds) || namedPanel.sourceBeatIds.length === 0) return null;
      const beats = namedPanel.sourceBeatIds.map((beatId) => beatById.get(beatId));
      if (beats.some((beat) => !beat)) return null;
      const concreteBeats = beats as AnnotatedBeat[];
      const maybeUnits = concreteBeats.flatMap((beat) => beat.unitIds.map((unitId) => unitById.get(unitId)));
      if (maybeUnits.some((unit) => !unit)) return null;
      const unitsOfPanel = maybeUnits as PreLayoutUnit[];
      // コマはシーンを跨がない(ビート自体もシーン純度検証済みだが、束ねた結果も確認する)。
      if (new Set(unitsOfPanel.map((unit) => unit.sceneIndex)).size !== 1) return null;
      const dialogueUnits = unitsOfPanel.filter((unit) => unit.type === "dialogue");
      const dialogueCharacters = dialogueUnits.reduce((sum, unit) => sum + unit.dialogueCharacters, 0);
      if (dialogueUnits.length > maxDialogues) return null;
      if (dialogueCharacters > maxDialogueCharacters) return null;
      // V5 D1 hard規則(ビート由来の決定的検査):
      // keepAlone ビートは他ビートと同居不可 / large以上の希望ビートを1コマへ複数束ねない /
      // splash希望ビートは単独コマ・単独ページ。
      if (concreteBeats.length > 1 && concreteBeats.some((beat) => beat.keepAlone)) return null;
      if (concreteBeats.filter((beat) => beat.preferredScale === "large" || beat.preferredScale === "splash").length > 1) return null;
      if (concreteBeats.some((beat) => beat.preferredScale === "splash") && (concreteBeats.length > 1 || page.panels.length !== 1)) return null;
      observedBeatIds.push(...namedPanel.sourceBeatIds);
      panelIds.add(namedPanel.id);
      dialogueCount += dialogueUnits.length;
      const first = unitsOfPanel[0]!;
      const sceneContext = first.sceneHeading ? `Scene: ${first.sceneHeading}.` : "";
      const visualParts = unitsOfPanel.map((unit) => unit.visualText).filter(Boolean);
      const sourceElementIds: string[] = [];
      for (const unit of unitsOfPanel) {
        if (sourceElementIds[sourceElementIds.length - 1] !== unit.elementId) sourceElementIds.push(unit.elementId);
      }
      panels.push({
        id: namedPanel.id,
        sceneIndex: first.sceneIndex,
        sceneHeading: first.sceneHeading,
        sourceElementIds,
        prompt: `${stylePrompt}. ${sceneContext} ${visualParts.join(" ")}`.replace(/\s+/g, " ").trim(),
        sourceText: unitsOfPanel.map((unit) => unit.text).join("\n"),
        dialogueOrderIndexes: dialogueUnits.map((unit) => unit.dialogueOrderIndex!),
        importance: namedPanel.importance,
        // V5 D1 P1a: 旧N1スキーマが生きている間は importance 出力を新語彙へ写すシム
        // (P1bでビート由来の derivePanelVisualScale へ置換する)。
        visualScale: visualScaleFromImportance(namedPanel.importance),
        sourceBeatIds: [...namedPanel.sourceBeatIds]
      });
    }
    // V5 D1 hard規則: 1ページの large(hero)コマは2つまで(プロンプトの "one or two" を決定的に固定)。
    if (panels.filter((panel) => panel.importance === "hero").length > 2) return null;
    const layoutTemplateId = selectScriptMangaLayoutId(panels.map((panel) => panel.importance ?? "normal"))
      ?? scriptMangaLayoutCandidates(panels.length)[0]!;
    pages.push({
      index: pageIndex,
      title: panels[0]!.sceneHeading || `Page ${pageIndex + 1}`,
      layoutTemplateId,
      pageIntent: page.pageIntent.trim(),
      ...(page.turnHook !== undefined ? { turnHook: page.turnHook } : {}),
      panels
    });
  }
  if (observedBeatIds.length !== expectedBeatIds.length || observedBeatIds.some((beatId, index) => beatId !== expectedBeatIds[index])) return null;
  return {
    title: context.title,
    pages,
    panelCount: pages.reduce((sum, page) => sum + page.panels.length, 0),
    dialogueCount
  };
}

/** panelsPerPage を JSON Schema にも反映し、LLM 側の構造化出力で超過を許さない。 */
export function createBeatPageNamingSchema(maxPanelsPerPage = 6) {
  return {
    type: "object", additionalProperties: false, required: ["pages"], properties: { pages: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["index", "pageIntent", "turnHook", "panels"], properties: {
        index: { type: "integer" }, pageIntent: { type: "string" }, turnHook: { type: "string", enum: ["reveal", "cliffhanger", "none"] },
        panels: { type: "array", minItems: 1, maxItems: normalizeMaxPanelsPerPage(maxPanelsPerPage), items: { type: "object", additionalProperties: false,
          required: ["id", "importance", "sourceBeatIds"], properties: { id: { type: "string" },
            importance: { type: "string", enum: ["splash", "hero", "normal"] }, sourceBeatIds: { type: "array", minItems: 1, items: { type: "string" } } } } }
      }
    } } }
  } as const;
}

/** panelsPerPage を JSON Schema にも反映し、従来 N1 経路にも同じ上限を課す。 */
export function createPageNamingSchema(maxPanelsPerPage = 6) {
  return {
    type: "object", additionalProperties: false, required: ["pages"], properties: { pages: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["index", "pageIntent", "turnHook", "panels"], properties: {
        index: { type: "integer" }, pageIntent: { type: "string" }, turnHook: { type: "string", enum: ["reveal", "cliffhanger", "none"] },
        panels: { type: "array", minItems: 1, maxItems: normalizeMaxPanelsPerPage(maxPanelsPerPage), items: { type: "object", additionalProperties: false,
          required: ["id", "importance", "sourcePanelIds"], properties: { id: { type: "string" },
            importance: { type: "string", enum: ["splash", "hero", "normal"] }, sourcePanelIds: { type: "array", minItems: 1, items: { type: "string" } } } } }
      }
    } } }
  } as const;
}

/** 後方互換用の既定(最大6コマ)スキーマ。N1 呼び出しでは動的 factory を使う。 */
export const BEAT_PAGE_NAMING_SCHEMA = createBeatPageNamingSchema();
export const PAGE_NAMING_SCHEMA = createPageNamingSchema();
