/**
 * DialogueLine(物語上の台詞)CRUD + DialoguePlacement(ページ上の配置、Docs/Feature-ScriptToManga.md S3)。
 * placement 作成は「吹き出し生成と対」: pages.objects_json へ PageObject(balloon/box/text、
 * `sourceDialogueLineId` 付き)を追加し、`dialogue_placements.balloon_object_id` で双方向リンクする。
 * `pages.ts` が手本(ドメインロジック分離)。
 */
import type { DialogueLine, DialoguePlacement, DialogueRenderKind, DialogueSemanticKind, CreatePlacementResult } from "../shared/apiTypes";
import { panelBounds } from "../shared/pageLayout";
import {
  DEFAULT_TEXT_STYLE,
  PAGE_OBJECTS_MAX_COUNT,
  createBalloonObject,
  createBoxObject,
  createTextObject,
  normalizePageObjects,
  type PageObject
} from "../shared/pageObjects";
import { createId, getRow, getRows, runSql, toApiRow, toApiRows } from "./db";
import { HttpError } from "./http";
import { objectBody, requiredString, stringOr } from "./validate";

const SEMANTIC_KINDS = new Set<DialogueSemanticKind>(["dialogue", "monologue", "narration", "sfx"]);
const RENDER_KINDS = new Set<DialogueRenderKind>(["balloon", "caption", "freeText"]);

function requireProject(projectId: string) {
  const project = getRow("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
}

function requireDialogueLine(lineId: string): DialogueLine {
  const row = toApiRow(getRow("SELECT * FROM dialogue_lines WHERE id = ?", [lineId])) as unknown as DialogueLine | null;
  if (!row) {
    throw new HttpError(404, "Dialogue line was not found");
  }
  return row;
}

interface ListDialogueLinesOptions {
  pageId?: string;
  scriptId?: string;
  status?: string;
}

/**
 * `GET /api/projects/:id/dialogue-lines?pageId=&scriptId=&status=`。`pageId` は
 * dialogue_placements 経由(そのページに1件以上配置済みの行)で絞り込む
 * (dialogue_lines 自体は page_id を持たない -- ページ割当は placement の作成そのもの)。
 */
export function listDialogueLines(projectId: string, options: ListDialogueLinesOptions = {}): DialogueLine[] {
  requireProject(projectId);
  const clauses = ["project_id = ?"];
  const params: unknown[] = [projectId];
  if (options.scriptId) {
    clauses.push("script_id = ?");
    params.push(options.scriptId);
  }
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.pageId) {
    clauses.push("id IN (SELECT line_id FROM dialogue_placements WHERE page_id = ?)");
    params.push(options.pageId);
  }
  const rows = getRows(
    `SELECT * FROM dialogue_lines WHERE ${clauses.join(" AND ")} ORDER BY order_index ASC, created_at ASC`,
    params
  );
  return toApiRows(rows) as unknown as DialogueLine[];
}

/** 手動でのセリフ行追加(script_id は NULL。source='manual')。 */
export function createDialogueLine(projectId: string, body: unknown): DialogueLine {
  requireProject(projectId);
  const input = objectBody(body);
  const text = requiredString(input.text, "text");
  const semanticKind: DialogueSemanticKind = SEMANTIC_KINDS.has(input.semanticKind as DialogueSemanticKind)
    ? (input.semanticKind as DialogueSemanticKind)
    : "dialogue";
  const nextOrder =
    getRow<{ next: number }>("SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM dialogue_lines WHERE project_id = ?", [
      projectId
    ])?.next ?? 0;
  const id = createId("line");
  const characterId = typeof input.characterId === "string" && input.characterId.trim() ? input.characterId.trim() : null;
  runSql(
    `INSERT INTO dialogue_lines
       (id, project_id, script_id, character_id, speaker_label, text, semantic_kind, emotion, order_index, source, status)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'manual', 'active')`,
    [id, projectId, characterId, stringOr(input.speakerLabel, ""), text, semanticKind, stringOr(input.emotion, "") || null, nextOrder]
  );
  return requireDialogueLine(id);
}

