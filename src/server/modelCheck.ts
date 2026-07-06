/**
 * 「必要モデルが ComfyUI 側に実際に配置されているか」を確認するロジック。
 * pure な照合部(`matchRequirements`)と IO 部(`checkModels`)を分離し、
 * pure 部のみ単体テストする。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchComfyNodeInfo, getComfySettings } from "./comfy";
import { extractModelRequirements, MODEL_TARGET_DIRS, type WorkflowModelRequirement } from "../shared/workflowModels";
import type { ModelCheckEntry, ModelCheckResult } from "../shared/apiTypes";

const REQUIRED_CORE_NODES = ["ComfySwitchNode", "PrimitiveBoolean"] as const;

const referencePath = fileURLToPath(
  new URL("../../Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.json", import.meta.url)
);

/**
 * 各 requirement を `choicesByLoaderClass`(loaderClass → ComfyUI の choices 配列。
 * `null` は choices 取得不能=ノード不在または ComfyUI 未接続)と突き合わせる。
 * 一致判定は完全一致 or basename 一致(`/` `\` どちらのセパレータも対応)。
 */
export function matchRequirements(
  requirements: WorkflowModelRequirement[],
  choicesByLoaderClass: Map<string, string[] | null>
): ModelCheckEntry[] {
  return requirements.map((requirement) => {
    const choices = choicesByLoaderClass.get(requirement.loaderClass);
    const available = choices == null ? null : matchesAny(choices, requirement.name);

    return {
      kind: requirement.kind,
      name: requirement.name,
      loaderClass: requirement.loaderClass,
      inputName: requirement.inputName,
      targetDir: MODEL_TARGET_DIRS[requirement.kind],
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

/**
 * ComfyUI に接続し、参照ワークフローが要求するモデル/コアノードの在不在を確認する。
 * ComfyUI 未接続でも常に 200 相当の結果を返せるよう、この関数自体は例外を投げない。
 */
export async function checkModels(family: "chroma"): Promise<ModelCheckResult> {
  const settings = getComfySettings();
  const checkedAt = new Date().toISOString();

  let requirements: WorkflowModelRequirement[];
  try {
    const workflow = JSON.parse(readFileSync(referencePath, "utf8"));
    requirements = extractModelRequirements(workflow);
  } catch (error) {
    return {
      family,
      comfy: { ok: false, baseUrl: settings.baseUrl, error: errorMessage(error) },
      nodes: REQUIRED_CORE_NODES.map((classType) => ({ classType, available: false })),
      models: [],
      checkedAt
    };
  }

  const loaderClasses = [...new Set(requirements.map((r) => r.loaderClass))];
  const targetClasses = [...new Set([...loaderClasses, ...REQUIRED_CORE_NODES])];

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

  const choicesByLoaderClass = new Map<string, string[] | null>();
  for (const loaderClass of loaderClasses) {
    const requirement = requirements.find((r) => r.loaderClass === loaderClass);
    const info = comfyOk ? objectInfoByClass.get(loaderClass) : null;
    choicesByLoaderClass.set(
      loaderClass,
      comfyOk ? extractChoices(info, loaderClass, requirement?.inputName) : null
    );
  }

  const models = matchRequirements(requirements, choicesByLoaderClass);

  const nodes = REQUIRED_CORE_NODES.map((classType) => {
    const info = objectInfoByClass.get(classType);
    return {
      classType,
      available: isNodePresent(info, classType)
    };
  });

  return {
    family,
    comfy: comfyOk
      ? { ok: true, baseUrl: settings.baseUrl }
      : { ok: false, baseUrl: settings.baseUrl, error: "ComfyUI に接続できませんでした" },
    nodes,
    models,
    checkedAt
  };
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
