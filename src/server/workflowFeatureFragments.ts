import type { FeatureKey, WorkflowModelRequirement } from "../shared/workflowModels";
import type { StyleLoraSelection } from "../shared/types";
import { type JsonObject, getNodeInput, isConnection, isObject, findNodeIdByExactClass, nextNodeId, setNodeInput } from "./workflowGraph";

// Consistent Character (Docs/Feature-ConsistentCharacter.md): optional MODEL-chain additions
// (user-selected style/character LoRAs / face-style reference PuLID-Flux) are NOT baked into the
// persisted Reference-UnifiedSwitchWorkflow.json -- they are spliced into the MODEL chain at
// generation time. Style LoRAs come from the request (the user picks them from ComfyUI's actual
// LoraLoaderModelOnly choices, so the exact name -- subfolder path included -- is used verbatim);
// PuLID additionally needs its request toggle + an uploaded reference image. The base template
// stays untouched for users who select none.
//
// (Overall-style reference / IP-Adapter and its RMBG step, plus the old auto Hyper-Chroma LoRA,
// were dropped. IP-Adapter (x-flux) patches Flux-only DoubleStreamBlock.img_mod which ComfyUI's
// native Chroma removes, so it cannot run on the Chroma base; art-style control moved to
// user-selected LoRAs instead -- see Docs/Feature-ConsistentCharacter.md.)
//
// PuLID's own model file is surfaced to the model-check via FEATURE_MODEL_REQUIREMENTS below (a
// hand-authored static list, since PuLID's loader never appears in the persisted base JSON).

// v0.9.0 was the version named in the original example workflow (Phase 1), but real-machine
// verification (Phase 5) found the actually-distributed file is v0.9.1 -- updated to match what
// ComfyUI installs actually report today (see Docs/Feature-ConsistentCharacter.md "Phase 5 実施記録").
const PULID_FILE = "pulid_flux_v0.9.1.safetensors";

export const FEATURE_MODEL_REQUIREMENTS: WorkflowModelRequirement[] = [
  { kind: "pulid", name: PULID_FILE, loaderClass: "PulidFluxModelLoader", inputName: "pulid_file", feature: "pulid" }
];

export interface FeatureNodePack {
  label: string;
  representativeClass: string;
}

/**
 * ノードパック存在検出用の代表クラス(`/object_info/{class}` が `{}` を返せば未導入)。
 * ポーズ(ControlNet)はコアノードのみで完結するため空配列(可用性は ControlNet モデルの
 * 有無だけで決まる)。
 */
export const FEATURE_NODE_PACKS: Record<FeatureKey, FeatureNodePack[]> = {
  base: [],
  controlnet: [],
  pulid: [{ label: "PuLID-Flux (Chroma対応fork, 例: PaoloC68/ComfyUI-PuLID-Flux-Chroma)", representativeClass: "ApplyPulidFlux" }]
};

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  base: "ベース",
  controlnet: "ポーズ(ControlNet)",
  pulid: "顔スタイル参照(PuLID)"
};

export interface FeatureFlags {
  pulid: boolean;
}

function addNode(workflow: JsonObject, node: JsonObject): string {
  const id = nextNodeId(workflow);
  workflow[id] = node;
  return id;
}

/**
 * Splices the optional MODEL-chain additions into the chain that feeds ModelSamplingAuraFlow, in
 * the order: UNETLoader -> [style LoRAs...] -> [PuLID apply] -> ModelSamplingAuraFlow.
 * A no-op when no LoRAs are requested and PuLID is off (the common case: base generation).
 *
 * `loras` is the ordered user selection (each name is a verbatim ComfyUI LoraLoaderModelOnly
 * choice, subfolder path included). `referenceImageName` must be non-null whenever pulid is
 * enabled -- callers AND the request toggle with feature availability AND the presence of an
 * uploaded reference image before setting `enabled.pulid` (see patchUnifiedSwitchWorkflow), so
 * reaching this function with pulid on but no image is a programming error.
 */
