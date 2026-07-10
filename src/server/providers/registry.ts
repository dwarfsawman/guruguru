import { HttpError } from "../http";
import { comfyProvider } from "./comfyProvider";
import type { GenerationProvider } from "./types";

const providers = new Map<string, GenerationProvider>([[comfyProvider.id, comfyProvider]]);

export function getProvider(id: string): GenerationProvider {
  const provider = providers.get(id);
  if (!provider) {
    throw new HttpError(400, `Unknown generation provider: ${id}`);
  }
  return provider;
}

export function listProviders(): GenerationProvider[] {
  return [...providers.values()];
}
