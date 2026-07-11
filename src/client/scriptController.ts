/**
 * 脚本画面(Docs/Feature-ScriptToManga.md S3)の controller。Fountain 取り込み/再取り込み、
 * シーン/セリフ一覧、キャラクタ CRUD + comfy binding(顔参照/LoRA)編集、セリフ行のページ割当を扱う。
 * `bookController.ts` の openBookSettings/backFromBookSettings と同型の画面遷移パターン。
 * AGENTS.md 規約により data-action は `registerActions` で登録する(main.ts への関数追加は禁止)。
 */
import type {
  Character,
  CharacterBindingView,
  CreatePlacementResult,
  DialogueLine,
  MangaScript,
  ScriptImportResult,
  ScriptRevision
} from "../shared/apiTypes";
import { api } from "./api";
import { pushToast, requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { refreshLoraChoices } from "./styleLoraController";
import { refreshRecentReferenceImages } from "./referenceController";
import {
  clearScriptMangaRunState,
  clearScriptMangaUiState,
  initializeScriptMangaUiState
} from "./scriptMangaController";

/** 脚本画面を開く(book grid の上に重ねて表示)。脚本一覧+キャラクタ一覧を取得する。 */
export async function openScriptScreen() {
  if (!state.currentProjectId || !state.book) {
    return;
  }
  state.detail = null;
  state.activePageId = null;
  state.activeRoundId = null;
  state.activeAssetId = null;
  state.bookSettingsOpen = false;
  state.scriptScreenOpen = true;
  state.sidebarOpen = false;
  state.maskEditMode = false;
  state.paintEditMode = false;
  initializeScriptMangaUiState();
  requestRender();

  const projectId = state.currentProjectId;
  try {
    const [scriptsResult, charactersResult] = await Promise.all([
      api<{ scripts: MangaScript[] }>(`/api/projects/${projectId}/scripts`),
      api<{ characters: Character[] }>(`/api/projects/${projectId}/characters`)
    ]);
    if (state.currentProjectId !== projectId || !state.scriptScreenOpen) {
      return;
    }
    state.scripts = scriptsResult.scripts;
    state.characters = charactersResult.characters;
    const firstScript = scriptsResult.scripts[0] ?? null;
    if (firstScript) {
      await selectScript(firstScript.id);
    } else {
      state.activeScriptId = null;
      state.activeScriptRevision = null;
      state.scriptDialogueLines = [];
      state.scriptFountainDraft = "";
    }
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
  void refreshLoraChoices();
}

/** 脚本画面からページ一覧へ戻る。 */
function closeScriptScreen() {
  state.scriptScreenOpen = false;
  state.activeScriptId = null;
  state.activeScriptRevision = null;
  state.scriptDialogueLines = [];
  state.scriptFountainDraft = "";
  state.selectedCharacterId = null;
  state.selectedCharacterBinding = null;
  state.characterFacePickerOpen = false;
  clearScriptMangaUiState();
  requestRender();
}

async function refreshScriptDialogueLines(scriptId: string) {
  if (!state.currentProjectId) {
    return;
  }
  const lines = await api<{ lines: DialogueLine[] }>(
    `/api/projects/${state.currentProjectId}/dialogue-lines?scriptId=${encodeURIComponent(scriptId)}`
  );
  if (state.activeScriptId === scriptId) {
    state.scriptDialogueLines = lines.lines;
  }
}

/** 脚本を切り替える。最新 revision + セリフ一覧を取得する。 */
export async function selectScript(scriptId: string) {
  clearScriptMangaRunState();
  state.activeScriptId = scriptId;
  requestRender();
  try {
    await Promise.all([fetchLatestRevisionInto(scriptId), refreshScriptDialogueLines(scriptId)]);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

/** その脚本の最新 revision を解決して state へ入れる。 */
async function fetchLatestRevisionInto(scriptId: string) {
  const result = await api<{ revisions: ScriptRevision[] }>(`/api/scripts/${scriptId}/revisions`);
  const latest = result.revisions[result.revisions.length - 1] ?? null;
  if (state.activeScriptId === scriptId) {
    state.activeScriptRevision = latest;
    state.scriptFountainDraft = latest?.fountainSource ?? state.scriptFountainDraft;
  }
}

function setScriptFountainDraft(value: string) {
  state.scriptFountainDraft = value;
}

/** Fountain テキストエリアの入力を state へ反映する(main.ts の input 委譲から呼ぶ)。 */
export function updateScriptFountainDraftFromControl(target: HTMLTextAreaElement) {
  setScriptFountainDraft(target.value);
}

async function importOrReimportScript() {
  const projectId = state.currentProjectId;
  if (!projectId || state.scriptImportBusy) {
    return;
  }
  const fountainSource = state.scriptFountainDraft;
  if (!fountainSource.trim()) {
    pushToast("Fountain テキストを入力してください。", "error");
    return;
  }
  clearScriptMangaRunState();
  state.scriptImportBusy = true;
  requestRender();
  try {
    let result: ScriptImportResult;
    if (state.activeScriptId) {
      result = await api<ScriptImportResult>(`/api/scripts/${state.activeScriptId}/revisions`, {
        method: "POST",
        body: JSON.stringify({ fountainSource })
      });
    } else {
      result = await api<ScriptImportResult>(`/api/projects/${projectId}/scripts`, {
        method: "POST",
        body: JSON.stringify({ fountainSource })
      });
      state.scripts = [...state.scripts, result.script];
    }
    if (state.currentProjectId !== projectId) {
      return;
    }
    state.activeScriptId = result.script.id;
    state.activeScriptRevision = result.revision;
    state.scriptDialogueLines = result.lines;
    // 話者の自動作成でキャラクタが増えている可能性があるので取り直す。
    const charactersResult = await api<{ characters: Character[] }>(`/api/projects/${projectId}/characters`);
    if (state.currentProjectId === projectId) {
      state.characters = charactersResult.characters;
    }
    const warningCount = result.revision.warnings?.length ?? 0;
    pushToast(
      warningCount > 0
        ? `脚本を取り込みました(警告 ${warningCount} 件)。`
        : "脚本を取り込みました。",
      "info"
    );
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    state.scriptImportBusy = false;
    requestRender();
  }
}

// --- キャラクタ CRUD ---

async function addCharacter() {
  const projectId = state.currentProjectId;
  if (!projectId) {
    return;
  }
  try {
    const result = await api<{ character: Character }>(`/api/projects/${projectId}/characters`, {
      method: "POST",
      body: JSON.stringify({ name: "新しいキャラクター" })
    });
    state.characters = [...state.characters, result.character];
    void selectCharacter(result.character.id);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
    requestRender();
  }
}

export async function selectCharacter(characterId: string) {
  state.selectedCharacterId = characterId;
  state.selectedCharacterBinding = null;
  state.characterFacePickerOpen = false;
  requestRender();
  try {
    const binding = await api<CharacterBindingView>(`/api/characters/${characterId}/bindings/comfy`);
    if (state.selectedCharacterId !== characterId) {
      return;
    }
    state.selectedCharacterBinding = binding;
    state.characterLoraNameDraft = binding.loraName ?? "";
    state.characterLoraStrengthDraft = binding.loraStrength ?? 1;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
  void refreshRecentReferenceImages();
}

function patchSelectedCharacter(fields: Partial<Pick<Character, "name" | "notes" | "color">>) {
  const characterId = state.selectedCharacterId;
  if (!characterId) {
    return;
  }
  void api<{ character: Character }>(`/api/characters/${characterId}`, {
    method: "PATCH",
    body: JSON.stringify(fields)
  })
    .then((result) => {
      state.characters = state.characters.map((character) => (character.id === characterId ? result.character : character));
      requestRender();
    })
    .catch((error) => {
      pushToast(error instanceof Error ? error.message : String(error), "error");
      requestRender();
    });
}

/** 名前/口調メモ/色の入力を state + サーバへ反映する(main.ts の input/change 委譲から呼ぶ)。 */
export function updateCharacterFieldFromControl(target: HTMLInputElement | HTMLTextAreaElement) {
  const field = target.dataset.characterField;
  if (field === "name" || field === "notes" || field === "color") {
    patchSelectedCharacter({ [field]: target.value } as Partial<Pick<Character, "name" | "notes" | "color">>);
  }
}

async function deleteSelectedCharacter() {
  const characterId = state.selectedCharacterId;
  if (!characterId) {
    return;
  }
  try {
    await api(`/api/characters/${characterId}`, { method: "DELETE" });
    state.characters = state.characters.filter((character) => character.id !== characterId);
    state.selectedCharacterId = null;
    state.selectedCharacterBinding = null;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

// --- comfy binding(顔参照/LoRA) ---

async function saveCharacterLora() {
  const characterId = state.selectedCharacterId;
  if (!characterId) {
    return;
  }
  try {
    const binding = await api<CharacterBindingView>(`/api/characters/${characterId}/bindings/comfy`, {
      method: "PUT",
      body: JSON.stringify({
        loraName: state.characterLoraNameDraft.trim() || null,
        loraStrength: state.characterLoraStrengthDraft
      })
    });
    if (state.selectedCharacterId === characterId) {
      state.selectedCharacterBinding = binding;
    }
    pushToast("LoRA 設定を保存しました。", "info");
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

export function updateCharacterLoraFromControl(target: HTMLInputElement | HTMLSelectElement) {
  const field = target.dataset.characterLoraField;
  if (field === "name") {
    state.characterLoraNameDraft = target.value;
  } else if (field === "strength") {
    const value = Number(target.value);
    state.characterLoraStrengthDraft = Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : state.characterLoraStrengthDraft;
  }
}

function toggleCharacterFacePicker() {
  if (!state.selectedCharacterId) {
    return;
  }
  state.characterFacePickerOpen = !state.characterFacePickerOpen;
  requestRender();
  if (state.characterFacePickerOpen) {
    void refreshRecentReferenceImages();
  }
}

async function putCharacterFaceImage(characterId: string, faceImageDataUrl: string) {
  try {
    const binding = await api<CharacterBindingView>(`/api/characters/${characterId}/bindings/comfy`, {
      method: "PUT",
      body: JSON.stringify({ faceImageDataUrl })
    });
    if (state.selectedCharacterId === characterId) {
      state.selectedCharacterBinding = binding;
      state.characterFacePickerOpen = false;
    }
    pushToast("顔参照画像を設定しました。", "info");
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

/** 「最近使った画像」ピッカーから顔参照を選ぶ。 */
async function pickCharacterFaceFromRecent(url: string) {
  const characterId = state.selectedCharacterId;
  if (!characterId) {
    return;
  }
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`画像を取得できませんでした (${response.status})`);
    }
    const blob = await response.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
      reader.addEventListener("error", () => reject(reader.error ?? new Error("画像を読み込めませんでした。")));
      reader.readAsDataURL(blob);
    });
    if (state.selectedCharacterId !== characterId) {
      return;
    }
    await putCharacterFaceImage(characterId, dataUrl);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
    requestRender();
  }
}

/** ファイル選択での顔参照アップロード(main.ts の change 委譲から呼ぶ)。 */
export async function uploadCharacterFaceImage(input: HTMLInputElement) {
  const characterId = state.selectedCharacterId;
  const file = input.files?.[0];
  input.value = "";
  if (!characterId || !file) {
    return;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    pushToast("顔参照画像は PNG / JPEG / WebP 画像を選択してください。", "error");
    return;
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("顔参照画像を読み込めませんでした。")));
    reader.readAsDataURL(file);
  });
  await putCharacterFaceImage(characterId, dataUrl);
}

async function clearCharacterFaceImage() {
  const characterId = state.selectedCharacterId;
  if (!characterId) {
    return;
  }
  try {
    const binding = await api<CharacterBindingView>(`/api/characters/${characterId}/bindings/comfy`, {
      method: "PUT",
      body: JSON.stringify({ clearFaceImage: true })
    });
    if (state.selectedCharacterId === characterId) {
      state.selectedCharacterBinding = binding;
    }
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

// --- セリフ行のページ割当(S3 UI 1) ---

/**
 * セリフ行をページへ割り当てる(placement 作成+吹き出し生成)。lightbox の配置ドロワーと同じ
 * `createDialoguePlacement` を呼ぶが、ここではページ中央固定(panelId 省略)。
 */
export async function assignDialogueLineToPage(lineId: string, pageId: string) {
  if (!pageId) {
    return;
  }
  try {
    await api<CreatePlacementResult>(`/api/dialogue-lines/${lineId}/placements`, {
      method: "POST",
      body: JSON.stringify({ pageId })
    });
    pushToast("セリフをページへ割り当てました。", "info");
  } catch (error) {
    pushToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    requestRender();
  }
}

/** セリフ行のページ割当 <select> の change ハンドラ(main.ts の change 委譲から呼ぶ)。 */
export function handleDialogueLinePageAssignSelect(target: HTMLSelectElement) {
  const lineId = target.dataset.dialogueLineId;
  const pageId = target.value;
  if (lineId && pageId) {
    void assignDialogueLineToPage(lineId, pageId);
    target.value = "";
  }
}

registerActions({
  "open-script-screen": () => void openScriptScreen(),
  "close-script-screen": () => closeScriptScreen(),
  "select-script": (id) => void selectScript(id),
  "import-script": () => void importOrReimportScript(),
  "add-character": () => void addCharacter(),
  "select-character": (id) => void selectCharacter(id),
  "delete-character": () => void deleteSelectedCharacter(),
  "save-character-lora": () => void saveCharacterLora(),
  "toggle-character-face-picker": () => toggleCharacterFacePicker(),
  "use-character-face-recent": (_id, target) => {
    const url = target.dataset.url;
    if (url) {
      void pickCharacterFaceFromRecent(url);
    }
  },
  "clear-character-face-image": () => void clearCharacterFaceImage()
});
