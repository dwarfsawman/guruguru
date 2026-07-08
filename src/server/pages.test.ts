import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRecentImages } from "./pages.ts";
import type { RecentReferenceImage } from "../shared/apiTypes.ts";

// 「最近使った画像」の混在マージ(重複排除は呼び出し側で済ませる前提)の純関数を pin する。
// See Docs/Feature-BookCommonSettings.md / Part 1。

function ref(url: string, createdAt: string): RecentReferenceImage {
  return { kind: "reference", url, thumbnailUrl: url, createdAt };
}

function asset(id: string, createdAt: string): RecentReferenceImage {
  return { kind: "asset", url: `/api/assets/${id}/image`, thumbnailUrl: `/api/assets/${id}/thumbnail?size=small`, createdAt };
}

test("mergeRecentImages: 参照と生成を createdAt 降順で混在させる", () => {
  const references = [ref("r-a", "2026-07-09T10:00:00Z"), ref("r-b", "2026-07-09T08:00:00Z")];
  const assets = [asset("s-1", "2026-07-09T11:00:00Z"), asset("s-2", "2026-07-09T09:00:00Z")];
  const merged = mergeRecentImages(references, assets, 10);
  assert.deepEqual(
    merged.map((image) => image.createdAt),
    ["2026-07-09T11:00:00Z", "2026-07-09T10:00:00Z", "2026-07-09T09:00:00Z", "2026-07-09T08:00:00Z"]
  );
  assert.deepEqual(merged.map((image) => image.kind), ["asset", "reference", "asset", "reference"]);
});

test("mergeRecentImages: limit で新しい順に打ち切る", () => {
  const references = [ref("r-a", "2026-07-09T10:00:00Z")];
  const assets = [
    asset("s-1", "2026-07-09T12:00:00Z"),
    asset("s-2", "2026-07-09T11:00:00Z"),
    asset("s-3", "2026-07-09T09:00:00Z")
  ];
  const merged = mergeRecentImages(references, assets, 2);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((image) => image.url), ["/api/assets/s-1/image", "/api/assets/s-2/image"]);
});

test("mergeRecentImages: limit 0 は空、負値も空", () => {
  const references = [ref("r-a", "2026-07-09T10:00:00Z")];
  assert.deepEqual(mergeRecentImages(references, [], 0), []);
  assert.deepEqual(mergeRecentImages(references, [], -3), []);
});

test("mergeRecentImages: 片方が空でも安全", () => {
  const assets = [asset("s-1", "2026-07-09T12:00:00Z")];
  assert.deepEqual(mergeRecentImages([], assets, 5), assets);
  assert.deepEqual(mergeRecentImages(assets, [], 5), assets);
});
