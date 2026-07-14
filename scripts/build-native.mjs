import { copyFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "..");
const manifestPath = join(root, "native", "guruzip-archive", "Cargo.toml");
const executableName = process.platform === "win32" ? "guruzip-archive.exe" : "guruzip-archive";

export async function buildNative({ copyToDist = true } = {}) {
  const child = Bun.spawn(
    ["cargo", "build", "--locked", "--release", "--manifest-path", manifestPath],
    { cwd: root, stdout: "inherit", stderr: "inherit" }
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`cargo build failed with code ${exitCode}`);
  }
  if (!copyToDist) {
    return;
  }
  const source = join(root, "native", "guruzip-archive", "target", "release", executableName);
  const destinationDir = join(root, "dist", "native");
  await mkdir(destinationDir, { recursive: true });
  await copyFile(source, join(destinationDir, executableName));
}

if (import.meta.main) {
  buildNative().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
