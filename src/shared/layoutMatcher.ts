/**
 * レイアウト検索(ネームスタジオV5 D3)。
 *
 * 責務分離: LLMは演出意図(ビートの preferredScale)だけを判断し、幾何・可読性・
 * テンプレート選択はこのモジュールの決定的な純関数が行う。共有コードなので
 * クライアントも同じ関数でtop-kを計算でき、フリップUIがゼロレイテンシになる。
 *
 * - hard constraint(実現可能性): コマ数一致 / 台詞収容の絶対下限 / figureスロットの要不要
 * - soft preference(ランキング): 希望面積との距離 / 収容余裕 / 縦横比 / 裁ち切り希望 / 前ページ反復
 */
import { extractLayoutFeatures, type LayoutFeatures } from "./layoutFeatures";
import {
  resolveScriptMangaLayout,
  type ScriptMangaLayoutResolver,
  scriptMangaLayoutCandidates
} from "./layoutPresets";
import type { MangaVisualScale } from "./mangaPlanV2";

// --- 可読性の下限(TextDemand) ---

export const PANEL_TEXT_DEMAND_VERSION = "text-demand-v1";

/** 1ページのコマ総面積が収容できる台詞文字数の目安(較正は未決#1、fixture集で行う)。 */
const PAGE_TEXT_CAPACITY_CHARACTERS = 900;
/** 吹き出し1つあたりの固定面積割合(枠・尻尾・余白のオーバーヘッド)。 */
const BALLOON_AREA_SHARE = 0.015;
/** 単独cap超過台詞などでも1コマページで必ず収まるよう、下限は総面積割合0.8で頭打ち。 */
const MIN_AREA_SHARE_CAP = 0.8;

export interface TextDemand {
  totalCharacters: number;
  balloonCount: number;
  writingMode?: "vertical" | "horizontal";
}

/**
 * 台詞量からコマの必要最小面積(ページのコマ総面積に対する割合)を見積もる。
 * 「演出上小さくしたい(visualScale)」と「読めるように大きくする必要(minArea)」を
 * 分離するのがV5の要(QA由来の2軸)。
 */
export function estimateMinimumPanelArea(demand: TextDemand): number {
  if (demand.balloonCount <= 0 || demand.totalCharacters <= 0) return 0;
  const textShare = demand.totalCharacters / PAGE_TEXT_CAPACITY_CHARACTERS;
  return Math.min(MIN_AREA_SHARE_CAP, textShare + demand.balloonCount * BALLOON_AREA_SHARE);
}

// --- 縦書きの高さ下限(MinHeightDemand) ---
//
// 面積だけの hard check では「下段大ゴマ+上段が横長の帯」というレイアウトが通ってしまい、
// 実際の applyDialogueLayout が「一部の行を配置できなかった」で 422 になる。原因は
// 縦書き日本語の吹き出しが **高さ** を要求すること(面積は足りていても列が入らない)。
// ここでは「最小可読サイズまで縮めてもなお入らない」= 実現不能、という下限だけを見る。
// 縮小で救える範囲は applyDialogueLayoutWithFallback の fontScale 縮小に任せる。

/** 最小可読フォントサイズ(page-width 相対)。scriptMangaLettering の下限と同値。 */
const MIN_LEGIBLE_FONT_SIZE = 0.014;
/** 縦書きの字送り(行方向)。 */
const VERTICAL_CHARACTER_ADVANCE = MIN_LEGIBLE_FONT_SIZE * 1.15;
/** 縦書きの列送り(行間を含む)。 */
const VERTICAL_COLUMN_ADVANCE = MIN_LEGIBLE_FONT_SIZE * 1.6;
/** 楕円吹き出しの内接率(外接矩形のうち実際に文字を置ける割合)。balloonInscribedFactor 相当。 */
const BALLOON_INSCRIBED_RATIO = 0.72;
/** 吹き出し外接矩形がスロット高さを占有してよい上限。 */
const BALLOON_HEIGHT_SHARE = 0.92;
/** 2つ目以降の吹き出しがスロット高さへ追加で要求する割合(部分的な積み重ね)。 */
const ADDITIONAL_BALLOON_HEIGHT_SHARE = 0.35;

/**
 * 縦書き吹き出しが要求するスロット最小高さ(page-width 相対)を見積もる。
 *
 * 吹き出しは文字組みが概ね正方形になる列数を選ぶ、という近似を置く(日本語の吹き出しは
 * 極端な横長・縦長にはしない)。列数の上限はスロット幅から決まるので、幅の狭いスロットでは
 * 自動的に列が減り、必要高さが増える。
 */
