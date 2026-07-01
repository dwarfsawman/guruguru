import { DEFAULT_WEB_SAM_MODEL_BASE_URL } from "../shared/constants";
import { isJsonObject } from "../shared/json";
import { HttpError } from "./http";

export { isJsonObject };

/** Coerce a request value into a JSON object, rejecting non-object bodies with 400. */
export function objectBody(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return value;
}

/** Require a non-empty trimmed string, throwing 400 `${name} is required` otherwise. */
export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${name} is required`);
  }
  return value.trim();
}

/** Return `value` when it is a string, otherwise `fallback`. */
export function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Return a trimmed non-empty string from `value` (trailing slashes stripped).
 * Falls back to the trimmed `fallback`, or the default WebSAM base URL when that
 * fallback is also empty.
 */
export function nonEmptyStringOr(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim().replace(/\/+$/, "");
  }
  return fallback.trim() || DEFAULT_WEB_SAM_MODEL_BASE_URL;
}

/** Return a trimmed non-empty string from `value`, or null. */
export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Coerce a request value into a number, returning `fallback` when not finite. */
export function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

/** Coerce a request value into a positive integer (>= 1), clamping toward `fallback`. */
export function positiveIntegerOr(value: unknown, fallback: number): number {
  return Math.max(1, Math.trunc(numberOr(value, fallback)));
}
