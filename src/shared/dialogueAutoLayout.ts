/**
 * Chronicle Page Flow(S5、Docs/Done/Feature-ChroniclePageFlow.md §2.5・§4 フェーズIII)。
 * 吹き出し一括配置の配置ソルバー(純ロジック、DOM・db 非依存)。サイズ計算(`computeTextLayoutForContent`
 * の呼び出し)はサーバー側(`dialogueAutoLayoutApi.ts`)の役目 -- ここは「必要サイズ・semanticKind・
 * order_index が渡されれば決定的に配置を組む」ことだけをやる。
 *
 * 手順(§2.5): コマを reading direction 順に並べ、発話を order 順に文字量比で各コマへ配分 →
 * 各コマ内で候補座標を生成(コマ上部優先、RTL は右寄り/LTR は左寄りから)→ ハード制約チェック →
 * ソフト制約スコアリング → 最良候補選択(同点近傍は seed で選ぶ)。
 *
 * 乱数は `Math.random` を使わず、自前の mulberry32 PRNG(seed 付き決定的)のみを使う。
 */
import type { DialogueSemanticKind } from "./apiTypes";
import { panelBounds, panelBoundsSize, type LayoutPanel, type PageLayout, type PanelShape } from "./pageLayout";
import {
  DEFAULT_BALLOON_SIZE,
  DEFAULT_BOX_FILL,
  DEFAULT_BOX_STROKE_COLOR,
  DEFAULT_BOX_STROKE_WIDTH,
  DEFAULT_TEXT_STYLE,
  PAGE_OBJECTS_MAX_COUNT,
  PAGE_OBJECT_MAX_SIZE,
  PAGE_OBJECT_MIN_SIZE,
  defaultBalloonTail,
  type BalloonObject,
  type BoxObject,
  type PageObject,
  type PageVec,
  type TextObject
} from "./pageObjects";

/** ページに対する、コマに対するアイテムの最大サイズ比率(これを超えたら配置不能として扱う、§2.5)。 */
export const AUTO_LAYOUT_MAX_PANEL_SIZE_RATIO = 0.8;

/** sfx オブジェクトのフォントサイズ倍率(DEFAULT_TEXT_STYLE.size に対して)。 */
export const AUTO_LAYOUT_SFX_FONT_SCALE = 2;

export interface DialogueAutoLayoutItem {
  placementId: string;
  lineId: string;
  text: string;
  semanticKind: DialogueSemanticKind;
  speakerLabel: string;
  /** dialogue_lines.order_index。コマ順との単調性判定・文字量比配分のソートキー。 */
  orderIndex: number;
  /** 既に割当済みなら、そのコマを自動分配より優先する。 */
  preferredPanelId?: string | null;
  /** 自動漫画など密度が高いページ向けの文字倍率。通常UIは1。 */
  fontScale?: number;
  /**
   * サイズ候補(page 単位、既にパディング込み)。サーバー側で `computeTextLayoutForContent` から複数の
   * 折返し高さで算出し、縦長(タワー型)優先の順で並べる。ソルバーは先頭から順に「入る候補」を試し、
   * 最初に配置できたものを採用する(全滅時のみ unplaced)。空配列は不可(呼び出し側で最低1件保証)。
   */
  sizeVariants: PageVec[];
}

/** 障害物(既存オブジェクト・ロック済み placement に対応する PageObject)。座標系は page 座標。 */
export interface DialogueAutoLayoutObstacle {
  position: PageVec;
  size: PageVec;
  rotation: number;
}

export interface DialogueAutoLayoutInput {
  layout: PageLayout;
  /** 既存 PageObject(障害物として扱う。ロック済み balloon もここに含まれる想定)。 */
  existingObjects: readonly PageObject[];
  items: DialogueAutoLayoutItem[];
  seed: number;
}

export interface DialogueAutoLayoutAssignment {
  placementId: string;
  panelId: string | null;
  objectId: string;
}

export interface DialogueAutoLayoutResult {
  objects: PageObject[];
  assignments: DialogueAutoLayoutAssignment[];
  warnings: string[];
  unplacedPlacementIds: string[];
}

