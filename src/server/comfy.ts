import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { defaultComfySettings, getSetting } from "./db";
import type { ComfySettings } from "../shared/types";

export interface ComfyImageInfo {
  filename: string;
  subfolder?: string;
  type?: string;
}

export function getComfySettings(): ComfySettings {
  return {
    ...defaultComfySettings,
    ...(getSetting<Partial<ComfySettings>>("comfy") ?? {})
  };
}

export async function testComfyConnection() {
  const settings = getComfySettings();
  const result: Record<string, unknown> = {
    baseUrl: settings.baseUrl,
    websocketUrl: settings.websocketUrl,
    objectInfo: null,
    queue: null,
    websocket: null
  };

  try {
    const objectInfo = await comfyFetchJson("/object_info");
    result.objectInfo = {
      ok: true,
      nodeTypes: objectInfo && typeof objectInfo === "object" ? Object.keys(objectInfo).length : 0
    };
  } catch (error) {
    result.objectInfo = {
      ok: false,
      error: errorMessage(error)
    };
  }

  try {
    result.queue = {
      ok: true,
      value: await comfyFetchJson("/queue")
    };
  } catch (error) {
    result.queue = {
      ok: false,
      error: errorMessage(error)
    };
  }

  result.websocket = await testWebSocket(settings.websocketUrl);
  return result;
}

export async function getComfyStatus() {
  const settings = getComfySettings();
  try {
    await comfyFetchJson("/queue", {}, 1500);
    return {
      ok: true,
      state: "connected",
      baseUrl: settings.baseUrl,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      state: "disconnected",
      baseUrl: settings.baseUrl,
      checkedAt: new Date().toISOString(),
      error: errorMessage(error)
    };
  }
}

export async function queuePrompt(workflow: unknown) {
  const body = await comfyFetchJson("/prompt", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      prompt: workflow,
      client_id: `guruguru-${randomUUID()}`
    })
  });

  if (!body || typeof body !== "object" || typeof (body as { prompt_id?: unknown }).prompt_id !== "string") {
    throw new Error("ComfyUI /prompt response did not include prompt_id");
  }

  return (body as { prompt_id: string }).prompt_id;
}

export async function getHistory(promptId: string) {
  return comfyFetchJson(`/history/${encodeURIComponent(promptId)}`);
}

export async function fetchViewImage(info: ComfyImageInfo): Promise<Buffer> {
  const params = new URLSearchParams();
  params.set("filename", info.filename);
  params.set("type", info.type ?? "output");
  if (info.subfolder) {
    params.set("subfolder", info.subfolder);
  }

  const response = await comfyFetch(`/view?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`ComfyUI /view failed with ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function uploadImageToComfy(imagePath: string) {
  const bytes = await readFile(imagePath);
  const form = new FormData();
  form.set("image", new Blob([bytes]), basename(imagePath));
  form.set("type", "input");
  form.set("overwrite", "true");

  const body = await comfyFetchJson("/upload/image", {
    method: "POST",
    body: form
  });

  if (!body || typeof body !== "object") {
    throw new Error("ComfyUI /upload/image response was invalid");
  }

  const uploaded = body as { name?: unknown; filename?: unknown; subfolder?: unknown; type?: unknown };
  const name = typeof uploaded.name === "string"
    ? uploaded.name
    : typeof uploaded.filename === "string"
      ? uploaded.filename
      : basename(imagePath);

  return {
    name,
    subfolder: typeof uploaded.subfolder === "string" ? uploaded.subfolder : "",
    type: typeof uploaded.type === "string" ? uploaded.type : "input"
  };
}

async function comfyFetchJson(path: string, init: RequestInit = {}, timeoutMs?: number) {
  const response = await comfyFetch(path, init, timeoutMs);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`ComfyUI ${path} failed with ${response.status}: ${text}`);
  }

  return json;
}

async function comfyFetch(path: string, init: RequestInit = {}, timeoutMs?: number) {
  const settings = getComfySettings();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? settings.timeoutSeconds * 1000);

  try {
    const base = settings.baseUrl.replace(/\/+$/, "");
    return await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function testWebSocket(websocketUrl: string) {
  if (typeof WebSocket === "undefined") {
    return {
      ok: false,
      skipped: true,
      error: "WebSocket is not available in this Node runtime"
    };
  }

  return new Promise((resolve) => {
    let socket: WebSocket;
    const timeout = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // ignore close failures on timeout
      }
      resolve({
        ok: false,
        error: "WebSocket connection timed out"
      });
    }, 2500);

    try {
      socket = new WebSocket(websocketUrl);
    } catch (error) {
      clearTimeout(timeout);
      resolve({
        ok: false,
        error: errorMessage(error)
      });
      return;
    }
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      socket.close();
      resolve({ ok: true });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        error: "WebSocket connection failed"
      });
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
