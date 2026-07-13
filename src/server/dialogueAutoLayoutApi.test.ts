import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDialogueLayout,
  previewDialogueLayout,
  reflowDialogueLayout,
  unlockAllDialoguePlacementsForPage
} from "./dialogueAutoLayoutApi.ts";
import { allocateDialoguePages } from "./dialogueAllocation.ts";
import { createDialoguePlacement, updateDialoguePlacement } from "./dialogueLines.ts";
import { createScript } from "./scripts.ts";
import { createPage, updatePageLayout } from "./pages.ts";
import { createProject } from "./projects.ts";
import { initializeDb, getRow, getRows, runSql } from "./db.ts";
import { HttpError } from "./http.ts";
import type { PageLayout } from "../shared/pageLayout.ts";
import type { PageObject } from "../shared/pageObjects.ts";

function createTestProject() {
  initializeDb();
  const project = createProject({ name: "S5 chronicle auto layout", mode: "book" });
  assert.ok(project);
  return project!.id as string;
}

const TWO_PANEL_LAYOUT: PageLayout = {
  version: 1,
  page: { aspectRatio: [1, 1.4142], height: 1.4142 },
  readingDirection: "rtl",
  panels: [
    { id: "panel_left", order: 1, shape: { type: "rect", bounds: [0, 0, 0.48, 1.4142] } },
    { id: "panel_right", order: 2, shape: { type: "rect", bounds: [0.52, 0, 1, 1.4142] } }
  ]
};

const SOURCE = ["INT. 教室 - 昼", "", "@太郎", "おはよう。", "", "@花子", "おはよう、太郎。元気そうだね。"].join("\n");

function setup() {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "第一話", fountainSource: SOURCE });
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: TWO_PANEL_LAYOUT });
  const lineIds = script.lines.map((line) => line.id);
  allocateDialoguePages(projectId, page.id, { lineIds });
  const placementRows = getRows<{ id: string; line_id: string }>(
    "SELECT id, line_id FROM dialogue_placements WHERE page_id = ?",
    [page.id]
  );
  return { projectId, pageId: page.id, script, placementRows };
}

function pageObjectsJson(pageId: string): PageObject[] {
  const row = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  return row?.objects_json ? (JSON.parse(row.objects_json) as PageObject[]) : [];
}

test("previewDialogueLayout: DB を書き換えない(before/after 同一)", () => {
  const { projectId, pageId, placementRows } = setup();
  const before = getRow<{ objects_json: string | null; updated_at: string }>("SELECT objects_json, updated_at FROM pages WHERE id = ?", [
    pageId
  ]);
  const placementsBefore = getRows("SELECT * FROM dialogue_placements WHERE page_id = ?", [pageId]);

  const preview = previewDialogueLayout(projectId, pageId, { placementIds: placementRows.map((row) => row.id), seed: 123 });
  assert.equal(preview.seed, 123);
  assert.ok(preview.objects.length > 0);

  const after = getRow<{ objects_json: string | null; updated_at: string }>("SELECT objects_json, updated_at FROM pages WHERE id = ?", [
    pageId
  ]);
  assert.deepEqual(after, before);
  const placementsAfter = getRows("SELECT * FROM dialogue_placements WHERE page_id = ?", [pageId]);
  assert.deepEqual(placementsAfter, placementsBefore);
});

test("previewDialogueLayout: seed 省略時も決定的な値を返す(同一呼び出しは同じ seed)", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  const a = previewDialogueLayout(projectId, pageId, { placementIds: ids });
  const b = previewDialogueLayout(projectId, pageId, { placementIds: ids });
  assert.equal(a.seed, b.seed);
});

