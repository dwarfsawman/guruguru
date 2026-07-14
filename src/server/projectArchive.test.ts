import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { HttpError } from "./http.ts";
import { packArchiveWithRust } from "./projectArchive.ts";

test("Rust pack preserves entry order and STORE/DEFLATE choices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guruguru-pack-test-"));
  try {
    const mimetypePath = join(dir, "mimetype.txt");
    const imagePath = join(dir, "image.png");
    const xmlPath = join(dir, "stack.xml");
    await Promise.all([
      writeFile(mimetypePath, "image/openraster"),
      writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])),
      writeFile(xmlPath, "<stack>" + "text".repeat(200) + "</stack>")
    ]);
    const archivePath = join(dir, "result.zip");
    await packArchiveWithRust(
      [
        { source: mimetypePath, archivePath: "mimetype", compression: "store" },
        { source: imagePath, archivePath: "data/image.png", compression: "store" },
        { source: xmlPath, archivePath: "stack.xml", compression: "deflate" }
      ],
      archivePath,
      join(dir, "entries.json")
    );

    const bytes = await readFile(archivePath);
    const zip = await JSZip.loadAsync(bytes);
    assert.deepEqual(Object.keys(zip.files), ["mimetype", "data/image.png", "stack.xml"]);
    assert.equal(await zip.file("mimetype")!.async("string"), "image/openraster");
    assert.equal(localHeaderCompression(bytes, "mimetype"), 0);
    assert.equal(localHeaderCompression(bytes, "data/image.png"), 0);
    assert.equal(localHeaderCompression(bytes, "stack.xml"), 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Rust pack rejects duplicate and unsafe archive paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guruguru-pack-invalid-test-"));
  try {
    const source = join(dir, "source.txt");
    await writeFile(source, "data");
    await assert.rejects(
      () =>
        packArchiveWithRust(
          [
            { source, archivePath: "same.txt", compression: "store" },
            { source, archivePath: "same.txt", compression: "deflate" }
          ],
          join(dir, "duplicate.zip"),
          join(dir, "duplicate.json")
        ),
      (error: unknown) => error instanceof HttpError && /duplicate archive path/.test(error.message)
    );
    await assert.rejects(
      () =>
        packArchiveWithRust(
          [{ source, archivePath: "../escape.txt", compression: "store" }],
          join(dir, "unsafe.zip"),
          join(dir, "unsafe.json")
        ),
      (error: unknown) => error instanceof HttpError && /unsafe ZIP entry path/.test(error.message)
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function localHeaderCompression(bytes: Buffer, filename: string): number {
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let offset = 0;
  while ((offset = bytes.indexOf(signature, offset)) >= 0) {
    const nameLength = bytes.readUInt16LE(offset + 26);
    const name = bytes.toString("utf8", offset + 30, offset + 30 + nameLength);
    if (name === filename) {
      return bytes.readUInt16LE(offset + 8);
    }
    offset += 4;
  }
  throw new Error(`ZIP local header was not found: ${filename}`);
}
