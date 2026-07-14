import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import JSZip from "jszip";
import { createId, getRow, initializeDb, runSql } from "./db.ts";
import { createProject } from "./projects.ts";
import { storeImage } from "./storage.ts";
import { assertSafeZipRelativePath, exportProject, importProject, importProjectFromStream } from "./projectTransfer.ts";
import { HttpError } from "./http.ts";

initializeDb();

/** テスト用の workflow_templates 行を直接 INSERT する(createTemplate はワークフロー検証が重いため)。 */
function insertWorkflowTemplate(suffix: string): string {
  const id = createId("template");
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, ?, '', 'txt2img', 1, '{}', '{}', ?)`,
    [id, `Template ${suffix}`, `hash_${suffix}`]
  );
  return id;
}

/**
 * rounds/assets/pages/characters/binding/脚本/自動漫画 run/task を一通り含む Project を組み立てる
 * (Docs/Feature-ProjectImportExport.md §7 のラウンドトリップテスト要件)。DB へは直接 SQL で INSERT し、
 * 生成パイプライン全体は経由しない(projectTransfer.ts はテーブル横断の汎用処理なので、各テーブルに
 * 1行ずつ入っていれば十分カバーできる)。
 */
async function buildFixtureProject(suffix: string) {
  const templateId = insertWorkflowTemplate(suffix);
  const project = createProject({ name: `Import/Export Test ${suffix}`, mode: "book", defaultTemplateId: templateId });
  if (!project) {
    throw new Error("failed to create test project");
  }
  const projectId = String(project.id);

  // Book 初期ページ(page_index=0)を再利用する。
  const page = getRow<{ id: string }>("SELECT id FROM pages WHERE project_id = ? AND page_index = 0", [projectId]);
  if (!page) {
    throw new Error("initial page was not created");
  }
  const pageId = page.id;

  // manga_scripts / script_revisions
  const scriptId = createId("script");
  runSql("INSERT INTO manga_scripts (id, project_id, title) VALUES (?, ?, ?)", [scriptId, projectId, "Script"]);
  const revisionId = createId("rev");
  runSql(
    "INSERT INTO script_revisions (id, script_id, revision, fountain_source, parsed_json) VALUES (?, ?, 1, 'INT. ROOM', '{}')",
    [revisionId, scriptId]
  );

  // characters / character_bindings(faceImagePath が projectRoot 配下の絶対パスを含む)
  const characterId = createId("char");
  runSql("INSERT INTO characters (id, project_id, name) VALUES (?, ?, ?)", [characterId, projectId, "Alice"]);
  const facePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
    "base64"
  );
  const stored = await storeImage(projectId, "round_fixture", 0, "face.png", facePng);
  const bindingId = createId("bind");
  runSql(
    "INSERT INTO character_bindings (id, character_id, provider_id, binding_json) VALUES (?, ?, 'comfy', ?)",
    [bindingId, characterId, JSON.stringify({ faceImagePath: stored.imagePath })]
  );

  // dialogue_lines
  const lineId = createId("line");
  runSql(
    `INSERT INTO dialogue_lines (id, project_id, script_id, character_id, text, order_index)
     VALUES (?, ?, ?, ?, 'Hello there', 0)`,
    [lineId, projectId, scriptId, characterId]
  );

  // generation_rounds(pending のまま = ステータス正規化の対象)+ generation_jobs + assets
  const roundId = createId("round");
  runSql(
    `INSERT INTO generation_rounds
       (id, project_id, template_id, round_index, status, generation_mode, page_id, request_json)
     VALUES (?, ?, ?, 0, 'pending', 'txt2img', ?, '{}')`,
    [roundId, projectId, templateId, pageId]
  );
  const jobId = createId("job");
  runSql(
    `INSERT INTO generation_jobs (id, project_id, round_id, batch_index, client_id, status)
     VALUES (?, ?, ?, 0, 'client-1', 'running')`,
    [jobId, projectId, roundId]
  );
  const assetImage = await storeImage(projectId, roundId, 0, "panel.png", facePng);
  const assetId = createId("asset");
  runSql(
    `INSERT INTO assets
       (id, project_id, round_id, batch_index, image_path, thumbnail_small_path, thumbnail_medium_path,
        workflow_template_id, workflow_template_version, workflow_snapshot_hash)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1, 'hash')`,
    [assetId, projectId, roundId, assetImage.imagePath, assetImage.thumbnailSmallPath, assetImage.thumbnailMediumPath, templateId]
  );

  // page_panel_assignments(pageId には layout が無いが、割り当て自体は panel_id 文字列のみで成立する)
  const panelAssignmentId = createId("panelassign");
  runSql(
    `INSERT INTO page_panel_assignments (id, page_id, panel_id, asset_id, crop_json)
     VALUES (?, ?, 'panel-1', ?, '{}')`,
    [panelAssignmentId, pageId, assetId]
  );

  // script_manga_plans / script_manga_runs(preparing のまま) / script_manga_run_pages / script_manga_tasks
  const planId = createId("manga_plan");
  runSql(
    `INSERT INTO script_manga_plans
       (id, project_id, script_id, script_revision_id, planner_version, prompt_compiler_version, plan_json, validation_json)
     VALUES (?, ?, ?, ?, 'v1', 'v1', '{}', '{}')`,
    [planId, projectId, scriptId, revisionId]
  );
  const runId = createId("manga");
  runSql(
    `INSERT INTO script_manga_runs
       (id, project_id, script_id, script_revision_id, plan_id, status, phase, config_json)
     VALUES (?, ?, ?, ?, ?, 'preparing', 'planning', '{}')`,
    [runId, projectId, scriptId, revisionId, planId]
  );
  runSql(
    `INSERT INTO script_manga_run_pages (run_id, page_id, page_index, layout_template_id) VALUES (?, ?, 0, ?)`,
    [runId, pageId, "builtin-layout-1"]
  );
  const taskId = createId("manga_task");
  runSql(
    `INSERT INTO script_manga_tasks (id, run_id, page_id, panel_id, round_id, prompt, status)
     VALUES (?, ?, ?, 'panel-1', ?, 'draw a room', 'running')`,
    [taskId, runId, pageId, roundId]
  );

  return {
    projectId,
    templateId,
    pageId,
    scriptId,
    revisionId,
    characterId,
    bindingId,
    lineId,
    roundId,
    jobId,
    assetId,
    panelAssignmentId,
    planId,
    runId,
    taskId
  };
}

function countProjectRows(projectId: string, table: string, whereProjectColumn = "project_id"): number {
  const row = getRow<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${whereProjectColumn} = ?`, [projectId]);
  return row?.n ?? 0;
}

