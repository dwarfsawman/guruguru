import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp, clampNumber, formatSvgNumber, isFiniteNumber } from "./numbers.ts";

test("isFiniteNumber: 有限数のみ true", () => {
  assert.equal(isFiniteNumber(0), true);
  assert.equal(isFiniteNumber(-1.5), true);
  assert.equal(isFiniteNumber(Number.NaN), false);
  assert.equal(isFiniteNumber(Number.POSITIVE_INFINITY), false);
  assert.equal(isFiniteNumber("1"), false);
  assert.equal(isFiniteNumber(null), false);
  assert.equal(isFiniteNumber(undefined), false);
});

test("clampNumber: 範囲内はそのまま、範囲外はクランプ、非数は fallback", () => {
  assert.equal(clampNumber(0.5, 0, 1, 0.3), 0.5);
  assert.equal(clampNumber(-2, 0, 1, 0.3), 0);
  assert.equal(clampNumber(2, 0, 1, 0.3), 1);
  assert.equal(clampNumber(Number.NaN, 0, 1, 0.3), 0.3);
  assert.equal(clampNumber("0.5", 0, 1, 0.3), 0.3);
  assert.equal(clampNumber(undefined, 0, 1, 0.3), 0.3);
});

test("clamp: 範囲内はそのまま、範囲外はクランプ、非有限は min", () => {
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(clamp(-2, 0, 1), 0);
  assert.equal(clamp(2, 0, 1), 1);
  assert.equal(clamp(Number.NaN, 0, 1), 0);
  // 非有限は +Infinity でも min(旧 toneSvg/balloonShape ローカル実装と同一挙動)。
  assert.equal(clamp(Number.POSITIVE_INFINITY, 0, 1), 0);
});

test("formatSvgNumber: 絶対6桁丸め・非有限は \"0\"", () => {
  assert.equal(formatSvgNumber(0.1234567891), "0.123457");
  assert.equal(formatSvgNumber(-1.0000004), "-1");
  assert.equal(formatSvgNumber(12), "12");
  assert.equal(formatSvgNumber(Number.NaN), "0");
  assert.equal(formatSvgNumber(Number.POSITIVE_INFINITY), "0");
});
