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

export async function queuePrompt(workflow: unknown, clientId = `guruguru-${randomUUID()}`) {
  const body = await comfyFetchJson("/prompt", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      prompt: workflow,
      client_id: clientId
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

export async function getQueue() {
  return comfyFetchJson("/queue");
}

export function isComfyQueueIdle(queue: unknown): boolean {
  if (!queue || typeof queue !== "object") return false;
  const value = queue as { queue_running?: unknown; queue_pending?: unknown };
  return Array.isArray(value.queue_running) && value.queue_running.length === 0 &&
    Array.isArray(value.queue_pending) && value.queue_pending.length === 0;
}

/** Explicit VRAM-swap mode only: unload cached ComfyUI models after confirming its global queue is idle. */
export async function releaseComfyModelsForAudit(): Promise<void> {
  const queue = await getQueue();
  if (!isComfyQueueIdle(queue)) {
    throw new Error("VLM audit is deferred because the ComfyUI queue is not idle");
  }
  await comfyFetchJson("/free", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unload_models: true, free_memory: true })
  });
}

/**
 * `/object_info/{classType}` の per-class 版。存在しない class を渡すと
 * ComfyUI は `{}` を返す(= ノード不在の判定を兼ねる)。呼び出し側
 * (`modelCheck.ts`)がネットワークエラーを個別に吸収する設計のため、
 * これ以上のエラーハンドリングはここでは行わない。
 */
export async function fetchComfyNodeInfo(classType: string) {
  return comfyFetchJson(`/object_info/${encodeURIComponent(classType)}`);
}

export async function deleteQueuedPrompts(promptIds: string[]) {
  if (promptIds.length === 0) {
    return null;
  }
  return comfyFetchJson("/queue", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      delete: promptIds
    })
  });
}

export async function interruptComfy() {
  return comfyFetchJson("/interrupt", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: "{}"
  });
}

export function openComfyWebSocket(clientId: string): WebSocket {
  const settings = getComfySettings();
  const url = new URL(settings.websocketUrl);
  url.searchParams.set("clientId", clientId);
  return new WebSocket(url.toString());
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
  return uploadImageBytesToComfy(await readFile(imagePath), basename(imagePath));
}

// 1x1 opaque black PNG. Unified-switch templates (Docs/ReferenceFlows/
// Reference-UnifiedSwitchWorkflow.md) keep every branch's LoadImage/LoadImageMask nodes in the
// graph even when a mode does not use them, and ComfyUI's prompt validation requires those
// filenames to exist regardless of lazy evaluation -- so this placeholder is uploaded once per
// process and written into every unused image input. Lazy evaluation ensures it is never read.
const DUMMY_IMAGE_NAME = "guruguru-dummy.png";
const DUMMY_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
let dummyImageNamePromise: Promise<string> | null = null;

export function ensureDummyComfyImage(): Promise<string> {
  if (!dummyImageNamePromise) {
    dummyImageNamePromise = uploadImageBytesToComfy(Buffer.from(DUMMY_IMAGE_BASE64, "base64"), DUMMY_IMAGE_NAME)
      .then((uploaded) => uploaded.name)
      .catch((error) => {
        // Drop the cached failure so a later generation retries (e.g. after a ComfyUI restart).
        dummyImageNamePromise = null;
        throw error;
      });
  }
  return dummyImageNamePromise;
}

async function uploadImageBytesToComfy(bytes: Buffer<ArrayBuffer>, filename: string) {
  const form = new FormData();
  form.set("image", new Blob([bytes]), filename);
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
      : filename;

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
