/**
 * Consistent Character(Docs/Feature-ConsistentCharacter.md)の「スタイル LoRA」枠 controller。
 * 絵柄コントロール用に models/loras の LoRA を複数選択・強度指定して MODEL チェーンへ適用する。
 * 候補は GET /api/comfy/loras(ComfyUI の LoraLoaderModelOnly choices)から取得し、選択は
 * フォームレベルの共有リスト state.loraDraft に持つ。AGENTS.md 規約により data-action は
 * registerActions で登録する。
 */
import type { StyleLoraSelection } from "../shared/types";
import { requestRender, state } from "./appState";
import { registerActions } from "./actionRegistry";
import { persistProjectDraft } from "./draftStore";
import { api } from "./api";

/** 同時適用できるスタイル LoRA の上限(サーバの normalizeStyleLoras / maxStyleLoras と一致させる)。 */
export const MAX_STYLE_LORAS = 4;

let loraChoicesInFlight = false;

/** GET /api/comfy/loras を取得して state.loraChoices を更新する(ComfyUI 未接続時は空一覧)。 */
export async function refreshLoraChoices() {
  if (loraChoicesInFlight) {
    return;
  }
  loraChoicesInFlight = true;
  state.loraChoices = { status: "loading", names: state.loraChoices.names };
  requestRender();
  try {
    const result = await api<{ ok: boolean; loras: string[] }>("/api/comfy/loras");
    state.loraChoices = { status: "ready", names: result.ok ? result.loras : [] };
  } catch {
    state.loraChoices = { status: "error", names: state.loraChoices.names };
  } finally {
    loraChoicesInFlight = false;
    requestRender();
  }
}

/** 送信用: 空名を除いた選択リスト。 */
export function styleLorasForRequest(): StyleLoraSelection[] {
  return state.loraDraft
    .filter((lora) => lora.name.trim() !== "")
    .map((lora) => ({ name: lora.name, strength: lora.strength }));
}

function persist() {
  if (state.currentProjectId) {
    persistProjectDraft(state.currentProjectId);
  }
}

/**
 * 行の select(name)/range(strength)変更を state.loraDraft へ反映する(main.ts の input/change
 * ハンドラから呼ぶ)。スライダーのドラッグを壊さないよう再レンダーはしない(強度の数値表示は
 * data-value-target で汎用更新され、select は native に選択が反映される。永続化は debounce)。
 */
export function updateStyleLoraFromControl(target: HTMLInputElement | HTMLSelectElement) {
  const index = Number(target.dataset.loraIndex);
  const field = target.dataset.loraField;
  if (!Number.isInteger(index) || index < 0 || index >= state.loraDraft.length) {
    return;
  }
  state.loraDraft = state.loraDraft.map((row, i) => {
    if (i !== index) {
      return row;
    }
    if (field === "name") {
      return { ...row, name: target.value };
    }
    if (field === "strength") {
      const value = Number(target.value);
      return { ...row, strength: Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : row.strength };
    }
    return row;
  });
  persist();
}

function loraIndexFromTarget(target: HTMLElement): number {
  const holder = target.dataset.loraIndex != null ? target : target.closest<HTMLElement>("[data-lora-index]");
  return Number(holder?.dataset.loraIndex);
}

registerActions({
  "add-style-lora": () => {
    if (state.loraDraft.length >= MAX_STYLE_LORAS) {
      return;
    }
    const firstChoice = state.loraChoices.names[0] ?? "";
    state.loraDraft = [...state.loraDraft, { name: firstChoice, strength: 1 }];
    persist();
    requestRender();
  },
  "remove-style-lora": (_id, target) => {
    const index = loraIndexFromTarget(target);
    if (!Number.isInteger(index)) {
      return;
    }
    state.loraDraft = state.loraDraft.filter((_, i) => i !== index);
    persist();
    requestRender();
  }
});
