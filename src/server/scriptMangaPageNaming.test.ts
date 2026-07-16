import test from "node:test";
import assert from "node:assert/strict";
import { parseFountain } from "../shared/fountain.ts";
import { buildPreLayoutUnits, type AnnotatedBeat, type PreLayoutUnit } from "../shared/preLayoutBeat.ts";
import {
  applyBeatPageNaming,
  createBeatPageNamingSchema,
  packAnnotatedBeatsDeterministically
} from "./scriptMangaPageNaming.ts";

function mkBeat(id: string, unitIds: string[], overrides: Partial<AnnotatedBeat> = {}): AnnotatedBeat {
  return {
    id,
    unitIds,
    kind: "action",
    preferredScale: "medium",
    importance: 0.5,
    pageTurnAffinity: 0,
    keepAlone: false,
    desiredScale: "normal",
    ...overrides
  };
}

function unitBeats(units: readonly PreLayoutUnit[], prefix = "beat"): AnnotatedBeat[] {
  return units.map((unit, index) => mkBeat(`${prefix}-${index + 1}`, [unit.id]));
}

/** ちょうど一度ずつ・順序保存の unit 被覆(パッカーの根本契約)。 */
function assertUnitCoverage(plan: { pages: Array<{ panels: Array<{ dialogueOrderIndexes: number[] }> }> }, units: readonly PreLayoutUnit[]) {
  const expected = units.filter((unit) => unit.type === "dialogue").map((unit) => unit.dialogueOrderIndex!);
  const observed = plan.pages.flatMap((page) => page.panels.flatMap((panel) => panel.dialogueOrderIndexes));
  assert.deepEqual(observed, expected);
}

test("applyBeatPageNaming: importance/turnHook を保持し、hero×強調スロットのレイアウトを事前選択する", () => {
  const doc = parseFountain("INT. A - DAY\n\nOne.\n\nTwo.\n\nThree.").doc;
  const units = buildPreLayoutUnits(doc);
  const beats = unitBeats(units);
  const result = applyBeatPageNaming({ pages: [{ index: 0, pageIntent: "hero top", turnHook: "cliffhanger", panels: [
    { id: "p1", importance: "hero", sourceBeatIds: [beats[0]!.id] },
    { id: "p2", importance: "normal", sourceBeatIds: [beats[1]!.id] },
    { id: "p3", importance: "normal", sourceBeatIds: [beats[2]!.id] }
  ] }] }, { title: "T", units, beats, targetPageCount: 1 });
  assert.ok(result);
  assert.deepEqual(result!.pages[0]!.panels.map((panel) => panel.importance), ["hero", "normal", "normal"]);
  assert.deepEqual(result!.pages[0]!.panels.map((panel) => panel.visualScale), ["large", "medium", "medium"]);
  assert.equal(result!.pages[0]!.turnHook, "cliffhanger");
  assert.equal(result!.pages[0]!.layoutTemplateId, "builtin:three-hero-top");
});

test("applyBeatPageNaming: splash は splash-bleed、全normal単独は候補先頭(既定互換)", () => {
  const doc = parseFountain("INT. A - DAY\n\nOne.\n\nTwo.").doc;
  const units = buildPreLayoutUnits(doc);
  const beats = [
    mkBeat("b1", [units[0]!.id], { preferredScale: "splash", keepAlone: true }),
    mkBeat("b2", [units[1]!.id])
  ];
  const result = applyBeatPageNaming({ pages: [
    { index: 0, pageIntent: "impact", turnHook: "none", panels: [{ id: "s", importance: "splash", sourceBeatIds: ["b1"] }] },
    { index: 1, pageIntent: "cool down", turnHook: "none", panels: [{ id: "n", importance: "normal", sourceBeatIds: ["b2"] }] }
  ] }, { title: "T", units, beats, targetPageCount: 2 });
  assert.ok(result);
  assert.equal(result!.pages[0]!.layoutTemplateId, "builtin:splash-bleed");
  assert.equal(result!.pages[1]!.layoutTemplateId, "builtin:splash");
});

