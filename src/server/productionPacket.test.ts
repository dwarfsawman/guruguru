import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRow, initializeDb } from "./db.ts";
import { listCharacters } from "./characters.ts";
import { createProject } from "./projects.ts";
import { listScripts, listScriptRevisions } from "./scripts.ts";
import {
  __testing,
  buildCharacterBible,
  bundledFiles,
  getStoryContext,
  importProductionPacket,
  readPacket
} from "./productionPacket.ts";

initializeDb();

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
  "base64"
);

const FOUNTAIN = "INT. 教室 - 夜明け前\n\nアオイが当番表に判を押す。\n\nアオイ\nおはよう。\n\nハル\n…おはよ。\n";

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 実際の書き出しと同じ形のパケットをテンポラリへ組み立てる。 */
function writePacket(overrides: (manifest: Record<string, unknown>) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "guruguru-packet-"));
  const scriptBytes = Buffer.from(FOUNTAIN, "utf8");
  writeFileSync(join(dir, "script.fountain"), scriptBytes);

  const faceRelative = "assets/characters/aoi/face.png";
  mkdirSync(join(dir, "assets", "characters", "aoi"), { recursive: true });
  writeFileSync(join(dir, faceRelative), TINY_PNG);

  const manifest: Record<string, unknown> = {
    formatVersion: 1,
    kind: "manga-production-packet",
    generator: { name: "character-garage", version: "2026.7.21" },
    generatedAtMs: 1780000000000,
    source: { workId: "11111111-1111-4111-8111-111111111111", episodeId: "22222222-2222-4222-8222-222222222222" },
    work: { title: "整理当番", description: "学園SF" },
    episode: { number: 1, title: "整理当番", summary: "却下から和解まで" },
    storyBible: {
      logline: "当番が申請を却下する話",
      theme: "何を持ち続けるか",
      premise: "記憶整理制度のある高校",
      tone: "モノクロ・静かな学園SF",
      ending: "当番が自分の空白を認める",
      audience: "青年",
      notes: "",
      settings: [{ name: "教室", description: "夜明け前", significance: "制度が執行される場所" }]
    },
    cast: [
      {
        name: "アオイ",
        displayName: "アオイ",
        aliases: ["委員長"],
        profile: "黒髪ボブ、制服、几帳面",
        arc: {
          want: "制度を正しく回したい",
          need: "自分の空白を認める",
          flaw: "効率を理由に痛みを避ける",
          startState: "疑いなく判を押す",
          turn: "却下が相手を壊したと知る",
          endState: "保留の欄を作る"
        },
        outfits: [{ scene: "終盤", description: "カーディガンを羽織る" }],
        referenceImages: [{ path: faceRelative, bytes: TINY_PNG.length, sha256: sha256(TINY_PNG) }]
      },
      {
        name: "ハル",
        displayName: "ハル",
        aliases: [],
        profile: "癖毛、猫背、ポケットに古い写真",
        arc: { want: "一行だけ消したい", need: "憶えていていいと知る", flaw: "", startState: "", turn: "", endState: "" },
        outfits: [],
        referenceImages: []
      }
    ],
    relationships: [{ from: "アオイ", to: "ハル", kind: "同級生", description: "当番と申請者", directed: true }],
    outline: {
      beats: [
        { name: "朝の承認", summary: "判を押す手", function: "setup", characters: ["アオイ"], setting: "教室" },
        { name: "却下", summary: "善意で申請を止める", function: "inciting_incident", characters: ["アオイ", "ハル"], setting: "教室" }
      ],
      pages: [
        { number: 1, summary: "手のアップ", beats: ["朝の承認"], turnNote: "制度を見せる" },
        { number: 2, summary: "却下の瞬間", beats: ["却下"], turnNote: "めくりで反応" }
      ]
    },
    script: { path: "script.fountain", bytes: scriptBytes.length, sha256: sha256(scriptBytes) },
    loras: [{ character: "アオイ", name: "aoi-v1.safetensors", bytes: 140000000, bundled: false }]
  };
  overrides(manifest);
  writeFileSync(join(dir, "packet.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

const created: string[] = [];
function packet(overrides?: (manifest: Record<string, unknown>) => void) {
  const dir = writePacket(overrides);
  created.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPacket accepts a well-formed packet and reports its bundled files", () => {
  const manifest = readPacket(packet());
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.episode.number, 1);
  assert.equal(manifest.cast.length, 2);
  assert.equal(manifest.outline.beats.length, 2);
  assert.equal(manifest.outline.pages.length, 2);
  assert.equal(manifest.relationships.length, 1);
  assert.equal(bundledFiles(manifest).length, 2);
  assert.equal(manifest.loras[0]?.bundled, false);
});

