/**
 * 内蔵のコマ割りテンプレート(プリセット)。Book のページ一覧の「テンプレから追加」で選べる、
 * よく使う漫画レイアウト。DB には持たず(取り込み分だけ DB)、コード側で管理する。
 *
 * 座標系は `PageLayout` と同じ width-relative-top-left。B5 相当(aspectRatio [182,257])で、
 * 余白/コマ間(GUTTER)を取った rect コマで構成する。読み順は右→左(rtl)。
 *
 * 通常コマのほかに、次の「自由な構図」プリセットを持つ(Docs/Reference-MangaCompositions.md):
 * - 裁ち切り(bleed): 紙端に接する辺を BLEED だけページ外へはみ出させる。枠線はページ外に
 *   落ちるため描かれず、絵が紙端まで届く(断ち切りコマ)。preflight は
 *   `PANEL_BLEED_OVERSHOOT` までのはみ出しを許容する。
 * - 斜めゴマ: polygon shape によるガター傾斜。
 * - ぶち抜き立ち絵スロット: `role: "figure"` + 枠なし。自動漫画ではこのスロットの選択候補が
 *   背景除去+白フチの切り抜き(ImageObject)としてコマ枠の前面へ重ねられる。
 */
import { DEFAULT_PANEL_FRAME, PANEL_BLEED_OVERSHOOT, panelBounds, type LayoutPanel, type PageLayout, type PanelShape } from "./pageLayout";
import { orderPanelsByReadingDirection } from "./dialogueAutoLayout";
import type { MangaPanelImportance } from "./mangaPlanV2";

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
/**
 * 裁ち切りコマのはみ出し量。既定枠線幅 0.006(中心線描画で半分の 0.003 が外側)より大きく取り、
 * 枠線が紙面外へ完全に落ちる=紙端に線が出ないようにする。`PANEL_BLEED_OVERSHOOT`(0.02)以内。
 */
const BLEED = 0.015;

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

/** ぶち抜き立ち絵スロット(枠なし+role:"figure")。 */
function figurePanel(id: string, order: number, x1: number, y1: number, x2: number, y2: number): LayoutPanel {
  return {
    id,
    order,
    shape: { type: "rect", bounds: [round(x1), round(y1), round(x2), round(y2)] },
    frame: { ...DEFAULT_PANEL_FRAME, visible: false },
    role: "figure"
  };
}

/** 全面裁ち切りの1コマ(扉絵・クライマックスの見開き級の見せ場)。 */
function splashBleedPanels(): LayoutPanel[] {
  return [rectPanel("bleed", 1, -BLEED, -BLEED, 1 + BLEED, PAGE_HEIGHT + BLEED)];
}

/** 天と左右へ裁ち切る上段大ゴマ+通常余白の締めコマ。 */
function twoBleedHeroTopPanels(): LayoutPanel[] {
  const heroBottom = 0.92;
  return [
    rectPanel("hero-bleed", 1, -BLEED, -BLEED, 1 + BLEED, heroBottom),
    rectPanel("closer", 2, MARGIN, heroBottom + GUTTER, 1 - MARGIN, PAGE_HEIGHT - MARGIN)
  ];
}

/** 天と左右へ裁ち切る上段大ゴマ+下段2コマ。 */
function threeBleedHeroTopPanels(): LayoutPanel[] {
  const heroBottom = 0.86;
  const half = (1 - MARGIN * 2 - GUTTER) / 2;
  return [
    rectPanel("hero-bleed", 1, -BLEED, -BLEED, 1 + BLEED, heroBottom),
    rectPanel("reaction-right", 2, MARGIN + half + GUTTER, heroBottom + GUTTER, 1 - MARGIN, PAGE_HEIGHT - MARGIN),
    rectPanel("reaction-left", 3, MARGIN, heroBottom + GUTTER, MARGIN + half, PAGE_HEIGHT - MARGIN)
  ];
}

