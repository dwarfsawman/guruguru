import assert from "node:assert/strict";
import test from "node:test";
import { mapNameStudioPage, type ComparableNameStudioPlan } from "./nameStudioPageMapping.ts";

function plan(pages: Array<Array<{ beats?: string[]; elements?: string[] }>>): ComparableNameStudioPlan {
  return {
    pages: pages.map((panels) => ({
      panels: panels.map((panel) => ({
        sourceBeatIds: panel.beats,
        sourceElementIds: panel.elements
      }))
    }))
  };
}

test("name studio take switch follows the same beat when page boundaries differ", () => {
  const from = plan([
    [{ beats: ["b1"] }],
    [{ beats: ["b2", "b3"] }],
    [{ beats: ["b4"] }]
  ]);
  const to = plan([
    [{ beats: ["b1", "b2"] }],
    [{ beats: ["b3", "b4"] }]
  ]);

  assert.deepEqual(mapNameStudioPage(from, to, 1), {
    pageIndex: 1,
    basis: "beat",
    anchorId: "b3"
  });
});

test("name studio take switch falls back from beat to source element", () => {
  const from = plan([[{ beats: ["missing"], elements: ["e1", "e2"] }]]);
  const to = plan([[{ elements: ["e0"] }], [{ elements: ["e2"] }]]);
  assert.deepEqual(mapNameStudioPage(from, to, 0), {
    pageIndex: 1,
    basis: "element",
    anchorId: "e2"
  });
});

test("name studio take switch uses normalized progress when no story anchor exists", () => {
  const from = plan(Array.from({ length: 71 }, (_, index) => [{ beats: [`a${index}`] }]));
  const to = plan(Array.from({ length: 64 }, (_, index) => [{ beats: [`b${index}`] }]));
  assert.deepEqual(mapNameStudioPage(from, to, 65), {
    pageIndex: 59,
    basis: "progress",
    anchorId: null
  });
});

test("name studio take switch supports directed beatIds", () => {
  const from: ComparableNameStudioPlan = { pages: [{ panels: [{ beatIds: ["beat-directed"] }] }] };
  const to = plan([[{ beats: ["other"] }], [{ beats: ["beat-directed"] }]]);
  assert.equal(mapNameStudioPage(from, to, 0).pageIndex, 1);
});
