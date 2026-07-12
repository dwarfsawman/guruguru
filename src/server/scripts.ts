/**
 * MangaScript / ScriptRevision(Docs/Feature-ScriptToManga.md S3): Fountain 取り込み・再取り込み。
 * 脚本原文と parse 結果は不変保存(script_revisions、再取り込みは新 revision の追加)。
 * 再取り込みは source_hash(正規化 speaker+text)で差分照合し、一致行は維持(配置無傷)、新規行は追加、
 * 対応が消えた行は status='orphaned'(自動削除しない。後の revision で復活可)。
 * `pages.ts` が手本(ドメインロジック分離)。
 */
import { createHash } from "node:crypto";
import type { FountainDoc } from "../shared/fountain";
import { parseFountain } from "../shared/fountain";
import type { DialogueBalloonStyle, DialogueLine, DialogueSemanticKind, MangaScript, ScriptImportResult, ScriptRevision } from "../shared/apiTypes";
import { createId, getRow, getRows, runSql, toApiRow, toApiRows } from "./db";
import { HttpError } from "./http";
import { findOrCreateCharacterByLabel } from "./characters";
import { objectBody, requiredString, stringOr } from "./validate";

interface DialogueLineRow {
  id: string;
  project_id: string;
  script_id: string | null;
  character_id: string | null;
  speaker_label: string;
  text: string;
  semantic_kind: string;
  balloon_style: string;
  order_index: number;
  scene_index: number | null;
  source_hash: string | null;
  status: string;
}

