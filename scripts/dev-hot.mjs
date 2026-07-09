import { createServer } from "node:http";
import { existsSync, watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildAll } from "./build.mjs";

const root = resolve(".");
const appPort = Number(process.env.PORT ?? 5177);
const reloadPort = Number(process.env.GURUGURU_RELOAD_PORT ?? appPort + 1);
const bunExecutable = process.execPath;
const watchedDirs = ["src", "scripts"];

let appProcess = null;
let rebuildTimer = null;
let rebuilding = false;
let rebuildAgain = false;
let shuttingDown = false;
const watchers = [];
const liveReloadClients = new Set();

const liveReloadServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (url.pathname !== "/events") {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "access-control-allow-origin": "*"
  });
  res.write("retry: 1000\n\n");
  liveReloadClients.add(res);
  req.on("close", () => {
    liveReloadClients.delete(res);
  });
});

liveReloadServer.listen(reloadPort, "127.0.0.1", () => {
  console.log(`Live reload listening on http://127.0.0.1:${reloadPort}/events`);
});

await rebuild("initial build");
startWatchers();
setupShutdown();

if (process.stdin.isTTY) {
  console.log("Watching src/ and scripts/. Press q or Ctrl+C to stop.");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    const key = chunk.toString("utf8");
    if (key === "q" || key === "\u0003") {
      void shutdown();
    }
  });
}

function startWatchers() {
  for (const dir of watchedDirs) {
    const path = join(root, dir);
    if (!existsSync(path)) {
      continue;
    }
    const watcher = watch(path, { recursive: true }, (_event, filename) => {
      const changed = filename ? `${dir}/${String(filename).replaceAll("\\", "/")}` : dir;
      if (shouldIgnoreChange(changed)) {
        return;
      }
      scheduleRebuild(changed);
    });
    watchers.push(watcher);
  }
}

function shouldIgnoreChange(path) {
  return path.includes("/.") || path.endsWith("~") || path.endsWith(".tmp") || path.endsWith(".log");
}

function scheduleRebuild(reason) {
  if (shuttingDown) {
    return;
  }
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    void rebuild(reason);
  }, 120);
}

async function rebuild(reason) {
  if (rebuilding) {
    rebuildAgain = true;
    return;
  }
  rebuilding = true;
  try {
    console.log(`\n[dev] Rebuilding (${reason})...`);
    await buildAll();
    await injectLiveReloadSnippet();
    await restartAppServer();
    broadcastReload();
    console.log("[dev] Ready.");
  } catch (error) {
    console.error("[dev] Rebuild failed:");
    console.error(error);
  } finally {
    rebuilding = false;
    if (rebuildAgain && !shuttingDown) {
      rebuildAgain = false;
      await rebuild("queued change");
    }
  }
}

async function injectLiveReloadSnippet() {
  const indexPath = join(root, "dist", "public", "index.html");
  const html = await readFile(indexPath, "utf8");
  const marker = "<!-- guruguru-dev-live-reload -->";
  if (html.includes(marker)) {
    return;
  }
  const snippet = `
    ${marker}
    <script>
      (() => {
        const source = new EventSource("http://127.0.0.1:${reloadPort}/events");
        source.onmessage = (event) => {
          if (event.data === "reload") window.location.reload();
        };
      })();
    </script>
`;
  await writeFile(indexPath, html.replace("</body>", `${snippet}  </body>`));
}

async function restartAppServer() {
  await stopAppServer();
  if (shuttingDown) {
    return;
  }
  const env = { ...process.env, PORT: String(appPort) };
  appProcess = Bun.spawn({
    cmd: [bunExecutable, "./dist/server/index.js"],
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit"
  });
  const processRef = appProcess;
  processRef.exited.then((code) => {
    if (!shuttingDown && appProcess === processRef) {
      console.error(`[dev] App server exited with code ${code}.`);
    }
  });
  await sleep(250);
}

async function stopAppServer() {
  if (!appProcess) {
    return;
  }
  const processRef = appProcess;
  appProcess = null;
  processRef.kill();
  await Promise.race([
    processRef.exited,
    sleep(2000).then(() => {
      try {
        processRef.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
    })
  ]);
}

function broadcastReload() {
  for (const client of liveReloadClients) {
    client.write("data: reload\n\n");
  }
}

function setupShutdown() {
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearTimeout(rebuildTimer);
  for (const watcher of watchers) {
    watcher.close();
  }
  for (const client of liveReloadClients) {
    client.end();
  }
  liveReloadClients.clear();
  liveReloadServer.close();
  await stopAppServer();
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
