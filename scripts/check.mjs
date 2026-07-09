import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(".");
const port = await findFreePort();
const dataDir = await mkdtemp(join(tmpdir(), "guruguru-check-"));

try {
  await runBun(["scripts/build.mjs"]);
  await smokeServer(port, dataDir);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

async function smokeServer(port, dataDir) {
  const server = Bun.spawn(["bun", "./dist/server/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      GURUGURU_TEST_DB: "1",
      GURUGURU_TEST_DATA_DIR: dataDir
    },
    stdout: "pipe",
    stderr: "pipe"
  });

  const stdout = readText(server.stdout);
  const stderr = readText(server.stderr);
  try {
    await waitForHealth(port);
  } catch (error) {
    server.kill();
    await Promise.race([server.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    const output = `${await stdout}${await stderr}`.trim();
    throw new Error(output || (error instanceof Error ? error.message : String(error)));
  } finally {
    server.kill();
    await Promise.race([server.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true) {
          return;
        }
      }
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError ?? new Error("health check timed out");
}

async function runBun(args) {
  const process = Bun.spawn(["bun", ...args], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit"
  });
  const code = await process.exited;
  if (code !== 0) {
    throw new Error(`bun ${args.join(" ")} failed with code ${code}`);
  }
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
        } else {
          reject(new Error("failed to allocate a free port"));
        }
      });
    });
  });
}

async function readText(stream) {
  return new Response(stream).text();
}
