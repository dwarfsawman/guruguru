import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowTemplate } from "../shared/apiTypes.ts";
import type { ScriptMangaRunView, ScriptMangaUiSettings } from "../shared/scriptMangaApi.ts";
import { actionHandlerFor } from "./actionRegistry.ts";
import { state } from "./appState.ts";
import {
  clearScriptMangaRunState,
  clearScriptMangaUiState,
  initializeScriptMangaUiState,
  nextScriptMangaSettings,
  scriptMangaCandidateAdoptRequest,
  scriptMangaPlanCandidatesRequest,
  scriptMangaPrepareRequest
} from "./scriptMangaController.ts";

const settings: ScriptMangaUiSettings = {
  templateId: "template-1",
  planningMode: "heuristic",
  panelsPerPage: 4,
  maxDialoguesPerPanel: 4,
  targetPageCount: 0,
  maxPanelCount: 0,
  dialoguePolicy: "preserve",
  auditMode: "vlm",
  poseControl: "off"
};

test("nextScriptMangaSettings applies supported template, planner and panel controls", () => {
  assert.equal(nextScriptMangaSettings(settings, "templateId", "template-2").templateId, "template-2");
  // V5 X5: planningMode select はUIから削除。reducerは未知フィールドとして無視する。
  assert.equal(nextScriptMangaSettings(settings, "planningMode", "llm"), settings);
  assert.equal(nextScriptMangaSettings(settings, "panelsPerPage", "0").panelsPerPage, 1);
  assert.equal(nextScriptMangaSettings(settings, "panelsPerPage", "9").panelsPerPage, 6);
  assert.equal(nextScriptMangaSettings(settings, "panelsPerPage", "3.8").panelsPerPage, 3);
  assert.equal(nextScriptMangaSettings(settings, "maxDialoguesPerPanel", "0").maxDialoguesPerPanel, 1);
  assert.equal(nextScriptMangaSettings(settings, "maxDialoguesPerPanel", "99").maxDialoguesPerPanel, 8);
  assert.equal(nextScriptMangaSettings(settings, "maxDialoguesPerPanel", "3.8").maxDialoguesPerPanel, 3);
  assert.equal(nextScriptMangaSettings(settings, "targetPageCount", "-1").targetPageCount, 0);
  assert.equal(nextScriptMangaSettings(settings, "targetPageCount", "999").targetPageCount, 200);
  assert.equal(nextScriptMangaSettings(settings, "maxPanelCount", "-1").maxPanelCount, 0);
  assert.equal(nextScriptMangaSettings(settings, "maxPanelCount", "999").maxPanelCount, 800);
  assert.equal(nextScriptMangaSettings(settings, "auditMode", "manual").auditMode, "manual");
  assert.equal(nextScriptMangaSettings(settings, "auditMode", "vlm").auditMode, "vlm");
});

test("nextScriptMangaSettings enables provenance-safe policies and keeps unsupported values disabled", () => {
  assert.equal(nextScriptMangaSettings(settings, "planningMode", "provided"), settings);
  assert.equal(nextScriptMangaSettings(settings, "panelsPerPage", "not-a-number"), settings);
  assert.equal(nextScriptMangaSettings(settings, "maxDialoguesPerPanel", "not-a-number"), settings);
  assert.equal(nextScriptMangaSettings(settings, "targetPageCount", "not-a-number"), settings);
  assert.equal(nextScriptMangaSettings(settings, "maxPanelCount", "not-a-number"), settings);
  assert.deepEqual(nextScriptMangaSettings(settings, "dialoguePolicy", "adapt"), { ...settings, dialoguePolicy: "adapt", panelsPerPage: 2 });
  assert.deepEqual(nextScriptMangaSettings(settings, "dialoguePolicy", "fill"), { ...settings, dialoguePolicy: "fill", panelsPerPage: 2 });
  assert.equal(nextScriptMangaSettings(settings, "dialoguePolicy", "generate"), settings);
  assert.equal(nextScriptMangaSettings(settings, "dialoguePolicy", "preserve").dialoguePolicy, "preserve");
  assert.equal(nextScriptMangaSettings(settings, "auditMode", "automatic"), settings);
});

