/**
 * 編集可能な閉じた cubic Bezier コマ枠の純ロジック。
 * 座標は PageLayout と同じ width-relative-top-left。
 */

export interface PanelBezierNode {
  point: [number, number];
  /** このアンカーへ入る制御点(絶対座標)。 */
  in: [number, number];
  /** このアンカーから出る制御点(絶対座標)。 */
  out: [number, number];
}

export interface PanelBezierGeometry {
  closed: true;
  nodes: PanelBezierNode[];
}

const EPS = 1e-9;

function num(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function pointText(point: readonly [number, number]): string {
  return `${num(point[0])} ${num(point[1])}`;
}

/** 構造化ノードを SVG path data へ変換する。 */
export function bezierPathData(geometry: PanelBezierGeometry): string {
  const nodes = geometry.nodes;
  if (nodes.length < 2) return "";
  const parts = [`M ${pointText(nodes[0]!.point)}`];
  for (let index = 0; index < nodes.length; index += 1) {
    const current = nodes[index]!;
    const next = nodes[(index + 1) % nodes.length]!;
    parts.push(`C ${pointText(current.out)} ${pointText(next.in)} ${pointText(next.point)}`);
  }
  parts.push("Z");
  return parts.join(" ");
}

function asPoint(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = value[0];
  const y = value[1];
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? [x, y]
    : null;
}

/** JSON 由来の編集ノードを厳密に正規化する。 */
export function normalizePanelBezierGeometry(value: unknown): PanelBezierGeometry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { closed?: unknown; nodes?: unknown };
  if (raw.closed !== true || !Array.isArray(raw.nodes) || raw.nodes.length < 3 || raw.nodes.length > 128) return null;
  const nodes: PanelBezierNode[] = [];
  for (const entry of raw.nodes) {
    if (!entry || typeof entry !== "object") return null;
    const node = entry as { point?: unknown; in?: unknown; out?: unknown };
    const point = asPoint(node.point);
    const incoming = asPoint(node.in);
    const outgoing = asPoint(node.out);
    if (!point || !incoming || !outgoing) return null;
    nodes.push({ point, in: incoming, out: outgoing });
  }
  return { closed: true, nodes };
}

function distance(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function signedArea(points: readonly [number, number][]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function closedResample(points: readonly [number, number][], count: number): [number, number][] {
  const segments: Array<{ a: [number, number]; b: [number, number]; start: number; length: number }> = [];
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const length = distance(a, b);
    if (length <= EPS) continue;
    segments.push({ a, b, start: total, length });
    total += length;
  }
  if (segments.length < 3 || total <= EPS) return [];
  const result: [number, number][] = [];
  let segmentIndex = 0;
  for (let index = 0; index < count; index += 1) {
    const target = (total * index) / count;
    while (segmentIndex + 1 < segments.length && target > segments[segmentIndex]!.start + segments[segmentIndex]!.length) {
      segmentIndex += 1;
    }
    const segment = segments[segmentIndex]!;
    const ratio = Math.max(0, Math.min(1, (target - segment.start) / segment.length));
    result.push([
      segment.a[0] + (segment.b[0] - segment.a[0]) * ratio,
      segment.a[1] + (segment.b[1] - segment.a[1]) * ratio
    ]);
  }
  return result;
}

/**
 * マウス軌跡を等弧長で間引き、Catmull-Rom 接線から滑らかな閉じた cubic Bezier を作る。
 * 面積がほぼ無い線や短すぎるストロークは null。
 */
export function fitClosedFreehandBezier(points: readonly [number, number][]): PanelBezierGeometry | null {
  const filtered: [number, number][] = [];
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    if (!filtered.length || distance(filtered[filtered.length - 1]!, point) >= 0.003) {
      filtered.push([point[0], point[1]]);
    }
  }
  if (filtered.length < 4) return null;
  // pointerup が始点付近なら重複終点を除き、閉曲線の継ぎ目が偏らないようにする。
  if (filtered.length > 4 && distance(filtered[0]!, filtered[filtered.length - 1]!) < 0.025) filtered.pop();
  let perimeter = 0;
  for (let index = 0; index < filtered.length; index += 1) {
    perimeter += distance(filtered[index]!, filtered[(index + 1) % filtered.length]!);
  }
  if (perimeter < 0.12 || Math.abs(signedArea(filtered)) < 0.002) return null;
  // 手描きの揺れをそのまま大量ノードへせず、後から扱いやすい 4〜18 点へ整える。
  const anchorCount = Math.max(4, Math.min(18, Math.round(perimeter / 0.11)));
  const anchors = closedResample(filtered, anchorCount);
  if (anchors.length < 4) return null;
  const tension = 0.82 / 6;
  const nodes = anchors.map((point, index): PanelBezierNode => {
    const previous = anchors[(index - 1 + anchors.length) % anchors.length]!;
    const next = anchors[(index + 1) % anchors.length]!;
    const tangent: [number, number] = [(next[0] - previous[0]) * tension, (next[1] - previous[1]) * tension];
    return {
      point: [point[0], point[1]],
      in: [point[0] - tangent[0], point[1] - tangent[1]],
      out: [point[0] + tangent[0], point[1] + tangent[1]]
    };
  });
  return { closed: true, nodes };
}

