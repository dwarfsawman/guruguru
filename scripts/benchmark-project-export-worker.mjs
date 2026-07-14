import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const [archivePath, engine, bufferMiB = "1"] = process.argv.slice(2);
if (!archivePath || (engine !== "rust" && engine !== "jszip")) {
  throw new Error("usage: bun scripts/benchmark-project-export-worker.mjs <archive.guruzip> <rust|jszip> <bufferMiB>");
}
if (process.env.GURUGURU_TEST_DB !== "1" || !process.env.GURUGURU_TEST_DATA_DIR) {
  throw new Error("benchmark worker requires GURUGURU_TEST_DB=1 and GURUGURU_TEST_DATA_DIR");
}
process.env.GURUGURU_ARCHIVE_BUFFER_MIB = bufferMiB;

const { initializeDb } = await import("../src/server/db.ts");
const { exportProject, importProjectFromArchive, withProjectExportArchive } = await import(
  "../src/server/projectTransfer.ts"
);
initializeDb();
const seeded = await importProjectFromArchive(archivePath, { engine: "rust" });
const projectId = String(seeded.project.id);
Bun.gc(true);

const initialRss = process.memoryUsage().rss;
let peakRss = initialRss;
const sampleRss = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const sampler = setInterval(sampleRss, 5);
const startedAt = performance.now();
let processMs = 0;
let wallMs = 0;
let archiveBytes = 0;
let endRss = initialRss;
try {
  if (engine === "jszip") {
    const result = await exportProject(projectId, { engine: "jszip" });
    processMs = performance.now() - startedAt;
    const outputPath = join(process.env.GURUGURU_TEST_DATA_DIR, "benchmark-jszip.guruzip");
    await writeFile(outputPath, result.buffer, { flag: "wx" });
    wallMs = performance.now() - startedAt;
    archiveBytes = result.buffer.byteLength;
    sampleRss();
    endRss = process.memoryUsage().rss;
  } else {
    await withProjectExportArchive(
      projectId,
      async (archive) => {
        processMs = performance.now() - startedAt;
        wallMs = processMs;
        archiveBytes = archive.byteLength;
        sampleRss();
        endRss = process.memoryUsage().rss;
      },
      { engine: "rust" }
    );
  }
  console.log(
    `GURUZIP_EXPORT_BENCHMARK_RESULT=${JSON.stringify({
      engine,
      bufferMiB: Number(bufferMiB),
      processMs,
      wallMs,
      initialRss,
      peakRss,
      endRss,
      rssScope: "bun-parent",
      archiveBytes
    })}`
  );
} finally {
  clearInterval(sampler);
}
