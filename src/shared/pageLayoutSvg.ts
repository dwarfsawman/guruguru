/**
 * コマ割りレイアウト(`PageLayout`)を文字列 SVG で描画する純関数。ページカードのコマ枠サムネ、
 * テンプレートピッカーのプレビュー、取り込み確認、プラン候補比較(ネームv4 D3)に使う。
 * house style(assetModal の `renderWebSamPromptOverlay` 等)に倣い createElementNS ではなく
 * 文字列 SVG を返す。元は client/views/pageLayoutSvg.ts(候補比較のため shared へ移動)。
 *
 * 座標は width-relative(x∈[0,1], y∈[0,page.height])。viewBox を `0 0 1000 {1000*height}` に取り、
 * 全体を `scale(1000)` した group 内に正規化座標のまま描くことで path の `d` もスケール不要にする。
 * 線幅も group 内で正規化値(例 0.006)を渡せば scale(1000) で 6 viewBox 単位となり、コマ枠は
 * 紙面幅に比例した太さで描かれる(印刷相当の見え方)。
 */
import type { LayoutPanel, PageLayout, PanelShape } from "./pageLayout";
import { DEFAULT_PANEL_FRAME, panelBounds } from "./pageLayout";
import type { MangaPageTurnHook, MangaVisualScale } from "./mangaPlanV2";
import { orderPanelsByReadingDirection } from "./dialogueAutoLayout";
import { escapeAttr } from "./htmlEscape";

const VIEWBOX_SCALE = 1000;

export interface PageLayoutSvgOptions {
  /** ルート svg の class。 */
  className?: string;
  /** 紙面(背景)の塗り。既定は CSS var(--layout-paper) + フォールバック。 */
  paper?: string;
  /** コマ枠の線色。既定は CSS var(--layout-koma) + フォールバック。 */
  stroke?: string;
  /** コマ番号(order)を中央に描く。 */
  showOrder?: boolean;
  /** aria-label(未指定なら装飾扱い aria-hidden)。 */
  ariaLabel?: string;
}

const DEFAULT_PAPER = "var(--layout-paper, #efece6)";
const DEFAULT_STROKE = "var(--layout-koma, #17140f)";

/** 浮動小数を短く整形(末尾ゼロ除去)。コマ内生成(pagePanelLightboxView)のジオメトリ計算とも共有する。 */
export function num(value: number): string {
  return Number(value.toFixed(5)).toString();
}