// --- 決定的 PRNG(mulberry32) ---

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 幾何ヘルパ ---

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxFromCenterSize(center: PageVec, size: PageVec, rotation: number): Box {
  const hw = size.x / 2;
  const hh = size.y / 2;
  if (!rotation) {
    return { x0: center.x - hw, y0: center.y - hh, x1: center.x + hw, y1: center.y + hh };
  }
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const corners: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh]
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lx, ly] of corners) {
    const x = center.x + lx * cos - ly * sin;
    const y = center.y + lx * sin + ly * cos;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

function inflate(box: Box, margin: number): Box {
  return { x0: box.x0 - margin, y0: box.y0 - margin, x1: box.x1 + margin, y1: box.y1 + margin };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0);
}

/** ray casting によるポリゴン内外判定。 */
function pointInPolygon(point: [number, number], points: [number, number][]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

/** panel shape の中心点内外判定(polygon/ellipse は形状に沿った判定、rect/path は外接矩形で近似)。 */
function pointInPanelShape(point: [number, number], shape: PanelShape): boolean {
  if (shape.type === "polygon") {
    return pointInPolygon(point, shape.points);
  }
  if (shape.type === "ellipse") {
    const [cx, cy] = shape.center;
    const [rx, ry] = shape.radius;
    if (rx <= 0 || ry <= 0) {
      return false;
    }
    const dx = (point[0] - cx) / rx;
    const dy = (point[1] - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }
  // rect/path: 外接矩形での近似(§2.5 は polygon のみ内部判定を明示)。
  return true;
}

// --- コマ順(reading direction)ソート ---

interface PanelWithCenter {
  panel: LayoutPanel;
  bounds: [number, number, number, number];
  centerX: number;
  centerY: number;
  height: number;
}

/**
 * コマを reading direction 順に並べる(§2.5)。panelBounds の中心座標でソートする -- 行(y が近い
 * コマの集まり)ごとに束ね、行内を x でソートする(RTL=降順/右→左、LTR=昇順/左→右)。
 * 行の束ねは「直前行の平均コマ高さの半分以内の y 差」をしきい値にする(一般的なコマ割りの行検出)。
 */
export function orderPanelsByReadingDirection(panels: readonly LayoutPanel[], direction: "rtl" | "ltr"): LayoutPanel[] {
  const withCenters: PanelWithCenter[] = panels.map((panel) => {
    const bounds = panelBounds(panel.shape);
    const [width, height] = panelBoundsSize(bounds);
    return { panel, bounds, centerX: (bounds[0] + bounds[2]) / 2, centerY: (bounds[1] + bounds[3]) / 2, height: height || width };
  });
  withCenters.sort((a, b) => a.centerY - b.centerY);

  const rows: PanelWithCenter[][] = [];
  for (const item of withCenters) {
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      const avgCy = lastRow.reduce((sum, entry) => sum + entry.centerY, 0) / lastRow.length;
      const avgHeight = lastRow.reduce((sum, entry) => sum + entry.height, 0) / lastRow.length;
      if (Math.abs(item.centerY - avgCy) < Math.max(avgHeight * 0.5, 1e-6)) {
        lastRow.push(item);
        continue;
      }
    }
    rows.push([item]);
  }

  const ordered: LayoutPanel[] = [];
  for (const row of rows) {
    row.sort((a, b) => (direction === "rtl" ? b.centerX - a.centerX : a.centerX - b.centerX));
    ordered.push(...row.map((entry) => entry.panel));
  }
  return ordered;
}

// --- 発話の文字量比配分(order 順、コマ順との単調性を保つ) ---

interface DistributedItem {
  item: DialogueAutoLayoutItem;
  panelIndex: number | null; // null = ページ全体候補(narration)
}

/**
 * 発話を order 順に文字量比で各コマへ配分する(§2.5)。narration はコマ非依存(panelIndex=null)。
 * dialogue/monologue/sfx はコマが1つも無ければ全て unplaced 扱いにする(呼び出し側で panelIndex===null
 * かつ panel が必要な kind を弾く)。
 */
function distributeItemsToPanels(items: DialogueAutoLayoutItem[], panelCount: number): DistributedItem[] {
  const sorted = [...items].sort((a, b) => a.orderIndex - b.orderIndex);
  if (panelCount <= 0) {
    return sorted.map((item) => ({ item, panelIndex: item.semanticKind === "narration" ? null : 0 }));
  }
  const weightOf = (item: DialogueAutoLayoutItem) => Math.max(1, item.text.length);
  const panelNeeding = sorted.filter((item) => item.semanticKind !== "narration");
  const totalWeight = panelNeeding.reduce((sum, item) => sum + weightOf(item), 0) || 1;
  const targetPerPanel = totalWeight / panelCount;

  let cumulative = 0;
  let panelIndex = 0;
  const result: DistributedItem[] = [];
  for (const item of sorted) {
    if (item.semanticKind === "narration") {
      result.push({ item, panelIndex: null });
      continue;
    }
    // バケット境界判定は「その行を足した後の累積」ではなく「その行の中点」で行う。足した後の累積で
    // 判定すると、平均よりわずかに重いだけの1行目が最初のバケット境界を自分の重みだけで越えてしまい、
    // 先頭コマが1件も割り当てられないまま丸ごと飛ばされる偏り(既知の不具合)が起きる。中点判定なら
    // 各行はその行が実際に占める区間の中心がどのバケットに属するかで決まり、より均等に配分される。
    const start = cumulative;
    cumulative += weightOf(item);
    const mid = (start + cumulative) / 2;
    while (panelIndex < panelCount - 1 && mid > (panelIndex + 1) * targetPerPanel) {
      panelIndex += 1;
    }
    result.push({ item, panelIndex });
  }
  return result;
}

// --- 候補生成・スコアリング ---

const CANDIDATE_GRID: number = 6;
/**
 * 「同点」の判定幅。厳密な浮動小数一致ではなく「同点近傍」(§2.5)を拾うため、隣接グリッドセル程度の
 * スコア差(走査方向の重み 0.3 のグリッド刻み)は同点扱いにして seed で選ばせる -- そうしないと
 * スコアが単調すぎて常に同じ候補が選ばれ、「再配置(seed 変更)」が実質無意味になってしまう。
 */
const SCORE_EPSILON = 0.09;

interface Candidate {
  position: PageVec;
  score: number;
}

interface CandidateSearchArgs {
  bounds: [number, number, number, number]; // x0,y0,x1,y1(候補を探す領域)
  size: PageVec;
  direction: "rtl" | "ltr";
  obstacles: Box[];
  pageBounds: [number, number, number, number];
  insidePanelCheck?: (point: [number, number]) => boolean;
  avoidPanelBoxes?: [number, number, number, number][]; // narration: コマの上に極力置かない
  anchorHint?: PageVec | null; // 同一話者近接ボーナスの基準点
  random: () => number;
}

function searchBestCandidate(args: CandidateSearchArgs): PageVec | null {
  const { bounds, size, direction, obstacles, pageBounds, insidePanelCheck, avoidPanelBoxes, anchorHint, random } = args;
  const margin = Math.max(0.006, Math.min(bounds[2] - bounds[0], bounds[3] - bounds[1]) * 0.04);
  const minX = bounds[0] + margin + size.x / 2;
  const maxX = bounds[2] - margin - size.x / 2;
  const minY = bounds[1] + margin + size.y / 2;
  const maxY = bounds[3] - margin - size.y / 2;
  if (minX > maxX || minY > maxY) {
    return null;
  }

  const candidates: Candidate[] = [];
  for (let row = 0; row < CANDIDATE_GRID; row += 1) {
    const ty = CANDIDATE_GRID === 1 ? 0 : row / (CANDIDATE_GRID - 1);
    const y = minY + ty * (maxY - minY);
    for (let col = 0; col < CANDIDATE_GRID; col += 1) {
      const tx = CANDIDATE_GRID === 1 ? 0 : col / (CANDIDATE_GRID - 1);
      // RTL は右寄り(x が大きい方)から、LTR は左寄りから優先して走査する。
      const effectiveTx = direction === "rtl" ? 1 - tx : tx;
      const x = minX + effectiveTx * (maxX - minX);
      const position: PageVec = { x, y };

      if (position.x - size.x / 2 < pageBounds[0] || position.x + size.x / 2 > pageBounds[2]) {
        continue;
      }
      if (position.y - size.y / 2 < pageBounds[1] || position.y + size.y / 2 > pageBounds[3]) {
        continue;
      }
      if (insidePanelCheck && !insidePanelCheck([x, y])) {
        continue;
      }
      const candidateBox = boxFromCenterSize(position, size, 0);
      if (obstacles.some((obstacle) => boxesOverlap(candidateBox, obstacle))) {
        continue;
      }

      // ソフト制約スコア: コマ上部優先(y が小さいほど高得点)、reading direction 優先方向、
      // avoidPanelBoxes との重なり回避(narration)、話者近接ボーナス、サイズが大きいほど微減点。
      let score = 0;
      score -= ty * 2; // 上部優先(row=0 が最上段)
      score -= effectiveTx * 0.3; // 走査方向を弱くスコアにも反映(同点になりすぎないように)
      if (avoidPanelBoxes) {
        for (const panelBox of avoidPanelBoxes) {
          if (x >= panelBox[0] && x <= panelBox[2] && y >= panelBox[1] && y <= panelBox[3]) {
            score -= 3;
            break;
          }
        }
      }
      if (anchorHint) {
        const dist = Math.hypot(position.x - anchorHint.x, position.y - anchorHint.y);
        score += Math.max(0, 0.5 - dist);
      }
      score -= size.x * size.y * 0.1;

      candidates.push({ position, score });
    }
  }

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b.score - a.score);
  const bestScore = candidates[0]!.score;
  const tied = candidates.filter((candidate) => Math.abs(candidate.score - bestScore) < SCORE_EPSILON);
  const pickIndex = tied.length > 1 ? Math.floor(random() * tied.length) : 0;
  return tied[Math.min(pickIndex, tied.length - 1)]!.position;
}

