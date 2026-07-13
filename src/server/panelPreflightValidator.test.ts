import assert from "node:assert/strict";
import test from "node:test";
import { findLayoutPreset } from "../shared/layoutPresets.ts";
import type { PanelSpec } from "../shared/mangaPlanV2.ts";
import { validatePanelPreflight } from "./panelPreflightValidator.ts";

function panel(): PanelSpec {
  return {
    id: "panel-1",
    sourceElementIds: ["source-1"],
    beatIds: ["beat-1"],
    preStateId: "state-1",
    postStateDelta: { notes: [] },
    settingId: "setting-1",
    cast: [{
      characterId: "character-1",
      variantId: "character-1:default",
      bbox: { x: 0.1, y: 0.2, width: 0.5, height: 0.7 },
      expression: "calm",
      action: "looks around",
      speakingLineIds: ["line-1"]
    }],
    props: [],
    shot: {
      size: "medium",
      angle: "eye-level",
      focalSubjectId: "character-1",
      compositionIntent: "clear silhouette"
    },
    dialogueLineIds: ["line-1"],
    dialogueOrderIndexes: [0],
    textSafeZones: [{ x: 0.65, y: 0.04, width: 0.3, height: 0.25 }],
    mustShow: [],
    mustNotShow: [],
    continuityFromPanelIds: [],
    referenceManifest: [],
    sceneIndex: 0,
    sceneHeading: "INT. ROOM - DAY",
    sourceText: "Alice: ここはどこ？",
    promptBase: "Alice looks around",
    compiledPrompt: "Alice looks around with an inquisitive expression, no text"
  };
}

function splashLayout() {
  const preset = findLayoutPreset("builtin:splash");
  assert.ok(preset);
  return preset.layout;
}

test("panel preflight accepts a traceable panel without dialogue wording in its prompt", () => {
  const report = validatePanelPreflight({
    panel: panel(),
    layout: splashLayout(),
    layoutPanelId: "r1c1",
    dialogueTexts: ["ここはどこ？"]
  });
  assert.equal(report.passed, true);
  assert.equal(report.checks.promptHasNoDialogueText, true);
});

test("panel preflight rejects dialogue wording leaked into the image prompt", () => {
  const leaked = panel();
  leaked.compiledPrompt = "Alice asks ここはどこ？ while looking around";
  const report = validatePanelPreflight({
    panel: leaked,
    layout: splashLayout(),
    layoutPanelId: "r1c1",
    dialogueTexts: ["ここはどこ？"]
  });
  assert.equal(report.passed, false);
  assert.equal(report.checks.promptHasNoDialogueText, false);
  assert.ok(report.violations.some((violation) => violation.code === "dialogue-in-image-prompt"));
});

test("panel preflight rejects a panel id missing from the selected layout", () => {
  const report = validatePanelPreflight({
    panel: panel(),
    layout: splashLayout(),
    layoutPanelId: "missing-panel",
    dialogueTexts: ["ここはどこ？"]
  });
  assert.equal(report.passed, false);
  assert.equal(report.checks.layoutPanelPresent, false);
  assert.equal(report.checks.geometryValid, false);
  assert.ok(report.violations.some((violation) => violation.code === "layout-panel-missing"));
});

test("panel preflight blocks required missing references and off-screen speakers left in visual cast", () => {
  const report = validatePanelPreflight({
    panel: panel(),
    layout: splashLayout(),
    layoutPanelId: "r1c1",
    dialogueTexts: ["ここはどこ？"],
    requireReferences: true,
    missingReferenceIds: ["character-1"],
    offscreenSpeakerIds: ["character-1"]
  });
  assert.equal(report.passed, false);
  assert.equal(report.checks.requiredReferencesReady, false);
  assert.equal(report.checks.offscreenSpeakersExcluded, false);
  assert.ok(report.violations.some((violation) => violation.code === "required-reference-missing"));
});
