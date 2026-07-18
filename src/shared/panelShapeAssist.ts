import type { PageLayout } from "./pageLayout";

export interface ParallelSnapGuide {
  activeStart: [number, number];
  activeEnd: [number, number];
  referenceStart: [number, number];
  referenceEnd: [number, number];
  label: "水平" | "垂直" | "平行";
}

export interface ParallelSnapResult {
  point: [number, number];
  guide: ParallelSnapGuide | null;
}

const ANGLE_TOLERANCE = (4 * Math.PI) / 180;
const DISTANCE_TOLERANCE = 0.026;
const EPS = 1e-9;

interface DirectionTarget {
  direction: [number, number];
  start: [number, number];
  end: [number, number];
  label: ParallelSnapGuide["label"];
}

function normalizedDirection(a: readonly [number, number], b: readonly [number, number]): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  return length > EPS ? [dx / length, dy / length] : null;
}

/**
 * 単一頂点ドラッグ時、隣接辺を水平・垂直または他のコマ辺へ完全平行にスナップする。
 * 最小の角度補正を採用し、画面側が PowerPoint 風ガイドを描ける情報も返す。
 */
export function snapPolygonVertexParallel(
  layout: PageLayout,
  panelId: string,
  vertexIndex: number,
  candidate: [number, number]
): ParallelSnapResult {
  const panelIndex = layout.panels.findIndex((panel) => panel.id === panelId);
  const panel = layout.panels[panelIndex];
  if (!panel || panel.shape.type !== "polygon" || panel.shape.points.length < 3) return { point: candidate, guide: null };
  const points = panel.shape.points;
  const count = points.length;
  const previous = points[(vertexIndex - 1 + count) % count];
  const next = points[(vertexIndex + 1) % count];
  if (!previous || !next) return { point: candidate, guide: null };

  const targets: DirectionTarget[] = [
    { direction: [1, 0], start: [0, candidate[1]], end: [1, candidate[1]], label: "水平" },
    { direction: [0, 1], start: [candidate[0], 0], end: [candidate[0], layout.page.height], label: "垂直" }
  ];
  layout.panels.forEach((entry, otherPanelIndex) => {
    if (entry.shape.type !== "polygon") return;
    entry.shape.points.forEach((a, edgeIndex) => {
      const b = entry.shape.type === "polygon" ? entry.shape.points[(edgeIndex + 1) % entry.shape.points.length] : null;
      if (!b) return;
      // ドラッグ中頂点へ接続する2辺自身は参照にしない。
      if (otherPanelIndex === panelIndex && (edgeIndex === vertexIndex || (edgeIndex + 1) % count === vertexIndex)) return;
      const direction = normalizedDirection(a, b);
      if (direction) targets.push({ direction, start: [a[0], a[1]], end: [b[0], b[1]], label: "平行" });
    });
  });

  let best: { point: [number, number]; guide: ParallelSnapGuide; score: number } | null = null;
  for (const anchor of [previous, next] as const) {
    const currentDirection = normalizedDirection(anchor, candidate);
    if (!currentDirection) continue;
    for (const target of targets) {
      const dot = Math.abs(currentDirection[0] * target.direction[0] + currentDirection[1] * target.direction[1]);
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (angle > ANGLE_TOLERANCE) continue;
      const vx = candidate[0] - anchor[0];
      const vy = candidate[1] - anchor[1];
      const projection = vx * target.direction[0] + vy * target.direction[1];
      const snapped: [number, number] = [anchor[0] + target.direction[0] * projection, anchor[1] + target.direction[1] * projection];
      const correction = Math.hypot(snapped[0] - candidate[0], snapped[1] - candidate[1]);
      if (correction > DISTANCE_TOLERANCE) continue;
      // 軸スナップは同角度なら優先し、意図した水平・垂直を安定させる。
      const score = angle + correction * 0.5 + (target.label === "平行" ? 0.0005 : 0);
      if (!best || score < best.score) {
        const span = Math.max(1.2, layout.page.height);
        best = {
          point: snapped,
          score,
          guide: {
            activeStart: [anchor[0] - target.direction[0] * span, anchor[1] - target.direction[1] * span],
            activeEnd: [anchor[0] + target.direction[0] * span, anchor[1] + target.direction[1] * span],
            referenceStart: target.start,
            referenceEnd: target.end,
            label: target.label
          }
        };
      }
    }
  }
  return best ? { point: best.point, guide: best.guide } : { point: candidate, guide: null };
}

