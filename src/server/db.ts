import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Database } from "bun:sqlite";
import { DEFAULT_WEB_SAM_MODEL_BASE_URL } from "../shared/constants";
import type { ComfySettings, LlmSettings, VlmAuditSettings } from "../shared/types";
import { isPathInsideOrEqual } from "./paths";
import { resolveServerEnvironment } from "./serverEnv";

// 環境変数の解決は serverEnv.ts の型付きリゾルバへ集約(テストモード時はテスト用
// ディレクトリが GURUGURU_DATA_DIR より必ず優先される)。
const serverEnv = resolveServerEnvironment();
const isTestDataMode = serverEnv.isTestDataMode;
export const instanceMode = serverEnv.instanceMode;
type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export const dataRoot = serverEnv.dataRoot;
assertDataRootIsNotProjectLocal(dataRoot);
mkdirSync(dataRoot, { recursive: true });

export const dbPath = join(dataRoot, "app.db");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
const databaseContext = new AsyncLocalStorage<Database>();

/**
 * 現在のDBをインメモリへ複製する。dry-runはこのsnapshotを使い、本番接続上で
 * SAVEPOINTを開かない（別request/background writeを誤rollbackしないため）。
 */
export function createIsolatedDatabaseSnapshot(): Database {
  // sqlite3_serialize keeps the source file header's WAL read/write versions (bytes 18/19 = 2).
  // An anonymous deserialized DB has no sibling `-wal` path, so its first prepared statement then
  // fails with SQLITE_CANTOPEN. The serialized image already contains the connection's current
  // logical contents; clone it and switch only those documented header bytes back to rollback mode.
  const serialized = Uint8Array.from(db.serialize());
  if (serialized.length >= 20) {
    serialized[18] = 1;
    serialized[19] = 1;
  }
  const snapshot = Database.deserialize(serialized);
  snapshot.exec("PRAGMA journal_mode = MEMORY");
  snapshot.exec("PRAGMA foreign_keys = ON");
  return snapshot;
}

/** runSql/getRow/getRowsだけを指定connectionへ向けるasync-context境界。 */
export function withDatabaseConnection<T>(connection: Database, action: () => T): T {
  return databaseContext.run(connection, action);
}

function activeDatabase(): Database {
  return databaseContext.getStore() ?? db;
}

// projectTransfer.ts(.guruzip エクスポート/インポート)が「この列は JSON なので parse して
// 再帰的にパス/ID を書き換える」判定に使うため export する(toApiRow のロジックとは独立に必要)。
export const jsonColumnNames = new Map<string, string>([
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
  ["must_not_change_json", "mustNotChange"],
  ["mask_json", "mask"],
  ["reference_snapshot_json", "referenceSnapshot"],
  ["parsed_json", "parsed"],
  ["warnings_json", "warnings"],
  ["warning_json", "warning"],
  ["items_json", "items"],
  ["plan_json", "plan"],
  ["validation_json", "validation"],
  ["evaluation_json", "evaluation"],
  ["export_manifest_json", "exportManifest"],
  ["generation_budget_json", "generationBudget"],
  ["panel_spec_json", "panelSpec"],
  ["reference_manifest_json", "referenceManifest"],
  ["candidate_asset_ids_json", "candidateAssetIds"],
  ["scores_json", "scores"],
  ["reuse_source_json", "reuseSource"],
  ["dependency_task_ids_json", "dependencyTaskIds"]
]);

