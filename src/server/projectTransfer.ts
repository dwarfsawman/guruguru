/**
 * Project import / export (`.gguru`, Docs/Feature-ProjectImportExport.md). A `.gguru` file is a
 * plain ZIP (JSZip, same mechanism as ORA/PPTX export) containing:
 *   manifest.json  … format identification / counts / warnings
 *   data.json      … raw DB rows (snake_case, straight `SELECT *` dumps, not `toApiRow`)
 *   files/<rel>    … every file under the project's storage directory, relative to projectRoot
 *
 * Design notes (see spec for the authoritative rules):
 * - Path portability (§2): every string column value and every string leaf inside a JSON column
 *   is walked. Absolute paths under the old projectRoot become `gguru://project/<rel>` tokens on
 *   export, and are resolved back to `join(newProjectRoot, rel)` on import. This is done with one
 *   generic recursive walker (`rewriteStringLeaves`) shared by export and import, so no per-table
 *   path-column list needs to be maintained.
 * - ID remapping (§3): import gives every project-scoped row a fresh id (`createId`). Because the
 *   walker performs *exact* string-leaf replacement (never substring), and the id map is built
 *   from every scoped row's own `id` column, simply running every row (including FK columns like
 *   `round_id`/`page_id`/`character_id`) through the same walker with the id map remaps every
 *   foreign key automatically — no per-table FK column list needed either. Internal JSON ids that
 *   are *not* DB row ids (e.g. layout `panel_id`, `balloon_object_id`) are never present in the id
 *   map, so they pass through unchanged, matching the spec.
 * - Shared entities (workflow_templates / layout_templates / generation_presets) keep their
 *   original id: reused if already present in the target DB, inserted as-is otherwise.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import { createId, dataRoot, getRow, getRows, jsonColumnNames, runSql } from "./db";
import { HttpError } from "./http";
import { deleteProjectStorage, ensureParentDir, ensureProjectStorage } from "./storage";
import { isPathInside, isPathInsideOrEqual } from "./paths";
import { safeAsciiName } from "./openRasterExport";

const APP_ID = "guruguru";
const KIND = "project-export";
const FORMAT_VERSION = 1;
const GGURU_PREFIX = "gguru://project/";
const IMPORTED_WHILE_IN_PROGRESS = JSON.stringify({ message: "imported while in progress" });

/** Project-scoped table registry, in FK-safe insertion order (see file header). */
interface ScopedTable {
  table: string;
  selectSql: string;
  /** createId() prefix; absent for tables whose PK is a FK column (no own `id`). */
  idPrefix?: string;
}