export function assembleFeatureFragments(
  workflow: JsonObject,
  enabled: FeatureFlags,
  referenceImageName: string | null,
  loras: ReadonlyArray<StyleLoraSelection> = []
): JsonObject {
  if (loras.length === 0 && !enabled.pulid) {
    return workflow;
  }

  const modelSamplingNodeId = findNodeIdByExactClass(workflow, "ModelSamplingAuraFlow");
  if (!modelSamplingNodeId) {
    throw new Error("consistent-character fragments require a ModelSamplingAuraFlow node in the base template");
  }
  const initialModelConnection = getNodeInput(workflow, modelSamplingNodeId, ["model"]);
  if (!isConnection(initialModelConnection)) {
    throw new Error("consistent-character fragments require ModelSamplingAuraFlow.model to already be wired");
  }

  let modelConnection: unknown[] = [...initialModelConnection];
  let referenceImageNodeId: string | null = null;
  const ensureReferenceImageNode = (): string => {
    if (referenceImageNodeId) {
      return referenceImageNodeId;
    }
    if (!referenceImageName) {
      throw new Error("consistent-character fragments: pulid enabled without a reference image name");
    }
    referenceImageNodeId = addNode(workflow, {
      class_type: "LoadImage",
      inputs: { image: referenceImageName }
    });
    return referenceImageNodeId;
  };

  for (const lora of loras) {
    const loraNodeId = addNode(workflow, {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: modelConnection,
        lora_name: lora.name,
        strength_model: lora.strength
      }
    });
    modelConnection = [loraNodeId, 0];
  }

  if (enabled.pulid) {
    const modelLoaderNodeId = addNode(workflow, {
      class_type: "PulidFluxModelLoader",
      inputs: { pulid_file: PULID_FILE }
    });
    const evaClipNodeId = addNode(workflow, { class_type: "PulidFluxEvaClipLoader", inputs: {} });
    const faceAnalysisNodeId = addNode(workflow, {
      class_type: "PulidFluxInsightFaceLoader",
      inputs: { provider: "CPU" }
    });
    const refImageNodeId = ensureReferenceImageNode();
    const applyNodeId = addNode(workflow, {
      class_type: "ApplyPulidFlux",
      inputs: {
        model: modelConnection,
        pulid_flux: [modelLoaderNodeId, 0],
        eva_clip: [evaClipNodeId, 0],
        face_analysis: [faceAnalysisNodeId, 0],
        image: [refImageNodeId, 0],
        prior_image: [refImageNodeId, 0],
        weight: 1.0,
        start_at: 0.2,
        end_at: 0.8,
        fusion: "train_weight",
        fusion_weight_max: 1,
        fusion_weight_min: 0,
        train_step: 8000,
        use_gray: true
      }
    });
    modelConnection = [applyNodeId, 0];
  }

  setNodeInput(workflow, modelSamplingNodeId, ["model"], modelConnection);
  return workflow;
}

/**
 * Removes the ControlNet branch entirely (the switch nodes, ControlNetApplyAdvanced, its
 * ControlNetLoader and control-image LoadImage, and the use-controlnet PrimitiveBoolean) and
 * rewires CFGGuider.positive/negative directly to the plain CLIPTextEncode nodes. Used when the
 * ControlNet model file is not installed: since it is otherwise hard-baked into the base
 * template, leaving it in place would make ComfyUI reject the *entire* prompt (graph-wide
 * choices validation, see Docs/ReferenceFlows/Reference-UnifiedSwitchWorkflow.md) even for plain
 * txt2img/img2img generations that never touch ControlNet.
 *
 * A no-op (returns `roles` unchanged) when the template has no ControlNet branch at all.
 */
export function pruneControlNetBranch<
  T extends {
    guiderNodeId: string | null;
    positivePromptNodeId: string | null;
    negativePromptNodeId: string | null;
    useControlNetBoolNodeId: string | null;
    controlNetApplyNodeId: string | null;
    controlLoadImageNodeId: string | null;
  }
>(workflow: JsonObject, roles: T): T {
  if (!roles.guiderNodeId || !roles.positivePromptNodeId || !roles.useControlNetBoolNodeId || !roles.controlNetApplyNodeId) {
    return roles;
  }

  const positiveSwitchNodeId = sourceNodeId(workflow, roles.guiderNodeId, "positive");
  const negativeSwitchNodeId = sourceNodeId(workflow, roles.guiderNodeId, "negative");
  const controlNetLoaderNodeId = sourceNodeId(workflow, roles.controlNetApplyNodeId, "control_net");

  setNodeInput(workflow, roles.guiderNodeId, ["positive"], [roles.positivePromptNodeId, 0]);
  if (roles.negativePromptNodeId) {
    setNodeInput(workflow, roles.guiderNodeId, ["negative"], [roles.negativePromptNodeId, 0]);
  }

  for (const nodeId of [
    positiveSwitchNodeId,
    negativeSwitchNodeId,
    roles.controlNetApplyNodeId,
    roles.controlLoadImageNodeId,
    controlNetLoaderNodeId,
    roles.useControlNetBoolNodeId
  ]) {
    if (nodeId) {
      delete workflow[nodeId];
    }
  }

  return {
    ...roles,
    useControlNetBoolNodeId: null,
    controlNetApplyNodeId: null,
    controlLoadImageNodeId: null
  };
}

function sourceNodeId(workflow: JsonObject, nodeId: string, inputName: string): string | null {
  const connection = getNodeInput(workflow, nodeId, [inputName]);
  if (!isConnection(connection)) {
    return null;
  }
  const sourceId = connection[0];
  return typeof sourceId === "string" && isObject(workflow[sourceId]) ? sourceId : null;
}
