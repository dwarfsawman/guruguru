import assert from "node:assert/strict";
import test from "node:test";
import { createId, getRow, initializeDb, runSql } from "./db.ts";
import { createProject } from "./projects.ts";
import { collectRound } from "./rounds.ts";
import { createScript } from "./scripts.ts";
import {
  approveScriptMangaRun,
  cancelScriptMangaRun,
  createScriptMangaRun,
  getScriptMangaRun,
  repairScriptMangaTask,
  resumeScriptMangaRun,
  retryScriptMangaTask,
  selectScriptMangaTaskCandidate,
  startScriptMangaRun
} from "./scriptManga.ts";
import {
  emitFakeJobEvent,
  fakeProvider,
  programFakeOutcomes,
  resetFakeProvider
} from "./providers/fakeProvider.ts";
import { registerProvider } from "./providers/registry.ts";
import type { GenerationRequest } from "../shared/types.ts";

registerProvider(fakeProvider);

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
const TINY_PNG = Buffer.from(TINY_PNG_DATA_URL.split(",")[1]!, "base64");

function template(): string {
  initializeDb();
  const id = createId("template");
  runSql(
    `INSERT INTO workflow_templates
       (id, name, description, type, version, workflow_json, role_map_json, workflow_hash)
     VALUES (?, 'Repair fake', '', 'txt2img', 1, '{}', '{}', 'repair-hash-v1')`,
    [id]
  );
  return id;
}

async function generatedReviewTask(label: string) {
  resetFakeProvider();
  programFakeOutcomes([{
    status: "completed",
    images: [{ bytes: TINY_PNG, filename: "candidate.png", outputNodeId: "fake-node" }]
  }]);
  const templateId = template();
  const project = createProject({ name: `${label}-${createId("test")}`, mode: "book" });
  assert.ok(project);
  const imported = createScript(project.id, {
    title: label,
    fountainSource: ["INT. ROOM - DAY", "", "A red door opens."].join("\n")
  });
  const run = await createScriptMangaRun(project.id, {
    scriptId: imported.script.id,
    templateId,
    providerId: "fake",
    auditMode: "manual"
  });
  const initialTask = run.tasks[0]!;
  assert.ok(initialTask.roundId);
  await collectRound(initialTask.roundId);
  const review = getScriptMangaRun(run.id);
  assert.equal(review.tasks[0]!.status, "awaiting_review");
  assert.equal(review.tasks[0]!.candidateAssetIds.length, 1);
  return {
    templateId,
    runId: run.id,
    task: review.tasks[0]!,
    parentAssetId: review.tasks[0]!.candidateAssetIds[0]!
  };
}

