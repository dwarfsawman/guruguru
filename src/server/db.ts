import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { DEFAULT_WEB_SAM_MODEL_BASE_URL } from "../shared/constants";
import type { ComfySettings, LlmSettings } from "../shared/types";
import { isPathInsideOrEqual } from "./paths";

const isTestDataMode = process.env.GURUGURU_TEST_DB === "1" || process.env.NODE_ENV === "test";
type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export const dataRoot = resolveDataRoot();
assertDataRootIsNotProjectLocal(dataRoot);
mkdirSync(dataRoot, { recursive: true });

export const dbPath = join(dataRoot, "app.db");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);

const jsonColumnNames = new Map<string, string>([
  ["workflow_json", "workflowJson"],
  ["role_map_json", "roleMap"],
  ["request_json", "request"],
  ["patched_workflow_json", "patchedWorkflow"],
  ["params_json", "params"],
  ["last_error_json", "lastError"],
  ["layout_json", "layout"],
  ["crop_json", "crop"],
  ["objects_json", "objects"],
  ["mosaic_json", "mosaic"],
  ["intent_json", "intent"],
  ["provider_snapshot_json", "providerSnapshot"],
  ["aliases_json", "aliases"],
  ["binding_json", "binding"],
  ["parsed_json", "parsed"],
  ["warnings_json", "warnings"],
  ["items_json", "items"]
]);

export const defaultComfySettings: ComfySettings = {
  baseUrl: "http://127.0.0.1:8188",
  websocketUrl: "ws://127.0.0.1:8188/ws",
  timeoutSeconds: 60,
  imageFetchMode: "view",
  storageDir: dataRoot,
  webSamModelBaseUrl: DEFAULT_WEB_SAM_MODEL_BASE_URL
};

export const defaultLlmSettings: LlmSettings = {
  baseUrl: "",
  model: "",
  systemPrompt:
    "あなたはComfyUIのプロンプト作成を支援するアシスタントです。画像生成に適した、具体的で効果的なプロンプトを提案してください。",
  temperature: 0.4
};

