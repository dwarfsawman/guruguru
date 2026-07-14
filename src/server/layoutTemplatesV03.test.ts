import assert from "node:assert/strict";
import test from "node:test";
import JSON5 from "json5";
import { initializeDb } from "./db.ts";
import {
  deleteLayoutTemplate,
  exportLayoutTemplate,
  exportPageLayout,
  importLayoutTemplate,
  refreshScriptMangaLayoutCandidates
} from "./layoutTemplates.ts";
import {
  LAYOUT_PRESETS,
  describeScriptMangaLayouts,
  findLayoutPreset,
  scriptMangaLayoutAlignsImportance,
  scriptMangaLayoutCandidates,
  selectScriptMangaLayoutId,
  setExternalScriptMangaLayouts
} from "../shared/layoutPresets.ts";
import { normalizeGuruguruLayout, normalizeGuruguruLayoutPages } from "../shared/pageLayout.ts";
import { HttpError } from "./http.ts";

/** SPEC v0.3 の examples/hero-bleed-figure 相当のフィクスチャ(裁ち切り+figure+autoManga)。 */
const V03_EXAMPLE = `{
  schemaVersion: '0.3.0',
  metadata: { title: 'Hero bleed figure' },
  coordinateSystem: { preset: 'width-relative-top-left', origin: 'top-left', xAxis: 'right', yAxis: 'down', unit: 'page-width' },
  document: { mode: 'single-page', readingDirection: 'rtl', pageProgression: 'rtl' },
  pages: [{ id: 'page_1', role: 'single', aspectRatio: [182, 257], height: 1.412, bounds: [0, 0, 1, 1.412] }],
  validation: { allowOutOfBounds: false, bleedOvershoot: 0.02 },
  panels: [
    { id: 'hero', pageId: 'page_1', order: 1, zIndex: 10, shape: { type: 'rect', bounds: [-0.015, -0.015, 1.015, 0.76] } },
    { id: 'reaction', pageId: 'page_1', order: 2, zIndex: 20, shape: { type: 'polygon', points: [[0.4, 0.78], [0.96, 0.78], [0.96, 1.37], [0.4, 1.37]] } },
    { id: 'figure_left', pageId: 'page_1', order: 3, zIndex: 30, role: 'figure', frame: { visible: false }, shape: { type: 'rect', bounds: [0.04, 0.78, 0.36, 1.37] } }
  ],
  importHints: { preferVector: true },
  extensions: {
    'com.guruguru': {
      autoManga: {
        candidate: true,
        description: 'borderless hero panel bleeding off the top, a reaction panel lower right, and a punch-out figure slot lower left',
        emphasisPanelIds: ['hero']
      }
    }
  }
}`;

const SPREAD_EXAMPLE = `{
  schemaVersion: '0.3.0',
  metadata: { title: 'Spread sample' },
  coordinateSystem: { preset: 'width-relative-top-left' },
  document: { mode: 'spread', readingDirection: 'rtl', pageProgression: 'rtl' },
  pages: [
    { id: 'page_right', role: 'right', aspectRatio: [182, 257], bounds: [0, 0, 1, 1.412] },
    { id: 'page_left', role: 'left', aspectRatio: [182, 257], bounds: [1, 0, 2, 1.412] }
  ],
  panels: [
    { id: 'r1', pageId: 'page_right', order: 1, shape: { type: 'rect', bounds: [0.04, 0.04, 0.96, 1.37] } },
    { id: 'l1', pageId: 'page_left', order: 1, shape: { type: 'rect', bounds: [1.04, 0.04, 1.5, 0.7] } },
    { id: 'l2', pageId: 'page_left', order: 2, shape: { type: 'rect', bounds: [1.52, 0.04, 1.96, 0.7] } }
  ],
  balloons: [
    { id: 'balloon_right', scope: { type: 'panel', id: 'r1' }, shape: { type: 'rect', bounds: [0.2, 0.2, 0.5, 0.4] }, textId: 'text_right' },
    {
      id: 'balloon_left', scope: { type: 'page', id: 'page_left' },
      shape: { type: 'path', d: 'M 1.6 0.2 L 1.8 0.2 L 1.8 0.4 Z' },
      tail: { type: 'beads', beads: [{ center: [1.55, 0.5], radius: 0.02 }], target: { type: 'point', position: [1.4, 0.6] } },
      textId: 'text_left'
    },
    { id: 'balloon_spread', scope: { type: 'spread' }, shape: { type: 'ellipse', center: [1, 0.8], radius: [0.2, 0.1] }, textId: 'text_spread' }
  ],
  texts: [
    { id: 'text_right', box: [0.25, 0.22, 0.45, 0.38], plainText: 'right' },
    { id: 'text_left', box: [1.62, 0.22, 1.78, 0.38], plainText: 'left' },
    { id: 'text_left_free', pageId: 'page_left', box: [1.2, 0.9, 1.4, 1.1], plainText: 'left free' },
    { id: 'text_spread', box: [0.9, 0.72, 1.1, 0.88], plainText: 'spread' }
  ]
}`;

