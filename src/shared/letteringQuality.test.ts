import test from "node:test";
import assert from "node:assert/strict";
import { auditLettering } from "./letteringQuality.ts";
import { createBalloonObject } from "./pageObjects.ts";
import type { PageLayout } from "./pageLayout.ts";

const layout: PageLayout = { version: 1, page: { aspectRatio: [5, 7], height: 1.4 }, readingDirection: "rtl", panels: [] };

test("lettering audit detects overflow, low contrast, and face overlap", () => {
  const balloon = createBalloonObject("b1", { x: 0.96, y: 0.2 });
  balloon.size = { x: 0.2, y: 0.15 };
  balloon.fill = "#ffffff";
  balloon.content!.style.color = "#eeeeee";
  const report = auditLettering(layout, [balloon], [{ x: 0.86, y: 0.12, width: 0.1, height: 0.12 }]);
  assert.equal(report.passed, false);
  assert.deepEqual(report.overflowObjectIds, ["b1"]);
  assert.deepEqual(report.lowContrastObjectIds, ["b1"]);
  assert.ok(report.balloonFaceOverlapRatio > 0);
});