export const defaultComfySettings: ComfySettings = {
  baseUrl: serverEnv.defaultComfyBaseUrl,
  websocketUrl: serverEnv.defaultComfyWebsocketUrl,
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

export const defaultVlmAuditSettings: VlmAuditSettings = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "gemma-4-e2b-uncensored-hauhaucs-aggressive",
  transport: "lmstudio-native",
  modelKey: "gemma-4-e2b-uncensored-hauhaucs-aggressive",
  temperature: 0,
  timeoutSeconds: 180,
  maxReferenceImages: 3,
  passThreshold: 0.65,
  contextLength: 4096,
  manageModelLifecycle: true,
  releaseComfyBeforeAudit: true,
  unloadAfterAudit: true
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

    -- Versioned, human-approved character identity references. Appearance text is intentionally
    -- separate from characters.notes (voice/personality/relationships). Image paths remain server
    -- private and always point inside the external OS user-data root.
    CREATE TABLE IF NOT EXISTS character_reference_sets (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      variant_id TEXT NOT NULL DEFAULT 'default',
      model_family TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'uploaded',
      appearance_ja TEXT NOT NULL DEFAULT '',
      appearance_prompt_en TEXT NOT NULL DEFAULT '',
      must_not_change_json TEXT NOT NULL DEFAULT '[]',
      appearance_hash TEXT NOT NULL,
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
      UNIQUE (character_id, variant_id, model_family, version)
    );

    CREATE TABLE IF NOT EXISTS character_reference_images (
      id TEXT PRIMARY KEY,
      reference_set_id TEXT NOT NULL,
      role TEXT NOT NULL,
      file_path TEXT,
      width INTEGER,
      height INTEGER,
      crop_json TEXT,
      mask_json TEXT,
      checksum TEXT NOT NULL DEFAULT '',
      asset_id TEXT,
      round_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (reference_set_id) REFERENCES character_reference_sets(id) ON DELETE CASCADE,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL,
      FOREIGN KEY (round_id) REFERENCES generation_rounds(id) ON DELETE SET NULL,
      UNIQUE (reference_set_id, role)
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
      balloon_style TEXT NOT NULL DEFAULT 'normal',
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
      text_override TEXT,
      semantic_kind_override TEXT,
      speaker_label_override TEXT,
      order_index_override INTEGER,
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

    -- コマ割り前ビート注釈(ネームv4 D2)。script revision 単位のキャッシュ。候補を何回
    -- 再生成しても LLM 注釈は1回で済ませる。フォールバック注釈は保存しない(LLM 復帰時に再注釈)。
    CREATE TABLE IF NOT EXISTS script_beat_annotations (
      id TEXT PRIMARY KEY,
      script_revision_id TEXT NOT NULL,
      annotator_version TEXT NOT NULL,
      beats_json TEXT NOT NULL,
      provenance_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (script_revision_id, annotator_version),
      FOREIGN KEY (script_revision_id) REFERENCES script_revisions(id) ON DELETE CASCADE
    );

    -- プラン候補(ネームv4 D3)。候補 = N1結果(ページ割り+importance/turnHook+事前選択レイアウト)。
    -- 再生成を複数回走らせて貯め、ワイヤーフレームで見比べて採用する。採用/破棄の履歴は
    -- status で残す(将来の ranker 学習データ)。既存 script_manga_plans/runs の FK 意味論には触れない。
    CREATE TABLE IF NOT EXISTS script_manga_plan_candidates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      script_id TEXT NOT NULL,
      script_revision_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      profile TEXT,
      temperature REAL,
      plan_json TEXT NOT NULL,
      provenance_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      adopted_run_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (script_id) REFERENCES manga_scripts(id) ON DELETE CASCADE,
      FOREIGN KEY (script_revision_id) REFERENCES script_revisions(id) ON DELETE CASCADE,
      FOREIGN KEY (adopted_run_id) REFERENCES script_manga_runs(id) ON DELETE SET NULL
    );

    -- Fountain revision から構築した、編集・検証可能な MangaPlanV2。画像生成より先に必ず保存する。
    CREATE TABLE IF NOT EXISTS script_manga_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      script_id TEXT NOT NULL,
      script_revision_id TEXT NOT NULL,
      plan_version INTEGER NOT NULL DEFAULT 2,
      planner_version TEXT NOT NULL,
      prompt_compiler_version TEXT NOT NULL,
      dialogue_policy TEXT NOT NULL DEFAULT 'preserve',
      status TEXT NOT NULL DEFAULT 'draft',
      plan_json TEXT NOT NULL,
      validation_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (script_id) REFERENCES manga_scripts(id) ON DELETE CASCADE,
      FOREIGN KEY (script_revision_id) REFERENCES script_revisions(id) ON DELETE RESTRICT
    );

    -- Fountain → plan → page/panel → image → audit → balloon の一括実行。run は再起動後も
    -- 同じ revision/plan から進捗を再構成でき、task は PanelSpec と generation_round を結ぶ。
    CREATE TABLE IF NOT EXISTS script_manga_runs (
      id TEXT PRIMARY KEY,
      predecessor_run_id TEXT,
      project_id TEXT NOT NULL,
      script_id TEXT NOT NULL,
      script_revision_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      plan_version INTEGER NOT NULL DEFAULT 2,
      planner_version TEXT NOT NULL DEFAULT '',
      prompt_compiler_version TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'preparing',
      phase TEXT NOT NULL DEFAULT 'parsing',
      approval_status TEXT NOT NULL DEFAULT 'pending',
      page_count INTEGER NOT NULL DEFAULT 0,
      panel_count INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      evaluation_json TEXT,
      export_manifest_json TEXT,
      generation_budget_json TEXT NOT NULL DEFAULT '{}',
      last_error_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (predecessor_run_id) REFERENCES script_manga_runs(id) ON DELETE SET NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (script_id) REFERENCES manga_scripts(id) ON DELETE CASCADE,
      FOREIGN KEY (script_revision_id) REFERENCES script_revisions(id) ON DELETE RESTRICT,
      FOREIGN KEY (plan_id) REFERENCES script_manga_plans(id) ON DELETE RESTRICT
    );

    -- run が所有するページ。page_index の UNIQUE 制約により resume/retry でページを重複作成しない。
    CREATE TABLE IF NOT EXISTS script_manga_run_pages (
      run_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      page_index INTEGER NOT NULL,
      layout_template_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (run_id, page_index),
      UNIQUE (page_id),
      FOREIGN KEY (run_id) REFERENCES script_manga_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS script_manga_tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      round_id TEXT,
      prompt TEXT NOT NULL,
      panel_spec_json TEXT,
      reference_manifest_json TEXT NOT NULL DEFAULT '[]',
      candidate_asset_ids_json TEXT NOT NULL DEFAULT '[]',
      selected_asset_id TEXT,
      scores_json TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      repair_parent_task_id TEXT,
      inherited_from_task_id TEXT,
      reuse_fingerprint TEXT,
      reuse_source_json TEXT,
      dependency_task_ids_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      asset_id TEXT,
      last_error_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (run_id) REFERENCES script_manga_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES generation_rounds(id) ON DELETE SET NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL,
      FOREIGN KEY (selected_asset_id) REFERENCES assets(id) ON DELETE SET NULL,
      FOREIGN KEY (repair_parent_task_id) REFERENCES script_manga_tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (inherited_from_task_id) REFERENCES script_manga_tasks(id) ON DELETE SET NULL
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
    CREATE INDEX IF NOT EXISTS idx_character_reference_sets_character
      ON character_reference_sets(character_id, variant_id, model_family, version DESC);
    CREATE INDEX IF NOT EXISTS idx_character_reference_sets_status
      ON character_reference_sets(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_character_reference_images_set
      ON character_reference_images(reference_set_id, role);
    CREATE INDEX IF NOT EXISTS idx_dialogue_proposals_page ON dialogue_proposals(page_id);
    CREATE INDEX IF NOT EXISTS idx_script_manga_runs_project ON script_manga_runs(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_script_manga_plans_project ON script_manga_plans(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_script_manga_plans_revision ON script_manga_plans(script_revision_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_script_manga_tasks_run ON script_manga_tasks(run_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_script_manga_tasks_panel ON script_manga_tasks(run_id, page_id, panel_id);
    CREATE INDEX IF NOT EXISTS idx_script_manga_plan_candidates_script
      ON script_manga_plan_candidates(script_id, script_revision_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_script_beat_annotations_revision
      ON script_beat_annotations(script_revision_id, annotator_version);

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
  ensureColumn("workflow_templates", "prompt_dialect", "TEXT NOT NULL DEFAULT 'natural'");
  ensureColumn("workflow_templates", "quality_tags", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("workflow_templates", "negative_base", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("generation_rounds", "branch_color_index", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("generation_rounds", "branch_reason", "TEXT");
  ensureColumn("generation_rounds", "branch_key", "TEXT");
  ensureColumn("generation_rounds", "page_id", "TEXT");
  // ネームスタジオV5 D5: 基礎プランを不変に保ち、人間のレイアウト選択と楽観ロックを別カラムで持つ。
  ensureColumn("script_manga_plan_candidates", "layout_overrides_json", "TEXT");
  ensureColumn("script_manga_plan_candidates", "edit_version", "INTEGER NOT NULL DEFAULT 0");
  // 人間ゲートのコマ割り修正: pageIndex→編集済みPageLayout / pageIndex→orderIndex→吹き出し中心ヒント。
  ensureColumn("script_manga_plan_candidates", "custom_layouts_json", "TEXT");
  ensureColumn("script_manga_plan_candidates", "balloon_hints_json", "TEXT");
  // V5 D6: plan_json への全書き込みで加算する内容バージョン(差分編集の楽観ロック)。
  ensureColumn("script_manga_plans", "edit_version", "INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_rounds_project_page ON generation_rounds(project_id, page_id)");
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
  ensureColumn("generation_rounds", "warning_json", "TEXT");
  // S1 v2: Provider 中立のネイティブジョブ参照。comfy は prompt_id と同値を二重書きする
  // (レガシー列の宣言は下記コメント参照)。読み側は `provider_job_ref ?? prompt_id` を読み、
  // v2 導入前の旧行(NULL)にも後方互換で動く(rounds.ts の jobNativeRef)。
  ensureColumn("generation_jobs", "provider_job_ref", "TEXT");
  // Chronicle Page Flow(Docs/Done/Feature-ChroniclePageFlow.md §2.4 フェーズIII): 自動配置の再現・ロック管理用。
  // auto_layout_locked=1 は手動編集済みで再配置対象外、auto_layout_seed/version は preview/apply の再現用。
  ensureColumn("dialogue_placements", "auto_layout_locked", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("dialogue_placements", "auto_layout_seed", "INTEGER");
  ensureColumn("dialogue_placements", "auto_layout_version", "INTEGER");
  // Revision-frozen automatic manga lettering. Manual/editor placements leave these NULL and keep
  // reading the live DialogueLine; run-owned placements retain the exact pinned-revision wording.
  ensureColumn("dialogue_placements", "text_override", "TEXT");
  ensureColumn("dialogue_placements", "semantic_kind_override", "TEXT");
  ensureColumn("dialogue_placements", "speaker_label_override", "TEXT");
  ensureColumn("dialogue_placements", "order_index_override", "INTEGER");
  ensureColumn("dialogue_lines", "balloon_style", "TEXT NOT NULL DEFAULT 'normal'");
  // Links a generation attempt to its owning automatic-manga task before provider submission.
  ensureColumn("generation_rounds", "script_manga_task_id", "TEXT");
  // MangaPlanV2/control layer: existing databases receive nullable relationship columns first;
  // all newly-created runs populate them before any page or generation side effect.
  ensureColumn("script_manga_runs", "script_revision_id", "TEXT");
  ensureColumn("script_manga_runs", "predecessor_run_id", "TEXT");
  ensureColumn("script_manga_runs", "plan_id", "TEXT");
  ensureColumn("script_manga_runs", "plan_version", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("script_manga_runs", "planner_version", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("script_manga_runs", "prompt_compiler_version", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("script_manga_runs", "phase", "TEXT NOT NULL DEFAULT 'parsing'");
  ensureColumn("script_manga_runs", "approval_status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn("script_manga_runs", "evaluation_json", "TEXT");
  ensureColumn("script_manga_runs", "export_manifest_json", "TEXT");
  ensureColumn("script_manga_runs", "generation_budget_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("script_manga_runs", "reference_snapshot_json", "TEXT");
  ensureColumn("script_manga_tasks", "panel_spec_json", "TEXT");
  ensureColumn("script_manga_tasks", "reference_manifest_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("script_manga_tasks", "candidate_asset_ids_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("script_manga_tasks", "selected_asset_id", "TEXT");
  ensureColumn("script_manga_tasks", "scores_json", "TEXT");
  ensureColumn("script_manga_tasks", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("script_manga_tasks", "repair_parent_task_id", "TEXT");
  ensureColumn("script_manga_tasks", "inherited_from_task_id", "TEXT");
  ensureColumn("script_manga_tasks", "reuse_fingerprint", "TEXT");
  ensureColumn("script_manga_tasks", "reuse_source_json", "TEXT");
  ensureColumn("script_manga_tasks", "dependency_task_ids_json", "TEXT NOT NULL DEFAULT '[]'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_generation_rounds_script_manga_task ON generation_rounds(script_manga_task_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_script_manga_runs_predecessor ON script_manga_runs(predecessor_run_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_script_manga_tasks_inherited_from ON script_manga_tasks(inherited_from_task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_script_manga_tasks_reuse_fingerprint ON script_manga_tasks(reuse_fingerprint)");
  // ALTER TABLE cannot add foreign keys on existing SQLite databases. These triggers give upgraded
  // databases the same SET NULL behavior as the fresh schema for optional manga lineage links.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_assets_clear_script_manga_selected
    AFTER DELETE ON assets BEGIN
      UPDATE script_manga_tasks SET selected_asset_id = NULL, asset_id = NULL
      WHERE selected_asset_id = OLD.id OR asset_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_script_manga_task_clear_repair_parent
    AFTER DELETE ON script_manga_tasks BEGIN
      UPDATE script_manga_tasks SET repair_parent_task_id = NULL WHERE repair_parent_task_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_script_manga_run_clear_predecessor
    AFTER DELETE ON script_manga_runs BEGIN
      UPDATE script_manga_runs SET predecessor_run_id = NULL WHERE predecessor_run_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_script_manga_task_clear_inherited_from
    AFTER DELETE ON script_manga_tasks BEGIN
      UPDATE script_manga_tasks SET inherited_from_task_id = NULL WHERE inherited_from_task_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_script_manga_task_clear_round_link
    AFTER DELETE ON script_manga_tasks BEGIN
      UPDATE generation_rounds SET script_manga_task_id = NULL WHERE script_manga_task_id = OLD.id;
    END;
  `);
  // このトリガ導入前に task 削除でダングリングした script_manga_task_id を一括NULL化
  // (deleteRoundTree の409ガードが恒久的に該当Roundを削除不能にしていた)。
  db.exec(`
    UPDATE generation_rounds SET script_manga_task_id = NULL
    WHERE script_manga_task_id IS NOT NULL
      AND script_manga_task_id NOT IN (SELECT id FROM script_manga_tasks)
  `);

  // A crash before materializeRun's terminal phase update can leave partial run-owned pages/tasks.
  // They were never observable as an adopted run, so remove the orphan atomically before releasing
  // the claim. This prevents a retry from accumulating inaccessible run-owned pages.
  const incompleteCandidateRuns = getRows<{ id: string; plan_id: string }>(`
    SELECT run.id, run.plan_id
      FROM script_manga_runs run
      JOIN script_manga_plan_candidates candidate
        ON candidate.id = json_extract(run.config_json, '$.planCandidateId')
     WHERE candidate.status = 'adopting'
       AND candidate.adopted_run_id IS NULL
       AND run.phase = 'planning'
  `);
  for (const run of incompleteCandidateRuns) {
    const pageIds = getRows<{ page_id: string }>(
      "SELECT page_id FROM script_manga_run_pages WHERE run_id = ?",
      [run.id]
    );
    runSql("SAVEPOINT recover_incomplete_candidate_run");
    try {
      runSql("DELETE FROM script_manga_runs WHERE id = ?", [run.id]);
      for (const page of pageIds) runSql("DELETE FROM pages WHERE id = ?", [page.page_id]);
      runSql(
        "DELETE FROM script_manga_plans WHERE id = ? AND NOT EXISTS (SELECT 1 FROM script_manga_runs WHERE plan_id = ?)",
        [run.plan_id, run.plan_id]
      );
      runSql("RELEASE SAVEPOINT recover_incomplete_candidate_run");
    } catch (error) {
      runSql("ROLLBACK TO SAVEPOINT recover_incomplete_candidate_run");
      runSql("RELEASE SAVEPOINT recover_incomplete_candidate_run");
      throw error;
    }
  }

  // A crash can occur after a candidate-owned run finished materialization but before the final
  // candidate update. Reconcile that durable identity first; only claim-only/planning orphans go
  // back to active. config_json is written in the initial run INSERT specifically for this recovery.
  runSql(`
    UPDATE script_manga_plan_candidates
       SET status = 'adopted',
           adopted_run_id = (
             SELECT run.id
               FROM script_manga_runs run
              WHERE json_extract(run.config_json, '$.planCandidateId') = script_manga_plan_candidates.id
                AND run.phase <> 'planning'
              ORDER BY run.created_at DESC, run.id DESC
              LIMIT 1
           )
     WHERE status = 'adopting'
       AND adopted_run_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM script_manga_runs run
          WHERE json_extract(run.config_json, '$.planCandidateId') = script_manga_plan_candidates.id
            AND run.phase <> 'planning'
       )
  `);
  runSql(
    "UPDATE script_manga_plan_candidates SET status = 'active' WHERE status = 'adopting' AND adopted_run_id IS NULL"
  );

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
  if (!getSetting<Partial<VlmAuditSettings>>("vlm_audit")) {
    setSetting("vlm_audit", defaultVlmAuditSettings);
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

// bun:sqlite の query() は prepare() と違い、コンパイル済みステートメントを
// Database インスタンス毎にキャッシュする(SQL文字列がキー)。キャッシュは
// インスタンスに紐づくので、withDatabaseConnection のスナップショットDBは自分の
// キャッシュを持ち、close() で一緒に解放される(本体 db と混線しない)。
// IN句の可変プレースホルダ等の動的SQLはバリアント数が要素数/スキーマ列数で
// 有界なので、無限成長の懸念はない。
export function runSql(sql: string, params: unknown[] = []) {
  const statement = activeDatabase().query(sql);
  return statement.run(...(params as SqlValue[]));
}

export function getRow<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
  const statement = activeDatabase().query(sql);
  return (statement.get(...(params as SqlValue[])) as T | undefined) ?? null;
}

export function getRows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const statement = activeDatabase().query(sql);
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