test("readPacket refuses an unsupported format version", () => {
  assert.throws(
    () => readPacket(packet((manifest) => { manifest.formatVersion = 99; })),
    /formatVersion 99 is not supported/
  );
});

test("readPacket refuses a directory that is not a production packet", () => {
  assert.throws(
    () => readPacket(packet((manifest) => { manifest.kind = "something-else"; })),
    /kind is/
  );
  const empty = mkdtempSync(join(tmpdir(), "guruguru-empty-"));
  created.push(empty);
  assert.throws(() => readPacket(empty), /packet\.json was not found/);
});

test("readPacket refuses a tampered bundled file", () => {
  const dir = packet();
  writeFileSync(join(dir, "script.fountain"), "tampered");
  assert.throws(() => readPacket(dir), /size mismatch|checksum mismatch/);
});

test("readPacket refuses a bundled file whose bytes match but content does not", () => {
  const dir = packet();
  const original = readFileSync(join(dir, "script.fountain"));
  const sameLength = Buffer.alloc(original.length, 0x41);
  writeFileSync(join(dir, "script.fountain"), sameLength);
  assert.throws(() => readPacket(dir), /checksum mismatch/);
});

test("readPacket refuses a missing bundled file", () => {
  const dir = packet();
  rmSync(join(dir, "script.fountain"));
  assert.throws(() => readPacket(dir), /bundled file is missing/);
});

test("readPacket refuses manifest paths that escape the packet directory", () => {
  assert.throws(
    () => readPacket(packet((manifest) => {
      (manifest.script as Record<string, unknown>).path = "../outside.fountain";
    })),
    /escapes the packet/
  );
  assert.throws(
    () => readPacket(packet((manifest) => {
      (manifest.script as Record<string, unknown>).path = "C:/Windows/System32/drivers/etc/hosts";
    })),
    /must be relative|escapes the packet/
  );
});

test("readPacket refuses a duplicated cast name", () => {
  assert.throws(
    () => readPacket(packet((manifest) => {
      const cast = manifest.cast as Array<Record<string, unknown>>;
      cast[1]!.name = "アオイ";
    })),
    /more than once/
  );
});

test("readPacket refuses a manifest with a malformed checksum", () => {
  assert.throws(
    () => readPacket(packet((manifest) => {
      (manifest.script as Record<string, unknown>).sha256 = "not-a-digest";
    })),
    /is not a SHA-256 digest/
  );
});

test("importing a packet creates a book project, the script, and the cast", async () => {
  const dir = packet();
  const result = await importProductionPacket({ packetPath: dir });

  assert.equal(result.projectCreated, true);
  assert.equal(result.charactersCreated, 2);
  assert.equal(result.charactersUpdated, 0);
  assert.equal(result.scriptRevision, 1);
  assert.equal(result.referenceImagesCopied, 1);

  const project = getRow<{ mode: string; name: string }>("SELECT mode, name FROM projects WHERE id = ?", [
    result.projectId
  ]);
  assert.equal(project?.mode, "book");

  const scripts = listScripts(result.projectId);
  assert.equal(scripts.length, 1);
  assert.equal(readFileSync(join(dir, "script.fountain"), "utf8").includes("おはよう"), true);

  // 脚本の話者名から重複キャラクターが増えていないこと(キャストを先に入れる理由)。
  const characters = listCharacters(result.projectId);
  assert.equal(characters.length, 2);
  const aoi = characters.find((character) => character.name === "アオイ");
  assert.ok(aoi, "アオイ should exist");
  assert.equal(aoi!.aliases?.includes("委員長"), true);
  assert.equal(aoi!.notes.includes("黒髪ボブ"), true);
  assert.equal(aoi!.notes.includes("望み: 制度を正しく回したい"), true);
  assert.equal(aoi!.notes.includes("カーディガン"), true);

  // 参照画像はプロジェクト配下へ複製され、Reference Set は自動作成しない。
  const context = getStoryContext(result.projectId);
  assert.ok(context);
  assert.equal(context!.referenceImages.length, 1);
  assert.equal(existsSync(context!.referenceImages[0]!.storedPath), true);
  assert.equal(context!.storyBible.logline, "当番が申請を却下する話");
  assert.equal(context!.outline.pages.length, 2);
  assert.equal(context!.arcs.find((entry) => entry.name === "アオイ")?.arc.turn, "却下が相手を壊したと知る");
  assert.equal(context!.characterBible.includes("アオイ: 黒髪ボブ"), true);

  // LoRA は同梱されないので、生成前に用意する必要があることを警告する。
  assert.equal(result.warnings.some((warning) => warning.includes("LoRA")), true);
});

