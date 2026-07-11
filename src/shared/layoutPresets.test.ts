import assert from "node:assert/strict";
import test from "node:test";
import { findLayoutPreset } from "./layoutPresets.ts";

test("dramatic manga presets keep the advertised panel count and RTL order", () => {
  const cases = [
    ["builtin:three-hero-top", 3],
    ["builtin:three-side-hero", 3],
    ["builtin:three-hero-bottom", 3],
    ["builtin:four-hero-bottom", 4],
    ["builtin:four-vertical-hero", 4]
  ] as const;
  for (const [id, count] of cases) {
    const preset = findLayoutPreset(id);
    assert.ok(preset, id);
    assert.equal(preset.layout.readingDirection, "rtl");
    assert.equal(preset.layout.panels.length, count);
    assert.deepEqual(preset.layout.panels.map((panel) => panel.order), Array.from({ length: count }, (_, i) => i + 1));
  }
});
