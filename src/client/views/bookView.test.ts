import assert from "node:assert/strict";
import test from "node:test";
import type { BookPages, Character } from "../../shared/apiTypes.ts";
import type { CharacterReferenceSetView } from "../../shared/referenceSets.ts";
import { renderBookView } from "./bookView.ts";

const book: BookPages = {
  project: {
    id: "project-1", name: "Book", description: "", mode: "book", canvasWidth: 1024, canvasHeight: 1446,
    updatedAt: "2026-07-14T00:00:00Z"
  },
  pages: []
};

const characters: Character[] = ["Alice", "Bob"].map((name, index) => ({
  id: `character-${index + 1}`, projectId: "project-1", name, aliases: null, notes: "", color: null,
  createdAt: "2026-07-14T00:00:00Z", updatedAt: "2026-07-14T00:00:00Z"
}));

function referenceSet(characterId: string, modelFamily: "chroma" | "anima"): CharacterReferenceSetView {
  return {
    id: `${characterId}-${modelFamily}`, characterId, characterName: "Bob", variantId: `${characterId}:default`,
    modelFamily, version: 1, status: "approved", source: "uploaded", appearanceJa: "", appearancePromptEn: "",
    mustNotChange: [], appearanceHash: "hash", stale: false, approvedAt: "2026-07-14T00:00:00Z",
    createdAt: "2026-07-14T00:00:00Z", updatedAt: "2026-07-14T00:00:00Z", images: []
  };
}

test("Reference corner stays compact in the Book grid", () => {
  const html = renderBookView(book, false, [], {
    characters,
    referenceSets: [referenceSet("character-2", "chroma"), referenceSet("character-2", "anima")],
    open: false,
    selectedCharacterId: null,
    busyId: null
  });
  assert.match(html, /2 characters · 準備済み 1 · 要設定 1/);
  assert.match(html, /data-action="open-reference-corner"/);
  assert.doesNotMatch(html, /reference-family-grid/);
  assert.doesNotMatch(html, /reference-corner-modal/);
});

test("Reference corner modal switches detailed editors with character tabs", () => {
  const html = renderBookView(book, false, [], {
    characters,
    referenceSets: [referenceSet("character-2", "chroma"), referenceSet("character-2", "anima")],
    open: true,
    selectedCharacterId: "character-2",
    busyId: null
  });
  assert.match(html, /workflow-modal reference-corner-modal/);
  assert.match(html, /data-action="close-reference-corner"/);
  assert.match(html, /data-action="select-reference-character" data-id="character-1" aria-selected="false"/);
  assert.match(html, /data-action="select-reference-character" data-id="character-2" aria-selected="true"/);
  assert.match(html, /data-reference-family-card data-character-id="character-2" data-model-family="chroma"/);
  assert.doesNotMatch(html, /data-reference-family-card data-character-id="character-1"/);
});
