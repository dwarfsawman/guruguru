import type { FountainDoc } from "./fountain";
import { planScriptManga, type ScriptMangaPanelPlan, type ScriptMangaPlan } from "./scriptMangaPlan";
import { isJsonObject } from "./json";

const LAYOUT_PANEL_COUNTS: Record<string, number> = {
  "builtin:splash": 1,
  "builtin:two-horizontal": 2,
  "builtin:two-vertical": 2,
  "builtin:three-horizontal": 3,
  "builtin:three-hero-top": 3,
  "builtin:four-grid": 4,
  "builtin:four-hero-bottom": 4,
  "builtin:four-vertical-hero": 4
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function identityForPanel(plan: Record<string, unknown>, panel: Record<string, unknown>): string {
  if (!isJsonObject(plan.characterBible)) return "";
  const bible = plan.characterBible;
  const subject = text(panel.subject).toLowerCase();
  const aliases: Array<[string[], string]> = [
    [["adult alice", "アリス"], "アリス・キサラギ（現在）"],
    [["16-year-old alice", "young alice", "少女アリス"], "少女アリス（8年前）"],
    [["mira", "ミラ"], "ミラ"], [["kain", "カイン"], "カイン・レイヴン"],
    [["shido", "シドウ"], "シドウ博士"], [["gen", "ゲン"], "ゲン"],
    [["white rabbit", "白い機体"], "WHITE RABBIT"], [["red queen", "赤い少女"], "RED QUEEN"],
    [["president", "総裁"], "AEGIS総裁"], [["aegis soldier", "兵士"], "AEGIS兵"],
    [["beast", "獣型"], "獣型兵器"]
  ];
  const entries: string[] = [];
  const continuity = text(bible.visualContinuity);
  if (continuity) entries.push(continuity);
  for (const [needles, key] of aliases) {
    if (!needles.some((needle) => subject.includes(needle))) continue;
    const value = bible[key];
    if (isJsonObject(value)) entries.push(`${key}: ${JSON.stringify(value)}`);
  }
  return entries.length > 0 ? `CHARACTER LOCK — ${entries.join("; ")}. ` : "";
}

/** 外部LLM/サブエージェントで作ったネームを、全台詞保持とlayout整合を確認して実行可能planへ変換する。 */
export function validateProvidedScriptMangaPlan(doc: FountainDoc, raw: unknown): ScriptMangaPlan | null {
  if (!isJsonObject(raw) || !Array.isArray(raw.pages) || raw.pages.length === 0 || raw.pages.length > 200) return null;
  const expectedDialogueCount = planScriptManga(doc).dialogueCount;
  const dialogueSeen = new Set<number>();
  const panelIds = new Set<string>();
  let panelCount = 0;

  const pages = raw.pages.flatMap((rawPage, pageIndex) => {
    if (!isJsonObject(rawPage) || (rawPage.index !== pageIndex && rawPage.index !== pageIndex + 1) || !Array.isArray(rawPage.panels)) return [];
    const layoutTemplateId = text(rawPage.layoutTemplateId);
    if (LAYOUT_PANEL_COUNTS[layoutTemplateId] !== rawPage.panels.length) return [];
    const panels: ScriptMangaPanelPlan[] = [];
    for (const rawPanel of rawPage.panels) {
      if (!isJsonObject(rawPanel)) return [];
      const id = text(rawPanel.id);
      const prompt = text(rawPanel.prompt);
      const sourceText = text(rawPanel.sourceText);
      const sceneIndex = typeof rawPanel.sceneIndex === "number" ? Math.trunc(rawPanel.sceneIndex) : -1;
      if (!id || panelIds.has(id) || !prompt || !sourceText || sceneIndex < 0 || sceneIndex >= doc.scenes.length) return [];
      if (!Array.isArray(rawPanel.dialogueOrderIndexes)) return [];
      const indexes: number[] = [];
      for (const value of rawPanel.dialogueOrderIndexes) {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= expectedDialogueCount || dialogueSeen.has(value)) return [];
        dialogueSeen.add(value);
        indexes.push(value);
      }
      panelIds.add(id);
      panels.push({
        id,
        sceneIndex,
        sceneHeading: text(rawPanel.sceneHeading),
        prompt: `${identityForPanel(raw, rawPanel)}${prompt}`,
        sourceText,
        dialogueOrderIndexes: indexes
      });
    }
    panelCount += panels.length;
    return [{ index: pageIndex, title: text(rawPage.title) || `Page ${pageIndex + 1}`, layoutTemplateId, panels }];
  });
  if (pages.length !== raw.pages.length || panelCount === 0 || panelCount > 800 || dialogueSeen.size !== expectedDialogueCount) return null;
  for (let index = 0; index < expectedDialogueCount; index += 1) if (!dialogueSeen.has(index)) return null;
  return { title: text(raw.title) || doc.titlePage.Title || "Manga", pages, panelCount, dialogueCount: expectedDialogueCount };
}
