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
import { DEFAULT_PANEL_FRAME, PANEL_BLEED_OVERSHOOT, type LayoutPanel, type PageLayout } from "./pageLayout";
import { orderPanelsByReadingDirection } from "./dialogueAutoLayout";

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
  preset("six-panel", "6コマ(3段×2)", gridPanels(3, 2)),
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
  "builtin:six-panel": "3x2 grid",
  "builtin:yonkoma": "four vertical strips (4-koma)",
  "builtin:cover": "title band plus large art panel"
};

export interface ScriptMangaLayoutDescriptor {
  id: string;
  panelCount: number;
  description: string;
  /** ぶち抜き立ち絵スロットの読み順位置(1始まり)。figure スロットが無ければ省略。 */
  figureSlot?: number;
}

/**
 * レイアウト id 群を LLM 監督/provided plan 作者向けの記述子へ変換する。`figureSlot` は
 * 実行時と同じ `orderPanelsByReadingDirection` で計算するため、plan の panels[index] ↔
 * layout スロットの対応(reading-order zip)と常に一致する。
 */
export function describeScriptMangaLayouts(ids: readonly string[]): ScriptMangaLayoutDescriptor[] {
  return ids.flatMap((id) => {
    const template = findLayoutPreset(id);
    if (!template) return [];
    const ordered = orderPanelsByReadingDirection(template.layout.panels, template.layout.readingDirection);
    const figureIndex = ordered.findIndex((panel) => panel.role === "figure");
    const descriptor: ScriptMangaLayoutDescriptor = {
      id,
      panelCount: template.layout.panels.length,
      description: SCRIPT_MANGA_LAYOUT_DESCRIPTIONS[id] ?? template.name
    };
    if (figureIndex >= 0) descriptor.figureSlot = figureIndex + 1;
    return [descriptor];
  });
}
