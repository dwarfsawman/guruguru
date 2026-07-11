import assert from "node:assert/strict";
import test from "node:test";
import { assetPointToPage } from "./speakerAnchors.ts";

test("assetPointToPage maps a cropped asset mouth into panel page coordinates", () => {
  const point = assetPointToPage({ x: 0.5, y: 0.5 }, [0.1, 0.2, 0.5, 0.8], { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  assert.ok(Math.abs(point.x - 0.3) < 1e-9);
  assert.ok(Math.abs(point.y - 0.5) < 1e-9);
});
