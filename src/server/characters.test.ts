import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCharacter,
  deleteCharacter,
  findCharacterByLabel,
  findOrCreateCharacterByLabel,
  getCharacterBinding,
  listCharacters,
  putCharacterBinding,
  updateCharacter
} from "./characters.ts";
import { createProject } from "./projects.ts";
import { initializeDb } from "./db.ts";

// 1x1 の最小 PNG(dataUrl アップロード用)。src/server/pages.test.ts と同一。
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

function createTestProject() {
  initializeDb();
  const project = createProject({ name: "S3 characters", mode: "book" });
  assert.ok(project);
  return project!.id as string;
}

test("createCharacter / listCharacters / updateCharacter / deleteCharacter", () => {
  const projectId = createTestProject();
  const character = createCharacter(projectId, { name: "太郎", aliases: ["タロウ", "たろう", ""], color: "#ff0000" });
  assert.equal(character.name, "太郎");
  assert.deepEqual(character.aliases, ["タロウ", "たろう"]);
  assert.equal(character.color, "#ff0000");

  const list = listCharacters(projectId);
  assert.equal(list.length, 1);

  const updated = updateCharacter(character.id, { notes: "元気な性格" });
  assert.equal(updated.notes, "元気な性格");
  assert.equal(updated.name, "太郎", "unspecified fields keep their previous value");

  const deleted = deleteCharacter(character.id);
  assert.equal(deleted.deleted, true);
  assert.equal(listCharacters(projectId).length, 0);
});

test("findCharacterByLabel: name/aliases の大文字小文字・空白ゆれを吸収する", () => {
  const projectId = createTestProject();
  createCharacter(projectId, { name: "Alice", aliases: ["ALI"] });
  assert.ok(findCharacterByLabel(projectId, " alice "));
  assert.ok(findCharacterByLabel(projectId, "ali"));
  assert.equal(findCharacterByLabel(projectId, "Bob"), null);
});

test("findOrCreateCharacterByLabel: 未知話者は自動作成する", () => {
  const projectId = createTestProject();
  const created = findOrCreateCharacterByLabel(projectId, "花子");
  assert.equal(created.name, "花子");
  const again = findOrCreateCharacterByLabel(projectId, "花子");
  assert.equal(again.id, created.id, "同じ話者名は同一 Character に解決される");
});

test("character binding: comfy の faceImagePath は API で生パスとして返らない", async () => {
  const projectId = createTestProject();
  const character = createCharacter(projectId, { name: "太郎" });

  const emptyBinding = getCharacterBinding(character.id, "comfy");
  assert.equal(emptyBinding.hasFaceImage, false);
  assert.equal(emptyBinding.faceImageUrl, null);

  const view = await putCharacterBinding(character.id, "comfy", {
    faceImageDataUrl: TINY_PNG_DATA_URL,
    loraName: "style_a.safetensors",
    loraStrength: 0.8
  });
  assert.equal(view.hasFaceImage, true);
  assert.equal(view.faceImageUrl, `/api/characters/${character.id}/bindings/comfy/face-image`);
  assert.equal(view.loraName, "style_a.safetensors");
  assert.equal(view.loraStrength, 0.8);
  // faceImagePath そのものは view のどのフィールドにも文字列として現れない(ローカル絶対パスの露出禁止)。
  assert.ok(!Object.values(view).some((value) => typeof value === "string" && value.includes(":\\")));

  const cleared = await putCharacterBinding(character.id, "comfy", { clearFaceImage: true });
  assert.equal(cleared.hasFaceImage, false);
  assert.equal(cleared.loraName, "style_a.safetensors", "clearFaceImage だけを変更し他のフィールドは維持する");
});

test("character binding: 未知 provider の binding_json は空 object として保存される(検証できないものは保存しない)", async () => {
  const projectId = createTestProject();
  const character = createCharacter(projectId, { name: "太郎" });
  const view = await putCharacterBinding(character.id, "unknown-provider", { faceImagePath: "C:\\secret\\path.png" });
  assert.equal(view.hasFaceImage, false);
  assert.equal(view.loraName, null);
});