test("re-importing the same packet adds a script revision instead of a second script", async () => {
  const dir = packet();
  const first = await importProductionPacket({ packetPath: dir });

  const updated = packet((manifest) => {
    // 同じ source の改訂版を模す。
    (manifest.episode as Record<string, unknown>).summary = "改訂";
  });
  writeFileSync(join(updated, "script.fountain"), `${FOUNTAIN}\nアオイ\nもう一度。\n`);
  const bytes = readFileSync(join(updated, "script.fountain"));
  const manifest = JSON.parse(readFileSync(join(updated, "packet.json"), "utf8")) as Record<string, unknown>;
  manifest.script = { path: "script.fountain", bytes: bytes.length, sha256: sha256(bytes) };
  writeFileSync(join(updated, "packet.json"), JSON.stringify(manifest));

  const second = await importProductionPacket({ packetPath: updated, projectId: first.projectId });
  assert.equal(second.projectId, first.projectId);
  assert.equal(second.projectCreated, false);
  assert.equal(second.charactersCreated, 0);
  assert.equal(second.charactersUpdated, 2);
  assert.equal(listScripts(first.projectId).length, 1);
  assert.equal(second.scriptRevision, 2);
  assert.equal(listScriptRevisions(second.scriptId!).length, 2);
});

test("importing a packet from a different source into the same project starts a new script", async () => {
  const first = await importProductionPacket({ packetPath: packet() });
  const other = packet((manifest) => {
    (manifest.source as Record<string, unknown>).episodeId = "44444444-4444-4444-8444-444444444444";
    (manifest.episode as Record<string, unknown>).number = 2;
  });
  const second = await importProductionPacket({ packetPath: other, projectId: first.projectId });
  assert.equal(second.scriptRevision, 1);
  assert.equal(listScripts(first.projectId).length, 2);
});

test("importing into a project that does not exist is refused", async () => {
  await assert.rejects(
    () => importProductionPacket({ packetPath: packet(), projectId: "project-does-not-exist" }),
    /Project was not found/
  );
});

test("an invalid packet writes nothing", async () => {
  const project = createProject({ name: "受け入れ先", mode: "book" });
  const before = listCharacters(project!.id).length;
  const dir = packet();
  rmSync(join(dir, "script.fountain"));

  await assert.rejects(() => importProductionPacket({ packetPath: dir, projectId: project!.id }), /bundled file is missing/);
  assert.equal(listCharacters(project!.id).length, before);
  assert.equal(listScripts(project!.id).length, 0);
  assert.equal(getStoryContext(project!.id), null);
});

test("a packet without a script imports the cast and warns", async () => {
  const dir = packet((manifest) => { delete manifest.script; });
  rmSync(join(dir, "script.fountain"));
  const result = await importProductionPacket({ packetPath: dir });
  assert.equal(result.scriptId, null);
  assert.equal(result.charactersCreated, 2);
  assert.equal(result.warnings.some((warning) => warning.includes("script.fountain")), true);
});

test("character bible lists every cast member's appearance and outfits", () => {
  const bible = buildCharacterBible(readPacket(packet()));
  assert.equal(bible.includes("アオイ: 黒髪ボブ、制服、几帳面"), true);
  assert.equal(bible.includes("衣装差分 — 終盤: カーディガンを羽織る"), true);
  assert.equal(bible.includes("ハル: 癖毛、猫背"), true);
});

test("packet paths are resolved below the packet directory only", () => {
  const dir = packet();
  assert.equal(__testing.resolvePacketPath(dir, "script.fountain").startsWith(dir), true);
  assert.throws(() => __testing.resolvePacketPath(dir, "../escape"), /escapes the packet/);
  assert.throws(() => __testing.resolvePacketPath(dir, "a/../../escape"), /escapes the packet/);
  assert.throws(() => __testing.resolvePacketPath(dir, ""), /empty path/);
});
