/**
 * 「必要モデルが ComfyUI 側に実際に配置されているか」を確認するロジック。
 * pure な照合部(`matchRequirements`)と IO 部(`checkModels`)を分離し、
 * pure 部のみ単体テストする。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchComfyNodeInfo, getComfySettings } from "./comfy";
import { extractModelRequirements, MODEL_TARGET_DIRS, type FeatureKey, type WorkflowModelRequirement } from "../shared/workflowModels";
import { FEATURE_LABELS, FEATURE_MODEL_REQUIREMENTS, FEATURE_NODE_PACKS } from "./workflowFeatureFragments";
import type { ModelCheckEntry, ModelCheckFeatureStatus, ModelCheckResult } from "../shared/apiTypes";

const REQUIRED_CORE_NODES = ["ComfySwitchNode", "PrimitiveBoolean"] as const;
// Features tracked for togglable availability -- "base" (the 4 always-required models) is
// excluded, it is not something a user can turn on/off.
const TOGGLABLE_FEATURES: FeatureKey[] = ["controlnet", "pulid"];

const referencePath = fileURLToPath(
  new URL("../../Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json", import.meta.url)
);

/**
 * 各 requirement を `choicesByRequirement`(`loaderClass::inputName` 複合キー → ComfyUI の
 * choices 配列。`null` は choices 取得不能=ノード不在または ComfyUI 未接続)と突き合わせる。
 * 複合キーなのは、LoadFluxIPAdapter のように同じ loaderClass が異なる入力名(`ipadatper` /
 * `clip_vision`)で2つのモデルファイルを要求するケースで、片方の choices をもう片方に
 * 誤って使い回さないため。一致判定は完全一致 or basename 一致(`/` `\` どちらのセパレータも対応)。
 */
export function matchRequirements(
  requirements: WorkflowModelRequirement[],
  choicesByRequirement: Map<string, string[] | null>
): ModelCheckEntry[] {
  return requirements.map((requirement) => {
    const choices = choicesByRequirement.get(choiceKey(requirement.loaderClass, requirement.inputName));
    const available = choices == null ? null : matchesAny(choices, requirement.name);

    return {
      kind: requirement.kind,
      name: requirement.name,
      loaderClass: requirement.loaderClass,
      inputName: requirement.inputName,
      targetDir: MODEL_TARGET_DIRS[requirement.kind],
      feature: requirement.feature,
      available
    };
  });
}

function matchesAny(choices: string[], name: string): boolean {
  return choices.some((choice) => choice === name || basenameOf(choice) === basenameOf(name));
}

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

function choiceKey(loaderClass: string, inputName: string): string {
  return `${loaderClass}::${inputName}`;
}

interface RawCheck {
  comfyOk: boolean;
  requirements: WorkflowModelRequirement[];
  objectInfoByClass: Map<string, unknown | null>;
  choicesByRequirement: Map<string, string[] | null>;
}

const NODE_PACK_CLASSES = [...new Set(Object.values(FEATURE_NODE_PACKS).flatMap((packs) => packs.map((p) => p.representativeClass)))];

/**
 * ComfyUI へ接続し、参照ワークフロー(base 4モデル + ControlNet)と、任意機能
 * (`FEATURE_MODEL_REQUIREMENTS`/`FEATURE_NODE_PACKS`)双方の在不在を1回の `/object_info`
 * 走査でまとめて確認する共通部。`checkModels`(UI向け表示)と `resolveFeatureAvailability`
 * (生成時のフラグメント注入ゲート)の両方がこれを使う。例外を投げず、取得不能時は
 * `comfyOk: false` を返す。
 */
async function runRawCheck(): Promise<RawCheck> {
  const workflow = JSON.parse(readFileSync(referencePath, "utf8"));
  const requirements = [...extractModelRequirements(workflow), ...FEATURE_MODEL_REQUIREMENTS];

  const loaderClasses = [...new Set(requirements.map((r) => r.loaderClass))];
  const targetClasses = [...new Set([...loaderClasses, ...REQUIRED_CORE_NODES, ...NODE_PACK_CLASSES])];

  const objectInfoByClass = new Map<string, unknown | null>();
  await Promise.all(
    targetClasses.map(async (classType) => {
      try {
        objectInfoByClass.set(classType, await fetchComfyNodeInfo(classType));
      } catch {
        objectInfoByClass.set(classType, null);
      }
    })
  );

  const comfyOk = [...objectInfoByClass.values()].some((info) => info !== null);

  const requirementKeys = [...new Set(requirements.map((r) => choiceKey(r.loaderClass, r.inputName)))];
  const choicesByRequirement = new Map<string, string[] | null>();
  for (const key of requirementKeys) {
    const requirement = requirements.find((r) => choiceKey(r.loaderClass, r.inputName) === key)!;
    const info = comfyOk ? objectInfoByClass.get(requirement.loaderClass) : null;
    choicesByRequirement.set(key, comfyOk ? extractChoices(info, requirement.loaderClass, requirement.inputName) : null);
  }

  return { comfyOk, requirements, objectInfoByClass, choicesByRequirement };
}

function isFeatureAvailable(raw: RawCheck, feature: FeatureKey): boolean {
  const nodePacksOk = FEATURE_NODE_PACKS[feature].every((pack) =>
    isNodePresent(raw.objectInfoByClass.get(pack.representativeClass), pack.representativeClass)
  );
  const modelsOk = raw.requirements
    .filter((requirement) => requirement.feature === feature)
    .every((requirement) => {
      const choices = raw.choicesByRequirement.get(choiceKey(requirement.loaderClass, requirement.inputName));
      return choices != null && matchesAny(choices, requirement.name);
    });
  return nodePacksOk && modelsOk;
}

