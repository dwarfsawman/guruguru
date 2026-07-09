/**
 * コマ形状編集(Docs/Feature-CGCollectionSuite.md P5)。頂点ドラッグ・辺への頂点追加・頂点削除・
 * 直線分割の純ロジック。`PanelShape`(pageLayout.ts)を編集可能な polygon 点列へ変換し、
 * 点列操作/分割の結果を返す -- DOM・state 非依存(クライアント/サーバ双方の検証で使えるように)。
 *
 * 自己交差する編集の防止は行わない(ユーザー責任)。NaN/範囲外の入力は clamp してフォールバックする。
 */
import type { PanelShape } from "./pageLayout";

const EPS = 1e-7;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clonePoints(points: readonly [number, number][]): [number, number][] {
  return points.map(([x, y]) => [x, y] as [number, number]);
}

/** ellipse を近似する頂点数。 */
const ELLIPSE_POLYGON_SIDES = 16;

/**
 * パネル形状を編集可能な polygon 点列へ変換する。rect は4頂点(角丸は破棄)、ellipse は
 * `ELLIPSE_POLYGON_SIDES` 頂点の正多角形近似、polygon はそのままコピーを返す。
 * path は厳密な頂点列を持たない(d 文字列)ため編集不可 = null。
 */
export function panelShapeToPolygon(shape: PanelShape): [number, number][] | null {
  if (shape.type === "polygon") {
    return clonePoints(shape.points);
  }
  if (shape.type === "rect") {
    const [x1, y1, x2, y2] = shape.bounds;
    const minX = Math.min(x1, x2);
    const minY = Math.min(y1, y2);
    const maxX = Math.max(x1, x2);
    const maxY = Math.max(y1, y2);
    return [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY]
    ];
  }
  if (shape.type === "ellipse") {
    const [cx, cy] = shape.center;
    const [rx, ry] = shape.radius;
    const points: [number, number][] = [];
    for (let i = 0; i < ELLIPSE_POLYGON_SIDES; i += 1) {
      const angle = (2 * Math.PI * i) / ELLIPSE_POLYGON_SIDES;
      points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
    }
    return points;
  }
  return null;
}

/**
 * 頂点1個を移動する。x は [0, bounds.maxX ?? 1]、y は [0, bounds.maxY ?? +∞] へ clamp する。
 * newPos が非数(NaN)ならその軸は元の値を維持する。index が範囲外なら無変更のコピーを返す。
 */
export function movePolygonVertex(
  points: readonly [number, number][],
  index: number,
  newPos: readonly [number, number],
  bounds: { maxX?: number; maxY?: number } = {}
): [number, number][] {
  const next = clonePoints(points);
  if (index < 0 || index >= next.length) {
    return next;
  }
  const maxX = isFiniteNumber(bounds.maxX) ? bounds.maxX : 1;
  const maxY = isFiniteNumber(bounds.maxY) ? bounds.maxY : Number.POSITIVE_INFINITY;
  const current = next[index]!;
  const x = isFiniteNumber(newPos[0]) ? Math.min(maxX, Math.max(0, newPos[0])) : current[0];
  const y = isFiniteNumber(newPos[1]) ? Math.min(maxY, Math.max(0, newPos[1])) : current[1];
  next[index] = [x, y];
  return next;
}

/** 辺(edgeIndex と edgeIndex+1 の間)の中点に新しい頂点を挿入する。 */
export function insertPolygonVertex(points: readonly [number, number][], edgeIndex: number): [number, number][] {
  const n = points.length;
  if (n === 0) {
    return [];
  }
  const i = ((edgeIndex % n) + n) % n;
  const j = (i + 1) % n;
  const a = points[i]!;
  const b = points[j]!;
  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const next = clonePoints(points);
  next.splice(i + 1, 0, mid);
  return next;
}

/**
 * 頂点1個を削除する。削除後に3頂点未満になる場合は拒否(null)。index が範囲外でも null。
 */
export function removePolygonVertex(points: readonly [number, number][], index: number): [number, number][] | null {
  if (index < 0 || index >= points.length) {
    return null;
  }
  if (points.length - 1 < 3) {
    return null;
  }
  return points.filter((_, i) => i !== index);
}

/** shoelace 公式による多角形面積(符号なし)。 */
export function polygonArea(points: readonly [number, number][]): number {
  const n = points.length;
  if (n < 3) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % n]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

interface ExtPoint {
  point: [number, number];
  isHit: boolean;
}

interface Hit {
  /** この頂点自体が線上にある場合はその頂点 index、辺上の交点なら null。 */
  atVertex: number | null;
  /** この hit が属する辺(頂点 index と 次の頂点の間)。頂点 hit の場合も自身の index を入れる。 */
  afterVertex: number;
  point: [number, number];
}

/** 直線(lineP1→lineP2 を通る無限直線)を基準にした符号付き距離(cross product)。 */
function lineSide(p: readonly [number, number], lineP1: readonly [number, number], dir: readonly [number, number]): number {
  return (p[0] - lineP1[0]) * dir[1] - (p[1] - lineP1[1]) * dir[0];
}

