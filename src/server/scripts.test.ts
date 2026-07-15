import { test } from "node:test";
import assert from "node:assert/strict";
import { addScriptRevision, createScript, listScriptRevisions, resolveDialoguePresentation } from "./scripts.ts";
import { listDialogueLines } from "./dialogueLines.ts";
import { listCharacters } from "./characters.ts";
import { createProject } from "./projects.ts";
import { initializeDb, getRow } from "./db.ts";
import {
  actionTextEstablishesVisibleActor,
  dialogueEstablishesVisibleSpeaker,
  findVisibleActorEvidence,
  getDialoguePresentationMeaning,
  parseSpeakerCue
} from "../shared/dialoguePresentation.ts";

function createTestProject() {
  initializeDb();
  const project = createProject({ name: "S3 scripts", mode: "book" });
  assert.ok(project);
  return project!.id as string;
}

const SOURCE_V1 = ["INT. 教室 - 昼", "", "@太郎", "おはよう。", "", "@花子", "おはよう、太郎。"].join("\n");

test("createScript: 日本語 Fountain(@話者)取り込みで characters/dialogue_lines が生成される", () => {
  const projectId = createTestProject();
  const result = createScript(projectId, { title: "第一話", fountainSource: SOURCE_V1 });
  assert.equal(result.script.title, "第一話");
  assert.equal(result.revision.revision, 1);
  assert.equal(result.revision.fountainSource, SOURCE_V1);
  assert.equal(result.lines.length, 2);
  assert.deepEqual(
    result.lines.map((line) => line.speakerLabel),
    ["太郎", "花子"]
  );
  assert.ok(result.lines.every((line) => line.status === "active"));

  const characters = listCharacters(projectId);
  assert.equal(characters.length, 2);
  assert.ok(characters.some((c) => c.name === "太郎"));
  assert.ok(characters.some((c) => c.name === "花子"));
});

test("再取り込み: 変更/削除/移動した行が維持・orphaned 追跡される", () => {
  const projectId = createTestProject();
  const first = createScript(projectId, { fountainSource: SOURCE_V1 });
  const scriptId = first.script.id;
  const taroLineId = first.lines.find((line) => line.speakerLabel === "太郎")!.id;
  const hanakoLineId = first.lines.find((line) => line.speakerLabel === "花子")!.id;

  // v2: 太郎の行は維持(同一speaker+text)、花子の行は消え、新しい台詞(次郎)が追加される。
  const SOURCE_V2 = ["INT. 教室 - 昼", "", "@太郎", "おはよう。", "", "@次郎", "やあ。"].join("\n");
  const second = addScriptRevision(scriptId, { fountainSource: SOURCE_V2 });
  assert.equal(second.revision.revision, 2);
  assert.equal(listScriptRevisions(scriptId).length, 2);

  const allLines = listDialogueLines(projectId, { scriptId });
  const taro = allLines.find((line) => line.id === taroLineId);
  const hanako = allLines.find((line) => line.id === hanakoLineId);
  const jiro = allLines.find((line) => line.speakerLabel === "次郎");
  assert.ok(taro, "太郎の行(id維持)は残る");
  assert.equal(taro!.status, "active");
  assert.ok(hanako, "花子の行は削除されず orphaned になる");
  assert.equal(hanako!.status, "orphaned");
  assert.ok(jiro, "新規行(次郎)が追加される");
  assert.equal(jiro!.status, "active");

  // v3: 花子の行が復活(同じ speaker+text が再登場)すると active に戻る。
  const SOURCE_V3 = ["INT. 教室 - 昼", "", "@太郎", "おはよう。", "", "@花子", "おはよう、太郎。"].join("\n");
  addScriptRevision(scriptId, { fountainSource: SOURCE_V3 });
  const afterRevive = listDialogueLines(projectId, { scriptId });
  const hanakoAgain = afterRevive.find((line) => line.id === hanakoLineId);
  assert.ok(hanakoAgain);
  assert.equal(hanakoAgain!.status, "active", "同一 hash の再出現で orphaned → active に復活する");
});

