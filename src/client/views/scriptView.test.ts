import assert from "node:assert/strict";
import test from "node:test";
import type { ScriptRevision, WorkflowTemplate } from "../../shared/apiTypes.ts";
import { setExternalScriptMangaLayouts } from "../../shared/layoutPresets.ts";
import type { ScriptMangaPlanCandidateView, ScriptMangaRunView } from "../../shared/scriptMangaApi.ts";
import {
  renderPlanCandidatesCard,
  renderScriptMangaControlCard,
  scriptMangaVlmAuditFromScores,
  type PlanCandidatesViewProps,
  type ScriptMangaControlViewProps
} from "./scriptView.ts";

const revision: ScriptRevision = {
  id: "revision-1",
  scriptId: "script-1",
  revision: 1,
  fountainSource: "INT. ROOM - DAY",
  parsed: { titlePage: {}, scenes: [] },
  warnings: null,
  createdAt: "2026-07-12T00:00:00.000Z"
};

const template: WorkflowTemplate = {
  id: "template-1",
  name: "Manga workflow",
  description: "",
  type: "txt2img",
  version: 1,
  workflowHash: "hash",
  workflowJson: {},
  roleMap: {}
};

function run(): ScriptMangaRunView {
  return {
    id: "run-1",
    projectId: "project-1",
    scriptId: "script-1",
    scriptRevisionId: "revision-1",
    planId: "plan-1",
    planVersion: 2,
    status: "awaiting_review",
    phase: "auditing",
    approvalStatus: "approved",
    pageCount: 2,
    panelCount: 6,
    completedCount: 4,
    failedCount: 0,
    evaluation: null,
    exportManifest: null,
    generationBudget: null,
    referenceSnapshot: null,
    auditMode: "vlm",
    lastError: null,
    plan: null,
    validation: {
      ok: true,
      issues: [{ severity: "warning", code: "test-warning", message: "Review <risk>" }]
    },
    tasks: [{
      id: "task-1",
      pageId: "page-1",
      panelId: "panel-2",
      roundId: "round-1",
      status: "awaiting_review",
      attemptCount: 1,
      candidateAssetIds: ["asset-1"],
      selectedAssetId: null,
      scores: null,
      lastError: null
    }],
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    completedAt: null
  };
}

function props(currentRun: ScriptMangaRunView | null = null): ScriptMangaControlViewProps {
  return {
    activeScriptId: "script-1",
    activeScriptRevision: revision,
    scriptMangaTemplates: [template],
    scriptMangaSettings: {
      templateId: "template-1",
      planningMode: "heuristic",
      panelsPerPage: 6,
      dialoguePolicy: "preserve",
      auditMode: "vlm",
      poseControl: "off"
    },
    scriptMangaRun: currentRun,
    scriptMangaBusy: false,
    scriptMangaVlmStatus: {
      ok: false,
      state: "model-not-loaded",
      baseUrl: "http://127.0.0.1:1234",
      model: "audit-model",
      checkedAt: "2026-07-12T00:00:00.000Z",
      loadedModelIds: []
    }
  };
}

test("script manga card renders supported controls and marks future dialogue policies unavailable", () => {
  const html = renderScriptMangaControlCard(props());
  assert.match(html, /data-script-manga-setting="templateId"/);
  assert.match(html, /data-script-manga-setting="planningMode"/);
  assert.match(html, /data-script-manga-setting="panelsPerPage"/);
  assert.match(html, /value="6" selected/);
  assert.match(html, /value="preserve" selected/);
  assert.match(html, /value="adapt" >adapt（原文一致の呼吸分割）/);
  assert.match(html, /value="fill" >fill（分割＋caption\/monitor\/SFX）/);
  assert.match(html, /value="generate" disabled>generate（今後対応）/);
  assert.match(html, /data-script-manga-setting="auditMode"/);
  assert.match(html, /VLM自動監査 → 人間レビュー/);
  assert.match(html, /ComfyUIモデルを解放してVLMへVRAMを入れ替え/);
  assert.match(html, /VLM on-demand · audit-model/);
  assert.match(html, /data-action="prepare-script-manga-run"/);
});

