import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { dataRoot, initializeDb, runSql } from "./db.ts";
import { evaluateDeterministicPanelQuality } from "./deterministicPanelQuality.ts";

test("deterministic quality gate flags a flat collapsed candidate without discarding it", async () => {
  initializeDb();
  const dir = join(dataRoot, "quality-test");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "flat.png");
  await writeFile(path, await sharp({ create: { width: 64, height: 64, channels: 3, background: "#808080" } }).png().toBuffer());
  runSql("INSERT INTO projects (id, name, storage_dir) VALUES ('quality-project', 'quality', ?)", [dir]);
  runSql("INSERT INTO workflow_templates (id, name, type, workflow_json, role_map_json, workflow_hash) VALUES ('missing', 'test', 'txt2img', '{}', '{}', '')");
  runSql(`INSERT INTO generation_rounds (id, project_id, template_id, round_index, status, generation_mode, request_json)
          VALUES ('quality-round', 'quality-project', 'missing', 0, 'completed', 'txt2img', '{}')`);
  runSql(`INSERT INTO assets (id, project_id, round_id, batch_index, image_path, thumbnail_small_path, thumbnail_medium_path,
          prompt, negative_prompt, seed, sampler, scheduler, workflow_template_id, workflow_template_version, workflow_snapshot_hash)
          VALUES ('quality-asset', 'quality-project', 'quality-round', 0, ?, ?, ?, '', '', 0, '', '', 'missing', 1, '')`, [path, path, path]);
  const report = await evaluateDeterministicPanelQuality("quality-asset");
  assert.equal(report.passed, false);
  assert.match(report.violations.join(" "), /near-flat/);
});
