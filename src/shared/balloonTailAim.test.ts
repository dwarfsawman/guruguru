import assert from "node:assert/strict";
import test from "node:test";
import { constrainBalloonTailTipToBounds, initialBalloonTailTip } from "./balloonTailAim.ts";

test("initial balloon tails point inward instead of straight down", () => {
  assert.ok(initialBalloonTailTip({ x: 0.8, y: 0.2 }, { x: 0.2, y: 0.3 }, 0).x < 0);
  assert.ok(initialBalloonTailTip({ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.3 }, 0).x > 0);
  assert.notEqual(initialBalloonTailTip({ x: 0.5, y: 0.2 }, { x: 0.2, y: 0.3 }, 0).x, 0);
});

test("balloon tail tip stays inside its assigned panel", () => {
  const constrained = constrainBalloonTailTipToBounds({ x: 0.7, y: 0.2 }, { x: -0.3, y: 0.1 }, [0.5, 0.05, 0.95, 0.4]);
  assert.ok(0.7 + constrained.x >= 0.525);
  assert.ok(0.7 + constrained.x <= 0.925);
  assert.ok(0.2 + constrained.y >= 0.075);
  assert.ok(0.2 + constrained.y <= 0.375);
});
