import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
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

  await copyFile(join(root, "src", "client", "index.html"), join(root, "dist", "public", "index.html"));
  await copyFile(join(root, "src", "client", "styles.css"), join(root, "dist", "public", "styles.css"));
  await copyFile(join(root, "src", "client", "spiral.svg"), join(root, "dist", "public", "spiral.svg"));
  await copyOrtRuntimeAssets();
  await copyMediapipeWasmAssets();
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