// --- PageObject 生成 ---

/**
 * `autolayout_${seed}_${localIndex}` の決定的 id(乱数不使用)。同 seed・同入力なら同じ id 列になる
 * (§7「同 seed 再現性」テストの対象)。呼び出しをまたいだグローバルカウンタは持たない。
 */
function nextObjectId(seed: number, localIndex: number): string {
  return `autolayout_${seed}_${localIndex}`;
}

function buildBalloonObject(id: string, item: DialogueAutoLayoutItem, position: PageVec, size: PageVec): BalloonObject {
  const isThought = item.semanticKind === "monologue";
  const object: BalloonObject = {
    id,
    kind: "balloon",
    position,
    rotation: 0,
    shape: isThought ? "thought" : item.text.replace(/\s+/g, "").length >= 34 ? "compound" : "ellipse",
    size,
    fill: DEFAULT_BOX_FILL,
    strokeColor: DEFAULT_BOX_STROKE_COLOR,
    strokeWidth: DEFAULT_BOX_STROKE_WIDTH,
    tail: isThought ? null : defaultBalloonTail(size),
    content: { text: item.text, style: { ...DEFAULT_TEXT_STYLE, size: DEFAULT_TEXT_STYLE.size * (item.fontScale ?? 1) } },
    sourceDialogueLineId: item.lineId
  };
  return object;
}

