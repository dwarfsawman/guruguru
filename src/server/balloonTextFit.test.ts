import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BOX_FILL, DEFAULT_BOX_STROKE_COLOR, DEFAULT_BOX_STROKE_WIDTH, DEFAULT_TEXT_STYLE, type BalloonObject } from "../shared/pageObjects.ts";
import { balloonContentMaxWidth, balloonInscribedFactor } from "../shared/balloonShape.ts";
import { computeTextLayoutForContent } from "./textLayoutApi.ts";
import { fitBalloonText } from "./balloonTextFit.ts";
import { initializeDb } from "./db.ts";

test("fitBalloonText shrinks overflowing vertical text into the balloon inscribed rectangle", () => {
  initializeDb();
  const balloon: BalloonObject = {
    id: "b", kind: "balloon", position: { x: 0.5, y: 0.5 }, rotation: 0, shape: "ellipse",
    size: { x: 0.18, y: 0.24 }, fill: DEFAULT_BOX_FILL, strokeColor: DEFAULT_BOX_STROKE_COLOR,
    strokeWidth: DEFAULT_BOX_STROKE_WIDTH, tail: null,
    content: { text: "これはとても長い台詞なので小さな吹き出しから確実にはみ出します。さらに続きます。", style: { ...DEFAULT_TEXT_STYLE, size: 0.03 } }
  };
  assert.equal(fitBalloonText(balloon), true);
  assert.ok(balloon.content!.style.size < 0.03);
  const layout = computeTextLayoutForContent(balloon.content!, balloonContentMaxWidth(balloon.shape, balloon.size, "vertical"));
  const factor = balloonInscribedFactor(balloon.shape);
  assert.ok(layout.bbox.maxX - layout.bbox.minX <= balloon.size.x * 0.88 * factor + 1e-6);
  assert.ok(layout.bbox.maxY - layout.bbox.minY <= balloon.size.y * 0.88 * factor + 1e-6);
});
