import type { FeatureKey, WorkflowModelRequirement } from "../shared/workflowModels";
import { type JsonObject, getNodeInput, isConnection, isObject, findNodeIdByExactClass, nextNodeId, setNodeInput } from "./workflowGraph";

// Consistent Character (Docs/Feature-ConsistentCharacter.md): optional feature branches
// (Hyper-Chroma low-step LoRA / face-style reference PuLID-Flux / overall-style reference
// IP-Adapter, plus an IP-Adapter-only RMBG background removal step) are NOT baked into the
// persisted Reference-UnifiedSwitchWorkflow.json -- they are spliced into the MODEL chain at
// generation time, only when both (a) the user has actually placed the required model file(s)
// in ComfyUI and (b) the corresponding request-level toggle is on. This keeps the base template
// working unmodified for users who have none of these installed.
//
// Because these fragments never appear in the persisted reference workflow, their required
// model files cannot be discovered by scanning that JSON the way extractModelRequirements()
// discovers the base 4 models / ControlNet model -- FEATURE_MODEL_REQUIREMENTS below is a
// hand-authored, static list instead. Filenames mirror the example workflow this feature set was
// modeled on (see Docs/Feature-ConsistentCharacter.md "Phase 1 実施記録" for the source-verified
// node input names). The LoRA file is expected directly under models/loras (no subfolder) to
// avoid a Windows-vs-POSIX path-separator mismatch against ComfyUI's reported choices list.

const LORA_FILE = "Hyper-Chroma-low-step-LoRA.safetensors";
// v0.9.0 was the version named in the original example workflow (Phase 1), but real-machine
// verification (Phase 5) found the actually-distributed file is v0.9.1 -- updated to match what
// ComfyUI installs actually report today (see Docs/Feature-ConsistentCharacter.md "Phase 5 実施記録").
const PULID_FILE = "pulid_flux_v0.9.1.safetensors";
const IPADAPTER_FILE = "ip_adapter.safetensors";
const CLIP_VISION_FILE = "clip-vit-large-patch14.safetensors";

export const FEATURE_MODEL_REQUIREMENTS: WorkflowModelRequirement[] = [
  { kind: "lora", name: LORA_FILE, loaderClass: "LoraLoaderModelOnly", inputName: "lora_name", feature: "lora" },
  { kind: "pulid", name: PULID_FILE, loaderClass: "PulidFluxModelLoader", inputName: "pulid_file", feature: "pulid" },
  { kind: "ipadapterFlux", name: IPADAPTER_FILE, loaderClass: "LoadFluxIPAdapter", inputName: "ipadatper", feature: "ipadapter" },
  { kind: "clipVision", name: CLIP_VISION_FILE, loaderClass: "LoadFluxIPAdapter", inputName: "clip_vision", feature: "ipadapter" }
];

export interface FeatureNodePack {
  label: string;
  representativeClass: string;
}

/**
 * ノードパック存在検出用の代表クラス(`/object_info/{class}` が `{}` を返せば未導入)。
 * ポーズ(ControlNet)と Hyper LoRA はコアノードのみで完結するため空配列
 * (可用性は FEATURE_MODEL_REQUIREMENTS のモデルファイル照合だけで決まる)。
 */
export const FEATURE_NODE_PACKS: Record<FeatureKey, FeatureNodePack[]> = {
  base: [],
  controlnet: [],
  lora: [],
  pulid: [{ label: "PuLID-Flux (Chroma対応fork, 例: PaoloC68/ComfyUI-PuLID-Flux-Chroma)", representativeClass: "ApplyPulidFlux" }],
  ipadapter: [{ label: "x-flux-comfyui", representativeClass: "ApplyAdvancedFluxIPAdapter" }],
  rmbg: [{ label: "comfyui-easy-use", representativeClass: "easy imageRemBg" }]
};

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  base: "ベース",
  controlnet: "ポーズ(ControlNet)",
  lora: "高速化LoRA(Hyper-Chroma)",
  pulid: "顔スタイル参照(PuLID)",
  ipadapter: "全体スタイル参照(IP-Adapter)",
  rmbg: "IP-Adapter背景除去(RMBG)"
};

export interface FeatureFlags {
  lora: boolean;
  ipadapter: boolean;
  pulid: boolean;
  /** Only meaningful when ipadapter is true; ignored otherwise. */
  rmbg: boolean;
}

function addNode(workflow: JsonObject, node: JsonObject): string {
  const id = nextNodeId(workflow);
  workflow[id] = node;
  return id;
}

/**
 * Splices the enabled optional-feature fragments into the MODEL chain that feeds
 * ModelSamplingAuraFlow, in the same order as the example workflow this feature set was modeled
 * on: UNETLoader -> [LoRA] -> [IP-Adapter apply] -> [PuLID apply] -> ModelSamplingAuraFlow.
 * A no-op when every flag is false (the common case: base txt2img/img2img/inpaint generation).
 *
 * `referenceImageName` must be non-null whenever ipadapter or pulid is enabled -- callers are
 * expected to have already ANDed the request-level toggle with feature availability AND the
 * presence of an uploaded reference image before setting those flags (see
 * patchUnifiedSwitchWorkflow), so reaching this function with a flag on but no image is a
 * programming error, not a user-facing condition.
 */
export function assembleFeatureFragments(
  workflow: JsonObject,
  enabled: FeatureFlags,
  referenceImageName: string | null
): JsonObject {
  if (!enabled.lora && !enabled.ipadapter && !enabled.pulid) {
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
      throw new Error("consistent-character fragments: pulid/ipadapter enabled without a reference image name");
    }
    referenceImageNodeId = addNode(workflow, {
      class_type: "LoadImage",
      inputs: { image: referenceImageName }
    });
    return referenceImageNodeId;
  };

  if (enabled.lora) {
    const loraNodeId = addNode(workflow, {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: modelConnection,
        lora_name: LORA_FILE,
        strength_model: 1.0
      }
    });
    modelConnection = [loraNodeId, 0];
  }

  if (enabled.ipadapter) {
    const loaderNodeId = addNode(workflow, {
      class_type: "LoadFluxIPAdapter",
      inputs: {
        ipadatper: IPADAPTER_FILE,
        clip_vision: CLIP_VISION_FILE,
        provider: "CPU"
      }
    });
    let ipImageConnection: unknown[] = [ensureReferenceImageNode(), 0];
    if (enabled.rmbg) {
      const rmbgNodeId = addNode(workflow, {
        class_type: "easy imageRemBg",
        inputs: {
          images: ipImageConnection,
          rem_mode: "RMBG-1.4",
          image_output: "Preview",
          save_prefix: "ComfyUI",
          torchscript_jit: false,
          add_background: "none",
          refine_foreground: false
        }
      });
      ipImageConnection = [rmbgNodeId, 0];
    }
    const applyNodeId = addNode(workflow, {
      class_type: "ApplyAdvancedFluxIPAdapter",
      inputs: {
        model: modelConnection,
        ip_adapter_flux: [loaderNodeId, 0],
        image: ipImageConnection,
        begin_strength: 0,
        end_strength: 1.0,
        smothing_type: "Linear"
      }
    });
    modelConnection = [applyNodeId, 0];
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
