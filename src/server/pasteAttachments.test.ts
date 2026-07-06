import { test } from "node:test";
import assert from "node:assert/strict";
import { pasteSourceExtension, pasteSourceUrl } from "./pasteAttachments.ts";

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