/** ZIP central directory に記録された圧縮方式(0=STORE, 8=DEFLATE)をエントリ名ごとに読む。 */
function zipCompressionMethods(buffer: Buffer): Map<string, number> {
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocdOffset, -1, "ZIP end of central directory が無い");
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const methods = new Map<string, number>();
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "ZIP central directory entry が不正");
    const method = buffer.readUInt16LE(offset + 10);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    methods.set(name, method);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return methods;
}

test("guruzip ラウンドトリップ: 行数一致・ID全新規・パスが新projectRoot配下・FK整合・ファイル実在", async () => {
  const fixture = await buildFixtureProject("roundtrip");
  const exportResult = await exportProject(fixture.projectId);
  assert.match(exportResult.filename, /\.guruzip$/);
  assert.equal(exportResult.contentType, "application/zip");

  const importResult = await importProject(exportResult.buffer);
  const newProjectId = String(importResult.project.id);
  assert.notEqual(newProjectId, fixture.projectId);

  // 行数一致(project_id を持つテーブル)
  for (const table of ["pages", "generation_rounds", "generation_jobs", "assets", "characters", "manga_scripts", "dialogue_lines"]) {
    assert.equal(
      countProjectRows(newProjectId, table),
      countProjectRows(fixture.projectId, table),
      `${table} の行数が一致しない`
    );
  }

  // 全 ID が新規(旧 project の ID が新 project 配下に一切現れない)
  const newPage = getRow<{ id: string }>("SELECT id FROM pages WHERE project_id = ?", [newProjectId]);
  assert.ok(newPage);
  assert.notEqual(newPage!.id, fixture.pageId);

  const newRound = getRow<Record<string, unknown>>("SELECT * FROM generation_rounds WHERE project_id = ?", [newProjectId]);
  assert.ok(newRound);
  assert.notEqual(newRound!.id, fixture.roundId);
  assert.equal(newRound!.page_id, newPage!.id);
  assert.equal(newRound!.template_id, fixture.templateId, "shared な workflow_template は元IDのまま");

  const newAsset = getRow<Record<string, unknown>>("SELECT * FROM assets WHERE project_id = ?", [newProjectId]);
  assert.ok(newAsset);
  assert.notEqual(newAsset!.id, fixture.assetId);
  assert.equal(newAsset!.round_id, newRound!.id);

  // パスが新 projectRoot 配下を指す(旧 projectRoot は一切含まれない)
  const newProjectRow = getRow<{ storage_dir: string }>("SELECT storage_dir FROM projects WHERE id = ?", [newProjectId]);
  assert.ok(newProjectRow);
  const newProjectRoot = newProjectRow!.storage_dir;
  assert.ok(String(newAsset!.image_path).startsWith(newProjectRoot), "asset.image_path が新 projectRoot 配下でない");

  const newBinding = getRow<{ binding_json: string }>(
    `SELECT cb.binding_json FROM character_bindings cb JOIN characters c ON c.id = cb.character_id WHERE c.project_id = ?`,
    [newProjectId]
  );
  assert.ok(newBinding);
  const bindingParsed = JSON.parse(newBinding!.binding_json) as { faceImagePath: string };
  assert.ok(bindingParsed.faceImagePath.startsWith(newProjectRoot), "binding_json.faceImagePath が新 projectRoot 配下でない");

  // panel_id(レイアウト内部 ID、DB 行 ID ではない)は変更されない
  const newAssignment = getRow<{ panel_id: string }>("SELECT panel_id FROM page_panel_assignments WHERE page_id = ?", [newPage!.id]);
  assert.equal(newAssignment!.panel_id, "panel-1");

  // FK 整合(参照先が実在する)
  const newTask = getRow<Record<string, unknown>>("SELECT * FROM script_manga_tasks WHERE run_id IN (SELECT id FROM script_manga_runs WHERE project_id = ?)", [newProjectId]);
  assert.ok(newTask);
  assert.equal(newTask!.round_id, newRound!.id);
  const newRun = getRow<Record<string, unknown>>("SELECT * FROM script_manga_runs WHERE project_id = ?", [newProjectId]);
  assert.ok(newRun);
  assert.equal(newTask!.run_id, newRun!.id);

  // ファイル実在
  const fs = await import("node:fs/promises");
  await assert.doesNotReject(fs.stat(String(newAsset!.image_path)));
  await assert.doesNotReject(fs.stat(bindingParsed.faceImagePath));
});

