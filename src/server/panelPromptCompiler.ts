import type { NarrativeEntity, NormalizedBox, PanelSpec } from "../shared/mangaPlanV2";
import type { StoryGraphDialogueInput } from "./storyGraphBuilder";

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
    return `${input.basePrompt.trim()}. ${input.panel.shot.size} shot. ${input.panel.shot.angle || "eye-level angle"}. one coherent moment, consistent character design, readable silhouettes, no text, no letters, no speech bubbles, no watermark`
      .replace(/\s+/g, " ")
      .trim();
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
