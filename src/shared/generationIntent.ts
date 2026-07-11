import type { GenerationRequest, MaskedContent } from "./types";

/**
 * 永続可能な成果物参照(Docs/Feature-ScriptToManga.md S1 v2)。共有の GenerationIntent に
 * ローカルファイルパスを直接置かない(intent_json への秘密・絶対パス混入を防ぐ)。
 * 実ファイルパスへの解決は server 専用の `resolveIntentArtifacts`(providers/types.ts)が行う。
 */
export type ArtifactRef =
  | { kind: "asset"; assetId: string }
  | { kind: "roundAttachment"; roundId: string; attachment: "mask" | "pose" | "reference" | "composite" }
  | { kind: "characterBinding"; characterId: string; providerId: string; role: "face" }
  | { kind: "pageMedia"; mediaId: string }; // S2 で導入(前景画像等)。S1 では構築されない。

export type GenerationTask = "create" | "transform" | "inpaint" | "upscale" | "detail";

/** 出力の割り当て先(構図情報ではない。構図は F4 の CompositionSpec)。 */
export type GenerationTarget =
  | { kind: "project" }
  | { kind: "page"; pageId: string }
  | { kind: "panel"; pageId: string; panelId: string }
  | { kind: "pageComposite"; pageId: string }; // F4 予約。S1 では構築しない。

/**
 * モデル中立の生成意図(Docs/Feature-ScriptToManga.md S1 v2)。「何を作りたいか」を Comfy 固有語彙から
 * 切り離して表現する。steps/cfg/sampler/scheduler は拡散モデル共通語彙として `sampling` に、
 * LoRA・templateId・generationMode のような Comfy 固有値は `styles[].id` / `providerOptions.comfy`
 * へ隔離する。`generation_rounds.intent_json` へ保存され、将来の re-run・別 Provider 実装の入力になる。
 */
export interface GenerationIntent {
  version: 2;
  /** 中立な操作種別。provider はこれと入力の有無で実行内容を決める。 */
  task: GenerationTask;
  /** 実行レシピ(Comfy では recipeId = workflow_templates.id、revision = String(version))。 */
  recipe: { providerId: string; recipeId: string; revision?: string };
  prompt: { positive: string; negative: string };
  canvas: { width: number; height: number };
  /** 独立ジョブ N 個の意味(1..32)。 */
  batchCount: number;
  seed: { mode: "fixed" | "random" | "increment" | "reuse_parent"; value: number | null };
  /** transform/inpaint/upscale/detail の入力画像(img2img 系)。 */
  source?: { image: ArtifactRef; denoise: number } | null;
  inpaint?: { mask: ArtifactRef; maskedContent: MaskedContent; padding: number; feather: number } | null;
  /** 構図制御。kind は中立語彙(pose/edge)。 */
  control?: Array<{ kind: "pose" | "edge"; image: ArtifactRef; strength: number; range: [number, number] }>;
  /** 人物同一性の参照(現実装は PuLID 顔参照。ipadapter モードの親画像もここへ写像する。下記 resolveIdentity 参照)。 */
  identity?: { face: ArtifactRef } | null;
  /** 絵柄スタイル。id は provider スコープの不透明文字列(Comfy では LoRA choice verbatim)。 */
  styles?: Array<{ id: string; strength: number }>;
  /** 将来: 透過出力の要求。既定 "none"(現行 Provider には alpha 情報源が無いため常に省略)。 */
  output?: { alpha: "none" | "preferred" | "required" };
  target: GenerationTarget;
  /** 助言的サンプリングパラメータ。provider は解釈可能な範囲で使い、無視してよい。 */
  sampling?: { steps?: number; cfg?: number; sampler?: string; scheduler?: string };
  /**
   * provider 固有のエスケープハッチ。comfy: { templateId, generationMode }。
   * 汎用オーケストレータ(rounds.ts)は中身を一切読まない。Provider ごとに検証・正規化してから使う
   * (comfyProvider.validateIntent 参照)。API キー・署名付き URL・ローカルパスの格納は禁止。
   */
  providerOptions?: Record<string, unknown>;
}

