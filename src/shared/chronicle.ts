/**
 * Chronicle Page Flow(S5、Docs/Feature-ChroniclePageFlow.md)。API 型・Beat 型・状態型・Preview 型。
 * フェーズI では GET /chronicle と Beat 表示のみ実装する(§6)。Preview 型はフェーズIII の
 * `dialogue-layout/preview` API 用に先出しした型のみで、フェーズI では未使用。
 */
import type { DialogueLineStatus, DialogueSemanticKind } from "./apiTypes";
import type { PageObject } from "./pageObjects";

/**
 * 会話のまとまり(§2.2)。`chronicleBeat.ts` が dialogue_lines(order_index 順)から決定的に構築する。
 * id は `revisionId` + 先頭 lineId から決定的に生成する(同じ入力なら同じ id になり、再取得後も
 * UI の選択状態等をキーで追跡できる)。
 */
export interface ChronicleBeat {
  id: string;
  sceneIndex: number;
  lineIds: string[];
  /** 話者名など(先頭行の speakerLabel。narration/sfx は種別ラベル)。 */
  label: string;
  /** 先頭セリフの抜粋。 */
  summary: string;
  /** このBeatに含まれる話者の識別子(characterId が無い行は speakerLabel を代用)。重複無し。 */
  speakerIds: string[];
  /** order_index(先頭行)。 */
  startOrder: number;
  /** order_index(末尾行)。 */
  endOrder: number;
}

/** Beat の状態色分け(§2.2 の表)。保存はせず lines/placements から都度導出する。 */
export type ChronicleBeatStatus = "unassigned" | "assigned" | "materialized" | "otherPage" | "orphaned";

/** Beat 1件の導出済み表示状態。`locked` は補助表示(主状態と独立、フェーズIIIの auto_layout_locked 用)。 */
export interface ChronicleBeatState {
  beatId: string;
  status: ChronicleBeatStatus;
  locked: boolean;
  /** 現在ページ(computeBeatState 呼び出し時に渡した pageId)に配置済みの行数。 */
  currentPageLineCount: number;
  totalLineCount: number;
}

/** GET /chronicle が返す1行分の placement 要約。 */
export interface ChroniclePlacementSummary {
  id: string;
  pageId: string;
  balloonObjectId: string | null;
  /** フェーズIII で追加される `auto_layout_locked` 列の値。フェーズI では常に undefined(未配線)。 */
  autoLayoutLocked?: boolean;
}

/**
 * GET /chronicle が返す1行分の状態導出用サマリ(DialogueLine 全体を送らず必要最小限に絞る)。
 * `speakerLabel`/`text`/`semanticKind` は状態導出には使わないが、Beat クリック時の内容プレビュー
 * (§2.3)をこの応答だけで組み立てられるよう含めている(専用プレビュー API を新設しない判断。実装上の逸脱)。
 */
export interface ChronicleLineSummary {
  lineId: string;
  status: DialogueLineStatus;
  orderIndex: number;
  sceneIndex: number | null;
  speakerLabel: string;
  text: string;
  semanticKind: DialogueSemanticKind;
  placements: ChroniclePlacementSummary[];
}

/** GET /chronicle が返すページ別の行 id 一覧(バーのページ範囲強調・自動スクロールに使う)。 */
export interface ChroniclePageSummary {
  pageId: string;
  pageIndex: number;
  lineIds: string[];
}

/** `GET /api/projects/:projectId/chronicle?scriptId=...` の応答(設計書 §3)。 */
export interface ChronicleApiResponse {
  scriptId: string;
  revisionId: string;
  beats: ChronicleBeat[];
  lines: ChronicleLineSummary[];
  pages: ChroniclePageSummary[];
}

// --- フェーズIII 先出し型(dialogue-layout/preview、未使用) ---

export interface DialogueLayoutAssignment {
  placementId: string;
  panelId: string | null;
  objectId: string;
}

export interface DialogueLayoutPreview {
  seed: number;
  objects: PageObject[];
  assignments: DialogueLayoutAssignment[];
  warnings: string[];
  unplacedPlacementIds: string[];
}

/** Chronicle バーで選択中 Beat の内容プレビュー(§2.3「Beat クリック」)。 */
export interface ChronicleBeatPreview {
  beatId: string;
  lines: Array<{
    lineId: string;
    speakerLabel: string;
    text: string;
    semanticKind: DialogueSemanticKind;
    pageIndex: number | null;
  }>;
}
