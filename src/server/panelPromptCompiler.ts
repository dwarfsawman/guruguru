import type { NarrativeEntity, NormalizedBox, PanelSpec } from "../shared/mangaPlanV2";
import type { StoryGraphDialogueInput } from "./storyGraphBuilder";
import type { ReferenceSetSnapshot } from "../shared/referenceSets";
import { getDialoguePresentationMeaning, stripClausesContainingCharacterLabels } from "../shared/dialoguePresentation";

export type PromptDialect = "natural" | "tags";
export interface PanelConditioning { positive: string; negative: string }
const TEXT_NEGATIVE = "text, letters, words, typography, captions, subtitles, speech bubbles, manga sound effects, signage, labels, logos, watermarks, UI overlays";
const QUALITY_NEGATIVE = "low quality, blurry, deformed, bad anatomy, extra limbs, extra fingers";

function tagSafeVisual(text: string): string {
  if (!text.trim()) return "";
  // Never pseudo-translate through a title/genre-specific dictionary. Structured LLM plans
  // should supply English visual facts for tag models; heuristic fallback keeps the source facts
  // intact instead of silently deleting or inventing meaning.
  return text.normalize("NFKC")
    .replace(/[\r\n。；;]+/gu, ", ")
    .replace(/、+/gu, ", ")
    .replace(/[^\p{L}\p{N}\p{M}\s,.'’"!?%:+\-()/]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:\s*,\s*)+/g, ", ")
    .trim()
    .replace(/^,\s*|,\s*$/g, "");
}

function regionName(box: NormalizedBox): string {
  const horizontal = box.x + box.width / 2 < 0.38 ? "left" : box.x + box.width / 2 > 0.62 ? "right" : "center";
  const vertical = box.y + box.height / 2 < 0.38 ? "upper" : box.y + box.height / 2 > 0.62 ? "lower" : "middle";
  return `${vertical}-${horizontal} region`;
}

function speechAct(line: StoryGraphDialogueInput): string {
  const meaning = getDialoguePresentationMeaning(line);
  if (meaning.visibilityEvidence === "none") {
    return `${meaning.delivery} delivered separately from the depicted action; do not infer speaking mouth movement; the image contains no rendered text`;
  }
  if (line.semanticKind === "monologue") return "quiet internal reaction with closed or resting mouth";
  if (line.semanticKind === "sfx") return "reacting to a sound; do not render sound-effect letters";
  if (/[?？]\s*$/.test(line.text)) return "asking a question while speaking";
  if (/[!！]\s*$/.test(line.text)) return "speaking emphatically";
  return "speaking naturally";
}

function stripDialogueFromVisualFact(text: string, dialogueById: Map<string, StoryGraphDialogueInput>): string {
  let result = text;
  for (const line of dialogueById.values()) {
    const wording = line.text.trim();
    if (wording) result = result.replaceAll(wording, "");
  }
  return result
    .replace(/[「『《][^」』》]*[」』》]/gu, "")
    .replace(/(?:communication|dialogue|caption|monitor|screen|text)\s*[:=]\s*[^.;]+/giu, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([,.;])\s*\1+/g, "$1")
    .trim();
}

function compileProvidedVisualFacts(input: {
  panel: PanelSpec;
  basePrompt: string;
  entities: NarrativeEntity[];
  dialogueById: Map<string, StoryGraphDialogueInput>;
}): string {
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity]));
  const parts = [input.basePrompt.trim()];
  if (!/\b(?:extreme[- ]wide|wide|long|full|medium|close[- ]?up|insert)\s+shot\b/iu.test(input.basePrompt)) {
    parts.push(`${input.panel.shot.size} shot`);
  }
  const angle = input.panel.shot.angle?.trim();
  if (angle && !/\b(?:eye[- ]level|low|high|dutch|overhead|bird(?:'s)?[- ]eye)\b/iu.test(input.basePrompt)) {
    parts.push(angle);
  }
  for (const member of input.panel.cast) {
    const entity = entityById.get(member.characterId);
    parts.push([
      entity?.name || "character",
      entity?.attributes.description?.trim() || "",
      member.action,
      member.expression ? `${member.expression} expression` : "",
      member.pose || "",
      `in the ${regionName(member.bbox)}`
    ].filter(Boolean).join(", "));
  }
  for (const item of input.panel.mustShow) {
    const fact = stripDialogueFromVisualFact(item.description, input.dialogueById);
    if (fact) parts.push(`must show: ${fact}`);
  }
  for (const item of input.panel.mustNotShow) {
    const fact = stripDialogueFromVisualFact(item.description, input.dialogueById);
    if (fact) parts.push(`must not show: ${fact}`);
  }
  parts.push("one coherent moment, single concrete scene, clearly recognizable subjects, consistent character design, no text, no letters, no speech bubbles, no watermark");
  return parts.filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
}

/**
 * ネームポーズレイヤの深度ヒント: 深度差のある2人以上のコマにだけ中立の1フレーズを足す
 * (Docs/Feature-NamePoseLayer.md。キャラ名・否定語なし = v3規約維持)。
 */
function depthStagingHint(panel: PanelSpec): string | null {
  const poses = panel.castPoses ?? [];
  if (poses.length < 2) return null;
  const depths = new Set(poses.map((pose) => pose.depth));
  if (depths.size < 2) return null;
  return "clear foreground and background separation between overlapping figures";
}

/**
 * Compiles visual facts only. Dialogue wording remains in the lettering layer and is represented
 * here as speech act / mouth state, preventing diffusion models from trying to draw the script.
 */
export function compilePanelPrompt(input: {
  panel: PanelSpec;
  basePrompt: string;
  entities: NarrativeEntity[];
  dialogueById: Map<string, StoryGraphDialogueInput>;
  /** LLM-directed fields are English, while NarrativeGraph identity labels may remain source-language. */
  narrativeMetadata?: "append" | "english-directed" | "base-only";
}): string {
  if (input.narrativeMetadata === "base-only") {
    return compileProvidedVisualFacts(input);
  }
  if (input.narrativeMetadata === "english-directed") {
    const parts = [input.basePrompt.trim()];
    parts.push(
      `${input.panel.shot.size} shot`,
      input.panel.shot.angle || "eye-level angle",
      input.panel.shot.compositionIntent || "clear single-moment composition"
    );
    const directedDepthHint = depthStagingHint(input.panel);
    if (directedDepthHint) parts.push(directedDepthHint);
    for (const member of input.panel.cast) {
      const lineStates = member.speakingLineIds
        .map((lineId) => input.dialogueById.get(lineId))
        .filter((line): line is StoryGraphDialogueInput => Boolean(line))
        .map(speechAct);
      parts.push([
        `character in the ${regionName(member.bbox)}`,
        member.action,
        member.expression ? `${member.expression} expression` : "",
        member.pose || "",
        member.gazeTarget ? `looking toward ${member.gazeTarget}` : "",
        lineStates.join(", ")
      ].filter(Boolean).join(", "));
    }
    for (const prop of input.panel.props) {
      parts.push(`prop: ${prop.state}${prop.bbox ? ` in the ${regionName(prop.bbox)}` : ""}`);
    }
    if (input.panel.textSafeZones.length > 0) {
      parts.push(`leave ${input.panel.textSafeZones.map(regionName).join(" and ")} visually quiet for later lettering`);
    }
    if (input.panel.mustShow.length > 0) parts.push(`must show: ${input.panel.mustShow.map((item) => item.description).join("; ")}`);
    if (input.panel.mustNotShow.length > 0) parts.push(`must not show: ${input.panel.mustNotShow.map((item) => item.description).join("; ")}`);
    parts.push("one coherent moment, consistent character design, readable silhouettes, no text, no letters, no speech bubbles, no watermark");
    return parts.filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
  }
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity]));
  const parts: string[] = [input.basePrompt.trim()];
  const focal = entityById.get(input.panel.shot.focalSubjectId);
  parts.push(
    `${input.panel.shot.size} shot`,
    input.panel.shot.angle || "eye-level angle",
    input.panel.shot.compositionIntent || "clear single-moment composition"
  );
  const appendDepthHint = depthStagingHint(input.panel);
  if (appendDepthHint) parts.push(appendDepthHint);
  if (focal) parts.push(`focal subject: ${focal.name}`);

  for (const member of input.panel.cast) {
    const entity = entityById.get(member.characterId);
    const description = entity?.attributes.description?.trim();
    const lineStates = member.speakingLineIds
      .map((lineId) => input.dialogueById.get(lineId))
      .filter((line): line is StoryGraphDialogueInput => Boolean(line))
      .map(speechAct);
    parts.push(
      [
        `${entity?.name || member.characterId} in the ${regionName(member.bbox)}`,
        description || "",
        member.action,
        member.expression ? `${member.expression} expression` : "",
        member.pose || "",
        member.gazeTarget ? `looking toward ${member.gazeTarget}` : "",
        lineStates.join(", ")
      ]
        .filter(Boolean)
        .join(", ")
    );
  }
  for (const prop of input.panel.props) {
    const entity = entityById.get(prop.entityId);
    parts.push(`${entity?.name || prop.entityId}: ${prop.state}${prop.bbox ? ` in the ${regionName(prop.bbox)}` : ""}`);
  }
  if (input.panel.textSafeZones.length > 0) {
    parts.push(`leave ${input.panel.textSafeZones.map(regionName).join(" and ")} visually quiet for later lettering`);
  }
  if (input.panel.mustShow.length > 0) parts.push(`must show: ${input.panel.mustShow.map((item) => item.description).join("; ")}`);
  if (input.panel.mustNotShow.length > 0) parts.push(`must not show: ${input.panel.mustNotShow.map((item) => item.description).join("; ")}`);
  parts.push("one coherent moment, consistent character design, readable silhouettes, no text, no letters, no speech bubbles, no watermark");
  return parts.filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
}

