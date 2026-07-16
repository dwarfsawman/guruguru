import assert from "node:assert/strict";
import test from "node:test";
import {
  importanceFromVisualScale,
  normalizeLegacyVisualScale,
  visualScaleFromImportance
} from "./mangaPlanV2.ts";
import { parseFountain } from "./fountain.ts";
import {
  type AnnotatedBeat,
  buildPreLayoutUnits,
  derivePanelVisualScale,
  validateBeatAnnotation
} from "./preLayoutBeat.ts";
import { normalizeScriptMangaPlanScales, planScriptManga } from "./scriptMangaPlan.ts";

test("normalizeLegacyVisualScale: visualScale優先、importance/desiredScaleは写像、不正はundefined", () => {
  assert.equal(normalizeLegacyVisualScale({ visualScale: "small", importance: "splash" }), "small");
  assert.equal(normalizeLegacyVisualScale({ importance: "hero" }), "large");
  assert.equal(normalizeLegacyVisualScale({ importance: "normal" }), "medium");
  assert.equal(normalizeLegacyVisualScale({ importance: "splash" }), "splash");
  assert.equal(normalizeLegacyVisualScale({ desiredScale: "small" }), "small");
  assert.equal(normalizeLegacyVisualScale({ desiredScale: "normal" }), "medium");
  assert.equal(normalizeLegacyVisualScale({ desiredScale: "hero" }), "large");
  assert.equal(normalizeLegacyVisualScale({ desiredScale: "splash" }), "splash");
  assert.equal(normalizeLegacyVisualScale({ importance: "huge", desiredScale: 3 }), undefined);
  assert.equal(normalizeLegacyVisualScale({}), undefined);
});

test("visualScale⇄importance 写像: splash/large(hero)は保存され、small/mediumはnormalへ畳まれる", () => {
  assert.equal(visualScaleFromImportance("splash"), "splash");
  assert.equal(visualScaleFromImportance("hero"), "large");
  assert.equal(visualScaleFromImportance("normal"), "medium");
  assert.equal(importanceFromVisualScale("splash"), "splash");
  assert.equal(importanceFromVisualScale("large"), "hero");
  assert.equal(importanceFromVisualScale("medium"), "normal");
  assert.equal(importanceFromVisualScale("small"), "normal");
});

function beat(id: string, preferredScale: AnnotatedBeat["preferredScale"], overrides: Partial<AnnotatedBeat> = {}): AnnotatedBeat {
  return {
    id,
    unitIds: [id],
    kind: "action",
    preferredScale,
    importance: 0.5,
    pageTurnAffinity: 0,
    keepAlone: false,
    desiredScale: "normal",
    ...overrides
  };
}

test("derivePanelVisualScale: 含有ビートのpreferredScale最大値。空ビートはmedium", () => {
  const ctx = { panelIndex: 0, panelCount: 3 };
  assert.equal(derivePanelVisualScale([beat("a", "small"), beat("b", "small")], ctx), "small");
  assert.equal(derivePanelVisualScale([beat("a", "small"), beat("b", "medium")], ctx), "medium");
  assert.equal(derivePanelVisualScale([beat("a", "medium"), beat("b", "large")], ctx), "large");
  assert.equal(derivePanelVisualScale([beat("a", "splash")], ctx), "splash");
  assert.equal(derivePanelVisualScale([], ctx), "medium");
});

const SCRIPT = ["INT. LAB - NIGHT", "", "箱を開ける。中には写真がある。", "", "@ALICE", "これは……私?"].join("\n");

test("validateBeatAnnotation v2: preferredScale一本の入力を受理し、旧語彙フィールドを決定的に導出する", () => {
  const doc = parseFountain(SCRIPT).doc;
  const units = buildPreLayoutUnits(doc);
  const raw = {
    beats: units.map((unit, index) => ({
      id: `b${index + 1}`,
      unitIds: [unit.id],
      kind: index === units.length - 1 ? "reveal" : "action",
      preferredScale: index === units.length - 1 ? "large" : "medium",
      pageTurnAffinity: 0.4,
      keepAlone: false
    }))
  };
  const beats = validateBeatAnnotation(raw, units);
  assert.ok(beats);
  const last = beats![beats!.length - 1]!;
  assert.equal(last.preferredScale, "large");
  assert.equal(last.desiredScale, "hero");
  assert.equal(last.importance, 0.85);
  assert.equal(beats![0]!.desiredScale, "normal");
  assert.equal(beats![0]!.importance, 0.5);
});

test("validateBeatAnnotation v2: 旧語彙(desiredScaleのみ)の入力も受理し、どちらも無ければreject", () => {
  const doc = parseFountain(SCRIPT).doc;
  const units = buildPreLayoutUnits(doc);
  const legacy = {
    beats: units.map((unit, index) => ({
      id: `b${index + 1}`,
      unitIds: [unit.id],
      kind: "action",
      importance: 0.7,
      pageTurnAffinity: 0,
      keepAlone: false,
      desiredScale: "hero"
    }))
  };
  const beats = validateBeatAnnotation(legacy, units);
  assert.ok(beats);
  assert.equal(beats![0]!.preferredScale, "large");
  assert.equal(beats![0]!.importance, 0.7, "与えられたimportance数値は保持される");

  const neither = {
    beats: units.map((unit, index) => ({
      id: `b${index + 1}`,
      unitIds: [unit.id],
      kind: "action",
      pageTurnAffinity: 0,
      keepAlone: false
    }))
  };
  assert.equal(validateBeatAnnotation(neither, units), null);
});

test("normalizeScriptMangaPlanScales: 旧importanceしか無いコマへvisualScaleを補完する", () => {
  const doc = parseFountain(SCRIPT).doc;
  const plan = planScriptManga(doc);
  const firstPanel = plan.pages[0]!.panels[0]!;
  assert.equal(firstPanel.visualScale, undefined, "決定的プランナーはスケール未設定");
  firstPanel.importance = "hero";
  const normalized = normalizeScriptMangaPlanScales(plan);
  assert.equal(normalized.pages[0]!.panels[0]!.visualScale, "large");
});
