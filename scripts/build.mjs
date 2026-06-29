import { copyFile, mkdir, rm } from "node:fs/promises";
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

  await copyFile(join(root, "src", "client", "index.html"), join(root, "dist", "public", "index.html"));
  await copyFile(join(root, "src", "client", "styles.css"), join(root, "dist", "public", "styles.css"));
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
