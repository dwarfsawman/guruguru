import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const esbuild = process.platform === "win32"
  ? join(root, "node_modules", "@esbuild", "win32-x64", "esbuild.exe")
  : join(root, "node_modules", "@esbuild", "linux-x64", "bin", "esbuild");

if (!existsSync(esbuild)) {
  console.error(`esbuild binary was not found at ${esbuild}`);
  process.exit(1);
}

async function main() {
  await rm(join(root, "dist"), { recursive: true, force: true });
  await mkdir(join(root, "dist", "server"), { recursive: true });
  await mkdir(join(root, "dist", "public"), { recursive: true });
  await mkdir(join(root, "dist", "public", "ort"), { recursive: true });
  await mkdir(join(root, "dist", "public", "mediapipe-wasm"), { recursive: true });

  run([
    "src/server/index.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node24",
    "--outfile=dist/server/index.js",
    "--log-level=warning"
  ]);

  run([
    "src/client/main.ts",
    "--bundle",
    "--platform=browser",
    "--format=esm",
    "--target=es2022",
    "--outfile=dist/public/app.js",
    "--log-level=warning"
  ]);

  run([
    "src/client/websam/worker.ts",
    "--bundle",
    "--platform=browser",
    "--format=esm",
    "--target=es2022",
    "--outfile=dist/public/websam-worker.js",
    "--log-level=warning"
  ]);

  run([
    "src/client/pose/worker.ts",
    "--bundle",
    "--platform=browser",
    "--format=iife",
    "--target=es2022",
    "--outfile=dist/public/pose-worker.js",
    "--log-level=warning"
  ]);

  run([
    "src/client/pose/cigposeWorker.ts",
    "--bundle",
    "--platform=browser",
    "--format=esm",
    "--target=es2022",
    "--outfile=dist/public/pose-cigpose-worker.js",
    "--log-level=warning"
  ]);

  await copyFile(join(root, "src", "client", "index.html"), join(root, "dist", "public", "index.html"));
  await bundleCss();
  await copyFile(join(root, "src", "client", "spiral.svg"), join(root, "dist", "public", "spiral.svg"));
  await copyFonts();
  await copyOrtRuntimeAssets();
  await copyMediapipeWasmAssets();
}

/**
 * src/client/styles/index.css の @import 行の順に各ファイルを素朴に連結して
 * dist/public/styles.css を出力する。esbuild の CSS バンドルを使わないのは、
 * パース→再出力による書き換え（等価だが差分の出る整形変更）を避け、
 * ソースとの対応を 1:1 に保つため。カスケード順は index.css の記載順そのもの。
 */
async function bundleCss() {
  const stylesDir = join(root, "src", "client", "styles");
  const index = await readFile(join(stylesDir, "index.css"), "utf8");
  const imports = [...index.matchAll(/^@import\s+"\.\/([^"]+)";\s*$/gm)].map((m) => m[1]);
  if (imports.length === 0) {
    throw new Error("styles/index.css has no @import entries");
  }
  const chunks = [];
  for (const name of imports) {
    chunks.push(await readFile(join(stylesDir, name), "utf8"));
  }
  await writeFile(join(root, "dist", "public", "styles.css"), chunks.join(""));
}

async function copyFonts() {
  const sourceDir = join(root, "src", "client", "fonts");
  await mkdir(join(root, "dist", "public", "fonts"), { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(woff2|txt)$/i.test(entry.name)) {
      continue;
    }
    await copyFile(join(sourceDir, entry.name), join(root, "dist", "public", "fonts", entry.name));
  }
}

async function copyOrtRuntimeAssets() {
  const sourceDir = join(root, "node_modules", "onnxruntime-web", "dist");
  if (!existsSync(sourceDir)) {
    return;
  }
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!/\.(wasm|mjs|js)$/i.test(entry.name)) {
      continue;
    }
    await copyFile(join(sourceDir, entry.name), join(root, "dist", "public", "ort", entry.name));
  }
}

async function copyMediapipeWasmAssets() {
  const sourceDir = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
  if (!existsSync(sourceDir)) {
    return;
  }
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!/\.(wasm|js)$/i.test(entry.name)) {
      continue;
    }
    await copyFile(join(sourceDir, entry.name), join(root, "dist", "public", "mediapipe-wasm", entry.name));
  }
}

function run(args) {
  const result = spawnSync(esbuild, args, {
    cwd: root,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