interface PanelConditioningInput {
  panel: PanelSpec;
  basePrompt: string;
  entities: NarrativeEntity[];
  dialogueById: Map<string, StoryGraphDialogueInput>;
  narrativeMetadata?: "append" | "english-directed" | "base-only";
  dialect?: PromptDialect;
  qualityTags?: string;
  negativeBase?: string;
  maxTerms?: number;
  sceneBible?: { set: string; lighting: string; palette: string };
  referenceAppearances?: ReferenceSetSnapshot[];
}

function excludedIdentityLabels(input: Pick<PanelConditioningInput, "panel" | "entities">): string[] {
  const excludedIds = new Set(input.panel.mustNotShow
    .filter((constraint) => constraint.kind === "entity-absent" && constraint.entityId)
    .map((constraint) => constraint.entityId!));
  return input.entities
    .filter((entity) => excludedIds.has(entity.id))
    .flatMap((entity) => [entity.name, ...entity.aliases]);
}

/**
 * ぶち抜き立ち絵スロット(Docs/Reference-MangaCompositions.md)の条件付け。シーンバイブル・
 * 文字用余白などのシーン都合は使わず、単独人物の全身立ち姿を「無地の白背景」で生成させる。
 * 白背景は候補採用時の背景除去(縁フラッドフィル)の成立条件なので positive で強制し、
 * 背景描写に働く語は negative へ移す。
 */
