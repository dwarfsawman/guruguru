import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(".");

async function main() {
  await rm(join(root, "dist"), { recursive: true, force: true });
  await mkdir(join(root, "dist", "server"), { recursive: true });
  await mkdir(join(root, "dist", "public"), { recursive: true });
  await mkdir(join(root, "dist", "public", "ort"), { recursive: true });
  await mkdir(join(root, "dist", "public", "mediapipe-wasm"), { recursive: true });

  await bundle({
    entrypoint: "src/server/index.ts",
    outfile: "dist/server/index.js",
    target: "bun",
    format: "esm"
  });

  await bundle({
    entrypoint: "src/client/main.ts",
    outfile: "dist/public/app.js",
    target: "browser",
    format: "esm"
  });

  await bundle({
    entrypoint: "src/client/websam/worker.ts",
    outfile: "dist/public/websam-worker.js",
    target: "browser",
    format: "esm"
  });

  await bundle({
    entrypoint: "src/client/pose/worker.ts",
    outfile: "dist/public/pose-worker.js",
    target: "browser",
    format: "iife"
  });

  await bundle({
    entrypoint: "src/client/pose/cigposeWorker.ts",
    outfile: "dist/public/pose-cigpose-worker.js",
    target: "browser",
    format: "esm"
  });

  await copyFile(join(root, "src", "client", "index.html"), join(root, "dist", "public", "index.html"));
  await bundleCss();
  await copyFile(join(root, "src", "client", "spiral.svg"), join(root, "dist", "public", "spiral.svg"));
  await copyFonts();
  await copyOrtRuntimeAssets();
  await copyMediapipeWasmAssets();
}

/**
 * src/client/styles/index.css の @import 行の順に各ファイルを素朴に連結して
 * dist/public/styles.css を出力する。Bun の CSS バンドルを使わないのは、
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

async function bundle(options) {
  const result = await Bun.build({
    entrypoints: [options.entrypoint],
    target: options.target,
    format: options.format,
    logLevel: "warning"
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  if (result.outputs.length !== 1) {
    throw new Error(`Expected one build output for ${options.entrypoint}, got ${result.outputs.length}`);
  }

  await Bun.write(join(root, options.outfile), result.outputs[0]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
