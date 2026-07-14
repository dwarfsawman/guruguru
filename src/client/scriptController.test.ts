import assert from "node:assert/strict";
import test from "node:test";
import { state } from "./appState.ts";
import { clearBookSession } from "./bookController.ts";

test("clearBookSession discards script ids and collections from the previous project", () => {
  state.scriptScreenOpen = true;
  state.scripts = [{ id: "old-script" } as never];
  state.activeScriptId = "old-script";
  state.activeScriptRevision = { id: "old-revision" } as never;
  state.scriptDialogueLines = [{ id: "old-line" } as never];
  state.scriptFountainDraft = "old fountain";
  state.scriptImportBusy = true;
  state.characters = [{ id: "old-character" } as never];
  state.selectedCharacterId = "old-character";
  state.selectedCharacterBinding = { characterId: "old-character" } as never;
  state.characterLoraNameDraft = "old.safetensors";
  state.characterLoraStrengthDraft = 0.5;
  state.characterFacePickerOpen = true;

  clearBookSession();

  assert.equal(state.scriptScreenOpen, false);
  assert.deepEqual(state.scripts, []);
  assert.equal(state.activeScriptId, null);
  assert.equal(state.activeScriptRevision, null);
  assert.deepEqual(state.scriptDialogueLines, []);
  assert.equal(state.scriptFountainDraft, "");
  assert.equal(state.scriptImportBusy, false);
  assert.deepEqual(state.characters, []);
  assert.equal(state.selectedCharacterId, null);
  assert.equal(state.selectedCharacterBinding, null);
  assert.equal(state.characterLoraNameDraft, "");
  assert.equal(state.characterLoraStrengthDraft, 1);
  assert.equal(state.characterFacePickerOpen, false);
});
