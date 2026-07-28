import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEditedPageLayout } from "../shared/pageLayout.ts";
import { normalizeMangaPlanV2Scales } from "../shared/mangaPlanV2.ts";
import { createId, getRow, initializeDb, runSql } from "./db.ts";
import { createProject } from "./projects.ts";
import { parseConfig } from "./scriptMangaRows.ts";
import { createScript } from "./scripts.ts";
import { buildPanelGenerationRequest, createScriptMangaRun } from "./scriptManga.ts";
import { fakeProvider, resetFakeProvider } from "./providers/fakeProvider.ts";
import { registerProvider } from "./providers/registry.ts";

registerProvider(fakeProvider);

type BuilderInput = Parameters<typeof buildPanelGenerationRequest>[0];

const SCRIPT = ["INT. LAB - NIGHT", "", "@ALICE", "これは……私?"].join("\n");

function controlNetTemplate(): string {
  initializeDb();
  const id = createId("template");
  const workflow = {
    "1": { class_type: "ControlNetLoader", inputs: { control_net_name: "openpose.safetensors" } },
    "2": { class_type: "ControlNetApplyAdvanced", inputs: { image: ["3", 0], strength: 1, start_percent: 0, end_percent: 1 } },
    "3": { class_type: "LoadImage", inputs: { image: "pose.png" } }
  };
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Request parity fake', '', 'txt2img', 1, ?, '{}', 'hash')`,
    [id, JSON.stringify(workflow)]
  );
  return id;
}

// GenerationRequest 組み立ての抽出(buildPanelGenerationRequest)の眼目:
// 同一入力に対して、再利用フィンガープリント用(taskReuseFingerprintForTarget 相当の呼び方)と
// 実生成 submit 用(submitTasks 相当の呼び方)が同一構造の request を返すこと。
test("buildPanelGenerationRequest: fingerprint用とsubmit用が同一入力で同一構造のrequestを返す", async () => {
  resetFakeProvider();
  const templateId = controlNetTemplate();
  const project = createProject({ name: `request-parity-${createId("t")}`, mode: "book" })!;
  const imported = createScript(project.id, { title: "Parity", fountainSource: SCRIPT });
  await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    dialoguePolicy: "preserve",
    auditMode: "manual",
    generateImages: true,
    poseControl: "full"
  });
  const runRow = getRow<BuilderInput["run"] & { plan_id: string | null; config_json: string }>(
    "SELECT * FROM script_manga_runs WHERE project_id = ?",
    [project.id]
  )!;
  const task = getRow<{ page_id: string; panel_id: string; panel_spec_json: string }>(
    "SELECT page_id, panel_id, panel_spec_json FROM script_manga_tasks WHERE run_id = ? ORDER BY created_at ASC LIMIT 1",
    [runRow.id]
  )!;
  const planRow = getRow<{ plan_json: string }>("SELECT plan_json FROM script_manga_plans WHERE id = ?", [runRow.plan_id])!;
  const plan = normalizeMangaPlanV2Scales(JSON.parse(planRow.plan_json)) as BuilderInput["plan"];
  const config = JSON.parse(runRow.config_json) as BuilderInput["config"];
  const layoutRow = getRow<{ layout_json: string | null }>("SELECT layout_json FROM pages WHERE id = ?", [task.page_id])!;
  const layout = normalizeEditedPageLayout(layoutRow.layout_json ? JSON.parse(layoutRow.layout_json) : null)!;
  const templateRow = getRow<{ workflow_json: string }>(
    "SELECT workflow_json FROM workflow_templates WHERE id = ?",
    [templateId]
  )!;

  const common = { run: runRow, plan, config, layout, panelId: task.panel_id } as const;
  // fingerprint 側: reuseTemplateSnapshot 由来の workflow JSON を渡し、providerId は埋め込まない。
  const forFingerprint = await buildPanelGenerationRequest({
    ...common,
    panel: JSON.parse(task.panel_spec_json) as BuilderInput["panel"],
    poseControlWorkflowJson: templateRow.workflow_json
  });
  // submit 側: workflow JSON は promptProfile 既定を使い、providerId を埋め込む。
  const forSubmit = await buildPanelGenerationRequest({
    ...common,
    panel: JSON.parse(task.panel_spec_json) as BuilderInput["panel"],
    providerId: config.providerId
  });

  assert.equal(forSubmit.request.providerId, "fake");
  assert.equal(forFingerprint.request.providerId, undefined);
  assert.ok(forFingerprint.request.controlnet, "poseControl有効+CNテンプレなのでcontrolnetが載る");
  const { providerId: _providerId, ...submitRest } = forSubmit.request;
  assert.deepEqual(submitRest, forFingerprint.request);
  assert.deepEqual(forSubmit.references.manifest, forFingerprint.references.manifest);
  assert.equal(forSubmit.conditioning.positive, forFingerprint.conditioning.positive);
  assert.deepEqual(forSubmit.size, forFingerprint.size);
});

test("run config: batchSize は指定できて、欠けている古い config は 1 に落ちる", () => {
  // 蒸留モデルでは1枚が安価なので、偽文字や指の破綻を retry の繰り返しではなく
  // 複数候補から選ぶことで潰せるようにしている。
  const withBatch = parseConfig({
    config_json: JSON.stringify({ templateId: "t", batchSize: 4 })
  } as never);
  assert.equal(withBatch.batchSize, 4);

  // batchSize を持たない古い run。undefined のまま生成要求へ渡すと正規化の既定値
  // (16)へ落ちて1コマに16枚出てしまうので、1 に固定する。
  const legacy = parseConfig({ config_json: JSON.stringify({ templateId: "t" }) } as never);
  assert.equal(legacy.batchSize, 1);

  for (const bad of [0, -3, 1.7, "4", null]) {
    const parsed = parseConfig({
      config_json: JSON.stringify({ templateId: "t", batchSize: bad })
    } as never);
    assert.ok(parsed.batchSize >= 1 && Number.isInteger(parsed.batchSize), `batchSize=${String(bad)} -> ${parsed.batchSize}`);
  }
});
