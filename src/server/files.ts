import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataRoot } from "./db";
import { sendJson } from "./http";
import { isPathInside } from "./paths";
import { safeFileStream } from "./storage";

const publicDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "public");

export async function serveStatic(res: ServerResponse, pathname: string) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(join(publicDir, normalizedPath));
  if (!isPathInside(filePath, publicDir) || !isServableFile(filePath)) {
    const indexHtml = await readFile(join(publicDir, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(indexHtml);
    return;
  }
  streamFile(res, filePath);
}

/** Only regular files are streamable; directories would hang `createReadStream`. */
function isServableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function streamFile(res: ServerResponse, filePath: string) {
  const stream = isPathInside(filePath, dataRoot) ? safeFileStream(filePath) : createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      sendJson(res, 404, { error: "File was not found" });
      return;
    }
    // header送信後の失敗はJSONへ切り替えられないため、接続を閉じてクライアントのハングを防ぐ。
    if (!res.destroyed) {
      res.destroy();
    }
  });
  stream.once("open", () => {
    res.writeHead(200, { "content-type": contentTypeFor(filePath) });
    stream.pipe(res);
  });
}

export function contentTypeFor(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }
  if (ext === ".js") {
    return "text/javascript; charset=utf-8";
  }
  if (ext === ".mjs") {
    return "text/javascript; charset=utf-8";
  }
  if (ext === ".css") {
    return "text/css; charset=utf-8";
  }
  if (ext === ".woff2") {
    return "font/woff2";
  }
  if (ext === ".wasm") {
    return "application/wasm";
  }
  if (ext === ".onnx" || ext === ".ort") {
    return "application/octet-stream";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".svg") {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}