/** 縦3列すべて天地へ裁ち切るスラット構成(モンタージュ・時間経過・列挙)。 */
function threeBleedVerticalPanels(): LayoutPanel[] {
  const width = (1 - GUTTER * 2) / 3;
  const x1 = width;
  const x2 = width * 2 + GUTTER;
  return [
    rectPanel("slat-right", 1, x2 + GUTTER, -BLEED, 1 + BLEED, PAGE_HEIGHT + BLEED),
    rectPanel("slat-center", 2, x1 + GUTTER, -BLEED, x2, PAGE_HEIGHT + BLEED),
    rectPanel("slat-left", 3, -BLEED, -BLEED, x1, PAGE_HEIGHT + BLEED)
  ];
}

/** ガターを斜めに切った3段(緊張・スピード・感情の乱れ)。 */
function threeDiagonalPanels(): LayoutPanel[] {
  const left = MARGIN;
  const right = 1 - MARGIN;
  const slant = 0.05;
  const bottom = PAGE_HEIGHT - MARGIN;
  const polygon = (id: string, order: number, points: [number, number][]): LayoutPanel => ({
    id,
    order,
    shape: { type: "polygon", points: points.map(([x, y]) => [round(x), round(y)]) },
    frame: { ...DEFAULT_PANEL_FRAME }
  });
  return [
    polygon("d1", 1, [[left, MARGIN], [right, MARGIN], [right, 0.42 - slant], [left, 0.42 + slant]]),
    polygon("d2", 2, [[left, 0.42 + slant + GUTTER], [right, 0.42 - slant + GUTTER], [right, 0.9 + slant], [left, 0.9 - slant]]),
    polygon("d3", 3, [[left, 0.9 - slant + GUTTER], [right, 0.9 + slant + GUTTER], [right, bottom], [left, bottom]])
  ];
}

/** 右2段+左ぶち抜き立ち絵スロット(読み順: 右上→右下→立ち絵)。 */
function threeFigureLeftPanels(): LayoutPanel[] {
  const figureRight = 0.4;
  return [
    rectPanel("story-1", 1, figureRight + GUTTER, MARGIN, 1 - MARGIN, MARGIN + 0.62),
    rectPanel("story-2", 2, figureRight + GUTTER, MARGIN + 0.62 + GUTTER, 1 - MARGIN, PAGE_HEIGHT - MARGIN),
    figurePanel("figure", 3, MARGIN, MARGIN, figureRight, PAGE_HEIGHT - MARGIN)
  ];
}

/** 上段全幅の大ゴマ+2×2の5コマ構成(hero×最大スロット整合用、ネームv4 D1)。 */
function fiveHeroTopPanels(): LayoutPanel[] {
  const left = MARGIN;
  const right = 1 - MARGIN;
  const bottom = PAGE_HEIGHT - MARGIN;
  const heroBottom = MARGIN + 0.56;
  const half = (right - left - GUTTER) / 2;
  const rowHeight = (bottom - heroBottom - GUTTER * 2) / 2;
  const middleTop = heroBottom + GUTTER;
  const bottomTop = middleTop + rowHeight + GUTTER;
  return [
    rectPanel("hero", 1, left, MARGIN, right, heroBottom),
    rectPanel("middle-right", 2, left + half + GUTTER, middleTop, right, middleTop + rowHeight),
    rectPanel("middle-left", 3, left, middleTop, left + half, middleTop + rowHeight),
    rectPanel("bottom-right", 4, left + half + GUTTER, bottomTop, right, bottom),
    rectPanel("bottom-left", 5, left, bottomTop, left + half, bottom)
  ];
}

/** 上段2コマ→中段右の大ゴマ→下段2コマの6コマ構成(会話の溜め→見せ場→残響、ネームv4 D1)。 */
function sixHeroRightPanels(): LayoutPanel[] {
  const left = MARGIN;
  const right = 1 - MARGIN;
  const bottom = PAGE_HEIGHT - MARGIN;
  const half = (right - left - GUTTER) / 2;
  const topBottom = MARGIN + 0.34;
  const middleTop = topBottom + GUTTER;
  const middleBottom = middleTop + 0.6;
  const bottomTop = middleBottom + GUTTER;
  const heroLeft = 0.34;
  return [
    rectPanel("top-right", 1, left + half + GUTTER, MARGIN, right, topBottom),
    rectPanel("top-left", 2, left, MARGIN, left + half, topBottom),
    rectPanel("hero", 3, heroLeft, middleTop, right, middleBottom),
    rectPanel("middle-left", 4, left, middleTop, heroLeft - GUTTER, middleBottom),
    rectPanel("bottom-right", 5, left + half + GUTTER, bottomTop, right, bottom),
    rectPanel("bottom-left", 6, left, bottomTop, left + half, bottom)
  ];
}