function requireProject(projectId: string) {
  const project = getRow("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
}

function requireScript(scriptId: string): MangaScript {
  const row = toApiRow(getRow("SELECT * FROM manga_scripts WHERE id = ?", [scriptId])) as unknown as MangaScript | null;
  if (!row) {
    throw new HttpError(404, "Script was not found");
  }
  return row;
}

export function listScripts(projectId: string): MangaScript[] {
  requireProject(projectId);
  const rows = getRows("SELECT * FROM manga_scripts WHERE project_id = ? ORDER BY created_at ASC", [projectId]);
  return toApiRows(rows) as unknown as MangaScript[];
}

export function getScript(scriptId: string): MangaScript {
  return requireScript(scriptId);
}

export function deleteScript(scriptId: string) {
  requireScript(scriptId);
  runSql("DELETE FROM manga_scripts WHERE id = ?", [scriptId]);
  return { deleted: true, scriptId };
}

export function listScriptRevisions(scriptId: string): ScriptRevision[] {
  requireScript(scriptId);
  const rows = getRows("SELECT * FROM script_revisions WHERE script_id = ? ORDER BY revision ASC", [scriptId]);
  return toApiRows(rows) as unknown as ScriptRevision[];
}

export function getScriptRevision(scriptId: string, revision: number): ScriptRevision {
  requireScript(scriptId);
  const row = toApiRow(
    getRow("SELECT * FROM script_revisions WHERE script_id = ? AND revision = ?", [scriptId, revision])
  ) as unknown as ScriptRevision | null;
  if (!row) {
    throw new HttpError(404, "Script revision was not found");
  }
  return row;
}

function normalizedHash(speaker: string, text: string): string {
  return createHash("sha1").update(`${speaker.trim()}\u0000${text.trim()}`).digest("hex");
}

interface FlatDialogue {
  sceneIndex: number;
  speakerLabel: string;
  text: string;
  parenthetical?: string;
}

function flattenDialogueElements(doc: FountainDoc): FlatDialogue[] {
  const out: FlatDialogue[] = [];
  doc.scenes.forEach((scene, sceneIndex) => {
    for (const element of scene.elements) {
      if (element.type === "dialogue") {
        const item: FlatDialogue = { sceneIndex, speakerLabel: element.speaker, text: element.text };
        if (element.parenthetical !== undefined) {
          item.parenthetical = element.parenthetical;
        }
        out.push(item);
      }
    }
  });
  return out;
}

/**
 * parenthetical (M)/(N) → monologue/narration、`SFX:` 接頭辞 → sfx(接頭辞は本文から除去する)。
 * それ以外は既定 dialogue。
 */
export function resolveDialoguePresentation(
  speakerLabel: string,
  parenthetical: string | undefined,
  rawText: string
): { semanticKind: DialogueSemanticKind; balloonStyle: DialogueBalloonStyle; text: string } {
  const trimmedParen = parenthetical?.trim().toUpperCase();
  if (trimmedParen === "(M)") {
    return { semanticKind: "monologue", balloonStyle: "thought", text: rawText };
  }
  if (trimmedParen === "(N)") {
    return { semanticKind: "narration", balloonStyle: "caption", text: rawText };
  }
  const trimmedText = rawText.trim();
  if (/^SFX:/i.test(trimmedText)) {
    return { semanticKind: "sfx", balloonStyle: "sfx", text: trimmedText.replace(/^SFX:\s*/i, "") };
  }
  if (/^《[^》]+》$/u.test(trimmedText) || /(?:機械音声|システム|アナウンス|computer|system)/iu.test(speakerLabel)) {
    return { semanticKind: "dialogue", balloonStyle: "machine", text: rawText };
  }
  const parentheticalText = (parenthetical ?? "").replace(/[()（）]/g, "").trim();
  if (/(?:V\.O\.|Ｖ\.Ｏ\.|記憶|記録|回想)/iu.test(parentheticalText)) {
    return { semanticKind: "dialogue", balloonStyle: "vo", text: rawText };
  }
  if (/(?:通信|無線|拡声|スピーカー)/u.test(`${speakerLabel} ${parentheticalText}`)) {
    return { semanticKind: "dialogue", balloonStyle: "telecom", text: rawText };
  }
  return { semanticKind: "dialogue", balloonStyle: "normal", text: rawText };
}

/**
 * 新規取り込み・再取り込み共通の差分適用。source_hash で既存行(そのスクリプトの全行、
 * status 不問)と照合し、一致は order_index/scene_index を更新して維持(配置は line_id 経由で無傷)、
 * 新規は追加、対応が消えた既存行は orphaned にする。同一 hash が複数ある場合は出現順(FIFO)で対応させる。
 */
function applyScriptRevisionDiff(projectId: string, scriptId: string, doc: FountainDoc): void {
  const flat = flattenDialogueElements(doc);
  const existingRows = getRows<DialogueLineRow>(
    "SELECT * FROM dialogue_lines WHERE script_id = ? ORDER BY order_index ASC",
    [scriptId]
  );

  const queues = new Map<string, string[]>();
  for (const row of existingRows) {
    const hash = row.source_hash ?? "";
    const queue = queues.get(hash) ?? [];
    queue.push(row.id);
    queues.set(hash, queue);
  }

  const claimed = new Set<string>();
  flat.forEach((item, index) => {
    const { semanticKind, balloonStyle, text } = resolveDialoguePresentation(item.speakerLabel, item.parenthetical, item.text);
    const hash = normalizedHash(item.speakerLabel, text);
    const queue = queues.get(hash);
    const existingId = queue && queue.length > 0 ? queue.shift() : undefined;
    if (existingId) {
      claimed.add(existingId);
      runSql(
        "UPDATE dialogue_lines SET order_index = ?, scene_index = ?, semantic_kind = ?, balloon_style = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [index, item.sceneIndex, semanticKind, balloonStyle, existingId]
      );
      return;
    }
    const character = findOrCreateCharacterByLabel(projectId, item.speakerLabel);
    const id = createId("line");
    runSql(
      `INSERT INTO dialogue_lines
         (id, project_id, script_id, character_id, speaker_label, text, semantic_kind, balloon_style, order_index, scene_index, source_hash, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'fountain')`,
      [id, projectId, scriptId, character.id, item.speakerLabel, text, semanticKind, balloonStyle, index, item.sceneIndex, hash]
    );
    claimed.add(id);
  });

  for (const row of existingRows) {
    if (!claimed.has(row.id) && row.status !== "orphaned") {
      runSql("UPDATE dialogue_lines SET status = 'orphaned', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
    }
  }
}

function scriptDialogueLines(scriptId: string): DialogueLine[] {
  const rows = getRows("SELECT * FROM dialogue_lines WHERE script_id = ? ORDER BY order_index ASC", [scriptId]);
  return toApiRows(rows) as unknown as DialogueLine[];
}

/** `POST /api/projects/:id/scripts` { title?, fountainSource }。 */
export function createScript(projectId: string, body: unknown): ScriptImportResult {
  requireProject(projectId);
  const input = objectBody(body);
  const fountainSource = requiredString(input.fountainSource, "fountainSource");
  const { doc, warnings } = parseFountain(fountainSource);
  const title = stringOr(input.title, "") || doc.titlePage.Title || "";

  const scriptId = createId("script");
  runSql("INSERT INTO manga_scripts (id, project_id, title) VALUES (?, ?, ?)", [scriptId, projectId, title]);

  const revisionId = createId("rev");
  runSql(
    `INSERT INTO script_revisions (id, script_id, revision, fountain_source, parsed_json, warnings_json)
     VALUES (?, ?, 1, ?, ?, ?)`,
    [revisionId, scriptId, fountainSource, JSON.stringify(doc), JSON.stringify(warnings)]
  );

  applyScriptRevisionDiff(projectId, scriptId, doc);

  return {
    script: requireScript(scriptId),
    revision: getScriptRevision(scriptId, 1),
    lines: scriptDialogueLines(scriptId)
  };
}

/** `POST /api/scripts/:id/revisions` { fountainSource }(再取り込み。全削除しない)。 */
export function addScriptRevision(scriptId: string, body: unknown): ScriptImportResult {
  const script = requireScript(scriptId);
  const input = objectBody(body);
  const fountainSource = requiredString(input.fountainSource, "fountainSource");
  const { doc, warnings } = parseFountain(fountainSource);

  const nextRevision =
    (getRow<{ next: number }>("SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM script_revisions WHERE script_id = ?", [
      scriptId
    ])?.next ?? 1);

  const revisionId = createId("rev");
  runSql(
    `INSERT INTO script_revisions (id, script_id, revision, fountain_source, parsed_json, warnings_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [revisionId, scriptId, nextRevision, fountainSource, JSON.stringify(doc), JSON.stringify(warnings)]
  );

  applyScriptRevisionDiff(script.projectId, scriptId, doc);

  return {
    script: requireScript(scriptId),
    revision: getScriptRevision(scriptId, nextRevision),
    lines: scriptDialogueLines(scriptId)
  };
}
