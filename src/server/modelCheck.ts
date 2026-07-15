/**
 * 「必要モデルが ComfyUI 側に実際に配置されているか」を確認するロジック。
 * pure な照合部(`matchRequirements`)と IO 部(`checkModels`)を分離し、
 * pure 部のみ単体テストする。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchComfyNodeInfo, getComfySettings } from "./comfy";
import { extractModelRequirements, MODEL_TARGET_DIRS, type FeatureKey, type ModelFamily, type WorkflowModelRequirement } from "../shared/workflowModels";
import { FEATURE_LABELS, FEATURE_MODEL_REQUIREMENTS, FEATURE_NODE_PACKS, type FeatureNodePack } from "./workflowFeatureFragments";
import type { ModelCheckEntry, ModelCheckFeatureStatus, ModelCheckResult } from "../shared/apiTypes";

const REQUIRED_CORE_NODES = ["ComfySwitchNode", "PrimitiveBoolean"] as const;
// Features tracked for togglable availability -- "base" (the 4 always-required models) is
// excluded, it is not something a user can turn on/off.
const TOGGLABLE_FEATURES: Record<ModelFamily, FeatureKey[]> = {
  chroma: ["controlnet", "pulid"],
  anima: ["animaInpaint", "animaControlnet", "animaInContext"]
};

const referencePaths: Record<ModelFamily, string> = {
  chroma: fileURLToPath(new URL("../../Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json", import.meta.url)),
  anima: fileURLToPath(new URL("../../Docs/ReferenceFlows/Reference-AnimaUnifiedSwitchWorkflow.json", import.meta.url))
};

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
    const available = choices == null ? null : matchesRequirement(choices, requirement);

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

function matchesRequirement(choices: string[], requirement: WorkflowModelRequirement): boolean {
  return requirement.matchBasename === false
    ? choices.some((choice) => choice === requirement.name)
    : matchesAny(choices, requirement.name);
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
async function runRawCheck(family: ModelFamily): Promise<RawCheck> {
  const workflow = JSON.parse(readFileSync(referencePaths[family], "utf8"));
  const requirements = [
    ...extractModelRequirements(workflow),
    ...FEATURE_MODEL_REQUIREMENTS.filter((requirement) =>
      family === "anima"
        ? requirement.feature === "animaInpaint" || requirement.feature === "animaControlnet" || requirement.feature === "animaInContext"
        : !requirement.feature.startsWith("anima")
    )
  ];

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
    isNodePackPresent(raw.objectInfoByClass.get(pack.representativeClass), pack)
  );
  const modelsOk = raw.requirements
    .filter((requirement) => requirement.feature === feature)
    .every((requirement) => {
      const choices = raw.choicesByRequirement.get(choiceKey(requirement.loaderClass, requirement.inputName));
      return choices != null && matchesRequirement(choices, requirement);
    });
  return nodePacksOk && modelsOk;
}

/**
 * ComfyUI に接続し、参照ワークフローが要求するモデル/コアノードの在不在を確認する。
 * ComfyUI 未接続でも常に 200 相当の結果を返せるよう、この関数自体は例外を投げない。
 */
export async function checkModels(family: ModelFamily): Promise<ModelCheckResult> {
  const settings = getComfySettings();
  const checkedAt = new Date().toISOString();

  let raw: RawCheck;
  try {
    raw = await runRawCheck(family);
  } catch (error) {
    return {
      family,
      comfy: { ok: false, baseUrl: settings.baseUrl, error: errorMessage(error) },
      nodes: REQUIRED_CORE_NODES.map((classType) => ({ classType, available: false })),
      models: [],
      features: TOGGLABLE_FEATURES[family].map((key) => ({
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

  const features: ModelCheckFeatureStatus[] = TOGGLABLE_FEATURES[family].map((key) => {
    const available = raw.comfyOk ? isFeatureAvailable(raw, key) : null;
    const missingNodePacks = FEATURE_NODE_PACKS[key].filter(
      (pack) => !isNodePackPresent(raw.objectInfoByClass.get(pack.representativeClass), pack)
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
  animaInpaint: boolean;
  animaControlnet: boolean;
  animaInContext: boolean;
}

const FEATURE_AVAILABILITY_CACHE_MS = 10_000;
const cachedAvailability = new Map<ModelFamily, { value: FeatureAvailability; expiresAt: number }>();

/**
 * 生成のたびにフラグメント注入をゲートするための、真偽値のみの可用性。ComfyUI 未接続時は
 * 「未確認」を許容せず安全側に倒して全機能 false を返す(そのラウンド自体どうせ失敗するため)。
 * すべてのラウンドで `/object_info` を叩き直すのを避けるため短い TTL でキャッシュする
 * (手動の「再チェック」`checkModels()` は常に非キャッシュ)。
 */
export async function resolveFeatureAvailability(family: ModelFamily = "chroma"): Promise<FeatureAvailability> {
  const now = Date.now();
  const cached = cachedAvailability.get(family);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let raw: RawCheck;
  try {
    raw = await runRawCheck(family);
  } catch {
    return { controlnet: false, pulid: false, animaInpaint: false, animaControlnet: false, animaInContext: false };
  }

  const value: FeatureAvailability = raw.comfyOk
    ? {
        controlnet: family === "chroma" && isFeatureAvailable(raw, "controlnet"),
        pulid: family === "chroma" && isFeatureAvailable(raw, "pulid"),
        animaInpaint: family === "anima" && isFeatureAvailable(raw, "animaInpaint"),
        animaControlnet: family === "anima" && isFeatureAvailable(raw, "animaControlnet"),
        animaInContext: family === "anima" && isFeatureAvailable(raw, "animaInContext")
      }
    : { controlnet: false, pulid: false, animaInpaint: false, animaControlnet: false, animaInContext: false };

  cachedAvailability.set(family, { value, expiresAt: now + FEATURE_AVAILABILITY_CACHE_MS });
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

/**
 * ノードパックが「正しく」導入されているか。代表クラスの存在(`isNodePresent`)に加えて、
 * `pack.requiredInputs` が指定されていれば、その入力名が全て `/object_info` の input スキーマ
 * (required ∪ optional)に存在することも要求する。同名クラスを登録する別フォークの取り違え
 * (例: PuLID の Chroma fork と簡易 Flux fork。後者は guruguru が送る `prior_image` を持たず、
 * クラス名チェックだけだと通ってしまい実行時に落ちる)を、生成前の可用性判定で弾くための関数。
 */
export function isNodePackPresent(info: unknown, pack: FeatureNodePack): boolean {
  if (!isNodePresent(info, pack.representativeClass)) {
    return false;
  }
  if (!pack.requiredInputs || pack.requiredInputs.length === 0) {
    return true;
  }
  const inputNames = nodeInputNames(info, pack.representativeClass);
  return pack.requiredInputs.every((name) => inputNames.has(name));
}

/** `/object_info/{class}` の `input.required` と `input.optional` に現れる入力名の集合。 */
function nodeInputNames(info: unknown, classType: string): Set<string> {
  const names = new Set<string>();
  if (!info || typeof info !== "object") {
    return names;
  }
  const nodeInfo = (info as Record<string, unknown>)[classType];
  if (!nodeInfo || typeof nodeInfo !== "object") {
    return names;
  }
  const input = (nodeInfo as { input?: unknown }).input;
  if (!input || typeof input !== "object") {
    return names;
  }
  for (const section of [(input as { required?: unknown }).required, (input as { optional?: unknown }).optional]) {
    if (section && typeof section === "object") {
      for (const key of Object.keys(section as Record<string, unknown>)) {
        names.add(key);
      }
    }
  }
  return names;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