/** 右3段+左ぶち抜き立ち絵スロット。 */
function fourFigureLeftPanels(): LayoutPanel[] {
  const figureRight = 0.38;
  const columnLeft = figureRight + GUTTER;
  const rowHeight = (PAGE_HEIGHT - MARGIN * 2 - GUTTER * 2) / 3;
  return [
    rectPanel("story-1", 1, columnLeft, MARGIN, 1 - MARGIN, MARGIN + rowHeight),
    rectPanel("story-2", 2, columnLeft, MARGIN + rowHeight + GUTTER, 1 - MARGIN, MARGIN + rowHeight * 2 + GUTTER),
    rectPanel("story-3", 3, columnLeft, MARGIN + (rowHeight + GUTTER) * 2, 1 - MARGIN, PAGE_HEIGHT - MARGIN),
    figurePanel("figure", 4, MARGIN, MARGIN, figureRight, PAGE_HEIGHT - MARGIN)
  ];
}

/** 内蔵テンプレ一覧(表示順)。 */
export const LAYOUT_PRESETS: BuiltinLayoutTemplate[] = [
  preset("cover", "表紙(タイトル+大ゴマ)", coverPanels()),
  preset("splash", "1コマ(大ゴマ)", gridPanels(1, 1)),
  preset("splash-bleed", "1コマ(全面裁ち切り)", splashBleedPanels()),
  preset("two-horizontal", "2コマ(上下)", gridPanels(2, 1)),
  preset("two-vertical", "2コマ(左右)", gridPanels(1, 2)),
  preset("two-bleed-hero-top", "2コマ(上段裁ち切り大ゴマ)", twoBleedHeroTopPanels()),
  preset("three-horizontal", "3コマ(3段)", gridPanels(3, 1)),
  preset("three-hero-top", "3コマ(上段大ゴマ)", threeHeroTopPanels()),
  preset("three-side-hero", "3コマ(右縦大ゴマ)", threeSideHeroPanels()),
  preset("three-hero-bottom", "3コマ(下段大ゴマ)", threeHeroBottomPanels()),
  preset("three-bleed-hero-top", "3コマ(上段裁ち切り大ゴマ)", threeBleedHeroTopPanels()),
  preset("three-bleed-vertical", "3コマ(縦3列裁ち切り)", threeBleedVerticalPanels()),
  preset("three-diagonal", "3コマ(斜めゴマ)", threeDiagonalPanels()),
  preset("three-figure-left", "3コマ(右2段+左ぶち抜き立ち絵)", threeFigureLeftPanels()),
  preset("four-grid", "4コマ(2×2)", gridPanels(2, 2)),
  preset("four-hero-bottom", "4コマ(下段大ゴマ)", fourHeroBottomPanels()),
  preset("four-vertical-hero", "4コマ(右縦大ゴマ)", fourVerticalHeroPanels()),
  preset("four-figure-left", "4コマ(右3段+左ぶち抜き立ち絵)", fourFigureLeftPanels()),
  preset("five-panel", "5コマ(2列+下段大ゴマ)", fivePanelPanels()),
  preset("five-hero-top", "5コマ(上段大ゴマ)", fiveHeroTopPanels()),
  preset("six-panel", "6コマ(3段×2)", gridPanels(3, 2)),
  preset("six-hero-right", "6コマ(中段右大ゴマ)", sixHeroRightPanels()),
  preset("yonkoma", "4コマ(縦4段)", gridPanels(4, 1))
];

