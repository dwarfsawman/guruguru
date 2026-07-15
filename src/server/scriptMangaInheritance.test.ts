import assert from "node:assert/strict";
import test from "node:test";
import type { MangaBeat, PanelSpec, WorldState } from "../shared/mangaPlanV2.ts";
import type { LayoutPanel } from "../shared/pageLayout.ts";
import type { ScriptMangaReferenceSnapshot } from "../shared/referenceSets.ts";
import {
  computeScriptMangaReuseFingerprint,
  matchScriptMangaReuseCandidates,
  matchScriptMangaReuseCandidatesWithReservations,
  type ScriptMangaReuseFingerprintInput
} from "./scriptMangaInheritance.ts";

function panel(overrides: Partial<PanelSpec> = {}): PanelSpec {
  return {
    id: "panel-old-id",
    sourceElementIds: ["source-1"],
    beatIds: ["beat-old-id"],
    preStateId: "state-old-id",
    postStateDelta: { notes: ["door opened"] },
    settingId: "setting-lab",
    cast: [{
      characterId: "character-alice",
      variantId: "default",
      bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.8 },
      pose: "standing",
      expression: "alert",
      action: "opens the door",
      speakingLineIds: ["line-1"]
    }],
    props: [{ entityId: "prop-door", state: "open" }],
    shot: {
      size: "medium",
      angle: "eye-level",
      focalSubjectId: "character-alice",
      compositionIntent: "show the opened door"
    },
    dialogueLineIds: ["line-1"],
    fillUnitIds: ["fill-1"],
    dialogueOrderIndexes: [1],
    textSafeZones: [{ x: 0.55, y: 0.05, width: 0.4, height: 0.25 }],
    mustShow: [{ kind: "action", description: "Alice opens the door", entityId: "character-alice" }],
    mustNotShow: [{ kind: "entity-absent", description: "No background people" }],
    continuityFromPanelIds: ["continuity-old-id"],
    referenceManifest: [{
      entityId: "character-alice",
      variantId: "default",
      artifact: { kind: "referenceSet", setId: "reference-set-1", version: 3, role: "face" },
      role: "identity",
      strength: 1
    }],
    sceneIndex: 0,
    sceneHeading: "INT. LAB - NIGHT",
    sourceText: "Alice opens the door.",
    promptBase: "Alice opens a steel door",
    compiledPrompt: "one woman, opening a steel door, empty laboratory",
    ...overrides
  };
}

function beat(overrides: Partial<MangaBeat> = {}): MangaBeat {
  return {
    id: "beat-old-id",
    sourceElementIds: ["source-1"],
    cause: "Alice reaches the lab",
    action: "Alice opens the door",
    result: "The lab is revealed",
    emotionChange: "calm to alert",
    mustShow: ["open door"],
    dialogueOnly: [],
    ...overrides
  };
}

function worldState(overrides: Partial<WorldState> = {}): WorldState {
  return {
    id: "state-old-id",
    settingId: "setting-lab",
    characterStates: {
      "character-alice": {
        variantId: "default",
        location: "hallway",
        outfit: "flight suit",
        heldEntityIds: [],
        pose: "standing",
        emotion: "calm"
      }
    },
    propStates: { "prop-door": { state: "closed", present: true } },
    time: "night",
    weather: "clear",
    lighting: "cold fluorescent",
    spatialNotes: ["door ahead"],
    ...overrides
  };
}

function referenceSnapshot(overrides: Partial<ScriptMangaReferenceSnapshot> = {}): ScriptMangaReferenceSnapshot {
  return {
    modelFamily: "anima",
    approvedAt: "2026-07-15T01:00:00.000Z",
    allowFallback: false,
    sets: [{
      setId: "reference-set-1",
      characterId: "character-alice",
      variantId: "default",
      modelFamily: "anima",
      version: 3,
      appearanceJa: "黒髪の女性",
      appearancePromptEn: "woman with short black hair",
      mustNotChange: ["short black hair", "blue eyes"],
      appearanceHash: "appearance-hash",
      images: [{ role: "face", checksum: "checksum-front", width: 1024, height: 1024 }]
    }],
    ...overrides
  };
}

function layout(overrides: Partial<LayoutPanel> = {}): LayoutPanel {
  return {
    id: "layout-panel-old-id",
    order: 4,
    shape: { type: "rect", bounds: [0.05, 0.1, 0.9, 0.5] },
    frame: { visible: true, style: "solid", strokeWidth: 0.005, strokeColor: "#000000" },
    ...overrides
  };
}

