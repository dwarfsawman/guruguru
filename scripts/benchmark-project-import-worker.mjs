import { performance } from "node:perf_hooks";

const [archivePath, engine, transport = "archive"] = process.argv.slice(2);
if (!archivePath || (engine !== "rust" && engine !== "jszip") || (transport !== "archive" && transport !== "stream")) {
  throw new Error("usage: bun scripts/benchmark-project-import-worker.mjs <archive.guruzip> <rust|jszip> <archive|stream>");
}
if (process.env.GURUGURU_TEST_DB !== "1" || !process.env.GURUGURU_TEST_DATA_DIR) {
  throw new Error("benchmark worker requires GURUGURU_TEST_DB=1 and GURUGURU_TEST_DATA_DIR");
}

const { initializeDb } = await import("../src/server/db.ts");
const { importProjectFromArchive, importProjectFromStream } = await import("../src/server/projectTransfer.ts");
initializeDb();
Bun.gc(true);

const initialRss = process.memoryUsage().rss;
let peakRss = initialRss;
const sampleRss = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const sampler = setInterval(sampleRss, 5);
const startedAt = performance.now();
try {
  const result = transport === "stream"
    ? await importProjectFromStream((await import("node:fs")).createReadStream(archivePath), { engine })
    : await importProjectFromArchive(archivePath, { engine });
  sampleRss();
  const wallMs = performance.now() - startedAt;
  const endRss = process.memoryUsage().rss;
  console.log(
    `GURUZIP_BENCHMARK_RESULT=${JSON.stringify({
      engine,
      transport,
      archiveBufferMiB: Number(process.env.GURUGURU_ARCHIVE_BUFFER_MIB ?? 10),
      wallMs,
      initialRss,
      peakRss,
      endRss,
      rssScope: "bun-parent",
      importedProjectId: String(result.project.id)
    })}`
  );
} finally {
  clearInterval(sampler);
}
