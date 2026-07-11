import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "../shared/fountain.ts";
import { buildStoryGraph, fountainSourceElementId, type StoryGraphCharacterInput } from "./storyGraphBuilder.ts";

function graphFor(source: string, characters: StoryGraphCharacterInput[] = []) {
  return buildStoryGraph({
    doc: parseFountain(source).doc,
    scriptRevisionId: "revision-42",
    characters,
    dialogues: []
  });
}

test("story graph assigns stable source ids from revision, scene and element indexes", () => {
  const source = `INT. LAB - NIGHT\n\nAlice enters.\n\n@Alice\nHello.\n\n>CUT TO:`;
  const first = graphFor(source);
  const second = graphFor(source);
  assert.deepEqual(
    first.graph.sourceElements.map((element) => element.id),
    second.graph.sourceElements.map((element) => element.id)
  );
  assert.equal(first.sourceIdBySceneElement.get("0:0"), "source:revision-42:scene-0:element-0");
  assert.equal(first.sourceIdBySceneElement.get("0:1"), "source:revision-42:scene-0:element-1");
  assert.equal(fountainSourceElementId("revision-42", 0, 2), "source:revision-42:scene-0:element-2");
});

test("story graph resolves an existing Character alias from action prose", () => {
  const characters: StoryGraphCharacterInput[] = [{
    id: "character-luna",
    name: "月城ルナ",
    aliases: ["Captain Luna", "ルナ"],
    notes: "silver hair"
  }];
  const result = graphFor(`INT. BRIDGE - NIGHT\n\nCaptain Luna enters the bridge.`, characters);
  const action = result.graph.sourceElements.find((element) => element.type === "action");
  assert.ok(action);
  assert.deepEqual(result.characterIdsForText(action.text), ["character-luna"]);
  assert.equal(result.characterById.get("character-luna")?.name, "月城ルナ");
  assert.equal(result.graph.entities.find((entity) => entity.id === "character-luna")?.attributes.description, "silver hair");
});

test("story graph grounds explicit silent character and prop tags", () => {
  const result = graphFor(
    `INT. VAULT - NIGHT\n\n[[character: Silent Child]] stands beside [[prop: Brass Key]].`
  );
  const silentCharacter = result.graph.entities.find((entity) => entity.kind === "character" && entity.name === "Silent Child");
  const prop = result.graph.entities.find((entity) => entity.kind === "prop" && entity.name === "Brass Key");
  assert.ok(silentCharacter);
  assert.ok(prop);
  assert.equal(silentCharacter.attributes.source, "explicit-fountain-tag");
  assert.equal(prop.attributes.source, "explicit-fountain-tag");
  assert.deepEqual(result.characterIdsForText("The Silent Child watches."), [silentCharacter.id]);
});

test("story graph warns about an unresolved Japanese pronoun in natural action prose", () => {
  const result = graphFor(`INT. ROOM - DAY\n\n彼女は静かに扉を開ける。`);
  const action = result.graph.sourceElements.find((element) => element.type === "action");
  assert.ok(action);
  assert.ok(result.graph.warnings.some(
    (warning) => warning.code === "unresolved-mention" && warning.sourceElementId === action.id
  ));
});
