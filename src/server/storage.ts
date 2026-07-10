import { createReadStream, mkdirSync } from "node:fs";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { dataRoot } from "./db";
import { isPathInside } from "./paths";

export interface StoredImage {
  imagePath: string;
  thumbnailSmallPath: string;
  thumbnailMediumPath: string;
  width: number | null;
  height: number | null;
}

export interface StoredMask {
  maskPath: string;
  width: number | null;
  height: number | null;
}

export interface StoredControlImage {
  controlPath: string;
  width: number | null;
  height: number | null;
}

export interface StoredReferenceImage {
  referencePath: string;
  width: number | null;
  height: number | null;
}

export function ensureProjectStorage(projectId: string) {
  const projectRoot = join(dataRoot, "projects", projectId);
  const paths = {
    projectRoot,
    original: join(projectRoot, "assets", "original"),
    thumbnails: join(projectRoot, "assets", "thumbnails"),
    masks: join(projectRoot, "masks"),
    control: join(projectRoot, "control"),
    reference: join(projectRoot, "reference"),
    workflows: join(projectRoot, "workflows"),
    exports: join(projectRoot, "exports"),
    pasteSources: join(projectRoot, "paste_sources"),
    composites: join(projectRoot, "composites"),
    pageMedia: join(projectRoot, "page_media")
  };

  for (const path of Object.values(paths)) {
    mkdirSync(path, { recursive: true });
  }

  return paths;
}

export async function storeImage(projectId: string, roundId: string, batchIndex: number, sourceName: string, bytes: Buffer): Promise<StoredImage> {
  const storage = ensureProjectStorage(projectId);
  const ext = normalizeImageExtension(sourceName);
  const baseName = `${roundId}_${String(batchIndex).padStart(3, "0")}_${sanitizeBaseName(basename(sourceName, ext))}${ext}`;
  const imagePath = join(storage.original, baseName);
  const thumbnailSmallPath = join(storage.thumbnails, `small_${baseName}`);
  const thumbnailMediumPath = join(storage.thumbnails, `medium_${baseName}`);

  await writeFile(imagePath, bytes);
  await copyFile(imagePath, thumbnailSmallPath);
  await copyFile(imagePath, thumbnailMediumPath);

  const size = readImageSize(bytes);
  return {
    imagePath,
    thumbnailSmallPath,
    thumbnailMediumPath,
    width: size?.width ?? null,
    height: size?.height ?? null
  };
}

export async function storeMaskImage(projectId: string, roundId: string, bytes: Buffer): Promise<StoredMask> {
  const storage = ensureProjectStorage(projectId);
  const baseName = `${sanitizeBaseName(roundId)}_mask.png`;
  const maskPath = join(storage.masks, baseName);
  const resolvedMaskPath = resolve(maskPath);
  const resolvedProjectRoot = resolve(storage.projectRoot);

  if (!isPathInside(resolvedMaskPath, resolvedProjectRoot)) {
    throw new Error("Mask storage path is outside the project directory");
  }

  await writeFile(resolvedMaskPath, bytes);
  const size = readImageSize(bytes);
  return {
    maskPath: resolvedMaskPath,
    width: size?.width ?? null,
    height: size?.height ?? null
  };
}

export async function storeControlImage(projectId: string, roundId: string, bytes: Buffer): Promise<StoredControlImage> {
  const storage = ensureProjectStorage(projectId);
  const baseName = `${sanitizeBaseName(roundId)}_pose.png`;
  const controlPath = join(storage.control, baseName);
  const resolvedControlPath = resolve(controlPath);
  const resolvedProjectRoot = resolve(storage.projectRoot);

  if (!isPathInside(resolvedControlPath, resolvedProjectRoot)) {
    throw new Error("Control image storage path is outside the project directory");
  }

  await writeFile(resolvedControlPath, bytes);
  const size = readImageSize(bytes);
  return {
    controlPath: resolvedControlPath,
    width: size?.width ?? null,
    height: size?.height ?? null
  };
}

/**
 * 顔スタイル参照(PuLID)の参照画像を
 * `reference/<roundId><ext>` へ保存する(mask/control と同型のパイプライン)。
 */
export async function storeReferenceImage(projectId: string, roundId: string, ext: string, bytes: Buffer): Promise<StoredReferenceImage> {
  const storage = ensureProjectStorage(projectId);
  const baseName = `${sanitizeBaseName(roundId)}${ext}`;
  const referencePath = join(storage.reference, baseName);
  const resolvedReferencePath = resolve(referencePath);
  const resolvedProjectRoot = resolve(storage.projectRoot);

  if (!isPathInside(resolvedReferencePath, resolvedProjectRoot)) {
    throw new Error("Reference image storage path is outside the project directory");
  }

  await writeFile(resolvedReferencePath, bytes);
  const size = readImageSize(bytes);
  return {
    referencePath: resolvedReferencePath,
    width: size?.width ?? null,
    height: size?.height ?? null
  };
}