test("applyBeatPageNaming: 順序逆転・シーン跨ぎ・keepAlone同居・large複数束ねを拒否する", () => {
  const doc = parseFountain("INT. A - DAY\n\nOne.\n\nINT. B - NIGHT\n\nTwo.").doc;
  const units = buildPreLayoutUnits(doc);
  const beats = unitBeats(units);
  const context = { title: "T", units, beats, targetPageCount: 1 };
  // 順序逆転
  assert.equal(applyBeatPageNaming({ pages: [{ index: 0, pageIntent: "bad", turnHook: "none", panels: [
    { id: "bad", importance: "normal", sourceBeatIds: [beats[1]!.id, beats[0]!.id] }
  ] }] }, context), null);
  // シーン跨ぎ(異なるsceneのビートを1コマへ)
  assert.equal(applyBeatPageNaming({ pages: [{ index: 0, pageIntent: "bad", turnHook: "none", panels: [
    { id: "mixed", importance: "normal", sourceBeatIds: beats.map((beat) => beat.id) }
  ] }] }, context), null);

  const sameSceneDoc = parseFountain("INT. A - DAY\n\nOne.\n\nTwo.").doc;
  const sameUnits = buildPreLayoutUnits(sameSceneDoc);
  // keepAlone 同居
  const keepAloneBeats = [mkBeat("k1", [sameUnits[0]!.id], { keepAlone: true }), mkBeat("k2", [sameUnits[1]!.id])];
  assert.equal(applyBeatPageNaming({ pages: [{ index: 0, pageIntent: "bad", turnHook: "none", panels: [
    { id: "ka", importance: "normal", sourceBeatIds: ["k1", "k2"] }
  ] }] }, { title: "T", units: sameUnits, beats: keepAloneBeats, targetPageCount: 1 }), null);
  // large希望を1コマへ複数
  const largeBeats = [
    mkBeat("l1", [sameUnits[0]!.id], { preferredScale: "large" }),
    mkBeat("l2", [sameUnits[1]!.id], { preferredScale: "large" })
  ];
  assert.equal(applyBeatPageNaming({ pages: [{ index: 0, pageIntent: "bad", turnHook: "none", panels: [
    { id: "ll", importance: "hero", sourceBeatIds: ["l1", "l2"] }
  ] }] }, { title: "T", units: sameUnits, beats: largeBeats, targetPageCount: 1 }), null);
});

test("applyBeatPageNaming: 台詞数capは有効、単独台詞コマは文字量capの適用除外(V5充足保証)", () => {
  const longLine = "あ".repeat(400);
  const doc = parseFountain(["INT. A - DAY", "", "@ALICE", "First.", "", "@BOB", "Second."].join("\n")).doc;
  const units = buildPreLayoutUnits(doc);
  const beats = unitBeats(units);
  const merged = { pages: [{ index: 0, pageIntent: "exchange", turnHook: "none", panels: [
    { id: "merged", importance: "normal", sourceBeatIds: beats.map((beat) => beat.id) }
  ] }] };
  const context = { title: "T", units, beats, targetPageCount: 1 };
  assert.equal(applyBeatPageNaming(merged, { ...context, maxDialoguesPerPanel: 1 }), null);
  assert.ok(applyBeatPageNaming(merged, { ...context, maxDialoguesPerPanel: 2 }));

  const longDoc = parseFountain(["INT. A - DAY", "", "@ALICE", longLine].join("\n")).doc;
  const longUnits = buildPreLayoutUnits(longDoc);
  const longBeats = unitBeats(longUnits, "long");
  const single = { pages: [{ index: 0, pageIntent: "monologue", turnHook: "none", panels: [
    { id: "solo", importance: "normal", sourceBeatIds: [longBeats[0]!.id] }
  ] }] };
  assert.ok(
    applyBeatPageNaming(single, { title: "T", units: longUnits, beats: longBeats, targetPageCount: 1, maxDialogueCharactersPerPanel: 260 }),
    "単独台詞コマは原子unitなのでcap超過でも合法"
  );
});

test("applyBeatPageNaming/schema: panelsPerPage 上限をスキーマとバリデータの両方で強制する", () => {
  assert.equal(createBeatPageNamingSchema(2).properties.pages.items.properties.panels.maxItems, 2);
  const doc = parseFountain("INT. A - DAY\n\nOne.\n\nTwo.\n\nThree.").doc;
  const units = buildPreLayoutUnits(doc);
  const beats = unitBeats(units, "panel-limit-beat");
  const named = { pages: [{ index: 0, pageIntent: "three beats", turnHook: "none", panels: beats.map((beat, index) => ({
    id: `beat-panel-${index + 1}`, importance: "normal", sourceBeatIds: [beat.id]
  })) }] };
  const context = { title: "Panel limit", units, beats, targetPageCount: 1 };
  assert.equal(applyBeatPageNaming(named, { ...context, maxPanelsPerPage: 2 }), null);
  assert.ok(applyBeatPageNaming(named, { ...context, maxPanelsPerPage: 3 }));
});

// --- packAnnotatedBeatsDeterministically(V5 D2) ---

test("packer: 全unitを一度ずつ順序保存で被覆し、ビート情報からスケール/レイアウトを決める", () => {
  const doc = parseFountain([
    "INT. A - DAY",
    "",
    "One.",
    "",
    "@ALICE",
    "Hello there.",
    "",
    "Two.",
    "",
    "@BOB",
    "Reply."
  ].join("\n")).doc;
  const units = buildPreLayoutUnits(doc);
  const beats = unitBeats(units);
  beats[1] = { ...beats[1]!, preferredScale: "large" };
  const plan = packAnnotatedBeatsDeterministically({ units, beats, title: "Packed" });
  assert.equal(plan.title, "Packed");
  assert.ok(plan.pages.length >= 1);
  assertUnitCoverage(plan, units);
  const flatPanels = plan.pages.flatMap((page) => page.panels);
  assert.equal(plan.panelCount, flatPanels.length);
  const largePanel = flatPanels.find((panel) => panel.visualScale === "large");
  assert.ok(largePanel, "largeビートを含むコマは large へ解決される");
  assert.equal(largePanel!.importance, "hero");
  for (const page of plan.pages) assert.ok(page.layoutTemplateId, "各ページにレイアウトが選択される");
});