test("guruzip HTTP経路: 分割チャンクを一時ファイルへ逐次受信してRust importできる", async () => {
  const fixture = await buildFixtureProject("stream");
  const exported = await exportProject(fixture.projectId);
  async function* chunks() {
    const chunkSize = 997;
    for (let offset = 0; offset < exported.buffer.length; offset += chunkSize) {
      yield exported.buffer.subarray(offset, Math.min(exported.buffer.length, offset + chunkSize));
    }
  }
  const imported = await importProjectFromStream(chunks());
  assert.notEqual(String(imported.project.id), fixture.projectId);
  assert.match(String(imported.project.storage_dir), /projects[\\/]+project_/);
});

test("guruzip ラウンドトリップ: 進行中ステータスは failed へ正規化される(§4)", async () => {
  const fixture = await buildFixtureProject("status");
  const exportResult = await exportProject(fixture.projectId);
  const importResult = await importProject(exportResult.buffer);
  const newProjectId = String(importResult.project.id);

  const round = getRow<{ status: string; last_error_json: string }>(
    "SELECT status, last_error_json FROM generation_rounds WHERE project_id = ?",
    [newProjectId]
  );
  assert.equal(round!.status, "failed");
  assert.match(round!.last_error_json, /imported while in progress/);

  const job = getRow<{ status: string }>(
    "SELECT status FROM generation_jobs WHERE project_id = ?",
    [newProjectId]
  );
  assert.equal(job!.status, "failed");

  const run = getRow<{ status: string }>("SELECT status FROM script_manga_runs WHERE project_id = ?", [newProjectId]);
  assert.equal(run!.status, "failed");

  const task = getRow<{ status: string }>(
    "SELECT status FROM script_manga_tasks WHERE run_id IN (SELECT id FROM script_manga_runs WHERE project_id = ?)",
    [newProjectId]
  );
  assert.equal(task!.status, "failed");
});

test("guruzip ラウンドトリップ: shared な workflow_template は既存IDを再利用し重複INSERTしない", async () => {
  const fixture = await buildFixtureProject("shared");
  const beforeCount = getRow<{ n: number }>("SELECT COUNT(*) AS n FROM workflow_templates WHERE id = ?", [fixture.templateId])!.n;
  assert.equal(beforeCount, 1);

  const exportResult = await exportProject(fixture.projectId);
  await importProject(exportResult.buffer);
  await importProject(exportResult.buffer); // 2回インポートしても template は複製されない

  const afterCount = getRow<{ n: number }>("SELECT COUNT(*) AS n FROM workflow_templates WHERE id = ?", [fixture.templateId])!.n;
  assert.equal(afterCount, 1);
});

