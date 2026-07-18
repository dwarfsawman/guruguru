import assert from "node:assert/strict";
import test from "node:test";
import { panelImageRect } from "../shared/pageLayout.ts";
import { assetPointToPage, speakerTailTarget } from "./speakerAnchors.ts";

test("assetPointToPage maps a cropped asset mouth into panel page coordinates", () => {
  // 縦横比一致(窓アスペクト=コマアスペクト)のケースは従来の cover 写像と同値。
  // コマ 0.4x0.6、窓 0.5x0.5 → asset は 0.8:1.2 相当のアスペクトで等倍一致。
  const rect = panelImageRect([0.1, 0.2, 0.5, 0.8], { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 800, 1200);
  const point = assetPointToPage({ x: 0.5, y: 0.5 }, rect);
  assert.ok(Math.abs(point.x - 0.3) < 1e-9);
  assert.ok(Math.abs(point.y - 0.5) < 1e-9);
});

test("speakerTailTarget stops before the mouth by a face-proportional gap", () => {
  const target = speakerTailTarget({ x: 0.5, y: 0.5 }, { x: 0.2, y: 0.5 }, 0.1);
  assert.ok(Math.abs(target.x - 0.472) < 1e-9);
  assert.equal(target.y, 0.5);
});
