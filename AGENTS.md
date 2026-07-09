# Repository Instructions

- Runtime user data, including `app.db`, generated assets, prompts, workflow snapshots, and thumbnails, must stay outside this repository.
- The app defaults to the OS user data directory (`%LOCALAPPDATA%\GURUGURU` on Windows). Set `GURUGURU_DATA_DIR` only to a path outside the repository.
- Do not access, inspect, list, dump, query, or summarize the runtime user data directory or its database unless the user explicitly asks for data migration or recovery.
- Commands or tests that initialize the database must use a test database by setting `GURUGURU_TEST_DB=1`. Use `GURUGURU_TEST_DATA_DIR` for an explicit temporary test location when needed.
- Never run tests, checks, scripts, or local experiments against the production user database.
- Do not create or use a project-local runtime database. If a command refuses a repository-local data directory, fix the environment to use an external or test data directory.
- Reserve the default app port `5177` for user-run instances such as `bun run start`. When Codex starts the app for validation or debugging, set an explicit non-5177 `PORT` and run with `GURUGURU_TEST_DB=1`; use `GURUGURU_TEST_DATA_DIR` outside the repository when a stable test data directory is needed.
- Do not run multiple GURUGURU instances against the same production data directory. Multi-instance testing is acceptable only when each instance uses a separate port and a separate external test data directory.
- Treat the user's production ComfyUI instance (default port 8188) as production user data. Do not read endpoints that expose generation content — `/history` (workflows, prompts, seeds), `/view` (images) — and do not browse its input/output directories. Connectivity-level endpoints (`/queue`, `/system_stats`, `/object_info`) are acceptable. To diagnose errors, ask the user to share the error message from the UI, or reproduce on an isolated test ComfyUI instance (separate port and working directories). Ask before state-changing calls to the production instance (e.g. `/free`, `/interrupt`).
- For UI layout validation, explicitly check a wide browser viewport such as `1680x920` or `1600x900`, especially for sidebars, modals, and workflow/template panels. Confirm the viewport dimensions before judging the result, and reset any temporary viewport override after verification.

## Client Architecture

- Client app state lives in `src/client/appState.ts`. Modules must `import { state } from "./appState"` and request re-renders via `requestRender()`; never import `main.ts`.
- New stateful feature code goes into a dedicated controller module (`src/client/*Controller.ts` etc.), registering its `data-action` handlers with `registerActions({...})` and its DOM event wiring with `registerEventBinder(...)` from `src/client/actionRegistry.ts`.
- Do not add new functions to `src/client/main.ts`. It is the composition root (boot, `render`, and legacy code pending migration under the second refactoring plan, phases B-I).

## Documentation and Git

- Keep repository operation notes, usage steps, and recurring cautions in `操作メモ.md`. Keep it short: this file is read often, so put only what applies regardless of which feature is being touched, plus a changelog trimmed to recent entries (older entries get folded into a one-line monthly summary).
- Feature-specific internal implementation/behavior detail (how a subsystem currently works, not history) goes in `Docs/Reference-*.md` instead of `操作メモ.md`. These are living references overwritten in place as the code changes — they carry no changelog of their own.
- Completed-feature design docs and their implementation history/changelog live in `Docs/Done/*.md` (see `Docs/README.md`). In-progress feature design docs live at `Docs/*.md` until done, then move to `Docs/Done/`.
- When new procedures or cautions are discovered, add them to `操作メモ.md` instead of recreating a broad specification document. When new internal-behavior detail is discovered, add it to the relevant `Docs/Reference-*.md` (or create one) instead of growing `操作メモ.md`.
- When updating repository Markdown, also add a concise entry to the relevant change history section.
- After making coherent edits to this repository, proactively create a git commit when the change has been checked. Keep commits scoped and do not include unrelated user changes.