const SCOPED_TABLES: ScopedTable[] = [
  { table: "manga_scripts", selectSql: `SELECT * FROM manga_scripts WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "script" },
  {
    table: "script_revisions",
    selectSql: `SELECT sr.* FROM script_revisions sr JOIN manga_scripts ms ON ms.id = sr.script_id WHERE ms.project_id = ? ORDER BY sr.created_at ASC`,
    idPrefix: "rev"
  },
  { table: "characters", selectSql: `SELECT * FROM characters WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "char" },
  {
    table: "character_bindings",
    selectSql: `SELECT cb.* FROM character_bindings cb JOIN characters c ON c.id = cb.character_id WHERE c.project_id = ? ORDER BY cb.created_at ASC`,
    idPrefix: "bind"
  },
  { table: "pages", selectSql: `SELECT * FROM pages WHERE project_id = ? ORDER BY page_index ASC`, idPrefix: "page" },
  { table: "script_manga_plans", selectSql: `SELECT * FROM script_manga_plans WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "manga_plan" },
  { table: "script_manga_runs", selectSql: `SELECT * FROM script_manga_runs WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "manga" },
  { table: "generation_rounds", selectSql: `SELECT * FROM generation_rounds WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "round" },
  { table: "generation_jobs", selectSql: `SELECT * FROM generation_jobs WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "job" },
  { table: "assets", selectSql: `SELECT * FROM assets WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "asset" },
  {
    table: "asset_parents",
    selectSql: `SELECT ap.* FROM asset_parents ap JOIN assets a ON a.id = ap.child_asset_id WHERE a.project_id = ? ORDER BY ap.created_at ASC`,
    idPrefix: "parent"
  },
  { table: "selection_events", selectSql: `SELECT * FROM selection_events WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "selection" },
  { table: "paste_sources", selectSql: `SELECT * FROM paste_sources WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "pastesrc" },
  {
    table: "asset_paste_attachments",
    selectSql: `SELECT apa.* FROM asset_paste_attachments apa JOIN assets a ON a.id = apa.asset_id WHERE a.project_id = ? ORDER BY apa.updated_at ASC`
  },
  {
    table: "page_panel_assignments",
    selectSql: `SELECT ppa.* FROM page_panel_assignments ppa JOIN pages p ON p.id = ppa.page_id WHERE p.project_id = ? ORDER BY ppa.created_at ASC`,
    idPrefix: "panelassign"
  },
  { table: "page_media", selectSql: `SELECT * FROM page_media WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "media" },
  { table: "dialogue_lines", selectSql: `SELECT * FROM dialogue_lines WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "line" },
  {
    table: "dialogue_placements",
    selectSql: `SELECT dp.* FROM dialogue_placements dp JOIN dialogue_lines dl ON dl.id = dp.line_id WHERE dl.project_id = ? ORDER BY dp.created_at ASC`,
    idPrefix: "place"
  },
  { table: "dialogue_proposals", selectSql: `SELECT * FROM dialogue_proposals WHERE project_id = ? ORDER BY created_at ASC`, idPrefix: "proposal" },
  {
    table: "script_manga_run_pages",
    selectSql: `SELECT smrp.* FROM script_manga_run_pages smrp JOIN script_manga_runs smr ON smr.id = smrp.run_id WHERE smr.project_id = ?`
  },
  {
    table: "script_manga_tasks",
    selectSql: `SELECT smt.* FROM script_manga_tasks smt JOIN script_manga_runs smr ON smr.id = smt.run_id WHERE smr.project_id = ? ORDER BY smt.created_at ASC`,
    idPrefix: "manga_task"
  }
];

const GENERATION_ROUND_NON_TERMINAL = new Set(["pending", "running"]);
const GENERATION_JOB_NON_TERMINAL = new Set(["pending", "queued", "running"]);
const SCRIPT_MANGA_RUN_NON_TERMINAL = new Set(["preparing", "running"]);
const SCRIPT_MANGA_TASK_NON_TERMINAL = new Set(["pending", "submitting", "running"]);

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export interface ProjectExportResult {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

export async function exportProject(projectId: string): Promise<ProjectExportResult> {
  const projectRow = getRow<Row>("SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!projectRow) {
    throw new HttpError(404, "Project was not found");
  }
  const projectRoot = resolve(String(projectRow.storage_dir ?? ""));

  const tables: Record<string, Row[]> = {};
  for (const config of SCOPED_TABLES) {
    tables[config.table] = getRows<Row>(config.selectSql, [projectId]);
  }

  const shared = collectSharedRows(projectRow, tables);

  const warnings: string[] = [];
  const rewrittenProject = exportRewriteRow(projectRow, projectRoot, warnings);
  const rewrittenTables: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(tables)) {
    rewrittenTables[table] = rows.map((row) => exportRewriteRow(row, projectRoot, warnings));
  }

  const fileEntries = await collectProjectFiles(projectRoot);

  const manifest = {
    app: APP_ID,
    kind: KIND,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    sourceProjectId: projectId,
    projectName: String(projectRow.name ?? ""),
    projectMode: String(projectRow.mode ?? "single"),
    counts: {
      pages: tables.pages!.length,
      rounds: tables.generation_rounds!.length,
      assets: tables.assets!.length,
      files: fileEntries.length
    },
    warnings
  };

  const data = {
    project: rewrittenProject,
    tables: rewrittenTables,
    shared
  };

  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("data.json", JSON.stringify(data, null, 2));
  for (const entry of fileEntries) {
    const bytes = await readFile(entry.absolutePath);
    zip.file(`files/${entry.relativePath}`, bytes, { compression: "DEFLATE" });
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const filename = `${safeAsciiName(String(projectRow.name ?? ""), "guruguru-project")}.gguru`;
  return { filename, contentType: "application/zip", buffer };
}

function collectSharedRows(projectRow: Row, tables: Record<string, Row[]>) {
  const workflowTemplateIds = new Set<string>();
  const layoutTemplateIds = new Set<string>();
  const presetIds = new Set<string>();

  addIfString(workflowTemplateIds, projectRow.default_template_id);
  for (const row of tables.generation_rounds ?? []) {
    addIfString(workflowTemplateIds, row.template_id);
    addIfString(presetIds, row.preset_id);
  }
  for (const row of tables.assets ?? []) {
    addIfString(workflowTemplateIds, row.workflow_template_id);
  }
  for (const row of tables.asset_parents ?? []) {
    addIfString(presetIds, row.preset_id);
  }
  for (const row of tables.script_manga_run_pages ?? []) {
    addIfString(layoutTemplateIds, row.layout_template_id);
  }

  const generationPresets = fetchRowsByIds("generation_presets", presetIds);
  // generation_presets.template_id は workflow_templates への参照(FK 制約あり)。preset を持ち出す
  // なら、その preset が指す template も一緒に持ち出さないとインポート先で FK 違反になる。
  for (const preset of generationPresets) {
    addIfString(workflowTemplateIds, preset.template_id);
  }

  return {
    workflow_templates: fetchRowsByIds("workflow_templates", workflowTemplateIds),
    layout_templates: fetchRowsByIds("layout_templates", layoutTemplateIds),
    generation_presets: generationPresets
  };
}

function addIfString(set: Set<string>, value: unknown) {
  if (typeof value === "string" && value) {
    set.add(value);
  }
}

function fetchRowsByIds(table: string, ids: Set<string>): Row[] {
  const rows: Row[] = [];
  for (const id of ids) {
    const row = getRow<Row>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

interface ProjectFileEntry {
  absolutePath: string;
  relativePath: string;
}

async function collectProjectFiles(projectRoot: string): Promise<ProjectFileEntry[]> {
  const results: ProjectFileEntry[] = [];

  async function walk(dir: string) {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = relative(projectRoot, absolutePath).split(sep).join("/");
        results.push({ absolutePath, relativePath });
      }
    }
  }

  await walk(projectRoot);
  results.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return results;
}

function exportRewriteRow(row: Row, projectRoot: string, warnings: string[]): Row {
  const out: Row = {};
  for (const [column, value] of Object.entries(row)) {
    out[column] = exportRewriteValue(column, value, projectRoot, warnings);
  }
  return out;
}

function exportRewriteValue(column: string, value: unknown, projectRoot: string, warnings: string[]): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (jsonColumnNames.has(column) && typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return exportPathLeaf(value, projectRoot, warnings);
    }
    return JSON.stringify(rewriteStringLeaves(parsed, (leaf) => exportPathLeaf(leaf, projectRoot, warnings)));
  }
  if (typeof value === "string") {
    return exportPathLeaf(value, projectRoot, warnings);
  }
  return value;
}

function exportPathLeaf(value: string, projectRoot: string, warnings: string[]): string {
  if (!isAbsolute(value)) {
    return value;
  }
  if (isPathInsideOrEqual(value, projectRoot)) {
    return toGguruToken(value, projectRoot);
  }
  if (isPathInsideOrEqual(value, dataRoot)) {
    const message = `projectRoot 外(dataRoot 配下)の絶対パスを検出しました: ${value}`;
    if (!warnings.includes(message)) {
      warnings.push(message);
    }
    return value;
  }
  return value;
}

function toGguruToken(absolutePath: string, projectRoot: string): string {
  const rel = relative(resolve(projectRoot), resolve(absolutePath));
  const relForward = rel.split(sep).join("/");
  return relForward ? `${GGURU_PREFIX}${relForward}` : GGURU_PREFIX;
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

export interface ProjectImportResult {
  project: Row;
  warnings: string[];
}

export async function importProject(zipBytes: Buffer): Promise<ProjectImportResult> {
  if (zipBytes.length === 0) {
    throw new HttpError(400, "インポートするファイルが空です。");
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBytes);
  } catch {
    throw new HttpError(400, "アップロードされたファイルは有効な .gguru(ZIP)ではありません。");
  }

  const manifestEntry = zip.file("manifest.json");
  const dataEntry = zip.file("data.json");
  if (!manifestEntry || !dataEntry) {
    throw new HttpError(400, ".gguru に manifest.json / data.json が含まれていません。");
  }

  let manifest: Record<string, unknown>;
  let data: { project: Row; tables?: Record<string, Row[]>; shared?: Record<string, Row[]> };
  try {
    manifest = JSON.parse(await manifestEntry.async("string"));
    data = JSON.parse(await dataEntry.async("string"));
  } catch {
    throw new HttpError(400, "manifest.json / data.json の解析に失敗しました。");
  }

  if (manifest.app !== APP_ID || manifest.kind !== KIND) {
    throw new HttpError(400, "guruguruのプロジェクトエクスポートファイルではありません。");
  }
  const formatVersion = manifest.formatVersion;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion > FORMAT_VERSION) {
    throw new HttpError(400, `対応していない formatVersion です(${String(formatVersion)})。`);
  }
  if (!data.project || typeof data.project !== "object") {
    throw new HttpError(400, "data.json に project 行がありません。");
  }

  // Zip Slip 検証を先に済ませ、files/ 配下のエントリを集める(未検証のパスは一切使わない)。
  const fileEntries: Array<{ zipPath: string; relativePath: string }> = [];
  zip.forEach((entryPath, entry) => {
    if (entry.dir || !entryPath.startsWith("files/")) {
      return;
    }
    const relativePath = entryPath.slice("files/".length);
    assertSafeZipRelativePath(relativePath);
    fileEntries.push({ zipPath: entryPath, relativePath });
  });

  const newProjectId = createId("project");
  const storage = ensureProjectStorage(newProjectId);
  const newProjectRoot = resolve(storage.projectRoot);

  const warnings: string[] = Array.isArray(manifest.warnings)
    ? manifest.warnings.filter((item): item is string => typeof item === "string")
    : [];

  let filesWritten = false;
  try {
    for (const entry of fileEntries) {
      const destPath = resolve(join(newProjectRoot, entry.relativePath));
      if (!isPathInside(destPath, newProjectRoot)) {
        throw new HttpError(400, "files/ 配下に不正なパスを検出しました。");
      }
      const bytes = await zip.file(entry.zipPath)!.async("nodebuffer");
      ensureParentDir(destPath);
      await writeFile(destPath, bytes);
      filesWritten = true;
    }

    const idMap = new Map<string, string>();
    const oldProjectId = data.project.id;
    if (typeof oldProjectId === "string") {
      idMap.set(oldProjectId, newProjectId);
    }
    for (const config of SCOPED_TABLES) {
      if (!config.idPrefix) {
        continue;
      }
      for (const row of data.tables?.[config.table] ?? []) {
        const oldId = row?.id;
        if (typeof oldId === "string") {
          idMap.set(oldId, createId(config.idPrefix));
        }
      }
    }

    runSql("BEGIN");
    try {
      const project = importRewriteRow(data.project, idMap, newProjectRoot);
      insertRow("projects", project);

      insertSharedRows("workflow_templates", data.shared?.workflow_templates);
      insertSharedRows("layout_templates", data.shared?.layout_templates);
      insertSharedRows("generation_presets", data.shared?.generation_presets);

      const deferredPatches: Array<() => void> = [];
      for (const config of SCOPED_TABLES) {
        for (const rawRow of data.tables?.[config.table] ?? []) {
          const row = importRewriteRow(rawRow, idMap, newProjectRoot);
          normalizeImportedStatus(config.table, row);
          deferSelfReferentialFk(config.table, row, deferredPatches);
          insertRow(config.table, row);
        }
      }
      for (const patch of deferredPatches) {
        patch();
      }

      runSql("COMMIT");
    } catch (error) {
      runSql("ROLLBACK");
      throw error;
    }

    const project = getRow<Row>("SELECT * FROM projects WHERE id = ?", [newProjectId]);
    if (!project) {
      throw new HttpError(500, "Projectのインポートに失敗しました。");
    }
    return { project, warnings };
  } catch (error) {
    if (filesWritten) {
      await deleteProjectStorage(newProjectRoot).catch(() => {
        // ベストエフォート。掃除に失敗しても元のエラーを優先して投げる。
      });
    }
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, error instanceof Error ? error.message : "Projectのインポートに失敗しました。");
  }
}

/**
 * `generation_rounds.parent_round_id` / `script_manga_tasks.repair_parent_task_id` は同じ
 * テーブル内の別行を指す自己参照 FK。INSERT 時点ではまだ参照先が挿入されていない可能性があるため、
 * 一旦 NULL で INSERT し、全行挿入後に UPDATE で復元する(`pages.ts` の reorder と同じ
 * BEGIN/COMMIT パターン内で完結させる)。
 */
function deferSelfReferentialFk(table: string, row: Row, deferredPatches: Array<() => void>) {
  if (table === "generation_rounds" && typeof row.parent_round_id === "string") {
    const parentId = row.parent_round_id;
    const id = row.id;
    row.parent_round_id = null;
    deferredPatches.push(() => runSql("UPDATE generation_rounds SET parent_round_id = ? WHERE id = ?", [parentId, id]));
  }
  if (table === "script_manga_tasks" && typeof row.repair_parent_task_id === "string") {
    const parentId = row.repair_parent_task_id;
    const id = row.id;
    row.repair_parent_task_id = null;
    deferredPatches.push(() => runSql("UPDATE script_manga_tasks SET repair_parent_task_id = ? WHERE id = ?", [parentId, id]));
  }
}

/**
 * §4: 生成が進行中のまま export された行はインポート先で監視ループが動いてしまうため、
 * 非終端 status を `failed` へ正規化する。
 */
function normalizeImportedStatus(table: string, row: Row) {
  if (table === "generation_rounds" && typeof row.status === "string" && GENERATION_ROUND_NON_TERMINAL.has(row.status)) {
    row.status = "failed";
    row.last_error_json = IMPORTED_WHILE_IN_PROGRESS;
  }
  if (table === "generation_jobs" && typeof row.status === "string" && GENERATION_JOB_NON_TERMINAL.has(row.status)) {
    row.status = "failed";
    row.last_error_json = IMPORTED_WHILE_IN_PROGRESS;
  }
  if (table === "script_manga_runs" && typeof row.status === "string" && SCRIPT_MANGA_RUN_NON_TERMINAL.has(row.status)) {
    row.status = "failed";
    row.last_error_json = IMPORTED_WHILE_IN_PROGRESS;
  }
  if (table === "script_manga_tasks" && typeof row.status === "string" && SCRIPT_MANGA_TASK_NON_TERMINAL.has(row.status)) {
    row.status = "failed";
    row.last_error_json = IMPORTED_WHILE_IN_PROGRESS;
  }
}

function insertSharedRows(table: string, rows: unknown) {
  if (!Array.isArray(rows)) {
    return;
  }
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const row = raw as Row;
    const id = row.id;
    if (typeof id !== "string") {
      continue;
    }
    const existing = getRow(`SELECT id FROM ${table} WHERE id = ?`, [id]);
    if (existing) {
      continue;
    }
    insertRow(table, row);
  }
}

function insertRow(table: string, row: Row) {
  const columns = Object.keys(row);
  if (columns.length === 0) {
    return;
  }
  const columnList = columns.map((column) => `"${column}"`).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const values = columns.map((column) => normalizeSqlValue(row[column]));
  runSql(`INSERT INTO ${table} (${columnList}) VALUES (${placeholders})`, values);
}

function normalizeSqlValue(value: unknown): string | number | bigint | boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "object") {
    // JSON 列は importRewriteValue が既に文字列化しているので、ここに来るのは想定外の値のみ
    // (壊れた入力に対する安全網として文字列化しておく)。
    return JSON.stringify(value);
  }
  return value as string | number | bigint | boolean;
}

/**
 * Zip Slip 対策(§5)。`files/` 配下のエントリ名の直接検証: `..` セグメント・先頭 `/`・ドライブレター・
 * `\` を含むものは拒否する。exported for direct unit testing -- in practice JSZip itself already
 * resolves `..` segments when round-tripping through `generateAsync`/`loadAsync` (an entry that tries
 * to escape `files/` ends up outside the `files/` prefix entirely and is filtered out before this
 * function even runs), so this function is the defense-in-depth layer the spec calls for and is
 * exercised directly by tests rather than through a JSZip-normalized fixture.
 */
export function assertSafeZipRelativePath(relativePath: string) {
  if (!relativePath) {
    throw new HttpError(400, "files/ 配下に空のパスを検出しました。");
  }
  if (relativePath.includes("\\") || relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath)) {
    throw new HttpError(400, `files/ 配下に不正なパスを検出しました: ${relativePath}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new HttpError(400, `files/ 配下に不正なパスを検出しました: ${relativePath}`);
  }
}

