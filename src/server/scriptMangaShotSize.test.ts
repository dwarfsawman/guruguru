/**
 * 監督LLM無し(heuristic)のコマで寄り引きが散ることを守る。
 *
 * 以前は `direction.shot` が常に空で、全コマが `medium` になっていた。同じ画角が
 * 何十コマも続く plan は漫画として読めないため、コマの構造だけから寄り引きを決める。
 * 単語マッチはしない(作品固有辞書を作らないため)ので、ここで検証するのも構造だけである。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { inferredShotSize } from "./scriptMangaPlanV2.ts";

const shot = (overrides: Partial<Parameters<typeof inferredShotSize>[0]> = {}) =>
  inferredShotSize({
    castCount: 1,
    propCount: 0,
    dialogueChars: 0,
    dialogueCount: 0,
    isNewSetting: false,
    ...overrides
  });

test("場所が変わった最初のコマは、人がいてもいなくても引きにする", () => {
  assert.equal(shot({ isNewSetting: true, castCount: 0 }), "wide");
  assert.equal(shot({ isNewSetting: true, castCount: 1 }), "wide");
  assert.equal(shot({ isNewSetting: true, castCount: 2 }), "wide");
  // 場所が変わった直後は小道具があっても場所を見せる。
  assert.equal(shot({ isNewSetting: true, castCount: 0, propCount: 3 }), "wide");
});

test("人物のいないコマは、小道具があれば insert、無ければ引き", () => {
  assert.equal(shot({ castCount: 0, propCount: 1 }), "insert");
  assert.equal(shot({ castCount: 0, propCount: 0 }), "wide");
});

test("人数が増えるほど引く", () => {
  assert.equal(shot({ castCount: 2 }), "medium");
  assert.equal(shot({ castCount: 3 }), "wide");
  assert.equal(shot({ castCount: 5 }), "wide");
});

test("単独キャラの短い台詞は反応の寄りにする", () => {
  assert.equal(shot({ castCount: 1, dialogueCount: 1, dialogueChars: 6 }), "close-up");
  assert.equal(shot({ castCount: 1, dialogueCount: 1, dialogueChars: 24 }), "close-up");
});

test("台詞が長いコマ、無言のコマは寄らない", () => {
  assert.equal(shot({ castCount: 1, dialogueCount: 1, dialogueChars: 25 }), "medium");
  assert.equal(shot({ castCount: 1, dialogueCount: 2, dialogueChars: 80 }), "medium");
  // 無言の演技コマは寄りではなく medium(表情だけに寄せると動作が読めなくなる)。
  assert.equal(shot({ castCount: 1, dialogueCount: 0, dialogueChars: 0 }), "medium");
});

test("同じ入力からは同じ結果になる(決定的)", () => {
  const input = { castCount: 1, propCount: 2, dialogueChars: 10, dialogueCount: 1, isNewSetting: false };
  assert.equal(inferredShotSize(input), inferredShotSize(input));
});

test("実際の脚本に近い並びで、画角が1種類に固まらない", () => {
  // 場面転換 → 無言の小道具 → 短い応酬 → 二人 → 群衆、という普通の流れ。
  const sequence = [
    shot({ isNewSetting: true, castCount: 1 }),
    shot({ castCount: 0, propCount: 1 }),
    shot({ castCount: 1, dialogueCount: 1, dialogueChars: 5 }),
    shot({ castCount: 1, dialogueCount: 1, dialogueChars: 40 }),
    shot({ castCount: 2, dialogueCount: 2, dialogueChars: 30 }),
    shot({ castCount: 4, dialogueCount: 1, dialogueChars: 8 })
  ];
  assert.deepEqual(sequence, ["wide", "insert", "close-up", "medium", "medium", "wide"]);
  assert.ok(new Set(sequence).size >= 4, `画角が散っていない: ${sequence.join(",")}`);
});