/** 多角形を見た目を変えず、後から曲げられる Bezier ノードへ変換する。 */
export function polygonToBezier(points: readonly [number, number][]): PanelBezierGeometry | null {
  if (points.length < 3) return null;
  return {
    closed: true,
    nodes: points.map(([x, y], index) => {
      const previous = points[(index - 1 + points.length) % points.length]!;
      const next = points[(index + 1) % points.length]!;
      return {
        point: [x, y],
        in: [x + (previous[0] - x) / 3, y + (previous[1] - y) / 3],
        out: [x + (next[0] - x) / 3, y + (next[1] - y) / 3]
      };
    })
  };
}

/** アンカー移動時は両ハンドルも同量動かす。 */
export function moveBezierAnchor(geometry: PanelBezierGeometry, index: number, point: [number, number]): PanelBezierGeometry {
  const nodes = geometry.nodes.map((node) => ({ point: [...node.point], in: [...node.in], out: [...node.out] })) as PanelBezierNode[];
  const node = nodes[index];
  if (!node) return { closed: true, nodes };
  const dx = point[0] - node.point[0];
  const dy = point[1] - node.point[1];
  node.point = [point[0], point[1]];
  node.in = [node.in[0] + dx, node.in[1] + dy];
  node.out = [node.out[0] + dx, node.out[1] + dy];
  return { closed: true, nodes };
}

/**
 * 制御点を移動する。既定は反対側を点対称に保つ滑らかハンドル、mirror=false で片側だけを動かす。
 */
export function moveBezierHandle(
  geometry: PanelBezierGeometry,
  index: number,
  side: "in" | "out",
  point: [number, number],
  mirror = true
): PanelBezierGeometry {
  const nodes = geometry.nodes.map((node) => ({ point: [...node.point], in: [...node.in], out: [...node.out] })) as PanelBezierNode[];
  const node = nodes[index];
  if (!node) return { closed: true, nodes };
  node[side] = [point[0], point[1]];
  if (mirror) {
    const other = side === "in" ? "out" : "in";
    node[other] = [node.point[0] * 2 - point[0], node.point[1] * 2 - point[1]];
  }
  return { closed: true, nodes };
}

export function removeBezierNode(geometry: PanelBezierGeometry, index: number): PanelBezierGeometry | null {
  if (geometry.nodes.length <= 3 || index < 0 || index >= geometry.nodes.length) return null;
  return { closed: true, nodes: geometry.nodes.filter((_, nodeIndex) => nodeIndex !== index) };
}