test("local repair appends a task-owned candidate, keeps the parent selectable, and survives a failed repair", async () => {
  const setup = await generatedReviewTask("repair-candidate-lineage");
  const parentRound = getRow<{ request_json: string }>(
    "SELECT request_json FROM generation_rounds WHERE id = ?",
    [setup.task.roundId]
  );
  assert.ok(parentRound);
  const frozen = JSON.parse(parentRound.request_json) as GenerationRequest;

  const submitted = await repairScriptMangaTask(setup.task.id, {
    assetId: setup.parentAssetId,
    denoise: 0.52,
    prompt: "ignored client override",
    templateId: "ignored-client-template",
    inpaint: {
      maskDataUrl: TINY_PNG_DATA_URL,
      maskedContent: "original",
      onlyMaskedPadding: 16,
      featherRadius: 2
    }
  });
  const runningTask = submitted.tasks[0]!;
  assert.equal(runningTask.status, "running");
  assert.equal(runningTask.attemptCount, setup.task.attemptCount + 1);
  assert.deepEqual(runningTask.candidateAssetIds, [setup.parentAssetId]);
  assert.notEqual(runningTask.roundId, setup.task.roundId);
  assert.ok(runningTask.roundId);

  const repairRound = getRow<{ request_json: string; script_manga_task_id: string }>(
    "SELECT request_json, script_manga_task_id FROM generation_rounds WHERE id = ?",
    [runningTask.roundId]
  );
  assert.ok(repairRound);
  assert.equal(repairRound.script_manga_task_id, setup.task.id);
  const repairRequest = JSON.parse(repairRound.request_json) as GenerationRequest;
  assert.equal(repairRequest.generationMode, "img2img");
  assert.equal(repairRequest.parentAssetId, setup.parentAssetId);
  assert.equal(repairRequest.templateId, frozen.templateId);
  assert.equal(repairRequest.prompt, frozen.prompt);
  assert.equal(repairRequest.negativePrompt, frozen.negativePrompt);
  assert.equal(repairRequest.steps, frozen.steps);
  assert.equal(repairRequest.cfg, frozen.cfg);
  assert.equal(repairRequest.sampler, frozen.sampler);
  assert.equal(repairRequest.scheduler, frozen.scheduler);
  assert.deepEqual(repairRequest.loras, frozen.loras);
  assert.equal(repairRequest.denoise, 0.52);
  assert.equal(repairRequest.width, 1);
  assert.equal(repairRequest.height, 1);
  assert.equal(repairRequest.inpaint?.maskDataUrl, null);
  assert.ok(repairRequest.inpaint?.maskPath);
  assert.equal(repairRequest.inpaint?.maskWidth, 1);
  assert.equal(repairRequest.inpaint?.maskHeight, 1);

  await collectRound(runningTask.roundId);
  const repaired = getScriptMangaRun(setup.runId);
  const repairedTask = repaired.tasks[0]!;
  assert.equal(repairedTask.status, "awaiting_review");
  assert.equal(repairedTask.candidateAssetIds.length, 2);
  assert.ok(repairedTask.candidateAssetIds.includes(setup.parentAssetId));
  const childAssetId = repairedTask.candidateAssetIds.find((id) => id !== setup.parentAssetId)!;
  assert.ok(childAssetId);
  assert.deepEqual(
    getRow<{ parent_asset_id: string; child_asset_id: string; relation_type: string }>(
      "SELECT parent_asset_id, child_asset_id, relation_type FROM asset_parents WHERE child_asset_id = ?",
      [childAssetId]
    ),
    { parent_asset_id: setup.parentAssetId, child_asset_id: childAssetId, relation_type: "img2img" }
  );

  programFakeOutcomes([{ status: "failed" }]);
  const failedSubmission = await repairScriptMangaTask(repairedTask.id, {
    assetId: setup.parentAssetId,
    inpaint: { maskDataUrl: TINY_PNG_DATA_URL }
  });
  const failedRoundId = failedSubmission.tasks[0]!.roundId!;
  assert.ok(failedRoundId);
  const failedJob = getRow<{ provider_job_ref: string }>(
    "SELECT provider_job_ref FROM generation_jobs WHERE round_id = ?",
    [failedRoundId]
  );
  assert.ok(failedJob?.provider_job_ref);
  emitFakeJobEvent(failedRoundId, failedJob.provider_job_ref, "failed", { message: "programmed repair failure" });
  await collectRound(failedRoundId);
  const afterFailure = getScriptMangaRun(setup.runId);
  assert.equal(afterFailure.tasks[0]!.status, "awaiting_review");
  assert.deepEqual(afterFailure.tasks[0]!.candidateAssetIds, repairedTask.candidateAssetIds);

  const selectedOld = await selectScriptMangaTaskCandidate(afterFailure.tasks[0]!.id, {
    assetId: setup.parentAssetId
  });
  assert.equal(selectedOld.tasks[0]!.status, "completed");
  assert.equal(selectedOld.tasks[0]!.selectedAssetId, setup.parentAssetId);
});

test("restart before a repair round is linked restores candidate review and returns the unspent attempt", async () => {
  const setup = await generatedReviewTask("repair-prelink-recovery");
  const before = getRow<{ round_id: string; attempt_count: number; candidate_asset_ids_json: string }>(
    "SELECT round_id, attempt_count, candidate_asset_ids_json FROM script_manga_tasks WHERE id = ?",
    [setup.task.id]
  );
  assert.ok(before?.round_id);
  runSql(
    `UPDATE script_manga_tasks
     SET status = 'submitting', round_id = NULL, attempt_count = attempt_count + 1
     WHERE id = ?`,
    [setup.task.id]
  );

  const recovered = getScriptMangaRun(setup.runId).tasks[0]!;
  assert.equal(recovered.status, "awaiting_review");
  assert.equal(recovered.roundId, before!.round_id);
  assert.equal(recovered.attemptCount, before!.attempt_count);
  assert.deepEqual(recovered.candidateAssetIds, JSON.parse(before!.candidate_asset_ids_json));
  assert.equal(
    getRow<{ count: number }>(
      "SELECT COUNT(*) AS count FROM generation_rounds WHERE script_manga_task_id = ?",
      [setup.task.id]
    )?.count,
    1,
    "recovery must not start a replacement txt2img round"
  );
});

