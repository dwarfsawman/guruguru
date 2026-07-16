/**
 * レイアウトの幾何特徴量(ネームスタジオV5 D3)。rankLayouts のランキング入力で、
 * カタログ側で事前計算できる純データ。座標系は width 相対・y∈[0, page.height]。
 */
import { orderPanelsByReadingDirection } from "./dialogueAutoLayout";
import { type PageLayout, panelBounds } from "./pageLayout";
import { emphasizedSlotForLayout, pageLayoutAreaProfile } from "./layoutPresets";

export type SlotAspectClass = "wide" | "tall" | "square";
export type SlotPositionBand = "top" | "middle" | "bottom";

export interface LayoutSlotFeatures {
  /** ページ内コマ総面積に対する割合(pageLayoutAreaProfile と同単位。合計1)。 */
  areaFraction: number;
  aspectClass: SlotAspectClass;
  positionBand: SlotPositionBand;
  /** ページ矩形([0,1]×[0,page.height])からはみ出す = 裁ち切りスロット。 */
  bleed: boolean;
  role: "normal" | "figure";
}

export interface LayoutFeatures {
  layoutId: string;
  panelCount: number;
  /** reading-order 順(plan panels と同順)。 */
  slots: LayoutSlotFeatures[];
  /** 強調スロットの reading-order index(面積最大が2位の1.15倍以上、または emphasisPanelIds)。 */
  emphasizedSlotIndex: number | null;
  hasBleed: boolean;
  figureSlotIndex: number | null;
}

const BLEED_EPSILON = 1e-6;

function aspectClassOf(width: number, height: number): SlotAspectClass {
  if (height <= 0) return "square";
  const ratio = width / height;
  if (ratio >= 1.3) return "wide";
  if (ratio <= 0.75) return "tall";
  return "square";
}

function positionBandOf(centerY: number, pageHeight: number): SlotPositionBand {
  const relative = pageHeight > 0 ? centerY / pageHeight : 0.5;
  if (relative < 1 / 3) return "top";
  if (relative > 2 / 3) return "bottom";
  return "middle";
}

/** レイアウト1件の特徴量を決定的に抽出する。 */
export function extractLayoutFeatures(layoutId: string, layout: PageLayout): LayoutFeatures {
  const ordered = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
  const areas = pageLayoutAreaProfile(layout);
  const slots: LayoutSlotFeatures[] = ordered.map((panel, index) => {
    const [x1, y1, x2, y2] = panelBounds(panel.shape);
    const bleed = x1 < -BLEED_EPSILON || y1 < -BLEED_EPSILON
      || x2 > 1 + BLEED_EPSILON || y2 > layout.page.height + BLEED_EPSILON;
    return {
      areaFraction: areas[index] ?? 0,
      aspectClass: aspectClassOf(Math.max(0, x2 - x1), Math.max(0, y2 - y1)),
      positionBand: positionBandOf((y1 + y2) / 2, layout.page.height),
      bleed,
      role: panel.role === "figure" ? "figure" : "normal"
    };
  });
  const figureSlotIndex = slots.findIndex((slot) => slot.role === "figure");
  return {
    layoutId,
    panelCount: ordered.length,
    slots,
    emphasizedSlotIndex: emphasizedSlotForLayout(layoutId, layout),
    hasBleed: slots.some((slot) => slot.bleed),
    figureSlotIndex: figureSlotIndex >= 0 ? figureSlotIndex : null
  };
}
