import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeImageDataUrl, decodeMaskDataUrl, normalizedUploadFileName } from "./uploadDataUrl.ts";
import { HttpError } from "./http.ts";

// Minimal 1x1 PNG (valid PNG magic bytes + IHDR/IDAT/IEND).
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAAC0lEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";
// Bytes starting with the JPEG SOI + APP0 marker (0xFF 0xD8 0xFF).
const JPEG_BASE64 = "/9j/4AAQSkZJRg==";
// Bytes starting with "RIFF"...."WEBP".
const WEBP_BASE64 = "UklGRiQAAABXRUJQAAAAAA==";

function assertHttpError(fn: () => unknown, status: number, messagePattern?: RegExp) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, status);
    if (messagePattern) {
      assert.match(error.message, messagePattern);
    }
    return true;
  });
}

test("decodeImageDataUrl: decodes a valid PNG data URL", () => {
  const result = decodeImageDataUrl(`data:image/png;base64,${PNG_BASE64}`);
  assert.equal(result.mimeType, "image/png");
  assert.ok(result.bytes.length > 0);
});

test("decodeImageDataUrl: decodes a valid JPEG data URL", () => {
  const result = decodeImageDataUrl(`data:image/jpeg;base64,${JPEG_BASE64}`);
  assert.equal(result.mimeType, "image/jpeg");
});

test("decodeImageDataUrl: decodes a valid WebP data URL", () => {
  const result = decodeImageDataUrl(`data:image/webp;base64,${WEBP_BASE64}`);
  assert.equal(result.mimeType, "image/webp");
});

test("decodeImageDataUrl: requires a non-empty dataUrl string", () => {
  assertHttpError(() => decodeImageDataUrl(undefined), 400, /dataUrl is required/);
  assertHttpError(() => decodeImageDataUrl(""), 400);
});

test("decodeImageDataUrl: rejects a malformed data URL shape", () => {
  assertHttpError(() => decodeImageDataUrl("not-a-data-url"), 400, /must be a base64 data URL/);
  assertHttpError(() => decodeImageDataUrl(`data:text/plain;base64,${PNG_BASE64}`), 400);
});

test("decodeImageDataUrl: rejects an empty (zero-byte) payload", () => {
  assertHttpError(() => decodeImageDataUrl("data:image/png;base64,"), 400, /must be a base64 data URL/);
});

test("decodeImageDataUrl: rejects payload whose bytes do not match the declared MIME type", () => {
  // Declares png but is actually jpeg bytes.
  assertHttpError(() => decodeImageDataUrl(`data:image/png;base64,${JPEG_BASE64}`), 400, /does not match the declared image MIME type/);
});

test("decodeImageDataUrl: rejects a payload above the 16MB source image size limit", () => {
  const bigBytes = Buffer.alloc(16 * 1024 * 1024 + 1, 0);
  bigBytes[0] = 0x89;
  bigBytes[1] = 0x50;
  bigBytes[2] = 0x4e;
  bigBytes[3] = 0x47;
  const dataUrl = `data:image/png;base64,${bigBytes.toString("base64")}`;
  assertHttpError(() => decodeImageDataUrl(dataUrl), 413, /too large/);
});

test("decodeMaskDataUrl: decodes a valid PNG mask data URL", () => {
  const result = decodeMaskDataUrl(`data:image/png;base64,${PNG_BASE64}`);
  assert.ok(result.bytes.length > 0);
});

test("decodeMaskDataUrl: requires a non-empty maskDataUrl string", () => {
  assertHttpError(() => decodeMaskDataUrl(undefined), 400, /inpaint\.maskDataUrl is required/);
});

test("decodeMaskDataUrl: only accepts image/png (rejects jpeg mime prefix)", () => {
  assertHttpError(() => decodeMaskDataUrl(`data:image/jpeg;base64,${JPEG_BASE64}`), 400, /must be a base64 PNG data URL/);
});

test("decodeMaskDataUrl: rejects payload whose bytes are not actually PNG", () => {
  assertHttpError(() => decodeMaskDataUrl(`data:image/png;base64,${JPEG_BASE64}`), 400, /not a PNG image/);
});

test("decodeMaskDataUrl: rejects a payload above the 8MB mask image size limit", () => {
  const bigBytes = Buffer.alloc(8 * 1024 * 1024 + 1, 0);
  bigBytes[0] = 0x89;
  bigBytes[1] = 0x50;
  bigBytes[2] = 0x4e;
  bigBytes[3] = 0x47;
  const dataUrl = `data:image/png;base64,${bigBytes.toString("base64")}`;
  assertHttpError(() => decodeMaskDataUrl(dataUrl), 413, /too large/);
});

test("normalizedUploadFileName: keeps filenames that already have a matching extension", () => {
  assert.equal(normalizedUploadFileName("photo.png", "image/png"), "photo.png");
  assert.equal(normalizedUploadFileName("photo.JPG", "image/jpeg"), "photo.JPG");
  assert.equal(normalizedUploadFileName("photo.webp", "image/webp"), "photo.webp");
});

test("normalizedUploadFileName: appends the correct extension when missing", () => {
  assert.equal(normalizedUploadFileName("photo", "image/png"), "photo.png");
  assert.equal(normalizedUploadFileName("photo", "image/jpeg"), "photo.jpg");
  assert.equal(normalizedUploadFileName("photo", "image/webp"), "photo.webp");
});

test("normalizedUploadFileName: falls back to 'source' for a blank filename", () => {
  assert.equal(normalizedUploadFileName("   ", "image/png"), "source.png");
  assert.equal(normalizedUploadFileName("", "image/jpeg"), "source.jpg");
});
