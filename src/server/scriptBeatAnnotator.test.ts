import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "../shared/fountain.ts";
import { buildPreLayoutUnits, type AnnotatedBeat } from "../shared/preLayoutBeat.ts";
import { validateMangaPlanV2 } from "../shared/mangaPlanV2.ts";
import { getRow, initializeDb, runSql } from "./db.ts";
import { createProject } from "./projects.ts";
import { createScript } from "./scripts.ts";
import { resolveLayoutTemplate } from "./layoutTemplates.ts";
import {
  annotateScriptBeats,
  persistBeatAnnotation,
  readCachedBeatAnnotation
} from "./scriptBeatAnnotator.ts";
import { applyBeatPageNaming } from "./scriptMangaPageNaming.ts";
import { buildMangaPlanV2 } from "./scriptMangaPlanV2.ts";

const SCRIPT = ["INT. LAB - NIGHT", "", "箱を開ける。中には写真がある。", "", "@ALICE", "これは……私?"].join("\n");

function spanBeats(units: ReturnType<typeof buildPreLayoutUnits>): AnnotatedBeat[] {
  return units.map((unit, index) => ({
    id: `b${index + 1}`,
    unitIds: [unit.id],
    kind: index === units.length - 1 ? "reveal" : "action",
    preferredScale: index === units.length - 1 ? "large" : "medium",
    importance: index === units.length - 1 ? 0.9 : 0.4,
    pageTurnAffinity: 0.2,
    keepAlone: false,
    desiredScale: "normal"
  }));
}

test("script_beat_annotations キャッシュ: 保存済み注釈があれば LLM を呼ばず cached=true で返す", async () => {
  initializeDb();
  const project = createProject({ name: "beat-cache-test", mode: "book" })!;
  const imported = createScript(project.id, { title: "Beats", fountainSource: SCRIPT });
  const revisionId = imported.revision.id;
  const doc = parseFountain(SCRIPT).doc;
  const units = buildPreLayoutUnits(doc);
  assert.equal(readCachedBeatAnnotation(revisionId, units), null);
  const beats = spanBeats(units);
  persistBeatAnnotation(revisionId, beats, { model: "test" });
  const cachedBeats = readCachedBeatAnnotation(revisionId, units);
  assert.ok(cachedBeats);
  assert.equal(cachedBeats!.length, beats.length);
  const result = await annotateScriptBeats(doc, revisionId);
  assert.equal(result.cached, true);
  assert.equal(result.fallback, false);
  assert.deepEqual(result.beats.map((beat) => beat.id), beats.map((beat) => beat.id));
  // 上書き保存(ON CONFLICT)も1行のまま。
  persistBeatAnnotation(revisionId, beats.slice(0, 1).concat(beats.slice(1)), { model: "test2" });
  const count = getRow<{ count: number }>(
    "SELECT COUNT(*) AS count FROM script_beat_annotations WHERE script_revision_id = ?",
    [revisionId]
  )?.count;
  assert.equal(count, 1);
});

test("annotateScriptBeats: LLM 不通では決定的フォールバック(キャッシュされない)", async () => {
  initializeDb();
  runSql("DELETE FROM app_settings WHERE key = 'llm'");
  initializeDb(); // 既定(空 baseUrl)の LLM 設定へ戻す
  const project = createProject({ name: "beat-fallback-test", mode: "book" })!;
  const imported = createScript(project.id, { title: "Beats", fountainSource: SCRIPT });
  const doc = parseFountain(SCRIPT).doc;
  const result = await annotateScriptBeats(doc, imported.revision.id);
  assert.equal(result.fallback, true);
  assert.ok(result.beats.length > 0);
  assert.equal(
    getRow("SELECT id FROM script_beat_annotations WHERE script_revision_id = ?", [imported.revision.id]),
    null,
    "フォールバックはキャッシュしない"
  );
});

test("buildMangaPlanV2: ビート注釈があれば beats を引き継ぎ、panel.beatIds が対応する(後付け生成の置換)", () => {
  initializeDb();
  const doc = parseFountain(SCRIPT).doc;
  const units = buildPreLayoutUnits(doc);
  const beats = spanBeats(units);
  const legacy = applyBeatPageNaming({ pages: [{ index: 0, pageIntent: "reveal the photo", turnHook: "reveal", panels: [
    { id: "p1", sourceBeatIds: [beats[0]!.id] },
    { id: "p2", sourceBeatIds: beats.slice(1).map((beat) => beat.id) }
  ] }] }, { title: "Beats", units, beats, targetPageCount: 1 });
  assert.ok(legacy);
  const dialogues = [{
    id: "line-0", orderIndex: 0, sceneIndex: 0, characterId: null,
    speakerLabel: "ALICE", text: "これは……私?", semanticKind: "dialogue", balloonStyle: "normal"
  }];
  const build = (beatAnnotation: { units: typeof units; beats: AnnotatedBeat[] } | null, id: string) => buildMangaPlanV2({
    id, projectId: "proj", scriptId: "script", scriptRevisionId: "rev", doc,
    legacyPlan: legacy!, characters: [], dialogues, providerId: "comfy", globalLoras: [],
    dialoguePolicy: "preserve", resolveLayoutTemplate, beatAnnotation
  });
  const withBeats = build({ units, beats }, "planA");
  assert.deepEqual(
    withBeats.narrativeGraph.beats.map((beat) => beat.id),
    beats.map((beat) => `beat:planA:${beat.id}`)
  );
  assert.equal(withBeats.narrativeGraph.beats[2]!.kind, "reveal");
  assert.equal(withBeats.narrativeGraph.beats[2]!.importance, 0.9);
  const panels = withBeats.pages[0]!.panels;
  assert.deepEqual(panels[0]!.beatIds, ["beat:planA:b1"]);
  assert.deepEqual(panels[1]!.beatIds, ["beat:planA:b2", "beat:planA:b3"]);
  assert.equal(panels[1]!.visualScale, "large", "V5: ビートのpreferredScaleから導出");
  assert.equal(withBeats.pages[0]!.turnHook, "reveal");
  assert.ok(validateMangaPlanV2(withBeats).ok, JSON.stringify(validateMangaPlanV2(withBeats).issues));
  // 注釈なし(従来経路): コマ毎の後付けビート。
  const withoutBeats = build(null, "planB");
  assert.deepEqual(withoutBeats.pages[0]!.panels.map((panel) => panel.beatIds), [["beat:planB:0"], ["beat:planB:1"]]);
  assert.equal(withoutBeats.narrativeGraph.beats[0]!.kind, undefined);
  assert.ok(validateMangaPlanV2(withoutBeats).ok);
});
