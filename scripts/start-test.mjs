import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const port = process.env.PORT ?? "5199";
if (port === "5177") throw new Error("PORT=5177 is reserved for the user-run production instance");

const defaultRoot = process.env.LOCALAPPDATA
  ? resolve(process.env.LOCALAPPDATA, "GURUGURU-CODEX-TEST")
  : resolve(process.env.TEMP ?? process.env.TMP ?? ".", "GURUGURU-CODEX-TEST");
const dataDir = resolve(process.env.GURUGURU_TEST_DATA_DIR ?? defaultRoot);
const repoRoot = resolve(import.meta.dir, "..");
if (dataDir === repoRoot || dataDir.startsWith(`${repoRoot}\\`) || dataDir.startsWith(`${repoRoot}/`)) {
  throw new Error("GURUGURU_TEST_DATA_DIR must be outside the repository");
}
mkdirSync(dataDir, { recursive: true });

console.log(`Starting test GURUGURU on http://127.0.0.1:${port}`);
console.log(`Test data: ${dataDir}`);

const child = Bun.spawn(["bun", "run", "start"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: port,
    GURUGURU_TEST_DB: "1",
    GURUGURU_TEST_DATA_DIR: dataDir,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
