import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPasteSourceIds, pasteSourceExtension, pasteSourceUrl } from "./pasteAttachments.ts";

// DB 依存のハンドラ本体は既存ハンドラ(sourceAssets 等)と同様に直接テストしない。
// ルーティングから参照される pure helper のみ characterization しておく。

test("pasteSourceExtension: maps accepted MIME types to extensions, defaulting to .png", () => {
  assert.equal(pasteSourceExtension("image/png"), ".png");
  assert.equal(pasteSourceExtension("image/jpeg"), ".jpg");
  assert.equal(pasteSourceExtension("image/webp"), ".webp");
  assert.equal(pasteSourceExtension("image/unknown"), ".png");
});

test("pasteSourceUrl: same-origin API path", () => {
  assert.equal(pasteSourceUrl("proj_1", "pastesrc_2"), "/api/projects/proj_1/paste-sources/pastesrc_2");
});

test("collectPasteSourceIds: reads sourceIds from an objects_json array", () => {
  const ids = collectPasteSourceIds([
    { id: "o1", sourceId: "pastesrc_a" },
    { id: "o2", sourceId: "pastesrc_b" },
    { id: "bad", sourceId: 42 },
    "garbage"
  ]);
  assert.deepEqual(ids, ["pastesrc_a", "pastesrc_b"]);
});

test("collectPasteSourceIds: reads sourceIds from a request_json (pasteComposite.objects)", () => {
  const ids = collectPasteSourceIds({
    templateId: "t",
    pasteComposite: { compositePath: "/x.png", objects: [{ id: "o1", sourceId: "pastesrc_c" }] }
  });
  assert.deepEqual(ids, ["pastesrc_c"]);
});

test("collectPasteSourceIds: empty for requests without pasteComposite or unexpected shapes", () => {
  assert.deepEqual(collectPasteSourceIds({ templateId: "t" }), []);
  assert.deepEqual(collectPasteSourceIds({ pasteComposite: null }), []);
  assert.deepEqual(collectPasteSourceIds(null), []);
  assert.deepEqual(collectPasteSourceIds("x"), []);
});