/**
 * 自動漫画がコマ数ごとに選べる候補。**各配列の先頭は決定的プランナー/N1 フォールバックの既定**
 * なので、新プリセットは必ず末尾へ追加する(既定を変えると全 run の既定構図が変わってしまう)。
 * bleed/figure 系は LLM 監督(または provided plan)が意図を持って選ぶ想定の候補。
 */
const SCRIPT_MANGA_LAYOUTS_BY_PANEL_COUNT: Readonly<Record<number, readonly string[]>> = {
  1: ["builtin:splash", "builtin:splash-bleed"],
  2: ["builtin:two-horizontal", "builtin:two-vertical", "builtin:two-bleed-hero-top"],
  3: [
    "builtin:three-horizontal",
    "builtin:three-hero-top",
    "builtin:three-side-hero",
    "builtin:three-hero-bottom",
    "builtin:three-bleed-hero-top",
    "builtin:three-bleed-vertical",
    "builtin:three-diagonal",
    "builtin:three-figure-left"
  ],
  4: ["builtin:four-grid", "builtin:four-hero-bottom", "builtin:four-vertical-hero", "builtin:four-figure-left"],
  5: ["builtin:five-panel", "builtin:five-hero-top"],
  6: ["builtin:six-panel", "builtin:six-hero-right"]
};

/**
 * 取り込みテンプレの候補プール参加(ネームv4 D6 / SPEC v0.3 §23.1)。`autoManga.candidate:true` の
 * 取り込みテンプレをサーバが登録し、内蔵候補の**末尾**へ加わる(既定=先頭の互換維持)。
 * 参加要件: コマ数1〜6 / 全コマ rect または polygon / bleedOvershoot 検証(取り込み時に済)。
 */
export interface ScriptMangaExternalLayout {
  id: string;
  name: string;
  layout: PageLayout;
  /** LLM向け英語説明。省略時は面積プロファイルから自動生成する。 */
  description?: string;
  /** hero スロット上書き(SPEC autoManga.emphasisPanelIds)。省略時は面積最大。 */
  emphasisPanelIds?: string[];
}

let externalScriptMangaLayouts: ScriptMangaExternalLayout[] = [];

/** 参加要件(§23.1)を満たすか。 */
export function isEligibleScriptMangaExternalLayout(layout: PageLayout): boolean {
  if (layout.panels.length < 1 || layout.panels.length > 6) return false;
  return layout.panels.every((panel) => panel.shape.type === "rect" || panel.shape.type === "polygon");
}

/** サーバが取り込みテンプレ一覧の更新時に呼ぶ。要件を満たさないものは黙って除外する。 */
export function setExternalScriptMangaLayouts(entries: readonly ScriptMangaExternalLayout[]): void {
  externalScriptMangaLayouts = entries.filter((entry) => isEligibleScriptMangaExternalLayout(entry.layout));
}

export function listExternalScriptMangaLayouts(): readonly ScriptMangaExternalLayout[] {
  return externalScriptMangaLayouts;
}

function findExternalScriptMangaLayout(id: string): ScriptMangaExternalLayout | null {
  return externalScriptMangaLayouts.find((entry) => entry.id === id) ?? null;
}

/** 自動漫画で選択可能なレイアウト(内蔵+候補参加の取り込みテンプレ)を、正確なコマ数ごとに返す。 */
export function scriptMangaLayoutCandidates(panelCount: number): string[] {
  if (!Number.isInteger(panelCount) || panelCount < 1 || panelCount > 6) return [];
  return [
    ...(SCRIPT_MANGA_LAYOUTS_BY_PANEL_COUNT[panelCount] ?? []),
    ...externalScriptMangaLayouts.filter((entry) => entry.layout.panels.length === panelCount).map((entry) => entry.id)
  ];
}

/** id で内蔵テンプレを引く(見つからなければ null)。 */
export function findLayoutPreset(id: string): BuiltinLayoutTemplate | null {
  return LAYOUT_PRESETS.find((template) => template.id === id) ?? null;
}

/** 内蔵テンプレートのコマ数を返す。外部テンプレート解決器の既定実装としても使える。 */
export function builtinLayoutPanelCount(id: string): number | null {
  return findLayoutPreset(id)?.layout.panels.length ?? null;
}

