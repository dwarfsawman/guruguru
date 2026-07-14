import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { HttpError } from "./http";
import { isPathInside } from "./paths";
import { ensureParentDir } from "./storage";

const PROJECT_FILE_IO_CONCURRENCY = 8;

export type ProjectArchiveEngine = "rust" | "jszip";

export interface ExtractedProjectArchive {
  manifestJson: string;
  dataJson: string;
  engine: ProjectArchiveEngine;
  fileCount: number;
  fileBytes?: number;
}

interface RustArchiveStats {
  files?: number;
  fileBytes?: number;
}

/**
 * `.guruzip` のメタデータを読み、files/ を新規 projectRoot へ展開する。
 * 通常経路はRust helperでZIPをディスクから逐次展開し、Nodeへ巨大Bufferを持ち込まない。
 * JSZip経路は性能比較と緊急切り戻しのために明示指定時だけ使う。
 */
export async function extractProjectArchive(
  archivePath: string,
  destinationRoot: string,
  metadataDir: string,
  engine: ProjectArchiveEngine = configuredProjectArchiveEngine()
): Promise<ExtractedProjectArchive> {
  return engine === "jszip"
    ? extractProjectArchiveWithJsZip(archivePath, destinationRoot)
    : extractProjectArchiveWithRust(archivePath, destinationRoot, metadataDir);
}

export function configuredProjectArchiveEngine(): ProjectArchiveEngine {
  const configured = process.env.GURUGURU_PROJECT_IMPORT_ENGINE?.trim().toLowerCase();
  if (!configured || configured === "rust") {
    return "rust";
  }
  if (configured === "jszip") {
    return "jszip";
  }
  throw new HttpError(500, `GURUGURU_PROJECT_IMPORT_ENGINE must be "rust" or "jszip" (received ${configured})`);
}

async function extractProjectArchiveWithRust(
  archivePath: string,
  destinationRoot: string,
  metadataDir: string
): Promise<ExtractedProjectArchive> {
  const executable = resolveNativeArchiveExecutable();
  const manifestPath = join(metadataDir, "manifest.json");
  const dataPath = join(metadataDir, "data.json");
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(
      [
        executable,
        "extract",
        "--archive",
        archivePath,
        "--destination",
        destinationRoot,
        "--manifest-out",
        manifestPath,
        "--data-out",
        dataPath
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
  } catch (error) {
    throw new HttpError(500, `Rust .guruzip extractorの起動に失敗しました: ${errorMessage(error)}`);
  }

  const stdoutPromise = new Response(child.stdout as ReadableStream<Uint8Array>).text();
  const stderrPromise = new Response(child.stderr as ReadableStream<Uint8Array>).text();
  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new HttpError(400, `アップロードされた .guruzip の展開に失敗しました: ${detail}`);
  }

  let stats: RustArchiveStats = {};
  try {
    stats = JSON.parse(stdout) as RustArchiveStats;
  } catch {
    // helperの統計は診断用。manifest/dataと展開結果があればインポート自体は続行できる。
  }
  return {
    manifestJson: await readFile(manifestPath, "utf8"),
    dataJson: await readFile(dataPath, "utf8"),
    engine: "rust",
    fileCount: typeof stats.files === "number" ? stats.files : 0,
    ...(typeof stats.fileBytes === "number" ? { fileBytes: stats.fileBytes } : {})
  };
}

function resolveNativeArchiveExecutable(): string {
  const executableName = process.platform === "win32" ? "guruzip-archive.exe" : "guruzip-archive";
  const configured = process.env.GURUGURU_ARCHIVE_BIN?.trim();
  const candidates = [
    configured ? resolve(configured) : null,
    resolve(process.cwd(), "dist", "native", executableName),
    resolve(process.cwd(), "native", "guruzip-archive", "target", "release", executableName),
    resolve(import.meta.dir, "..", "native", executableName),
    resolve(import.meta.dir, "..", "..", "native", "guruzip-archive", "target", "release", executableName)
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new HttpError(
      500,
      `Rust .guruzip extractorが見つかりません。bun run build:native を実行してください (${candidates.join(", ")})`
    );
  }
  return executable;
}

async function extractProjectArchiveWithJsZip(
  archivePath: string,
  destinationRoot: string
): Promise<ExtractedProjectArchive> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await readFile(archivePath));
  } catch {
    throw new HttpError(400, "アップロードされたファイルは有効な .guruzip(ZIP)ではありません。");
  }

  const manifestEntry = zip.file("manifest.json");
  const dataEntry = zip.file("data.json");
  if (!manifestEntry || !dataEntry) {
    throw new HttpError(400, ".guruzip に manifest.json / data.json が含まれていません。");
  }

  const fileEntries: Array<{ zipPath: string; relativePath: string }> = [];
  zip.forEach((entryPath, entry) => {
    if (entry.dir || !entryPath.startsWith("files/")) {
      return;
    }
    const relativePath = entryPath.slice("files/".length);
    assertSafeZipRelativePath(relativePath);
    fileEntries.push({ zipPath: entryPath, relativePath });
  });

  await forEachWithConcurrency(fileEntries, PROJECT_FILE_IO_CONCURRENCY, async (entry) => {
    const destPath = resolve(join(destinationRoot, entry.relativePath));
    if (!isPathInside(destPath, destinationRoot)) {
      throw new HttpError(400, "files/ 配下に不正なパスを検出しました。");
    }
    const bytes = await zip.file(entry.zipPath)!.async("nodebuffer");
    ensureParentDir(destPath);
    await writeFile(destPath, bytes);
  });

  return {
    manifestJson: await manifestEntry.async("string"),
    dataJson: await dataEntry.async("string"),
    engine: "jszip",
    fileCount: fileEntries.length
  };
}

/**
 * Zip Slip対策。Rust helperも同じ条件を独立に検査し、Node側のJSZip比較経路でも維持する。
 */
export function assertSafeZipRelativePath(relativePath: string) {
  if (!relativePath) {
    throw new HttpError(400, "files/ 配下に空のパスを検出しました。");
  }
  if (relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.includes(":")) {
    throw new HttpError(400, `files/ 配下に不正なパスを検出しました: ${relativePath}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new HttpError(400, `files/ 配下に不正なパスを検出しました: ${relativePath}`);
  }
}

/** 最初の失敗後も実行中workerを待ち、呼び出し側のstorage cleanupと競合させない。 */
async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown = null;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (firstError === null) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      try {
        await operation(items[index]!);
      } catch (error) {
        firstError ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== null) {
    throw firstError;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