test("scriptMangaPlanCandidatesRequest forwards explicit planning density controls", () => {
  assert.deepEqual(scriptMangaPlanCandidatesRequest("script-1", 3, settings), {
    scriptId: "script-1",
    count: 3,
    targetPageCount: 0,
    panelsPerPage: 4,
    maxDialoguesPerPanel: 4
  });
  assert.equal(scriptMangaPlanCandidatesRequest("script-1", 2, settings, "group-1").groupId, "group-1");
});

test("scriptMangaPrepareRequest always prepares a review run without generating images", () => {
  assert.deepEqual(scriptMangaPrepareRequest("script-1", settings), {
    scriptId: "script-1",
    ...settings,
    generateImages: false,
    candidateSelectionPolicy: "review",
    requireReferenceSets: true,
    allowReferenceFallback: false
  });
});

test("scriptMangaCandidateAdoptRequest leaves candidate identity to the dedicated URL", () => {
  assert.deepEqual(scriptMangaCandidateAdoptRequest(settings, 3), {
    ...settings,
    expectedCandidateVersion: 3,
    generateImages: false,
    candidateSelectionPolicy: "review",
    requireReferenceSets: true,
    allowReferenceFallback: false
  });
});

test("script manga controller registers local retry and completed-run export actions", () => {
  assert.equal(typeof actionHandlerFor("retry-script-manga-task"), "function");
  assert.equal(typeof actionHandlerFor("edit-script-manga-candidate-mask"), "function");
  assert.equal(typeof actionHandlerFor("repair-script-manga-candidate"), "function");
  assert.equal(typeof actionHandlerFor("export-script-manga-run"), "function");
});

test("script manga UI lifecycle clears revision-pinned runs without leaking project settings", () => {
  const template: WorkflowTemplate = {
    id: "template-ui",
    name: "UI template",
    description: "",
    type: "txt2img",
    version: 1,
    workflowHash: "hash",
    workflowJson: {},
    roleMap: {}
  };
  state.templates = [template];
  state.scriptMangaSettings = { ...settings, templateId: "missing-template", panelsPerPage: 6 };
  state.scriptMangaRun = { id: "old-run" } as ScriptMangaRunView;
  state.scriptMangaBusy = true;
  state.scriptMangaVlmStatus = {
    ok: true,
    state: "ready",
    baseUrl: "http://127.0.0.1:1234",
    model: "audit-model",
    checkedAt: "2026-07-12T00:00:00.000Z",
    loadedModelIds: ["audit-model"]
  };

  initializeScriptMangaUiState();
  assert.deepEqual(state.scriptMangaTemplates, [template]);
  assert.equal(state.scriptMangaSettings.templateId, template.id);
  assert.equal(state.scriptMangaRun, null);
  assert.equal(state.scriptMangaBusy, false);
  assert.equal(state.scriptMangaVlmStatus, null);

  state.scriptMangaRun = { id: "revision-run" } as ScriptMangaRunView;
  clearScriptMangaRunState();
  assert.equal(state.scriptMangaRun, null);
  assert.equal(state.scriptMangaSettings.panelsPerPage, 6, "script switch keeps reusable controls");

  clearScriptMangaUiState();
  assert.deepEqual(state.scriptMangaTemplates, []);
  assert.deepEqual(state.scriptMangaSettings, {
    templateId: "",
    planningMode: "llm",
    panelsPerPage: 4,
    maxDialoguesPerPanel: 4,
    targetPageCount: 0,
    maxPanelCount: 0,
    dialoguePolicy: "preserve",
    auditMode: "vlm",
    poseControl: "off"
  });
  assert.equal(state.scriptMangaVlmStatus, null);
  state.templates = [];
});
