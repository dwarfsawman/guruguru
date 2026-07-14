/**
 * コマ割りテンプレート(漫画パネルレイアウト)の登録・一覧・解決・エクスポート。
 *
 * 内蔵プリセット(`LAYOUT_PRESETS`、コード側)と、ユーザーが取り込んだ `.guruguru-layout.json5`
 * (`layout_templates` テーブル)をマージして提供する。取り込み時はここで `JSON5.parse` してから
 * 純ロジックの `normalizeGuruguruLayoutPages` で `PageLayout` へ正規化する(json5 依存はサーバに閉じる)。
 *
 * ネームv4 D6(SPEC v0.3): 見開きはページ毎に分割取り込み、`autoManga.candidate:true` の
 * 取り込みテンプレは自動漫画のレイアウト候補プールへ参加する(`refreshScriptMangaLayoutCandidates`)。
 * エクスポートは取り込み原文(source_json5)を基点に未対応フィールドを温存する(§27.2 SHOULD)。
 */
import JSON5 from "json5";
import type { LayoutTemplateSummary } from "../shared/apiTypes";
import {
  LAYOUT_PRESETS,
  describeScriptMangaLayouts,
  emphasizedSlotIndex,
  findLayoutPreset,
  layoutAreaProfile,
  scriptMangaLayoutCandidates,
  setExternalScriptMangaLayouts,
  type ScriptMangaExternalLayout
} from "../shared/layoutPresets";
import { normalizeEditedPageLayout, normalizeGuruguruLayoutPages, type PageLayout, type PageLayoutAutoManga } from "../shared/pageLayout";
import {
  GURUGURU_LAYOUT_SCHEMA_VERSION,
  guruguruLayoutFromPage,
  guruguruLayoutFromPageLayout,
  type ExportPageBalloon
} from "../shared/pageLayoutExport";
import { normalizePageObjects, type BalloonObject, type TextObject } from "../shared/pageObjects";
import { orderPanelsByReadingDirection } from "../shared/dialogueAutoLayout";
import { createId, getRow, getRows, runSql } from "./db";
import { HttpError } from "./http";
import { objectBody, stringOr } from "./validate";

interface LayoutTemplateRow {
  id: string;
  name: string;
  layout_json: string;
  source_json5?: string | null;
  created_at: string;
}

function builtinSummaries(): LayoutTemplateSummary[] {
  return LAYOUT_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    source: "builtin",
    layout: preset.layout
  }));
}

function parseStoredLayout(row: LayoutTemplateRow): PageLayout | null {
  try {
    return JSON.parse(row.layout_json) as PageLayout;
  } catch {
    return null;
  }
}

/** 内蔵 + 取り込み(新しい順)をマージして返す。 */
export function listLayoutTemplates(): LayoutTemplateSummary[] {
  const importedRows = getRows<LayoutTemplateRow>(
    "SELECT id, name, layout_json, created_at FROM layout_templates WHERE deleted_at IS NULL ORDER BY created_at DESC"
  );
  const imported: LayoutTemplateSummary[] = [];
  for (const row of importedRows) {
    const layout = parseStoredLayout(row);
    if (layout) {
      imported.push({ id: row.id, name: row.name, source: "imported", layout, createdAt: String(row.created_at) });
    }
  }
  return [...builtinSummaries(), ...imported];
}

/**
 * 取り込みテンプレの自動漫画候補プール(ネームv4 D6)を最新化する。サーバ起動時と
 * 取り込み/削除後に呼ぶ。参加は `autoManga.candidate:true` のみ、参加要件
 * (コマ数1〜6・rect/polygon)は shared 側 `setExternalScriptMangaLayouts` が検証する。
 * 並びは取り込みの古い順(候補配列は「末尾へ追加」規約 — 既定=内蔵先頭の互換維持)。
 */
export function refreshScriptMangaLayoutCandidates(): void {
  const rows = getRows<LayoutTemplateRow>(
    "SELECT id, name, layout_json, created_at FROM layout_templates WHERE deleted_at IS NULL ORDER BY created_at ASC"
  );
  const entries: ScriptMangaExternalLayout[] = [];
  for (const row of rows) {
    const layout = parseStoredLayout(row);
    const autoManga = layout?.source?.autoManga;
    if (!layout || !autoManga?.candidate) continue;
    entries.push({
      id: row.id,
      name: row.name,
      layout,
      ...(autoManga.description ? { description: autoManga.description } : {}),
      ...(autoManga.emphasisPanelIds?.length ? { emphasisPanelIds: autoManga.emphasisPanelIds } : {})
    });
  }
  setExternalScriptMangaLayouts(entries);
}