export function estimateMinimumPanelHeight(
  demand: { maxBalloonCharacters: number; balloonCount: number },
  slotWidth: number
): number {
  const characters = Math.max(0, Math.floor(demand.maxBalloonCharacters));
  if (characters <= 0 || demand.balloonCount <= 0) return 0;
  const usableWidth = Math.max(0, slotWidth) * BALLOON_INSCRIBED_RATIO;
  // 正方形に近い組みになる列数。スロット幅で頭打ちにする。
  const squarishColumns = Math.ceil(Math.sqrt((characters * VERTICAL_CHARACTER_ADVANCE) / VERTICAL_COLUMN_ADVANCE));
  const widthLimitedColumns = Math.max(1, Math.floor(usableWidth / VERTICAL_COLUMN_ADVANCE));
  const columns = Math.max(1, Math.min(squarishColumns, widthLimitedColumns));
  const charactersPerColumn = Math.ceil(characters / columns);
  const balloonHeight = (charactersPerColumn * VERTICAL_CHARACTER_ADVANCE) / BALLOON_INSCRIBED_RATIO;
  const stacking = 1 + ADDITIONAL_BALLOON_HEIGHT_SHARE * Math.max(0, demand.balloonCount - 1);
  return (balloonHeight * stacking) / BALLOON_HEIGHT_SHARE;
}

// --- PanelDemand ---

export interface PanelDemand {
  /** ビートから解決された演出上の大きさ。 */
  visualScale: MangaVisualScale;
  /** 可読性の下限(コマ総面積に対する割合)。hard constraint。 */
  minAreaFraction: number;
  /** このコマで最も長い吹き出しの文字数。縦書きの最小高さ(hard constraint)に使う。 */
  maxBalloonCharacters: number;
  /** このコマの吹き出し数。最小高さの積み重ね分に使う。 */
  balloonCount: number;
  /** 初期実装は常に "any"(監督前でshot情報が無いため。将来の拡張点)。 */
  preferredAspect: "wide" | "tall" | "square" | "any";
  /** 必須条件。明示的な演出指定がある場合のみ。 */
  requiredRole?: "figure";
  /** 希望条件(不一致はソフトコスト)。 */
  preferredPresentation?: "framed" | "bleed";
}

/** visualScale と台詞量から PanelDemand を組み立てる(サーバー/クライアント共通)。 */
export function buildPanelDemand(input: {
  visualScale?: MangaVisualScale;
  totalCharacters: number;
  balloonCount: number;
  /** 最長吹き出しの文字数。省略時は均等割り(呼び出し側が行ごとの長さを持たない旧経路)。 */
  maxBalloonCharacters?: number;
  requiredRole?: "figure";
}): PanelDemand {
  const visualScale = input.visualScale ?? "medium";
  return {
    visualScale,
    minAreaFraction: estimateMinimumPanelArea({
      totalCharacters: input.totalCharacters,
      balloonCount: input.balloonCount
    }),
    maxBalloonCharacters: input.maxBalloonCharacters
      ?? (input.balloonCount > 0 ? Math.ceil(input.totalCharacters / input.balloonCount) : 0),
    balloonCount: input.balloonCount,
    preferredAspect: "any",
    ...(input.requiredRole ? { requiredRole: input.requiredRole } : {}),
    // 見せ場は裁ち切りを希望する。商業誌では大ゴマを裁ち切りで抜くのが普通で、
    // splash だけを bleed 希望にしていると large のページが常に枠付きグリッドになる。
    // soft cost なので、収容や面積が破綻する場合は従来どおり枠付きが選ばれる。
    ...(visualScale === "splash" || visualScale === "large"
      ? { preferredPresentation: "bleed" as const }
      : {})
  };
}

// --- ランキング ---

/** UI側で日本語化する構造化理由(文字列直書きしない)。 */
export type LayoutReason =
  | { code: "large-slot-aligned"; panelIndex: number }
  | { code: "text-capacity-ok" }
  | { code: "capacity-tight"; panelIndex: number }
  | { code: "avoids-previous-layout" }
  | { code: "bleed-preferred" }
  | { code: "default-order" };

