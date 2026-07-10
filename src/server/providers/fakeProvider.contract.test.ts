import { test } from "node:test";
import assert from "node:assert/strict";
import { createId, getRow, getRows, initializeDb, runSql } from "../db.ts";
import { collectRound, createGenerationRound, interruptRound } from "../rounds.ts";
import { createProject } from "../projects.ts";
import { registerProvider } from "./registry.ts";
import { emitFakeJobEvent, fakeProvider, markFakeJobRunning, programFakeOutcomes, resetFakeProvider } from "./fakeProvider.ts";
import type { GenerationRequest } from "../../shared/types.ts";

/**
 * S1 契約テスト(Docs/Feature-ScriptToManga.md S1「契約テスト(FakeProvider)」)。FakeProvider を
 * registry へ登録し、request.providerId の隠しフック(省略時 'comfy')経由で選択して、rounds.ts の
 * オーケストレーション(createGenerationRound → collectRound / interruptRound)が Provider 抽象化
 * 越しに正しく動くことを検証する。
 */
registerProvider(fakeProvider);

function baseRequest(overrides: Partial<GenerationRequest & { providerId?: string }> = {}) {
  return {
    templateId: overrides.templateId!,
    prompt: "a cat",
    negativePrompt: "",
    seed: 100,
    seedMode: "fixed" as const,
    batchSize: 2,
    steps: 20,
    cfg: 7,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1,
    width: 64,
    height: 64,
    generationMode: "txt2img" as const,
    providerId: "fake",
    ...overrides
  };
}

function createDummyWorkflowTemplate(): string {
  initializeDb();
  const id = createId("template");
  runSql(
    `INSERT INTO workflow_templates (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Dummy', '', 'txt2img', 1, '{}', '{}', 'hash')`,
    [id]
  );
  return id;
}

function createTestProject(): string {
  const project = createProject({ name: `fake-provider-contract-${createId("suffix")}`, mode: "single" });
  assert.ok(project);
  return project!.id as string;
}

type JobRow = { id: string; batch_index: number; prompt_id: string | null; provider_job_ref: string | null; status: string; seed: number | null };

function jobsForRound(roundId: string): JobRow[] {
  return getRows<JobRow>("SELECT * FROM generation_jobs WHERE round_id = ? ORDER BY batch_index ASC", [roundId]);
}

test("contract 1: submit -> collect creates assets with correct seed/tree/provider_job_ref", async () => {
  resetFakeProvider();
  const templateId = createDummyWorkflowTemplate();
  const projectId = createTestProject();

  const { round } = await createGenerationRound(projectId, baseRequest({ templateId }) as unknown as GenerationRequest);
  assert.ok(round);

  const jobRows = jobsForRound(round!.id as string);
  assert.equal(jobRows.length, 2);
  for (const job of jobRows) {
    assert.ok(job.provider_job_ref, "provider_job_ref should be populated for every job");
    assert.equal(job.provider_job_ref, job.prompt_id, "comfy-compatible dual-write: prompt_id mirrors provider_job_ref");
  }

  const collectResult = await collectRound(round!.id as string);
  assert.equal(collectResult.statusCode, 200);
  const assets = collectResult.body.assets as Array<{ seed: number; batchIndex: number }>;
  assert.equal(assets.length, 2);
  const seedsByBatch = new Map(assets.map((asset) => [asset.batchIndex, asset.seed]));
  assert.equal(seedsByBatch.get(0), 100);
  assert.equal(seedsByBatch.get(1), 101);

  const updatedRound = collectResult.body.round as { status: string };
  assert.equal(updatedRound.status, "completed");
});

test("contract 1b: img2img round records an asset_parents tree entry back to the parent asset", async () => {
  resetFakeProvider();
  const templateId = createDummyWorkflowTemplate();
  const projectId = createTestProject();

  // Seed a "parent" asset directly (any prior round/asset works as the img2img source).
  const parentRoundId = createId("round");
  const parentAssetId = createId("asset");
  runSql(
    `INSERT INTO generation_rounds (id, project_id, template_id, round_index, status, generation_mode, request_json, provider_id)
     VALUES (?, ?, ?, 0, 'completed', 'txt2img', '{}', 'manual')`,
    [parentRoundId, projectId, templateId]
  );
  runSql(
    `INSERT INTO assets
      (id, project_id, round_id, batch_index, image_path, thumbnail_small_path, thumbnail_medium_path,
       width, height, workflow_template_id, workflow_template_version, workflow_snapshot_hash, status)
     VALUES (?, ?, ?, 0, 'dummy.png', 'dummy_s.png', 'dummy_m.png', 64, 64, ?, 1, 'hash', 'selected')`,
    [parentAssetId, projectId, parentRoundId, templateId]
  );

  const { round } = await createGenerationRound(
    projectId,
    baseRequest({ templateId, generationMode: "img2img", parentAssetId, batchSize: 1 }) as unknown as GenerationRequest
  );
  assert.ok(round);
  await collectRound(round!.id as string);

  const childAsset = getRow<{ id: string }>("SELECT id FROM assets WHERE round_id = ?", [round!.id as string]);
  assert.ok(childAsset);
  const tree = getRow<{ relation_type: string }>(
    "SELECT relation_type FROM asset_parents WHERE parent_asset_id = ? AND child_asset_id = ?",
    [parentAssetId, childAsset!.id]
  );
  assert.equal(tree?.relation_type, "img2img");
});

