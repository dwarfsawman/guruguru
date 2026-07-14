/**
 * Project import / export (`.guruzip`, Docs/Feature-ProjectImportExport.md). A `.guruzip` file is a
 * plain ZIP (Rust native export / import; JSZip is retained for A/B diagnostics) containing:
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
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import { createId, dataRoot, getRow, getRows, jsonColumnNames, runSql } from "./db";
import { HttpError } from "./http";
import { deleteProjectStorage, ensureProjectStorage } from "./storage";
import { isPathInside, isPathInsideOrEqual } from "./paths";
import { safeAsciiName } from "./openRasterExport";
import {
  configuredProjectExportEngine,
  createProjectArchiveWithRust,
  extractProjectArchive,
  type ProjectArchiveEngine
} from "./projectArchive";

export { assertSafeZipRelativePath } from "./projectArchive";

const APP_ID = "guruguru";
const KIND = "project-export";
const FORMAT_VERSION = 1;
const GGURU_PREFIX = "gguru://project/";
const IMPORTED_WHILE_IN_PROGRESS = JSON.stringify({ message: "imported while in progress" });
const IMPORT_STREAM_WRITE_BUFFER_BYTES = 1024 * 1024;

/** files/ 配下で再圧縮する価値がある、可読テキスト形式。その他は既圧縮バイナリを想定して STORE にする。 */
const DEFLATED_PROJECT_FILE_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".fountain",
  ".htm",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".log",
  ".md",
  ".mjs",
  ".svg",
  ".toml",
  ".ts",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

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

export interface ProjectExportArchiveResult {
  filename: string;
  contentType: string;
  archivePath: string;
  byteLength: number;
  engine: ProjectArchiveEngine;
}

export interface ProjectExportOptions {
  /** 通常はrust。jszipはA/B性能比較と緊急診断だけに使う。 */
  engine?: ProjectArchiveEngine;
}

interface PreparedProjectExport {
  filename: string;
  contentType: string;
  projectRoot: string;
  manifestJson: string;
  dataJson: string;
  fileEntries: ProjectFileEntry[];
}

/**
 * Bufferを必要とする既存の内部呼び出し向け。通常のHTTP経路はwithProjectExportArchiveを使い、
 * Rustが作成した巨大ZIPをBunへ読み戻さない。
 */
export async function exportProject(
  projectId: string,
  options: ProjectExportOptions = {}
): Promise<ProjectExportResult> {
  const prepared = await prepareProjectExport(projectId);
  const engine = options.engine ?? configuredProjectExportEngine();
  if (engine === "jszip") {
    return {
      filename: prepared.filename,
      contentType: prepared.contentType,
      buffer: await createProjectZipBufferWithJsZip(prepared)
    };
  }
  return withExportTempDir("buffer", async (dir) => {
    const archive = await createPreparedProjectArchive(prepared, dir, engine);
    return {
      filename: archive.filename,
      contentType: archive.contentType,
      buffer: await readFile(archive.archivePath)
    };
  });
}

/**
 * HTTP配信用。callbackの完了まで一時ZIPを保持し、成功・失敗を問わずその後に安全確認して削除する。
 */
export async function withProjectExportArchive<T>(
  projectId: string,
  operation: (archive: ProjectExportArchiveResult) => Promise<T>,
  options: ProjectExportOptions = {}
): Promise<T> {
  const prepared = await prepareProjectExport(projectId);
  const engine = options.engine ?? configuredProjectExportEngine();
  return withExportTempDir("archive", async (dir) => {
    const archive = await createPreparedProjectArchive(prepared, dir, engine);
    return operation(archive);
  });
}

async function prepareProjectExport(projectId: string): Promise<PreparedProjectExport> {
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

  const filename = `${safeAsciiName(String(projectRow.name ?? ""), "guruguru-project")}.guruzip`;
  return {
    filename,
    contentType: "application/zip",
    projectRoot,
    manifestJson: JSON.stringify(manifest, null, 2),
    dataJson: JSON.stringify(data, null, 2),
    fileEntries
  };
}

