import type { NarrativeEntity, NormalizedBox, PanelSpec } from "../shared/mangaPlanV2";
import type { StoryGraphDialogueInput } from "./storyGraphBuilder";
import type { ReferenceSetSnapshot } from "../shared/referenceSets";

export type PromptDialect = "natural" | "tags";
export interface PanelConditioning { positive: string; negative: string }
const TEXT_NEGATIVE = "text, letters, words, typography, captions, subtitles, speech bubbles, manga sound effects, signage, labels, logos, watermarks, UI overlays";
const QUALITY_NEGATIVE = "low quality, blurry, deformed, bad anatomy, extra limbs, extra fingers";

const VISUAL_TAG_TRANSLATIONS: Array<[RegExp, string]> = [
  [/宇宙/u, "outer space"], [/人工衛星/u, "broken satellite debris"], [/月/u, "moon"],
  [/白い.*(?:人型|機体|機動兵器)/u, "damaged white humanoid mecha"], [/黒い.*(?:塔|構造体)/u, "giant black mechanical tower"],
  [/コックピット/u, "mecha cockpit"], [/警告灯/u, "red warning lights"], [/少女/u, "young woman"],
  [/都市/u, "futuristic megacity"], [/雲海/u, "sea of clouds"], [/ホバーバイク/u, "futuristic hover bike"],
  [/研究(?:区画|所|棟)/u, "abandoned research facility"], [/格納庫/u, "industrial hangar"],
  [/爆発/u, "explosion"], [/閃光/u, "bright flash"], [/光弾/u, "red energy projectiles"],
  [/雨/u, "rain"], [/夜/u, "night"], [/昼/u, "daylight"]
];

function tagSafeVisual(text: string): string {
  if (!text.trim()) return "";
  const tags = VISUAL_TAG_TRANSLATIONS.filter(([pattern]) => pattern.test(text)).map(([, tag]) => tag);
  const english = text.replace(/[\u3040-\u30ff\u3400-\u9fff]+/gu, " ")
    .replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim();
  if (english && /[a-z]{3}/i.test(english)) tags.push(english);
  return [...new Set(tags)].join(", ");
}

function regionName(box: NormalizedBox): string {
  const horizontal = box.x + box.width / 2 < 0.38 ? "left" : box.x + box.width / 2 > 0.62 ? "right" : "center";
  const vertical = box.y + box.height / 2 < 0.38 ? "upper" : box.y + box.height / 2 > 0.62 ? "lower" : "middle";
  return `${vertical}-${horizontal} region`;
}

function speechAct(line: StoryGraphDialogueInput): string {
  if (["telecom", "machine", "vo", "caption", "monitor"].includes(line.balloonStyle ?? "")) {
    return "off-screen voice; the speaker is not depicted in this panel; the image contains no rendered text";
  }
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
    .flatMap((part) => (input.dialect === "tags" ? tagSafeVisual(part ?? "") : part ?? "").split(/\s*,\s*|\.\s+/))
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
  const naturalRaw = /[\u3040-\u30ff\u3400-\u9fff]/u.test(raw) ? tagSafeVisual(raw) : raw;
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
        `${input.panel.shot.size} shot`, input.panel.shot.angle, ...input.panel.cast.flatMap((member) => [member.action, member.expression]), ...scene, input.basePrompt].map((part) => tagSafeVisual(part ?? ""))
    : [naturalRaw, ...approvedAppearances, ...identities, ...scene.map((part) => /[\u3040-\u30ff\u3400-\u9fff]/u.test(part) ? tagSafeVisual(part) : part)];
  const maxTerms = Math.max(12, input.maxTerms ?? 75);
  const positive = positiveParts.flatMap((part) => part?.split(/\s*,\s*|\.\s+/) ?? []).filter(Boolean).slice(0, maxTerms).join(input.dialect === "tags" ? ", " : ". ");
  const moved = input.panel.mustNotShow.map((item) => item.description).filter(Boolean);
  return {
    positive,
    negative: [input.negativeBase?.trim() || QUALITY_NEGATIVE, TEXT_NEGATIVE, ...moved].filter(Boolean).join(", ")
  };
}
