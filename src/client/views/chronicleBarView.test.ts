import assert from "node:assert/strict";
import test from "node:test";
import type { ChronicleBarViewState } from "./chronicleBarView.ts";
import { renderChronicleBar } from "./chronicleBarView.ts";

function view(currentPageId = "page-current"): ChronicleBarViewState {
  return {
    status: "ready",
    errorMessage: null,
    collapsed: false,
    scripts: [{
      id: "script-1",
      projectId: "project-1",
      title: "Episode",
      createdAt: "2026-07-14T00:00:00Z",
      updatedAt: "2026-07-14T00:00:00Z"
    }],
    scriptId: "script-1",
    beats: [
      { id: "beat-1", sceneIndex: 0, lineIds: ["line-1"], label: "Alice", summary: "first", speakerIds: ["Alice"], startOrder: 0, endOrder: 0 },
      { id: "beat-2", sceneIndex: 1, lineIds: ["line-2"], label: "Bob", summary: "adopted", speakerIds: ["Bob"], startOrder: 1, endOrder: 1 }
    ],
    lines: [
      { lineId: "line-1", status: "active", orderIndex: 0, sceneIndex: 0, speakerLabel: "Alice", text: "first", semanticKind: "dialogue", placements: [] },
      { lineId: "line-2", status: "active", orderIndex: 1, sceneIndex: 1, speakerLabel: "Bob", text: "adopted", semanticKind: "dialogue", placements: [{ id: "placement-2", pageId: "page-current", balloonObjectId: "balloon-2" }] }
    ],
    pages: [],
    currentPageId,
    previewBeatId: null,
    selectedBeatIds: [],
    allocationPolicy: "skip",
    busyAction: null,
    preview: null
  };
}

test("Chronicle bar marks only current-page dialogue bright when the page has placements", () => {
  const html = renderChronicleBar(view());
  assert.match(html, /chronicle-bar-track has-current-page-lines/);
  assert.match(html, /class="chronicle-beat is-status-materialized is-current-page"[^>]*data-id="beat-2"[^>]*aria-current="true"/);
  assert.doesNotMatch(html, /data-id="beat-1"[^>]*aria-current/);
});

test("Chronicle bar keeps the legacy brightness when the page has no placements", () => {
  const html = renderChronicleBar(view("page-empty"));
  assert.match(html, /class="chronicle-bar-track"/);
  assert.doesNotMatch(html, /has-current-page-lines/);
});

test("Chronicle chip identifies its representative line and stays associated with it while collapsed", () => {
  const state = view();
  state.beats[0]!.lineIds = ["line-1", "line-3"];
  state.beats[0]!.endOrder = 2;
  state.lines.push({
    lineId: "line-3", status: "active", orderIndex: 2, sceneIndex: 0, speakerLabel: "Mira", text: "script text",
    semanticKind: "dialogue", placements: [{
      id: "placement-3", pageId: "page-current", balloonObjectId: "balloon-3",
      speakerLabelOverride: "ミラ", textOverride: "配置時のセリフ", renderedText: "吹き出しのセリフ"
    }]
  });
  state.pages = [{ pageId: "page-current", pageIndex: 4, lineIds: ["line-3"] }];

  const html = renderChronicleBar(state);
  assert.match(html, /<span class="chronicle-beat-count">2セリフ<\/span>/);
  assert.match(html, /title="代表セリフ: Alice「first」[\s\S]*2セリフ/);
  // B-2: previewBeatId が立っていない既定状態ではアコーディオンは一切出ない。
  assert.doesNotMatch(html, /chronicle-beat-accordion/);
  assert.doesNotMatch(html, /chronicle-beat-preview-speaker/);
});

test("B-2: clicking a beat chip expands an accordion directly beneath that chip, without the removed header", () => {
  const state = view();
  state.beats[0]!.lineIds = ["line-1", "line-3"];
  state.beats[0]!.endOrder = 2;
  state.lines.push({
    lineId: "line-3", status: "active", orderIndex: 2, sceneIndex: 0, speakerLabel: "Mira", text: "script text",
    semanticKind: "dialogue", placements: [{
      id: "placement-3", pageId: "page-current", balloonObjectId: "balloon-3",
      speakerLabelOverride: "ミラ", textOverride: "配置時のセリフ", renderedText: "吹き出しのセリフ"
    }]
  });
  state.pages = [{ pageId: "page-current", pageIndex: 4, lineIds: ["line-3"] }];
  state.previewBeatId = "beat-1";
  state.selectedBeatIds = ["beat-1"];

  const html = renderChronicleBar(state);
  // 見出し行(「セリフ一覧」「タグは先頭セリフを代表表示」)はユーザー明示要望で削除済み。
  // (注意: チップの title 属性には元々「クリックでセリフ一覧 / Shift+クリックで範囲選択」という
  // 無関係なツールチップ文言があるため、単純な /セリフ一覧/ 部分一致では誤検知する -- 削除対象の
  // 見出し要素そのもの `<strong>セリフ一覧</strong>` の有無を見る。)
  assert.doesNotMatch(html, /<strong>セリフ一覧<\/strong>/);
  assert.doesNotMatch(html, /タグは先頭セリフを代表表示/);
  // 中身(話者/本文/配置状態)は維持。
  assert.match(html, /chronicle-beat-preview-speaker">ミラ<\/span>/);
  assert.match(html, /chronicle-beat-preview-text">吹き出しのセリフ<\/span>/);
  assert.match(html, /chronicle-beat-preview-page">このページ<\/span>/);
  // 開いたチップは is-expanded で強調される(選択中でもあるので is-selected も併存)。
  assert.match(html, /class="chronicle-beat is-status-unassigned is-current-page is-selected is-expanded"[^>]*data-id="beat-1"/);
  // アコーディオンは beat-1 のチップの直後、beat-2 のチップより前(= そのチップの直下)に差し込まれる。
  const chip1Index = html.indexOf('data-id="beat-1"');
  const accordionIndex = html.indexOf("chronicle-beat-accordion");
  const chip2Index = html.indexOf('data-id="beat-2"');
  assert.ok(chip1Index >= 0 && chip2Index > chip1Index, "fixture sanity: beat-1 chip precedes beat-2 chip");
  assert.ok(
    accordionIndex > chip1Index && accordionIndex < chip2Index,
    "accordion must render between beat-1's own chip and the next chip, not in a separate block after all chips"
  );
  // beat-2(閉じたまま)は is-expanded を持たない。
  assert.doesNotMatch(html, /class="chronicle-beat is-status-materialized is-current-page is-expanded"/);
});
