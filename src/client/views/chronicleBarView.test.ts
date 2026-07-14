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
