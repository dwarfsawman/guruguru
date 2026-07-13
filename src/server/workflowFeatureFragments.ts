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

/**
 * Anima In-Context Character PoC (darask0/Anima-InContext-Character).
 * The adapter is intentionally injected dynamically rather than baked into the persisted Anima
 * template: users without the experimental node pack/model can keep using the base preset.
 */
export const ANIMA_IN_CONTEXT_LORA_FILE = "anima-incontext-character.safetensors";

/** Adapter model contract used by modelCheck.ts's family-specific availability gate. */
export const ANIMA_IN_CONTEXT_MODEL_REQUIREMENTS: WorkflowModelRequirement[] = [
  {
    kind: "lora",
    name: ANIMA_IN_CONTEXT_LORA_FILE,
    loaderClass: "LoraLoaderModelOnly",
    inputName: "lora_name",
    feature: "animaInContext",
    // The dynamic fragment sends this exact root-level ComfyUI choice. A basename-only match to a
    // subfolder choice would report available and then fail graph validation at queue time.
    matchBasename: false
  }
] as const;

export const FEATURE_MODEL_REQUIREMENTS: WorkflowModelRequirement[] = [
  { kind: "pulid", name: PULID_FILE, loaderClass: "PulidFluxModelLoader", inputName: "pulid_file", feature: "pulid" },
  ...ANIMA_IN_CONTEXT_MODEL_REQUIREMENTS
];

export interface FeatureNodePack {
  label: string;
  representativeClass: string;
  /**
   * 代表クラス名の存在だけでなく、これらの入力名が `/object_info` の input スキーマ
   * (required ∪ optional)に全て存在することも要求する。同じクラス名を登録する別フォークの
   * 取り違えを生成前に弾くための判別キー。例: `ApplyPulidFlux` は Chroma 対応 fork
   * (PaoloC68/ComfyUI-PuLID-Flux-Chroma)と簡易 Flux fork(lldacing/ComfyUI_PuLID_Flux_ll)が
   * 同名クラスを登録するが、guruguru が送る `prior_image`/`fusion`/`train_step`/`use_gray`
   * (assembleFeatureFragments の ApplyPulidFlux inputs)は Chroma fork にしか無い。簡易版が
   * 入っている(またはクラス名衝突でロード順の後勝ちにより簡易版が優先された)場合、クラス名は
   * 通っても実行時に `unexpected keyword argument 'prior_image'` で落ちる。`prior_image` の
   * 有無で判別する。未指定なら従来どおりクラス名の存在のみで判定。
   */
  requiredInputs?: string[];
  /** 未導入(または別フォーク取り違え)を検知したとき UI で案内するインストール手順 URL。 */
  installUrl?: string;
}

/**
 * `/object_info` contracts for the experimental Anima node pack. These are exported separately
 * for the same compatibility reason as ANIMA_IN_CONTEXT_MODEL_REQUIREMENTS above.
 */
export const ANIMA_IN_CONTEXT_NODE_PACKS: FeatureNodePack[] = [
  {
    label: "Anima In-Context Character (reference encode)",
    representativeClass: "AnimaRefEncode",
    requiredInputs: ["vae", "image", "target_width", "target_height"],
    installUrl: "https://huggingface.co/darask0/Anima-InContext-Character/tree/main/comfyui-anima-incontext"
  },
  {
    label: "Anima In-Context Character (reference latent batch)",
    representativeClass: "AnimaRefLatentBatch",
    requiredInputs: ["ref_latent_1", "ref_latent_2", "fit_mode"],
    installUrl: "https://huggingface.co/darask0/Anima-InContext-Character/tree/main/comfyui-anima-incontext"
  },
  {
    label: "Anima In-Context Character (apply)",
    representativeClass: "AnimaInContextApply",
    requiredInputs: ["model", "ref_latent", "strength", "start_percent", "end_percent", "cond_only", "fit_mode", "ref_timestep"],
    installUrl: "https://huggingface.co/darask0/Anima-InContext-Character/tree/main/comfyui-anima-incontext"
  }
];

/**
 * ノードパック存在検出用の代表クラス(`/object_info/{class}` が `{}` を返せば未導入)。
 * ポーズ(ControlNet)はコアノードのみで完結するため空配列(可用性は ControlNet モデルの
 * 有無だけで決まる)。
 */
export const FEATURE_NODE_PACKS: Record<FeatureKey, FeatureNodePack[]> = {
  base: [],
  controlnet: [],
  pulid: [
    {
      label: "PuLID-Flux (Chroma対応fork, 例: PaoloC68/ComfyUI-PuLID-Flux-Chroma)",
      representativeClass: "ApplyPulidFlux",
      requiredInputs: ["prior_image"],
      installUrl: "https://comfy.icu/extension/PaoloC68__ComfyUI-PuLID-Flux-Chroma"
    }
  ],
  animaInContext: ANIMA_IN_CONTEXT_NODE_PACKS
};

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  base: "ベース",
  controlnet: "ポーズ(ControlNet)",
  pulid: "顔スタイル参照(PuLID)",
  animaInContext: "キャラクター参照(Anima In-Context・実験)"
};