function compileFigureConditioning(input: PanelConditioningInput): PanelConditioning {
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity]));
  const member = input.panel.cast[0];
  const entity = member ? entityById.get(member.characterId) : undefined;
  const variant = member ? entity?.variants.find((item) => item.id === member.variantId) : undefined;
  const identity = [entity?.attributes.tags || entity?.attributes.description, variant?.attributes.tags || variant?.attributes.description]
    .filter((value): value is string => Boolean(value?.trim()) && !/[぀-ヿ㐀-鿿]/u.test(value!));
  const approvedAppearances = (input.referenceAppearances ?? []).flatMap((reference) => [
    reference.appearancePromptEn,
    reference.mustNotChange.length > 0 ? `identity invariants: ${reference.mustNotChange.join(", ")}` : ""
  ]).filter(Boolean);
  const quality = input.qualityTags?.trim() || "masterpiece, best quality, high detail";
  const excludedLabels = excludedIdentityLabels(input);
  const parts = [
    quality,
    "solo",
    ...approvedAppearances,
    ...identity,
    "full body, standing figure, head to toe in frame",
    member?.action ?? "",
    member?.expression ? `${member.expression} expression` : "",
    member?.pose ?? "",
    tagSafeVisual(input.basePrompt),
    "simple background, plain white background"
  ];
  const maxTerms = Math.max(12, input.maxTerms ?? 75);
  const positive = parts
    .flatMap((part) => {
      const safe = stripClausesContainingCharacterLabels(part ?? "", excludedLabels);
      return (input.dialect === "tags" ? tagSafeVisual(safe) : safe).split(/\s*,\s*|\.\s+/);
    })
    .filter(Boolean)
    .slice(0, maxTerms)
    .join(input.dialect === "tags" ? ", " : ". ");
  const moved = input.panel.mustNotShow.map((item) => item.description).filter(Boolean);
  return {
    positive,
    negative: [
      input.negativeBase?.trim() || QUALITY_NEGATIVE,
      TEXT_NEGATIVE,
      "detailed background, scenery, indoor, outdoor, cropped legs, cropped feet, out of frame",
      ...moved
    ].filter(Boolean).join(", ")
  };
}