/**
 * polygon を直線で2分割し、切断辺をガター幅の半分ずつ両側へオフセットする。
 * 交点がちょうど2つ取れない(直線が退化/接するだけ/分割後の頂点数が3未満になる等)場合は null。
 * 数値誤差(頂点がちょうど線上に乗る等)は line 長基準の epsilon で丸めて頑健にする。
 */
export function splitPanelByLine(
  points: readonly [number, number][],
  lineP1: readonly [number, number],
  lineP2: readonly [number, number],
  gutter: number
): { a: [number, number][]; b: [number, number][] } | null {
  const n = points.length;
  if (n < 3) {
    return null;
  }
  const dir: [number, number] = [lineP2[0] - lineP1[0], lineP2[1] - lineP1[1]];
  const lineLen = Math.hypot(dir[0], dir[1]);
  if (!(lineLen > EPS)) {
    return null;
  }
  const eps = EPS * Math.max(1, lineLen);

  const rawSides = points.map((p) => lineSide(p, lineP1, dir));
  const signs = rawSides.map((s) => (Math.abs(s) <= eps ? 0 : s > 0 ? 1 : -1));

  // すべて同じ側(または全部線上)なら分割にならない。
  if (signs.every((s) => s >= 0) || signs.every((s) => s <= 0)) {
    return null;
  }

  const hits: Hit[] = [];
  for (let i = 0; i < n; i += 1) {
    if (signs[i] === 0) {
      hits.push({ atVertex: i, afterVertex: i, point: points[i]! });
    }
  }
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    if (signs[i] === 0 || signs[j] === 0) {
      continue;
    }
    if (signs[i] !== signs[j]) {
      const t = rawSides[i]! / (rawSides[i]! - rawSides[j]!);
      const a = points[i]!;
      const b = points[j]!;
      hits.push({ atVertex: null, afterVertex: i, point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] });
    }
  }

  if (hits.length !== 2) {
    return null;
  }
  const [hitA, hitB] = hits as [Hit, Hit];
  if (Math.hypot(hitA.point[0] - hitB.point[0], hitA.point[1] - hitB.point[1]) <= eps) {
    return null;
  }

  // hits を "afterVertex" 順(頂点hit優先)に並べ、頂点 hit / 辺 hit を統一した拡張点列を作る。
  const hitsByAfterVertex = new Map<number, Hit[]>();
  for (const hit of hits) {
    const list = hitsByAfterVertex.get(hit.afterVertex) ?? [];
    list.push(hit);
    hitsByAfterVertex.set(hit.afterVertex, list);
  }

  const ext: ExtPoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const atThisVertex = (hitsByAfterVertex.get(i) ?? []).some((hit) => hit.atVertex === i);
    ext.push({ point: points[i]!, isHit: atThisVertex });
    const edgeHits = (hitsByAfterVertex.get(i) ?? []).filter((hit) => hit.atVertex === null);
    for (const hit of edgeHits) {
      ext.push({ point: hit.point, isHit: true });
    }
  }

  const hitIndices: number[] = [];
  ext.forEach((entry, index) => {
    if (entry.isHit) {
      hitIndices.push(index);
    }
  });
  if (hitIndices.length !== 2) {
    return null;
  }
  const [ia, ib] = hitIndices as [number, number];

  const chainAExt = ext.slice(ia, ib + 1);
  const chainBExt = [...ext.slice(ib), ...ext.slice(0, ia + 1)];
  if (chainAExt.length < 3 || chainBExt.length < 3) {
    return null;
  }

  // 直線の法線(side を増やす方向)。ガターはこの向きへ双方の切断頂点をオフセットする。
  const nrm: [number, number] = [dir[1] / lineLen, -dir[0] / lineLen];
  const halfGutter = Math.max(0, isFiniteNumber(gutter) ? gutter : 0) / 2;

  function averageSign(chain: ExtPoint[]): number {
    const interior = chain.filter((entry) => !entry.isHit);
    if (interior.length === 0) {
      return 0;
    }
    const avg = interior.reduce((sum, entry) => sum + lineSide(entry.point, lineP1, dir), 0) / interior.length;
    return avg >= 0 ? 1 : -1;
  }

  function applyGutter(chain: ExtPoint[], sign: number): [number, number][] {
    return chain.map((entry) => {
      if (!entry.isHit || halfGutter <= 0) {
        return entry.point;
      }
      return [entry.point[0] + nrm[0] * sign * halfGutter, entry.point[1] + nrm[1] * sign * halfGutter] as [number, number];
    });
  }

  const signA = averageSign(chainAExt);
  const signB = averageSign(chainBExt);
  if (signA === 0 || signB === 0) {
    // 内部点が全て線上(縮退した薄い chain)は安全側で分割を拒否する。
    return null;
  }

  return { a: applyGutter(chainAExt, signA), b: applyGutter(chainBExt, signB) };
}