/** LLM 監督・provided plan 作者へ渡すレイアウト候補の説明(英語)。 */
const SCRIPT_MANGA_LAYOUT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "builtin:splash": "single framed panel with page margins",
  "builtin:splash-bleed": "single borderless splash; the art bleeds off every page edge (cinematic full-page beat)",
  "builtin:two-horizontal": "two stacked panels",
  "builtin:two-vertical": "two side-by-side panels",
  "builtin:two-bleed-hero-top": "top hero panel bleeds off the top and side page edges (borderless); framed closer panel below",
  "builtin:three-horizontal": "three stacked strips",
  "builtin:three-hero-top": "large hero panel on top, two reaction panels below",
  "builtin:three-side-hero": "tall hero panel on the right, two stacked panels on the left",
  "builtin:three-hero-bottom": "two setup panels on top, wide payoff panel below",
  "builtin:three-bleed-hero-top": "top hero panel bleeds off the page edges (borderless); two framed reaction panels below",
  "builtin:three-bleed-vertical": "three vertical slats bleeding off the top and bottom edges (montage, passage of time, enumeration)",
  "builtin:three-diagonal": "three stacked panels with slanted gutters (tension, speed, emotional turbulence)",
  "builtin:three-figure-left":
    "two story panels stacked on the right plus a punch-out figure slot on the left: that panel renders its single character as a borderless full-body cut-out standing over the page frames; give it the character-defining beat and keep its dialogue minimal",
  "builtin:four-grid": "2x2 grid",
  "builtin:four-hero-bottom": "two setup panels, a bridge strip, and a wide payoff panel",
  "builtin:four-vertical-hero": "tall hero panel on the right, three stacked panels on the left",
  "builtin:four-figure-left":
    "three story panels stacked on the right plus a punch-out figure slot on the left: that panel renders its single character as a borderless full-body cut-out standing over the page frames; give it the character-defining beat and keep its dialogue minimal",
  "builtin:five-panel": "two rows of two panels plus a wide bottom payoff",
  "builtin:five-hero-top": "wide hero panel on top, then a 2x2 grid of follow-up panels",
  "builtin:six-panel": "3x2 grid",
  "builtin:six-hero-right": "two setup panels on top, a large hero panel on the middle right with a narrow side panel, two closing panels below",
  "builtin:yonkoma": "four vertical strips (4-koma)",
  "builtin:cover": "title band plus large art panel"
};

// --- 面積プロファイルとレイアウト事前選択(ネームv4 D1) ---

/**
 * shape の符号なし面積(page-width² 単位)。polygon は靴紐公式、ellipse は πab、
 * path は外接矩形による近似(内蔵/取り込み候補の参加要件は rect/polygon のみ)。
 */