/** v3 conditioning contract: exclusions never enter positive conditioning. */
export function compilePanelConditioning(input: PanelConditioningInput): PanelConditioning {
  // ぶち抜き立ち絵スロットはシーン描写ではなく人物切り抜き前提の専用条件付けへ分岐する。
  if (input.panel.role === "figure") {
    return compileFigureConditioning(input);
  }
  const cleanPanel = { ...input.panel, mustNotShow: [] };
  const raw = compilePanelPrompt({ ...input, panel: cleanPanel });
  const excludedLabels = excludedIdentityLabels(input);
  const naturalRaw = stripClausesContainingCharacterLabels(raw, excludedLabels);
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity]));
  const identities = input.panel.cast.flatMap((member) => {
    const entity = entityById.get(member.characterId);
    const variant = entity?.variants.find((item) => item.id === member.variantId);
    const descriptions = [entity?.attributes.tags || entity?.attributes.description, variant?.attributes.tags || variant?.attributes.description]
      .filter((value): value is string => Boolean(value?.trim()) && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(value!));
    return descriptions;
  });
  const approvedAppearances = (input.referenceAppearances ?? []).flatMap((reference) => [
    reference.appearancePromptEn,
    reference.mustNotChange.length > 0 ? `identity invariants: ${reference.mustNotChange.join(", ")}` : ""
  ]).filter(Boolean);
  const quality = input.qualityTags?.trim() || "masterpiece, best quality, high detail";
  const scene = input.sceneBible ? [input.sceneBible.set, input.sceneBible.lighting, input.sceneBible.palette] : [];
  const castCount = input.panel.cast.length === 0 ? "" : input.panel.cast.length === 1 ? "1character" : `${input.panel.cast.length}characters`;
  const positiveParts = input.dialect === "tags"
    ? [quality, castCount, ...approvedAppearances, ...identities,
        `${input.panel.shot.size} shot`, input.panel.shot.angle, ...input.panel.cast.flatMap((member) => [member.action, member.expression]), ...scene, input.basePrompt]
        .map((part) => tagSafeVisual(stripClausesContainingCharacterLabels(part ?? "", excludedLabels)))
    : [naturalRaw, ...approvedAppearances, ...identities, ...scene.map((part) => stripClausesContainingCharacterLabels(part, excludedLabels))];
  const maxTerms = Math.max(12, input.maxTerms ?? 75);
  const positive = positiveParts.flatMap((part) => part?.split(/\s*,\s*|\.\s+/) ?? []).filter(Boolean).slice(0, maxTerms).join(input.dialect === "tags" ? ", " : ". ");
  const moved = input.panel.mustNotShow.map((item) => item.description).filter(Boolean);
  return {
    positive,
    negative: [input.negativeBase?.trim() || QUALITY_NEGATIVE, TEXT_NEGATIVE, ...moved].filter(Boolean).join(", ")
  };
}
