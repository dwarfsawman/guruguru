import { mkdtemp, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const archivePath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("usage: bun scripts/benchmark-project-export.mjs <archive.guruzip> [--repeat N]");
}
const repeatIndex = process.argv.indexOf("--repeat");
const repeat = repeatIndex >= 0 ? Number(process.argv[repeatIndex + 1]) : 1;
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
  throw new Error("--repeat must be an integer from 1 to 10");
}
if (!archivePath.toLowerCase().endsWith(".guruzip")) {
  throw new Error(`benchmark input must use the .guruzip extension: ${archivePath}`);
}
const archiveStat = await stat(archivePath);
if (!archiveStat.isFile() || archiveStat.size === 0) {
  throw new Error(`benchmark input is not a non-empty file: ${archivePath}`);
}

const root = resolve(import.meta.dir, "..");
const variants = [
  { label: "jszip", engine: "jszip", bufferMiB: 1 },
  { label: "rust-1mib", engine: "rust", bufferMiB: 1 },
  { label: "rust-10mib", engine: "rust", bufferMiB: 10 }
];
const results = [];
for (let iteration = 0; iteration < repeat; iteration += 1) {
  const ordered = rotate(variants, iteration);
  for (const variant of ordered) {
    results.push(await runBenchmark(variant, iteration));
  }
}

const mib = 1024 * 1024;
const summary = variants.map((variant) => {
  const matching = results.filter((result) => result.label === variant.label);
  return {
    variant: variant.label,
    runs: matching.length,
    medianProcessSeconds: (median(matching.map((result) => result.processMs)) / 1000).toFixed(3),
    medianDiskReadySeconds: (median(matching.map((result) => result.wallMs)) / 1000).toFixed(3),
    medianPeakRssMiB: (median(matching.map((result) => result.peakRss)) / mib).toFixed(1),
    medianEndRssMiB: (median(matching.map((result) => result.endRss)) / mib).toFixed(1),
    medianArchiveBytes: median(matching.map((result) => result.archiveBytes))
  };
});
console.table(summary);
console.log(JSON.stringify({ sourceArchive: archivePath, sourceBytes: archiveStat.size, repeat, summary, results }, null, 2));

async function runBenchmark(variant, iteration) {
  const dataDir = await mkdtemp(join(resolve(tmpdir()), `guruzip-export-benchmark-${variant.label}-`));
  try {
    const child = Bun.spawn(
      [
        "bun",
        "scripts/benchmark-project-export-worker.mjs",
        archivePath,
        variant.engine,
        String(variant.bufferMiB)
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          GURUGURU_TEST_DB: "1",
          GURUGURU_TEST_DATA_DIR: dataDir
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
      throw new Error(`${variant.label} benchmark failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
    }
    const line = stdout
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith("GURUZIP_EXPORT_BENCHMARK_RESULT="));
    if (!line) {
      throw new Error(`${variant.label} benchmark did not return a result: ${stdout.trim()}`);
    }
    return {
      ...JSON.parse(line.slice("GURUZIP_EXPORT_BENCHMARK_RESULT=".length)),
      label: variant.label,
      iteration
    };
  } finally {
    await removeBenchmarkDir(dataDir);
  }
}

function rotate(values, offset) {
  const index = offset % values.length;
  return [...values.slice(index), ...values.slice(0, index)];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function removeBenchmarkDir(path) {
  const resolved = resolve(path);
  const tempRoot = resolve(tmpdir());
  const safe = resolved.startsWith(`${tempRoot}\\`) || resolved.startsWith(`${tempRoot}/`);
  if (!safe || !basename(resolved).startsWith("guruzip-export-benchmark-")) {
    throw new Error(`refusing to remove unverified benchmark directory: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}