export function initializeDb() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      default_template_id TEXT,
      storage_dir TEXT NOT NULL,
      canvas_width INTEGER NOT NULL DEFAULT 1024,
      canvas_height INTEGER NOT NULL DEFAULT 1446,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (default_template_id) REFERENCES workflow_templates(id)
    );

    CREATE TABLE IF NOT EXISTS workflow_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      workflow_json TEXT NOT NULL,
      role_map_json TEXT NOT NULL,
      workflow_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    );

    -- S1 v2 (Docs/Feature-ScriptToManga.md): prompt_id / patched_workflow_json は ComfyProvider の
    -- レガシー列(ComfyProvider だけが書く。他 Provider は触らない)。汎用列は provider_id/intent_json/
    -- provider_snapshot_json(ensureColumn で追記、下記参照)。
    CREATE TABLE IF NOT EXISTS generation_rounds (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      parent_round_id TEXT,
      round_index INTEGER NOT NULL,
      prompt_id TEXT, -- レガシー(comfy のみ書く)
      status TEXT NOT NULL,
      generation_mode TEXT NOT NULL,
      branch_color_index INTEGER NOT NULL DEFAULT 0,
      branch_reason TEXT,
      branch_key TEXT,
      preset_id TEXT,
      request_json TEXT NOT NULL,
      patched_workflow_json TEXT, -- レガシー(comfy のみ書く)
      last_error_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (template_id) REFERENCES workflow_templates(id),
      FOREIGN KEY (parent_round_id) REFERENCES generation_rounds(id)
    );

    -- S1 v2: prompt_id / client_id は ComfyProvider のレガシー列。汎用列は provider_job_ref
    -- (ensureColumn で追記、下記参照)。読み側は rounds.ts の jobNativeRef(provider_job_ref ?? prompt_id)。
    CREATE TABLE IF NOT EXISTS generation_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      batch_index INTEGER NOT NULL,
      prompt_id TEXT, -- レガシー(comfy のみ書く)
      client_id TEXT NOT NULL, -- レガシー(comfy のみ書く)
      seed INTEGER,
      status TEXT NOT NULL,
      last_error_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      queued_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES generation_rounds(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      prompt_id TEXT,
      batch_index INTEGER NOT NULL,
      image_path TEXT NOT NULL,
      thumbnail_small_path TEXT NOT NULL,
      thumbnail_medium_path TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      prompt TEXT NOT NULL DEFAULT '',
      negative_prompt TEXT NOT NULL DEFAULT '',
      seed INTEGER,
      sampler TEXT NOT NULL DEFAULT '',
      scheduler TEXT NOT NULL DEFAULT '',
      steps INTEGER,
      cfg REAL,
      denoise REAL,
      model_name TEXT,
      workflow_template_id TEXT NOT NULL,
      workflow_template_version INTEGER NOT NULL,
      workflow_snapshot_hash TEXT NOT NULL,
      comfy_output_node_id TEXT, -- S1 v2: ComfyProvider のレガシー列(他 Provider は触らない)
      status TEXT NOT NULL DEFAULT 'generated',
      rating INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES generation_rounds(id) ON DELETE CASCADE,
      FOREIGN KEY (workflow_template_id) REFERENCES workflow_templates(id)
    );

    CREATE TABLE IF NOT EXISTS asset_parents (
      id TEXT PRIMARY KEY,
      parent_asset_id TEXT NOT NULL,
      child_asset_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      strength REAL,
      preset_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_asset_id) REFERENCES assets(id) ON DELETE CASCADE,
      FOREIGN KEY (child_asset_id) REFERENCES assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS selection_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      round_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      action TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES generation_rounds(id) ON DELETE CASCADE,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      generation_mode TEXT NOT NULL,
      template_id TEXT,
      params_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (template_id) REFERENCES workflow_templates(id)
    );

    CREATE TABLE IF NOT EXISTS paste_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS asset_paste_attachments (
      asset_id TEXT PRIMARY KEY,
      objects_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      page_index INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS layout_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'imported',
      layout_json TEXT NOT NULL,
      source_json5 TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS page_panel_assignments (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      crop_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
    );

    -- ImageObject の Asset 寿命問題対策(Docs/Feature-ScriptToManga.md S2): ページオブジェクトから
    -- 参照する画像は配置時に projects/<id>/page_media/ へコピーする。Round/Asset 削除で assetId 参照が
    -- 孤児化しない(source_asset_id は来歴のみ、ON DELETE SET NULL)。
    CREATE TABLE IF NOT EXISTS page_media (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      source_asset_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (source_asset_id) REFERENCES assets(id) ON DELETE SET NULL
    );

    -- 脚本ドメイン(Docs/Feature-ScriptToManga.md S3): Character は Provider 中立(name/aliases/notes/color)。
    -- 顔参照/LoRA 等 Provider 別の設定は character_bindings へ分離する(将来の外部 Provider が別形式を持てる)。
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases_json TEXT,
      notes TEXT NOT NULL DEFAULT '',
      color TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- comfy: { faceImagePath?, loraName?, loraStrength? }(provider が検証)。faceImagePath はサーバ内部の
    -- 絶対パスであり API では直接返さない(GET は存在フラグ+配信 URL に変換する。既知の罠11)。
    CREATE TABLE IF NOT EXISTS character_bindings (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS manga_scripts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- 脚本原文と parse 結果は不変保存(再取り込みは新 revision の追加)。fountain_source / parsed_json は
    -- INSERT 後に更新しない。
    CREATE TABLE IF NOT EXISTS script_revisions (
      id TEXT PRIMARY KEY,
      script_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      fountain_source TEXT NOT NULL,
      parsed_json TEXT NOT NULL,
      warnings_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (script_id) REFERENCES manga_scripts(id) ON DELETE CASCADE
    );

    -- DialogueLine(物語上の台詞)。DialoguePlacement(ページ上の配置)とは1対多で分離する
    -- (1台詞を複数吹き出しへ分割できるように)。semantic_kind は台詞の属性(会話/心の声/ナレーション/SFX)。
    CREATE TABLE IF NOT EXISTS dialogue_lines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      script_id TEXT,
      character_id TEXT,
      speaker_label TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      semantic_kind TEXT NOT NULL DEFAULT 'dialogue',
      emotion TEXT,
      order_index INTEGER NOT NULL DEFAULT 0,
      scene_index INTEGER,
      source_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'fountain',
      proposal_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (script_id) REFERENCES manga_scripts(id) ON DELETE SET NULL,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
    );

    -- DialoguePlacement(ページ上の配置)。panel_id は layout.panels の JSON id を指すため FK は張れない
    -- (実在検証はアプリ側、rounds.ts の targetPanelId 検証と同じ前例)。render_kind=balloon の場合、
    -- balloon_object_id が対応する PageObject(pages.objects_json 内)の id を指す(双方向リンク)。
    CREATE TABLE IF NOT EXISTS dialogue_placements (
      id TEXT PRIMARY KEY,
      line_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      panel_id TEXT,
      part_index INTEGER NOT NULL DEFAULT 0,
      render_kind TEXT NOT NULL DEFAULT 'balloon',
      balloon_object_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (line_id) REFERENCES dialogue_lines(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    );

    -- 構造化 LLM セリフ提案(Docs/Feature-ScriptToManga.md S4)。LLM の生出力・モデル名・脚本 revision・
    -- 項目別の採用履歴(items_json)を永続化する。script_revision_id は提案時点の revision id(stale 判定用、
    -- 最新 revision と比較する派生値なので列としては持たない -- dialogueProposals.ts が都度計算する)。
    CREATE TABLE IF NOT EXISTS dialogue_proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      script_id TEXT,
      script_revision_id TEXT,
      page_id TEXT,
      model TEXT NOT NULL,
      request_json TEXT NOT NULL,
      raw_output TEXT,
      items_json TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (script_id) REFERENCES manga_scripts(id) ON DELETE SET NULL,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_character_bindings_char_provider ON character_bindings(character_id, provider_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_script_revisions_script_rev ON script_revisions(script_id, revision);
    CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id);
    CREATE INDEX IF NOT EXISTS idx_manga_scripts_project ON manga_scripts(project_id);
    CREATE INDEX IF NOT EXISTS idx_dialogue_lines_project ON dialogue_lines(project_id);
    CREATE INDEX IF NOT EXISTS idx_dialogue_lines_script ON dialogue_lines(script_id);
    CREATE INDEX IF NOT EXISTS idx_dialogue_placements_line ON dialogue_placements(line_id);
    CREATE INDEX IF NOT EXISTS idx_dialogue_placements_page ON dialogue_placements(page_id);
    CREATE INDEX IF NOT EXISTS idx_dialogue_proposals_project ON dialogue_proposals(project_id);
    CREATE INDEX IF NOT EXISTS idx_dialogue_proposals_page ON dialogue_proposals(page_id);

    CREATE INDEX IF NOT EXISTS idx_paste_sources_project ON paste_sources(project_id);
    CREATE INDEX IF NOT EXISTS idx_page_media_project ON page_media(project_id);
    CREATE INDEX IF NOT EXISTS idx_pages_project ON pages(project_id, page_index);
    CREATE INDEX IF NOT EXISTS idx_rounds_project ON generation_rounds(project_id, round_index);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_round_batch ON generation_jobs(round_id, batch_index);
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_prompt ON generation_jobs(prompt_id);
    CREATE INDEX IF NOT EXISTS idx_generation_jobs_round_status ON generation_jobs(round_id, status);
    CREATE INDEX IF NOT EXISTS idx_assets_project_round ON assets(project_id, round_id, batch_index);
    CREATE INDEX IF NOT EXISTS idx_asset_parents_parent ON asset_parents(parent_asset_id);
    CREATE INDEX IF NOT EXISTS idx_asset_parents_child ON asset_parents(child_asset_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_page_panel_assignments_page_panel ON page_panel_assignments(page_id, panel_id);
    CREATE INDEX IF NOT EXISTS idx_page_panel_assignments_asset ON page_panel_assignments(asset_id);
  `);
  ensureColumn("workflow_templates", "deleted_at", "TEXT");
  ensureColumn("generation_rounds", "branch_color_index", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("generation_rounds", "branch_reason", "TEXT");
  ensureColumn("generation_rounds", "branch_key", "TEXT");
  ensureColumn("generation_rounds", "page_id", "TEXT");
  ensureColumn("asset_paste_attachments", "enabled", "INTEGER NOT NULL DEFAULT 1");
  // Book モード: 'single'（既定・従来の1枚生成）/ 'book'（複数ページ）。
  ensureColumn("projects", "mode", "TEXT NOT NULL DEFAULT 'single'");
  // Book / OpenRaster export の既定キャンバスサイズ(px)。既存プロジェクトは B5 縦比率へ丸める。
  ensureColumn("projects", "canvas_width", "INTEGER NOT NULL DEFAULT 1024");
  ensureColumn("projects", "canvas_height", "INTEGER NOT NULL DEFAULT 1446");
  // コマ割りテンプレから追加したページの `PageLayout`(JSON)。通常ページは NULL。
  ensureColumn("pages", "layout_json", "TEXT");
  // ページオブジェクト(Docs/Feature-CGCollectionSuite.md P1): テキスト/吹き出し/ボックスの配列(JSON)。
  // 未設定は NULL(toApiRow は `objects: null` を返す。normalizePageObjects(null) は空配列)。
  ensureColumn("pages", "objects_json", "TEXT");
  // モザイクリージョン(Docs/Feature-CGCollectionSuite.md P6): 非破壊リージョンの配列(JSON)。
  // 未設定は NULL(toApiRow は `mosaic: null` を返す。normalizeMosaicRegions(null) は空配列)。
  ensureColumn("pages", "mosaic_json", "TEXT");
  // コマ内生成(Docs/Feature-PanelGeneration.md): この Round がどのコマ向けの生成かを示す。
  // 通常の(コマを対象としない)生成/single モードでは NULL。
  ensureColumn("generation_rounds", "target_panel_id", "TEXT");
  // GenerationIntent/Provider 抽象化(Docs/Feature-ScriptToManga.md S1): この Round を実行した
  // Provider の id。既存行は全て ComfyUI 実行だったため 'comfy' を既定値とする。
  ensureColumn("generation_rounds", "provider_id", "TEXT NOT NULL DEFAULT 'comfy'");
  // 導出済みの GenerationIntent(モデル中立の生成意図)。再現性・将来の re-run 用。旧行は NULL。
  ensureColumn("generation_rounds", "intent_json", "TEXT");
  // submit() 時点の ProviderCapabilities スナップショット。旧行は NULL。
  ensureColumn("generation_rounds", "provider_snapshot_json", "TEXT");
  // S1 v2: Provider 中立のネイティブジョブ参照。comfy は prompt_id と同値を二重書きする
  // (レガシー列の宣言は下記コメント参照)。読み側は `provider_job_ref ?? prompt_id` を読み、
  // v2 導入前の旧行(NULL)にも後方互換で動く(rounds.ts の jobNativeRef)。
  ensureColumn("generation_jobs", "provider_job_ref", "TEXT");

  const existing = getSetting<Partial<ComfySettings>>("comfy");
  if (!existing) {
    setSetting("comfy", defaultComfySettings);
  } else {
    const merged = {
      ...defaultComfySettings,
      ...existing,
      storageDir: dataRoot,
      webSamModelBaseUrl: existing.webSamModelBaseUrl?.trim() || DEFAULT_WEB_SAM_MODEL_BASE_URL
    };
    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      setSetting("comfy", merged);
    }
  }

  if (!getSetting<Partial<LlmSettings>>("llm")) {
    setSetting("llm", defaultLlmSettings);
  }
}

function ensureColumn(tableName: string, columnName: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

export function getSetting<T>(key: string): T | null {
  const row = getRow<{ value_json: string }>("SELECT value_json FROM app_settings WHERE key = ?", [key]);
  if (!row) {
    return null;
  }
  return JSON.parse(row.value_json) as T;
}

export function setSetting(key: string, value: unknown) {
  runSql(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP`,
    [key, JSON.stringify(value)]
  );
}

export function runSql(sql: string, params: unknown[] = []) {
  const statement = db.prepare(sql);
  return statement.run(...(params as SqlValue[]));
}

export function getRow<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
  const statement = db.prepare(sql);
  return (statement.get(...(params as SqlValue[])) as T | undefined) ?? null;
}