test("script manga card shows ready, on-demand and unreachable VLM service states safely", () => {
  const readyProps = props();
  readyProps.scriptMangaVlmStatus = {
    ...readyProps.scriptMangaVlmStatus!,
    ok: true,
    state: "ready",
    model: "ready-model"
  };
  assert.match(renderScriptMangaControlCard(readyProps), /VLM ready · ready-model/);

  const unreachableProps = props();
  unreachableProps.scriptMangaVlmStatus = {
    ...unreachableProps.scriptMangaVlmStatus!,
    state: "server-unreachable",
    error: "offline <script>alert(1)</script>"
  };
  const unreachableHtml = renderScriptMangaControlCard(unreachableProps);
  assert.match(unreachableHtml, /VLM unreachable/);
  assert.match(unreachableHtml, /title="offline &lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.doesNotMatch(unreachableHtml, /offline <script>/);
});

test("script manga card renders run state and reviewable asset candidates", () => {
  const html = renderScriptMangaControlCard(props(run()));
  assert.match(html, /awaiting_review/);
  assert.match(html, /auditing/);
  assert.match(html, /revision-1/);
  assert.match(html, /2 \/ 6/);
  assert.match(html, /Review &lt;risk&gt;/);
  assert.match(html, /\/api\/assets\/asset-1\/thumbnail\?size=medium/);
  assert.match(html, /\/api\/assets\/asset-1\/image/);
  assert.match(html, /data-action="select-script-manga-candidate"/);
  assert.match(html, /data-id="task-1" data-asset-id="asset-1"/);
  assert.match(html, /data-action="retry-script-manga-task"/);
  assert.match(html, /data-id="task-1"/);
  assert.match(html, /このコマを再生成/);
  for (const action of ["approve", "start", "resume", "refresh", "cancel"]) {
    assert.match(html, new RegExp(`data-action="${action}-script-manga-run"`));
  }
});

test("completed script manga run offers PNG, PPTX and ORA downloads", () => {
  const completedRun = run();
  completedRun.status = "completed";
  completedRun.phase = "completed";
  completedRun.completedCount = completedRun.panelCount;
  completedRun.tasks[0]!.status = "completed";
  completedRun.tasks[0]!.selectedAssetId = "asset-1";
  const html = renderScriptMangaControlCard(props(completedRun));
  assert.match(html, /完成ページ/);
  for (const format of ["png", "pptx", "ora"]) {
    assert.match(html, new RegExp(`data-action="export-script-manga-run" data-format="${format}"`));
  }
  assert.doesNotMatch(html, /data-format="jpeg"/);
});

test("scriptMangaVlmAuditFromScores bounds and normalizes untrusted audit payloads", () => {
  assert.equal(scriptMangaVlmAuditFromScores(null), null);
  assert.equal(scriptMangaVlmAuditFromScores({ vlmAudit: { state: "unknown" } }), null);
  const audit = scriptMangaVlmAuditFromScores({
    vlmAudit: {
      state: "completed",
      reports: [
        { assetId: "", score: 2, passed: true, checks: {}, violations: [] },
        {
          assetId: "asset-safe",
          score: 1.4,
          passed: true,
          checks: { visualIdentity: "pass", fakeText: "invalid" },
          violations: ["", "  one issue  ", 42],
          model: "audit-model"
        }
      ]
    }
  });
  assert.deepEqual(audit, {
    state: "completed",
    reports: [{
      assetId: "asset-safe",
      score: 1,
      passed: true,
      checks: { visualIdentity: "pass" },
      violations: ["one issue"],
      model: "audit-model"
    }],
    error: null
  });
});

test("script manga candidate cards render VLM pass, fail and escaped violations", () => {
  const auditedRun = run();
  auditedRun.tasks[0]!.candidateAssetIds = ["asset-1", "asset-2"];
  auditedRun.tasks[0]!.scores = {
    vlmAudit: {
      state: "completed",
      reports: [
        {
          assetId: "asset-1",
          score: 0.93,
          passed: true,
          checks: { visualIdentity: "pass", fakeText: "pass" },
          violations: [],
          model: "vlm-safe"
        },
        {
          assetId: "asset-2",
          score: 0.41,
          passed: false,
          checks: { visualIdentity: "pass", fakeText: "fail" },
          violations: ["fake text <script>alert(1)</script>"],
          model: "vlm-unsafe<script>"
        }
      ]
    }
  };
  const html = renderScriptMangaControlCard(props(auditedRun));
  assert.match(html, /VLM 93%/);
  assert.match(html, />PASS</);
  assert.match(html, /VLM 41%/);
  assert.match(html, />FAIL</);
  assert.match(html, /fakeText: FAIL/);
  assert.match(html, /fake text &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /vlm-unsafe&lt;script&gt;/);
});

test("script manga UI explains unavailable VLM audits without exposing raw markup", () => {
  const unavailableRun = run();
  unavailableRun.tasks[0]!.scores = {
    vlmAudit: { state: "unavailable", error: "model <offline>" }
  };
  const html = renderScriptMangaControlCard(props(unavailableRun));
  assert.match(html, /VLM利用不可/);
  assert.match(html, /model &lt;offline&gt;/);
  assert.doesNotMatch(html, /model <offline>/);
});

test("script manga UI shows auditing panel count and VRAM swap status", () => {
  const auditingRun = run();
  auditingRun.status = "auditing";
  auditingRun.phase = "auditing";
  auditingRun.tasks = [
    { ...auditingRun.tasks[0]!, id: "task-a", panelId: "panel-a", status: "auditing", scores: { vlmAudit: { state: "queued" } } },
    {
      ...auditingRun.tasks[0]!,
      id: "task-b",
      panelId: "panel-b",
      status: "auditing",
      scores: { vlmAudit: { state: "deferred", error: "waiting" } }
    }
  ];
  const html = renderScriptMangaControlCard(props(auditingRun));
  assert.match(html, /VLM監査中 — 2 panel/);
  assert.match(html, /1 panelは監査再開待ち（VRAM入替待機中）/);
});

test("plan candidate card renders an imported autoManga layout wireframe", () => {
  const layoutId = "layout-imported-candidate";
  setExternalScriptMangaLayouts([{
    id: layoutId,
    name: "Imported candidate",
    layout: {
      version: 1,
      page: { aspectRatio: [182, 257], height: 257 / 182 },
      readingDirection: "rtl",
      panels: [{ id: "panel-1", order: 1, shape: { type: "rect", bounds: [0.04, 0.04, 0.96, 1.37] } }]
    }
  }]);
  const candidate: ScriptMangaPlanCandidateView = {
    id: "candidate-1",
    projectId: "project-1",
    scriptId: "script-1",
    scriptRevisionId: revision.id,
    groupId: "group-1",
    profile: null,
    temperature: null,
    status: "active",
    adoptedRunId: null,
    plan: {
      title: "Imported layout plan",
      panelCount: 1,
      dialogueCount: 0,
      pages: [{
        index: 0,
        title: "Page 1",
        layoutTemplateId: layoutId,
        panels: [{
          id: "planned-panel-1",
          sceneIndex: 0,
          sceneHeading: "INT. ROOM - DAY",
          sourceElementIds: ["element-1"],
          prompt: "A quiet room",
          sourceText: "A quiet room.",
          dialogueOrderIndexes: []
        }]
      }]
    },
    pageNaming: { mode: "deterministic", fallback: true },
    createdAt: "2026-07-14T00:00:00.000Z"
  };
  const controlProps = props();
  const candidateProps: PlanCandidatesViewProps = {
    activeScriptId: controlProps.activeScriptId,
    activeScriptRevision: controlProps.activeScriptRevision,
    scriptMangaSettings: controlProps.scriptMangaSettings,
    scriptMangaBusy: false,
    scriptMangaCandidates: [candidate],
    scriptMangaCandidateBeatKinds: {},
    scriptMangaCandidateDialogueChars: [],
    scriptMangaCandidatesBusy: false,
    scriptMangaCandidateCount: 3
  };
  try {
    const html = renderPlanCandidatesCard(candidateProps);
    assert.match(html, /plan-candidate-page-svg/);
    assert.doesNotMatch(html, /plan-candidate-page is-unknown/);
  } finally {
    setExternalScriptMangaLayouts([]);
  }
});
