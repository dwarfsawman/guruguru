/**
 * イテレーションツリーのエッジ（親→子リンク）を SVG オーバーレイとして描画する。
 *
 * ノードのレイアウトは従来どおり flexbox が担当し、ここでは実際に配置された
 * ドットの座標を測定して、親ドット→子ドットを1本の滑らかな三次ベジェで結ぶ。
 * 色は親色→子色の linear-gradient（`gradientUnits="userSpaceOnUse"` でエッジの
 * 向きに沿う）で変化させる。分岐時の縦バス＋直角の折れ線を、モックのような
 * 流線形の曲線に置き換えるのが狙い。
 *
 * CSS の擬似要素コネクタは JS 無効時のフォールバックとして残し、描画に成功したら
 * `.iteration-forest.edges-ready` で隠す（プログレッシブエンハンスメント）。
 */

export interface EdgePoint {
  x: number;
  y: number;
}

/**
 * 親ドット右端 `from` から子ドット左端 `to` を結ぶ三次ベジェの `d` 属性を返す。
 * 制御点は水平方向のハンドルにして、両端の接線を水平に保つ（＝滑らかな S 字）。
 * 純関数なのでレイアウトに依存せず単体テストできる。
 */
export function iterationEdgePath(from: EdgePoint, to: EdgePoint): string {
  const dx = to.x - from.x;
  // ハンドル長: 水平距離の半分。近すぎるときも最低限のカーブを残す。
  const handle = Math.max(14, Math.abs(dx) * 0.5);
  const c1x = round1(from.x + handle);
  const c2x = round1(to.x - handle);
  return (
    `M ${round1(from.x)} ${round1(from.y)} ` +
    `C ${c1x} ${round1(from.y)}, ${c2x} ${round1(to.y)}, ${round1(to.x)} ${round1(to.y)}`
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * `.iteration-forest` 配下の全エッジを測定し、内包する `svg.iteration-edges` に
 * ベジェパスとグラデーションを再構築する。レイアウト後（rAF / ResizeObserver）に呼ぶ。
 */
export function drawIterationEdges(forest: HTMLElement): void {
  const svg = forest.querySelector<SVGSVGElement>("svg.iteration-edges");
  if (!svg) {
    return;
  }

  const dots = Array.from(forest.querySelectorAll<HTMLElement>(".iteration-dot[data-round-id]"));
  const byId = new Map<string, HTMLElement>();
  for (const dot of dots) {
    const id = dot.dataset.roundId;
    if (id) {
      byId.set(id, dot);
    }
  }

  // svg 自身のスクロール込みの現在位置を基準に、コンテンツ座標系へ変換する。
  const width = forest.scrollWidth;
  const height = forest.scrollHeight;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const origin = svg.getBoundingClientRect();

  const defs = document.createElementNS(SVG_NS, "defs");
  const paths: SVGPathElement[] = [];

  let index = 0;
  for (const dot of dots) {
    const parentId = dot.dataset.parentId;
    if (!parentId) {
      continue;
    }
    const parent = byId.get(parentId);
    if (!parent) {
      continue;
    }

    const pr = parent.getBoundingClientRect();
    const cr = dot.getBoundingClientRect();
    // 親ドット右端 → 子ドット左端（各ドットの縦中心）。
    const from: EdgePoint = { x: pr.right - origin.left - 1, y: pr.top + pr.height / 2 - origin.top };
    const to: EdgePoint = { x: cr.left - origin.left + 1, y: cr.top + cr.height / 2 - origin.top };

    const gradientId = `iteration-edge-grad-${index++}`;
    const gradient = document.createElementNS(SVG_NS, "linearGradient");
    gradient.setAttribute("id", gradientId);
    gradient.setAttribute("gradientUnits", "userSpaceOnUse");
    gradient.setAttribute("x1", String(round1(from.x)));
    gradient.setAttribute("y1", String(round1(from.y)));
    gradient.setAttribute("x2", String(round1(to.x)));
    gradient.setAttribute("y2", String(round1(to.y)));
    gradient.appendChild(makeStop("0", parent.dataset.hue));
    gradient.appendChild(makeStop("1", dot.dataset.hue));
    defs.appendChild(gradient);

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", iterationEdgePath(from, to));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", `url(#${gradientId})`);
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    paths.push(path);
  }

  svg.replaceChildren(defs, ...paths);
  forest.classList.add("edges-ready");
}

function makeStop(offset: string, hue: string | undefined): SVGStopElement {
  const stop = document.createElementNS(SVG_NS, "stop");
  stop.setAttribute("offset", offset);
  stop.setAttribute("stop-color", `hsl(${hue ?? "0"} 33% 55%)`);
  stop.setAttribute("stop-opacity", "0.85");
  return stop;
}
