import assert from "node:assert/strict";
import test from "node:test";
import { initialBalloonTailTip } from "./balloonTailAim.ts";

test("initial balloon tails point inward instead of straight down", () => {
  assert.ok(initialBalloonTailTip({ x: 0.8, y: 0.2 }, { x: 0.2, y: 0.3 }, 0).x < 0);
  assert.ok(initialBalloonTailTip({ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.3 }, 0).x > 0);
  assert.notEqual(initialBalloonTailTip({ x: 0.5, y: 0.2 }, { x: 0.2, y: 0.3 }, 0).x, 0);
});