test("applyDialogueLayout: 成功時に objects_json と placement 列を更新する", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  const result = applyDialogueLayout(projectId, pageId, { placementIds: ids, seed: 7 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  assert.equal(result.objects.length, ids.length);

  const objects = pageObjectsJson(pageId);
  assert.equal(objects.length, ids.length);
  for (const object of objects) {
    assert.equal(object.kind, "balloon");
    assert.ok(object.sourceDialogueLineId);
  }

  const placements = getRows<{ id: string; balloon_object_id: string | null; panel_id: string | null; auto_layout_seed: number | null; auto_layout_version: number | null }>(
    "SELECT id, balloon_object_id, panel_id, auto_layout_seed, auto_layout_version FROM dialogue_placements WHERE id IN (" +
      ids.map(() => "?").join(",") +
      ")",
    ids
  );
  for (const placement of placements) {
    assert.ok(placement.balloon_object_id);
    assert.equal(placement.auto_layout_seed, 7);
    assert.equal(placement.auto_layout_version, 1);
    // sourceDialogueLineId ⇄ balloon_object_id の双方向リンク。
    const object = objects.find((o) => o.id === placement.balloon_object_id);
    assert.ok(object);
  }
});

test("applyDialogueLayout: unplaced が混在すると 422 で全件ロールバックする(部分確定しない)", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  // 巨大サイズを要求させるため、極端に長い行を追加して1件だけ unplaced になるよう仕向ける代わりに、
  // レイアウトを1コマだけの極小コマへ差し替えて必ず配置不能を発生させる。
  const tinyLayout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1.4142], height: 1.4142 },
    readingDirection: "rtl",
    panels: [{ id: "panel_tiny", order: 1, shape: { type: "rect", bounds: [0, 0, 0.02, 0.02] } }]
  };
  updatePageLayout(projectId, pageId, { layout: tinyLayout });

  const before = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  const placementsBefore = getRows("SELECT * FROM dialogue_placements WHERE page_id = ?", [pageId]);

  assert.throws(() => applyDialogueLayout(projectId, pageId, { placementIds: ids, seed: 1 }), HttpError);

  const after = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  assert.deepEqual(after, before);
  const placementsAfter = getRows("SELECT * FROM dialogue_placements WHERE page_id = ?", [pageId]);
  assert.deepEqual(placementsAfter, placementsBefore);
});

test("applyDialogueLayout: PAGE_OBJECTS_MAX_COUNT 超過は拒否する", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  const filler: PageObject[] = Array.from({ length: 299 }, (_, i) => ({
    id: `filler_${i}`,
    kind: "box",
    position: { x: 0.1, y: 0.1 },
    rotation: 0,
    size: { x: 0.01, y: 0.01 },
    fill: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 0.004
  }));
  runSql("UPDATE pages SET objects_json = ? WHERE id = ?", [JSON.stringify(filler), pageId]);

  assert.throws(() => applyDialogueLayout(projectId, pageId, { placementIds: ids, seed: 1 }), HttpError);
});

test("applyDialogueLayout: 既に吹き出し化済みの placement を対象にすると拒否する", () => {
  const { projectId, pageId, script } = setup();
  const taroLine = script.lines.find((line) => line.speakerLabel === "太郎")!;
  const created = createDialoguePlacement(taroLine.id, { pageId });
  assert.throws(() => applyDialogueLayout(projectId, pageId, { placementIds: [created.placement.id], seed: 1 }), HttpError);
});

// --- 回帰テスト: サイズバリアントで従来 unplaced だった長めの行が配置できる(問題2) ---

const FOUR_GRID_LAYOUT: PageLayout = {
  version: 1,
  page: { aspectRatio: [182, 257], height: 257 / 182 },
  readingDirection: "rtl",
  panels: [
    { id: "r1c2", order: 1, shape: { type: "rect", bounds: [0.51, 0.04, 0.96, 0.696044] } },
    { id: "r1c1", order: 2, shape: { type: "rect", bounds: [0.04, 0.04, 0.49, 0.696044] } },
    { id: "r2c2", order: 3, shape: { type: "rect", bounds: [0.51, 0.716044, 0.96, 1.372088] } },
    { id: "r2c1", order: 4, shape: { type: "rect", bounds: [0.04, 0.716044, 0.49, 1.372088] } }
  ]
};

const LONG_DIALOGUE_SOURCE = [
  "INT. 教室 - 昼",
  "",
  "@ソラ",
  "(M)",
  "……寒い。まだ着いたはずがない。どうして私だけ起こされた?",
  "",
  "@アマネ",
  "おはようございます、ソラ。緊急事態です。起こしてしまってごめんなさい。",
  "",
  "@ソラ",
  "アマネ? 船のAIが謝るなんて、プログラムにあったかしら。"
].join("\n");

