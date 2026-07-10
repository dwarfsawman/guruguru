/**
 * Chronicle Page Flow(S5、Docs/Done/Feature-ChroniclePageFlow.md §2.2)。純ロジック(DB/HTTP 非依存)。
 * dialogue_lines(order_index 順)から Beat(会話のまとまり)を決定的に構築し、
 * lines/placements の要約から Beat の表示状態(色分け)を導出する。
 */
import type { DialogueLine } from "./apiTypes";
import type {
  ChronicleBeat,
  ChronicleBeatPreview,
  ChronicleBeatState,
  ChronicleBeatStatus,
  ChroniclePageSummary,
  ChronicleLineSummary
} from "./chronicle";

/** Beat 分割の目安(§2.2)。1つの Beat に詰め込む上限。 */
export const BEAT_MAX_CHARS = 120;
export const BEAT_MAX_LINES = 6;

/** dialogue/monologue は「会話」としてまとめる。narration/sfx は種別そのものが切替の合図。 */
function beatGroupKind(line: DialogueLine): "talk" | "narration" | "sfx" {
  if (line.semanticKind === "narration") {
    return "narration";
  }
  if (line.semanticKind === "sfx") {
    return "sfx";
  }
  return "talk";
}

function beatLabel(kind: "talk" | "narration" | "sfx", firstLine: DialogueLine): string {
  if (kind === "narration") {
    return "ナレーション";
  }
  if (kind === "sfx") {
    return "SFX";
  }
  return firstLine.speakerLabel || "(話者未設定)";
}

function summarize(text: string, maxLength = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) {
    return flat;
  }
  return `${flat.slice(0, maxLength)}…`;
}

interface OpenGroup {
  kind: "talk" | "narration" | "sfx";
  sceneIndex: number;
  lines: DialogueLine[];
  charCount: number;
}

function closeGroup(group: OpenGroup, revisionId: string): ChronicleBeat {
  const firstLine = group.lines[0]!;
  const lastLine = group.lines[group.lines.length - 1]!;
  const speakerIds = Array.from(
    new Set(group.lines.map((line) => line.characterId ?? line.speakerLabel).filter((value): value is string => Boolean(value)))
  );
  return {
    id: `beat_${revisionId}_${firstLine.id}`,
    sceneIndex: group.sceneIndex,
    lineIds: group.lines.map((line) => line.id),
    label: beatLabel(group.kind, firstLine),
    summary: summarize(firstLine.text),
    speakerIds,
    startOrder: firstLine.orderIndex,
    endOrder: lastLine.orderIndex
  };
}

/**
 * `dialogue_lines`(scriptId で絞り込み済み、order_index 昇順、status 不問 -- orphaned 行も
 * Chronicle 上に表示するため含める)から Beat を決定的に構築する。
 *
 * 分割規則(§2.2):
 * - 同一シーン内の連続した dialogue/monologue はまとめる。
 * - narration/sfx/scene 境界/semantic_kind の切替(talk⇄narration⇄sfx)で分割する
 *   (narration/sfx は他行とまとめず単独 Beat になる)。
 * - 1 Beat あたり文字数 120 字 or 発話数 6 を超えたら分割する。
 */
export function buildChronicleBeats(lines: DialogueLine[], revisionId: string): ChronicleBeat[] {
  const sorted = [...lines].sort((a, b) => a.orderIndex - b.orderIndex);
  const beats: ChronicleBeat[] = [];
  let open: OpenGroup | null = null;

  for (const line of sorted) {
    const kind = beatGroupKind(line);
    const sceneIndex = line.sceneIndex ?? -1;
    const lineChars = line.text.length;

    if (kind !== "talk") {
      // narration/sfx は常に単独 Beat(まとめない)。
      if (open) {
        beats.push(closeGroup(open, revisionId));
        open = null;
      }
      beats.push(closeGroup({ kind, sceneIndex, lines: [line], charCount: lineChars }, revisionId));
      continue;
    }

    const canContinue =
      open !== null &&
      open.kind === "talk" &&
      open.sceneIndex === sceneIndex &&
      open.lines.length + 1 <= BEAT_MAX_LINES &&
      open.charCount + lineChars <= BEAT_MAX_CHARS;

    if (canContinue && open) {
      open.lines.push(line);
      open.charCount += lineChars;
      continue;
    }

    if (open) {
      beats.push(closeGroup(open, revisionId));
    }
    open = { kind, sceneIndex, lines: [line], charCount: lineChars };
  }

  if (open) {
    beats.push(closeGroup(open, revisionId));
  }

  return beats;
}