function input(overrides: Partial<ScriptMangaReuseFingerprintInput> = {}): ScriptMangaReuseFingerprintInput {
  return {
    scriptRevisionId: "revision-1",
    panel: panel(),
    resolvedBeats: [beat()],
    resolvedPreState: worldState(),
    resolvedContinuityPanels: [panel({ id: "continuity-old-id", continuityFromPanelIds: [] })],
    layoutPanel: layout(),
    generation: {
      providerId: "comfy",
      template: { id: "anima-int8", version: 2, workflowHash: "workflow-hash" },
      promptCompilerVersion: "manga-plan-v2-prompt-v5",
      request: {
        prompt: "one woman, opening a steel door, empty laboratory",
        negativePrompt: "extra people, text",
        width: 1024,
        height: 768,
        batchSize: 1,
        steps: 20,
        cfg: 5,
        sampler: "euler",
        scheduler: "beta",
        denoise: 1,
        generationMode: "txt2img",
        seed: 123,
        seedMode: "random",
        target: { runId: "run-old", taskId: "task-old", pageId: "page-old", panelId: "panel-old" }
      }
    },
    referenceSnapshot: referenceSnapshot(),
    ...overrides
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("reuse fingerprint ignores regenerated plan/runtime IDs, seed, and approval timestamp", () => {
  const before = input();
  const after = clone(before);
  after.panel.id = "panel-new-id";
  after.panel.beatIds = ["beat-new-id"];
  after.panel.preStateId = "state-new-id";
  after.panel.continuityFromPanelIds = ["continuity-new-id"];
  after.resolvedBeats = [beat({ id: "beat-new-id" })];
  after.resolvedPreState = worldState({ id: "state-new-id" });
  after.resolvedContinuityPanels = [panel({ id: "continuity-new-id", continuityFromPanelIds: [] })];
  after.layoutPanel = layout({ id: "layout-panel-new-id", order: 9 });
  after.referenceSnapshot = referenceSnapshot({ approvedAt: "2026-07-15T09:00:00.000Z" });
  after.generation = clone(before.generation) as Record<string, unknown>;
  const generation = after.generation as { request: { seed: number; target: Record<string, string> } };
  generation.request.seed = 999;
  generation.request.target = { runId: "run-new", taskId: "task-new", pageId: "page-new", panelId: "panel-new" };

  assert.equal(computeScriptMangaReuseFingerprint(after), computeScriptMangaReuseFingerprint(before));
});

test("reuse fingerprint is insensitive to object key order and reference-set ordering", () => {
  const before = input();
  const after = clone(before);
  after.generation = {
    request: (before.generation as { request: unknown }).request,
    promptCompilerVersion: "manga-plan-v2-prompt-v5",
    template: { workflowHash: "workflow-hash", version: 2, id: "anima-int8" },
    providerId: "comfy"
  };
  const snapshot = referenceSnapshot();
  snapshot.sets[0]!.mustNotChange.reverse();
  after.referenceSnapshot = snapshot;

  assert.equal(computeScriptMangaReuseFingerprint(after), computeScriptMangaReuseFingerprint(before));
});

test("reuse fingerprint changes for material story, layout, generation, and reference changes", () => {
  const baseline = input();
  const baselineFingerprint = computeScriptMangaReuseFingerprint(baseline);
  const mutations: ScriptMangaReuseFingerprintInput[] = [];

  mutations.push(input({ scriptRevisionId: "revision-2" }));
  mutations.push(input({ panel: panel({ cast: [] }) }));
  mutations.push(input({ panel: panel({ props: [{ entityId: "prop-door", state: "closed" }] }) }));
  mutations.push(input({ panel: panel({ cast: [{ ...panel().cast[0]!, action: "walks away" }] }) }));
  mutations.push(input({ layoutPanel: layout({ shape: { type: "rect", bounds: [0.1, 0.1, 0.8, 0.5] } }) }));
  mutations.push(input({ generation: { ...(baseline.generation as object), promptCompilerVersion: "manga-plan-v2-prompt-v6" } }));
  const changedSnapshot = referenceSnapshot();
  changedSnapshot.sets[0]!.images[0]!.checksum = "different-checksum";
  mutations.push(input({ referenceSnapshot: changedSnapshot }));
  mutations.push(input({ resolvedBeats: [beat({ action: "Alice closes the door" })] }));
  mutations.push(input({ resolvedPreState: worldState({ lighting: "red emergency light" }) }));

  for (const mutation of mutations) {
    assert.notEqual(computeScriptMangaReuseFingerprint(mutation), baselineFingerprint);
  }
});

test("matching consumes duplicate predecessor fingerprints once in deterministic order", () => {
  const matches = matchScriptMangaReuseCandidates(
    [
      { fingerprint: "same", value: "old-a" },
      { fingerprint: "other", value: "old-other" },
      { fingerprint: "same", value: "old-b" }
    ],
    [
      { fingerprint: "same", value: "new-a" },
      { fingerprint: "same", value: "new-b" },
      { fingerprint: "same", value: "new-c" },
      { fingerprint: "other", value: "new-other" },
      { fingerprint: null, value: "new-null" }
    ]
  );

  assert.deepEqual(
    matches.map(({ predecessor, successor, predecessorIndex, successorIndex }) => ({
      predecessor,
      successor,
      predecessorIndex,
      successorIndex
    })),
    [
      { predecessor: "old-a", successor: "new-a", predecessorIndex: 0, successorIndex: 0 },
      { predecessor: "old-b", successor: "new-b", predecessorIndex: 2, successorIndex: 1 },
      { predecessor: "old-other", successor: "new-other", predecessorIndex: 1, successorIndex: 3 }
    ]
  );
});

test("persisted inheritance reserves a repair source before matching duplicate pending targets", () => {
  const matches = matchScriptMangaReuseCandidatesWithReservations(
    [{ fingerprint: "root-match", value: "repair-source" }],
    [
      {
        fingerprint: "repair-material-fingerprint",
        value: "already-inherited-after-restart",
        reservedPredecessorIndex: 0
      },
      { fingerprint: "root-match", value: "duplicate-pending-target" }
    ]
  );

  assert.deepEqual(matches.map(({ predecessor, successor }) => ({ predecessor, successor })), [
    { predecessor: "repair-source", successor: "already-inherited-after-restart" }
  ]);
});