test("previewDialogueLayout: four-grid の四半ページに26〜35字の会話が『コマに対して文字量が多すぎる』で誤って弾かれない(回帰)", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "回帰テスト", fountainSource: LONG_DIALOGUE_SOURCE });
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: FOUR_GRID_LAYOUT });
  const lineIds = script.lines.map((line) => line.id);
  allocateDialoguePages(projectId, page.id, { lineIds });
  const placementRows = getRows<{ id: string }>("SELECT id FROM dialogue_placements WHERE page_id = ?", [page.id]);

  const preview = previewDialogueLayout(projectId, page.id, { placementIds: placementRows.map((row) => row.id), seed: 1234 });

  // 修正前は「コマに対して文字量が多すぎる」判定で全滅していた3行構成。修正後は全て配置できる
  // (このレイアウト・行数では各行が別コマへ収まる)。
  assert.equal(preview.unplacedPlacementIds.length, 0, JSON.stringify(preview.warnings));
  assert.equal(preview.objects.length, placementRows.length);
  for (const warning of preview.warnings) {
    assert.ok(!warning.includes("文字量が多すぎる"), `unexpected size-rejection warning: ${warning}`);
  }
});

test("previewDialogueLayout: LTR レイアウトでも配置できる(RTL 以外の受け入れ確認)", () => {
  const ltrLayout: PageLayout = { ...FOUR_GRID_LAYOUT, readingDirection: "ltr" };
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "ltr-test", fountainSource: LONG_DIALOGUE_SOURCE });
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: ltrLayout });
  allocateDialoguePages(projectId, page.id, { lineIds: script.lines.map((line) => line.id) });
  const placementRows = getRows<{ id: string }>("SELECT id FROM dialogue_placements WHERE page_id = ?", [page.id]);

  const preview = previewDialogueLayout(projectId, page.id, { placementIds: placementRows.map((row) => row.id), seed: 1234 });
  assert.equal(preview.unplacedPlacementIds.length, 0, JSON.stringify(preview.warnings));
  assert.equal(preview.objects.length, placementRows.length);
});

test("previewDialogueLayout: six-panel で26字程度のセリフが配置できる(受け入れ基準)", () => {
  const sixPanelLayout: PageLayout = {
    version: 1,
    page: { aspectRatio: [182, 257], height: 257 / 182 },
    readingDirection: "rtl",
    panels: [
      { id: "r1c2", order: 1, shape: { type: "rect", bounds: [0.51, 0.04, 0.96, 0.45] } },
      { id: "r1c1", order: 2, shape: { type: "rect", bounds: [0.04, 0.04, 0.49, 0.45] } },
      { id: "r2c2", order: 3, shape: { type: "rect", bounds: [0.51, 0.47, 0.96, 0.9] } },
      { id: "r2c1", order: 4, shape: { type: "rect", bounds: [0.04, 0.47, 0.49, 0.9] } },
      { id: "r3c2", order: 5, shape: { type: "rect", bounds: [0.51, 0.92, 0.96, 1.372088] } },
      { id: "r3c1", order: 6, shape: { type: "rect", bounds: [0.04, 0.92, 0.49, 1.372088] } }
    ]
  };
  const projectId = createTestProject();
  const source = ["INT. 教室 - 昼", "", "@太郎", "おはようございます、今日はいい天気ですね元気にしていますか。"].join("\n");
  const script = createScript(projectId, { title: "six-panel", fountainSource: source });
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: sixPanelLayout });
  allocateDialoguePages(projectId, page.id, { lineIds: script.lines.map((line) => line.id) });
  const placementRows = getRows<{ id: string }>("SELECT id FROM dialogue_placements WHERE page_id = ?", [page.id]);

  const preview = previewDialogueLayout(projectId, page.id, { placementIds: placementRows.map((row) => row.id), seed: 7 });
  assert.equal(preview.unplacedPlacementIds.length, 0, JSON.stringify(preview.warnings));
});

// --- フェーズIV(Docs/Done/Feature-ChroniclePageFlow.md §2.6・§6): 再配置(reflow)とロック解除 ---

