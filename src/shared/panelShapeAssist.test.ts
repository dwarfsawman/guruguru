import { describe, expect, test } from "bun:test";
import type { PageLayout } from "./pageLayout";
import { snapPolygonVertexParallel } from "./panelShapeAssist";

const layout: PageLayout = {
  version: 1,
  page: { aspectRatio: [1, 1.4], height: 1.4 },
  readingDirection: "rtl",
  panels: [
    { id: "a", order: 1, shape: { type: "polygon", points: [[0.05, 0.05], [0.45, 0.05], [0.45, 0.5], [0.05, 0.5]] } },
    { id: "b", order: 2, shape: { type: "polygon", points: [[0.55, 0.1], [0.95, 0.2], [0.95, 0.6], [0.55, 0.5]] } }
  ]
};

describe("parallel shape assist", () => {
  test("near-horizontal edge becomes exactly horizontal", () => {
    const result = snapPolygonVertexParallel(layout, "a", 1, [0.42, 0.06]);
    expect(result.point[1]).toBe(0.05);
    expect(result.guide?.label).toBe("水平");
  });

  test("edge can snap exactly parallel to another slanted panel edge", () => {
    const result = snapPolygonVertexParallel(layout, "a", 1, [0.44, 0.1475]);
    const activeDx = result.point[0] - 0.05;
    const activeDy = result.point[1] - 0.05;
    expect(activeDy / activeDx).toBeCloseTo(0.25, 8);
    expect(result.guide?.label).toBe("平行");
  });

  test("far angles are left untouched", () => {
    const candidate: [number, number] = [0.36, 0.2];
    expect(snapPolygonVertexParallel(layout, "a", 1, candidate)).toEqual({ point: candidate, guide: null });
  });
});