export interface FeatureFlags {
  pulid: boolean;
  /** Experimental Anima reference-latent conditioning. Optional for caller compatibility. */
  animaInContext?: boolean;
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
  loras: ReadonlyArray<StyleLoraSelection> = [],
  animaOptions: {
    width?: number;
    height?: number;
    strength?: number;
    startPercent?: number;
    endPercent?: number;
  } = {}
): JsonObject {
  if (loras.length === 0 && !enabled.pulid && !enabled.animaInContext) {
    return workflow;
  }

  if (enabled.pulid && enabled.animaInContext) {
    throw new Error("PuLID and Anima In-Context cannot be enabled in the same workflow");
  }

  const modelSamplingNodeId = findNodeIdByExactClass(workflow, "ModelSamplingAuraFlow");
  const guiderNodeId = findNodeIdByExactClass(workflow, "CFGGuider");
  const anchorNodeId = modelSamplingNodeId ?? guiderNodeId;
  if (!anchorNodeId) {
    throw new Error("model fragments require a ModelSamplingAuraFlow or CFGGuider model input in the base template");
  }
  const initialModelConnection = getNodeInput(workflow, anchorNodeId, ["model"]);
  if (!isConnection(initialModelConnection)) {
    throw new Error("model fragments require the base model input to already be wired");
  }

  let animaVaeNodeId: string | null = null;
  if (enabled.animaInContext) {
    if (modelSamplingNodeId) {
      throw new Error("Anima In-Context is only supported by the Anima direct model chain");
    }
    if (!referenceImageName) {
      throw new Error("consistent-character fragments: Anima In-Context enabled without a reference image name");
    }
    animaVaeNodeId = findNodeIdByExactClass(workflow, "VAELoader");
    if (!animaVaeNodeId) {
      throw new Error("Anima In-Context requires a VAELoader in the base template");
    }
  }

  // Chroma has a single insertion point before ModelSamplingAuraFlow. Anima has no sampling
  // patch node, so CFGGuider and both BasicScheduler nodes consume the UNET directly and must all
  // be rewired to the same LoRA chain.
  const modelTargets = modelSamplingNodeId
    ? [modelSamplingNodeId]
    : Object.entries(workflow)
        .filter(([, rawNode]) =>
          isObject(rawNode) && isObject(rawNode.inputs) && sameConnection(rawNode.inputs.model, initialModelConnection)
        )
        .map(([nodeId]) => nodeId);

  let modelConnection: unknown[] = [...initialModelConnection];
  let referenceImageNodeId: string | null = null;
  const ensureReferenceImageNode = (): string => {
    if (referenceImageNodeId) {
      return referenceImageNodeId;
    }
    if (!referenceImageName) {
      throw new Error("consistent-character fragments: identity reference enabled without a reference image name");
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
    if (!modelSamplingNodeId) {
      throw new Error("PuLID-Flux is only supported by the Chroma ModelSamplingAuraFlow preset");
    }
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

  if (enabled.animaInContext) {
    // The dedicated adapter must be the last LoRA before the model patch, matching the published
    // reference workflow: UNET -> [user LoRAs] -> adapter LoRA -> AnimaInContextApply.
    const adapterNodeId = addNode(workflow, {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: modelConnection,
        lora_name: ANIMA_IN_CONTEXT_LORA_FILE,
        strength_model: 1.0
      }
    });
    const refImageNodeId = ensureReferenceImageNode();
    const refEncodeNodeId = addNode(workflow, {
      class_type: "AnimaRefEncode",
      inputs: {
        vae: [animaVaeNodeId!, 0],
        image: [refImageNodeId, 0],
        ...(animaOptions.width ? { target_width: animaOptions.width } : {}),
        ...(animaOptions.height ? { target_height: animaOptions.height } : {})
      }
    });
    const applyNodeId = addNode(workflow, {
      class_type: "AnimaInContextApply",
      inputs: {
        model: [adapterNodeId, 0],
        ref_latent: [refEncodeNodeId, 0],
        strength: animaOptions.strength ?? 1.0,
        start_percent: animaOptions.startPercent ?? 0.0,
        end_percent: animaOptions.endPercent ?? 1.0,
        cond_only: true,
        fit_mode: "pad",
        ref_timestep: 0.0
      }
    });
    modelConnection = [applyNodeId, 0];
  }

  for (const nodeId of modelTargets) {
    setNodeInput(workflow, nodeId, ["model"], modelConnection);
  }
  return workflow;
}

function sameConnection(value: unknown, expected: unknown[]): boolean {
  return isConnection(value) && value[0] === expected[0] && value[1] === expected[1];
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
