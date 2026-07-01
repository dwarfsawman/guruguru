import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeAttr, escapeHtml, formatCssNumber, formatDate, formatNumber, formatSliderValue } from "./format.ts";

function fakeInput(step: string, value: string): HTMLInputElement {
  return { step, value } as unknown as HTMLInputElement;
}

test("escapeHtml: escapes &, <, >, and double quotes", () => {
  assert.equal(escapeHtml(`<b>"quoted" & tags</b>`), "&lt;b&gt;&quot;quoted&quot; &amp; tags&lt;/b&gt;");
});

test("escapeHtml: does not escape single quotes", () => {
  assert.equal(escapeHtml("it's fine"), "it's fine");
});

test("escapeHtml: coerces non-string values, treating null/undefined as empty", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(true), "true");
});

test("escapeAttr: also escapes single quotes on top of escapeHtml", () => {
  assert.equal(escapeAttr(`it's <b>"bold"</b>`), "it&#039;s &lt;b&gt;&quot;bold&quot;&lt;/b&gt;");
});

test("formatDate: formats a non-empty ISO string via Date#toLocaleString", () => {
  const iso = "2024-01-01T00:00:00.000Z";
  assert.equal(formatDate(iso), new Date(iso).toLocaleString());
});

test("formatDate: returns '-' for an empty string", () => {
  assert.equal(formatDate(""), "-");
});

test("formatNumber: prints integers without decimals", () => {
  assert.equal(formatNumber(5), "5");
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(-3), "-3");
});

test("formatNumber: prints non-integers with up to 2 decimals, trimming a single trailing zero", () => {
  assert.equal(formatNumber(1.5), "1.5");
  assert.equal(formatNumber(1.25), "1.25");
});

test("formatCssNumber: rounds to 3 decimal places", () => {
  assert.equal(formatCssNumber(1.23456), "1.235");
  assert.equal(formatCssNumber(2), "2");
});

test("formatCssNumber: returns '0' for non-finite values", () => {
  assert.equal(formatCssNumber(NaN), "0");
  assert.equal(formatCssNumber(Infinity), "0");
});

test("formatSliderValue: whole-number string for step >= 1", () => {
  assert.equal(formatSliderValue(fakeInput("1", "5")), "5");
  assert.equal(formatSliderValue(fakeInput("2", "6")), "6");
});

test("formatSliderValue: defaults step to 1 when step is empty/falsy", () => {
  assert.equal(formatSliderValue(fakeInput("", "7")), "7");
});

test("formatSliderValue: fixed(2) with trailing zero trimmed when step < 1", () => {
  assert.equal(formatSliderValue(fakeInput("0.1", "0.5")), "0.5");
  assert.equal(formatSliderValue(fakeInput("0.01", "0.25")), "0.25");
});
