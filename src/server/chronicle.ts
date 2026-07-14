/**
 * Chronicle Page Flow(S5、Docs/Done/Feature-ChroniclePageFlow.md §3)。フェーズI: GET のみ
 * (取得・Beat 構築の配線)。一括割り当て/自動配置はフェーズII 以降。
 */
import type { ChronicleApiResponse, ChroniclePageSummary, ChroniclePlacementSummary } from "../shared/chronicle";
import type { DialogueLine } from "../shared/apiTypes";
import { buildChronicleBeats } from "../shared/chronicleBeat";
import { normalizePageObjects } from "../shared/pageObjects";
import { getRow, getRows, toApiRows } from "./db";
import { HttpError } from "./http";

function requireProject(projectId: string) {
  const project = getRow("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
}

interface ScriptRow {
  id: string;
}

/** scriptId 省略時は最初の脚本(作成順)。プロジェクトに脚本が無ければ 404。 */
function resolveScript(projectId: string, scriptId: string | undefined): ScriptRow {
  if (scriptId) {
    const row = getRow<ScriptRow>("SELECT id FROM manga_scripts WHERE id = ? AND project_id = ?", [scriptId, projectId]);
    if (!row) {
      throw new HttpError(404, "Script was not found in this project");
    }
    return row;
  }
  const row = getRow<ScriptRow>("SELECT id FROM manga_scripts WHERE project_id = ? ORDER BY created_at ASC LIMIT 1", [
    projectId
  ]);
  if (!row) {
    throw new HttpError(404, "This project has no script yet");
  }
  return row;
}

interface RevisionRow {
  id: string;
}

/** 最新有効 revision(MAX(revision))。script_revisions は不変保存なので最新1件を取れば良い。 */
function resolveLatestRevision(scriptId: string): RevisionRow {
  const row = getRow<RevisionRow>(
    "SELECT id FROM script_revisions WHERE script_id = ? ORDER BY revision DESC LIMIT 1",
    [scriptId]
  );
  if (!row) {
    throw new HttpError(404, "This script has no revision yet");
  }
  return row;
}

interface PlacementRow {
  id: string;
  line_id: string;
  page_id: string;
  balloon_object_id: string | null;
  text_override: string | null;
  speaker_label_override: string | null;
  auto_layout_locked: number;
  auto_layout_seed: number | null;
}

interface ChroniclePageRow {
  id: string;
  page_index: number;
  objects_json: string | null;
}

/**
 * `GET /api/projects/:projectId/chronicle?scriptId=...`。scriptId 省略時は最初の脚本。
 * その脚本の全 dialogue_lines(status 不問 -- orphaned 行も Chronicle 上に残す、order_index 順)から
 * Beat を構築し、行ごとの placement 要約・ページ別の行 id 一覧をあわせて返す。
 */
export function getChronicle(projectId: string, scriptId: string | undefined): ChronicleApiResponse {
  requireProject(projectId);
  const script = resolveScript(projectId, scriptId);
  const revision = resolveLatestRevision(script.id);

  const lineRows = getRows("SELECT * FROM dialogue_lines WHERE script_id = ? ORDER BY order_index ASC", [script.id]);
  const lines = toApiRows(lineRows) as unknown as DialogueLine[];

  const beats = buildChronicleBeats(lines, revision.id);

  const pageRows = getRows<ChroniclePageRow>(
    "SELECT id, page_index, objects_json FROM pages WHERE project_id = ? ORDER BY page_index ASC",
    [projectId]
  );
  const renderedTextByObject = new Map<string, string>();
  for (const page of pageRows) {
    const objects = normalizePageObjects(page.objects_json ? JSON.parse(page.objects_json) : []);
    for (const object of objects) {
      if ((object.kind === "balloon" || object.kind === "box" || object.kind === "text") && object.content?.text) {
        renderedTextByObject.set(`${page.id}:${object.id}`, object.content.text);
      }
    }
  }

  const lineIds = lines.map((line) => line.id);
  const placementsByLine = new Map<string, ChroniclePlacementSummary[]>();
  if (lineIds.length > 0) {
    const placeholders = lineIds.map(() => "?").join(",");
    const placementRows = getRows<PlacementRow>(
      `SELECT id, line_id, page_id, balloon_object_id, text_override, speaker_label_override,
              auto_layout_locked, auto_layout_seed
       FROM dialogue_placements WHERE line_id IN (${placeholders})`,
      lineIds
    );
    for (const row of placementRows) {
      const list = placementsByLine.get(row.line_id) ?? [];
      list.push({
        id: row.id,
        pageId: row.page_id,
        balloonObjectId: row.balloon_object_id,
        textOverride: row.text_override,
        renderedText: row.balloon_object_id
          ? renderedTextByObject.get(`${row.page_id}:${row.balloon_object_id}`) ?? null
          : null,
        speakerLabelOverride: row.speaker_label_override,
        autoLayoutLocked: Boolean(row.auto_layout_locked),
        autoLayoutSeed: row.auto_layout_seed
      });
      placementsByLine.set(row.line_id, list);
    }
  }

  const lineSummaries = lines.map((line) => ({
    lineId: line.id,
    status: line.status,
    orderIndex: line.orderIndex,
    sceneIndex: line.sceneIndex,
    speakerLabel: line.speakerLabel,
    text: line.text,
    semanticKind: line.semanticKind,
    placements: placementsByLine.get(line.id) ?? []
  }));

  const pages: ChroniclePageSummary[] = pageRows.map((page) => {
    const pageLineIds = new Set<string>();
    for (const [lineId, placements] of placementsByLine.entries()) {
      if (placements.some((placement) => placement.pageId === page.id)) {
        pageLineIds.add(lineId);
      }
    }
    return { pageId: page.id, pageIndex: page.page_index, lineIds: Array.from(pageLineIds) };
  });

  return {
    scriptId: script.id,
    revisionId: revision.id,
    beats,
    lines: lineSummaries,
    pages
  };
}
