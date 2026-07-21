import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeAttr, escapeHtml } from "./htmlEscape.ts";

test("escapeHtml: & < > \" をエスケープし、' はそのまま(SVG生成系の旧ローカル escapeAttr と同一挙動)", () => {
  assert.equal(escapeHtml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e'f");
  assert.equal(escapeHtml("plain"), "plain");
});

test("escapeHtml: null/undefined は空文字、数値は文字列化", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(12.5), "12.5");
});

test("escapeAttr: escapeHtml に加えて ' も &#039; にする", () => {
  assert.equal(escapeAttr(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&#039;f");
  assert.equal(escapeAttr(null), "");
});
