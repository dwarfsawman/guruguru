import { defaultVlmAuditSettings, getSetting } from "./db";
import type { VlmAuditServiceStatus } from "../shared/scriptMangaApi";
import type { VlmAuditSettings } from "../shared/types";

interface LmStudioModel {
  key: string;
  loaded_instances?: Array<{ id?: unknown }>;
  capabilities?: { vision?: unknown };
}

interface LmStudioModelsResponse {
  models?: LmStudioModel[];
}

export interface VlmModelLease {
  settings: VlmAuditSettings;
  instanceId: string | null;
}

export function getVlmAuditSettings(): VlmAuditSettings {
  const saved = getSetting<Partial<VlmAuditSettings>>("vlm_audit") ?? {};
  return {
    ...defaultVlmAuditSettings,
    ...saved,
    baseUrl: (saved.baseUrl ?? defaultVlmAuditSettings.baseUrl).trim().replace(/\/+$/, ""),
    model: (saved.model ?? defaultVlmAuditSettings.model).trim(),
    modelKey: (saved.modelKey ?? defaultVlmAuditSettings.modelKey ?? saved.model ?? defaultVlmAuditSettings.model).trim()
  };
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export function lmStudioNativeBaseUrl(settings: VlmAuditSettings): string {
  return settings.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

async function lmStudioJson<T>(settings: VlmAuditSettings, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${lmStudioNativeBaseUrl(settings)}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}: ${text.slice(0, 240)}`);
    return JSON.parse(text) as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("LM Studio model operation timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function listLmStudioModels(settings: VlmAuditSettings): Promise<LmStudioModel[]> {
  const response = await lmStudioJson<LmStudioModelsResponse>(settings, "/api/v1/models", {}, 3500);
  return Array.isArray(response.models) ? response.models : [];
}

/** Loads the configured VLM on demand and returns the actual instance identifier used for inference. */
export async function acquireVlmModel(settings = getVlmAuditSettings()): Promise<VlmModelLease> {
  if (settings.transport !== "lmstudio-native" || settings.manageModelLifecycle === false) {
    return { settings, instanceId: null };
  }
  const modelKey = settings.modelKey?.trim() || settings.model.trim();
  const model = (await listLmStudioModels(settings)).find((candidate) => candidate.key === modelKey);
  if (!model) throw new Error(`LM Studio model is not downloaded: ${modelKey}`);
  if (model.capabilities?.vision !== true) throw new Error(`LM Studio model is not vision-capable: ${modelKey}`);
  const loaded = model.loaded_instances?.find((instance) => typeof instance.id === "string")?.id;
  if (typeof loaded === "string") {
    return { settings: { ...settings, model: loaded }, instanceId: loaded };
  }
  const response = await lmStudioJson<{ instance_id?: unknown }>(
    settings,
    "/api/v1/models/load",
    {
      method: "POST",
      body: JSON.stringify({
        model: modelKey,
        context_length: settings.contextLength ?? 4096,
        flash_attention: true,
        offload_kv_cache_to_gpu: false
      })
    },
    Math.max(30_000, settings.timeoutSeconds * 1000)
  );
  if (typeof response.instance_id !== "string" || !response.instance_id) {
    throw new Error("LM Studio did not return a loaded model instance id");
  }
  return { settings: { ...settings, model: response.instance_id }, instanceId: response.instance_id };
}

/** Releases only the VLM instance selected for this audit window. */
export async function releaseVlmModel(lease: VlmModelLease): Promise<void> {
  if (!lease.instanceId || lease.settings.transport !== "lmstudio-native" || lease.settings.unloadAfterAudit === false) return;
  await lmStudioJson(
    lease.settings,
    "/api/v1/models/unload",
    { method: "POST", body: JSON.stringify({ instance_id: lease.instanceId }) },
    30_000
  );
}

/** Readiness probe only: it never loads/unloads a model and never accesses generation content. */
export async function getVlmAuditStatus(settings = getVlmAuditSettings()): Promise<VlmAuditServiceStatus> {
  const checkedAt = new Date().toISOString();
  if (!settings.baseUrl || !settings.model) {
    return {
      ok: false,
      state: "unconfigured",
      baseUrl: settings.baseUrl,
      model: settings.model,
      checkedAt,
      loadedModelIds: [],
      error: "VLM audit base URL and model are required"
    };
  }
  try {
    if (settings.transport === "lmstudio-native") {
      const modelKey = settings.modelKey?.trim() || settings.model;
      const model = (await listLmStudioModels(settings)).find((candidate) => candidate.key === modelKey);
      if (!model || model.capabilities?.vision !== true) {
        return {
          ok: false,
          state: "model-not-loaded",
          baseUrl: settings.baseUrl,
          model: settings.model,
          checkedAt,
          loadedModelIds: [],
          error: model ? "Configured model is not vision-capable" : `Configured model is not downloaded: ${modelKey}`
        };
      }
      const loadedModelIds = (model.loaded_instances ?? [])
        .map((instance) => instance.id)
        .filter((id): id is string => typeof id === "string");
      const loaded = loadedModelIds.length > 0;
      const readyOnDemand = settings.manageModelLifecycle !== false;
      return {
        ok: loaded || readyOnDemand,
        state: loaded ? "ready" : "model-not-loaded",
        baseUrl: settings.baseUrl,
        model: settings.model,
        checkedAt,
        loadedModelIds,
        ...(loaded || readyOnDemand ? {} : { error: `Configured audit model is not loaded: ${modelKey}` })
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`${settings.baseUrl}/models`, { signal: controller.signal });
      if (!response.ok) throw new Error(`VLM server returned HTTP ${response.status}`);
      const json = await response.json() as { data?: Array<{ id?: unknown }> };
      const loadedModelIds = Array.isArray(json.data)
        ? json.data.map((item) => item?.id).filter((id): id is string => typeof id === "string")
        : [];
      const ready = loadedModelIds.includes(settings.model);
      return {
        ok: ready,
        state: ready ? "ready" : "model-not-loaded",
        baseUrl: settings.baseUrl,
        model: settings.model,
        checkedAt,
        loadedModelIds,
        ...(ready ? {} : { error: `Configured audit model is not loaded: ${settings.model}` })
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return {
      ok: false,
      state: "server-unreachable",
      baseUrl: settings.baseUrl,
      model: settings.model,
      checkedAt,
      loadedModelIds: [],
      error: message(error)
    };
  }
}