function objectText(object: PageObject): string | undefined {
  return object.kind === "text" ? object.content.text : (object.kind === "box" || object.kind === "balloon") ? object.content?.text : undefined;
}

test("reflowDialogueLayout: 位置が変わりテキストは維持される(materialized な placement を対象)", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  applyDialogueLayout(projectId, pageId, { placementIds: ids, seed: 1 });
  const before = pageObjectsJson(pageId);
  const textById = new Map(before.map((object) => [object.sourceDialogueLineId, objectText(object)]));

  const result = reflowDialogueLayout(projectId, pageId, { seed: 99999 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  assert.equal(result.objects.length, ids.length);

  const after = pageObjectsJson(pageId);
  assert.equal(after.length, before.length);
  // 位置が(seed 変更により)少なくとも1件は変わっている。
  const anyMoved = after.some((object) => {
    const prior = before.find((item) => item.sourceDialogueLineId === object.sourceDialogueLineId);
    return prior && (prior.position.x !== object.position.x || prior.position.y !== object.position.y);
  });
  assert.ok(anyMoved, "seed を変えたら少なくとも1件は位置が変わるはず");
  // テキストは維持される。
  for (const object of after) {
    assert.equal(objectText(object), textById.get(object.sourceDialogueLineId));
  }
  // placement の auto_layout_seed が更新されている。
  const placementsAfter = getRows<{ auto_layout_seed: number | null; balloon_object_id: string | null }>(
    "SELECT auto_layout_seed, balloon_object_id FROM dialogue_placements WHERE id IN (" + ids.map(() => "?").join(",") + ")",
    ids
  );
  for (const placement of placementsAfter) {
    assert.equal(placement.auto_layout_seed, 99999);
    assert.ok(placement.balloon_object_id);
  }
});

test("reflowDialogueLayout: auto_layout_locked=1 の placement は対象から除外され、位置が不変", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  applyDialogueLayout(projectId, pageId, { placementIds: ids, seed: 1 });
  const lockedId = ids[0]!;
  updateDialoguePlacement(lockedId, { autoLayoutLocked: true });
  const lockedBalloonId = getRow<{ balloon_object_id: string }>("SELECT balloon_object_id FROM dialogue_placements WHERE id = ?", [
    lockedId
  ])!.balloon_object_id;
  const before = pageObjectsJson(pageId);
  const lockedObjectBefore = before.find((object) => object.id === lockedBalloonId)!;

  reflowDialogueLayout(projectId, pageId, { seed: 555 });

  const after = pageObjectsJson(pageId);
  const lockedObjectAfter = after.find((object) => object.id === lockedBalloonId);
  assert.ok(lockedObjectAfter, "ロック済みオブジェクトの id はそのまま残る");
  assert.deepEqual(lockedObjectAfter!.position, lockedObjectBefore.position);
  assert.equal(lockedObjectAfter!.kind, "balloon");
  assert.equal(lockedObjectBefore.kind, "balloon");
  if (lockedObjectAfter!.kind === "balloon" && lockedObjectBefore.kind === "balloon") {
    assert.deepEqual(lockedObjectAfter.size, lockedObjectBefore.size);
  }

  const lockedPlacementAfter = getRow<{ auto_layout_seed: number | null }>(
    "SELECT auto_layout_seed FROM dialogue_placements WHERE id = ?",
    [lockedId]
  );
  assert.notEqual(lockedPlacementAfter?.auto_layout_seed, 555, "ロック済み placement の auto_layout_seed は更新されない");
});

test("reflowDialogueLayout: 配置不能なら 422 で全件ロールバック(既存配置が消えない)", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  applyDialogueLayout(projectId, pageId, { placementIds: ids, seed: 1 });

  const tinyLayout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1.4142], height: 1.4142 },
    readingDirection: "rtl",
    panels: [{ id: "panel_tiny", order: 1, shape: { type: "rect", bounds: [0, 0, 0.02, 0.02] } }]
  };
  updatePageLayout(projectId, pageId, { layout: tinyLayout });

  const before = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  const placementsBefore = getRows("SELECT * FROM dialogue_placements WHERE page_id = ?", [pageId]);

  assert.throws(() => reflowDialogueLayout(projectId, pageId, { seed: 1 }), HttpError);

  const after = getRow<{ objects_json: string | null }>("SELECT objects_json FROM pages WHERE id = ?", [pageId]);
  assert.deepEqual(after, before);
  const placementsAfter = getRows("SELECT * FROM dialogue_placements WHERE page_id = ?", [pageId]);
  assert.deepEqual(placementsAfter, placementsBefore);
});

