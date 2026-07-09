import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_JPEG_QUALITY,
  DEFAULT_PIXEL_WIDTH,
  MAX_PIXEL_WIDTH,
  MIN_PIXEL_WIDTH,
  clampJpegQuality,
  clampPixelWidth,
  computeExportCanvas,
  pageImageFileBase,
  parseImageExportFormat
} from "./imageExport.ts";
import { HttpError } from "./http.ts";

test("pageImageFileBase: page_index+1 を3桁ゼロ詰め", () => {
  assert.equal(pageImageFileBase(0), "001");
  assert.equal(pageImageFileBase(1), "002");
  assert.equal(pageImageFileBase(9), "010");
  assert.equal(pageImageFileBase(999), "1000");
});

test("pageImageFileBase: 負値や小数は 0 側へ丸める", () => {
  assert.equal(pageImageFileBase(-5), "001");
  assert.equal(pageImageFileBase(2.9), "003");
});

test("clampPixelWidth: 未指定/不正値は既定 1280", () => {
  assert.equal(clampPixelWidth(undefined), DEFAULT_PIXEL_WIDTH);
  assert.equal(clampPixelWidth(null), DEFAULT_PIXEL_WIDTH);
  assert.equal(clampPixelWidth("not-a-number"), DEFAULT_PIXEL_WIDTH);
  assert.equal(clampPixelWidth(Number.NaN), DEFAULT_PIXEL_WIDTH);
});

test("clampPixelWidth: 範囲外は 256〜4096 へ clamp", () => {
  assert.equal(clampPixelWidth(10), MIN_PIXEL_WIDTH);
  assert.equal(clampPixelWidth(100000), MAX_PIXEL_WIDTH);
  assert.equal(clampPixelWidth(2048), 2048);
  assert.equal(clampPixelWidth(2048.6), 2049);
});

test("clampJpegQuality: 未指定/不正値は既定 90", () => {
  assert.equal(clampJpegQuality(undefined), DEFAULT_JPEG_QUALITY);
  assert.equal(clampJpegQuality("bad"), DEFAULT_JPEG_QUALITY);
});

test("clampJpegQuality: 範囲外は 1〜100 へ clamp", () => {
  assert.equal(clampJpegQuality(0), 1);
  assert.equal(clampJpegQuality(-10), 1);
  assert.equal(clampJpegQuality(1000), 100);
  assert.equal(clampJpegQuality(55.4), 55);
});

test("parseImageExportFormat: png/jpeg 以外は 400", () => {
  assert.equal(parseImageExportFormat("png"), "png");
  assert.equal(parseImageExportFormat("jpeg"), "jpeg");
  assert.throws(() => parseImageExportFormat("gif"), (error: unknown) => error instanceof HttpError && error.statusCode === 400);
  assert.throws(() => parseImageExportFormat(undefined), (error: unknown) => error instanceof HttpError && error.statusCode === 400);
});

test("computeExportCanvas: pixelWidth × ページ高さ比 で解像度を計算", () => {
  assert.deepEqual(computeExportCanvas(1280, 1.4142), { width: 1280, height: Math.round(1280 * 1.4142) });
  assert.deepEqual(computeExportCanvas(1000, 0.5), { width: 1000, height: 500 });
});

test("computeExportCanvas: 高さは最小1px", () => {
  assert.deepEqual(computeExportCanvas(1000, 0), { width: 1000, height: 1 });
});
