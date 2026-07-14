import { mkdtemp, rm, stat } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const archivePath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("usage: bun scripts/benchmark-project-import.mjs <archive.guruzip> [--repeat N] [--transport archive|stream] [--buffer-mib N]");
}
const repeatIndex = process.argv.indexOf("--repeat");
const repeat = repeatIndex >= 0 ? Number(process.argv[repeatIndex + 1]) : 1;
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
  throw new Error("--repeat must be an integer from 1 to 10");
}
const transportIndex = process.argv.indexOf("--transport");
const transport = transportIndex >= 0 ? process.argv[transportIndex + 1] : "archive";
if (transport !== "archive" && transport !== "stream") {
  throw new Error("--transport must be archive or stream");
}
const bufferIndex = process.argv.indexOf("--buffer-mib");
const bufferMiB = bufferIndex >= 0
  ? Number(process.argv[bufferIndex + 1])
  : Number(process.env.GURUGURU_ARCHIVE_BUFFER_MIB ?? 10);
if (!Number.isInteger(bufferMiB) || bufferMiB < 1 || bufferMiB > 64) {
  throw new Error("--buffer-mib must be an integer from 1 to 64");
}
if (!archivePath.toLowerCase().endsWith(".guruzip")) {
  throw new Error(`benchmark input must use the .guruzip extension: ${archivePath}`);
}
const archiveStat = await stat(archivePath);
if (!archiveStat.isFile() || archiveStat.size === 0) {
  throw new Error(`benchmark input is not a non-empty file: ${archivePath}`);
}

const root = resolve(import.meta.dir, "..");
const results = [];
for (let iteration = 0; iteration < repeat; iteration += 1) {
  const engines = iteration % 2 === 0 ? ["jszip", "rust"] : ["rust", "jszip"];
  for (const engine of engines) {
    results.push(await runBenchmark(engine, iteration));
  }
}

const mib = 1024 * 1024;
const summary = ["jszip", "rust"].map((engine) => {
  const engineResults = results.filter((result) => result.engine === engine);
  return {
    engine,
    runs: engineResults.length,
    medianSeconds: (median(engineResults.map((result) => result.wallMs)) / 1000).toFixed(3),
    medianPeakRssMiB: (median(engineResults.map((result) => result.peakRss)) / mib).toFixed(1),
    medianEndRssMiB: (median(engineResults.map((result) => result.endRss)) / mib).toFixed(1),
    medianRssIncreaseMiB: (median(engineResults.map((result) => result.peakRss - result.initialRss)) / mib).toFixed(1)
  };
});
console.table(summary);
console.log(JSON.stringify({ archivePath, archiveBytes: archiveStat.size, repeat, transport, bufferMiB, summary, results }, null, 2));

async function runBenchmark(engine, iteration) {
  const dataDir = await mkdtemp(join(resolve(tmpdir()), `guruzip-benchmark-${engine}-`));
  try {
    const child = Bun.spawn(
      ["bun", "scripts/benchmark-project-import-worker.mjs", archivePath, engine, transport],
      {
        cwd: root,
        env: {
          ...process.env,
          GURUGURU_TEST_DB: "1",
          GURUGURU_TEST_DATA_DIR: dataDir,
          GURUGURU_ARCHIVE_BUFFER_MIB: String(bufferMiB)
        },
        stdout: "pipe",
        stderr: "pipe"
      }
    );
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (exitCode !== 0) {
      throw new Error(`${engine} benchmark failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
    }
    const line = stdout
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith("GURUZIP_BENCHMARK_RESULT="));
    if (!line) {
      throw new Error(`${engine} benchmark did not return a result: ${stdout.trim()}`);
    }
    return { ...JSON.parse(line.slice("GURUZIP_BENCHMARK_RESULT=".length)), iteration };
  } finally {
    await removeBenchmarkDir(dataDir);
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function removeBenchmarkDir(path) {
  const resolved = resolve(path);
  const tempRoot = resolve(tmpdir());
  const safe =
    resolved.startsWith(`${tempRoot}\\`) ||
    resolved.startsWith(`${tempRoot}/`);
  if (!safe || !basename(resolved).startsWith("guruzip-benchmark-")) {
    throw new Error(`refusing to remove unverified benchmark directory: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}
