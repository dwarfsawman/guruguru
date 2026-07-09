/**
 * コマ割りレイアウト(`PageLayout`)を文字列 SVG で描画する純関数。ページカードのコマ枠サムネ、
 * テンプレートピッカーのプレビュー、取り込み確認に使う。house style(assetModal の
 * `renderWebSamPromptOverlay` 等)に倣い createElementNS ではなく文字列 SVG を返す。
 *
 * 座標は width-relative(x∈[0,1], y∈[0,page.height])。viewBox を `0 0 1000 {1000*height}` に取り、
 * 全体を `scale(1000)` した group 内に正規化座標のまま描くことで path の `d` もスケール不要にする。
 * 線幅も group 内で正規化値(例 0.006)を渡せば scale(1000) で 6 viewBox 単位となり、コマ枠は
 * 紙面幅に比例した太さで描かれる(2枚目画像のような印刷相当の見え方)。
 */
import type { LayoutPanel, PageLayout, PanelShape } from "../../shared/pageLayout";
import { DEFAULT_PANEL_FRAME } from "../../shared/pageLayout";
import { escapeAttr } from "../format";

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

/** 形状の中心(コマ番号の配置、コマ内生成の空コマヒント表示に使う)。path は中心不明なので null。 */
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
  if (frame.visible === false) {
    return "";
  }
  const stroke = defaultStroke;
  const parts = [shapeElement(panel.shape, stroke, frame.strokeWidth)];
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
