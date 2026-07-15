import assert from "node:assert/strict";
import test from "node:test";
import { findLayoutPreset } from "./layoutPresets.ts";
import { MANGA_PLAN_VERSION, type MangaPlanV2, validateMangaPlanV2 } from "./mangaPlanV2.ts";

function validPlan(): MangaPlanV2 {
  return {
    version: MANGA_PLAN_VERSION,
    id: "plan-1",
    title: "Test manga",
    scriptId: "script-1",
    scriptRevisionId: "revision-1",
    dialoguePolicy: "preserve",
    plannerVersion: "test-planner",
    promptCompilerVersion: "test-compiler",
    narrativeGraph: {
      sourceElements: [
        { id: "source-action", sceneIndex: 0, elementIndex: 0, type: "action", text: "Alice enters." },
        { id: "source-dialogue", sceneIndex: 0, elementIndex: 1, type: "dialogue", text: "Alice: Hello." },
        {
          id: "source-transition",
          sceneIndex: 0,
          elementIndex: 2,
          type: "transition",
          text: "CUT TO:",
          omissionReason: "represented by scene ordering"
        }
      ],
      entities: [
        {
          id: "setting-room",
          kind: "setting",
          name: "Room",
          aliases: [],
          attributes: {},
          variants: [{ id: "setting-room:default", label: "default", attributes: {} }]
        },
        {
          id: "character-alice",
          kind: "character",
          name: "Alice",
          aliases: [],
          attributes: {},
          variants: [{ id: "character-alice:default", label: "default", attributes: {} }]
        },
        {
          id: "prop-key",
          kind: "prop",
          name: "Key",
          aliases: [],
          attributes: {},
          variants: [{ id: "prop-key:default", label: "default", attributes: {} }]
        }
      ],
      worldStates: [{
        id: "state-before",
        settingId: "setting-room",
        characterStates: {
          "character-alice": {
            variantId: "character-alice:default",
            location: "room",
            outfit: "coat",
            heldEntityIds: [],
            pose: "standing",
            emotion: "calm"
          }
        },
        propStates: { "prop-key": { state: "intact", present: true } },
        time: "day",
        weather: "clear",
        lighting: "window light",
        spatialNotes: []
      }],
      beats: [{
        id: "beat-1",
        sourceElementIds: ["source-action", "source-dialogue"],
        cause: "Alice arrives",
        action: "Alice greets the room",
        result: "Her presence is established",
        emotionChange: "",
        mustShow: ["Alice"],
        dialogueOnly: []
      }],
      warnings: []
    },
    sourceDialogueLineIds: ["line-1"],
    dialogueSnapshots: [{
      id: "line-1",
      orderIndex: 0,
      sceneIndex: 0,
      characterId: "character-alice",
      speakerLabel: "Alice",
      text: "Hello.",
      semanticKind: "dialogue"
    }],
    pages: [{
      index: 0,
      title: "Page 1",
      layoutTemplateId: "test:one-panel",
      layoutSnapshot: JSON.parse(JSON.stringify(findLayoutPreset("builtin:splash")!.layout)),
      pageIntent: "Introduce Alice",
      panels: [{
        id: "panel-1",
        sourceElementIds: ["source-action", "source-dialogue"],
        beatIds: ["beat-1"],
        preStateId: "state-before",
        postStateDelta: { notes: ["Alice is now present"] },
        settingId: "setting-room",
        cast: [{
          characterId: "character-alice",
          variantId: "character-alice:default",
          bbox: { x: 0.1, y: 0.2, width: 0.35, height: 0.7 },
          expression: "calm",
          action: "waves",
          speakingLineIds: ["line-1"]
        }],
        props: [{ entityId: "prop-key", state: "intact", bbox: { x: 0.55, y: 0.65, width: 0.15, height: 0.15 } }],
        shot: {
          size: "medium",
          angle: "eye-level",
          focalSubjectId: "character-alice",
          compositionIntent: "Alice on the right"
        },
        dialogueLineIds: ["line-1"],
        dialogueOrderIndexes: [0],
        textSafeZones: [{ x: 0.62, y: 0.04, width: 0.32, height: 0.25 }],
        mustShow: [{ kind: "entity-present", entityId: "character-alice", description: "Show Alice" }],
        mustNotShow: [{ kind: "other", description: "No generated text" }],
        continuityFromPanelIds: [],
        referenceManifest: [],
        sceneIndex: 0,
        sceneHeading: "INT. ROOM - DAY",
        sourceText: "Alice enters.\nAlice: Hello.",
        promptBase: "Alice enters and waves",
        compiledPrompt: "Alice enters and waves, no text"
      }]
    }],
    panelCount: 1,
    dialogueCount: 1,
    createdAt: "2026-07-12T00:00:00.000Z"
  };
}