test("packer: keepAloneは単独コマ、splashは単独コマ・単独ページ(splash系レイアウト)", () => {
  const doc = parseFountain("INT. A - DAY\n\nOne.\n\nTwo.\n\nThree.").doc;
  const units = buildPreLayoutUnits(doc);
  const beats = [
    mkBeat("b1", [units[0]!.id]),
    mkBeat("b2", [units[1]!.id], { preferredScale: "splash", keepAlone: true }),
    mkBeat("b3", [units[2]!.id])
  ];
  const plan = packAnnotatedBeatsDeterministically({ units, beats, title: "T" });
  assertUnitCoverage(plan, units);
  const splashPage = plan.pages.find((page) => page.panels.some((panel) => panel.visualScale === "splash"));
  assert.ok(splashPage);
  assert.equal(splashPage!.panels.length, 1, "splashは単独ページ");
  assert.deepEqual(splashPage!.panels[0]!.sourceBeatIds, ["b2"]);
});

test("packer: capを超えるビートは連続コマへ分割し、sourceBeatIdsを連続重複で保持する", () => {
  const doc = parseFountain([
    "INT. A - DAY",
    "",
    "@ALICE",
    "L1.",
    "",
    "@BOB",
    "L2.",
    "",
    "@ALICE",
    "L3."
  ].join("\n")).doc;
  const units = buildPreLayoutUnits(doc);
  const bigBeat = mkBeat("big", units.map((unit) => unit.id));
  const plan = packAnnotatedBeatsDeterministically({ units, beats: [bigBeat], title: "T", maxDialoguesPerPanel: 1 });
  assertUnitCoverage(plan, units);
  const flatPanels = plan.pages.flatMap((page) => page.panels);
  assert.equal(flatPanels.length, 3, "台詞3つ×cap1 → 3コマへ分割");
  for (const panel of flatPanels) assert.deepEqual(panel.sourceBeatIds, ["big"], "分割コマは同じビートidを連続保持");
});

test("packer: 単独でcap超過する台詞unitは1台詞コマとして合法(生成が止まらない)", () => {
  const longLine = "あ".repeat(500);
  const doc = parseFountain(["INT. A - DAY", "", "@ALICE", longLine, "", "@BOB", "Short."].join("\n")).doc;
  const units = buildPreLayoutUnits(doc);
  const beats = [mkBeat("big", units.map((unit) => unit.id))];
  const plan = packAnnotatedBeatsDeterministically({ units, beats, title: "T", maxDialogueCharactersPerPanel: 260 });
  assertUnitCoverage(plan, units);
  const overCapPanel = plan.pages.flatMap((page) => page.panels).find((panel) =>
    panel.dialogueOrderIndexes.length === 1 && panel.sourceText.includes(longLine)
  );
  assert.ok(overCapPanel, "cap超過台詞は単独コマとして残る");
});

test("packer: 1ページのlargeコマは2つまで、targetPageCountは密度の目安として効く", () => {
  const lines = ["INT. A - DAY", ""];
  for (let index = 0; index < 8; index += 1) lines.push(`Action ${index + 1}.`, "");
  const doc = parseFountain(lines.join("\n")).doc;
  const units = buildPreLayoutUnits(doc);
  const beats = unitBeats(units).map((beat) => ({ ...beat, preferredScale: "large" as const }));
  const plan = packAnnotatedBeatsDeterministically({ units, beats, title: "T" });
  assertUnitCoverage(plan, units);
  for (const page of plan.pages) {
    assert.ok(page.panels.filter((panel) => panel.visualScale === "large").length <= 2, "large/pageは2つまで");
  }
  const mediumBeats = unitBeats(units);
  const dense = packAnnotatedBeatsDeterministically({ units, beats: mediumBeats, title: "T", targetPageCount: 2 });
  assert.ok(dense.pages.length <= 4, "目安に寄せて詰める(hard capはpanelLimitのみ)");
  const loose = packAnnotatedBeatsDeterministically({ units, beats: mediumBeats, title: "T", targetPageCount: 8 });
  assert.ok(loose.pages.length >= dense.pages.length, "目標が多いほどページも増える");
});

test("packer: 空入力は明示エラー(上流の空スクリプト縮退経路が扱う)", () => {
  assert.throws(() => packAnnotatedBeatsDeterministically({ units: [], beats: [], title: "T" }));
});