export interface ToGenerationIntentContext {
  /** ArtifactRef.roundAttachment(mask/pose/reference/composite)の解決に使う Round id。 */
  roundId: string;
  providerId: string;
  /** recipe.revision(Comfy では workflow_templates.version の文字列化)。取得できなければ省略。 */
  recipeRevision?: string | null;
  pageId?: string | null;
  panelId?: string | null;
}

/**
 * `request`(prepare* 通過後の正規化済み GenerationRequest。dataUrl は既にファイルパス化済み)から
 * `GenerationIntent` を導出する純関数。`prepare*`(添付永続化)完了後に呼ぶこと(inpaint/ControlNet/
 * 参照画像が Intent から落ちないため)。ArtifactRef は roundId ベースの記号参照であり、実ファイルへの
 * 解決はここでは行わない(server 専用の resolveIntentArtifacts が担う)。
 */
export function toGenerationIntent(request: GenerationRequest, ctx: ToGenerationIntentContext): GenerationIntent {
  return {
    version: 2,
    task: deriveTask(request),
    recipe: {
      providerId: ctx.providerId,
      recipeId: request.templateId,
      revision: ctx.recipeRevision ?? undefined
    },
    prompt: { positive: request.prompt, negative: request.negativePrompt },
    canvas: { width: request.width, height: request.height },
    batchCount: request.batchSize,
    seed: { mode: toIntentSeedMode(request.seedMode), value: request.seed },
    source: resolveSource(request, ctx),
    inpaint: resolveInpaint(request, ctx),
    control: resolveControl(request, ctx),
    identity: resolveIdentity(request, ctx),
    styles: resolveStyles(request),
    target: resolveTarget(ctx),
    sampling: { steps: request.steps, cfg: request.cfg, sampler: request.sampler, scheduler: request.scheduler },
    providerOptions: { comfy: { templateId: request.templateId, generationMode: request.generationMode } }
  };
}

/**
 * task の導出規則(Docs/Feature-ScriptToManga.md S1): txt2img/seed_reuse/prompt_reuse → create、
 * img2img は inpaint 有り→inpaint / 無し→transform、ipadapter/controlnet → transform
 * (control/identity の有無で表現)、upscale → upscale、detail → detail。
 */
function deriveTask(request: GenerationRequest): GenerationTask {
  const mode = request.generationMode;
  if (mode === "img2img") {
    return request.inpaint?.maskPath ? "inpaint" : "transform";
  }
  if (mode === "ipadapter" || mode === "controlnet") {
    return "transform";
  }
  if (mode === "upscale") {
    return "upscale";
  }
  if (mode === "detail") {
    return "detail";
  }
  // txt2img / seed_reuse / prompt_reuse / manual_upload(Provider を通らないため到達しない想定)
  return "create";
}

function toIntentSeedMode(mode: GenerationRequest["seedMode"]): GenerationIntent["seed"]["mode"] {
  return mode === "reuse_parent_seed" ? "reuse_parent" : mode;
}

/**
 * source は img2img モードでのみ populate する。ipadapter/controlnet モードは requiresParentAsset()
 * (親アセットが必須)だが、実際の workflow パッチ(src/server/workflow.ts)では親画像を VAEEncode の
 * ソースとしては使わない(img2img 系の latent path 分岐は generationMode==="img2img" にのみ入る)ため、
 * source(denoise ベースの transform 入力)として記録するのは誤り(S1 レビュー指摘2)。
 */