export interface StoredPasteSource {
  filePath: string;
  width: number | null;
  height: number | null;
}

export interface StoredComposite {
  compositePath: string;
  width: number | null;
  height: number | null;
}

/** 貼り付けソース画像を `paste_sources/<sourceId><ext>` へ保存する。 */
export async function storePasteSourceImage(projectId: string, sourceId: string, ext: string, bytes: Buffer): Promise<StoredPasteSource> {
  const storage = ensureProjectStorage(projectId);
  const baseName = `${sanitizeBaseName(sourceId)}${ext}`;
  const filePath = resolve(join(storage.pasteSources, baseName));
  if (!isPathInside(filePath, resolve(storage.projectRoot))) {
    throw new Error("Paste source storage path is outside the project directory");
  }
  await writeFile(filePath, bytes);
  const size = readImageSize(bytes);
  return { filePath, width: size?.width ?? null, height: size?.height ?? null };
}

/** 生成時のクライアント合成画像(貼り付け込み img2img 入力)を `composites/<roundId>_composite.png` へ保存する。 */
export async function storeCompositeImage(projectId: string, roundId: string, bytes: Buffer): Promise<StoredComposite> {
  const storage = ensureProjectStorage(projectId);
  const baseName = `${sanitizeBaseName(roundId)}_composite.png`;
  const compositePath = resolve(join(storage.composites, baseName));
  if (!isPathInside(compositePath, resolve(storage.projectRoot))) {
    throw new Error("Composite storage path is outside the project directory");
  }
  await writeFile(compositePath, bytes);
  const size = readImageSize(bytes);
  return { compositePath, width: size?.width ?? null, height: size?.height ?? null };
}

export interface StoredPageMedia {
  filePath: string;
  width: number | null;
  height: number | null;
}

/**
 * ページオブジェクトの ImageObject が参照する page 所有メディアへコピーする
 * (Docs/Feature-ScriptToManga.md S2: Asset 寿命問題対策)。`page_media/<mediaId><ext>` へ、
 * 元アセットのバイト列をそのまま複製する(以後 Round/Asset が削除されてもこのファイルは独立して残る)。
 */
export async function storePageMediaImage(projectId: string, mediaId: string, sourceImagePath: string): Promise<StoredPageMedia> {
  const storage = ensureProjectStorage(projectId);
  const ext = normalizeImageExtension(sourceImagePath);
  const baseName = `${sanitizeBaseName(mediaId)}${ext}`;
  const filePath = resolve(join(storage.pageMedia, baseName));
  if (!isPathInside(filePath, resolve(storage.projectRoot))) {
    throw new Error("Page media storage path is outside the project directory");
  }
  const bytes = await readFile(sourceImagePath);
  await writeFile(filePath, bytes);
  const size = readImageSize(bytes);
  return { filePath, width: size?.width ?? null, height: size?.height ?? null };
}

export function safeFileStream(path: string) {
  const resolved = resolve(path);
  if (!isPathInside(resolved, dataRoot)) {
    throw new Error("File is outside the data directory");
  }
  return createReadStream(resolved);
}

export async function deleteProjectStorage(projectRoot: string) {
  const resolvedProjectRoot = resolve(projectRoot);
  const projectsRoot = resolve(dataRoot, "projects");
  if (!isPathInside(resolvedProjectRoot, projectsRoot)) {
    throw new Error("Project storage path is outside the data directory");
  }
  await rm(resolvedProjectRoot, { recursive: true, force: true });
}

export function ensureParentDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function normalizeImageExtension(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
    return ext;
  }
  return ".png";
}

function sanitizeBaseName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "image";
}

export function readImageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.toString("ascii", 1, 4) === "PNG") {
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20)
    };
  }

  if (bytes.length >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7)
        };
      }
      offset += 2 + length;
    }
  }

  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunkType = bytes.toString("ascii", 12, 16);
    if (chunkType === "VP8X" && bytes.length >= 30) {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3)
      };
    }

    if (chunkType === "VP8 " && bytes.length >= 30) {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff
      };
    }

    if (chunkType === "VP8L" && bytes.length >= 25) {
      return {
        width: 1 + (((bytes[22]! & 0x3f) << 8) | bytes[21]!),
        height: 1 + (((bytes[24]! & 0x0f) << 10) | (bytes[23]! << 2) | ((bytes[22]! & 0xc0) >> 6))
      };
    }
  }

  return null;
}
