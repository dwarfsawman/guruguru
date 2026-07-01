export type Json = Record<string, unknown>;

export function parseJsonObjectText(text: string, label: string, allowEmpty = false): { value: Json | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed && allowEmpty) {
    return { value: {}, error: null };
  }
  if (!trimmed) {
    return { value: null, error: `${label}を入力してください。` };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!isJsonObject(parsed)) {
      return { value: null, error: `${label}のルートはJSON objectである必要があります。` };
    }
    return { value: parsed, error: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { value: null, error: `${label}をJSONとして読めません: ${detail}` };
  }
}

export function isJsonObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pickJsonObject(source: Json, key: string) {
  const value = source[key];
  return isJsonObject(value) ? value : null;
}
