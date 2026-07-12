import type { NarrativeEntity, NormalizedBox, PanelSpec } from "../shared/mangaPlanV2";
import type { StoryGraphDialogueInput } from "./storyGraphBuilder";

export type PromptDialect = "natural" | "tags";
export interface PanelConditioning { positive: string; negative: string }
const TEXT_NEGATIVE = "text, letters, words, typography, captions, subtitles, speech bubbles, manga sound effects, signage, labels, logos, watermarks, UI overlays";
const QUALITY_NEGATIVE = "low quality, blurry, deformed, bad anatomy, extra limbs, extra fingers";

function regionName(box: NormalizedBox): string {
  const horizontal = box.x + box.width / 2 < 0.38 ? "left" : box.x + box.width / 2 > 0.62 ? "right" : "center";
  const vertical = box.y + box.height / 2 < 0.38 ? "upper" : box.y + box.height / 2 > 0.62 ? "lower" : "middle";
  return `${vertical}-${horizontal} region`;
}

function speechAct(line: StoryGraphDialogueInput): string {
  if (line.semanticKind === "narration") return "off-panel narration; the image contains no rendered text";
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

/** v3 conditioning contract: exclusions never enter positive conditioning. */
export function compilePanelConditioning(input: {
  panel: PanelSpec;
  basePrompt: string;
  entities: NarrativeEntity[];
  dialogueById: Map<string, StoryGraphDialogueInput>;
  narrativeMetadata?: "append" | "english-directed" | "base-only";
  dialect?: PromptDialect;
  qualityTags?: string;
  negativeBase?: string;
  maxTerms?: number;
}): PanelConditioning {
  const cleanPanel = { ...input.panel, mustNotShow: [] };
  const raw = compilePanelPrompt({ ...input, panel: cleanPanel });
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity]));
  const identities = input.panel.cast.flatMap((member) => {
    const entity = entityById.get(member.characterId);
    const variant = entity?.variants.find((item) => item.id === member.variantId);
    const descriptions = [entity?.attributes.tags || entity?.attributes.description, variant?.attributes.tags || variant?.attributes.description]
      .filter((value): value is string => Boolean(value?.trim()) && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(value!));
    return descriptions;
  });
  const quality = input.qualityTags?.trim() || "masterpiece, best quality, high detail";
  const positiveParts = input.dialect === "tags"
    ? [quality, input.panel.cast.length === 1 ? "1character" : `${input.panel.cast.length}characters`, ...identities,
        `${input.panel.shot.size} shot`, input.panel.shot.angle, ...input.panel.cast.flatMap((member) => [member.action, member.expression]), input.basePrompt]
    : [raw, ...identities];
  const maxTerms = Math.max(12, input.maxTerms ?? 75);
  const positive = positiveParts.flatMap((part) => part?.split(/\s*,\s*|\.\s+/) ?? []).filter(Boolean).slice(0, maxTerms).join(input.dialect === "tags" ? ", " : ". ");
  const moved = input.panel.mustNotShow.map((item) => item.description).filter(Boolean);
  return {
    positive,
    negative: [input.negativeBase?.trim() || QUALITY_NEGATIVE, TEXT_NEGATIVE, ...moved].filter(Boolean).join(", ")
  };
}