test("contract 2: a single failed job among several drives the round to a correct terminal state", async () => {
  resetFakeProvider();
  const templateId = createDummyWorkflowTemplate();
  const projectId = createTestProject();
  programFakeOutcomes([{ status: "completed" }, { status: "failed" }]);

  const { round } = await createGenerationRound(projectId, baseRequest({ templateId, batchSize: 2 }) as unknown as GenerationRequest);
  assert.ok(round);
  const roundId = round!.id as string;

  const jobRows = jobsForRound(roundId);
  const failingJob = jobRows.find((job) => job.batch_index === 1)!;
  assert.ok(failingJob.provider_job_ref);

  emitFakeJobEvent(roundId, failingJob.provider_job_ref!, "failed", { message: "synthetic failure" });
  const collectResult = await collectRound(roundId);

  const updatedJobRows = jobsForRound(roundId);
  const statusesByBatch = new Map(updatedJobRows.map((job) => [job.batch_index, job.status]));
  assert.equal(statusesByBatch.get(0), "completed");
  assert.equal(statusesByBatch.get(1), "failed");

  const updatedRound = collectResult.body.round as { status: string };
  assert.equal(updatedRound.status, "failed");
  const assets = collectResult.body.assets as unknown[];
  assert.equal(assets.length, 1, "only the succeeding job's image should have been collected");
});

test("contract 3: interrupt correctly splits running vs queued jobs", async () => {
  resetFakeProvider();
  const templateId = createDummyWorkflowTemplate();
  const projectId = createTestProject();

  const { round } = await createGenerationRound(projectId, baseRequest({ templateId, batchSize: 3 }) as unknown as GenerationRequest);
  assert.ok(round);
  const roundId = round!.id as string;

  const jobRows = jobsForRound(roundId);
  assert.equal(jobRows.length, 3);
  const runningJob = jobRows[1]!;
  markFakeJobRunning(runningJob.provider_job_ref!);

  await interruptRound(roundId);

  const updatedJobRows = jobsForRound(roundId);
  const statusesByRef = new Map(updatedJobRows.map((job) => [job.provider_job_ref, job.status]));
  assert.equal(statusesByRef.get(runningJob.provider_job_ref), "interrupted");
  for (const job of updatedJobRows) {
    if (job.provider_job_ref !== runningJob.provider_job_ref) {
      assert.equal(job.status, "cancelled");
    }
  }

  const roundRow = getRow<{ status: string }>("SELECT status FROM generation_rounds WHERE id = ?", [roundId]);
  assert.equal(roundRow?.status, "interrupted");
});

test("contract 4: collect completes purely from DB job rows, without any watch/event-driven state (restart-equivalent)", async () => {
  resetFakeProvider();
  const templateId = createDummyWorkflowTemplate();
  const projectId = createTestProject();

  const { round } = await createGenerationRound(projectId, baseRequest({ templateId, batchSize: 2 }) as unknown as GenerationRequest);
  assert.ok(round);
  const roundId = round!.id as string;

  // No emitFakeJobEvent call here: FakeProvider registered a watcher via ensureRoundMonitor, but
  // nothing ever pushes to it. This exercises the pure DB-row + provider.collectImages polling path
  // (the same path a restarted server would take, per Docs/Feature-ScriptToManga.md S1's note that
  // jobs rows + provider_job_ref must be enough to resume collection after a restart).
  const collectResult = await collectRound(roundId);
  assert.equal(collectResult.statusCode, 200);
  assert.equal((collectResult.body.assets as unknown[]).length, 2);
  assert.equal((collectResult.body.round as { status: string }).status, "completed");
});
