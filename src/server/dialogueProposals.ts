/**
 * DialogueProposal(構造化 LLM セリフ提案、Docs/Feature-ScriptToManga.md S4)。ページのコマ構成・
 * シーン文脈・キャラクタ口調から DialogueProvider(openaiCompatibleDialogueProvider)へ提案を依頼し、
 * 生出力・モデル名・脚本 revision・項目別の採用履歴を dialogue_proposals へ永続化する。
 * 採用(adopt)は dialogue_lines(source='llm', proposal_id)を作るのみ -- 配置(placement)は S3 の
 * 手動配置フロー(ドロワー)に合流させる(このモジュールでは placement を作らない)。
 * LLM 呼び出しの成否に関わらず提案行は必ず作成する(失敗時は status='failed' + error。API は
 * HttpError を投げず、常に proposal を返す -- クライアントが status を見てトースト表示する)。
 * `pages.ts` / `scripts.ts` が手本(ドメインロジック分離)。
 */
import type {
  DialogueLine,
  DialogueProposal,
  DialogueProposalItem
} from "../shared/apiTypes";
import type { FountainDoc } from "../shared/fountain";
import type { PageLayout } from "../shared/pageLayout";
import { createId, getRow, getRows, runSql, toApiRow } from "./db";
import { HttpError } from "./http";
import { type ChatMessage, getLlmSettings, isLlmConfigured } from "./llm";
import { StructuredJsonError } from "./llmStructured";
import { openaiCompatibleDialogueProvider } from "./dialogue/openaiCompatibleDialogueProvider";
import type { DialoguePromptPanel } from "./dialogue/prompt";
import { findOrCreateCharacterByLabel, listCharacters } from "./characters";
import { getScript, listScriptRevisions } from "./scripts";
import { listDialogueLines } from "./dialogueLines";
import { objectBody } from "./validate";

interface ProposalRow {
  id: string;
  project_id: string;
  script_id: string | null;
  script_revision_id: string | null;
  page_id: string | null;
  model: string;
  request_json: string;
  raw_output: string | null;
  items_json: string | null;
  status: "proposed" | "resolved" | "failed";
  error: string | null;
  created_at: string;
}

interface PageRowForProposal {
  id: string;
  project_id: string;
  page_index: number;
  layout_json: string | null;
}

