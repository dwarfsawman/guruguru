/**
 * 内蔵のコマ割りテンプレート(プリセット)。Book のページ一覧の「テンプレから追加」で選べる、
 * よく使う漫画レイアウト。DB には持たず(取り込み分だけ DB)、コード側で管理する。
 *
 * 座標系は `PageLayout` と同じ width-relative-top-left。B5 相当(aspectRatio [182,257])で、
 * 余白/コマ間(GUTTER)を取った rect コマで構成する。読み順は右→左(rtl)。
 */
import { DEFAULT_PANEL_FRAME, type LayoutPanel, type PageLayout } from "./pageLayout";

/** 内蔵テンプレの1件。id は `builtin:<slug>` で衝突を避ける。 */
export interface BuiltinLayoutTemplate {
  id: string;
  name: string;
  layout: PageLayout;
}

/** B5 仕上がり比(商業漫画原稿もほぼ同比)。 */
const PAGE_ASPECT: [number, number] = [182, 257];
const PAGE_HEIGHT = 257 / 182; // ≈ 1.4120879
/** ページ外周の余白(page-width 単位)。 */
const MARGIN = 0.04;
/** コマ間(ガター)。 */
const GUTTER = 0.02;

/** 座標を扱いやすい精度へ丸める。 */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function rectPanel(id: string, order: number, x1: number, y1: number, x2: number, y2: number): LayoutPanel {
  return {
    id,
    order,
    shape: { type: "rect", bounds: [round(x1), round(y1), round(x2), round(y2)] },
    frame: { ...DEFAULT_PANEL_FRAME }
  };
}

/**
 * rows×cols の均等グリッドを rect コマで作る。読み順は各段で右→左、段は上→下(rtl の漫画)。
 */
function gridPanels(rows: number, cols: number): LayoutPanel[] {
  const contentW = 1 - MARGIN * 2;
  const contentH = PAGE_HEIGHT - MARGIN * 2;
  const cellW = (contentW - GUTTER * (cols - 1)) / cols;
  const cellH = (contentH - GUTTER * (rows - 1)) / rows;

  const panels: LayoutPanel[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x1 = MARGIN + c * (cellW + GUTTER);
      const y1 = MARGIN + r * (cellH + GUTTER);
      // rtl: 右端(c = cols-1)を段内の先頭にする。
      const order = r * cols + (cols - 1 - c) + 1;
      panels.push(rectPanel(`r${r + 1}c${c + 1}`, order, x1, y1, x1 + cellW, y1 + cellH));
    }
  }
  panels.sort((a, b) => a.order - b.order);
  return panels;
}

function preset(id: string, name: string, panels: LayoutPanel[]): BuiltinLayoutTemplate {
  return {
    id: `builtin:${id}`,
    name,
    layout: {
      version: 1,
      page: { aspectRatio: PAGE_ASPECT, height: PAGE_HEIGHT },
      readingDirection: "rtl",
      panels
    }
  };
}

/** 表紙: 上に細いタイトル帯 + 下に大きな絵のコマ。 */
function coverPanels(): LayoutPanel[] {
  const right = 1 - MARGIN;
  const bottom = PAGE_HEIGHT - MARGIN;
  const titleBottom = MARGIN + 0.24;
  return [
    rectPanel("title", 1, MARGIN, MARGIN, right, titleBottom),
    rectPanel("art", 2, MARGIN, titleBottom + GUTTER, right, bottom)
  ];
}

/** 会話の導入→反応→決めを作る、上段大ゴマ+下段2コマ。 */
function threeHeroTopPanels(): LayoutPanel[] {
  const left = MARGIN;
  const right = 1 - MARGIN;
  const bottom = PAGE_HEIGHT - MARGIN;
  const heroBottom = MARGIN + 0.72;
  const half = (right - left - GUTTER) / 2;
  return [
    rectPanel("hero", 1, left, MARGIN, right, heroBottom),
    rectPanel("reaction-right", 2, left + half + GUTTER, heroBottom + GUTTER, right, bottom),
    rectPanel("reaction-left", 3, left, heroBottom + GUTTER, left + half, bottom)
  ];
}

/** 小さな導入3コマから下段の大ゴマへ落とす、アクション/発見向け。 */
function fourHeroBottomPanels(): LayoutPanel[] {
  const left = MARGIN;
  const right = 1 - MARGIN;
  const bottom = PAGE_HEIGHT - MARGIN;
  const topBottom = MARGIN + 0.43;
  const cell = (right - left - GUTTER * 2) / 3;
  return [
    rectPanel("setup-right", 1, left + (cell + GUTTER) * 2, MARGIN, right, topBottom),
    rectPanel("setup-center", 2, left + cell + GUTTER, MARGIN, left + cell * 2 + GUTTER, topBottom),
    rectPanel("setup-left", 3, left, MARGIN, left + cell, topBottom),
    rectPanel("payoff", 4, left, topBottom + GUTTER, right, bottom)
  ];
}

/** 右の縦長主役コマから左の3段へ流す、追跡/対決向け。 */
function fourVerticalHeroPanels(): LayoutPanel[] {
  const left = MARGIN;
  const right = 1 - MARGIN;
  const bottom = PAGE_HEIGHT - MARGIN;
  const heroLeft = 0.55;
  const smallHeight = (bottom - MARGIN - GUTTER * 2) / 3;
  return [
    rectPanel("hero-right", 1, heroLeft, MARGIN, right, bottom),
    rectPanel("left-top", 2, left, MARGIN, heroLeft - GUTTER, MARGIN + smallHeight),
    rectPanel("left-middle", 3, left, MARGIN + smallHeight + GUTTER, heroLeft - GUTTER, MARGIN + smallHeight * 2 + GUTTER),
    rectPanel("left-bottom", 4, left, MARGIN + (smallHeight + GUTTER) * 2, heroLeft - GUTTER, bottom)
  ];
}

/** 内蔵テンプレ一覧(表示順)。 */
export const LAYOUT_PRESETS: BuiltinLayoutTemplate[] = [
  preset("cover", "表紙(タイトル+大ゴマ)", coverPanels()),
  preset("splash", "1コマ(大ゴマ)", gridPanels(1, 1)),
  preset("two-horizontal", "2コマ(上下)", gridPanels(2, 1)),
  preset("two-vertical", "2コマ(左右)", gridPanels(1, 2)),
  preset("three-horizontal", "3コマ(3段)", gridPanels(3, 1)),
  preset("three-hero-top", "3コマ(上段大ゴマ)", threeHeroTopPanels()),
  preset("four-grid", "4コマ(2×2)", gridPanels(2, 2)),
  preset("four-hero-bottom", "4コマ(下段大ゴマ)", fourHeroBottomPanels()),
  preset("four-vertical-hero", "4コマ(右縦大ゴマ)", fourVerticalHeroPanels()),
  preset("six-panel", "6コマ(3段×2)", gridPanels(3, 2)),
  preset("yonkoma", "4コマ(縦4段)", gridPanels(4, 1))
];

/** id で内蔵テンプレを引く(見つからなければ null)。 */
export function findLayoutPreset(id: string): BuiltinLayoutTemplate | null {
  return LAYOUT_PRESETS.find((template) => template.id === id) ?? null;
}
