export function nodeIdFromRolePath(rawPath: unknown): string | null {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return null;
  }
  return rawPath.split(".").filter(Boolean)[0] ?? null;
}