/** 形状の中心(コマ番号の配置、コマ内生成の空コマヒント表示に使う)。 */
export function shapeCenter(shape: PanelShape): [number, number] | null {
  if (shape.type === "polygon") {
    const n = shape.points.length;
    if (n === 0) {
      return null;
    }
    const sum = shape.points.reduce<[number, number]>((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
    return [sum[0] / n, sum[1] / n];
  }
  if (shape.type === "rect") {
    return [(shape.bounds[0] + shape.bounds[2]) / 2, (shape.bounds[1] + shape.bounds[3]) / 2];
  }
  if (shape.type === "ellipse") {
    return shape.center;
  }
  if (shape.bezier) {
    const nodes = shape.bezier.nodes;
    return nodes.reduce<[number, number]>(
      (sum, node) => [sum[0] + node.point[0] / nodes.length, sum[1] + node.point[1] / nodes.length],
      [0, 0]
    );
  }
  return null;
}

/** shape を素の SVG 形状要素にする(fill/stroke 等の装飾属性は `attrs` で指定)。 */
function shapeGeometryElement(shape: PanelShape, attrs: string): string {
  if (shape.type === "polygon") {
    const points = shape.points.map(([x, y]) => `${num(x)},${num(y)}`).join(" ");
    return `<polygon points="${points}" ${attrs} />`;
  }
  if (shape.type === "rect") {
    const [x1, y1, x2, y2] = shape.bounds;
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    const rx = shape.cornerRadius ? ` rx="${num(shape.cornerRadius)}"` : "";
    return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"${rx} ${attrs} />`;
  }
  if (shape.type === "ellipse") {
    return `<ellipse cx="${num(shape.center[0])}" cy="${num(shape.center[1])}" rx="${num(shape.radius[0])}" ry="${num(shape.radius[1])}" ${attrs} />`;
  }
  return `<path d="${escapeAttr(shape.d)}" ${attrs} />`;
}

/**
 * shape を装飾なしの素の SVG 形状要素にする。コマ内生成(pagePanelLightboxView)が
 * `<clipPath>` の中身や data 属性付きのドラッグ対象要素として再利用する。
 */
export function panelShapeElement(shape: PanelShape, attrs = ""): string {
  return shapeGeometryElement(shape, attrs);
}

function shapeElement(shape: PanelShape, stroke: string, strokeWidth: number): string {
  return shapeGeometryElement(
    shape,
    `fill="none" stroke="${escapeAttr(stroke)}" stroke-width="${num(strokeWidth)}" stroke-linejoin="miter"`
  );
}

function panelElement(panel: LayoutPanel, defaultStroke: string, showOrder: boolean): string {
  const frame = panel.frame ?? DEFAULT_PANEL_FRAME;
  if (frame.visible === false && panel.role !== "figure") {
    return "";
  }
  const stroke = defaultStroke;
  // ぶち抜き立ち絵スロット(枠なし)は実描画では線を引かないが、サムネ/ピッカーでは破線で
  // スロット位置が分かるようにする(Docs/Reference-MangaCompositions.md)。
  const parts = [
    frame.visible === false
      ? shapeGeometryElement(
          panel.shape,
          `fill="none" stroke="${escapeAttr(stroke)}" stroke-width="${num(DEFAULT_PANEL_FRAME.strokeWidth * 0.75)}" stroke-dasharray="0.024 0.016" opacity="0.55"`
        )
      : shapeElement(panel.shape, stroke, frame.strokeWidth)
  ];
  if (showOrder) {
    const center = shapeCenter(panel.shape);
    if (center) {
      parts.push(
        `<text x="${num(center[0])}" y="${num(center[1])}" class="page-layout-order" font-size="0.06" text-anchor="middle" dominant-baseline="central">${panel.order}</text>`
      );
    }
  }
  return parts.join("");
}

/**
 * `PageLayout` を SVG 文字列に描画する。コマ枠は紙面幅に比例した太さ(frame.strokeWidth)で描く。
 * `preserveAspectRatio="xMidYMid meet"` で親要素に収める。
 */
export function renderPageLayoutSvg(layout: PageLayout, options: PageLayoutSvgOptions = {}): string {
  const width = VIEWBOX_SCALE;
  const height = VIEWBOX_SCALE * layout.page.height;
  const paper = options.paper ?? DEFAULT_PAPER;
  const stroke = options.stroke ?? DEFAULT_STROKE;
  const classAttr = options.className ? ` class="${escapeAttr(options.className)}"` : "";
  const a11y = options.ariaLabel
    ? ` role="img" aria-label="${escapeAttr(options.ariaLabel)}"`
    : ` aria-hidden="true"`;

  const panels = layout.panels.map((panel) => panelElement(panel, stroke, options.showOrder ?? false)).join("");

  return `<svg${classAttr} viewBox="0 0 ${num(width)} ${num(height)}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"${a11y}>
    <g transform="scale(${VIEWBOX_SCALE})">
      <rect x="0" y="0" width="1" height="${num(layout.page.height)}" fill="${escapeAttr(paper)}" />
      ${panels}
    </g>
  </svg>`;
}

// --- プラン候補ワイヤーフレーム(ネームv4 D3) ---

/** reading-order で layout スロットと対応する、コマ1つ分の注釈情報。 */
export interface WireframePanelInfo {
  /** 解決済みコマスケール(V5 D1)。large/splash は強調塗り、small は減光。旧planはparse境界で正規化済み。 */
  visualScale?: MangaVisualScale;
  /** コマ内台詞の合計文字数(台詞量バー)。 */
  dialogueCharacters?: number;
  /** コマに割り当てたビートの kind 列(アイコン表示)。 */
  beatKinds?: string[];
}

export interface PageWireframeOptions extends PageLayoutSvgOptions {
  /** reading-order 順(plan panels[index] と同じ対応)。 */
  panels?: WireframePanelInfo[];
  turnHook?: MangaPageTurnHook;
  /** 候補間diffハイライト(ページ割りが他候補と異なる)。 */
  highlight?: boolean;
}

/** ビートkind → 1文字グリフ。 */
const BEAT_KIND_GLYPHS: Record<string, string> = {
  setup: "S",
  action: "A",
  reaction: "R",
  reveal: "!",
  decision: "D",
  transition: "→",
  pause: "…"
};

/** 台詞量バーの基準文字数(これで満幅)。 */
const DIALOGUE_BAR_FULL_CHARACTERS = 120;

/**
 * プラン候補比較用のページワイヤーフレーム。コマ枠に加えて、importance の塗り分け
 * (hero=強調塗り、splash=全面帯)、コマ内台詞量バー、ビートkindグリフ、ページの
 * turnHook マーク(rtl の次ページ側=左下)を重ねる。
 */
export function renderPageWireframeSvg(layout: PageLayout, options: PageWireframeOptions = {}): string {
  const width = VIEWBOX_SCALE;
  const height = VIEWBOX_SCALE * layout.page.height;
  const paper = options.paper ?? DEFAULT_PAPER;
  const stroke = options.stroke ?? DEFAULT_STROKE;
  const classAttr = options.className ? ` class="${escapeAttr(options.className)}${options.highlight ? " is-diff" : ""}"` : options.highlight ? ` class="is-diff"` : "";
  const a11y = options.ariaLabel ? ` role="img" aria-label="${escapeAttr(options.ariaLabel)}"` : ` aria-hidden="true"`;
  const ordered = orderPanelsByReadingDirection(layout.panels, layout.readingDirection);
  const overlays: string[] = [];
  ordered.forEach((panel, index) => {
    const info = options.panels?.[index];
    if (!info) return;
    const [x1, y1, x2, y2] = panelBounds(panel.shape);
    const panelWidth = Math.max(0, x2 - x1);
    const scale = info.visualScale;
    if (scale === "large") {
      overlays.push(shapeGeometryElement(panel.shape, `fill="var(--wire-hero, rgba(217,119,6,0.30))" stroke="var(--wire-hero-stroke, rgba(217,119,6,0.9))" stroke-width="0.008"`));
    } else if (scale === "splash") {
      overlays.push(shapeGeometryElement(panel.shape, `fill="var(--wire-splash, rgba(190,24,93,0.26))" stroke="var(--wire-splash-stroke, rgba(190,24,93,0.9))" stroke-width="0.009"`));
    } else if (scale === "small") {
      overlays.push(shapeGeometryElement(panel.shape, `fill="var(--wire-small, rgba(100,116,139,0.16))"`));
    }
    if (info.dialogueCharacters && info.dialogueCharacters > 0) {
      const ratio = Math.min(1, info.dialogueCharacters / DIALOGUE_BAR_FULL_CHARACTERS);
      const barWidth = Math.max(0.02, panelWidth * 0.86 * ratio);
      const barY = y2 - 0.036;
      overlays.push(
        `<rect x="${num(x1 + panelWidth * 0.07)}" y="${num(barY)}" width="${num(barWidth)}" height="0.016" rx="0.006" fill="var(--wire-dialogue, rgba(37,99,235,0.75))" />`
      );
    }
    const glyphs = (info.beatKinds ?? []).map((kind) => BEAT_KIND_GLYPHS[kind] ?? "·").join("");
    if (glyphs) {
      overlays.push(
        `<text x="${num(x1 + 0.018)}" y="${num(y1 + 0.02)}" font-size="0.052" dominant-baseline="hanging" fill="var(--wire-beat, rgba(15,23,42,0.72))">${escapeAttr(glyphs)}</text>`
      );
    }
  });
  if (options.turnHook === "reveal" || options.turnHook === "cliffhanger") {
    // rtl では次ページは左側。めくり位置マークをページ左下に置く。
    const label = options.turnHook === "reveal" ? "▼reveal" : "▼cliff";
    overlays.push(
      `<text x="0.03" y="${num(layout.page.height - 0.024)}" font-size="0.06" font-weight="bold" fill="var(--wire-turnhook, rgba(190,24,93,0.95))">${label}</text>`
    );
  }
  const panels = layout.panels.map((panel) => panelElement(panel, stroke, false)).join("");
  const border = options.highlight
    ? `<rect x="0.004" y="0.004" width="0.992" height="${num(layout.page.height - 0.008)}" fill="none" stroke="var(--wire-diff, rgba(220,38,38,0.9))" stroke-width="0.012" stroke-dasharray="0.05 0.03" />`
    : "";
  return `<svg${classAttr} viewBox="0 0 ${num(width)} ${num(height)}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"${a11y}>
    <g transform="scale(${VIEWBOX_SCALE})">
      <rect x="0" y="0" width="1" height="${num(layout.page.height)}" fill="${escapeAttr(paper)}" />
      ${panels}
      ${overlays.join("")}
      ${border}
    </g>
  </svg>`;
}
