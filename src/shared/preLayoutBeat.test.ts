import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "./fountain.ts";
import {
  buildPreLayoutUnits,
  fallbackBeatAnnotation,
  sentenceSpans,
  validateBeatAnnotation
} from "./preLayoutBeat.ts";
import { planScriptManga } from "./scriptMangaPlan.ts";

test("sentenceSpans: span連結は原文と一致し(往復不変)、終端記号・閉じ括弧・空白は前の文に付く", () => {
  const cases = [
    "箱を開ける。中には写真がある。",
    "「開けるな!」と叫んだ。だが遅かった…",
    "One line\nSecond line ends? Yes!  Trailing",
    "終端なしの文",
    "記号だけ。。!?\n\n次の行",
    ""
  ];
  for (const text of cases) {
    const spans = sentenceSpans(text);
    assert.equal(spans.map(([start, end]) => text.slice(start, end)).join(""), text, JSON.stringify(text));
    for (let index = 1; index < spans.length; index += 1) {
      assert.equal(spans[index]![0], spans[index - 1]![1], "spanは隙間なく連続する");
    }
  }
  assert.deepEqual(
    sentenceSpans("箱を開ける。中には写真がある。").map(([s, e]) => "箱を開ける。中には写真がある。".slice(s, e)),
    ["箱を開ける。", "中には写真がある。"]
  );
});

const SCRIPT = `INT. LAB - NIGHT

箱を開ける。中には写真がある。

@ALICE
これは……私?

@BOB
(囁き)
落ち着いて聞いてくれ。

INT. HALL - NIGHT

二人は走り出す。
`;

test("buildPreLayoutUnits: dialogueは1unit、actionは文span、採番はplanScriptMangaと一致", () => {
  const doc = parseFountain(SCRIPT).doc;
  const units = buildPreLayoutUnits(doc);
  const dialogueUnits = units.filter((unit) => unit.type === "dialogue");
  assert.equal(dialogueUnits.length, planScriptManga(doc).dialogueCount);
  assert.deepEqual(dialogueUnits.map((unit) => unit.dialogueOrderIndex), [0, 1]);
  const spanUnits = units.filter((unit) => unit.spanIndex !== null);
  assert.equal(spanUnits.length, 2, "2文のactionは2つのspan unitになる");
  assert.deepEqual(spanUnits.map((unit) => unit.text), ["箱を開ける。", "中には写真がある。"]);
  assert.ok(spanUnits.every((unit) => unit.elementId === spanUnits[0]!.elementId));
  assert.ok(spanUnits[0]!.id.endsWith(":s0") && spanUnits[1]!.id.endsWith(":s1"));
  const single = units.find((unit) => unit.text === "二人は走り出す。");
  assert.ok(single, "1文のactionは要素全体unit");
  assert.equal(single!.spanIndex, null);
  assert.equal(units.find((unit) => unit.speaker === "ALICE")!.dialogueCharacters, "これは……私?".length);
});

test("validateBeatAnnotation: 被覆・順序・シーン純度・enumを決定的に検証する", () => {
  const doc = parseFountain(SCRIPT).doc;
  const units = buildPreLayoutUnits(doc);
  const ids = units.map((unit) => unit.id);
  const good = {
    beats: [
      { id: "b1", unitIds: [ids[0]!], kind: "setup", importance: 0.4, pageTurnAffinity: 0.1, keepAlone: false, desiredScale: "normal" },
      { id: "b2", unitIds: [ids[1]!, ids[2]!], kind: "reveal", importance: 0.9, pageTurnAffinity: 0.8, keepAlone: true, desiredScale: "hero" },
      { id: "b3", unitIds: [ids[3]!], kind: "reaction", importance: 0.5, pageTurnAffinity: 0.2, keepAlone: false, desiredScale: "normal" },
      { id: "b4", unitIds: [ids[4]!], kind: "action", importance: 0.6, pageTurnAffinity: 0.4, keepAlone: false, desiredScale: "normal" }
    ]
  };
  const validated = validateBeatAnnotation(good, units);
  assert.ok(validated);
  assert.equal(validated!.length, 4);
  // 欠落
  assert.equal(validateBeatAnnotation({ beats: good.beats.slice(0, 3) }, units), null);
  // 順序違反
  assert.equal(validateBeatAnnotation({ beats: [good.beats[1], good.beats[0], good.beats[2], good.beats[3]] }, units), null);
  // シーン跨ぎ(b4のunitはシーン1、b3のunitはシーン0)
  assert.equal(validateBeatAnnotation({ beats: [good.beats[0], good.beats[1], {
    ...good.beats[2]!, unitIds: [ids[3]!, ids[4]!]
  }] }, units), null);
  // enum違反
  assert.equal(validateBeatAnnotation({ beats: [{ ...good.beats[0]!, kind: "montage" }, ...good.beats.slice(1)] }, units), null);
});

test("fallbackBeatAnnotation: 1要素=1ビート(spanは元要素へ束ね直し)、常に検証を通る", () => {
  const doc = parseFountain(SCRIPT).doc;
  const units = buildPreLayoutUnits(doc);
  const beats = fallbackBeatAnnotation(units);
  assert.equal(beats.length, 4, "action(2span→1) + 台詞2 + action1");
  assert.ok(beats.every((beat) => beat.kind === "action"));
  assert.ok(validateBeatAnnotation({ beats }, units));
  assert.deepEqual(beats[0]!.unitIds.length, 2, "同一要素のspanは1ビートに束ねる");
});
