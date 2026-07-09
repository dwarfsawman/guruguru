/**
 * コマ割りテンプレート(漫画パネルレイアウト)の登録・一覧・解決。
 *
 * 内蔵プリセット(`LAYOUT_PRESETS`、コード側)と、ユーザーが取り込んだ `.guruguru-layout.json5`
 * (`layout_templates` テーブル)をマージして提供する。取り込み時はここで `JSON5.parse` してから
 * 純ロジックの `normalizeGuruguruLayout` で `PageLayout` へ正規化する(json5 依存はサーバに閉じる)。
 */
import JSON5 from "json5";
import type { LayoutTemplateSummary } from "../shared/apiTypes";
import { LAYOUT_PRESETS, findLayoutPreset } from "../shared/layoutPresets";
import { normalizeGuruguruLayout, type PageLayout } from "../shared/pageLayout";
import { createId, getRow, getRows, runSql } from "./db";
import { HttpError } from "./http";
import { objectBody, stringOr } from "./validate";

interface LayoutTemplateRow {
  id: string;
  name: string;
  layout_json: string;
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
 * `.guruguru-layout.json5` を取り込んで登録する。body = `{ json5: string, name?: string }`。
 * パース/正規化に失敗したら 400(分かりやすいメッセージ)。
 */
export function importLayoutTemplate(body: unknown): LayoutTemplateSummary {
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

  let layout: PageLayout;
  try {
    layout = normalizeGuruguruLayout(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, `レイアウトとして取り込めませんでした: ${detail}`);
  }

  const name = deriveName(stringOr(input.name, ""), layout);
  const id = createId("layout");
  runSql(
    "INSERT INTO layout_templates (id, name, source, layout_json, source_json5) VALUES (?, ?, 'imported', ?, ?)",
    [id, name, JSON.stringify(layout), rawText]
  );
  const row = getRow<LayoutTemplateRow>(
    "SELECT id, name, layout_json, created_at FROM layout_templates WHERE id = ?",
    [id]
  );
  return {
    id,
    name,
    source: "imported",
    layout,
    createdAt: row ? String(row.created_at) : undefined
  };
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