async function createPreparedProjectArchive(
  prepared: PreparedProjectExport,
  tempDir: string,
  engine: ProjectArchiveEngine
): Promise<ProjectExportArchiveResult> {
  const archivePath = join(tempDir, "project.guruzip");
  if (engine === "rust") {
    const manifestPath = join(tempDir, "manifest.json");
    const dataPath = join(tempDir, "data.json");
    await Promise.all([
      writeFile(manifestPath, prepared.manifestJson, { encoding: "utf8", flag: "wx" }),
      writeFile(dataPath, prepared.dataJson, { encoding: "utf8", flag: "wx" })
    ]);
    await createProjectArchiveWithRust(prepared.projectRoot, manifestPath, dataPath, archivePath);
  } else {
    await writeFile(archivePath, await createProjectZipBufferWithJsZip(prepared), { flag: "wx" });
  }
  const archiveStats = await stat(archivePath);
  if (!archiveStats.isFile() || archiveStats.size === 0) {
    throw new HttpError(500, ".guruzip の作成結果が空です。");
  }
  return {
    filename: prepared.filename,
    contentType: prepared.contentType,
    archivePath,
    byteLength: archiveStats.size,
    engine
  };
}

async function createProjectZipBufferWithJsZip(prepared: PreparedProjectExport): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("manifest.json", prepared.manifestJson, { compression: "DEFLATE" });
  zip.file("data.json", prepared.dataJson, { compression: "DEFLATE" });
  for (const entry of prepared.fileEntries) {
    const bytes = await readFile(entry.absolutePath);
    zip.file(`files/${entry.relativePath}`, bytes, { compression: projectFileCompression(entry.relativePath) });
  }
  // 全体の既定はSTORE。圧縮するエントリは上で明示し、PNG/JPEG等の再DEFLATEを避ける。
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