function requireProject(projectId: string) {
  const project = getRow("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
}

function requirePageRow(projectId: string, pageId: string): PageRowForProposal {
  const row = getRow<PageRowForProposal>("SELECT id, project_id, page_index, layout_json FROM pages WHERE id = ?", [pageId]);
  if (!row || row.project_id !== projectId) {
    throw new HttpError(404, "Page was not found");
  }
  return row;
}

function requireProposalRow(proposalId: string): ProposalRow {
  const row = getRow<ProposalRow>("SELECT * FROM dialogue_proposals WHERE id = ?", [proposalId]);
  if (!row) {
    throw new HttpError(404, "Dialogue proposal was not found");
  }
  return row;
}

function parseItems(itemsJson: string | null): DialogueProposalItem[] {
  if (!itemsJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(itemsJson) as unknown;
    return Array.isArray(parsed) ? (parsed as DialogueProposalItem[]) : [];
  } catch {
    return [];
  }
}

/** 当該脚本の最新 revision id(脚本無し/revision無しなら null)。 */
function latestRevisionIdForScript(scriptId: string | null): string | null {
  if (!scriptId) {
    return null;
  }
  const revisions = listScriptRevisions(scriptId);
  return revisions.length > 0 ? revisions[revisions.length - 1]!.id : null;
}

function toProposalView(row: ProposalRow): DialogueProposal {
  const latestRevisionId = latestRevisionIdForScript(row.script_id);
  const isStale = Boolean(row.script_revision_id) && row.script_revision_id !== latestRevisionId;
  return {
    id: row.id,
    projectId: row.project_id,
    scriptId: row.script_id,
    scriptRevisionId: row.script_revision_id,
    pageId: row.page_id,
    model: row.model,
    request: JSON.parse(row.request_json) as unknown,
    rawOutput: row.raw_output,
    items: row.items_json ? parseItems(row.items_json) : null,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    isStale
  };
}

function proposalView(proposalId: string): DialogueProposal {
  return toProposalView(requireProposalRow(proposalId));
}

/** `GET /api/projects/:id/dialogue-proposals?pageId=` */
export function listDialogueProposals(projectId: string, options: { pageId?: string } = {}): DialogueProposal[] {
  requireProject(projectId);
  const clauses = ["project_id = ?"];
  const params: unknown[] = [projectId];
  if (options.pageId) {
    clauses.push("page_id = ?");
    params.push(options.pageId);
  }
  const rows = getRows<ProposalRow>(`SELECT * FROM dialogue_proposals WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`, params);
  return rows.map(toProposalView);
}

/** シーン抜粋(中心シーン ± 1)。プレーンテキストで LLM プロンプトへそのまま埋め込む。 */
function renderSceneExcerpt(doc: FountainDoc, centerIndex: number): string {
  if (doc.scenes.length === 0) {
    return "";
  }
  const center = Math.min(Math.max(centerIndex, 0), doc.scenes.length - 1);
  const start = Math.max(0, center - 1);
  const end = Math.min(doc.scenes.length - 1, center + 1);
  const parts: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const scene = doc.scenes[i];
    if (!scene) {
      continue;
    }
    parts.push(`${i === center ? "★" : ""}[${scene.heading}]`);
    for (const element of scene.elements) {
      if (element.type === "action") {
        parts.push(element.text);
      } else if (element.type === "dialogue") {
        parts.push(`${element.speaker}: ${element.text}`);
      } else if (element.type === "transition") {
        parts.push(`(${element.text})`);
      }
    }
  }
  return parts.join("\n");
}

/**
 * ページに対応するシーンの推定。dialogue_lines は scene_index を持つが page_id を持たないため、
 * 「そのページに既に配置済みのセリフ」(dialogue_placements 経由)の scene_index の最頻値を使う。
 * 未配置なら Book 内のページ位置比率からシーン番号を線形に推定するベストエフォート
 * (脚本とページ割りが厳密対応する保証は無い。設計書に明示の対応関係が無いための実装判断。
 * ズレは UI 上のシーン抜粋プレビューで人間が気づける)。
 */
