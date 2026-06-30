# Repository Instructions

- Runtime user data, including `app.db`, generated assets, prompts, workflow snapshots, and thumbnails, must stay outside this repository.
- The app defaults to the OS user data directory (`%LOCALAPPDATA%\GURUGURU` on Windows). Set `GURUGURU_DATA_DIR` only to a path outside the repository.
- Do not access, inspect, list, dump, query, or summarize the runtime user data directory or its database unless the user explicitly asks for data migration or recovery.
- Commands or tests that initialize the database must use a test database by setting `GURUGURU_TEST_DB=1`. Use `GURUGURU_TEST_DATA_DIR` for an explicit temporary test location when needed.
- Never run tests, checks, scripts, or local experiments against the production user database.
- Do not create or use a project-local runtime database. If a command refuses a repository-local data directory, fix the environment to use an external or test data directory.
