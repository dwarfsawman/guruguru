import { createReadStream, mkdirSync } from "node:fs";
import { copyFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { dataRoot } from "./db";

export interface StoredImage {
  imagePath: string;
  thumbnailSmallPath: string;
  thumbnailMediumPath: string;
  width: number | null;
  height: number | null;
}

export function ensureProjectStorage(projectId: string) {
  const projectRoot = join(dataRoot, "projects", projectId);
  const paths = {
    projectRoot,
    original: join(projectRoot, "assets", "original"),
    thumbnails: join(projectRoot, "assets", "thumbnails"),
    workflows: join(projectRoot, "workflows"),
    exports: join(projectRoot, "exports")
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

export function safeFileStream(path: string) {
  const resolved = resolve(path);
  const root = resolve(dataRoot);
  if (!resolved.toLowerCase().startsWith(root.toLowerCase())) {
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

function readImageSize(bytes: Buffer): { width: number; height: number } | null {
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

function isPathInside(target: string, parent: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(target));
  return pathFromParent !== "" && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent);
}