/**
 * ComfyUI に接続し、参照ワークフローが要求するモデル/コアノードの在不在を確認する。
 * ComfyUI 未接続でも常に 200 相当の結果を返せるよう、この関数自体は例外を投げない。
 */
export async function checkModels(family: "chroma"): Promise<ModelCheckResult> {
  const settings = getComfySettings();
  const checkedAt = new Date().toISOString();

  let raw: RawCheck;
  try {
    raw = await runRawCheck();
  } catch (error) {
    return {
      family,
      comfy: { ok: false, baseUrl: settings.baseUrl, error: errorMessage(error) },
      nodes: REQUIRED_CORE_NODES.map((classType) => ({ classType, available: false })),
      models: [],
      features: TOGGLABLE_FEATURES.map((key) => ({
        key,
        label: FEATURE_LABELS[key],
        available: null,
        requiredNodePacks: FEATURE_NODE_PACKS[key],
        missingNodePacks: FEATURE_NODE_PACKS[key]
      })),
      checkedAt
    };
  }

  const models = matchRequirements(raw.requirements, raw.choicesByRequirement);

  const nodes = REQUIRED_CORE_NODES.map((classType) => ({
    classType,
    available: isNodePresent(raw.objectInfoByClass.get(classType), classType)
  }));

  const features: ModelCheckFeatureStatus[] = TOGGLABLE_FEATURES.map((key) => {
    const available = raw.comfyOk ? isFeatureAvailable(raw, key) : null;
    const missingNodePacks = FEATURE_NODE_PACKS[key].filter(
      (pack) => !isNodePresent(raw.objectInfoByClass.get(pack.representativeClass), pack.representativeClass)
    );
    return {
      key,
      label: FEATURE_LABELS[key],
      available,
      requiredNodePacks: FEATURE_NODE_PACKS[key],
      missingNodePacks: raw.comfyOk ? missingNodePacks : FEATURE_NODE_PACKS[key]
    };
  });

  return {
    family,
    comfy: raw.comfyOk
      ? { ok: true, baseUrl: settings.baseUrl }
      : { ok: false, baseUrl: settings.baseUrl, error: "ComfyUI に接続できませんでした" },
    nodes,
    models,
    features,
    checkedAt
  };
}

/**
 * 生成フォームの「スタイル LoRA」枠が選ばせる LoRA 一覧。ComfyUI の LoraLoaderModelOnly が
 * 報告する choices(サブフォルダ込みの実ファイル名)をそのまま返す。ComfyUI 未接続/ノード不在時は
 * `ok: false` + 空配列(この関数自体は例外を投げない)。
 */
export async function listAvailableLoras(): Promise<{ ok: boolean; loras: string[] }> {
  try {
    const info = await fetchComfyNodeInfo("LoraLoaderModelOnly");
    const choices = extractChoices(info, "LoraLoaderModelOnly", "lora_name");
    return choices == null ? { ok: false, loras: [] } : { ok: true, loras: choices };
  } catch {
    return { ok: false, loras: [] };
  }
}

export interface FeatureAvailability {
  controlnet: boolean;
  pulid: boolean;
}

const FEATURE_AVAILABILITY_CACHE_MS = 10_000;
let cachedAvailability: { value: FeatureAvailability; expiresAt: number } | null = null;

/**
 * 生成のたびにフラグメント注入をゲートするための、真偽値のみの可用性。ComfyUI 未接続時は
 * 「未確認」を許容せず安全側に倒して全機能 false を返す(そのラウンド自体どうせ失敗するため)。
 * すべてのラウンドで `/object_info` を叩き直すのを避けるため短い TTL でキャッシュする
 * (手動の「再チェック」`checkModels()` は常に非キャッシュ)。
 */
export async function resolveFeatureAvailability(): Promise<FeatureAvailability> {
  const now = Date.now();
  if (cachedAvailability && cachedAvailability.expiresAt > now) {
    return cachedAvailability.value;
  }

  let raw: RawCheck;
  try {
    raw = await runRawCheck();
  } catch {
    return { controlnet: false, pulid: false };
  }

  const value: FeatureAvailability = raw.comfyOk
    ? {
        controlnet: isFeatureAvailable(raw, "controlnet"),
        pulid: isFeatureAvailable(raw, "pulid")
      }
    : { controlnet: false, pulid: false };

  cachedAvailability = { value, expiresAt: now + FEATURE_AVAILABILITY_CACHE_MS };
  return value;
}

function extractChoices(info: unknown, classType: string, inputName: string | undefined): string[] | null {
  if (!inputName || !info || typeof info !== "object") {
    return null;
  }

  const nodeInfo = (info as Record<string, unknown>)[classType];
  if (!nodeInfo || typeof nodeInfo !== "object") {
    return null;
  }

  const input = (nodeInfo as { input?: unknown }).input;
  if (!input || typeof input !== "object") {
    return null;
  }

  const required = (input as { required?: unknown }).required;
  const optional = (input as { optional?: unknown }).optional;

  const fromRequired = extractChoicesFromSection(required, inputName);
  if (fromRequired) {
    return fromRequired;
  }
  return extractChoicesFromSection(optional, inputName);
}

function extractChoicesFromSection(section: unknown, inputName: string): string[] | null {
  if (!section || typeof section !== "object") {
    return null;
  }
  const entry = (section as Record<string, unknown>)[inputName];
  if (!Array.isArray(entry)) {
    return null;
  }
  const choices = entry[0];
  if (!Array.isArray(choices) || !choices.every((c) => typeof c === "string")) {
    return null;
  }
  return choices;
}

function isNodePresent(info: unknown, classType: string): boolean {
  if (!info || typeof info !== "object") {
    return false;
  }
  return classType in (info as Record<string, unknown>);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