function projectFileCompression(relativePath: string): "STORE" | "DEFLATE" {
  return DEFLATED_PROJECT_FILE_EXTENSIONS.has(extname(relativePath).toLowerCase()) ? "DEFLATE" : "STORE";
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

// NOTE: JSON 列の判定は db.ts の jsonColumnNames を使う。script_manga_runs.config_json は
// jsonColumnNames に載っておらず、意図的に再帰走査しない -- 中身は templateId(shared な
// workflow_template の ID で import 後もそのまま)・LoRA 名・数値パラメータのみで、
// プロジェクトスコープの ID もローカルパスも含まないため書き換え不要(将来の列監査用メモ)。
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

export interface ProjectImportOptions {
  /** 通常はrust。jszipはA/B性能比較と緊急診断だけに使う。 */
  engine?: ProjectArchiveEngine;
}

/**
 * 既存のBuffer呼び出し互換。HTTP本番経路はimportProjectFromStreamを使い、巨大Buffer自体を作らない。
 */
export async function importProject(zipBytes: Buffer, options: ProjectImportOptions = {}): Promise<ProjectImportResult> {
  if (zipBytes.length === 0) {
    throw new HttpError(400, "インポートするファイルが空です。");
  }
  return withImportTempDir("buffer", async (dir) => {
    const archivePath = join(dir, "upload.guruzip");
    await writeFile(archivePath, zipBytes);
    return importProjectFromArchive(archivePath, options);
  });
}

/** HTTPリクエストを外部一時ファイルへ逐次保存し、Nodeの全Buffer保持を避ける。 */
export async function importProjectFromStream(
  source: AsyncIterable<unknown>,
  options: ProjectImportOptions = {}
): Promise<ProjectImportResult> {
  return withImportTempDir("upload", async (dir) => {
    const archivePath = join(dir, "upload.guruzip");
    const handle = await open(archivePath, "wx");
    let byteLength = 0;
    const writeBuffer = Buffer.allocUnsafe(IMPORT_STREAM_WRITE_BUFFER_BYTES);
    let bufferedBytes = 0;
    try {
      for await (const chunk of source) {
        const bytes = toBufferChunk(chunk);
        let sourceOffset = 0;
        while (sourceOffset < bytes.length) {
          const copyBytes = Math.min(writeBuffer.length - bufferedBytes, bytes.length - sourceOffset);
          bytes.copy(writeBuffer, bufferedBytes, sourceOffset, sourceOffset + copyBytes);
          bufferedBytes += copyBytes;
          sourceOffset += copyBytes;
          if (bufferedBytes === writeBuffer.length) {
            await writeAll(handle, writeBuffer, bufferedBytes);
            bufferedBytes = 0;
          }
        }
        byteLength += bytes.length;
      }
      if (bufferedBytes > 0) {
        await writeAll(handle, writeBuffer, bufferedBytes);
      }
    } finally {
      await handle.close();
    }
    if (byteLength === 0) {
      throw new HttpError(400, "インポートするファイルが空です。");
    }
    return importProjectFromArchive(archivePath, options);
  });
}

/**
 * ディスク上の`.guruzip`を指定engineで展開してDBへ取り込む。ベンチマークはこの入口を別プロセスで呼ぶ。
 */
export async function importProjectFromArchive(
  archivePath: string,
  options: ProjectImportOptions = {}
): Promise<ProjectImportResult> {
  let archiveSize: number;
  try {
    archiveSize = (await stat(archivePath)).size;
  } catch {
    throw new HttpError(400, "インポートするファイルを読み込めません。");
  }
  if (archiveSize === 0) {
    throw new HttpError(400, "インポートするファイルが空です。");
  }

  const newProjectId = createId("project");
  const storage = ensureProjectStorage(newProjectId);
  const newProjectRoot = resolve(storage.projectRoot);
  let metadataDir: string;
  try {
    metadataDir = await createImportTempDir("metadata");
  } catch (error) {
    await deleteProjectStorage(newProjectRoot).catch(() => {});
    throw new HttpError(500, error instanceof Error ? error.message : "guruzip一時領域の作成に失敗しました。");
  }

  try {
    const extracted = await extractProjectArchive(archivePath, newProjectRoot, metadataDir, options.engine);
    let manifest: Record<string, unknown>;
    let data: { project: Row; tables?: Record<string, Row[]>; shared?: Record<string, Row[]> };
    try {
      manifest = JSON.parse(extracted.manifestJson);
      data = JSON.parse(extracted.dataJson);
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
    const warnings: string[] = Array.isArray(manifest.warnings)
      ? manifest.warnings.filter((item): item is string => typeof item === "string")
      : [];

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
    // ensureProjectStorage() が先にディレクトリツリーを作っているため、ファイルを1つも
    // 書いていない失敗(空 zip の DB 失敗・Zip Slip 400 等)でも空の projects/<newId>/ が
    // 残る。掃除は常にベストエフォートで行い、失敗しても元のエラーを優先して投げる。
    await deleteProjectStorage(newProjectRoot).catch(() => {});
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, error instanceof Error ? error.message : "Projectのインポートに失敗しました。");
  } finally {
    await removeImportTempDir(metadataDir).catch(() => {});
  }
}

async function withImportTempDir<T>(purpose: string, operation: (dir: string) => Promise<T>): Promise<T> {
  const dir = await createImportTempDir(purpose);
  try {
    return await operation(dir);
  } finally {
    await removeImportTempDir(dir).catch(() => {});
  }
}

async function createImportTempDir(purpose: string): Promise<string> {
  return mkdtemp(join(resolve(tmpdir()), `guruguru-import-${purpose}-`));
}

async function removeImportTempDir(dir: string): Promise<void> {
  const resolved = resolve(dir);
  const tempRoot = resolve(tmpdir());
  if (!isPathInside(resolved, tempRoot) || !basename(resolved).startsWith("guruguru-import-")) {
    throw new Error(`Refusing to remove unverified import temp directory: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

async function withExportTempDir<T>(purpose: string, operation: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(resolve(tmpdir()), `guruguru-export-${purpose}-`));
  try {
    return await operation(dir);
  } finally {
    await removeExportTempDir(dir).catch(() => {});
  }
}

async function removeExportTempDir(dir: string): Promise<void> {
  const resolved = resolve(dir);
  const tempRoot = resolve(tmpdir());
  if (!isPathInside(resolved, tempRoot) || !basename(resolved).startsWith("guruguru-export-")) {
    throw new Error(`Refusing to remove unverified export temp directory: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

function toBufferChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new HttpError(400, "インポートリクエストに不正なバイナリチャンクを検出しました。");
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  length: number
): Promise<void> {
  let offset = 0;
  while (offset < length) {
    const result = await handle.write(buffer, offset, length - offset, null);
    if (result.bytesWritten === 0) {
      throw new Error("guruzip一時ファイルへの書き込みが進みませんでした。");
    }
    offset += result.bytesWritten;
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

/** SQL 識別子として安全なカラム名(英数字とアンダースコアのみ)。 */
const SAFE_COLUMN_NAME = /^[A-Za-z0-9_]+$/;

function insertRow(table: string, row: Row) {
  const columns = Object.keys(row);
  if (columns.length === 0) {
    return;
  }
  // カラム名は data.json(=信頼できない入力)由来。`"` 等を含む名前でクォートを破って
  // SQL を注入されないよう、識別子として安全な文字だけを許可する(不一致は 400)。
  for (const column of columns) {
    if (!SAFE_COLUMN_NAME.test(column)) {
      throw new HttpError(400, `data.json に不正なカラム名を検出しました: ${column}`);
    }
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
