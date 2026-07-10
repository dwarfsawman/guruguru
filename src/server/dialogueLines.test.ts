import { test } from "node:test";
import assert from "node:assert/strict";
import { createDialoguePlacement, createDialogueLine, deleteDialoguePlacement } from "./dialogueLines.ts";
import { createPage, getPageDetail, updatePageLayout, updatePageObjects } from "./pages.ts";
import { createProject } from "./projects.ts";
import { initializeDb, getRow } from "./db.ts";
import { createBoxObject } from "../shared/pageObjects.ts";
import { HttpError } from "./http.ts";

function createTestProject() {
  initializeDb();
  const project = createProject({ name: "S3 dialogue placements", mode: "book" });
  assert.ok(project);
  return project!.id as string;
}

function twoPanelLayout() {
  return {
    version: 1,
    page: { aspectRatio: [1, 1.4], height: 1.4 },
    readingDirection: "rtl",
    panels: [
      { id: "panel_1", order: 1, shape: { type: "rect", bounds: [0, 0, 0.5, 0.7] } },
      { id: "panel_2", order: 2, shape: { type: "rect", bounds: [0.5, 0, 1, 0.7] } }
    ]
  };
}

test("createDialoguePlacement: 吹き出し生成と対で作成し、双方向リンクを持つ", () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  const line = createDialogueLine(projectId, { text: "こんにちは", speakerLabel: "太郎" });

  const result = createDialoguePlacement(line.id, { pageId: page.id });
  assert.equal(result.placement.lineId, line.id);
  assert.equal(result.placement.pageId, page.id);
  assert.equal(result.placement.panelId, null);
  assert.equal(result.placement.partIndex, 0);
  assert.equal(result.placement.renderKind, "balloon");
  assert.ok(result.placement.balloonObjectId);

  const balloon = result.objects.find((obj) => obj.id === result.placement.balloonObjectId);
  assert.ok(balloon);
  assert.equal(balloon!.kind, "balloon");
  assert.equal(balloon!.sourceDialogueLineId, line.id);
  assert.equal((balloon as { content?: { text: string } }).content?.text, "こんにちは");

  const detail = getPageDetail(projectId, page.id);
  assert.equal(detail.page.objects?.length, 1);
});

test("createDialoguePlacement: 同じ行を2回配置すると part_index がインクリメントされる(分割配置)", () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  const line = createDialogueLine(projectId, { text: "分割される台詞", speakerLabel: "太郎" });

  const first = createDialoguePlacement(line.id, { pageId: page.id });
  const second = createDialoguePlacement(line.id, { pageId: page.id });
  assert.equal(first.placement.partIndex, 0);
  assert.equal(second.placement.partIndex, 1);
  assert.equal(second.objects.length, 2);
});

test("createDialoguePlacement: panelId 指定はコマ中心に配置される", () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: twoPanelLayout() });
  const line = createDialogueLine(projectId, { text: "コマ内のセリフ", speakerLabel: "花子" });

  const result = createDialoguePlacement(line.id, { pageId: page.id, panelId: "panel_2" });
  assert.equal(result.placement.panelId, "panel_2");
  const balloon = result.objects.find((obj) => obj.id === result.placement.balloonObjectId)!;
  // panel_2 の bounds は [0.5,0,1,0.7] なので中心は (0.75, 0.35)。
  assert.ok(Math.abs(balloon.position.x - 0.75) < 1e-9);
  assert.ok(Math.abs(balloon.position.y - 0.35) < 1e-9);
});

test("createDialoguePlacement: 存在しない panelId は 400", () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: twoPanelLayout() });
  const line = createDialogueLine(projectId, { text: "テスト", speakerLabel: "太郎" });
  assert.throws(() => createDialoguePlacement(line.id, { pageId: page.id, panelId: "panel_missing" }), HttpError);
});

test("createDialoguePlacement: PAGE_OBJECTS_MAX_COUNT(300)超過時は配置を拒否する", () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  const filler = Array.from({ length: 300 }, (_, i) => createBoxObject(`obj_${i}`, { x: 0.5, y: 0.5 }));
  updatePageObjects(projectId, page.id, { objects: filler });
  const line = createDialogueLine(projectId, { text: "溢れる台詞", speakerLabel: "太郎" });
  assert.throws(() => createDialoguePlacement(line.id, { pageId: page.id }), HttpError);
});

test("deleteDialoguePlacement: placement と対応する PageObject を両方削除する", () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  const line = createDialogueLine(projectId, { text: "消される台詞", speakerLabel: "太郎" });
  const created = createDialoguePlacement(line.id, { pageId: page.id });

  deleteDialoguePlacement(created.placement.id);
  assert.equal(getRow("SELECT id FROM dialogue_placements WHERE id = ?", [created.placement.id]), null);

  const detail = getPageDetail(projectId, page.id);
  assert.equal(detail.page.objects?.find((obj) => obj.id === created.placement.balloonObjectId), undefined);
});

test("updatePageLayout: 消えたコマへの placement は panel_id が NULL 化される(placement/吹き出しは残る)", () => {
  const projectId = createTestProject();
  const page = createPage(projectId);
  updatePageLayout(projectId, page.id, { layout: twoPanelLayout() });
  const line = createDialogueLine(projectId, { text: "コマが消える台詞", speakerLabel: "太郎" });
  const created = createDialoguePlacement(line.id, { pageId: page.id, panelId: "panel_2" });

  // panel_2 を取り除いたレイアウトへ更新する。
  const shrunk = {
    ...twoPanelLayout(),
    panels: [{ id: "panel_1", order: 1, shape: { type: "rect", bounds: [0, 0, 1, 0.7] } }]
  };
  updatePageLayout(projectId, page.id, { layout: shrunk });

  const row = getRow<{ panel_id: string | null }>("SELECT panel_id FROM dialogue_placements WHERE id = ?", [
    created.placement.id
  ]);
  assert.equal(row!.panel_id, null);
  // placement 行・PageObject 自体は削除されない。
  assert.ok(getRow("SELECT id FROM dialogue_placements WHERE id = ?", [created.placement.id]));
  const detail = getPageDetail(projectId, page.id);
  assert.ok(detail.page.objects?.some((obj) => obj.id === created.placement.balloonObjectId));
});