test("reflowDialogueLayout: 対象(未ロックの materialized placement)が無ければ何もしない", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  // まだ apply していない(全て balloon_object_id=NULL)ので対象0件。
  const result = reflowDialogueLayout(projectId, pageId, { seed: 1 });
  assert.equal(result.objects.length, 0);
  assert.ok(result.warnings.length > 0);
  const placementsAfter = getRows("SELECT * FROM dialogue_placements WHERE id IN (" + ids.map(() => "?").join(",") + ")", ids);
  for (const placement of placementsAfter as Array<{ balloon_object_id: string | null }>) {
    assert.equal(placement.balloon_object_id, null);
  }
});

test("unlockAllDialoguePlacementsForPage: 現在ページのロックを一括解除する", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  applyDialogueLayout(projectId, pageId, { placementIds: ids, seed: 1 });
  for (const id of ids) {
    updateDialoguePlacement(id, { autoLayoutLocked: true });
  }

  const result = unlockAllDialoguePlacementsForPage(projectId, pageId);
  assert.equal(result.unlocked, ids.length);

  const placementsAfter = getRows<{ auto_layout_locked: number }>(
    "SELECT auto_layout_locked FROM dialogue_placements WHERE id IN (" + ids.map(() => "?").join(",") + ")",
    ids
  );
  for (const placement of placementsAfter) {
    assert.equal(placement.auto_layout_locked, 0);
  }

  const second = unlockAllDialoguePlacementsForPage(projectId, pageId);
  assert.equal(second.unlocked, 0, "既にロックが無ければ冪等に0を返す");
});

// --- 回帰テスト: 2x2 グリッド+ロック1件で reflow が全 seed 422 になる不具合(§6 フェーズV) ---

const FIVE_LINE_SOURCE = [
  "INT. 教室 - 昼",
  "",
  "@太郎",
  "おはようございます",
  "",
  "@太郎",
  "おはようございます",
  "",
  "@太郎",
  "おはようございます",
  "",
  "@太郎",
  "おはようございます",
  "",
  "@太郎",
  "おはようございます"
].join("\n");