test("normalizeGuruguruLayoutPages: autoManga読み取り・bleedOvershoot検証・見開き分割(左ページはローカル座標へ)", () => {
  const single = normalizeGuruguruLayout(JSON5.parse(V03_EXAMPLE));
  assert.equal(single.source?.autoManga?.candidate, true);
  assert.deepEqual(single.source?.autoManga?.emphasisPanelIds, ["hero"]);
  assert.equal(single.panels.length, 3);
  assert.equal(single.panels.find((panel) => panel.id === "figure_left")?.role, "figure");

  // bleedOvershoot 超過は取り込みエラー。
  const over = JSON5.parse(V03_EXAMPLE) as { panels: Array<{ shape: { bounds: number[] } }> };
  over.panels[0]!.shape.bounds = [-0.1, -0.015, 1.015, 0.76];
  assert.throws(() => normalizeGuruguruLayout(over), /bleedOvershoot/);
  // allowOutOfBounds: true なら無制限(従来どおり)。
  const allowed = JSON5.parse(V03_EXAMPLE) as Record<string, unknown> & { panels: Array<{ shape: { bounds: number[] } }> };
  allowed.panels[0]!.shape.bounds = [-0.1, -0.015, 1.015, 0.76];
  (allowed.validation as Record<string, unknown>).allowOutOfBounds = true;
  assert.ok(normalizeGuruguruLayout(allowed));

  const pages = normalizeGuruguruLayoutPages(JSON5.parse(SPREAD_EXAMPLE));
  assert.equal(pages.length, 2);
  assert.equal(pages[0]!.pageId, "page_right");
  assert.equal(pages[1]!.pageId, "page_left");
  assert.equal(pages[1]!.layout.source?.pageId, "page_left");
  const l1 = pages[1]!.layout.panels.find((panel) => panel.id === "l1")!;
  assert.equal(l1.shape.type, "rect");
  if (l1.shape.type === "rect") {
    assert.ok(Math.abs(l1.shape.bounds[0] - 0.04) < 1e-9, "左ページはx-1でローカル化");
    assert.ok(Math.abs(l1.shape.bounds[2] - 0.5) < 1e-9);
  }
  assert.deepEqual(pages[0]!.layout.balloons?.map((balloon) => balloon.id), ["balloon_right"]);
  assert.deepEqual(pages[1]!.layout.balloons?.map((balloon) => balloon.id), ["balloon_left"]);
  const leftBalloon = pages[1]!.layout.balloons![0]!;
  assert.equal(leftBalloon.shape?.type, "path");
  if (leftBalloon.shape?.type === "path") {
    assert.equal(leftBalloon.shape.d, "M 0.6 0.2 L 0.8 0.2 L 0.8 0.4 Z");
  }
  assert.deepEqual(
    (leftBalloon.tail as { beads: Array<{ center: number[] }>; target: { position: number[] } }).beads[0]!.center,
    [0.55, 0.5]
  );
  assert.deepEqual(
    (leftBalloon.tail as { beads: Array<{ center: number[] }>; target: { position: number[] } }).target.position,
    [0.4, 0.6]
  );
  assert.deepEqual(
    pages[0]!.layout.texts?.map((text) => (text as { id: string }).id),
    ["text_right"]
  );
  assert.deepEqual(
    pages[1]!.layout.texts?.map((text) => (text as { id: string }).id),
    ["text_left", "text_left_free"]
  );
  assert.deepEqual((pages[1]!.layout.texts![0] as { box: number[] }).box, [0.62, 0.22, 0.78, 0.38]);
});

