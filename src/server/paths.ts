import { isAbsolute, relative, resolve } from "node:path";

/**
 * Strict path containment: returns true only when `target` resolves to a path
 * strictly below `parent` (i.e. a real child, never equal to `parent`).
 *
 * Use this for security boundaries where the target must live inside a parent
 * directory, such as serving a generated asset file or deleting project storage.
 *
 * This is intentionally based on `relative(resolve(parent), resolve(target))`
 * rather than a textual `startsWith(parent)` prefix check: a prefix check can be
 * bypassed by sibling paths that merely share a textual prefix (e.g.
 * `/data/evil` vs `/data`) and does not normalize Windows drive letters or
 * separators. `relative()` + `resolve()` normalize separators, reject `..`
 * escapes, and `isAbsolute()` rejects cross-drive targets on Windows.
 */
export function isPathInside(target: string, parent: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(target));
  return pathFromParent !== "" && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent);
}

/**
 * Inclusive path containment: returns true when `target` is strictly below
 * `parent` OR resolves to the exact same path as `parent`.
 *
 * Use this only when equality with the parent should be treated as "inside".
 * For example, the startup guard that refuses a data directory equal to (or
 * inside) the project repository root needs equality to count as "inside" so
 * that pointing `GURUGURU_DATA_DIR` at the repository itself is rejected.
 *
 * For normal file-serving / deletion boundaries prefer `isPathInside`, since
 * streaming or deleting the parent directory itself is never intended.
 */
export function isPathInsideOrEqual(target: string, parent: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(target));
  return pathFromParent === "" || (!!pathFromParent && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}