test("reflowDialogueLayout: 2x2グリッドで5件中1件ロック、ロック吹き出しが担当コマを占有していても後続コマへフォールバックして配置できる(回帰)", () => {
  const projectId = createTestProject();
  const script = createScript(projectId, { title: "回帰テスト(reflow fallback)", fountainSource: FIVE_LINE_SOURCE });
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: FOUR_GRID_LAYOUT });
  const lineIds = script.lines.map((line) => line.id);
  allocateDialoguePages(projectId, page.id, { lineIds });
  const placementRows = getRows<{ id: string }>("SELECT id FROM dialogue_placements WHERE page_id = ?", [page.id]);
  const ids = placementRows.map((row) => row.id);

  const applied = applyDialogueLayout(projectId, page.id, { placementIds: ids, seed: 1 });
  assert.equal(applied.unplacedPlacementIds.length, 0, JSON.stringify(applied.warnings));

  // 5行/4コマの均等配分では、いずれかのコマに2行が割り当てられる(等長テキストなので中点判定で
  // 決定的にそうなる)。同一コマへ割り当てられた2件を見つける。
  const byPanel = new Map<string, string[]>();
  for (const assignment of applied.assignments) {
    if (!assignment.panelId) continue;
    const list = byPanel.get(assignment.panelId) ?? [];
    list.push(assignment.placementId);
    byPanel.set(assignment.panelId, list);
  }
  const sharedPanelEntry = [...byPanel.entries()].find(([, placementIds]) => placementIds.length >= 2);
  assert.ok(sharedPanelEntry, "少なくとも1コマは2件以上が共有しているはず");
  const [sharedPanelId, sharedPlacementIds] = sharedPanelEntry!;
  const [lockedPlacementId] = sharedPlacementIds;

  // 共有コマの吹き出し1件をロックし、コマ全域を覆うサイズへ拡張する(担当コマの空きスペースが
  // ゼロになる状況を再現)。
  updateDialoguePlacement(lockedPlacementId!, { autoLayoutLocked: true });
  const lockedBalloonId = getRow<{ balloon_object_id: string }>("SELECT balloon_object_id FROM dialogue_placements WHERE id = ?", [
    lockedPlacementId
  ])!.balloon_object_id;
  const panel = FOUR_GRID_LAYOUT.panels.find((p) => p.id === sharedPanelId)!;
  const bounds = (panel.shape as { bounds: [number, number, number, number] }).bounds;
  const panelCenter = { x: (bounds[0] + bounds[2]) / 2, y: (bounds[1] + bounds[3]) / 2 };
  const panelSize = { x: bounds[2] - bounds[0], y: bounds[3] - bounds[1] };
  const objectsBefore = pageObjectsJson(page.id);
  const enlargedObjects = objectsBefore.map((object) =>
    object.id === lockedBalloonId ? { ...object, position: panelCenter, size: panelSize } : object
  );
  runSql("UPDATE pages SET objects_json = ? WHERE id = ?", [JSON.stringify(enlargedObjects), page.id]);

  // 修正前は担当コマ固定だったため、同 seed 内で候補が一切見つからず(乱数はどの seed でも tie-break
  // にしか使われない)、全 seed で 422 になっていた。フォールバックにより後続コマへ逃がせることを
  // 複数 seed で確認する。
  for (const seed of [1, 2, 3, 4, 5]) {
    const result = reflowDialogueLayout(projectId, page.id, { seed });
    assert.equal(result.unplacedPlacementIds.length, 0, `seed=${seed}: ${JSON.stringify(result.warnings)}`);
  }

  // ロック済みの吹き出しは動かない。
  const objectsAfter = pageObjectsJson(page.id);
  const lockedObjectAfter = objectsAfter.find((object) => object.id === lockedBalloonId);
  assert.ok(lockedObjectAfter);
  assert.deepEqual(lockedObjectAfter!.position, panelCenter);
});

test("applyDialogueLayout: avoidZones/maxPanelCoverageRatio を受け付け、崩れた avoidZones は 400", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  assert.throws(
    () => previewDialogueLayout(projectId, pageId, { placementIds: ids, seed: 1, avoidZones: [{ x: 0.1 }] }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
  const result = applyDialogueLayout(projectId, pageId, {
    placementIds: ids,
    seed: 7,
    avoidZones: [{ x: 0.6, y: 0, width: 0.4, height: 0.3, label: "顔" }],
    maxPanelCoverageRatio: 0.6
  });
  assert.equal(result.unplacedPlacementIds.length, 0);
  assert.equal(result.objects.length, ids.length);
});

test("reflowDialogueLayout: fontScale 指定時は再配置後も吹き出し本文サイズを維持する", () => {
  const { projectId, pageId, placementRows } = setup();
  const ids = placementRows.map((row) => row.id);
  applyDialogueLayout(projectId, pageId, { placementIds: ids, seed: 7, fontScale: 0.88 });
  const reflowed = reflowDialogueLayout(projectId, pageId, { seed: 9, fontScale: 0.88 });
  assert.equal(reflowed.unplacedPlacementIds.length, 0);
  const balloons = pageObjectsJson(pageId).filter(
    (object): object is Extract<PageObject, { kind: "balloon" }> => object.kind === "balloon"
  );
  assert.ok(balloons.length > 0);
  for (const balloon of balloons) {
    assert.ok(balloon.content, "本文を維持すること");
    // DEFAULT_TEXT_STYLE.size(0.04) × 0.88。fontScale が無視されると 0.04 に戻ってしまう。
    assert.ok(Math.abs(balloon.content!.style.size - 0.04 * 0.88) < 1e-9, `size=${balloon.content!.style.size}`);
  }
});
