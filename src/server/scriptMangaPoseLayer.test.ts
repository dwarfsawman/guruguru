/**
 * ネームポーズレイヤ(Docs/Feature-NamePoseLayer.md)P2: 監督の castRef/head/torso/layer が
 * buildMangaPlanV2 で cast と castPoses へ結線されることの検証。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "../shared/fountain.ts";
import { validateMangaPlanV2 } from "../shared/mangaPlanV2.ts";
import { planScriptManga, type ScriptMangaPanelDirection, type ScriptMangaPlan } from "../shared/scriptMangaPlan.ts";
import { initializeDb } from "./db.ts";
import { resolveLayoutTemplate } from "./layoutTemplates.ts";
import { buildMangaPlanV2 } from "./scriptMangaPlanV2.ts";
import type { StoryGraphCharacterInput, StoryGraphDialogueInput } from "./storyGraphBuilder.ts";

const SCRIPT = [
  "INT. LAB - NIGHT",
  "",
  "Alice opens the box. Bob watches from the doorway.",
  "",
  "@ALICE",
  "Is this... me?",
  "",
  "@BOB",
  "Careful with that."
].join("\n");

const CHARACTERS: StoryGraphCharacterInput[] = [
  { id: "char-alice", name: "Alice", aliases: ["ALICE"], notes: "", color: "#ff3366" },
  { id: "char-bob", name: "Bob", aliases: ["BOB"], notes: "", color: null }
];

const DIALOGUES: StoryGraphDialogueInput[] = [
  { id: "line-0", orderIndex: 0, sceneIndex: 0, characterId: "char-alice", speakerLabel: "ALICE", text: "Is this... me?", semanticKind: "dialogue", balloonStyle: "normal" },
  { id: "line-1", orderIndex: 1, sceneIndex: 0, characterId: "char-bob", speakerLabel: "BOB", text: "Careful with that.", semanticKind: "dialogue", balloonStyle: "normal" }
];

type DirectablePanel = ScriptMangaPlan["pages"][number]["panels"][number] & {
  direction?: ScriptMangaPanelDirection;
};

function buildPlan(direction: ScriptMangaPanelDirection | null) {
  initializeDb();
  const doc = parseFountain(SCRIPT).doc;
  const legacy = planScriptManga(doc, { panelsPerPage: 4, maxElementsPerPanel: 8 });
  const panel = legacy.pages[0]!.panels.find((candidate) =>
    candidate.dialogueOrderIndexes.includes(0) || candidate.dialogueOrderIndexes.includes(1)
  ) ?? legacy.pages[0]!.panels[0]!;
  if (direction) {
    (panel as DirectablePanel).direction = direction;
    legacy.plannerProvenance = { kind: "llm-director", model: "test", batches: [] } as ScriptMangaPlan["plannerProvenance"];
  }
  const plan = buildMangaPlanV2({
    id: "plan-pose",
    projectId: "proj",
    scriptId: "script",
    scriptRevisionId: "rev",
    doc,
    legacyPlan: legacy,
    characters: CHARACTERS,
    dialogues: DIALOGUES,
    providerId: "comfy",
    globalLoras: [],
    dialoguePolicy: "preserve",
    resolveLayoutTemplate,
    beatAnnotation: null
  });
  const v2Panel = plan.pages.flatMap((page) => page.panels).find((candidate) => candidate.id === panel.id)!;
  return { plan, panel: v2Panel };
}

test("buildMangaPlanV2: castRef が subject をキャラへ結線し bbox/pose/アンカー骨格が反映される", () => {
  const { plan, panel } = buildPlan({
    shot: "medium",
    angle: "eye-level",
    subject: "primary character, second character",
    subjects: [
      {
        ref: "primary character", position: "upper-left", action: "pointing at the box", expression: "tense",
        castRef: "alice", head: { x: 0.3, y: 0.15 }, torso: { x: 0.3, y: 0.55 }, layer: 1
      },
      {
        ref: "second character", position: "middle-right", action: "standing still", expression: "wary",
        castRef: "BOB", layer: 0
      }
    ],
    action: "the box is opened",
    emotion: "tense",
    composition: "diagonal"
  });
  const alice = panel.cast.find((member) => member.characterId === "char-alice")!;
  const bob = panel.cast.find((member) => member.characterId === "char-bob")!;
  // castRef 一致(大文字小文字無視・alias 含む)で positionBox が実際に使われる。
  assert.deepEqual(alice.bbox, { x: 0.04, y: 0.04, width: 0.3, height: 0.42 });
  assert.deepEqual(bob.bbox, { x: 0.66, y: 0.29, width: 0.3, height: 0.42 });
  assert.equal(alice.pose, "pointing at the box");
  assert.equal(bob.pose, "standing still");
  // castPoses: アンカー付きの alice は source=llm、bob は bbox フィット(reconstructed)。
  assert.ok(panel.castPoses);
  const alicePose = panel.castPoses!.find((pose) => pose.characterId === "char-alice")!;
  const bobPose = panel.castPoses!.find((pose) => pose.characterId === "char-bob")!;
  assert.equal(alicePose.source, "llm");
  assert.equal(alicePose.presetId, "pointing");
  assert.equal(bobPose.source, "reconstructed");
  // layer ヒント: bob(layer 0)が奥、alice(layer 1)が手前。
  assert.equal(bobPose.depth, 0);
  assert.equal(alicePose.depth, 1);
  // アンカーはパネルローカル正規化のまま骨格へ写る(ヒップ中点 = torso)。
  const hipMid = {
    x: (alicePose.joints[8]!.x + alicePose.joints[11]!.x) / 2,
    y: (alicePose.joints[8]!.y + alicePose.joints[11]!.y) / 2
  };
  assert.ok(Math.abs(hipMid.x - 0.3) < 1e-6 && Math.abs(hipMid.y - 0.55) < 1e-6, `(${hipMid.x},${hipMid.y})`);
  assert.equal(alicePose.joints.length, 18);
  // キャラ色は entities まで伝播している。
  const aliceEntity = plan.narrativeGraph.entities.find((entity) => entity.id === "char-alice")!;
  assert.equal(aliceEntity.color, "#ff3366");
  assert.ok(validateMangaPlanV2(plan).ok, JSON.stringify(validateMangaPlanV2(plan).issues));
});

test("buildMangaPlanV2: 中立ロールのみ(castRef無し)は従来の castBoxes へフォールバックし骨格も生成される", () => {
  const { panel } = buildPlan({
    shot: "wide",
    angle: "eye-level",
    subject: "primary character",
    subjects: [
      { ref: "primary character", position: "upper-left", action: "opening the box", expression: "focused" }
    ],
    action: "the box is opened",
    emotion: "calm",
    composition: "wide establishing"
  });
  // ref は中立ロールなので castRef 無しでは結線されない = 決定的レイアウト(castBoxes)。
  for (const member of panel.cast) {
    assert.notDeepEqual(member.bbox, { x: 0.04, y: 0.04, width: 0.3, height: 0.42 });
  }
  assert.ok(panel.castPoses, "アンカー無しでも骨格レイヤは常時生成される");
  assert.ok(panel.castPoses!.every((pose) => pose.source === "reconstructed"));
  // depth の既定則: focalSubject が最前面(深度最大)。
  const focalPose = panel.castPoses!.find((pose) => pose.characterId === panel.shot.focalSubjectId);
  if (focalPose && panel.castPoses!.length > 1) {
    const maxDepth = Math.max(...panel.castPoses!.map((pose) => pose.depth));
    assert.equal(focalPose.depth, maxDepth);
  }
});

test("buildMangaPlanV2: 未演出(direction無し)でも骨格レイヤが生成され plan は valid", () => {
  const { plan, panel } = buildPlan(null);
  assert.ok(panel.castPoses);
  assert.ok(panel.castPoses!.length >= 1);
  assert.ok(panel.castPoses!.every((pose) => pose.joints.length === 18));
  assert.ok(validateMangaPlanV2(plan).ok, JSON.stringify(validateMangaPlanV2(plan).issues));
});
