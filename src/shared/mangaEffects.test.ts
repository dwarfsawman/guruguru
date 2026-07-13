import test from "node:test";
import assert from "node:assert/strict";
import { createMangaEffectObjects, inferMangaEffect, isMangaEffectObject } from "./mangaEffects.ts";
import type { PanelSpec } from "./mangaPlanV2.ts";
import type { LayoutPanel } from "./pageLayout.ts";

const panel = { id: "p1", shot: { size: "close-up", focalSubjectId: "c", angle: "eye-level", compositionIntent: "dramatic reveal" },
  settingId: "s", preStateId: "a", postStateId: "b", beatId: "beat", cast: [], props: [], textSafeZones: [], mustShow: [], mustNotShow: [],
  dialogueLineIds: [], promptBase: "", compiledPrompt: "", referenceManifest: [] } as unknown as PanelSpec;
const layoutPanel: LayoutPanel = { id: "lp", order: 0, shape: { type: "rect", bounds: [0.1, 0.1, 0.9, 0.6] } };

test("composition/shotから集中線を決定的生成する", () => {
  assert.equal(inferMangaEffect(panel), "focus-lines");
  const first = createMangaEffectObjects(panel, layoutPanel);
  assert.equal(first.length, 12);
  assert.deepEqual(first, createMangaEffectObjects(panel, layoutPanel));
});

test("自動付与済みの集中線・スピード線オブジェクトを識別する", () => {
  assert.equal(isMangaEffectObject({ kind: "box", id: "effect:p1:focus-lines:0" }), true);
  assert.equal(isMangaEffectObject({ kind: "box", id: "effect:p2:speed-lines:8" }), true);
  assert.equal(isMangaEffectObject({ kind: "box", id: "user-box:0" }), false);
  assert.equal(isMangaEffectObject({ kind: "image", id: "effect:p1:focus-lines:0" }), false);
});
