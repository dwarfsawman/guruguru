/**
 * Node ESM resolve hook used only by `npm test` (see package.json).
 *
 * Production source files use extensionless relative imports (e.g. `from "./json"`),
 * which is valid under `tsconfig.json`'s `moduleResolution: "Bundler"` and is what
 * `scripts/build.mjs` (esbuild) already resolves correctly. Node's native TypeScript
 * support (`node --test` running `.test.ts` files directly, no ts-node/tsx/jest)
 * follows plain ESM resolution rules instead, which require an explicit file
 * extension on relative specifiers. Without this hook, loading a test file that
 * imports a production module which itself imports another local module without
 * an extension (e.g. `src/shared/workflowRoleMap.ts` importing `./json`) fails with
 * ERR_MODULE_NOT_FOUND.
 *
 * This hook only changes how the test runner *locates* files on disk; it does not
 * change any production source file or its behavior.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const candidateExtensions = [".ts", ".js", ".mjs"];

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(".")) {
    return nextResolve(specifier, context);
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!(error && error.code === "ERR_MODULE_NOT_FOUND")) {
      throw error;
    }

    const base = new URL(specifier, context.parentURL);
    for (const extension of candidateExtensions) {
      const candidateUrl = base.href + extension;
      if (existsSync(fileURLToPath(candidateUrl))) {
        return nextResolve(candidateUrl, context);
      }
    }

    throw error;
  }
}