test("候補プール参加: candidate:true の取り込みテンプレが候補末尾へ加わり、説明とemphasis上書きが効く", () => {
  initializeDb();
  setExternalScriptMangaLayouts([]);
  const before3 = scriptMangaLayoutCandidates(3);
  const imported = importLayoutTemplate({ json5: V03_EXAMPLE, name: "Hero bleed figure" });
  try {
    const after3 = scriptMangaLayoutCandidates(3);
    assert.deepEqual(after3.slice(0, before3.length), before3, "内蔵の並びは不変");
    assert.ok(after3.includes(imported.template.id), "取り込みテンプレが候補へ参加");
    const described = describeScriptMangaLayouts([imported.template.id]);
    assert.equal(described.length, 1);
    assert.ok(described[0]!.description.includes("borderless hero panel"), "autoManga.description を使う");
    assert.equal(described[0]!.figureSlot, 3, "figureスロット位置(reading order)");
    // emphasisPanelIds=['hero'] → hero は reading order 先頭スロット。
    assert.equal(scriptMangaLayoutAlignsImportance(imported.template.id, ["hero", "normal", "normal"]), true);
    assert.equal(scriptMangaLayoutAlignsImportance(imported.template.id, ["normal", "normal", "hero"]), false);
    // 事前選択は figure スロット付きを避ける(既存方針のまま)。
    assert.equal(selectScriptMangaLayoutId(["hero", "normal", "normal"]), "builtin:three-hero-top");
  } finally {
    deleteLayoutTemplate(imported.template.id);
  }
  assert.ok(!scriptMangaLayoutCandidates(3).includes(imported.template.id), "削除で候補からも消える");
});

test("見開き取り込みはページ毎に2テンプレへ分割される", () => {
  initializeDb();
  const result = importLayoutTemplate({ json5: SPREAD_EXAMPLE, name: "Spread" });
  try {
    assert.equal(result.templates.length, 2);
    assert.ok(result.templates[0]!.name.includes("(1/2)"));
    assert.equal(result.templates[0]!.layout.panels.length, 1);
    assert.equal(result.templates[1]!.layout.panels.length, 2);
  } finally {
    for (const template of result.templates) deleteLayoutTemplate(template.id);
  }
});

test("ラウンドトリップ: 内蔵全プリセット import→export→import で SPEC §27.3 不変条件を保つ", () => {
  initializeDb();
  setExternalScriptMangaLayouts([]);
  for (const preset of LAYOUT_PRESETS) {
    const exported = exportLayoutTemplate(preset.id);
    assert.ok(exported.filename.endsWith(".guruguru-layout.json5"));
    const parsed = JSON5.parse(exported.json5) as Record<string, unknown>;
    assert.equal(parsed.schemaVersion, "0.3.0", preset.id);
    const reimported = normalizeGuruguruLayout(parsed);
    assert.equal(reimported.readingDirection, preset.layout.readingDirection, preset.id);
    assert.deepEqual(reimported.page.aspectRatio, preset.layout.page.aspectRatio, preset.id);
    assert.equal(reimported.panels.length, preset.layout.panels.length, preset.id);
    preset.layout.panels.forEach((panel, index) => {
      const back = reimported.panels[index]!;
      assert.equal(back.id, panel.id, `${preset.id}/${panel.id} id`);
      assert.equal(back.order, panel.order, `${preset.id}/${panel.id} order`);
      assert.deepEqual(back.shape, panel.shape, `${preset.id}/${panel.id} shape`);
      assert.equal(back.role, panel.role, `${preset.id}/${panel.id} role`);
      assert.equal(back.frame?.visible ?? true, panel.frame?.visible ?? true, `${preset.id}/${panel.id} frame.visible`);
      assert.equal(back.frame?.style ?? "solid", panel.frame?.style ?? "solid", `${preset.id}/${panel.id} frame.style`);
    });
  }
});

test("ラウンドトリップ: v0.3例ファイルの取り込み→エクスポートは原文の未対応フィールドを温存する", () => {
  initializeDb();
  const imported = importLayoutTemplate({ json5: V03_EXAMPLE, name: "Round trip" });
  try {
    const exported = exportLayoutTemplate(imported.template.id);
    const parsed = JSON5.parse(exported.json5) as Record<string, unknown>;
    assert.equal(parsed.schemaVersion, "0.3.0");
    assert.deepEqual(parsed.importHints, { preferVector: true }, "未対応フィールド(importHints)の温存");
    const reimported = normalizeGuruguruLayout(parsed);
    assert.equal(reimported.panels.length, 3);
    assert.equal(reimported.source?.autoManga?.candidate, true);
    assert.deepEqual(
      reimported.panels.map((panel) => panel.id),
      imported.template.layout.panels.map((panel) => panel.id)
    );
    assert.deepEqual(
      reimported.panels.map((panel) => panel.shape),
      imported.template.layout.panels.map((panel) => panel.shape)
    );
  } finally {
    deleteLayoutTemplate(imported.template.id);
  }
});

