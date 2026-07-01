/**
 * Bootstrap loaded via `node --import` (see `npm test` in package.json).
 * Registers `test-resolve-hook.mjs` using the non-experimental `module.register()`
 * API so that `--experimental-loader`'s deprecation warning is avoided.
 */
import { register } from "node:module";

register("./test-resolve-hook.mjs", import.meta.url);
