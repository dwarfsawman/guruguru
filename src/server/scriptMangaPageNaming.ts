import { scriptMangaLayoutCandidates } from "../shared/layoutPresets";
import type { ScriptMangaPagePlan, ScriptMangaPanelPlan, ScriptMangaPlan } from "../shared/scriptMangaPlan";

export type PanelImportance = "splash" | "hero" | "normal";
export type TurnHook = "reveal" | "cliffhanger" | "none";
export interface PageNamingPanel { id: string; importance: PanelImportance; sourcePanelIds: string[] }
export interface PageNamingPage { index: number; pageIntent: string; turnHook?: TurnHook; panels: PageNamingPanel[] }
export interface PageNamingResult { pages: PageNamingPage[] }

function flatten(plan: ScriptMangaPlan): ScriptMangaPanelPlan[] { return plan.pages.flatMap((page) => page.panels); }

/** N1契約を検証してScriptMangaPlanへ適用する。失敗時はnullで決定的packerへ戻せる。 */
export function applyPageNaming(raw: unknown, source: ScriptMangaPlan, targetPageCount: number): ScriptMangaPlan | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as PageNamingResult).pages)) return null;
  const named = raw as PageNamingResult;
  const sourcePanels = flatten(source);
  const byId = new Map(sourcePanels.map((panel) => [panel.id, panel]));
  const expectedIds = sourcePanels.map((panel) => panel.id);
  const observedIds: string[] = [];
  const minPages = Math.max(1, Math.floor(targetPageCount * 0.8));
  const maxPages = Math.max(minPages, Math.ceil(targetPageCount * 1.2));
  if (named.pages.length < minPages || named.pages.length > maxPages) return null;
  const pages: ScriptMangaPagePlan[] = [];
  for (let pageIndex = 0; pageIndex < named.pages.length; pageIndex += 1) {
    const page = named.pages[pageIndex];
    if (!page || page.index !== pageIndex || !page.pageIntent?.trim() || !Array.isArray(page.panels) || page.panels.length < 1 || page.panels.length > 6) return null;
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
      observedIds.push(...namedPanel.sourcePanelIds);
      panels.push({
        ...concrete[0]!, id: namedPanel.id,
        sourceElementIds: concrete.flatMap((panel) => panel.sourceElementIds),
        sourceText: concrete.map((panel) => panel.sourceText).join("\n"),
        prompt: concrete.map((panel) => panel.prompt).join(" "),
        dialogueOrderIndexes: concrete.flatMap((panel) => panel.dialogueOrderIndexes)
      });
    }
    pages.push({ index: pageIndex, title: panels[0]!.sceneHeading || `Page ${pageIndex + 1}`,
      layoutTemplateId: scriptMangaLayoutCandidates(panels.length)[0]!, pageIntent: page.pageIntent.trim(), panels });
  }
  if (observedIds.length !== expectedIds.length || observedIds.some((id, index) => id !== expectedIds[index])) return null;
  return { ...source, pages, panelCount: pages.reduce((sum, page) => sum + page.panels.length, 0) };
}

export const PAGE_NAMING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["pages"], properties: { pages: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["index", "pageIntent", "turnHook", "panels"], properties: {
      index: { type: "integer" }, pageIntent: { type: "string" }, turnHook: { type: "string", enum: ["reveal", "cliffhanger", "none"] },
      panels: { type: "array", minItems: 1, maxItems: 6, items: { type: "object", additionalProperties: false,
        required: ["id", "importance", "sourcePanelIds"], properties: { id: { type: "string" },
          importance: { type: "string", enum: ["splash", "hero", "normal"] }, sourcePanelIds: { type: "array", minItems: 1, items: { type: "string" } } } } }
    }
  } } }
} as const;