test("再取り込み: parenthetical (M)/(N) は monologue/narration に、SFX: 接頭辞は sfx になる", () => {
  const projectId = createTestProject();
  const source = ["INT. A - DAY", "", "@太郎", "(M)", "心の声だ。", "", "@太郎", "SFX: ドカーン"].join("\n");
  const result = createScript(projectId, { fountainSource: source });
  assert.equal(result.lines[0]!.semanticKind, "monologue");
  assert.equal(result.lines[0]!.text, "心の声だ。");
  assert.equal(result.lines[1]!.semanticKind, "sfx");
  assert.equal(result.lines[1]!.text, "ドカーン");
});

test("明示された日英のdelivery拡張とdisplay readoutを分類する", () => {
  const cases = [
    ["男の声（通信）", undefined, "聞こえるか", "telecom"],
    ["ゲン", "（通信）", "命令だ", "telecom"],
    ["ミラ（V.O.）", undefined, "思い出して", "vo"],
    ["男の声（記憶）", undefined, "逃げろ", "vo"],
    ["シドウ（記録）", undefined, "記録を開始", "vo"],
    ["ミラ", "(V.O.)", "思い出して", "vo"],
    ["シドウ", "（記録）", "記録を開始", "vo"],
    ["AEGIS兵（拡声）", undefined, "停止しろ", "telecom"],
    ["機械音声", undefined, "同期完了", "machine"],
    ["表示", undefined, "《同期率 98.7%》", "machine"],
    ["《生命維持限界》", undefined, "《同期率 98.7%》:\n《帰還経路 消失》", "machine"],
    ["CONTROL (V.O.)", undefined, "Stay where you are.", "vo"],
    ["DISPATCH", "(RADIO)", "Unit seven, respond.", "telecom"],
    ["ARCHIVE", "(RECORDING)", "Log entry twelve.", "vo"],
    ["AUTOMATED VOICE", undefined, "Access denied.", "machine"],
    ["MIRA (CONT'D) (V.O.)", undefined, "I remember.", "vo"],
    ["MIRA (V.O., FILTERED)", undefined, "I remember.", "vo"],
    ["DISPATCH", "(RADIO / FILTERED)", "Unit seven, respond.", "telecom"]
  ] as const;
  for (const [speaker, parenthetical, text, expected] of cases) {
    assert.equal(resolveDialoguePresentation(speaker, parenthetical, text).balloonStyle, expected);
  }
});

test("delivery語を名前や本文のsubstringとして含むだけでは画面外発話にしない", () => {
  const cases = [
    ["記録係", undefined, "帳簿を確認します。"],
    ["システム担当者", undefined, "サーバーを直します。"],
    ["アナウンス研究会", undefined, "発表を始めます。"],
    ["通信士", undefined, "私が現場へ行きます。"],
    ["COMPUTER SCIENTIST", undefined, "The model is ready."],
    ["RECORDING ARTIST", undefined, "One more take."],
    ["MIRA (V.O.) ASSISTANT", undefined, "I am on camera."],
    ["ミラ", undefined, "《これは秘密》"],
    ["表示", undefined, "《引用》だと思う。"],
    ["表示", undefined, "《同期率 98.7%》\n状態は安定している。"]
  ] as const;
  for (const [speaker, parenthetical, text] of cases) {
    assert.equal(resolveDialoguePresentation(speaker, parenthetical, text).balloonStyle, "normal", `${speaker}: ${text}`);
  }
});

test("deliveryとvisible-cast根拠を分離し、cue suffixだけを人物名から除く", () => {
  assert.deepEqual(parseSpeakerCue("MIRA (younger) (V.O.)"), {
    identityLabel: "MIRA (younger)",
    delivery: "voice-over"
  });
  assert.equal(dialogueEstablishesVisibleSpeaker({ semanticKind: "dialogue", balloonStyle: "normal" }), true);
  assert.equal(dialogueEstablishesVisibleSpeaker({ semanticKind: "dialogue", balloonStyle: "vo" }), false);
  assert.deepEqual(getDialoguePresentationMeaning({ semanticKind: "dialogue", balloonStyle: "vo" }), {
    delivery: "voice-over",
    visibilityEvidence: "none"
  });
});