/**
 * Beat の表示状態を lines/placements の要約から導出する(§2.2 の表)。保存しない派生値。
 * `currentPageId` は「現在編集中のページ」(null なら未指定 -- ページ横断で見た概況になる)。
 *
 * 優先順位: orphaned(削除済み行を含む) > unassigned(未配置行を含む) > otherPage(現在ページ以外
 * にのみ配置された行を含む) > materialized(現在ページに全行配置済み・全吹き出し化済み) > assigned
 * (現在ページに全行配置済み・未吹き出し化を含む)。
 */
export function computeBeatState(
  beat: ChronicleBeat,
  lineSummaries: ReadonlyMap<string, ChronicleLineSummary>,
  currentPageId: string | null
): ChronicleBeatState {
  const lines = beat.lineIds.map((id) => lineSummaries.get(id)).filter((value): value is ChronicleLineSummary => Boolean(value));
  const locked = lines.some((line) => line.placements.some((placement) => placement.autoLayoutLocked));

  if (lines.length === 0 || lines.some((line) => line.status === "orphaned")) {
    return { beatId: beat.id, status: "orphaned", locked, currentPageLineCount: 0, totalLineCount: lines.length };
  }
  if (lines.some((line) => line.placements.length === 0)) {
    return statusResult(beat, "unassigned", locked, lines, currentPageId);
  }

  if (currentPageId) {
    const allOnCurrentPage = lines.every((line) => line.placements.some((placement) => placement.pageId === currentPageId));
    if (!allOnCurrentPage) {
      return statusResult(beat, "otherPage", locked, lines, currentPageId);
    }
    const currentPagePlacements = lines.flatMap((line) => line.placements.filter((placement) => placement.pageId === currentPageId));
    const status: ChronicleBeatStatus = currentPagePlacements.every((placement) => placement.balloonObjectId)
      ? "materialized"
      : "assigned";
    return statusResult(beat, status, locked, lines, currentPageId);
  }

  const allPlacements = lines.flatMap((line) => line.placements);
  const status: ChronicleBeatStatus = allPlacements.every((placement) => placement.balloonObjectId) ? "materialized" : "assigned";
  return statusResult(beat, status, locked, lines, currentPageId);
}

/**
 * Beat クリック時の内容プレビュー(§2.3)。専用 API を新設せず、GET /chronicle の応答
 * (lines/pages)だけから組み立てる(純ロジック)。配置先ページは `pages` の lineIds から逆引きする
 * (1行が複数ページに配置されている場合は先頭の1件のみ表示 -- MVP はページ単位の割り当てが基本のため)。
 */
export function buildBeatPreview(
  beat: ChronicleBeat,
  lineSummaries: ReadonlyMap<string, ChronicleLineSummary>,
  pages: readonly ChroniclePageSummary[]
): ChronicleBeatPreview {
  const pageIndexByLineId = new Map<string, number>();
  for (const page of pages) {
    for (const lineId of page.lineIds) {
      if (!pageIndexByLineId.has(lineId)) {
        pageIndexByLineId.set(lineId, page.pageIndex);
      }
    }
  }
  return {
    beatId: beat.id,
    lines: beat.lineIds.map((lineId) => {
      const summary = lineSummaries.get(lineId);
      return {
        lineId,
        speakerLabel: summary?.speakerLabel ?? "",
        text: summary?.text ?? "",
        semanticKind: summary?.semanticKind ?? "dialogue",
        pageIndex: pageIndexByLineId.get(lineId) ?? null
      };
    })
  };
}

function statusResult(
  beat: ChronicleBeat,
  status: ChronicleBeatStatus,
  locked: boolean,
  lines: ChronicleLineSummary[],
  currentPageId: string | null
): ChronicleBeatState {
  const currentPageLineCount = currentPageId
    ? lines.filter((line) => line.placements.some((placement) => placement.pageId === currentPageId)).length
    : lines.filter((line) => line.placements.length > 0).length;
  return { beatId: beat.id, status, locked, currentPageLineCount, totalLineCount: lines.length };
}
