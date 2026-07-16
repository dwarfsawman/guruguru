import type { FountainDoc } from "./fountain";
import { builtinLayoutPanelCount } from "./layoutPresets";
import { MANGA_VISUAL_SCALES, type MangaVisualScale, normalizeLegacyVisualScale } from "./mangaPlanV2";
import {
  planScriptManga,
  type ScriptMangaPanelDirection,
  type ScriptMangaPanelPlan,
  type ScriptMangaPlan
} from "./scriptMangaPlan";
import { isJsonObject } from "./json";

export type ScriptMangaLayoutPanelCountResolver = (layoutTemplateId: string) => number | null | undefined;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === "string" && entry.trim() ? [entry.trim()] : []);
}

function identityNames(key: string, value: unknown): string[] {
  const names = [key];
  if (!isJsonObject(value)) return names;
  names.push(...stringList(value.name), ...stringList(value.names), ...stringList(value.alias), ...stringList(value.aliases));
  return names;
}

function identityForPanel(plan: Record<string, unknown>, subject: string): string {
  if (!isJsonObject(plan.characterBible)) return "";
  const bible = plan.characterBible;
  const normalizedSubject = subject.toLocaleLowerCase();
  const entries: string[] = [];
  const continuity = text(bible.visualContinuity);
  if (continuity) entries.push(continuity);
  for (const [key, value] of Object.entries(bible)) {
    if (key === "visualContinuity") continue;
    const matches = identityNames(key, value).some((name) => normalizedSubject.includes(name.toLocaleLowerCase()));
    if (!matches) continue;
    if (isJsonObject(value)) entries.push(`${key}: ${JSON.stringify(value)}`);
  }
  return entries.length > 0 ? `CHARACTER LOCK — ${entries.join("; ")}. ` : "";
}

const DIRECTION_KEYS = ["shot", "subject", "action", "emotion", "composition"] as const;

function optionalDirectionStrings(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const values = value.map(text);
  return values.every(Boolean) ? values : null;
}

function optionalDirectionSubjects(
  value: unknown
): ScriptMangaPanelDirection["subjects"] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const subjects: NonNullable<ScriptMangaPanelDirection["subjects"]> = [];
  for (const raw of value) {
    if (!isJsonObject(raw)) return null;
    const ref = text(raw.ref);
    const position = text(raw.position);
    const action = text(raw.action);
    const expression = text(raw.expression);
    const gaze = raw.gaze === undefined ? undefined : text(raw.gaze);
    if (!ref || !position || !action || !expression || (raw.gaze !== undefined && !gaze)) return null;
    subjects.push({ ref, position, action, expression, ...(gaze ? { gaze } : {}) });
  }
  return subjects;
}

function panelDirection(panel: Record<string, unknown>): ScriptMangaPanelDirection | null | undefined {
  const hasNested = Object.hasOwn(panel, "direction");
  const source = hasNested ? panel.direction : panel;
  if (source === undefined) return undefined;
  if (!isJsonObject(source)) return null;
  if (!hasNested && !DIRECTION_KEYS.every((key) => Object.hasOwn(source, key))) return undefined;
  const values = Object.fromEntries(DIRECTION_KEYS.map((key) => [key, text(source[key])])) as unknown as ScriptMangaPanelDirection;
  if (!DIRECTION_KEYS.every((key) => values[key])) return null;
  const angle = source.angle === undefined ? undefined : text(source.angle);
  const subjects = optionalDirectionSubjects(source.subjects);
  const avoid = optionalDirectionStrings(source.avoid);
  if ((source.angle !== undefined && !angle) || subjects === null || avoid === null) return null;
  return {
    ...values,
    ...(angle ? { angle } : {}),
    ...(subjects !== undefined ? { subjects } : {}),
    ...(avoid !== undefined ? { avoid } : {})
  };
}

function sourceElementIds(panel: Record<string, unknown>): string[] | null {
  if (panel.sourceElementIds === undefined) return [];
  if (!Array.isArray(panel.sourceElementIds)) return null;
  const ids = panel.sourceElementIds.map(text);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
  return ids;
}

