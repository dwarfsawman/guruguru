# Repository Instructions

- Runtime user data, including `app.db`, generated assets, prompts, workflow snapshots, and thumbnails, must stay outside this repository.
- The app defaults to the OS user data directory (`%LOCALAPPDATA%\GURUGURU` on Windows). Set `GURUGURU_DATA_DIR` only to a path outside the repository.
- Do not access, inspect, list, dump, query, or summarize the runtime user data directory or its database unless the user explicitly asks for data migration or recovery.
- Commands or tests that initialize the database must use a test database by setting `GURUGURU_TEST_DB=1`. Use `GURUGURU_TEST_DATA_DIR` for an explicit temporary test location when needed.
- Never run tests, checks, scripts, or local experiments against the production user database.
- Do not create or use a project-local runtime database. If a command refuses a repository-local data directory, fix the environment to use an external or test data directory.
- Reserve the default app port `5177` for user-run instances such as `npm start`. When Codex starts the app for validation or debugging, set an explicit non-5177 `PORT` and run with `GURUGURU_TEST_DB=1`; use `GURUGURU_TEST_DATA_DIR` outside the repository when a stable test data directory is needed.
- Do not run multiple GURUGURU instances against the same production data directory. Multi-instance testing is acceptable only when each instance uses a separate port and a separate external test data directory.
- For UI layout validation, explicitly check a wide browser viewport such as `1680x920` or `1600x900`, especially for sidebars, modals, and workflow/template panels. Confirm the viewport dimensions before judging the result, and reset any temporary viewport override after verification.

## Documentation and Git

- Keep repository operation notes, usage steps, and recurring cautions in `操作メモ.md`.
- When new procedures or cautions are discovered, add them to `操作メモ.md` instead of recreating a broad specification document.
- When updating repository Markdown, also add a concise entry to the relevant change history section.
- After making coherent edits to this repository, proactively create a git commit when the change has been checked. Keep commits scoped and do not include unrelated user changes.