function resolveSource(request: GenerationRequest, ctx: ToGenerationIntentContext): GenerationIntent["source"] {
  if (request.generationMode !== "img2img") {
    return null;
  }
  if (request.pasteComposite?.compositePath) {
    return {
      image: { kind: "roundAttachment", roundId: ctx.roundId, attachment: "composite" },
      denoise: request.denoise
    };
  }
  if (request.parentAssetId) {
    return {
      image: { kind: "asset", assetId: request.parentAssetId },
      denoise: request.denoise
    };
  }
  return null;
}

function resolveInpaint(request: GenerationRequest, ctx: ToGenerationIntentContext): GenerationIntent["inpaint"] {
  const inpaint = request.inpaint;
  if (!inpaint || !inpaint.maskPath) {
    return null;
  }
  return {
    mask: { kind: "roundAttachment", roundId: ctx.roundId, attachment: "mask" },
    maskedContent: inpaint.maskedContent,
    padding: inpaint.onlyMaskedPadding,
    feather: inpaint.featherRadius ?? 0
  };
}

/**
 * S1 レビュー指摘2: controlnet モードの制御画像は「pose ドラフト添付があればそれ、無ければ親アセット
 * 画像そのもの」(src/server/workflow.ts:111-114: `!request.controlnet` のとき親画像が
 * controlnet_image_input へ直結される)。旧実装は pose ドラフトが無いと control を空配列のまま返し、
 * 親画像を(誤って)source へ回していた。
 */
function resolveControl(request: GenerationRequest, ctx: ToGenerationIntentContext): GenerationIntent["control"] {
  if (request.generationMode !== "controlnet") {
    return [];
  }
  if (request.controlnet?.poseImagePath) {
    return [
      {
        kind: "pose",
        image: { kind: "roundAttachment", roundId: ctx.roundId, attachment: "pose" },
        strength: request.controlnet.strength,
        range: [request.controlnet.startPercent, request.controlnet.endPercent]
      }
    ];
  }
  if (request.parentAssetId) {
    // pose ドラフト無しの controlnet: 親アセット画像そのものが制御画像として直結される
    // (strength/range はテンプレ既定値に委ねられるため、助言的なデフォルトを記録する)。
    return [
      {
        kind: "pose",
        image: { kind: "asset", assetId: request.parentAssetId },
        strength: 1,
        range: [0, 1]
      }
    ];
  }
  return [];
}

/**
 * identity は PuLID 顔参照(request.reference)を正とする。ipadapter モードの親アセット画像は
 * ipadapter_image_input(スタイル/同一性の参照入力)へ直結され、img2img のような VAEEncode ソースには
 * ならない(S1 レビュー指摘2 と同根)ため、PuLID 参照が無い場合のフォールバックとして identity に
 * 写像する(control の kind が pose/edge に限定され ipadapter を表現できないための設計判断。
 * Docs/Feature-ScriptToManga.md S1 は「control/identity の有無で表現」とだけ規定しており、
 * この割り当てはレビューで確定していない実装判断 — 詳細は作業報告を参照)。
 */
function resolveIdentity(request: GenerationRequest, ctx: ToGenerationIntentContext): GenerationIntent["identity"] {
  const reference = request.reference;
  if (reference?.face?.enabled && reference.imagePath) {
    return { face: { kind: "roundAttachment", roundId: ctx.roundId, attachment: "reference" } };
  }
  if (request.generationMode === "ipadapter" && request.parentAssetId) {
    return { face: { kind: "asset", assetId: request.parentAssetId } };
  }
  return null;
}

function resolveStyles(request: GenerationRequest): GenerationIntent["styles"] {
  return (request.loras ?? []).map((lora) => ({ id: lora.name, strength: lora.strength }));
}

function resolveTarget(ctx: ToGenerationIntentContext): GenerationTarget {
  if (ctx.pageId && ctx.panelId) {
    return { kind: "panel", pageId: ctx.pageId, panelId: ctx.panelId };
  }
  if (ctx.pageId) {
    return { kind: "page", pageId: ctx.pageId };
  }
  return { kind: "project" };
}