test("guruzip エクスポート: 画像はSTORE、manifest/dataとテキストはDEFLATE", async () => {
  const fixture = await buildFixtureProject("compression-method");
  const project = getRow<{ storage_dir: string }>("SELECT storage_dir FROM projects WHERE id = ?", [fixture.projectId]);
  assert.ok(project);
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(project.storage_dir, "notes.txt"), "compressible text\n".repeat(256));

  const exportResult = await exportProject(fixture.projectId);
  const methods = zipCompressionMethods(exportResult.buffer);

  assert.equal(methods.get("manifest.json"), 8);
  assert.equal(methods.get("data.json"), 8);
  assert.equal(methods.get("files/notes.txt"), 8);
  const pngEntries = [...methods].filter(([name]) => name.startsWith("files/") && name.endsWith(".png"));
  assert.ok(pngEntries.length > 0, "fixture のPNGがZIPに含まれていない");
  for (const [name, method] of pngEntries) {
    assert.equal(method, 0, `${name} はSTOREであるべき`);
  }
});

test("guruzip インポート: 全DEFLATE ZIPも展開できる", async () => {
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({ app: "guruguru", kind: "project-export", formatVersion: 1, counts: {}, warnings: [] })
  );
  zip.file(
    "data.json",
    JSON.stringify({
      project: {
        id: "project_legacy_deflate",
        name: "Legacy Deflate",
        mode: "single",
        storage_dir: "gguru://project/",
        canvas_width: 1024,
        canvas_height: 1446
      },
      tables: {},
      shared: {}
    })
  );
  zip.file("files/legacy.png", Buffer.alloc(4096, 7));
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  assert.equal(zipCompressionMethods(buffer).get("files/legacy.png"), 8, "fixture は旧DEFLATE形式であるべき");

  const imported = await importProject(buffer);
  const project = getRow<{ storage_dir: string }>("SELECT storage_dir FROM projects WHERE id = ?", [
    String(imported.project.id)
  ]);
  assert.ok(project);
  const fs = await import("node:fs/promises");
  const bytes = await fs.readFile(join(project.storage_dir, "legacy.png"));
  assert.equal(bytes.length, 4096);
});

