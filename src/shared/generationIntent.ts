import { requiresParentAsset } from "./generationMode";
import type { GenerationRequest, MaskedContent } from "./types";

/**
 * モデル中立の生成意図(Docs/Feature-ScriptToManga.md S1)。「何を作りたいか」を Comfy 固有語彙から
 * 切り離して表現する。steps/cfg/sampler/scheduler は拡散モデル共通語彙として `sampling` に、
 * LoRA・templateId・generationMode のような Comfy 固有値は `styles[].id` / `providerOptions.comfy`
 * へ隔離する。`generation_rounds.intent_json` へ保存され、将来の re-run・別 Provider 実装の入力になる。
 */
export interface GenerationIntent {
  version: 1;
  prompt: { positive: string; negative: string };
  canvas: { width: number; height: number };
  /** 独立ジョブ N 個の意味(1..32)。 */
  batchCount: number;
  seed: { mode: "fixed" | "random" | "increment" | "reuse_parent"; value: number | null };
  /** img2img 系の入力画像(親アセット or ペースト合成済みファイル)。 */
  source?: { imagePath: string; denoise: number } | null;
  inpaint?: { maskPath: string; maskedContent: MaskedContent; padding: number; feather: number } | null;
  /** 構図制御。kind は中立語彙(pose/edge)。 */
  control?: Array<{ kind: "pose" | "edge"; imagePath: string; strength: number; range: [number, number] }>;
  /** 人物同一性の参照(現実装は PuLID 顔参照)。 */
  identity?: { faceImagePath: string } | null;
  /** 絵柄スタイル。id は provider スコープの不透明文字列(Comfy では LoRA choice verbatim)。 */
  styles?: Array<{ id: string; strength: number }>;
  /** 将来: 透過出力の要求。現行 Provider には情報源が無いため常に省略。 */
  output?: { transparent?: boolean };
  /** 生成対象のメタデータ(workflow には注入されない。コマ自動割当に使用)。 */
  target?: { pageId?: string | null; panelId?: string | null };
  /** 助言的サンプリングパラメータ。provider は解釈可能な範囲で使い、無視してよい。 */
  sampling?: { steps?: number; cfg?: number; sampler?: string; scheduler?: string };
  /** provider 固有のエスケープハッチ。comfy: { templateId, generationMode } 等。 */
  providerOptions?: Record<string, unknown>;
}

/**
 * `request`(prepare* 通過後の正規化済み GenerationRequest。dataUrl は既にパス化済み)から
 * `GenerationIntent` を導出する純関数。
 *
 * `target.parentImagePath` は設計書の 2 引数シグネチャ `toGenerationIntent(request, target?)` を保つための
 * 同居フィールド(GenerationIntent 自身の `target` とは別概念)。GenerationRequest は `parentAssetId` しか
 * 持たず実ファイルパスを含まないため、呼び出し側(rounds.ts)が解決済みの親アセット画像パスをここへ渡す。
 * pasteComposite.compositePath があればそちらを優先する。
 */
export function toGenerationIntent(
  request: GenerationRequest,
  target?: { pageId?: string | null; panelId?: string | null; parentImagePath?: string | null }
): GenerationIntent {
  return {
    version: 1,
    prompt: { positive: request.prompt, negative: request.negativePrompt },
    canvas: { width: request.width, height: request.height },
    batchCount: request.batchSize,
    seed: { mode: toIntentSeedMode(request.seedMode), value: request.seed },
    source: resolveSource(request, target?.parentImagePath),
    inpaint: resolveInpaint(request),
    control: resolveControl(request),
    identity: resolveIdentity(request),
    styles: resolveStyles(request),
    target: { pageId: target?.pageId ?? null, panelId: target?.panelId ?? null },
    sampling: { steps: request.steps, cfg: request.cfg, sampler: request.sampler, scheduler: request.scheduler },
    providerOptions: { comfy: { templateId: request.templateId, generationMode: request.generationMode } }
  };
}

function toIntentSeedMode(mode: GenerationRequest["seedMode"]): GenerationIntent["seed"]["mode"] {
  return mode === "reuse_parent_seed" ? "reuse_parent" : mode;
}

function resolveSource(request: GenerationRequest, parentImagePath: string | null | undefined): GenerationIntent["source"] {
  if (!requiresParentAsset(request.generationMode)) {
    return null;
  }
  const imagePath = request.pasteComposite?.compositePath || parentImagePath || null;
  return imagePath ? { imagePath, denoise: request.denoise } : null;
}

function resolveInpaint(request: GenerationRequest): GenerationIntent["inpaint"] {
  const inpaint = request.inpaint;
  if (!inpaint || !inpaint.maskPath) {
    return null;
  }
  return {
    maskPath: inpaint.maskPath,
    maskedContent: inpaint.maskedContent,
    padding: inpaint.onlyMaskedPadding,
    feather: inpaint.featherRadius ?? 0
  };
}

function resolveControl(request: GenerationRequest): GenerationIntent["control"] {
  const controlnet = request.controlnet;
  if (!controlnet || !controlnet.poseImagePath) {
    return [];
  }
  return [
    {
      kind: "pose",
      imagePath: controlnet.poseImagePath,
      strength: controlnet.strength,
      range: [controlnet.startPercent, controlnet.endPercent]
    }
  ];
}

function resolveIdentity(request: GenerationRequest): GenerationIntent["identity"] {
  const reference = request.reference;
  if (!reference?.face?.enabled || !reference.imagePath) {
    return null;
  }
  return { faceImagePath: reference.imagePath };
}

function resolveStyles(request: GenerationRequest): GenerationIntent["styles"] {
  return (request.loras ?? []).map((lora) => ({ id: lora.name, strength: lora.strength }));
}
