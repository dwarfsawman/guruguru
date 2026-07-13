import type { Character } from "../shared/apiTypes";
import type { CharacterReferenceSetView, ReferenceImageRole, ReferenceModelFamily } from "../shared/referenceSets";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions, registerEventBinder } from "./actionRegistry";

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("参照画像を読み込めませんでした。")));
    reader.readAsDataURL(file);
  });
}

export async function loadReferenceCorner(projectId: string): Promise<void> {
  try {
    const [characters, sets] = await Promise.all([
      api<{ characters: Character[] }>(`/api/projects/${projectId}/characters`),
      api<{ referenceSets: CharacterReferenceSetView[] }>(`/api/projects/${projectId}/reference-sets`)
    ]);
    if (state.currentProjectId !== projectId) return;
    state.characters = characters.characters;
    state.referenceSets = sets.referenceSets;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

export function clearReferenceCorner(): void {
  state.referenceSets = [];
  state.referenceSetBusyId = null;
}

function familyCard(target: HTMLElement): HTMLElement {
  const card = target.closest<HTMLElement>("[data-reference-family-card]");
  if (!card) throw new Error("Reference Set card was not found");
  return card;
}

function inputValue(card: HTMLElement, name: string): string {
  return card.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value.trim() ?? "";
}

function setInput(card: HTMLElement): {
  characterId: string;
  modelFamily: ReferenceModelFamily;
  variantId: string;
  appearanceJa: string;
  appearancePromptEn: string;
  mustNotChange: string[];
} {
  const characterId = card.dataset.characterId ?? "";
  const modelFamily = card.dataset.modelFamily as ReferenceModelFamily;
  const variantId = inputValue(card, "variantId") || "default";
  const appearanceJa = inputValue(card, "appearanceJa");
  const appearancePromptEn = inputValue(card, "appearancePromptEn");
  const mustNotChange = inputValue(card, "mustNotChange").split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
  return { characterId, modelFamily, variantId, appearanceJa, appearancePromptEn, mustNotChange };
}

async function createFromCard(target: HTMLElement): Promise<CharacterReferenceSetView> {
  const card = familyCard(target);
  const input = setInput(card);
  const response = await api<{ referenceSet: CharacterReferenceSetView }>(`/api/characters/${input.characterId}/reference-sets`, {
    method: "POST",
    body: JSON.stringify(input)
  });
  return response.referenceSet;
}

async function withBusy(id: string, operation: () => Promise<void>): Promise<void> {
  if (state.referenceSetBusyId) return;
  state.referenceSetBusyId = id;
  requestRender();
  try {
    await operation();
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    state.referenceSetBusyId = null;
    if (state.currentProjectId) await loadReferenceCorner(state.currentProjectId);
    else requestRender();
  }
}

registerActions({
  "toggle-reference-corner": () => {
    state.referenceCornerExpanded = !state.referenceCornerExpanded;
    requestRender();
  },
  "refresh-reference-corner": () => {
    if (state.currentProjectId) void loadReferenceCorner(state.currentProjectId);
  },
  "create-reference-set": (_id, target) => {
    const key = target.dataset.characterId ?? "new";
    void withBusy(key, async () => {
      await createFromCard(target);
      pushToast("Reference Setの新しいバージョンを保存しました。", "info");
    });
  },
  "generate-reference-set": (id) => {
    void withBusy(id, async () => {
      await api(`/api/reference-sets/${id}/generate`, { method: "POST", body: "{}" });
      pushToast("候補生成を開始しました。自動採用は行いません。", "info");
    });
  },
  "regenerate-reference-set": (_id, target) => {
    void withBusy(target.dataset.characterId ?? "regenerate", async () => {
      const created = await createFromCard(target);
      await api(`/api/reference-sets/${created.id}/generate`, { method: "POST", body: "{}" });
      pushToast(`v${created.version}の候補生成を開始しました。`, "info");
    });
  },
  "approve-reference-set": (id, target) => {
    const card = familyCard(target);
    const faceAssetId = card.querySelector<HTMLInputElement>('input[data-candidate-role="face"]:checked')?.value;
    const fullBodyAssetId = card.querySelector<HTMLInputElement>('input[data-candidate-role="full_body"]:checked')?.value;
    void withBusy(id, async () => {
      await api(`/api/reference-sets/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ faceAssetId, fullBodyAssetId })
      });
      pushToast("Reference Setを承認しました。", "info");
    });
  }
});

registerEventBinder((app) => {
  app.addEventListener("change", (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (!input?.matches("[data-reference-upload]") || !input.files?.[0]) return;
    const setId = input.dataset.referenceSetId ?? "";
    const role = input.dataset.referenceUpload as ReferenceImageRole;
    const file = input.files[0];
    void withBusy(setId, async () => {
      const imageDataUrl = await fileToDataUrl(file);
      await api(`/api/reference-sets/${setId}/images/${role}`, {
        method: "PUT",
        body: JSON.stringify({ imageDataUrl })
      });
      pushToast(`${role === "face" ? "顔" : "全身"}画像を確認待ちに追加しました。`, "info");
    });
  });
});
