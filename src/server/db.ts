import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ComfySettings } from "../shared/types";

export const dataRoot = resolve(process.env.GURUGURU_DATA_DIR ?? "data");
mkdirSync(dataRoot, { recursive: true });

const dbPath = join(dataRoot, "app.db");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

const jsonColumnNames = new Map<string, string>([
  ["workflow_json", "workflowJson"],
  ["role_map_json", "roleMap"],
  ["request_json", "request"],
  ["patched_workflow_json", "patchedWorkflow"],
  ["params_json", "params"],
  ["last_error_json", "lastError"]
]);

export const defaultComfySettings: ComfySettings = {
  baseUrl: "http://127.0.0.1:8188",
  websocketUrl: "ws://127.0.0.1:8188/ws",
  timeoutSeconds: 60,
  imageFetchMode: "view",
  storageDir: dataRoot
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
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS generation_rounds (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      parent_round_id TEXT,
      round_index INTEGER NOT NULL,
      prompt_id TEXT,
      status TEXT NOT NULL,
      generation_mode TEXT NOT NULL,
      preset_id TEXT,
      request_json TEXT NOT NULL,
      patched_workflow_json TEXT,
      last_error_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (template_id) REFERENCES workflow_templates(id),
      FOREIGN KEY (parent_round_id) REFERENCES generation_rounds(id)
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
      comfy_output_node_id TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_rounds_project ON generation_rounds(project_id, round_index);
    CREATE INDEX IF NOT EXISTS idx_assets_project_round ON assets(project_id, round_id, batch_index);
    CREATE INDEX IF NOT EXISTS idx_asset_parents_parent ON asset_parents(parent_asset_id);
    CREATE INDEX IF NOT EXISTS idx_asset_parents_child ON asset_parents(child_asset_id);
  `);

  const existing = getSetting<ComfySettings>("comfy");
  if (!existing) {
    setSetting("comfy", defaultComfySettings);
  }
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
  return statement.run(...params);
}

export function getRow<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
  const statement = db.prepare(sql);
  return (statement.get(...params) as T | undefined) ?? null;
}

export function getRows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const statement = db.prepare(sql);
  return statement.all(...params) as T[];
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
