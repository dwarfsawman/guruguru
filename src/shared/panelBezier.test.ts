import { describe, expect, test } from "bun:test";
import {
  bezierPathData,
  fitClosedFreehandBezier,
  moveBezierAnchor,
  moveBezierHandle,
  normalizePanelBezierGeometry,
  polygonToBezier,
  removeBezierNode
} from "./panelBezier";

describe("panelBezier", () => {
  test("polygon conversion keeps straight corners and emits a closed cubic path", () => {
    const geometry = polygonToBezier([[0, 0], [1, 0], [1, 1], [0, 1]])!;
    expect(geometry.nodes).toHaveLength(4);
    expect(bezierPathData(geometry)).toBe("M 0 0 C 0.333333 0 0.666667 0 1 0 C 1 0.333333 1 0.666667 1 1 C 0.666667 1 0.333333 1 0 1 C 0 0.666667 0 0.333333 0 0 Z");
  });

  test("freehand loop becomes a compact editable smooth path", () => {
    const points: [number, number][] = [];
    for (let index = 0; index < 80; index += 1) {
      const angle = (Math.PI * 2 * index) / 80;
      points.push([0.5 + Math.cos(angle) * 0.3, 0.6 + Math.sin(angle) * 0.24]);
    }
    const geometry = fitClosedFreehandBezier(points)!;
    expect(geometry.nodes.length).toBeGreaterThanOrEqual(8);
    expect(geometry.nodes.length).toBeLessThanOrEqual(18);
    expect(bezierPathData(geometry)).toMatch(/^M .* C .* Z$/);
  });

  test("anchor and mirrored handle edits are immutable", () => {
    const original = polygonToBezier([[0, 0], [1, 0], [1, 1], [0, 1]])!;
    const anchored = moveBezierAnchor(original, 0, [0.1, 0.2]);
    expect(anchored.nodes[0]!.point).toEqual([0.1, 0.2]);
    expect(anchored.nodes[0]!.in[0]).toBeCloseTo(0.1);
    expect(anchored.nodes[0]!.in[1]).toBeCloseTo(0.5333333333);
    expect(anchored.nodes[0]!.out[0]).toBeCloseTo(0.4333333333);
    expect(anchored.nodes[0]!.out[1]).toBeCloseTo(0.2);
    expect(original.nodes[0]!.point).toEqual([0, 0]);
    const handled = moveBezierHandle(anchored, 0, "out", [0.3, 0.2]);
    expect(handled.nodes[0]!.in).toEqual([-0.09999999999999998, 0.2]);
    expect(removeBezierNode(handled, 0)!.nodes).toHaveLength(3);
  });

  test("normalizer rejects incomplete structures", () => {
    expect(normalizePanelBezierGeometry({ closed: true, nodes: [] })).toBeNull();
    expect(normalizePanelBezierGeometry({ closed: true, nodes: [{ point: [0, 0] }] })).toBeNull();
  });
});