function buildNarrationObject(id: string, item: DialogueAutoLayoutItem, position: PageVec, size: PageVec): BoxObject {
  return {
    id,
    kind: "box",
    position,
    rotation: 0,
    size,
    cornerRadius: 0,
    fill: DEFAULT_BOX_FILL,
    strokeColor: DEFAULT_BOX_STROKE_COLOR,
    strokeWidth: DEFAULT_BOX_STROKE_WIDTH,
    content: { text: item.text, style: { ...DEFAULT_TEXT_STYLE, size: DEFAULT_TEXT_STYLE.size * (item.fontScale ?? 1) } },
    sourceDialogueLineId: item.lineId
  };
}

function buildSfxObject(id: string, item: DialogueAutoLayoutItem, position: PageVec): TextObject {
  return {
    id,
    kind: "text",
    position,
    rotation: 0,
    content: {
      text: item.text,
      style: { ...DEFAULT_TEXT_STYLE, size: DEFAULT_TEXT_STYLE.size * AUTO_LAYOUT_SFX_FONT_SCALE * (item.fontScale ?? 1) }
    },
    sourceDialogueLineId: item.lineId
  };
}

function clampItemSize(size: PageVec): PageVec {
  return {
    x: Math.min(PAGE_OBJECT_MAX_SIZE, Math.max(PAGE_OBJECT_MIN_SIZE, size.x || DEFAULT_BALLOON_SIZE.x)),
    y: Math.min(PAGE_OBJECT_MAX_SIZE, Math.max(PAGE_OBJECT_MIN_SIZE, size.y || DEFAULT_BALLOON_SIZE.y))
  };
}