export interface RankedLayout {
  layoutId: string;
  /** 大きいほど良い(-総コスト)。同点は候補配列順で安定。 */
  score: number;
  costs: { area: number; capacity: number; aspect: number; role: number; repetition: number };
  /** 空でなければ実現不能(表示候補・採用対象にしない)。ゲート用。 */
  hardViolations: string[];
  reasons: LayoutReason[];
}

export interface RankLayoutsContext {
  previousLayoutId?: string;
  /**
   * 直近ページのレイアウト(新しい順)。`previousLayoutId` の一般化で、両方指定した場合は
   * `previousLayoutId` を先頭とみなす。直前ほど強く、少し前ほど弱くペナルティを掛けるので、
   * 同じ構造のページが続いても同じレイアウトが並ばない。
   */
  recentLayoutIds?: readonly string[];
  /** 既定は scriptMangaLayoutCandidates(コマ数)。テスト・カタログ差し替え用。 */
  candidateIds?: readonly string[];
  resolveLayout?: ScriptMangaLayoutResolver;
}

/** 直前ページと同じレイアウトを選んだときのコスト(遡るほど 1/distance で減衰)。 */
const REPETITION_COST = 2.5;

/** visualScale → 目標面積の重み(V5 D1: small 0.6 / medium 1.0 / large 2.0)。 */
function scaleTargetWeight(scale: MangaVisualScale): number {
  return scale === "large" || scale === "splash" ? 2 : scale === "small" ? 0.6 : 1;
}

function rankOne(
  features: LayoutFeatures,
  demands: readonly PanelDemand[],
  context: RankLayoutsContext
): RankedLayout {
  const hardViolations: string[] = [];
  const reasons: LayoutReason[] = [];
  const largeIndexes = demands.flatMap((demand, index) =>
    demand.visualScale === "large" || demand.visualScale === "splash" ? [index] : []);

  // hard: 台詞収容の絶対下限。
  let capacityCost = 0;
  let tight = false;
  demands.forEach((demand, index) => {
    const slot = features.slots[index]!;
    // hard: 縦書き吹き出しの最小高さ。面積は足りていても横長の帯には縦書きが入らない
    // (均一段組ばかりが選ばれていた真因)。
    const minHeight = estimateMinimumPanelHeight(demand, slot.width);
    if (minHeight > 0 && slot.height + 1e-9 < minHeight) {
      hardViolations.push(`height:${index}`);
    }
    if (slot.areaFraction + 1e-9 < demand.minAreaFraction) {
      hardViolations.push(`capacity:${index}`);
    } else if (slot.areaFraction < demand.minAreaFraction * 1.25) {
      capacityCost += (demand.minAreaFraction * 1.25 - slot.areaFraction) * 20;
      reasons.push({ code: "capacity-tight", panelIndex: index });
      tight = true;
    }
  });
  if (!tight && hardViolations.length === 0 && demands.some((demand) => demand.minAreaFraction > 0)) {
    reasons.push({ code: "text-capacity-ok" });
  }

  // hard: figureスロットの要不要(要求なしのfigureレイアウトは意味が変わるため不可、旧事前選択の継承)。
  const wantsFigure = demands.some((demand) => demand.requiredRole === "figure");
  if (wantsFigure && features.figureSlotIndex === null) hardViolations.push("figure-slot-missing");
  if (!wantsFigure && features.figureSlotIndex !== null) hardViolations.push("figure-slot-unwanted");

  // soft: 希望面積との距離 + large×強調スロット整合。
  const weights = demands.map((demand) => scaleTargetWeight(demand.visualScale));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let areaCost = demands.reduce(
    (sum, _, index) => sum + Math.abs(weights[index]! / weightTotal - (features.slots[index]?.areaFraction ?? 0)),
    0
  ) * 3;
  const aligned = features.emphasizedSlotIndex !== null && largeIndexes.includes(features.emphasizedSlotIndex);
  if (largeIndexes.length > 0) {
    if (aligned) reasons.push({ code: "large-slot-aligned", panelIndex: features.emphasizedSlotIndex! });
    else areaCost += 4; // 旧 selectScriptMangaLayoutId の aligns-first を支配的コストとして継承
  }

  // soft: 縦横比(初期は any 固定なので実質0。将来の拡張点)。
  let aspectCost = 0;
  demands.forEach((demand, index) => {
    if (demand.preferredAspect !== "any" && features.slots[index]!.aspectClass !== demand.preferredAspect) {
      aspectCost += 2;
    }
  });

  // soft: 裁ち切り希望。
  let roleCost = 0;
  const wantsBleed = demands.some((demand) => demand.preferredPresentation === "bleed");
  if (wantsBleed) {
    if (features.hasBleed) reasons.push({ code: "bleed-preferred" });
    else roleCost += 2;
  }

  // soft: 直近ページとの反復。直前ページとの一致が最も重く、遡るほど軽くなる。
  // 1.5 では面積コストの差(0.4程度)を覆せず、同構造のページが続くと同じレイアウトが並び続けた。
  const recent = [
    ...(context.previousLayoutId ? [context.previousLayoutId] : []),
    ...(context.recentLayoutIds ?? []).filter((id) => id !== context.previousLayoutId)
  ];
  let repetitionCost = 0;
  recent.forEach((layoutId, distance) => {
    if (layoutId === features.layoutId) repetitionCost += REPETITION_COST / (distance + 1);
  });
  if (recent.length > 0 && repetitionCost === 0) reasons.push({ code: "avoids-previous-layout" });

  const costs = { area: areaCost, capacity: capacityCost, aspect: aspectCost, role: roleCost, repetition: repetitionCost };
  return {
    layoutId: features.layoutId,
    score: -(areaCost + capacityCost + aspectCost + roleCost + repetitionCost),
    costs,
    hardViolations,
    reasons
  };
}