export function updateDialogueLine(lineId: string, body: unknown): DialogueLine {
  const existing = requireDialogueLine(lineId);
  const input = objectBody(body);
  const text = typeof input.text === "string" && input.text.trim() ? input.text : existing.text;
  const semanticKind: DialogueSemanticKind = SEMANTIC_KINDS.has(input.semanticKind as DialogueSemanticKind)
    ? (input.semanticKind as DialogueSemanticKind)
    : existing.semanticKind;
  const characterId =
    input.characterId === null
      ? null
      : typeof input.characterId === "string" && input.characterId.trim()
        ? input.characterId.trim()
        : existing.characterId;
  const emotion = input.emotion === null ? null : typeof input.emotion === "string" ? input.emotion || null : existing.emotion;
  const status = input.status === "active" || input.status === "orphaned" ? input.status : existing.status;
  runSql(
    `UPDATE dialogue_lines
     SET text = ?, semantic_kind = ?, character_id = ?, emotion = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [text, semanticKind, characterId, emotion, status, lineId]
  );
  return requireDialogueLine(lineId);
}

export function deleteDialogueLine(lineId: string) {
  requireDialogueLine(lineId);
  runSql("DELETE FROM dialogue_lines WHERE id = ?", [lineId]);
  return { deleted: true, lineId };
}

// --- DialoguePlacement ---

interface PageRowForPlacement {
  id: string;
  project_id: string;
  layout_json: string | null;
  objects_json: string | null;
}

function requirePageRow(pageId: string): PageRowForPlacement {
  const row = getRow<PageRowForPlacement>("SELECT id, project_id, layout_json, objects_json FROM pages WHERE id = ?", [pageId]);
  if (!row) {
    throw new HttpError(404, "Page was not found");
  }
  return row;
}

function pageCenter(page: PageRowForPlacement, panelId: string | null): { x: number; y: number } {
  if (!page.layout_json) {
    return { x: 0.5, y: 0.7 };
  }
  let layout: { page: { height: number }; panels: Array<{ id: string; shape: unknown }> };
  try {
    layout = JSON.parse(page.layout_json) as typeof layout;
  } catch {
    return { x: 0.5, y: 0.7 };
  }
  if (panelId) {
    const panel = layout.panels.find((item) => item.id === panelId);
    if (panel) {
      const [x0, y0, x1, y1] = panelBounds(panel.shape as Parameters<typeof panelBounds>[0]);
      return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    }
  }
  return { x: 0.5, y: layout.page.height / 2 };
}

function requirePanelExists(page: PageRowForPlacement, panelId: string) {
  if (!page.layout_json) {
    throw new HttpError(400, "This page has no layout to place a panel-scoped placement in");
  }
  let layout: { panels: Array<{ id: string }> };
  try {
    layout = JSON.parse(page.layout_json) as typeof layout;
  } catch {
    throw new HttpError(400, "This page's layout is invalid");
  }
  if (!layout.panels.some((panel) => panel.id === panelId)) {
    throw new HttpError(400, "panelId was not found in this Page's layout");
  }
}

/**
 * `dialogue_placements` の1行を API 型へ変換する。`auto_layout_locked` は INTEGER(0/1)なので
 * `toApiRow` の自動変換(単純 snake→camel、型変換なし)の後に boolean へ直す
 * (`pasteAttachments.ts` の `enabled` と同じパターン)。
 */
function placementRow(placementId: string): DialoguePlacement {
  const row = toApiRow(getRow("SELECT * FROM dialogue_placements WHERE id = ?", [placementId])) as unknown as
    | (DialoguePlacement & { autoLayoutLocked: unknown })
    | null;
  if (!row) {
    throw new HttpError(404, "Dialogue placement was not found");
  }
  return { ...row, autoLayoutLocked: Boolean(row.autoLayoutLocked) };
}

/**
 * `POST /api/dialogue-lines/:id/placements` { pageId, panelId?, renderKind? }。
 * placement 作成+吹き出し(または caption/freeText)生成を対で行う。1台詞を複数吹き出しへ
 * 分割配置できるよう `part_index` はその行の既存 placement 件数を採番する。
 */
export function createDialoguePlacement(lineId: string, body: unknown): CreatePlacementResult {
  const line = requireDialogueLine(lineId);
  const input = objectBody(body);
  const pageId = requiredString(input.pageId, "pageId");
  const page = requirePageRow(pageId);
  if (page.project_id !== line.projectId) {
    throw new HttpError(400, "pageId does not belong to this line's project");
  }
  const panelId = typeof input.panelId === "string" && input.panelId.trim() ? input.panelId.trim() : null;
  if (panelId) {
    requirePanelExists(page, panelId);
  }
  const renderKind: DialogueRenderKind = RENDER_KINDS.has(input.renderKind as DialogueRenderKind)
    ? (input.renderKind as DialogueRenderKind)
    : "balloon";

  const objects = normalizePageObjects(page.objects_json ? JSON.parse(page.objects_json) : []);
  if (objects.length >= PAGE_OBJECTS_MAX_COUNT) {
    throw new HttpError(400, `ページオブジェクトの上限(${PAGE_OBJECTS_MAX_COUNT})に達しています。`);
  }

  const center = pageCenter(page, panelId);
  const objectId = createId("obj");
  const text = line.text;
  let newObject: PageObject;
  if (renderKind === "balloon") {
    const balloon = createBalloonObject(objectId, center);
    balloon.content = { text, style: { ...DEFAULT_TEXT_STYLE } };
    newObject = balloon;
  } else if (renderKind === "caption") {
    const box = createBoxObject(objectId, center);
    box.content = { text, style: { ...DEFAULT_TEXT_STYLE } };
    newObject = box;
  } else {
    newObject = createTextObject(objectId, center, text);
  }
  newObject.sourceDialogueLineId = lineId;

  const nextObjects = normalizePageObjects([...objects, newObject]);
  runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify(nextObjects),
    pageId
  ]);

  const partIndex =
    getRow<{ next: number }>("SELECT COUNT(*) AS next FROM dialogue_placements WHERE line_id = ?", [lineId])?.next ?? 0;
  const placementId = createId("place");
  runSql(
    `INSERT INTO dialogue_placements (id, line_id, page_id, panel_id, part_index, render_kind, balloon_object_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [placementId, lineId, pageId, panelId, partIndex, renderKind, objectId]
  );

  return { placement: placementRow(placementId), objects: nextObjects };
}

export function updateDialoguePlacement(placementId: string, body: unknown): DialoguePlacement {
  const existing = placementRow(placementId);
  const input = objectBody(body);
  const page = requirePageRow(existing.pageId);
  const panelId =
    input.panelId === null
      ? null
      : typeof input.panelId === "string" && input.panelId.trim()
        ? input.panelId.trim()
        : existing.panelId;
  if (panelId) {
    requirePanelExists(page, panelId);
  }
  const renderKind: DialogueRenderKind = RENDER_KINDS.has(input.renderKind as DialogueRenderKind)
    ? (input.renderKind as DialogueRenderKind)
    : existing.renderKind;
  runSql(
    "UPDATE dialogue_placements SET panel_id = ?, render_kind = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [panelId, renderKind, placementId]
  );
  return placementRow(placementId);
}

/**
 * placement 削除。対応する PageObject(balloon_object_id)もページから取り除く
 * (placement は「吹き出し生成と対」で作られるため、削除も対で行う)。
 */
export function deleteDialoguePlacement(placementId: string) {
  const existing = placementRow(placementId);
  if (existing.balloonObjectId) {
    const page = requirePageRow(existing.pageId);
    const objects = normalizePageObjects(page.objects_json ? JSON.parse(page.objects_json) : []);
    const nextObjects = objects.filter((object) => object.id !== existing.balloonObjectId);
    if (nextObjects.length !== objects.length) {
      runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
        JSON.stringify(nextObjects),
        existing.pageId
      ]);
    }
  }
  runSql("DELETE FROM dialogue_placements WHERE id = ?", [placementId]);
  return { deleted: true, placementId };
}

/**
 * レイアウト変更/コマ削除時の後始末(Docs/Feature-ScriptToManga.md S3)。`pages.ts` の
 * `updatePageLayout` から、残った panel id 集合を渡して呼ぶ。消えたコマへの placement は
 * panel_id を NULL 化する(placement 自体・balloon は消さない -- ページ中央扱いに落ちるだけ)。
 */
export function clearOrphanedPlacementPanelIds(pageId: string, validPanelIds: ReadonlySet<string>): void {
  const rows = getRows<{ id: string; panel_id: string | null }>(
    "SELECT id, panel_id FROM dialogue_placements WHERE page_id = ? AND panel_id IS NOT NULL",
    [pageId]
  );
  for (const row of rows) {
    if (row.panel_id && !validPanelIds.has(row.panel_id)) {
      runSql("UPDATE dialogue_placements SET panel_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
    }
  }
}
