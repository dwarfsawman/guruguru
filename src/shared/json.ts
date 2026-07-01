/**
 * Plain JSON object type shared by client, server, and shared modules.
 * Represents a non-null, non-array JSON object.
 */
export type Json = Record<string, unknown>;

/**
 * Type guard for a plain JSON object (non-null, non-array).
 * Used by client (`src/client/json.ts`), server (`src/server/validate.ts`),
 * and shared workflow modules to avoid divergent implementations.
 */
export function isJsonObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
