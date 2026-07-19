import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "../shared/fountain.ts";
import { planScriptManga } from "../shared/scriptMangaPlan.ts";
import { applyScriptMangaDirectorBatch, buildScriptMangaDirectorSystemPrompt } from "./scriptMangaDirector.ts";

function basePages(panelCount: number) {
  const actions = Array.from({ length: panelCount }, (_, index) => `Action ${index + 1}.`).join("\n\n");
  const doc = parseFountain(`INT. ROOM - DAY\n\n${actions}`).doc;
  return planScriptManga(doc, { panelsPerPage: panelCount, maxElementsPerPanel: 1 }).pages;
}

function directedRaw(sourcePages: ReturnType<typeof basePages>, extras: Record<string, unknown> = {}) {
  return {
    pages: [{
      index: 0,
      pageIntent: "Directed",
      ...extras,
      panels: sourcePages[0]!.panels.map((panel, index) => ({
        id: panel.id,
        shot: index === 0 ? "wide" : "medium",
        angle: "eye-level",
        subjects: [{ ref: `subject ${index + 1}`, position: "middle-center", action: `action ${index + 1}`, expression: "focused" }],
        action: `action ${index + 1}`,
        emotion: "focused",
        composition: `composition ${index + 1}`,
        prompt: `rendered panel ${index + 1}`
      }))
    }]
  };
}

test("ネーム監督は人物名を画像生成フィールドへ転記せず中立な役割名を使う", () => {
  const prompt = buildScriptMangaDirectorSystemPrompt({
    fixedIdentity: "Alice: silver hair and a black pilot suit",
    speakers: ["ALICE", "BOB"]
  });
  assert.match(prompt, /Character names and aliases are narrative metadata only/);
  assert.match(prompt, /Never copy them into visual-generation fields/);
  assert.match(prompt, /prompt, action, emotion, composition, avoid, or any subjects\[\] string/);
  assert.match(prompt, /primary character/);
  assert.match(prompt, /Names may remain in pageIntent and other non-visual metadata/);
  assert.match(prompt, /Alice: silver hair and a black pilot suit/);
  assert.match(prompt, /登場話者: ALICE, BOB/);
});

test("director batch preserves structured direction and page intent for five and six panel pages", () => {
  for (const panelCount of [5, 6]) {
    const sourcePages = basePages(panelCount);
    const sourceIds = sourcePages[0]!.panels.map((panel) => panel.sourceElementIds);
    const directed = applyScriptMangaDirectorBatch(directedRaw(sourcePages), sourcePages, "test style");
    assert.ok(directed);
    assert.equal(directed![0]!.layoutTemplateId, sourcePages[0]!.layoutTemplateId, "レイアウトはsourceのまま");
    assert.equal(directed![0]!.pageIntent, "Directed");
    assert.deepEqual(directed![0]!.panels.map((panel) => panel.sourceElementIds), sourceIds);
    assert.deepEqual(directed![0]!.panels[0]!.direction, {
      shot: "wide",
      angle: "eye-level",
      subject: "subject 1",
      subjects: [{ ref: "subject 1", position: "middle-center", action: "action 1", expression: "focused" }],
      avoid: undefined,
      action: "action 1",
      emotion: "focused",
      composition: "composition 1"
    });
    assert.equal(directed![0]!.panels[0]!.prompt, "rendered panel 1");
  }
});

test("ネームポーズレイヤ: castRef/head/torso/layer は素通しされ、不正値だけsubject単位で捨てられる", () => {
  const sourcePages = basePages(2);
  const raw = directedRaw(sourcePages);
  // panel0: 正常な新フィールド一式。
  Object.assign(raw.pages[0]!.panels[0]!.subjects[0]!, {
    castRef: " Alice ",
    head: { x: 0.52, y: 0.18 },
    torso: { x: 0.5, y: 0.61 },
    layer: 2
  });
  // panel1: torso 欠落(headだけでは捨てる)+ 非整数 layer + 空 castRef。
  Object.assign(raw.pages[0]!.panels[1]!.subjects[0]!, {
    castRef: "  ",
    head: { x: 0.4, y: 0.2 },
    layer: 2.5
  });
  const directed = applyScriptMangaDirectorBatch(raw, sourcePages);
  assert.ok(directed);
  assert.deepEqual(directed![0]!.panels[0]!.direction!.subjects![0], {
    ref: "subject 1",
    position: "middle-center",
    action: "action 1",
    expression: "focused",
    castRef: "Alice",
    head: { x: 0.52, y: 0.18 },
    torso: { x: 0.5, y: 0.61 },
    layer: 2
  });
  assert.deepEqual(directed![0]!.panels[1]!.direction!.subjects![0], {
    ref: "subject 2",
    position: "middle-center",
    action: "action 2",
    expression: "focused"
  }, "torso欠落のhead・非整数layer・空castRefは捨てる");
  // 範囲外座標はクランプされる(プロンプト誘導フォールバック時の防御)。
  const clamped = directedRaw(sourcePages);
  Object.assign(clamped.pages[0]!.panels[0]!.subjects[0]!, {
    head: { x: -0.5, y: 0.2 },
    torso: { x: 1.7, y: 0.9 }
  });
  const clampedDirected = applyScriptMangaDirectorBatch(clamped, sourcePages);
  assert.deepEqual(clampedDirected![0]!.panels[0]!.direction!.subjects![0]!.head, { x: 0, y: 0.2 });
  assert.deepEqual(clampedDirected![0]!.panels[0]!.direction!.subjects![0]!.torso, { x: 1, y: 0.9 });
});

test("ネームポーズレイヤ: システムプロンプトが castRef/head/torso/layer を説明する", () => {
  const prompt = buildScriptMangaDirectorSystemPrompt({ speakers: ["ALICE"] });
  assert.match(prompt, /set castRef to the exact character name/);
  assert.match(prompt, /never rendered into prompts/);
  assert.match(prompt, /head \{x,y\} and torso \{x,y\}/);
  assert.match(prompt, /layer \(integer 0-3, larger = nearer to the viewer\)/);
});

test("V5 X3: 監督はレイアウトを変更できない — 出力にlayoutTemplateIdがあっても無視されsourceが保たれる", () => {
  const sourcePages = basePages(3);
  sourcePages[0]!.panels[0]!.visualScale = "large";
  const originalLayout = sourcePages[0]!.layoutTemplateId;
  // 監督schemaにlayoutは無い。悪意/旧形式のlayoutTemplateIdが混ざってもsourceのまま。
  const directed = applyScriptMangaDirectorBatch(
    directedRaw(sourcePages, { layoutTemplateId: "builtin:three-horizontal" }),
    sourcePages
  );
  assert.ok(directed);
  assert.equal(directed![0]!.layoutTemplateId, originalLayout);
  assert.deepEqual(directed![0]!.panels.map((panel) => panel.visualScale), ["large", undefined, undefined],
    "visualScaleは監督合成後も保持される");
});

test("director batch rejects panel-count mismatch and preserves batch-level page identity", () => {
  const sourcePages = basePages(3);
  const short = directedRaw(sourcePages);
  short.pages[0]!.panels = short.pages[0]!.panels.slice(0, 2);
  assert.equal(applyScriptMangaDirectorBatch(short, sourcePages), null, "コマ数不一致はreject");
  const wrongIndex = directedRaw(sourcePages);
  (wrongIndex.pages[0] as { index: number }).index = 1;
  assert.equal(applyScriptMangaDirectorBatch(wrongIndex, sourcePages), null, "page indexの不一致はreject");
});