export function getRows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const statement = db.prepare(sql);
  return statement.all(...(params as SqlValue[])) as T[];
}

export function toApiRow<T extends Record<string, unknown>>(row: T | null): Record<string, unknown> | null {
  if (!row) {
    return null;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const mappedKey = jsonColumnNames.get(key) ?? snakeToCamel(key);
    if (jsonColumnNames.has(key) && typeof value === "string") {
      out[mappedKey] = parseJsonColumn(value);
    } else {
      out[mappedKey] = value;
    }
  }
  return out;
}

export function toApiRows<T extends Record<string, unknown>>(rows: T[]): Record<string, unknown>[] {
  return rows.map((row) => toApiRow(row)!);
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function parseJsonColumn(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function resolveDataRoot(): string {
  const explicitDataDir = process.env.GURUGURU_DATA_DIR?.trim();
  if (explicitDataDir) {
    return resolve(explicitDataDir);
  }

  if (isTestDataMode) {
    return resolve(process.env.GURUGURU_TEST_DATA_DIR?.trim() || join(tmpdir(), "guruguru-test", `pid-${process.pid}`));
  }

  return defaultUserDataRoot();
}

function defaultUserDataRoot(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "GURUGURU");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "GURUGURU");
  }

  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "guruguru");
}

function assertDataRootIsNotProjectLocal(root: string) {
  if (isTestDataMode) {
    return;
  }

  const projectRoot = resolve(".");
  if (isPathInsideOrEqual(root, projectRoot)) {
    throw new Error(
      `Refusing to use a GURUGURU data directory inside the current project: ${root}. ` +
        "Set GURUGURU_DATA_DIR outside the repository, or set GURUGURU_TEST_DB=1 for test databases."
    );
  }
}