function issueCodes(plan: MangaPlanV2): string[] {
  return validateMangaPlanV2(plan).issues.map((issue) => issue.code);
}

test("validateMangaPlanV2 accepts a plan whose layout cardinality and frozen counts match", () => {
  const report = validateMangaPlanV2(validPlan());
  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);

  const mismatch = validPlan();
  mismatch.pages[0]!.layoutSnapshot.panels.push({
    ...mismatch.pages[0]!.layoutSnapshot.panels[0]!,
    id: "extra-layout-panel",
    order: 1
  });
  assert.ok(issueCodes(mismatch).includes("layout-panel-count"));

  const missingSnapshot = validPlan();
  delete (missingSnapshot.pages[0] as Partial<MangaPlanV2["pages"][number]>).layoutSnapshot;
  assert.ok(issueCodes(missingSnapshot).includes("layout-snapshot"));
});

test("validateMangaPlanV2 detects missing and duplicate dialogue coverage", () => {
  const missing = validPlan();
  missing.sourceDialogueLineIds.push("line-2");
  missing.dialogueCount = 2;
  const missingCodes = issueCodes(missing);
  assert.ok(missingCodes.includes("dialogue-total"));
  assert.ok(missingCodes.includes("dialogue-missing"));

  const duplicate = validPlan();
  duplicate.pages[0]!.panels[0]!.dialogueLineIds.push("line-1");
  assert.ok(issueCodes(duplicate).includes("dialogue-duplicate"));
});

test("validateMangaPlanV2 preserves frozen dialogue order, indexes, and scene ownership", () => {
  const reversed = validPlan();
  reversed.sourceDialogueLineIds.push("line-2");
  reversed.dialogueSnapshots.push({
    ...reversed.dialogueSnapshots[0]!,
    id: "line-2",
    orderIndex: 1,
    text: "Again."
  });
  reversed.dialogueCount = 2;
  reversed.pages[0]!.panels[0]!.dialogueLineIds = ["line-2", "line-1"];
  reversed.pages[0]!.panels[0]!.dialogueOrderIndexes = [1, 0];
  reversed.pages[0]!.panels[0]!.cast[0]!.speakingLineIds = ["line-2", "line-1"];
  assert.ok(issueCodes(reversed).includes("dialogue-order"));

  const wrongIndexes = validPlan();
  wrongIndexes.pages[0]!.panels[0]!.dialogueOrderIndexes = [99];
  assert.ok(issueCodes(wrongIndexes).includes("dialogue-order-indexes"));

  const wrongScene = validPlan();
  wrongScene.dialogueSnapshots[0]!.sceneIndex = 1;
  assert.ok(issueCodes(wrongScene).includes("dialogue-scene"));

  const unorderedSource = structuredClone(reversed);
  unorderedSource.sourceDialogueLineIds = ["line-2", "line-1"];
  assert.ok(issueCodes(unorderedSource).includes("dialogue-source-order"));
});

test("validateMangaPlanV2 requires direct speakers in cast and validates speaking-line ownership", () => {
  const missingSpeaker = validPlan();
  missingSpeaker.pages[0]!.panels[0]!.cast = [];
  assert.ok(issueCodes(missingSpeaker).includes("visible-speaker-cast"));

  const wrongSpeaker = validPlan();
  wrongSpeaker.pages[0]!.panels[0]!.cast[0]!.characterId = "prop-key";
  assert.ok(issueCodes(wrongSpeaker).includes("cast-dialogue-speaker"));

  const foreignLine = validPlan();
  foreignLine.pages[0]!.panels[0]!.cast[0]!.speakingLineIds = ["line-outside-panel"];
  assert.ok(issueCodes(foreignLine).includes("cast-dialogue-panel"));
});

test("validateMangaPlanV2 requires action-grounded actors even when their dialogue is off-screen", () => {
  const plan = validPlan();
  plan.dialogueSnapshots[0]!.balloonStyle = "vo";
  plan.pages[0]!.panels[0]!.cast = [];
  const codes = issueCodes(plan);
  assert.ok(codes.includes("source-actor-cast"));
  assert.ok(!codes.includes("visible-speaker-cast"));
});

