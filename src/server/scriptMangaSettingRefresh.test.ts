import assert from "node:assert/strict";
import test from "node:test";
import type { NarrativeEntity } from "../shared/mangaPlanV2.ts";
import { refreshedSettingEntities } from "./scriptMangaSubmission.ts";

const setting = (index: number, description?: string): NarrativeEntity => ({
  id: `setting:rev-1:scene-${index}`,
  kind: "setting",
  name: `Scene ${index}`,
  aliases: [],
  attributes: { heading: "INT. BATH", ...(description ? { description } : {}) },
  variants: []
} as unknown as NarrativeEntity);

test("舞台記述は run 設定から取り直す（プランに焼かれた古い記述を使わない）", () => {
  // 実測: 舞台が物語の中で変わる作品で設定を直しても再生成に反映されず、
  // 終盤8コマが「新しい壁画が描かれない」で全滅し、retry しても同じ絵が出続けた。
  const character = { id: "char:a", kind: "character", name: "A", aliases: [], attributes: {}, variants: [] } as unknown as NarrativeEntity;
  const entities = [setting(1, "old mural on the far wall"), setting(9, "old mural on the far wall"), character];
  const refreshed = refreshedSettingEntities(entities, { 1: "faded outline only", 9: "blank pale wall" });

  assert.equal(refreshed[0]!.attributes.description, "faded outline only");
  assert.equal(refreshed[1]!.attributes.description, "blank pale wall");
  assert.equal(refreshed[2], character, "人物エンティティは触らない");
  assert.equal(entities[0]!.attributes.description, "old mural on the far wall", "元の配列を破壊しない");
});

test("設定が無い・該当シーンが無いときは元のまま", () => {
  const entities = [setting(2, "storeroom")];
  assert.equal(refreshedSettingEntities(entities, undefined)[0]!.attributes.description, "storeroom");
  assert.equal(refreshedSettingEntities(entities, {})[0]!.attributes.description, "storeroom");
  assert.equal(refreshedSettingEntities(entities, { 5: "elsewhere" })[0]!.attributes.description, "storeroom");
});
