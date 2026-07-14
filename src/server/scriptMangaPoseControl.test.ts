import assert from "node:assert/strict";
import test from "node:test";
import { createId, getRows, initializeDb, runSql } from "./db.ts";
import { createProject } from "./projects.ts";
import { createScript } from "./scripts.ts";
import { createScriptMangaRun, parsePoseControlInput } from "./scriptManga.ts";
import { fakeProvider, resetFakeProvider } from "./providers/fakeProvider.ts";
import { registerProvider } from "./providers/registry.ts";

registerProvider(fakeProvider);

const SCRIPT = ["INT. LAB - NIGHT", "", "@ALICE", "これは……私?"].join("\n");

function template(withControlNet: boolean): string {
  initializeDb();
  const id = createId("template");
  const workflow = withControlNet
    ? {
        "1": { class_type: "ControlNetLoader", inputs: { control_net_name: "openpose.safetensors" } },
        "2": { class_type: "ControlNetApplyAdvanced", inputs: { image: ["3", 0], strength: 1, start_percent: 0, end_percent: 1 } },
        "3": { class_type: "LoadImage", inputs: { image: "pose.png" } }
      }
    : {};
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Pose control fake', '', 'txt2img', 1, ?, '{}', 'hash')`,
    [id, JSON.stringify(workflow)]
  );
  return id;
}

test("parsePoseControlInput: 文字列/オブジェクト/不正値の正規化", () => {
  assert.equal(parsePoseControlInput("off"), undefined);
  assert.equal(parsePoseControlInput(undefined), undefined);
  assert.equal(parsePoseControlInput("nonsense"), undefined);
  assert.deepEqual(parsePoseControlInput("face"), { enabled: true, mode: "face", strength: 0.5, endPercent: 0.6 });
  assert.deepEqual(
    parsePoseControlInput({ enabled: true, mode: "upper", strength: 1.2, endPercent: 0.8 }),
    { enabled: true, mode: "upper", strength: 1.2, endPercent: 0.8 }
  );
  assert.equal(parsePoseControlInput({ enabled: false, mode: "full" }), undefined);
});

async function runWithPoseControl(withControlNetTemplate: boolean, poseControl: unknown): Promise<Array<{ request_json: string }>> {
  resetFakeProvider();
  const templateId = template(withControlNetTemplate);
  const project = createProject({ name: `pose-cn-${createId("t")}`, mode: "book" })!;
  const imported = createScript(project.id, { title: "Pose", fountainSource: SCRIPT });
  const run = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    dialoguePolicy: "preserve",
    auditMode: "manual",
    generateImages: true,
    ...(poseControl !== undefined ? { poseControl } : {})
  });
  return getRows<{ request_json: string }>(
    `SELECT request_json FROM generation_rounds WHERE project_id = ? ORDER BY round_index ASC`,
    [project.id]
  );
}

test("submitTasks: poseControl有効+CNテンプレでrequestへ骨格controlnetが注入される", async () => {
  const rounds = await runWithPoseControl(true, "full");
  assert.ok(rounds.length > 0);
  const request = JSON.parse(rounds[0]!.request_json) as { controlnet?: { poseImagePath?: string | null; strength: number; startPercent: number; endPercent: number } | null };
  assert.ok(request.controlnet, "controlnetが注入される");
  assert.ok(request.controlnet!.poseImagePath, "骨格画像は保存済みパスへ正規化される");
  assert.equal(request.controlnet!.strength, 0.5);
  assert.equal(request.controlnet!.startPercent, 0);
  assert.equal(request.controlnet!.endPercent, 0.6);
});

test("submitTasks: 既定OFF・テンプレにControlNetApplyAdvancedが無い場合は注入しない", async () => {
  for (const [withCn, poseControl] of [[true, undefined], [false, "full"]] as const) {
    const rounds = await runWithPoseControl(withCn, poseControl);
    assert.ok(rounds.length > 0);
    const request = JSON.parse(rounds[0]!.request_json) as { controlnet?: unknown };
    assert.ok(request.controlnet === undefined || request.controlnet === null, `withCn=${withCn} pose=${String(poseControl)}`);
  }
});
