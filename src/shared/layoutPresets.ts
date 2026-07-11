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

/** 右の縦大ゴマを先に読み、左上→左下へ落とす。人物対決や移動の方向感に向く。 */
function threeSideHeroPanels(): LayoutPanel[] {
  const left = MARGIN;
  const right = 1 - MARGIN;
  const bottom = PAGE_HEIGHT - MARGIN;
  const heroLeft = 0.49;
  const splitY = MARGIN + (bottom - MARGIN - GUTTER) * 0.47;
  return [
    rectPanel("hero-right", 1, heroLeft, MARGIN, right, bottom),
    rectPanel("left-top", 2, left, MARGIN, heroLeft - GUTTER, splitY),
    rectPanel("left-bottom", 3, left, splitY + GUTTER, heroLeft - GUTTER, bottom)
  ];
}

/** 上段の短い2コマで溜め、下段の横長大ゴマで決める。 */
function threeHeroBottomPanels(): LayoutPanel[] {
  const left = MARGIN;
  const right = 1 - MARGIN;
  const bottom = PAGE_HEIGHT - MARGIN;
  const topBottom = MARGIN + 0.43;
  const half = (right - left - GUTTER) / 2;
  return [
    rectPanel("setup-right", 1, left + half + GUTTER, MARGIN, right, topBottom),
    rectPanel("setup-left", 2, left, MARGIN, left + half, topBottom),
    rectPanel("payoff", 3, left, topBottom + GUTTER, right, bottom)
  ];
}

/** 小さな導入3コマから下段の大ゴマへ落とす、アクション/発見向け。 */
function fourHeroBottomPanels(): LayoutPanel[] {
  const left = MARGIN;
  const right = 1 - MARGIN;
  const bottom = PAGE_HEIGHT - MARGIN;
  const topBottom = MARGIN + 0.3;
  const middleBottom = topBottom + GUTTER + 0.22;
  const half = (right - left - GUTTER) / 2;
  return [
    rectPanel("setup-right", 1, left + half + GUTTER, MARGIN, right, topBottom),
    rectPanel("setup-left", 2, left, MARGIN, left + half, topBottom),
    rectPanel("bridge", 3, left, topBottom + GUTTER, right, middleBottom),
    rectPanel("payoff", 4, left, middleBottom + GUTTER, right, bottom)
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

/** 上段・中段を2コマずつ進め、下段の横長コマで締める5コマ構成。 */
function fivePanelPanels(): LayoutPanel[] {
  const left = MARGIN;
  const right = 1 - MARGIN;
  const bottom = PAGE_HEIGHT - MARGIN;
  const half = (right - left - GUTTER) / 2;
  const rowHeight = (bottom - MARGIN - GUTTER * 2) / 3;
  const middleTop = MARGIN + rowHeight + GUTTER;
  const bottomTop = middleTop + rowHeight + GUTTER;
  return [
    rectPanel("top-right", 1, left + half + GUTTER, MARGIN, right, MARGIN + rowHeight),
    rectPanel("top-left", 2, left, MARGIN, left + half, MARGIN + rowHeight),
    rectPanel("middle-right", 3, left + half + GUTTER, middleTop, right, middleTop + rowHeight),
    rectPanel("middle-left", 4, left, middleTop, left + half, middleTop + rowHeight),
    rectPanel("payoff", 5, left, bottomTop, right, bottom)
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
  preset("three-side-hero", "3コマ(右縦大ゴマ)", threeSideHeroPanels()),
  preset("three-hero-bottom", "3コマ(下段大ゴマ)", threeHeroBottomPanels()),
  preset("four-grid", "4コマ(2×2)", gridPanels(2, 2)),
  preset("four-hero-bottom", "4コマ(下段大ゴマ)", fourHeroBottomPanels()),
  preset("four-vertical-hero", "4コマ(右縦大ゴマ)", fourVerticalHeroPanels()),
  preset("five-panel", "5コマ(2列+下段大ゴマ)", fivePanelPanels()),
  preset("six-panel", "6コマ(3段×2)", gridPanels(3, 2)),
  preset("yonkoma", "4コマ(縦4段)", gridPanels(4, 1))
];

const SCRIPT_MANGA_LAYOUTS_BY_PANEL_COUNT: Readonly<Record<number, readonly string[]>> = {
  1: ["builtin:splash"],
  2: ["builtin:two-horizontal", "builtin:two-vertical"],
  3: ["builtin:three-horizontal", "builtin:three-hero-top", "builtin:three-side-hero", "builtin:three-hero-bottom"],
  4: ["builtin:four-grid", "builtin:four-hero-bottom", "builtin:four-vertical-hero"],
  5: ["builtin:five-panel"],
  6: ["builtin:six-panel"]
};

/** 自動漫画で選択可能な内蔵レイアウトを、正確なコマ数ごとに返す。 */
export function scriptMangaLayoutCandidates(panelCount: number): string[] {
  if (!Number.isInteger(panelCount) || panelCount < 1 || panelCount > 6) return [];
  return [...(SCRIPT_MANGA_LAYOUTS_BY_PANEL_COUNT[panelCount] ?? [])];
}

/** id で内蔵テンプレを引く(見つからなければ null)。 */
export function findLayoutPreset(id: string): BuiltinLayoutTemplate | null {
  return LAYOUT_PRESETS.find((template) => template.id === id) ?? null;
}

/** 内蔵テンプレートのコマ数を返す。外部テンプレート解決器の既定実装としても使える。 */
export function builtinLayoutPanelCount(id: string): number | null {
  return findLayoutPreset(id)?.layout.panels.length ?? null;
}