/**
 * 吹き出し一括配置ソルバーの本体(§2.5・§4)。同 seed → 同結果(決定的)。
 * `existingObjects` はロック済み balloon も含めた障害物一覧として扱う(呼び出し側で用意する)。
 */
export function runDialogueAutoLayout(input: DialogueAutoLayoutInput): DialogueAutoLayoutResult {
  const { layout, existingObjects, items, seed } = input;
  const random = mulberry32(seed);
  const pageBounds: [number, number, number, number] = [0, 0, 1, layout.page.height];
  const orderedPanels = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
  const panelBoundsList = orderedPanels.map((panel) => panelBounds(panel.shape));

  const obstacles: Box[] = existingObjects.map((object) => {
    const size = object.kind === "text" ? estimateTextObjectSize(object) : object.size;
    return inflate(boxFromCenterSize(object.position, size, object.rotation), 0.006);
  });

  const distributed = distributeItemsToPanels(items, orderedPanels.length);

  const objects: PageObject[] = [];
  const assignments: DialogueAutoLayoutAssignment[] = [];
  const warnings: string[] = [];
  const unplacedPlacementIds: string[] = [];
  let placedCount = existingObjects.length;
  let localIndex = 0;
  /**
   * 既に使われている id 集合(既存オブジェクト+今回生成済み分)。`nextObjectId` は `seed` を
   * またいだグローバルカウンタを持たないため、reflow のように「同じ seed を使い回す」呼び出しで
   * 既存(ロック済みなど)オブジェクトの id と衝突しうる。衝突すると `normalizePageObjects` が
   * 新オブジェクト側へ元の id を渡し既存オブジェクトを `_dup` へ追いやってしまい、ロック済み
   * placement の balloon_object_id 参照が浮く重大なバグになるため、ここで事前に空き id まで
   * localIndex を進めて回避する。
   */
  const usedObjectIds = new Set<string>(existingObjects.map((object) => object.id));
  const lastPositionBySpeaker = new Map<string, PageVec>();
  /**
   * 直近で panel ベースに配置できたアイテムの実際のコマ index(-1 = まだ無し)。担当コマへのフォール
   * バック探索(下記)の起点として使い、発話順とコマ順の単調性(order_index 昇順で panelId のコマ順が
   * 逆転しない)を壊さないようにする。
   */
  let lastAssignedPanelIndex = -1;

  for (const { item, panelIndex: distributedPanelIndex } of distributed) {
    const preferredPanelIndex = item.preferredPanelId
      ? orderedPanels.findIndex((panel) => panel.id === item.preferredPanelId)
      : -1;
    const panelIndex = item.preferredPanelId ? (preferredPanelIndex >= 0 ? preferredPanelIndex : null) : distributedPanelIndex;
    const hasPreferredPanel = Boolean(item.preferredPanelId);
    if (placedCount >= PAGE_OBJECTS_MAX_COUNT) {
      unplacedPlacementIds.push(item.placementId);
      warnings.push(`「${truncate(item.text)}」: ページオブジェクトの上限(${PAGE_OBJECTS_MAX_COUNT})に達しているため配置できませんでした。`);
      continue;
    }

    const variants = (item.sizeVariants.length > 0 ? item.sizeVariants : [DEFAULT_BALLOON_SIZE]).map(clampItemSize);
    const anchorHint = lastPositionBySpeaker.get(item.speakerLabel) ?? null;
    // narration/sfx はページ全体候補も許可(§2.5)。sfx はまず担当コマ内で試し、コマ比率超過/空き無しの
    // 場合のみページ全体へフォールバックする(担当コマ近傍を優先するスコアリング付き)。
    const allowsPageWideFallback = item.semanticKind === "sfx";

    let position: PageVec | null = null;
    let size: PageVec | null = null;
    let targetPanel: LayoutPanel | null = null;
    let anyVariantFitsPanelRatio = false;

    if (item.semanticKind === "narration") {
      // ページ全体候補(コマ非依存)。コマの上に極力被らないようスコアで回避する。
      for (const variant of variants) {
        const found = searchBestCandidate({
          bounds: pageBounds,
          size: variant,
          direction: layout.readingDirection,
          obstacles,
          pageBounds,
          avoidPanelBoxes: panelBoundsList,
          anchorHint,
          random
        });
        if (found) {
          position = found;
          size = variant;
          break;
        }
      }
    } else if (panelIndex === null || orderedPanels.length === 0) {
      // dialogue/monologue はコマが無ければ配置不能。sfx はページ全体候補へフォールバックする。
      if (allowsPageWideFallback) {
        for (const variant of variants) {
          const found = searchBestCandidate({
            bounds: pageBounds,
            size: variant,
            direction: layout.readingDirection,
            obstacles,
            pageBounds,
            avoidPanelBoxes: panelBoundsList,
            anchorHint,
            random
          });
          if (found) {
            position = found;
            size = variant;
            break;
          }
        }
      }
      if (!position) {
        unplacedPlacementIds.push(item.placementId);
        warnings.push(`「${truncate(item.text)}」: このページにコマが無いため配置できませんでした。`);
        continue;
      }
    } else {
      const index = panelIndex;
      targetPanel = orderedPanels[index] ?? null;
      const bounds = panelBoundsList[index];
      if (!targetPanel || !bounds) {
        unplacedPlacementIds.push(item.placementId);
        warnings.push(`「${truncate(item.text)}」: 対象コマが見つかりませんでした。`);
        continue;
      }
      const [bx0, by0, bx1, by1] = bounds;
      const panelWidth = Math.max(1e-6, bx1 - bx0);
      const panelHeight = Math.max(1e-6, by1 - by0);
      const insidePanelCheck = (point: [number, number]) => pointInPanelShape(point, targetPanel!.shape);
      let placedPanelIndex = index;

      for (const variant of variants) {
        if (variant.x > panelWidth * AUTO_LAYOUT_MAX_PANEL_SIZE_RATIO || variant.y > panelHeight * AUTO_LAYOUT_MAX_PANEL_SIZE_RATIO) {
          continue;
        }
        anyVariantFitsPanelRatio = true;
        const found = searchBestCandidate({
          bounds,
          size: variant,
          direction: layout.readingDirection,
          obstacles,
          pageBounds,
          insidePanelCheck,
          anchorHint,
          random
        });
        if (found) {
          position = found;
          size = variant;
          break;
        }
      }

      if (!position && !allowsPageWideFallback && !hasPreferredPanel) {
        // 担当コマに空きが無い場合のフォールバック: 発話順とコマ順の単調性(order_index 昇順で
        // panelId のコマ順が逆転しない)を壊さない範囲で後続コマへの配置を試みる -- 探索範囲は
        // 「直前に panel ベースで配置した発話のコマ index の次」以降、かつ「担当 index+2」まで。
        // sfx は既存のページ全体フォールバック(担当コマ近傍優先)を維持するため対象外にする。
        const fallbackStart = Math.max(index + 1, lastAssignedPanelIndex + 1);
        const fallbackEnd = Math.min(orderedPanels.length - 1, index + 2);
        for (let fbIndex = fallbackStart; fbIndex <= fallbackEnd && !position; fbIndex += 1) {
          const fbPanel = orderedPanels[fbIndex];
          const fbBounds = panelBoundsList[fbIndex];
          if (!fbPanel || !fbBounds) {
            continue;
          }
          const [fbx0, fby0, fbx1, fby1] = fbBounds;
          const fbWidth = Math.max(1e-6, fbx1 - fbx0);
          const fbHeight = Math.max(1e-6, fby1 - fby0);
          const fbInsidePanelCheck = (point: [number, number]) => pointInPanelShape(point, fbPanel.shape);
          for (const variant of variants) {
            if (variant.x > fbWidth * AUTO_LAYOUT_MAX_PANEL_SIZE_RATIO || variant.y > fbHeight * AUTO_LAYOUT_MAX_PANEL_SIZE_RATIO) {
              continue;
            }
            anyVariantFitsPanelRatio = true;
            const found = searchBestCandidate({
              bounds: fbBounds,
              size: variant,
              direction: layout.readingDirection,
              obstacles,
              pageBounds,
              insidePanelCheck: fbInsidePanelCheck,
              anchorHint,
              random
            });
            if (found) {
              position = found;
              size = variant;
              targetPanel = fbPanel;
              placedPanelIndex = fbIndex;
              break;
            }
          }
        }
      }

      if (position) {
        lastAssignedPanelIndex = placedPanelIndex;
      }

      if (!position && allowsPageWideFallback) {
        // コマ内に入らなかった sfx は、担当コマ近傍を優先しつつページ全体から探す。
        const panelCenter: PageVec = { x: (bx0 + bx1) / 2, y: (by0 + by1) / 2 };
        for (const variant of variants) {
          const found = searchBestCandidate({
            bounds: pageBounds,
            size: variant,
            direction: layout.readingDirection,
            obstacles,
            pageBounds,
            anchorHint: panelCenter,
            random
          });
          if (found) {
            position = found;
            size = variant;
            targetPanel = null; // ページ全体配置扱い(コマ非依存)。
            break;
          }
        }
      }

      if (!position) {
        if (!anyVariantFitsPanelRatio && !allowsPageWideFallback) {
          unplacedPlacementIds.push(item.placementId);
          warnings.push(`「${truncate(item.text)}」: コマに対して文字量が多すぎるため配置できませんでした(分割/フォント縮小/手動配置をご検討ください)。`);
          continue;
        }
        unplacedPlacementIds.push(item.placementId);
        warnings.push(`「${truncate(item.text)}」: 空きスペースが見つからず配置できませんでした。`);
        continue;
      }
    }

    if (!position || !size) {
      unplacedPlacementIds.push(item.placementId);
      warnings.push(`「${truncate(item.text)}」: 空きスペースが見つからず配置できませんでした。`);
      continue;
    }

    let objectId = nextObjectId(seed, localIndex);
    localIndex += 1;
    while (usedObjectIds.has(objectId)) {
      objectId = nextObjectId(seed, localIndex);
      localIndex += 1;
    }
    usedObjectIds.add(objectId);
    let object: PageObject;
    if (item.semanticKind === "dialogue" || item.semanticKind === "monologue") {
      object = buildBalloonObject(objectId, item, position, size);
    } else if (item.semanticKind === "narration") {
      object = buildNarrationObject(objectId, item, position, size);
    } else {
      object = buildSfxObject(objectId, item, position);
    }

    objects.push(object);
    assignments.push({ placementId: item.placementId, panelId: targetPanel?.id ?? null, objectId });
    obstacles.push(inflate(boxFromCenterSize(position, size, 0), 0.006));
    placedCount += 1;
    if (item.speakerLabel) {
      lastPositionBySpeaker.set(item.speakerLabel, position);
    }
  }

  return { objects, assignments, warnings, unplacedPlacementIds };
}

function truncate(text: string, max = 16): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** TextObject は size を持たないため、文字数・スタイルから概算 bbox を出す(既存オブジェクト回避の近似)。 */
function estimateTextObjectSize(object: TextObject): PageVec {
  const style = object.content.style;
  const length = Math.max(1, object.content.text.length);
  const lineExtent = style.size * (style.lineSpacing ?? 1.6);
  const crossExtent = Math.max(style.size, style.size * (style.letterSpacing ?? 1) * length * 0.6);
  if (style.direction === "vertical") {
    return {
      x: object.maxWidth ?? Math.max(PAGE_OBJECT_MIN_SIZE, lineExtent),
      y: object.maxWidth ? Math.min(object.maxWidth, crossExtent) : Math.max(PAGE_OBJECT_MIN_SIZE, crossExtent)
    };
  }
  return {
    x: object.maxWidth ?? Math.max(PAGE_OBJECT_MIN_SIZE, crossExtent),
    y: Math.max(PAGE_OBJECT_MIN_SIZE, lineExtent)
  };
}