export interface LayoutTemplateImportResult {
  template: LayoutTemplateSummary;
  /** 見開き分割時は全ページ分(先頭が template と同一)。単ページは1件。 */
  templates: LayoutTemplateSummary[];
}

/**
 * `.guruguru-layout.json5` を取り込んで登録する。body = `{ json5: string, name?: string }`。
 * 見開き(複数ページ)はページ毎に分割して登録する(SPEC §27.2 MAY)。
 * パース/正規化/座標検証(bleedOvershoot、SPEC §11.2)に失敗したら 400。
 */
export function importLayoutTemplate(body: unknown): LayoutTemplateImportResult {
  const input = objectBody(body);
  const rawText = stringOr(input.json5 ?? input.text ?? input.content, "");
  if (!rawText.trim()) {
    throw new HttpError(400, "レイアウトファイルの内容が空です。");
  }

  let parsed: unknown;
  try {
    parsed = JSON5.parse(rawText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, `JSON5 として解析できませんでした: ${detail}`);
  }

  let pages: ReturnType<typeof normalizeGuruguruLayoutPages>;
  try {
    pages = normalizeGuruguruLayoutPages(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, `レイアウトとして取り込めませんでした: ${detail}`);
  }

  const baseName = deriveName(stringOr(input.name, ""), pages[0]!.layout);
  const templates: LayoutTemplateSummary[] = [];
  pages.forEach((page, index) => {
    const name = pages.length > 1 ? `${baseName} (${index + 1}/${pages.length})` : baseName;
    const id = createId("layout");
    runSql(
      "INSERT INTO layout_templates (id, name, source, layout_json, source_json5) VALUES (?, ?, 'imported', ?, ?)",
      [id, name, JSON.stringify(page.layout), rawText]
    );
    const row = getRow<LayoutTemplateRow>(
      "SELECT id, name, layout_json, created_at FROM layout_templates WHERE id = ?",
      [id]
    );
    templates.push({
      id,
      name,
      source: "imported",
      layout: page.layout,
      createdAt: row ? String(row.created_at) : undefined
    });
  });
  refreshScriptMangaLayoutCandidates();
  return { template: templates[0]!, templates };
}

function deriveName(explicit: string, layout: PageLayout): string {
  const candidate = explicit.trim() || layout.source?.title?.trim() || "";
  return candidate || "取り込みレイアウト";
}

/** 取り込みテンプレのソフト削除(内蔵は不可)。 */
export function deleteLayoutTemplate(id: string): { deleted: true; id: string } {
  if (id.startsWith("builtin:")) {
    throw new HttpError(400, "内蔵テンプレートは削除できません。");
  }
  const row = getRow("SELECT id FROM layout_templates WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!row) {
    throw new HttpError(404, "レイアウトテンプレートが見つかりません。");
  }
  runSql("UPDATE layout_templates SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  refreshScriptMangaLayoutCandidates();
  return { deleted: true, id };
}

/** id からレイアウトを解決する(内蔵/取り込みの両対応)。ページ作成時に使う。 */
export function resolveLayoutTemplate(id: string): PageLayout | null {
  const preset = findLayoutPreset(id);
  if (preset) {
    return preset.layout;
  }
  const row = getRow<LayoutTemplateRow>(
    "SELECT id, name, layout_json, created_at FROM layout_templates WHERE id = ? AND deleted_at IS NULL",
    [id]
  );
  return row ? parseStoredLayout(row) : null;
}

// --- エクスポート(ネームv4 D6 / SPEC v0.3 §27) ---

export interface LayoutTemplateExportResult {
  filename: string;
  json5: string;
}

function sanitizeFilename(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|\s]+/gu, "-").replace(/^-+|-+$/gu, "");
  return cleaned || "layout";
}

/**
 * 内蔵候補の autoManga メタデータ(規格リポジトリへのサンプル還元用)。自動漫画の候補プールに
 * 参加している内蔵のみ candidate:true、説明は LLM向け記述、emphasis は面積最大スロットの panel id。
 */
function builtinAutoManga(id: string, layout: PageLayout): PageLayoutAutoManga | null {
  const candidate = scriptMangaLayoutCandidates(layout.panels.length).includes(id);
  if (!candidate) return null;
  const description = describeScriptMangaLayouts([id])[0]?.description;
  const areas = layoutAreaProfile(id);
  const slot = areas ? emphasizedSlotIndex(areas) : null;
  const emphasisPanelId = slot !== null
    ? orderPanelsByReadingDirection(layout.panels, layout.readingDirection)[slot]?.id
    : undefined;
  return {
    candidate: true,
    ...(description ? { description } : {}),
    ...(emphasisPanelId ? { emphasisPanelIds: [emphasisPanelId] } : {})
  };
}