/**
 * PanelDemand 列に対して候補レイアウトを決定的にランキングする(共有純関数)。
 * hardViolations が空の候補だけが実現可能。返り値はスコア降順(同点は候補配列順)。
 */
export function rankLayouts(demands: readonly PanelDemand[], context: RankLayoutsContext = {}): RankedLayout[] {
  if (demands.length === 0) return [];
  const resolveLayout = context.resolveLayout ?? resolveScriptMangaLayout;
  const candidateIds = context.candidateIds ?? scriptMangaLayoutCandidates(demands.length);
  const ranked: RankedLayout[] = [];
  for (const layoutId of candidateIds) {
    const layout = resolveLayout(layoutId);
    if (!layout || layout.panels.length !== demands.length) continue;
    ranked.push(rankOne(extractLayoutFeatures(layoutId, layout), demands, context));
  }
  // 安定ソート(同点は候補配列順=既定互換)。
  return ranked
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.score - a.entry.score) || (a.index - b.index))
    .map(({ entry }) => entry);
}

/** 実現可能(hardViolationsが空)な候補だけをスコア順で返す。実現可能性ゲートの本体。 */
export function feasibleLayouts(demands: readonly PanelDemand[], context: RankLayoutsContext = {}): RankedLayout[] {
  return rankLayouts(demands, context).filter((entry) => entry.hardViolations.length === 0);
}

// --- diverse top-k ---

/** 見た目の類似判定(面積プロファイルL1・強調スロット・bleed構成)。 */
function looksSimilar(a: LayoutFeatures, b: LayoutFeatures): boolean {
  if (a.emphasizedSlotIndex !== b.emphasizedSlotIndex) return false;
  if (a.hasBleed !== b.hasBleed) return false;
  const l1 = a.slots.reduce(
    (sum, slot, index) => sum + Math.abs(slot.areaFraction - (b.slots[index]?.areaFraction ?? 0)),
    0
  );
  return l1 < 0.15;
}

/**
 * スコア上位から「目で見て違う」count 件を選ぶ。単純なtop-kは生成カタログで
 * 「上40%/60%と上42%/58%」のような実質同案が並ぶため、類似を間引く。
 * 多様な候補が足りない場合はスコア順で埋める。
 */
export function selectDiverseLayouts(
  ranked: readonly RankedLayout[],
  options: { count: number; resolveLayout?: ScriptMangaLayoutResolver } = { count: 3 }
): RankedLayout[] {
  const resolveLayout = options.resolveLayout ?? resolveScriptMangaLayout;
  const picked: Array<{ entry: RankedLayout; features: LayoutFeatures }> = [];
  const skipped: RankedLayout[] = [];
  for (const entry of ranked) {
    if (picked.length >= options.count) break;
    const layout = resolveLayout(entry.layoutId);
    if (!layout) continue;
    const features = extractLayoutFeatures(entry.layoutId, layout);
    if (picked.some((existing) => looksSimilar(existing.features, features))) {
      skipped.push(entry);
      continue;
    }
    picked.push({ entry, features });
  }
  const result = picked.map(({ entry }) => entry);
  for (const entry of skipped) {
    if (result.length >= options.count) break;
    result.push(entry);
  }
  return result;
}