test("local repair fails closed when the parent workflow revision changed without mutating the task", async () => {
  const setup = await generatedReviewTask("repair-template-freeze");
  runSql(
    "UPDATE workflow_templates SET version = 2, workflow_hash = 'repair-hash-v2' WHERE id = ?",
    [setup.templateId]
  );
  await assert.rejects(
    repairScriptMangaTask(setup.task.id, {
      assetId: setup.parentAssetId,
      inpaint: { maskDataUrl: TINY_PNG_DATA_URL }
    }),
    /workflow revision is no longer available/
  );
  const unchanged = getScriptMangaRun(setup.runId).tasks[0]!;
  assert.equal(unchanged.status, "awaiting_review");
  assert.equal(unchanged.roundId, setup.task.roundId);
  assert.equal(unchanged.attemptCount, setup.task.attemptCount);
  assert.deepEqual(unchanged.candidateAssetIds, setup.task.candidateAssetIds);
});

test("a selected inpaint repair inherits through its frozen parent and mask lineage", async () => {
  const setup = await generatedReviewTask("repair-successor-lineage");
  const submitted = await repairScriptMangaTask(setup.task.id, {
    assetId: setup.parentAssetId,
    denoise: 0.48,
    inpaint: {
      maskDataUrl: TINY_PNG_DATA_URL,
      maskedContent: "fill",
      onlyMaskedPadding: 24,
      featherRadius: 3
    }
  });
  const repairRoundId = submitted.tasks[0]!.roundId!;
  await collectRound(repairRoundId);
  const repaired = getScriptMangaRun(setup.runId);
  const childAssetId = repaired.tasks[0]!.candidateAssetIds.find((id) => id !== setup.parentAssetId)!;
  assert.ok(childAssetId);
  const completed = await selectScriptMangaTaskCandidate(repaired.tasks[0]!.id, { assetId: childAssetId });
  assert.equal(completed.status, "completed");

  const selectedSource = getRow<{ reuse_fingerprint: string; reuse_source_json: string }>(
    "SELECT reuse_fingerprint, reuse_source_json FROM script_manga_tasks WHERE id = ?",
    [completed.tasks[0]!.id]
  );
  assert.ok(selectedSource?.reuse_fingerprint);
  const source = JSON.parse(selectedSource!.reuse_source_json) as {
    fingerprint: string;
    matchFingerprint: string;
    assetContentHash?: string;
    generationMode: string;
    maskContentHash?: string;
    parentLineage?: {
      parentAssetId?: string;
      parentFingerprint?: string;
      parentAssetContentHash?: string;
      parentAssetWidth?: number;
      parentAssetHeight?: number;
    };
  };
  assert.equal(source.generationMode, "repair-img2img");
  assert.equal(source.fingerprint, selectedSource!.reuse_fingerprint);
  assert.notEqual(source.fingerprint, source.matchFingerprint, "repair material has its own reviewed-result signature");
  assert.match(source.assetContentHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(source.maskContentHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(source.parentLineage?.parentAssetId, setup.parentAssetId);
  assert.match(source.parentLineage?.parentFingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.match(source.parentLineage?.parentAssetContentHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(source.parentLineage?.parentAssetWidth, 1);
  assert.equal(source.parentLineage?.parentAssetHeight, 1);
  assert.doesNotMatch(selectedSource!.reuse_source_json, /data:image|maskDataUrl|prompt/i);

  const successor = await createScriptMangaRun(
    getRow<{ project_id: string }>("SELECT project_id FROM script_manga_runs WHERE id = ?", [completed.id])!.project_id,
    {
      scriptId: completed.scriptId,
      planningMode: "provided",
      predecessorRunId: completed.id,
      successorPlan: structuredClone(completed.plan),
      generateImages: false
    }
  );
  approveScriptMangaRun(successor.id);
  const inherited = await startScriptMangaRun(successor.id);
  assert.equal(inherited.status, "completed");
  assert.equal(inherited.tasks[0]!.selectedAssetId, childAssetId);
  assert.equal(inherited.tasks[0]!.inheritedFromTaskId, completed.tasks[0]!.id);
  assert.equal(inherited.tasks[0]!.reuseFingerprint, source.fingerprint);
  assert.equal(getRow("SELECT id FROM generation_rounds WHERE script_manga_task_id = ?", [inherited.tasks[0]!.id]), null);

  const parentImage = getRow<{ image_path: string }>("SELECT image_path FROM assets WHERE id = ?", [setup.parentAssetId]);
  assert.ok(parentImage?.image_path);
  const originalParentBytes = Buffer.from(await Bun.file(parentImage!.image_path).arrayBuffer());
  const sharpModule = (await import("sharp")).default;
  const replacementParentBytes = await sharpModule({
    create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } }
  }).png().toBuffer();
  await Bun.write(parentImage!.image_path, replacementParentBytes);
  try {
    const changedParentSuccessor = await createScriptMangaRun(
      getRow<{ project_id: string }>("SELECT project_id FROM script_manga_runs WHERE id = ?", [completed.id])!.project_id,
      {
        scriptId: completed.scriptId,
        planningMode: "provided",
        predecessorRunId: completed.id,
        successorPlan: structuredClone(completed.plan),
        generateImages: false
      }
    );
    approveScriptMangaRun(changedParentSuccessor.id);
    const changedParent = await startScriptMangaRun(changedParentSuccessor.id);
    assert.equal(changedParent.tasks[0]!.inheritedFromTaskId, null);
    assert.ok(changedParent.tasks[0]!.roundId, "same-size parent byte replacement invalidates repair lineage");
    await cancelScriptMangaRun(changedParentSuccessor.id);
  } finally {
    await Bun.write(parentImage!.image_path, originalParentBytes);
  }

  const repairRequest = getRow<{ request_json: string; parent_round_id: string | null }>(
    "SELECT request_json, parent_round_id FROM generation_rounds WHERE id = ?",
    [repairRoundId]
  )!;
  const tamperedRequest = JSON.parse(repairRequest.request_json) as GenerationRequest;
  tamperedRequest.prompt = `${tamperedRequest.prompt}, unrelated replacement subject`;
  runSql("UPDATE generation_rounds SET request_json = ? WHERE id = ?", [JSON.stringify(tamperedRequest), repairRoundId]);
  runSql("UPDATE script_manga_tasks SET reuse_fingerprint = NULL, reuse_source_json = NULL WHERE id = ?", [completed.tasks[0]!.id]);
  const tamperedChildSuccessor = await createScriptMangaRun(
    getRow<{ project_id: string }>("SELECT project_id FROM script_manga_runs WHERE id = ?", [completed.id])!.project_id,
    {
      scriptId: completed.scriptId,
      planningMode: "provided",
      predecessorRunId: completed.id,
      successorPlan: structuredClone(completed.plan),
      generateImages: false
    }
  );
  approveScriptMangaRun(tamperedChildSuccessor.id);
  const tamperedChild = await startScriptMangaRun(tamperedChildSuccessor.id);
  assert.equal(tamperedChild.tasks[0]!.inheritedFromTaskId, null);
  assert.ok(tamperedChild.tasks[0]!.roundId, "repair child with changed non-repair conditions must regenerate");
  await cancelScriptMangaRun(tamperedChildSuccessor.id);
  runSql("UPDATE generation_rounds SET request_json = ? WHERE id = ?", [repairRequest.request_json, repairRoundId]);
  runSql(
    "UPDATE script_manga_tasks SET reuse_fingerprint = ?, reuse_source_json = ? WHERE id = ?",
    [selectedSource!.reuse_fingerprint, selectedSource!.reuse_source_json, completed.tasks[0]!.id]
  );

  runSql("UPDATE generation_rounds SET parent_round_id = NULL WHERE id = ?", [repairRoundId]);
  const brokenRoundParentSuccessor = await createScriptMangaRun(
    getRow<{ project_id: string }>("SELECT project_id FROM script_manga_runs WHERE id = ?", [completed.id])!.project_id,
    {
      scriptId: completed.scriptId,
      planningMode: "provided",
      predecessorRunId: completed.id,
      successorPlan: structuredClone(completed.plan),
      generateImages: false
    }
  );
  approveScriptMangaRun(brokenRoundParentSuccessor.id);
  const brokenRoundParent = await startScriptMangaRun(brokenRoundParentSuccessor.id);
  assert.equal(brokenRoundParent.tasks[0]!.inheritedFromTaskId, null);
  assert.ok(brokenRoundParent.tasks[0]!.roundId, "repair round must point at the selected parent round");
  await cancelScriptMangaRun(brokenRoundParentSuccessor.id);
  runSql("UPDATE generation_rounds SET parent_round_id = ? WHERE id = ?", [repairRequest.parent_round_id, repairRoundId]);

  const maskPath = (JSON.parse(repairRequest.request_json) as GenerationRequest).inpaint?.maskPath;
  assert.ok(maskPath);
  await Bun.write(maskPath!, Buffer.from("changed mask bytes"));
  const changedMaskSuccessor = await createScriptMangaRun(
    getRow<{ project_id: string }>("SELECT project_id FROM script_manga_runs WHERE id = ?", [completed.id])!.project_id,
    {
      scriptId: completed.scriptId,
      planningMode: "provided",
      predecessorRunId: completed.id,
      successorPlan: structuredClone(completed.plan),
      generateImages: false
    }
  );
  approveScriptMangaRun(changedMaskSuccessor.id);
  const changedMask = await startScriptMangaRun(changedMaskSuccessor.id);
  assert.equal(changedMask.tasks[0]!.inheritedFromTaskId, null);
  assert.ok(changedMask.tasks[0]!.roundId, "changed repair-mask bytes invalidate the stored material signature");
  await cancelScriptMangaRun(changedMaskSuccessor.id);
});

test("candidate selection is single-winner and rejects a canceled run", async () => {
  const setup = await generatedReviewTask("candidate-select-cas");
  const outcomes = await Promise.allSettled([
    selectScriptMangaTaskCandidate(setup.task.id, { assetId: setup.parentAssetId }),
    selectScriptMangaTaskCandidate(setup.task.id, { assetId: setup.parentAssetId })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal(getScriptMangaRun(setup.runId).tasks[0]!.status, "completed");
  assert.equal(
    getRow<{ count: number }>("SELECT COUNT(*) AS count FROM selection_events WHERE asset_id = ? AND action = 'select'", [setup.parentAssetId])?.count,
    1
  );

  const pollSetup = await generatedReviewTask("candidate-select-active-poll");
  const activeSelection = selectScriptMangaTaskCandidate(pollSetup.task.id, { assetId: pollSetup.parentAssetId });
  const polled = getScriptMangaRun(pollSetup.runId);
  assert.equal(polled.tasks[0]!.status, "selecting", "polling must preserve an in-process selection claim");
  const concurrentResume = resumeScriptMangaRun(pollSetup.runId);
  assert.equal(
    getRow<{ status: string }>("SELECT status FROM script_manga_tasks WHERE id = ?", [pollSetup.task.id])?.status,
    "selecting",
    "resume must not recover a selection that is active in this process"
  );
  await activeSelection;
  await concurrentResume;
  assert.equal(getScriptMangaRun(pollSetup.runId).tasks[0]!.status, "completed");

  const cancelRaceSetup = await generatedReviewTask("candidate-select-cancel-race");
  const canceledSelection = assert.rejects(
    selectScriptMangaTaskCandidate(cancelRaceSetup.task.id, { assetId: cancelRaceSetup.parentAssetId }),
    /stopped accepting the candidate selection/
  );
  await cancelScriptMangaRun(cancelRaceSetup.runId);
  await canceledSelection;
  const canceledRaceTask = getRow<{
    status: string;
    reuse_fingerprint: string | null;
    reuse_source_json: string | null;
  }>("SELECT status, reuse_fingerprint, reuse_source_json FROM script_manga_tasks WHERE id = ?", [cancelRaceSetup.task.id]);
  assert.equal(canceledRaceTask?.status, "canceled");
  assert.equal(canceledRaceTask?.reuse_fingerprint, null);
  assert.equal(canceledRaceTask?.reuse_source_json, null);

  const canceledSetup = await generatedReviewTask("candidate-select-canceled-run");
  await cancelScriptMangaRun(canceledSetup.runId);
  await assert.rejects(
    selectScriptMangaTaskCandidate(canceledSetup.task.id, { assetId: canceledSetup.parentAssetId }),
    /current run state/
  );

  const staleSetup = await generatedReviewTask("candidate-select-stale-claim");
  runSql(
    "UPDATE script_manga_tasks SET status = 'selecting', inherited_from_task_id = ?, reuse_fingerprint = 'stale', reuse_source_json = '{}' WHERE id = ?",
    [staleSetup.task.id, staleSetup.task.id]
  );
  runSql(
    `INSERT INTO page_panel_assignments (id, page_id, panel_id, asset_id, crop_json)
     VALUES (?, ?, ?, ?, '{}')`,
    [createId("assignment"), staleSetup.task.pageId, staleSetup.task.panelId, staleSetup.parentAssetId]
  );
  await assert.rejects(
    retryScriptMangaTask(staleSetup.task.id),
    /Only failed, blocked, or unselected review tasks/
  );
  const recovered = getScriptMangaRun(staleSetup.runId);
  assert.equal(recovered.tasks[0]!.status, "awaiting_review");
  assert.equal(
    getRow("SELECT id FROM page_panel_assignments WHERE page_id = ? AND panel_id = ?", [staleSetup.task.pageId, staleSetup.task.panelId]),
    null,
    "poll recovery removes a candidate assignment written before the selection completion CAS"
  );
  const recoveredLineage = getRow<{ inherited_from_task_id: string | null; reuse_fingerprint: string | null; reuse_source_json: string | null }>(
    "SELECT inherited_from_task_id, reuse_fingerprint, reuse_source_json FROM script_manga_tasks WHERE id = ?",
    [staleSetup.task.id]
  );
  assert.equal(recoveredLineage?.inherited_from_task_id, null);
  assert.equal(recoveredLineage?.reuse_fingerprint, null);
  assert.equal(recoveredLineage?.reuse_source_json, null);
  assert.equal(
    (recovered.evaluation as { selecting?: number; awaitingReview?: number } | null)?.selecting,
    0
  );
  const retried = await retryScriptMangaTask(staleSetup.task.id);
  assert.equal(retried.tasks[0]!.status, "running");
  const resetLineage = getRow<{ inherited_from_task_id: string | null; reuse_fingerprint: string | null; reuse_source_json: string | null }>(
    "SELECT inherited_from_task_id, reuse_fingerprint, reuse_source_json FROM script_manga_tasks WHERE id = ?",
    [staleSetup.task.id]
  );
  assert.equal(resetLineage?.inherited_from_task_id, null);
  assert.equal(resetLineage?.reuse_fingerprint, null);
  assert.equal(resetLineage?.reuse_source_json, null);
  await cancelScriptMangaRun(staleSetup.runId);
});

test("run cancellation closes local work gates before awaiting provider interruption", async () => {
  const setup = await generatedReviewTask("cancel-local-gate-first");
  const retried = await retryScriptMangaTask(setup.task.id);
  assert.equal(retried.tasks[0]!.status, "running");
  assert.ok(retried.tasks[0]!.roundId);

  const canceling = cancelScriptMangaRun(setup.runId);
  try {
    const claimed = getScriptMangaRun(setup.runId);
    assert.equal(claimed.status, "canceled", "the run is closed synchronously before interruptRound yields");
    assert.equal(claimed.tasks[0]!.status, "canceled");
    await assert.rejects(resumeScriptMangaRun(setup.runId), /Canceled runs cannot be resumed/);
  } finally {
    await canceling;
  }
});
