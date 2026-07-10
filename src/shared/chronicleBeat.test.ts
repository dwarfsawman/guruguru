import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBeatPreview, buildChronicleBeats, computeBeatState, BEAT_MAX_CHARS, BEAT_MAX_LINES } from "./chronicleBeat.ts";
import type { DialogueLine } from "./apiTypes.ts";
import type { ChroniclePageSummary, ChronicleLineSummary } from "./chronicle.ts";

function makeLine(overrides: Partial<DialogueLine> & Pick<DialogueLine, "id" | "orderIndex">): DialogueLine {
  return {
    projectId: "project_1",
    scriptId: "script_1",
    characterId: null,
    speakerLabel: "太郎",
    text: "テスト",
    semanticKind: "dialogue",
    emotion: null,
    sceneIndex: 0,
    sourceHash: null,
    status: "active",
    source: "fountain",
    proposalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

test("buildChronicleBeats: 同一シーンの連続 dialogue/monologue は1つの Beat にまとまる", () => {
  const lines = [
    makeLine({ id: "l1", orderIndex: 0, speakerLabel: "太郎", text: "おはよう" }),
    makeLine({ id: "l2", orderIndex: 1, speakerLabel: "花子", text: "おはよう、太郎" }),
    makeLine({ id: "l3", orderIndex: 2, speakerLabel: "太郎", semanticKind: "monologue", text: "元気そうだ" })
  ];
  const beats = buildChronicleBeats(lines, "rev_1");
  assert.equal(beats.length, 1);
  assert.deepEqual(beats[0]!.lineIds, ["l1", "l2", "l3"]);
  assert.equal(beats[0]!.startOrder, 0);
  assert.equal(beats[0]!.endOrder, 2);
  assert.deepEqual(beats[0]!.speakerIds.sort(), ["太郎", "花子"].sort());
});

test("buildChronicleBeats: scene_index の境界で分割される", () => {
  const lines = [
    makeLine({ id: "l1", orderIndex: 0, sceneIndex: 0 }),
    makeLine({ id: "l2", orderIndex: 1, sceneIndex: 1 })
  ];
  const beats = buildChronicleBeats(lines, "rev_1");
  assert.equal(beats.length, 2);
  assert.deepEqual(beats[0]!.lineIds, ["l1"]);
  assert.deepEqual(beats[1]!.lineIds, ["l2"]);
});

test("buildChronicleBeats: narration/sfx は単独 Beat になり周囲の dialogue とまとめない", () => {
  const lines = [
    makeLine({ id: "l1", orderIndex: 0, semanticKind: "dialogue", text: "おはよう" }),
    makeLine({ id: "l2", orderIndex: 1, semanticKind: "narration", text: "太陽が昇る" }),
    makeLine({ id: "l3", orderIndex: 2, semanticKind: "sfx", text: "ドカーン" }),
    makeLine({ id: "l4", orderIndex: 3, semanticKind: "dialogue", text: "おはよう" })
  ];
  const beats = buildChronicleBeats(lines, "rev_1");
  assert.equal(beats.length, 4);
  assert.equal(beats[1]!.label, "ナレーション");
  assert.equal(beats[2]!.label, "SFX");
});

test("buildChronicleBeats: 発話数が上限(6)を超えると分割される", () => {
  const lines = Array.from({ length: BEAT_MAX_LINES + 2 }, (_, i) =>
    makeLine({ id: `l${i}`, orderIndex: i, text: "短い" })
  );
  const beats = buildChronicleBeats(lines, "rev_1");
  assert.equal(beats.length, 2);
  assert.equal(beats[0]!.lineIds.length, BEAT_MAX_LINES);
  assert.equal(beats[1]!.lineIds.length, 2);
});

test("buildChronicleBeats: 文字数が上限(120字)を超えると分割される", () => {
  const longText = "あ".repeat(80);
  const lines = [
    makeLine({ id: "l1", orderIndex: 0, text: longText }),
    makeLine({ id: "l2", orderIndex: 1, text: longText }),
    makeLine({ id: "l3", orderIndex: 2, text: "短い" })
  ];
  const beats = buildChronicleBeats(lines, "rev_1");
  assert.ok(beats.length >= 2);
  assert.equal(beats[0]!.lineIds.length, 1);
  const totalCharsInFirst = beats[0]!.lineIds.length * longText.length;
  assert.ok(totalCharsInFirst <= BEAT_MAX_CHARS);
});

test("buildChronicleBeats: 決定的な id(同一入力→同一 id)", () => {
  const lines = [makeLine({ id: "l1", orderIndex: 0 })];
  const beatsA = buildChronicleBeats(lines, "rev_1");
  const beatsB = buildChronicleBeats(lines, "rev_1");
  assert.equal(beatsA[0]!.id, beatsB[0]!.id);
  const beatsOtherRevision = buildChronicleBeats(lines, "rev_2");
  assert.notEqual(beatsA[0]!.id, beatsOtherRevision[0]!.id);
});

test("buildChronicleBeats: order_index 順が壊れた入力でも並び替えてから構築する", () => {
  const lines = [
    makeLine({ id: "l2", orderIndex: 1, sceneIndex: 0 }),
    makeLine({ id: "l1", orderIndex: 0, sceneIndex: 0 })
  ];
  const beats = buildChronicleBeats(lines, "rev_1");
  assert.equal(beats.length, 1);
  assert.deepEqual(beats[0]!.lineIds, ["l1", "l2"]);
});

function summaryFor(
  lineId: string,
  options: Partial<ChronicleLineSummary> = {}
): ChronicleLineSummary {
  return {
    lineId,
    status: "active",
    orderIndex: 0,
    sceneIndex: 0,
    speakerLabel: "太郎",
    text: "テスト",
    semanticKind: "dialogue",
    placements: [],
    ...options
  };
}

test("buildBeatPreview: 配置先ページの pageIndex を lines/pages から逆引きする", () => {
  const beat = buildChronicleBeats(
    [makeLine({ id: "l1", orderIndex: 0, speakerLabel: "太郎", text: "やあ" })],
    "rev_1"
  )[0]!;
  const summaries = new Map([["l1", summaryFor("l1", { speakerLabel: "太郎", text: "やあ" })]]);
  const pages: ChroniclePageSummary[] = [{ pageId: "page_1", pageIndex: 2, lineIds: ["l1"] }];
  const preview = buildBeatPreview(beat, summaries, pages);
  assert.equal(preview.beatId, beat.id);
  assert.equal(preview.lines.length, 1);
  assert.equal(preview.lines[0]!.pageIndex, 2);
  assert.equal(preview.lines[0]!.speakerLabel, "太郎");
  assert.equal(preview.lines[0]!.text, "やあ");
});

test("buildBeatPreview: 未配置行は pageIndex が null", () => {
  const beat = buildChronicleBeats([makeLine({ id: "l1", orderIndex: 0 })], "rev_1")[0]!;
  const summaries = new Map([["l1", summaryFor("l1")]]);
  const preview = buildBeatPreview(beat, summaries, []);
  assert.equal(preview.lines[0]!.pageIndex, null);
});

test("computeBeatState: placement が無い行を含む場合は unassigned", () => {
  const beat = buildChronicleBeats([makeLine({ id: "l1", orderIndex: 0 })], "rev_1")[0]!;
  const summaries = new Map([[ "l1", summaryFor("l1") ]]);
  const result = computeBeatState(beat, summaries, "page_1");
  assert.equal(result.status, "unassigned");
});

test("computeBeatState: 現在ページに全行 placement 有り・balloon 無しは assigned", () => {
  const beat = buildChronicleBeats([makeLine({ id: "l1", orderIndex: 0 })], "rev_1")[0]!;
  const summaries = new Map([
    ["l1", summaryFor("l1", { placements: [{ id: "place_1", pageId: "page_1", balloonObjectId: null }] })]
  ]);
  const result = computeBeatState(beat, summaries, "page_1");
  assert.equal(result.status, "assigned");
});

test("computeBeatState: 現在ページに全行 balloon 有りは materialized", () => {
  const beat = buildChronicleBeats([makeLine({ id: "l1", orderIndex: 0 })], "rev_1")[0]!;
  const summaries = new Map([
    ["l1", summaryFor("l1", { placements: [{ id: "place_1", pageId: "page_1", balloonObjectId: "obj_1" }] })]
  ]);
  const result = computeBeatState(beat, summaries, "page_1");
  assert.equal(result.status, "materialized");
});

test("computeBeatState: 現在ページ以外にのみ配置された行を含む場合は otherPage", () => {
  const beat = buildChronicleBeats([makeLine({ id: "l1", orderIndex: 0 })], "rev_1")[0]!;
  const summaries = new Map([
    ["l1", summaryFor("l1", { placements: [{ id: "place_1", pageId: "page_2", balloonObjectId: null }] })]
  ]);
  const result = computeBeatState(beat, summaries, "page_1");
  assert.equal(result.status, "otherPage");
});

test("computeBeatState: 削除済み(orphaned)行を含む場合は orphaned が最優先", () => {
  const beat = buildChronicleBeats([makeLine({ id: "l1", orderIndex: 0 })], "rev_1")[0]!;
  const summaries = new Map([
    [
      "l1",
      summaryFor("l1", {
        status: "orphaned",
        placements: [{ id: "place_1", pageId: "page_1", balloonObjectId: "obj_1" }]
      })
    ]
  ]);
  const result = computeBeatState(beat, summaries, "page_1");
  assert.equal(result.status, "orphaned");
});