test("exportLayoutTemplate: 未知idは404、refreshScriptMangaLayoutCandidatesは起動時再構築に使える", () => {
  initializeDb();
  assert.throws(
    () => exportLayoutTemplate("layout_missing"),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404
  );
  setExternalScriptMangaLayouts([]);
  const imported = importLayoutTemplate({ json5: V03_EXAMPLE, name: "Refresh check" });
  try {
    setExternalScriptMangaLayouts([]);
    assert.ok(!scriptMangaLayoutCandidates(3).includes(imported.template.id));
    refreshScriptMangaLayoutCandidates();
    assert.ok(scriptMangaLayoutCandidates(3).includes(imported.template.id), "DBから再構築できる");
  } finally {
    deleteLayoutTemplate(imported.template.id);
  }
  assert.ok(findLayoutPreset("builtin:splash"), "内蔵は影響を受けない");
});

test("exportPageLayout: コマ枠+吹き出し(plainText/kind/scope/speaker)+readingOrderを書き出す", async () => {
  initializeDb();
  const { createProject } = await import("./projects.ts");
  const { createPage } = await import("./pages.ts");
  const { runSql, createId, getRow } = await import("./db.ts");
  const project = createProject({ name: `page-export-${createId("t")}`, mode: "book" })!;
  const page = createPage(project.id);
  const layout = findLayoutPreset("builtin:two-horizontal")!.layout;
  const balloonId = "balloon_1";
  const objects = [
    {
      id: balloonId, kind: "balloon", position: { x: 0.3, y: 0.3 }, rotation: 0,
      shape: "thought", size: { x: 0.2, y: 0.14 }, fill: "#ffffff", strokeColor: "#000000", strokeWidth: 0.004,
      content: { text: "これは心の声。", style: { fontId: "default", size: 0.03, direction: "vertical", color: "#000000" } }
    },
    {
      id: "text_1", kind: "text", position: { x: 0.5, y: 1.0 }, rotation: 0,
      content: { text: "自由テキスト", style: { fontId: "default", size: 0.03, direction: "horizontal", color: "#000000" } }
    }
  ];
  runSql("UPDATE pages SET layout_json = ?, objects_json = ? WHERE id = ?", [
    JSON.stringify(layout), JSON.stringify(objects), page.id
  ]);
  const characterId = createId("char");
  runSql("INSERT INTO characters (id, project_id, name) VALUES (?, ?, 'ALICE')", [characterId, project.id]);
  const lineId = createId("line");
  runSql(
    `INSERT INTO dialogue_lines (id, project_id, character_id, speaker_label, text, order_index) VALUES (?, ?, ?, 'ALICE', 'これは心の声。', 0)`,
    [lineId, project.id, characterId]
  );
  const panelId = layout.panels[0]!.id;
  runSql(
    `INSERT INTO dialogue_placements (id, line_id, page_id, panel_id, balloon_object_id) VALUES (?, ?, ?, ?, ?)`,
    [createId("place"), lineId, page.id, panelId, balloonId]
  );
  const exported = exportPageLayout(project.id, page.id);
  const parsed = JSON5.parse(exported.json5) as {
    balloons?: Array<Record<string, unknown>>;
    texts?: Array<Record<string, unknown>>;
    readingOrder?: { balloons: string[]; texts: string[] };
    panels: unknown[];
  };
  assert.equal(parsed.panels.length, 2);
  assert.equal(parsed.balloons?.length, 1);
  const balloon = parsed.balloons![0]!;
  assert.equal(balloon.kind, "thought");
  assert.deepEqual(balloon.scope, { type: "panel", id: panelId });
  assert.deepEqual(balloon.speaker, { type: "character", characterId });
  assert.equal(parsed.texts?.length, 2);
  assert.equal((parsed.texts![0] as { plainText?: string }).plainText, "これは心の声。");
  assert.equal((parsed.texts![0] as { writingMode?: string }).writingMode, "vertical-rl");
  assert.equal((parsed.texts![1] as { plainText?: string }).plainText, "自由テキスト");
  assert.deepEqual(parsed.readingOrder?.balloons, [balloonId]);
  // 再取り込みしてもコマ枠は保たれる(吹き出しは予約フィールドとして保持)。
  const reimported = normalizeGuruguruLayout(parsed);
  assert.equal(reimported.panels.length, 2);
  assert.equal(reimported.balloons?.length, 1);
  assert.equal(
    getRow("SELECT id FROM pages WHERE id = ?", [page.id]) !== null, true
  );
});