/** optional な enum フィールド(ネームv4 D1 の importance/turnHook)。未指定は undefined、不正は null。 */
function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** 外部LLM/サブエージェントで作ったネームを、全台詞保持とlayout整合を確認して実行可能planへ変換する。 */
export function validateProvidedScriptMangaPlan(
  doc: FountainDoc,
  raw: unknown,
  resolveLayoutPanelCount: ScriptMangaLayoutPanelCountResolver = builtinLayoutPanelCount
): ScriptMangaPlan | null {
  if (!isJsonObject(raw) || !Array.isArray(raw.pages) || raw.pages.length === 0 || raw.pages.length > 200) return null;
  const expectedDialogueCount = planScriptManga(doc).dialogueCount;
  const dialogueSeen = new Set<number>();
  const panelIds = new Set<string>();
  let panelCount = 0;

  const pages = raw.pages.flatMap((rawPage, pageIndex) => {
    if (!isJsonObject(rawPage) || (rawPage.index !== pageIndex && rawPage.index !== pageIndex + 1) || !Array.isArray(rawPage.panels)) return [];
    const layoutTemplateId = text(rawPage.layoutTemplateId);
    if (resolveLayoutPanelCount(layoutTemplateId) !== rawPage.panels.length) return [];
    const panels: ScriptMangaPanelPlan[] = [];
    for (const rawPanel of rawPage.panels) {
      if (!isJsonObject(rawPanel)) return [];
      const id = text(rawPanel.id);
      const prompt = text(rawPanel.prompt);
      const sourceText = text(rawPanel.sourceText);
      const sceneIndex = typeof rawPanel.sceneIndex === "number" ? Math.trunc(rawPanel.sceneIndex) : -1;
      if (!id || panelIds.has(id) || !prompt || !sourceText || sceneIndex < 0 || sceneIndex >= doc.scenes.length) return [];
      const sourceIds = sourceElementIds(rawPanel);
      const direction = panelDirection(rawPanel);
      // V5 D1: 旧語彙(importance)と新語彙(visualScale)の両方を受理する(providedはDB非経由の
      // 生API入力なので、ここが normalizeLegacyVisualScale の適用境界のひとつ)。保存は visualScale のみ。
      const importance = optionalEnum(rawPanel.importance, ["splash", "hero", "normal"] as const);
      const visualScale = optionalEnum(rawPanel.visualScale, MANGA_VISUAL_SCALES);
      if (sourceIds === null || direction === null || importance === null || visualScale === null) return [];
      const resolvedScale: MangaVisualScale | undefined =
        normalizeLegacyVisualScale({ importance, visualScale });
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
        sourceElementIds: sourceIds,
        prompt: `${identityForPanel(raw, direction?.subject ?? text(rawPanel.subject))}${prompt}`,
        sourceText,
        dialogueOrderIndexes: indexes,
        ...(direction ? { direction } : {}),
        ...(resolvedScale ? { visualScale: resolvedScale } : {})
      });
    }
    const turnHook = optionalEnum(rawPage.turnHook, ["reveal", "cliffhanger", "none"] as const);
    if (turnHook === null) return [];
    panelCount += panels.length;
    const pageIntent = text(rawPage.pageIntent);
    return [{
      index: pageIndex,
      title: text(rawPage.title) || `Page ${pageIndex + 1}`,
      layoutTemplateId,
      panels,
      ...(pageIntent ? { pageIntent } : {}),
      ...(turnHook ? { turnHook } : {})
    }];
  });
  if (pages.length !== raw.pages.length || panelCount === 0 || panelCount > 800 || dialogueSeen.size !== expectedDialogueCount) return null;
  for (let index = 0; index < expectedDialogueCount; index += 1) if (!dialogueSeen.has(index)) return null;
  return { title: text(raw.title) || doc.titlePage.Title || "Manga", pages, panelCount, dialogueCount: expectedDialogueCount };
}
