/**
 * ネームポーズレイヤ(Docs/Feature-NamePoseLayer.md)P2: 監督の castRef/head/torso/layer が
 * buildMangaPlanV2 で cast と castPoses へ結線されることの検証。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "../shared/fountain.ts";
import { validateMangaPlanV2, type PanelCastPose, type PanelSpec } from "../shared/mangaPlanV2.ts";
import { planScriptManga, type ScriptMangaPanelDirection, type ScriptMangaPlan } from "../shared/scriptMangaPlan.ts";
import { createId, initializeDb, runSql } from "./db.ts";
import { HttpError } from "./http.ts";
import { resolveLayoutTemplate } from "./layoutTemplates.ts";
import { compilePanelPrompt } from "./panelPromptCompiler.ts";
import { createProject } from "./projects.ts";
import { fakeProvider, resetFakeProvider } from "./providers/fakeProvider.ts";
import { registerProvider } from "./providers/registry.ts";
import { createScript } from "./scripts.ts";
import { applyNamePlanEdits, buildPoseControlAttachment, createScriptMangaRun } from "./scriptManga.ts";
import { buildMangaPlanV2 } from "./scriptMangaPlanV2.ts";
import type { StoryGraphCharacterInput, StoryGraphDialogueInput } from "./storyGraphBuilder.ts";

registerProvider(fakeProvider);

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

// --- P3: 生成接続(保存骨格優先+深度順)と差分編集 ---

function jointGrid(visible = true): PanelCastPose["joints"] {
  return Array.from({ length: 18 }, (_, index) => ({ x: 0.3 + (index % 3) * 0.2, y: 0.05 + index * 0.05, visible }));
}

function poseOnlyPanel(castPoses: PanelCastPose[], cast: PanelSpec["cast"] = []): PanelSpec {
  return {
    id: "pp1",
    sourceElementIds: [],
    beatIds: [],
    preStateId: "state:pre",
    postStateDelta: { notes: [] },
    settingId: "setting:0",
    cast,
    castPoses,
    props: [],
    shot: { size: "medium", angle: "eye-level", focalSubjectId: "char-x", compositionIntent: "x" },
    dialogueLineIds: [],
    dialogueOrderIndexes: [],
    textSafeZones: [],
    mustShow: [],
    mustNotShow: [],
    continuityFromPanelIds: [],
    referenceManifest: [],
    sceneIndex: 0,
    sceneHeading: "INT. LAB",
    sourceText: "",
    promptBase: "base",
    compiledPrompt: "x"
  } as PanelSpec;
}

test("buildPoseControlAttachment: 保存骨格を depth 昇順(奥→手前)で使い、mode マスクを交差適用する", async () => {
  const panel = poseOnlyPanel([
    { characterId: "char-front", depth: 1, joints: jointGrid(), source: "human", presetId: "front" },
    { characterId: "char-back", depth: 0, joints: jointGrid(), source: "llm", presetId: "back" }
  ]);
  const attachment = await buildPoseControlAttachment(panel, 128, 128, { enabled: true, mode: "full", strength: 0.5, endPercent: 0.6 });
  assert.ok(attachment, "保存骨格があれば cast が空でも添付できる");
  assert.deepEqual(attachment!.presetIds, ["back", "front"], "depth 昇順 = 奥が先に描かれ手前が上書きする");
  assert.match(attachment!.poseImageDataUrl, /^data:image\/png;base64,/);

  // face モード: 頭部以外しか可視でない骨格はマスク後に何も残らず、復元も出来ない(cast空)ので null。
  const legsOnly = jointGrid(true).map((joint, index) => ({ ...joint, visible: index >= 8 && index <= 13 }));
  const legsPanel = poseOnlyPanel([
    { characterId: "char-legs", depth: 0, joints: legsOnly, source: "human" }
  ]);
  const faceAttachment = await buildPoseControlAttachment(legsPanel, 128, 128, { enabled: true, mode: "face", strength: 0.5, endPercent: 0.6 });
  assert.equal(faceAttachment, null, "mode交差で全関節が不可視なら添付しない");
  const fullAttachment = await buildPoseControlAttachment(legsPanel, 128, 128, { enabled: true, mode: "full", strength: 0.5, endPercent: 0.6 });
  assert.ok(fullAttachment, "full なら同じ骨格で添付できる");
});

test("compilePanelPrompt: 深度差のある2人以上のコマにだけ前後関係ヒントが入る", () => {
  const layered = poseOnlyPanel([
    { characterId: "a", depth: 0, joints: jointGrid(), source: "llm" },
    { characterId: "b", depth: 1, joints: jointGrid(), source: "llm" }
  ]);
  const hint = "clear foreground and background separation between overlapping figures";
  const prompt = compilePanelPrompt({ panel: layered, basePrompt: "base", entities: [], dialogueById: new Map(), narrativeMetadata: "english-directed" });
  assert.ok(prompt.includes(hint));
  const flat = poseOnlyPanel([
    { characterId: "a", depth: 0, joints: jointGrid(), source: "llm" },
    { characterId: "b", depth: 0, joints: jointGrid(), source: "llm" }
  ]);
  const flatPrompt = compilePanelPrompt({ panel: flat, basePrompt: "base", entities: [], dialogueById: new Map(), narrativeMetadata: "english-directed" });
  assert.ok(!flatPrompt.includes(hint), "深度が同じならヒント無し");
  const solo = poseOnlyPanel([{ characterId: "a", depth: 1, joints: jointGrid(), source: "llm" }]);
  const soloPrompt = compilePanelPrompt({ panel: solo, basePrompt: "base", entities: [], dialogueById: new Map(), narrativeMetadata: "english-directed" });
  assert.ok(!soloPrompt.includes(hint), "1人ならヒント無し");
});

test("applyNamePlanEdits: pose 編集(置換/深度/削除)と検証エラー", async () => {
  initializeDb();
  resetFakeProvider();
  const templateId = createId("template");
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Pose layer fake', '', 'txt2img', 1, '{}', '{}', 'hash')`,
    [templateId]
  );
  const project = createProject({ name: `pose-layer-${createId("t")}`, mode: "book" })!;
  const imported = createScript(project.id, { title: "Pose layer", fountainSource: SCRIPT });
  const run = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    dialoguePolicy: "preserve",
    auditMode: "manual",
    generateImages: false
  });
  assert.ok(run.planId && run.plan && run.planEditVersion !== null);
  const panel = run.plan!.pages.flatMap((page) => page.panels).find((candidate) => candidate.cast.length > 0)!;
  assert.ok(panel, "cast のあるコマが存在する");
  const characterId = panel.cast[0]!.characterId;
  const joints = Array.from({ length: 18 }, (_, index) => ({ x: 0.4, y: index / 20, visible: index !== 17 }));

  const edited = applyNamePlanEdits(run.planId!, {
    expectedVersion: run.planEditVersion!,
    edits: [{ kind: "pose", panelId: panel.id, characterId, joints, depth: 3 }]
  });
  const editedPanel = edited.plan.pages.flatMap((page) => page.panels).find((candidate) => candidate.id === panel.id)!;
  const editedPose = editedPanel.castPoses!.find((pose) => pose.characterId === characterId)!;
  assert.equal(editedPose.source, "human");
  assert.equal(editedPose.depth, 3);
  assert.equal(editedPose.joints[17]!.visible, false);
  assert.ok(Math.abs(editedPose.joints[5]!.y - 5 / 20) < 1e-9);
  assert.equal(editedPanel.directionSource, "human");

  // 削除(joints: null)。
  const removed = applyNamePlanEdits(run.planId!, {
    expectedVersion: edited.editVersion,
    edits: [{ kind: "pose", panelId: panel.id, characterId, joints: null }]
  });
  const removedPanel = removed.plan.pages.flatMap((page) => page.panels).find((candidate) => candidate.id === panel.id)!;
  assert.ok(!removedPanel.castPoses?.some((pose) => pose.characterId === characterId), "骨格が削除される");

  // 検証エラー: 関節数不足 / cast 外キャラ / 空編集。
  const badCases: Array<Record<string, unknown>> = [
    { kind: "pose", panelId: panel.id, characterId, joints: joints.slice(0, 17) },
    { kind: "pose", panelId: panel.id, characterId: "char-not-there", joints },
    { kind: "pose", panelId: panel.id, characterId }
  ];
  for (const badEdit of badCases) {
    assert.throws(
      () => applyNamePlanEdits(run.planId!, { expectedVersion: removed.editVersion, edits: [badEdit] }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 400,
      JSON.stringify(badEdit)
    );
  }
});