/**
 * テンプレートのエクスポート。取り込みテンプレは保存済み原文(source_json5)を基点に
 * schemaVersion だけ v0.3 へ引き上げて未対応フィールドを温存する(§27.2 SHOULD)。
 * 見開き分割由来(source.pageId あり)は原文が複数ページのため、正規化済みレイアウトから
 * 単ページとして書き出す(未対応フィールドは失われる — §27.3 の許容範囲)。
 */
export function exportLayoutTemplate(id: string): LayoutTemplateExportResult {
  const preset = findLayoutPreset(id);
  if (preset) {
    const root = guruguruLayoutFromPageLayout(preset.layout, {
      title: preset.name,
      autoManga: builtinAutoManga(id, preset.layout)
    });
    return {
      filename: `${sanitizeFilename(id.replace(/^builtin:/u, ""))}.guruguru-layout.json5`,
      json5: JSON5.stringify(root, null, 2)
    };
  }
  const row = getRow<LayoutTemplateRow>(
    "SELECT id, name, layout_json, source_json5, created_at FROM layout_templates WHERE id = ? AND deleted_at IS NULL",
    [id]
  );
  if (!row) throw new HttpError(404, "レイアウトテンプレートが見つかりません。");
  const layout = parseStoredLayout(row);
  if (!layout) throw new HttpError(500, "保存されているレイアウトが壊れています。");
  const filename = `${sanitizeFilename(row.name)}.guruguru-layout.json5`;
  if (row.source_json5 && !layout.source?.pageId) {
    try {
      const original = JSON5.parse(row.source_json5) as Record<string, unknown>;
      original.schemaVersion = GURUGURU_LAYOUT_SCHEMA_VERSION;
      return { filename, json5: JSON5.stringify(original, null, 2) };
    } catch {
      // 原文が壊れている場合は正規化済みレイアウトからの書き出しへフォールバックする。
    }
  }
  const root = guruguruLayoutFromPageLayout(layout, {
    title: row.name,
    autoManga: layout.source?.autoManga ?? null
  });
  return { filename, json5: JSON5.stringify(root, null, 2) };
}

/**
 * ページの現在の状態(コマ枠+吹き出し+テキスト)を `.guruguru-layout.json5` へ書き出す
 * (ネームv4 D6)。吹き出しの所属コマ・読み順・話者は dialogue_placements/lines から写す。
 * `plainText` は MUST、ルビ(`content`)は初期実装では出さない(SPEC §17 MAY)。
 */
export function exportPageLayout(projectId: string, pageId: string): LayoutTemplateExportResult {
  const page = getRow<{ id: string; title: string; page_index: number; layout_json: string | null; objects_json: string | null }>(
    "SELECT id, title, page_index, layout_json, objects_json FROM pages WHERE id = ? AND project_id = ?",
    [pageId, projectId]
  );
  if (!page) throw new HttpError(404, "ページが見つかりません。");
  const layout = page.layout_json ? normalizeEditedPageLayout(JSON.parse(page.layout_json)) : null;
  if (!layout) throw new HttpError(400, "このページにはコマ割りレイアウトがありません。");
  const objects = normalizePageObjects(page.objects_json ? JSON.parse(page.objects_json) : []);
  const placements = getRows<{
    balloon_object_id: string;
    panel_id: string | null;
    order_key: number | null;
    character_id: string | null;
  }>(
    `SELECT p.balloon_object_id, p.panel_id, COALESCE(p.order_index_override, l.order_index) AS order_key, l.character_id
     FROM dialogue_placements p JOIN dialogue_lines l ON l.id = p.line_id
     WHERE p.page_id = ? AND p.balloon_object_id IS NOT NULL`,
    [pageId]
  );
  const placementByObject = new Map(placements.map((placement) => [placement.balloon_object_id, placement]));
  const balloons: ExportPageBalloon[] = objects
    .filter((object): object is BalloonObject => object.kind === "balloon")
    .map((object, index) => {
      const placement = placementByObject.get(object.id);
      return {
        object,
        panelId: placement?.panel_id ?? null,
        orderIndex: placement?.order_key ?? 1_000_000 + index,
        characterId: placement?.character_id ?? null
      };
    });
  const texts = objects.filter((object): object is TextObject => object.kind === "text");
  const title = page.title?.trim() || `Page ${page.page_index + 1}`;
  const root = guruguruLayoutFromPage(layout, balloons, texts, { title });
  return {
    filename: `${sanitizeFilename(title)}.guruguru-layout.json5`,
    json5: JSON5.stringify(root, null, 2)
  };
}