export function panelShapeArea(shape: PanelShape): number {
  if (shape.type === "polygon") {
    let doubled = 0;
    for (let index = 0; index < shape.points.length; index += 1) {
      const [x1, y1] = shape.points[index]!;
      const [x2, y2] = shape.points[(index + 1) % shape.points.length]!;
      doubled += x1 * y2 - x2 * y1;
    }
    return Math.abs(doubled) / 2;
  }
  if (shape.type === "ellipse") {
    return Math.PI * Math.abs(shape.radius[0] * shape.radius[1]);
  }
  const [x1, y1, x2, y2] = panelBounds(shape);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

/**
 * レイアウトの reading-order 面積プロファイル(合計1の面積比)。並びは実行時の
 * plan panels[index] ↔ layout スロット対応と同じ `orderPanelsByReadingDirection`。
 */
export function pageLayoutAreaProfile(layout: PageLayout): number[] {
  const ordered = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
  const areas = ordered.map((panel) => panelShapeArea(panel.shape));
  const total = areas.reduce((sum, area) => sum + area, 0);
  if (!(total > 0)) return areas.map(() => 1 / Math.max(1, areas.length));
  return areas.map((area) => area / total);
}

/** レイアウト id の面積プロファイル(内蔵+候補参加の取り込みテンプレ。未知の id は null)。 */
export function layoutAreaProfile(id: string): number[] | null {
  const layout = findLayoutPreset(id)?.layout ?? findExternalScriptMangaLayout(id)?.layout ?? null;
  return layout ? pageLayoutAreaProfile(layout) : null;
}

/** 「強調スロットあり」とみなす、最大面積スロットの対2位面積比の下限。均等グリッドを除外する。 */
const LAYOUT_EMPHASIS_RATIO = 1.15;

/**
 * 面積プロファイルの強調スロット(reading-order index)。最大面積が2位の
 * `LAYOUT_EMPHASIS_RATIO` 倍以上のときだけ「強調あり」。均等グリッドや単コマは null。
 */
export function emphasizedSlotIndex(areas: readonly number[]): number | null {
  if (areas.length < 2) return null;
  let maxIndex = 0;
  for (let index = 1; index < areas.length; index += 1) {
    if (areas[index]! > areas[maxIndex]!) maxIndex = index;
  }
  const second = Math.max(...areas.filter((_, index) => index !== maxIndex));
  return areas[maxIndex]! >= second * LAYOUT_EMPHASIS_RATIO ? maxIndex : null;
}

export type ScriptMangaLayoutResolver = (id: string) => PageLayout | null;

/** 自動漫画で利用可能な内蔵・取り込みレイアウトを id から解決する。 */
export const resolveScriptMangaLayout: ScriptMangaLayoutResolver = (id) =>
  findLayoutPreset(id)?.layout ?? findExternalScriptMangaLayout(id)?.layout ?? null;

function heroSlotIndexes(importances: readonly MangaPanelImportance[]): number[] {
  return importances.flatMap((value, index) => (value === "hero" || value === "splash" ? [index] : []));
}

/**
 * レイアウトの強調スロット(reading-order index)。取り込みテンプレの
 * `autoManga.emphasisPanelIds` があれば面積最大より優先する(SPEC v0.3 §23.1)。
 */
function emphasizedSlotForLayout(id: string, layout: PageLayout): number | null {
  const external = findExternalScriptMangaLayout(id);
  if (external?.emphasisPanelIds?.length) {
    const ordered = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
    const index = ordered.findIndex((panel) => external.emphasisPanelIds!.includes(panel.id));
    if (index >= 0) return index;
  }
  return emphasizedSlotIndex(pageLayoutAreaProfile(layout));
}

/**
 * hero 構成とレイアウトの整合(heroコマが強調スロットに乗るか)。hero なし・単コマは常に整合。
 * 未解決 id やコマ数不一致は「判定不能」として整合扱い(監督/呼び出し側の裁量に任せる)。
 */
export function scriptMangaLayoutAlignsImportance(
  layoutTemplateId: string,
  importances: readonly MangaPanelImportance[],
  resolveLayout: ScriptMangaLayoutResolver = resolveScriptMangaLayout
): boolean {
  const heroes = heroSlotIndexes(importances);
  if (heroes.length === 0 || importances.length < 2) return true;
  const layout = resolveLayout(layoutTemplateId);
  if (!layout || layout.panels.length !== importances.length) return true;
  const slot = emphasizedSlotForLayout(layoutTemplateId, layout);
  return slot !== null && heroes.includes(slot);
}

/**
 * N1 の importance 構成からレイアウトを決定的に事前選択する(ネームv4 D1)。
 * - splash(単コマページ)→ 全面裁ち切り(bleed 候補)を優先。
 * - hero あり → hero×強調スロット一致を最優先。次点は「hero=2 / normal=1」の
 *   目標面積比との L1 距離が小さい候補。figure スロット付きは単独人物切り抜きへ
 *   意味が変わるため事前選択では避ける(監督が明示的に選ぶのは可)。
 * - 全 normal → 従来どおり候補先頭(既定構図の互換維持)。
 */
export function selectScriptMangaLayoutId(
  importances: readonly MangaPanelImportance[],
  resolveLayout: ScriptMangaLayoutResolver = resolveScriptMangaLayout
): string | null {
  const candidates = scriptMangaLayoutCandidates(importances.length);
  if (candidates.length === 0) return null;
  if (importances.length === 1) {
    if (importances[0] !== "splash") return candidates[0]!;
    return candidates.find((id) => id.includes("bleed")) ?? candidates[0]!;
  }
  const heroes = heroSlotIndexes(importances);
  if (heroes.length === 0) return candidates[0]!;
  const targetWeights = importances.map((value) => (value === "hero" || value === "splash" ? 2 : 1));
  const targetTotal = targetWeights.reduce((sum, weight) => sum + weight, 0);
  let best: { id: string; aligns: boolean; fit: number } | null = null;
  for (const id of candidates) {
    const layout = resolveLayout(id);
    if (!layout || layout.panels.length !== importances.length) continue;
    const ordered = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
    if (ordered.some((panel) => panel.role === "figure")) continue;
    const areas = pageLayoutAreaProfile(layout);
    const slot = emphasizedSlotForLayout(id, layout);
    const aligns = slot !== null && heroes.includes(slot);
    const fit = -importances.reduce(
      (sum, _, position) => sum + Math.abs(targetWeights[position]! / targetTotal - (areas[position] ?? 0)),
      0
    );
    // 候補順の走査なので、同点は常に先勝ち(既存並びの互換維持)。
    if (!best || (aligns && !best.aligns) || (aligns === best.aligns && fit > best.fit + 1e-9)) {
      best = { id, aligns, fit };
    }
  }
  return best?.id ?? candidates[0]!;
}

export interface ScriptMangaLayoutDescriptor {
  id: string;
  panelCount: number;
  description: string;
  /** ぶち抜き立ち絵スロットの読み順位置(1始まり)。figure スロットが無ければ省略。 */
  figureSlot?: number;
}

/**
 * 面積プロファイルからの英語説明の自動生成(ネームv4 D6: `autoManga.description` 省略時)。
 * LLM監督が候補として扱える最低限の情報(コマ数・強調スロット位置・裁ち切り)を持たせる。
 */
export function describeLayoutFromAreaProfile(layout: PageLayout): string {
  const areas = pageLayoutAreaProfile(layout);
  const slot = emphasizedSlotIndex(areas);
  const height = layout.page.height;
  const bleeds = layout.panels.some((panel) => {
    const [x1, y1, x2, y2] = panelBounds(panel.shape);
    return x1 < 0 || y1 < 0 || x2 > 1 || y2 > height;
  });
  const base = `imported ${areas.length}-panel layout`;
  const emphasis = slot !== null
    ? `, large hero slot at reading position ${slot + 1} (${Math.round((areas[slot] ?? 0) * 100)}% of the page)`
    : ", evenly sized panels";
  return `${base}${emphasis}${bleeds ? ", with art bleeding off the page edge" : ""}`;
}

/**
 * レイアウト id 群を LLM 監督/provided plan 作者向けの記述子へ変換する。`figureSlot` は
 * 実行時と同じ `orderPanelsByReadingDirection` で計算するため、plan の panels[index] ↔
 * layout スロットの対応(reading-order zip)と常に一致する。取り込み候補(autoManga)は
 * `description` があればそれを、無ければ面積プロファイルから自動生成した説明を使う。
 */
export function describeScriptMangaLayouts(ids: readonly string[]): ScriptMangaLayoutDescriptor[] {
  return ids.flatMap((id) => {
    const template = findLayoutPreset(id);
    const external = template ? null : findExternalScriptMangaLayout(id);
    const layout = template?.layout ?? external?.layout;
    if (!layout) return [];
    const ordered = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
    const figureIndex = ordered.findIndex((panel) => panel.role === "figure");
    const descriptor: ScriptMangaLayoutDescriptor = {
      id,
      panelCount: layout.panels.length,
      description: template
        ? SCRIPT_MANGA_LAYOUT_DESCRIPTIONS[id] ?? template.name
        : external!.description ?? describeLayoutFromAreaProfile(layout)
    };
    if (figureIndex >= 0) descriptor.figureSlot = figureIndex + 1;
    return [descriptor];
  });
}