test("action/synopsisの人物名は物理的な登場だけをvisible-cast根拠にする", () => {
  const positive = [
    "ミラがコンソールの前で振り返る。",
    "ミラが部屋に入る。",
    "ミラとアリスが立つ。",
    "モニターの横でミラは立ち上がる。",
    "Mira enters the room.",
    "Mira and Alice stand together.",
    "Mira stands in front of the monitor.",
    "Mira crosses the room and opens the door.",
    "Beside the monitor, Mira raises one hand."
  ];
  const nonPhysical = [
    "無線からミラの声が響く。",
    "無線からミラ。",
    "机にはミラの写真が置かれている。",
    "モニターにミラが映る。",
    "記録映像の中でミラが笑っている。",
    "ミラが写真の中で笑っている。",
    "ミラが画像の中で笑っている。",
    "ミラがモニターの中で手を振る。",
    "ミラが鏡の中で立っている。",
    "モニターがミラを映し出す。",
    "ミラの端末だけが点滅する。",
    "ミラからの通信が途切れる。",
    "アリスはミラへ手紙を書く。",
    "ミラは来なかった。",
    "アリスがミラについて話す。",
    "アリスがミラについて、静かに語る。",
    "アリスがミラを思い出す。",
    "アリスがミラを探す。",
    "ミラが来たとアリスは言う。",
    "A photo of Mira rests on the desk.",
    "The monitor shows Mira.",
    "A portrait depicts Mira.",
    "Mira appears on the monitor.",
    "Mira smiles in the photograph.",
    "Mira smiles in the image.",
    "Mira runs in the video.",
    "Mira waves on the monitor.",
    "Mira stands in the reflection.",
    "Mira is heard over the radio.",
    "Mira's notebook lies open.",
    "They hear Mira over the radio.",
    "From the radio: Mira.",
    "Mira is absent from the room.",
    "Alice writes to Mira.",
    "Mira never arrives.",
    "Alice plans to meet Mira tomorrow.",
    "Alice talks about Mira.",
    "Alice talks with Bob about Mira.",
    "Alice remembers Mira.",
    "Alice searches for Mira.",
    "Alice searches the whole building for Mira.",
    "Alice looks at Mira and Bob stands.",
    "Mira enters according to Alice.",
    "According to Alice, Mira enters.",
    "Alice says that Mira enters.",
    "アリスによれば、ミラが来る。"
  ];
  for (const text of positive) assert.equal(actionTextEstablishesVisibleActor(text, ["ミラ", "Mira"]), true, text);
  for (const text of nonPhysical) assert.equal(actionTextEstablishesVisibleActor(text, ["ミラ", "Mira"]), false, text);
  assert.equal(actionTextEstablishesVisibleActor("Mira and Alice stand together.", ["Mira"]), true);
  assert.equal(actionTextEstablishesVisibleActor("Mira and Alice stand together.", ["Alice"]), true);
  assert.equal(actionTextEstablishesVisibleActor("ミラとアリスが立つ。", ["ミラ"]), true);
  assert.equal(actionTextEstablishesVisibleActor("ミラとアリスが立つ。", ["アリス"]), true);
  assert.deepEqual(findVisibleActorEvidence("[[character: Mira]] waits in silence.", ["Mira"])?.kind, "explicit-cast-tag");
  assert.deepEqual(findVisibleActorEvidence("[[cast: Mira]] Mira smiles in the photograph.", ["Mira"])?.kind, "explicit-cast-tag");
  assert.equal(actionTextEstablishesVisibleActor("ミラージュが発進する。", ["ミラ"]), false, "名前の部分一致を許可しない");
});

test("inline V.O. cueは別人物を作らず、通常発話と同じcharacterへ結び付く", () => {
  const projectId = createTestProject();
  const source = [
    "INT. ROOM - NIGHT",
    "",
    "ミラは窓辺に立つ。",
    "",
    "@ミラ",
    "ここにいる。",
    "",
    "@ミラ（V.O.）",
    "あの日を思い出す。"
  ].join("\n");
  const result = createScript(projectId, { fountainSource: source });
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0]!.characterId, result.lines[1]!.characterId);
  assert.equal(result.lines[1]!.speakerLabel, "ミラ（V.O.）", "原文のcue labelは保持する");
  assert.deepEqual(listCharacters(projectId).map((character) => character.name), ["ミラ"]);
});

test("script_revisions は不変保存(fountain_source / parsed_json を後から書き換えない)", () => {
  const projectId = createTestProject();
  const result = createScript(projectId, { fountainSource: SOURCE_V1 });
  const row = getRow<{ fountain_source: string }>("SELECT fountain_source FROM script_revisions WHERE id = ?", [
    result.revision.id
  ]);
  assert.equal(row!.fountain_source, SOURCE_V1);
});
