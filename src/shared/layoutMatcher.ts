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

// --- PanelDemand ---

export interface PanelDemand {
  /** ビートから解決された演出上の大きさ。 */
  visualScale: MangaVisualScale;
  /** 可読性の下限(コマ総面積に対する割合)。hard constraint。 */
  minAreaFraction: number;
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
  requiredRole?: "figure";
}): PanelDemand {
  const visualScale = input.visualScale ?? "medium";
  return {
    visualScale,
    minAreaFraction: estimateMinimumPanelArea({
      totalCharacters: input.totalCharacters,
      balloonCount: input.balloonCount
    }),
    preferredAspect: "any",
    ...(input.requiredRole ? { requiredRole: input.requiredRole } : {}),
    // splash は裁ち切りを希望(旧 selectScriptMangaLayoutId の splash→bleed 優先の継承)。
    ...(visualScale === "splash" ? { preferredPresentation: "bleed" as const } : {})
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
  /** 既定は scriptMangaLayoutCandidates(コマ数)。テスト・カタログ差し替え用。 */
  candidateIds?: readonly string[];
  resolveLayout?: ScriptMangaLayoutResolver;
}

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

  // soft: 前ページとの反復。
  let repetitionCost = 0;
  if (context.previousLayoutId) {
    if (context.previousLayoutId === features.layoutId) repetitionCost += 1.5;
    else reasons.push({ code: "avoids-previous-layout" });
  }

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
