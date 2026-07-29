import assert from "node:assert/strict";
import test from "node:test";
import { parseFountain } from "../shared/fountain.ts";
import { buildStoryGraph, deriveSceneBibles, fountainSourceElementId, type StoryGraphCharacterInput } from "./storyGraphBuilder.ts";

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
  assert.deepEqual(result.visibleCharacterIdsForActionText(action.text), ["character-luna"]);
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
  assert.deepEqual(result.visibleCharacterIdsForActionText("[[character: Silent Child]] watches."), [silentCharacter.id]);
});

test("story graph distinguishes physical cast evidence from media and ownership mentions", () => {
  const characters: StoryGraphCharacterInput[] = [{ id: "character-mira", name: "ミラ", aliases: ["Mira"], notes: "" }];
  const result = graphFor("INT. ROOM - NIGHT\n\nモニターにミラが映る。", characters);
  assert.deepEqual(result.characterIdsForText("モニターにミラが映る。"), ["character-mira"], "generic mention lookup remains available");
  assert.deepEqual(result.visibleCharacterIdsForActionText("モニターにミラが映る。"), []);
  assert.deepEqual(result.visibleCharacterIdsForActionText("アリスがミラを探す。"), []);
  assert.deepEqual(result.visibleCharacterIdsForActionText("ミラがモニターの横に立つ。"), ["character-mira"]);
  assert.deepEqual(result.visibleCharacterIdsForActionText("ミラが部屋に入る。"), ["character-mira"]);
});

test("story graph warns about an unresolved Japanese pronoun in natural action prose", () => {
  const result = graphFor(`INT. ROOM - DAY\n\n彼女は静かに扉を開ける。`);
  const action = result.graph.sourceElements.find((element) => element.type === "action");
  assert.ok(action);
  assert.ok(result.graph.warnings.some(
    (warning) => warning.code === "unresolved-mention" && warning.sourceElementId === action.id
  ));
});

test("story graph freezes deterministic set/lighting/palette scene bibles", () => {
  const result = graphFor("INT. COCKPIT - NIGHT\n\nBlue warning lights pulse across the wet canopy.");
  assert.equal(result.graph.sceneBibles?.length, 1);
  const bible = result.graph.sceneBibles![0]!;
  assert.match(bible.set, /COCKPIT/);
  assert.match(bible.lighting, /night lighting/);
  // palette は色相ではなく階調で書く(既定出力がモノクロ漫画のため)。
  assert.match(bible.palette, /high-contrast tonal range/);
  const setting = result.graph.entities.find((entity) => entity.id === bible.settingId);
  assert.equal(setting?.attributes.palette, bible.palette);
});

test("deriveSceneBibles: palette は色相ではなく階調で書く(既定出力がモノクロ漫画のため)", () => {
  // 同じ prompt に "Japanese monochrome manga" が入るので、palette が色名を含むと
  // 矛盾する。CFG を下げた蒸留モデルでは negative が効かず、そのまま着色される。
  const doc = parseFountain(
    [
      "INT. 整理室 - 夜明け前",
      "",
      "窓の外はまだ暗い。",
      "",
      "INT. 教室 - 朝",
      "",
      "斜めの光が机を横切る。",
      "",
      "INT. 廊下 - CONTINUOUS",
      "",
      "誰もいない。"
    ].join("\n")
  ).doc;

  const bibles = deriveSceneBibles(doc, "rev-test");
  assert.equal(bibles.length, 3);

  const HUES = /\b(blue|red|green|yellow|orange|purple|pink|brown|cyan|magenta|teal|gold|silver|sepia|amber|crimson|azure|color(?:ed|ful)?)\b/i;
  for (const bible of bibles) {
    assert.ok(!HUES.test(bible.palette), `palette に色相が入っている: ${bible.palette}`);
    assert.ok(bible.palette.trim().length > 0, "palette は非空(validation が要求する)");
    assert.ok(bible.lighting.trim().length > 0, "lighting は非空");
    assert.ok(bible.set.trim().length > 0, "set は非空");
  }

  // 夜と昼で階調が変わることは維持する(場面ごとの気分は palette の役目)。
  assert.notEqual(bibles[0]!.palette, bibles[1]!.palette);
  assert.match(bibles[0]!.palette, /dark|black|high-contrast/i);
  assert.match(bibles[1]!.palette, /bright|white/i);
});

test("deriveSceneBibles: set は場所だけを書き、action 行の人物描写を混ぜない", () => {
  // action 行は規約どおり固有名を書かず、人物を外見で指す。これがシーン全コマへ
  // 配られると、そのコマに居ない人物の外見が prompt に残って絵に出てしまう。
  const doc = parseFountain([
    "INT. 鶴の湯 浴室 - 朝",
    "",
    "The elderly woman in a dark apron and round glasses enters the tiled bath hall holding a bucket.",
    "",
    "The young woman in paint-stained overalls holds the brush up beside her own face."
  ].join("\n")).doc;

  const bibles = deriveSceneBibles(doc, "rev-1");
  assert.equal(bibles.length, 1);
  const bible = bibles[0]!;
  assert.equal(bible.set, "鶴の湯 浴室 - 朝");
  assert.ok(!/elderly woman|round glasses|apron/i.test(bible.set), bible.set);
  assert.ok(!/overalls|brush/i.test(bible.set), bible.set);
  // 照明と階調はシーン単位の継続情報なので残す。
  assert.match(bible.lighting, /daylight/);
  assert.match(bible.palette, /tonal range/);
});
