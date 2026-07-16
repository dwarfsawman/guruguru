import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "../shared/fountain.ts";
import { buildPreLayoutUnits, fallbackBeatAnnotation, type AnnotatedBeat } from "../shared/preLayoutBeat.ts";
import { planScriptManga } from "../shared/scriptMangaPlan.ts";
import { applyBeatPageNaming, type BeatPageNamingContext } from "./scriptMangaPageNaming.ts";

const SCRIPT = `INT. LAB - NIGHT

箱を開ける。中には写真がある。

@ALICE
これは……私?

@BOB
落ち着いて聞いてくれ。
`;

function context(overrides: Partial<BeatPageNamingContext> = {}): BeatPageNamingContext {
  const doc = parseFountain(SCRIPT).doc;
  const units = buildPreLayoutUnits(doc);
  return {
    title: "Test",
    units,
    beats: fallbackBeatAnnotation(units),
    targetPageCount: 1,
    ...overrides
  };
}

test("applyBeatPageNaming: 同一要素のspanを別コマへ分割でき、台詞契約とsource追跡が保たれる", () => {
  const ctx = context();
  const doc = parseFountain(SCRIPT).doc;
  // fallback注釈は要素単位なので、spanを分けるためにspan単位の注釈を作る。
  const spanBeats: AnnotatedBeat[] = ctx.units.map((unit, index) => ({
    id: `b${index + 1}`,
    unitIds: [unit.id],
    kind: "action",
    preferredScale: "medium",
    importance: 0.5,
    pageTurnAffinity: 0,
    keepAlone: false,
    desiredScale: "normal"
  }));
  const result = applyBeatPageNaming({ pages: [{
    index: 0, pageIntent: "open the box", turnHook: "reveal", panels: [
      { id: "p1", importance: "normal", sourceBeatIds: ["b1"] },
      { id: "p2", importance: "hero", sourceBeatIds: ["b2"] },
      { id: "p3", importance: "normal", sourceBeatIds: ["b3", "b4"] }
    ]
  }] }, { ...ctx, beats: spanBeats });
  assert.ok(result);
  const [page] = result!.pages;
  assert.equal(page!.panels.length, 3);
  // span分割: p1/p2 は同じ element id を持つ(重複保持)。
  assert.deepEqual(page!.panels[0]!.sourceElementIds, page!.panels[1]!.sourceElementIds);
  assert.equal(page!.panels[0]!.sourceText, "箱を開ける。");
  assert.equal(page!.panels[1]!.sourceText, "中には写真がある。");
  // 台詞は一度ずつ。
  assert.deepEqual(page!.panels[2]!.dialogueOrderIndexes, [0, 1]);
  assert.equal(result!.dialogueCount, planScriptManga(doc).dialogueCount);
  // importance/turnHook/レイアウト事前選択(hero@読み順2 → 右縦大ゴマ)。
  assert.equal(page!.turnHook, "reveal");
  assert.deepEqual(page!.panels.map((panel) => panel.importance), ["normal", "hero", "normal"]);
  assert.equal(page!.layoutTemplateId, "builtin:three-side-hero");
  assert.deepEqual(page!.panels[1]!.sourceBeatIds, ["b2"]);
});

test("applyBeatPageNaming: 被覆・順序・シーン純度・splash単独・台詞量上限を検証する", () => {
  const ctx = context();
  const beatIds = ctx.beats.map((beat) => beat.id);
  const page = (panels: Array<{ id: string; importance: string; sourceBeatIds: string[] }>) =>
    ({ pages: [{ index: 0, pageIntent: "x", turnHook: "none", panels }] });
  // 全ビート被覆
  assert.equal(applyBeatPageNaming(page([{ id: "p1", importance: "normal", sourceBeatIds: [beatIds[0]!] }]), ctx), null);
  // 順序違反
  assert.equal(applyBeatPageNaming(page([
    { id: "p1", importance: "normal", sourceBeatIds: [...beatIds].reverse() }
  ]), ctx), null);
  // 未知ビート
  assert.equal(applyBeatPageNaming(page([
    { id: "p1", importance: "normal", sourceBeatIds: [...beatIds, "ghost"] }
  ]), ctx), null);
  // splashは単独ページのみ
  assert.equal(applyBeatPageNaming(page([
    { id: "p1", importance: "splash", sourceBeatIds: [beatIds[0]!] },
    { id: "p2", importance: "normal", sourceBeatIds: beatIds.slice(1) }
  ]), ctx), null);
  // 正常(1コマに全ビート: シーンは1つなので通る)
  assert.ok(applyBeatPageNaming(page([{ id: "p1", importance: "normal", sourceBeatIds: beatIds }]), ctx));
});

test("applyBeatPageNaming: コマ内台詞文字量の上限を超えるコマは拒否する", () => {
  const longLine = "この台詞はとても長い。".repeat(6); // 66字 > 下限40字
  const doc = parseFountain(`INT. A - DAY\n\n@ALICE\n${longLine}`).doc;
  const units = buildPreLayoutUnits(doc);
  const beats = fallbackBeatAnnotation(units);
  const ctx: BeatPageNamingContext = { title: "T", units, beats, targetPageCount: 1, maxDialogueCharactersPerPanel: 40 };
  const raw = { pages: [{ index: 0, pageIntent: "x", turnHook: "none", panels: [
    { id: "p1", importance: "normal", sourceBeatIds: beats.map((beat) => beat.id) }
  ] }] };
  assert.equal(applyBeatPageNaming(raw, ctx), null);
  assert.ok(applyBeatPageNaming(raw, { ...ctx, maxDialogueCharactersPerPanel: 200 }));
});

test("applyBeatPageNaming: シーンを跨ぐコマは拒否する", () => {
  const doc = parseFountain("INT. A - DAY\n\nOne.\n\nINT. B - NIGHT\n\nTwo.").doc;
  const units = buildPreLayoutUnits(doc);
  const beats = fallbackBeatAnnotation(units);
  const ctx: BeatPageNamingContext = { title: "T", units, beats, targetPageCount: 1 };
  assert.equal(applyBeatPageNaming({ pages: [{ index: 0, pageIntent: "x", turnHook: "none", panels: [
    { id: "p1", importance: "normal", sourceBeatIds: beats.map((beat) => beat.id) }
  ] }] }, ctx), null);
  assert.ok(applyBeatPageNaming({ pages: [{ index: 0, pageIntent: "x", turnHook: "none", panels: [
    { id: "p1", importance: "normal", sourceBeatIds: [beats[0]!.id] },
    { id: "p2", importance: "normal", sourceBeatIds: [beats[1]!.id] }
  ] }] }, ctx));
});
