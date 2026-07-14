import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { HttpError } from "./http";
import { isPathInside } from "./paths";

export interface FileExportMetrics {
  kind: "images" | "openraster" | "pptx";
  format: string;
  renderMs: number;
  zipMs: number;
  responseMs: number;
  pageCount: number;
  inputBytes: number;
  outputBytes: number;
  peakRssBytes: number;
}

export interface FileExportResult {
  filename: string;
  contentType: string;
  artifactPath: string;
  byteLength: number;
  pageCount: number;
  metrics: FileExportMetrics;
}

type CreateFileExport = (tempDir: string, metrics: FileExportMetrics) => Promise<FileExportResult>;

/** 一時成果物をcallback完了まで保持し、render/pack/responseを分離計測する。 */
export async function withMeasuredFileExport<T>(
  purpose: string,
  kind: FileExportMetrics["kind"],
  format: string,
  create: CreateFileExport,
  operation: (artifact: FileExportResult) => Promise<T>
): Promise<T> {
  const metrics: FileExportMetrics = {
    kind,
    format,
    renderMs: 0,
    zipMs: 0,
    responseMs: 0,
    pageCount: 0,
    inputBytes: 0,
    outputBytes: 0,
    peakRssBytes: currentRssBytes()
  };
  const sampleRss = () => {
    metrics.peakRssBytes = Math.max(metrics.peakRssBytes, currentRssBytes());
  };
  const sampler = setInterval(sampleRss, 25);
  sampler.unref?.();
  let status: "ok" | "error" = "error";
  try {
    return await withFileExportTempDir(purpose, async (tempDir) => {
      const artifact = await create(tempDir, metrics);
      sampleRss();
      const responseStartedAt = performance.now();
      try {
        const result = await operation(artifact);
        status = "ok";
        return result;
      } finally {
        metrics.responseMs = performance.now() - responseStartedAt;
        sampleRss();
      }
    });
  } finally {
    clearInterval(sampler);
    sampleRss();
    console.info(`[export-metrics] ${JSON.stringify({ ...metrics, status })}`);
  }
}

export async function finalizeFileExport(
  result: Omit<FileExportResult, "byteLength">,
  emptyMessage: string
): Promise<FileExportResult> {
  const artifactStats = await stat(result.artifactPath);
  if (!artifactStats.isFile() || artifactStats.size === 0) {
    throw new HttpError(500, emptyMessage);
  }
  result.metrics.pageCount = result.pageCount;
  result.metrics.outputBytes = artifactStats.size;
  return { ...result, byteLength: artifactStats.size };
}

/** header送信後の失敗はJSONへ切り替えず、接続を閉じて一時成果物のcleanupへ進む。 */
export async function streamFileExport(res: ServerResponse, result: FileExportResult): Promise<void> {
  res.writeHead(200, {
    "content-type": result.contentType,
    "content-length": String(result.byteLength),
    "content-disposition": `attachment; filename="${result.filename}"`
  });
  try {
    await pipeline(createReadStream(result.artifactPath), res);
  } catch {
    if (!res.destroyed) {
      res.destroy();
    }
  }
}

async function withFileExportTempDir<T>(purpose: string, operation: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(resolve(tmpdir()), `guruguru-file-export-${purpose}-`));
  try {
    return await operation(dir);
  } finally {
    await removeFileExportTempDir(dir).catch(() => {});
  }
}

async function removeFileExportTempDir(dir: string): Promise<void> {
  const resolved = resolve(dir);
  const tempRoot = resolve(tmpdir());
  if (!isPathInside(resolved, tempRoot) || !basename(resolved).startsWith("guruguru-file-export-")) {
    throw new Error(`Refusing to remove unverified file export temp directory: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

function currentRssBytes(): number {
  try {
    return process.memoryUsage().rss;
  } catch {
    return 0;
  }
}
