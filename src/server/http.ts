import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Send a JSON response. No-op once headers have already been sent so that
 * concurrent error handling (e.g. mid-stream) does not corrupt the response.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

/**
 * Read and JSON.parse the request body. Empty bodies resolve to an empty
 * object so that handlers can treat missing bodies as `{}` uniformly.
 */
export async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

/** HTTP error carrying a status code, thrown by API handlers to short-circuit routing. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
  }
}