function resolveSceneIndexForPage(page: PageRowForProposal, scriptId: string, doc: FountainDoc): number {
  if (doc.scenes.length === 0) {
    return 0;
  }
  const placedSceneIndices = getRows<{ scene_index: number | null }>(
    `SELECT dl.scene_index AS scene_index FROM dialogue_placements dp
     JOIN dialogue_lines dl ON dl.id = dp.line_id
     WHERE dp.page_id = ? AND dl.script_id = ? AND dl.scene_index IS NOT NULL`,
    [page.id, scriptId]
  );
  if (placedSceneIndices.length > 0) {
    const counts = new Map<number, number>();
    for (const row of placedSceneIndices) {
      const idx = row.scene_index as number;
      counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
    let best = placedSceneIndices[0]!.scene_index as number;
    let bestCount = -1;
    for (const [idx, count] of counts) {
      if (count > bestCount) {
        best = idx;
        bestCount = count;
      }
    }
    return Math.min(best, doc.scenes.length - 1);
  }
  const totalPages =
    getRow<{ count: number }>("SELECT COUNT(*) AS count FROM pages WHERE project_id = ?", [page.project_id])?.count ?? 1;
  const ratio = totalPages > 1 ? page.page_index / (totalPages - 1) : 0;
  return Math.min(doc.scenes.length - 1, Math.round(ratio * (doc.scenes.length - 1)));
}

function resolveDefaultScriptId(projectId: string): string | null {
  const row = getRow<{ id: string }>("SELECT id FROM manga_scripts WHERE project_id = ? ORDER BY created_at ASC LIMIT 1", [projectId]);
  return row?.id ?? null;
}

/**
 * LLM 提案の panelId をこのページの `layout.panels` 実在チェックに掛ける。不正なら黙殺せず
 * console.warn した上で null に落とす(dialogue_placements.requirePanelExists と同じ方針、
 * ただし提案は panelId が「無くても意味のある案」なので 400 では弾かず null化に留める)。
 */
function sanitizeProposalItemPanelId(
  item: DialogueProposalItem,
  pageId: string,
  validPanelIds: ReadonlySet<string>
): DialogueProposalItem {
  if (item.panelId && !validPanelIds.has(item.panelId)) {
    console.warn(`[dialogueProposals] LLM proposed an unknown panelId=${item.panelId} for pageId=${pageId}; falling back to null`);
    return { ...item, panelId: null };
  }
  return item;
}

/** `POST /api/projects/:id/pages/:pageId/dialogue-proposals` { scriptId?, instruction? }(60s timeout)。 */
export async function createDialogueProposal(projectId: string, pageId: string, body: unknown): Promise<{ proposal: DialogueProposal }> {
  requireProject(projectId);
  const page = requirePageRow(projectId, pageId);
  const input = objectBody(body);
  const settings = getLlmSettings();
  if (!isLlmConfigured(settings)) {
    throw new HttpError(400, "OpenAI互換プロンプト接続が設定されていません。");
  }

  const scriptId = typeof input.scriptId === "string" && input.scriptId.trim() ? input.scriptId.trim() : resolveDefaultScriptId(projectId);
  if (!scriptId) {
    throw new HttpError(400, "この機能を使うには脚本を取り込んでください。");
  }
  const script = getScript(scriptId);
  if (script.projectId !== projectId) {
    throw new HttpError(400, "scriptId does not belong to this project");
  }
  const revisions = listScriptRevisions(scriptId);
  const revision = revisions[revisions.length - 1];
  if (!revision) {
    throw new HttpError(400, "この脚本にはまだ取り込んだ内容がありません。");
  }
  const doc = revision.parsed;

  const layout: PageLayout | null = page.layout_json ? (JSON.parse(page.layout_json) as PageLayout) : null;
  const panels: DialoguePromptPanel[] = layout
    ? layout.panels.map((panel) => ({ id: panel.id, order: panel.order })).sort((a, b) => a.order - b.order)
    : [];
  const validPanelIds = new Set(panels.map((panel) => panel.id));
  const characters = listCharacters(projectId).map((character) => ({
    name: character.name,
    notes: character.notes,
    aliases: character.aliases ?? []
  }));
  const existingLines = listDialogueLines(projectId, { pageId }).map((line) => ({
    speakerName: line.speakerLabel,
    text: line.text
  }));
  const sceneIndex = resolveSceneIndexForPage(page, scriptId, doc);
  const sceneExcerpt = renderSceneExcerpt(doc, sceneIndex);
  const instruction = typeof input.instruction === "string" && input.instruction.trim() ? input.instruction.trim() : undefined;

  const id = createId("proposal");
  try {
    const result = await openaiCompatibleDialogueProvider.suggest({
      sceneExcerpt,
      panels,
      characters,
      existingLines,
      ...(instruction ? { instruction } : {}),
      settings
    });
    const items = result.items.map((item) => sanitizeProposalItemPanelId(item, pageId, validPanelIds));
    runSql(
      `INSERT INTO dialogue_proposals
         (id, project_id, script_id, script_revision_id, page_id, model, request_json, raw_output, items_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
      [id, projectId, scriptId, revision.id, pageId, result.model, JSON.stringify(result.messages), result.rawOutput, JSON.stringify(items)]
    );
  } catch (error) {
    const messages: ChatMessage[] = error instanceof StructuredJsonError ? error.messages : [];
    const rawOutput = error instanceof StructuredJsonError ? error.rawOutput : null;
    const errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    runSql(
      `INSERT INTO dialogue_proposals
         (id, project_id, script_id, script_revision_id, page_id, model, request_json, raw_output, items_json, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'failed', ?)`,
      [id, projectId, scriptId, revision.id, pageId, settings.model, JSON.stringify(messages), rawOutput, errorMessage]
    );
  }

  return { proposal: proposalView(id) };
}

function parseItemIndices(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function parseEdits(raw: unknown): Map<number, string> {
  const out = new Map<number, string>();
  if (!Array.isArray(raw)) {
    return out;
  }
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const index = (entry as Record<string, unknown>).index;
    const text = (entry as Record<string, unknown>).text;
    if (typeof index === "number" && Number.isInteger(index) && typeof text === "string" && text.trim()) {
      out.set(index, text.trim());
    }
  }
  return out;
}

/**
 * `POST /api/dialogue-proposals/:id/adopt` { itemIndices, edits? }。採用項目は
 * `dialogue_lines(source='llm', proposal_id)` を作る(character_id は aliases 突合、無ければ自動作成)。
 * 範囲外/既に処理済みの index は黙って無視する(冪等: 二重送信に耐える)。
 */
export function adoptDialogueProposalItems(proposalId: string, body: unknown): { proposal: DialogueProposal; lines: DialogueLine[] } {
  const row = requireProposalRow(proposalId);
  const input = objectBody(body);
  const itemIndices = parseItemIndices(input.itemIndices);
  if (itemIndices.length === 0) {
    throw new HttpError(400, "itemIndices is required");
  }
  const edits = parseEdits(input.edits);
  const items = parseItems(row.items_json);

  const nextOrderBase =
    getRow<{ next: number }>("SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM dialogue_lines WHERE project_id = ?", [
      row.project_id
    ])?.next ?? 0;

  const createdLines: DialogueLine[] = [];
  let orderOffset = 0;
  for (const index of itemIndices) {
    const item = items[index];
    if (!item || item.itemStatus !== "proposed") {
      continue;
    }
    const editedText = edits.get(index);
    const finalText = editedText ?? item.text;
    const character = findOrCreateCharacterByLabel(row.project_id, item.speakerName);
    const lineId = createId("line");
    runSql(
      `INSERT INTO dialogue_lines
         (id, project_id, script_id, character_id, speaker_label, text, semantic_kind, emotion, order_index, source, status, proposal_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'llm', 'active', ?)`,
      [
        lineId,
        row.project_id,
        row.script_id,
        character.id,
        item.speakerName,
        finalText,
        item.semanticKind,
        item.emotion ?? null,
        nextOrderBase + orderOffset,
        proposalId
      ]
    );
    orderOffset += 1;
    item.itemStatus = "adopted";
    item.adoptedLineId = lineId;
    if (editedText) {
      item.editedText = editedText;
    }
    const lineRow = toApiRow(getRow("SELECT * FROM dialogue_lines WHERE id = ?", [lineId])) as unknown as DialogueLine;
    createdLines.push(lineRow);
  }

  const allResolved = items.length > 0 && items.every((item) => item.itemStatus !== "proposed");
  runSql("UPDATE dialogue_proposals SET items_json = ?, status = ? WHERE id = ?", [
    JSON.stringify(items),
    allResolved ? "resolved" : row.status,
    proposalId
  ]);

  return { proposal: proposalView(proposalId), lines: createdLines };
}

/** `POST /api/dialogue-proposals/:id/reject` { itemIndices? }(省略 = 残り全部)。 */
export function rejectDialogueProposalItems(proposalId: string, body: unknown): { proposal: DialogueProposal } {
  const row = requireProposalRow(proposalId);
  const input = objectBody(body);
  const items = parseItems(row.items_json);
  const itemIndices = input.itemIndices === undefined ? items.map((_, index) => index) : parseItemIndices(input.itemIndices);

  for (const index of itemIndices) {
    const item = items[index];
    if (item && item.itemStatus === "proposed") {
      item.itemStatus = "rejected";
    }
  }

  const allResolved = items.length > 0 && items.every((item) => item.itemStatus !== "proposed");
  runSql("UPDATE dialogue_proposals SET items_json = ?, status = ? WHERE id = ?", [
    JSON.stringify(items),
    allResolved ? "resolved" : row.status,
    proposalId
  ]);

  return { proposal: proposalView(proposalId) };
}