function importRewriteRow(row: Row, idMap: Map<string, string>, newProjectRoot: string): Row {
  const out: Row = {};
  for (const [column, value] of Object.entries(row)) {
    out[column] = importRewriteValue(column, value, idMap, newProjectRoot);
  }
  return out;
}

function importRewriteValue(column: string, value: unknown, idMap: Map<string, string>, newProjectRoot: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (jsonColumnNames.has(column) && typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return importLeaf(value, idMap, newProjectRoot);
    }
    return JSON.stringify(rewriteStringLeaves(parsed, (leaf) => importLeaf(leaf, idMap, newProjectRoot)));
  }
  if (typeof value === "string") {
    return importLeaf(value, idMap, newProjectRoot);
  }
  return value;
}

function importLeaf(value: string, idMap: Map<string, string>, newProjectRoot: string): string {
  const mappedId = idMap.get(value);
  if (mappedId) {
    return mappedId;
  }
  if (value.startsWith(GGURU_PREFIX)) {
    return fromGguruToken(value, newProjectRoot);
  }
  return value;
}

function fromGguruToken(token: string, newProjectRoot: string): string {
  const rel = token.slice(GGURU_PREFIX.length);
  if (!rel) {
    return newProjectRoot;
  }
  const relOs = rel.split("/").join(sep);
  return join(newProjectRoot, relOs);
}

// ---------------------------------------------------------------------------------------------
// Shared recursive string-leaf walker (export: path rewrite only; import: id + path rewrite)
// ---------------------------------------------------------------------------------------------

function rewriteStringLeaves(value: unknown, rewrite: (leaf: string) => string): unknown {
  if (typeof value === "string") {
    return rewrite(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteStringLeaves(item, rewrite));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = rewriteStringLeaves(item, rewrite);
    }
    return out;
  }
  return value;
}
