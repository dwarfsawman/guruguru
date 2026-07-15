import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const port = process.env.GURUGURU_AGENT_PORT ?? process.env.PORT ?? "5199";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
  throw new Error(`Invalid agent port: ${port}`);
}
if (port === "5177") {
  throw new Error("PORT=5177 is reserved for the user-run instance");
}

const defaultRoot = process.env.LOCALAPPDATA
  ? resolve(process.env.LOCALAPPDATA, "GURUGURU-AGENT")
  : resolve(process.env.HOME ?? process.env.USERPROFILE ?? process.env.TEMP ?? process.env.TMP ?? ".", ".guruguru-agent");
const dataDir = resolve(process.env.GURUGURU_AGENT_DATA_DIR ?? defaultRoot);
const repoRoot = resolve(import.meta.dir, "..");
if (dataDir === repoRoot || dataDir.startsWith(`${repoRoot}\\`) || dataDir.startsWith(`${repoRoot}/`)) {
  throw new Error("GURUGURU_AGENT_DATA_DIR must be outside the repository");
}
mkdirSync(dataDir, { recursive: true });

const childEnv = {
  ...process.env,
  HOST: process.env.HOST ?? "127.0.0.1",
  PORT: port,
  GURUGURU_INSTANCE_MODE: "agent",
  GURUGURU_DATA_DIR: dataDir,
  GURUGURU_DEFAULT_COMFY_BASE_URL:
    process.env.GURUGURU_DEFAULT_COMFY_BASE_URL ?? "http://127.0.0.1:8288",
  GURUGURU_DEFAULT_COMFY_WEBSOCKET_URL:
    process.env.GURUGURU_DEFAULT_COMFY_WEBSOCKET_URL ?? "ws://127.0.0.1:8288/ws"
};
// An agent instance is a persistent, isolated normal database. Never inherit test-mode switches
// from the invoking shell, because that would silently change its storage semantics.
delete childEnv.GURUGURU_TEST_DB;
delete childEnv.GURUGURU_TEST_DATA_DIR;
delete childEnv.NODE_ENV;

console.log(`Starting agent GURUGURU on http://${childEnv.HOST}:${port}`);
console.log(`Agent data: ${dataDir}`);
console.log(`Default ComfyUI: ${childEnv.GURUGURU_DEFAULT_COMFY_BASE_URL}`);

if (process.env.GURUGURU_AGENT_DRY_RUN === "1") {
  process.exit(0);
}

const child = Bun.spawn(["bun", "run", "start"], {
  cwd: repoRoot,
  env: childEnv,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit"
});
process.exit(await child.exited);