test("validateMangaPlanV2 permits an explicit off-frame action actor without adding them to cast", () => {
  const plan = validPlan();
  const panel = plan.pages[0]!.panels[0]!;
  plan.dialogueSnapshots[0]!.balloonStyle = "vo";
  panel.cast = [];
  panel.mustShow = [];
  panel.mustNotShow.push({
    kind: "entity-absent",
    entityId: "character-alice",
    description: "Alice remains outside this close-up frame"
  });
  const report = validateMangaPlanV2(plan);
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.ok(!report.issues.some((issue) => issue.code === "source-actor-cast"));

  panel.cast = [structuredClone(validPlan().pages[0]!.panels[0]!.cast[0]!)];
  assert.ok(issueCodes(plan).includes("cast-explicitly-absent"));
});

test("validateMangaPlanV2 checks state, beat and entity references", () => {
  const plan = validPlan();
  const panel = plan.pages[0]!.panels[0]!;
  panel.preStateId = "missing-state";
  panel.settingId = "missing-setting";
  panel.beatIds = ["missing-beat"];
  panel.cast[0]!.characterId = "missing-character";
  panel.props[0]!.entityId = "missing-prop";
  const codes = issueCodes(plan);
  for (const code of ["pre-state", "setting", "beat-reference", "cast-reference", "prop-reference"]) {
    assert.ok(codes.includes(code), code);
  }
});

test("validateMangaPlanV2 rejects source elements borrowed from another scene", () => {
  const plan = validPlan();
  plan.narrativeGraph.sourceElements.push({
    id: "source-other-scene",
    sceneIndex: 1,
    elementIndex: 0,
    type: "action",
    text: "Alice stands outside."
  });
  plan.pages[0]!.panels[0]!.sourceElementIds.push("source-other-scene");
  assert.ok(issueCodes(plan).includes("source-scene"));
});

test("validateMangaPlanV2 rejects invalid cast, prop and lettering geometry", () => {
  const plan = validPlan();
  const panel = plan.pages[0]!.panels[0]!;
  panel.cast[0]!.bbox = { x: 0.8, y: 0.2, width: 0.3, height: 0.7 };
  panel.props[0]!.bbox = { x: 0.2, y: 0.2, width: 0, height: 0.1 };
  panel.textSafeZones[0] = { x: -0.1, y: 0.1, width: 0.3, height: 0.2 };
  const codes = issueCodes(plan);
  assert.ok(codes.includes("cast-box"));
  assert.ok(codes.includes("prop-box"));
  assert.ok(codes.includes("safe-zone"));
});

test("validateMangaPlanV2 warns only when an omitted source lacks a reason", () => {
  assert.equal(issueCodes(validPlan()).includes("source-unassigned"), false);

  const plan = validPlan();
  delete plan.narrativeGraph.sourceElements[2]!.omissionReason;
  const report = validateMangaPlanV2(plan);
  assert.equal(report.ok, true, "source omission is reviewable warning, not a structural error");
  assert.ok(report.issues.some((issue) => issue.code === "source-unassigned" && issue.severity === "warning"));
});

test("validateMangaPlanV2 warns when a figure slot panel does not have exactly one cast member", () => {
  // splash(1コマ)を figure スロット化した snapshot。cast 2人で warning、1人なら issue 無し。
  const plan = validPlan();
  plan.pages[0]!.layoutSnapshot.panels[0]!.role = "figure";
  assert.equal(issueCodes(plan).includes("figure-cast-count"), false);

  const crowded = validPlan();
  crowded.pages[0]!.layoutSnapshot.panels[0]!.role = "figure";
  crowded.pages[0]!.panels[0]!.cast.push({
    characterId: "character-alice",
    variantId: "character-alice:default",
    bbox: { x: 0.5, y: 0.2, width: 0.3, height: 0.7 },
    expression: "calm",
    action: "standing",
    speakingLineIds: []
  });
  const report = validateMangaPlanV2(crowded);
  const issue = report.issues.find((entry) => entry.code === "figure-cast-count");
  assert.ok(issue, "figure-cast-count warning");
  assert.equal(issue!.severity, "warning");
  assert.equal(report.ok, true, "warning は実行を止めない");
});
