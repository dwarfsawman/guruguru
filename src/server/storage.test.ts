import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { ensureAssetThumbnail, storeImage } from "./storage.ts";

test("storeImage writes bounded small and medium thumbnails", async () => {
  const source = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: "#dd8844" }
  }).jpeg({ quality: 95 }).toBuffer();
  const stored = await storeImage("thumbnail-test", "round", 0, "sample.jpg", source);

  const [small, medium] = await Promise.all([
    sharp(stored.thumbnailSmallPath).metadata(),
    sharp(stored.thumbnailMediumPath).metadata()
  ]);
  assert.ok(Math.max(small.width ?? 0, small.height ?? 0) <= 320);
  assert.ok(Math.max(medium.width ?? 0, medium.height ?? 0) <= 768);
  assert.ok((await stat(stored.thumbnailSmallPath)).size < source.byteLength);
});

test("ensureAssetThumbnail repairs a legacy full-size thumbnail copy", async () => {
  const source = await sharp({
    create: { width: 1400, height: 1000, channels: 3, background: "#4477bb" }
  }).png().toBuffer();
  const stored = await storeImage("thumbnail-repair-test", "round", 0, "sample.png", source);
  const legacyThumbnailPath = `${stored.thumbnailSmallPath}.legacy.png`;
  await writeFile(legacyThumbnailPath, source);

  await ensureAssetThumbnail(stored.imagePath, legacyThumbnailPath, "small");
  const repaired = await sharp(legacyThumbnailPath).metadata();
  assert.ok(Math.max(repaired.width ?? 0, repaired.height ?? 0) <= 320);
});