// Zip Slip 対策(§5)の直接検証。実運用では JSZip 自身が generateAsync/loadAsync の往復で ".."
// セグメントを解決してしまい(files/ 配下から追い出されて素通しの対象外になる)、悪意ある相対パスの
// まま importProject() の forEach コールバックへ届く経路を JSZip 経由で再現できない。そのため
// assertSafeZipRelativePath を直接 unit test して spec §5 の拒否条件(".." セグメント・先頭 "/"・
// ドライブレター・"\")を pin する。
test("assertSafeZipRelativePath: '..' セグメントを含むパスは400", () => {
  assert.throws(
    () => assertSafeZipRelativePath("../evil.txt"),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
  assert.throws(
    () => assertSafeZipRelativePath("a/../../evil.txt"),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});

test("assertSafeZipRelativePath: 先頭 '/' は400", () => {
  assert.throws(
    () => assertSafeZipRelativePath("/etc/passwd"),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});

test("assertSafeZipRelativePath: ドライブレターは400", () => {
  assert.throws(
    () => assertSafeZipRelativePath("C:/evil.txt"),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
  assert.throws(
    () => assertSafeZipRelativePath("assets/image.png:stream"),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});

test("assertSafeZipRelativePath: バックスラッシュを含むパスは400", () => {
  assert.throws(
    () => assertSafeZipRelativePath("a\\evil.txt"),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});

test("assertSafeZipRelativePath: 空文字は400", () => {
  assert.throws(
    () => assertSafeZipRelativePath(""),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});

test("assertSafeZipRelativePath: 通常の相対パスは通す", () => {
  assert.doesNotThrow(() => assertSafeZipRelativePath("assets/original/round_1_000_img.png"));
});

test("guruzip インポート: files/ 配下の '..' エントリはRustのraw path検査で400になりstorageを残さない", async () => {
  const { dataRoot } = await import("./db.ts");
  const fs = await import("node:fs/promises");
  const projectsRoot = join(dataRoot, "projects");
  const before = new Set(await fs.readdir(projectsRoot).catch(() => [] as string[]));
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({ app: "guruguru", kind: "project-export", formatVersion: 1, counts: {}, warnings: [] })
  );
  zip.file(
    "data.json",
    JSON.stringify({
      project: { id: "project_evil", name: "Evil", mode: "single", storage_dir: "gguru://project/", canvas_width: 1024, canvas_height: 1446 },
      tables: {},
      shared: {}
    })
  );
  zip.file("files/../evil.txt", "pwned");
  const buffer = await zip.generateAsync({ type: "nodebuffer" });

  await assert.rejects(
    () => importProject(buffer),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
  const after = await fs.readdir(projectsRoot).catch(() => [] as string[]);
  assert.deepEqual(after.filter((name) => !before.has(name)), []);
});

test("guruzip インポート: formatVersion が対応範囲を超えると400", async () => {
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({ app: "guruguru", kind: "project-export", formatVersion: 999, counts: {}, warnings: [] })
  );
  zip.file(
    "data.json",
    JSON.stringify({
      project: { id: "project_future", name: "Future", mode: "single", storage_dir: "gguru://project/", canvas_width: 1024, canvas_height: 1446 },
      tables: {},
      shared: {}
    })
  );
  const buffer = await zip.generateAsync({ type: "nodebuffer" });

  await assert.rejects(
    () => importProject(buffer),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});

test("guruzip インポート: app/kind が一致しないファイルは400", async () => {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({ app: "other-app", kind: "project-export", formatVersion: 1 }));
  zip.file("data.json", JSON.stringify({ project: { id: "x" }, tables: {}, shared: {} }));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });

  await assert.rejects(
    () => importProject(buffer),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
});

test("guruzip インポート: 不正なカラム名(SQLインジェクション)を含む data.json は400で拒否され、行が増えない", async () => {
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({ app: "guruguru", kind: "project-export", formatVersion: 1, counts: {}, warnings: [] })
  );
  const maliciousColumn = `id") VALUES ('x'); --`;
  zip.file(
    "data.json",
    JSON.stringify({
      project: {
        id: "project_inject",
        name: "Inject",
        mode: "single",
        storage_dir: "gguru://project/",
        canvas_width: 1024,
        canvas_height: 1446,
        [maliciousColumn]: "evil"
      },
      tables: {},
      shared: {}
    })
  );
  const buffer = await zip.generateAsync({ type: "nodebuffer" });

  const beforeProjectCount = getRow<{ n: number }>("SELECT COUNT(*) AS n FROM projects")!.n;
  await assert.rejects(
    () => importProject(buffer),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400
  );
  const afterProjectCount = getRow<{ n: number }>("SELECT COUNT(*) AS n FROM projects")!.n;
  assert.equal(afterProjectCount, beforeProjectCount, "拒否されたインポートで project 行が増えてはいけない");
});

test("guruzip インポート: 失敗時はファイル未書き込みでも空の projects/<newId>/ ディレクトリを残さない", async () => {
  const { dataRoot } = await import("./db.ts");
  const fs = await import("node:fs/promises");
  const projectsRoot = join(dataRoot, "projects");
  const before = new Set(await fs.readdir(projectsRoot).catch(() => [] as string[]));

  // files/ を含まない zip + DB INSERT を確実に失敗させる不正カラム名 → ファイルを1つも書かない失敗経路。
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({ app: "guruguru", kind: "project-export", formatVersion: 1, counts: {}, warnings: [] })
  );
  zip.file(
    "data.json",
    JSON.stringify({
      project: { id: "project_orphan", name: "Orphan", mode: "single", storage_dir: "gguru://project/", canvas_width: 1024, canvas_height: 1446, ["bad-column"]: 1 },
      tables: {},
      shared: {}
    })
  );
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => importProject(buffer));

  const after = await fs.readdir(projectsRoot).catch(() => [] as string[]);
  const leaked = after.filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], "失敗したインポートが空のプロジェクトディレクトリを残している");
});

test("guruzip エクスポート: 存在しない project は404", async () => {
  await assert.rejects(
    () => exportProject("project_does_not_exist"),
    (error: unknown) => error instanceof HttpError && error.statusCode === 404
  );
});

test("guruzip インポート: data.json の files/ 内容が新 projectRoot に展開される(圧縮往復)", async () => {
  const fixture = await buildFixtureProject("files");
  const exportResult = await exportProject(fixture.projectId);
  const zip = await JSZip.loadAsync(exportResult.buffer);
  const fileNames = Object.keys(zip.files).filter((name) => name.startsWith("files/") && !zip.files[name]!.dir);
  assert.ok(fileNames.length > 0, "files/ にエントリが無い");

  const importResult = await importProject(exportResult.buffer);
  const newProjectId = String(importResult.project.id);
  const newProjectRow = getRow<{ storage_dir: string }>("SELECT storage_dir FROM projects WHERE id = ?", [newProjectId]);
  const fs = await import("node:fs/promises");
  for (const name of fileNames) {
    const rel = name.slice("files/".length);
    await assert.doesNotReject(fs.stat(join(newProjectRow!.storage_dir, ...rel.split("/"))));
  }
});
