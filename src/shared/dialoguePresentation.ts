import type { DialogueBalloonStyle } from "./apiTypes";

/** How a scripted line reaches the reader. This is independent of who is visible in the image. */
export type DialogueDelivery =
  | "direct"
  | "voice-over"
  | "telecom"
  | "machine"
  | "narration"
  | "display"
  | "sound-effect";

/**
 * Evidence contributed by the dialogue element alone. `none` does not mean that the speaker must
 * be absent: an action or synopsis element may independently establish that person as visible.
 */
export type DialogueVisibilityEvidence = "visible-speaker" | "none";

export interface DialoguePresentationMeaning {
  delivery: DialogueDelivery;
  visibilityEvidence: DialogueVisibilityEvidence;
}

/** Structured evidence from action/synopsis prose that a character is physically in frame. */
export interface VisibleActorEvidence {
  kind: "explicit-cast-tag" | "physical-mention";
  label: string;
  index: number;
}

export type ExplicitDialogueDelivery = "voice-over" | "telecom" | "machine";

export interface ParsedSpeakerCue {
  /** Speaker identity with recognized delivery/continuation suffixes removed. */
  identityLabel: string;
  delivery: ExplicitDialogueDelivery | null;
}

const TRAILING_CUE_EXTENSION = /\s*(?:\(([^()]*)\)|（([^（）]*)）)\s*$/u;

function normalizeMarker(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
}

function markerTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .split(/\s*[,/、]\s*/u)
    .map(normalizeMarker)
    .filter(Boolean);
}

function explicitDeliveryMarker(value: string): ExplicitDialogueDelivery | null {
  const marker = normalizeMarker(value);
  if (/^(?:V\.?\s*O\.?|VOICE[- ]?OVER|O\.?\s*S\.?|O\.?\s*C\.?|OFF[- ]?SCREEN|MEMORY|RECORDING|FLASHBACK|記憶|記録|回想)$/u.test(marker)) {
    return "voice-over";
  }
  if (/^(?:通信|無線|拡声|スピーカー|電話|RADIO|OVER RADIO|PHONE|TELECOM|LOUDSPEAKER|P\.?\s*A\.?)$/u.test(marker)) {
    return "telecom";
  }
  if (/^(?:機械|機械音声|システム音声|自動音声|MACHINE|MACHINE VOICE|COMPUTER VOICE|SYSTEM VOICE|AUTOMATED VOICE)$/u.test(marker)) {
    return "machine";
  }
  return null;
}

/** Parse comma/slash separated Fountain extensions as exact tokens, never as substrings. */
function explicitDeliveryFromExtension(value: string): ExplicitDialogueDelivery | null {
  for (const token of markerTokens(value)) {
    const delivery = explicitDeliveryMarker(token);
    if (delivery) return delivery;
  }
  return null;
}

function isContinuationMarker(value: string): boolean {
  return /^(?:CONT'?D|CONTINUED|続き)$/u.test(normalizeMarker(value));
}

/** Parse only explicit, terminal Fountain cue extensions such as `MIRA (V.O.)`. */
export function parseSpeakerCue(speakerLabel: string): ParsedSpeakerCue {
  let identityLabel = speakerLabel.trim();
  let delivery: ExplicitDialogueDelivery | null = null;
  while (identityLabel) {
    const match = TRAILING_CUE_EXTENSION.exec(identityLabel);
    if (!match || match.index === undefined) break;
    const marker = match[1] ?? match[2] ?? "";
    const recognizedDelivery = explicitDeliveryFromExtension(marker);
    if (!recognizedDelivery && !isContinuationMarker(marker)) break;
    delivery ??= recognizedDelivery;
    identityLabel = identityLabel.slice(0, match.index).trimEnd();
  }
  return { identityLabel: identityLabel || speakerLabel.trim(), delivery };
}

/** A parsed Fountain parenthetical is already a structured field, but its value must match fully. */
export function parseParentheticalDelivery(parenthetical: string | undefined): ExplicitDialogueDelivery | null {
  if (!parenthetical?.trim()) return null;
  const trimmed = parenthetical.trim();
  const wrapped = /^(?:\(([^()]*)\)|（([^（）]*)）)$/u.exec(trimmed);
  return explicitDeliveryFromExtension(wrapped ? (wrapped[1] ?? wrapped[2] ?? "") : trimmed);
}

/** Exact generic audio-source cues. Substrings such as `システム担当者` are intentionally excluded. */
export function isMachineSpeakerCue(speakerLabel: string): boolean {
  const normalized = parseSpeakerCue(speakerLabel).identityLabel.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
  return /^(?:機械音声|システム|システム音声|自動音声|アナウンス|館内アナウンス|場内アナウンス|COMPUTER|COMPUTER VOICE|SYSTEM|SYSTEM VOICE|AUTOMATED VOICE|AUTOMATED ANNOUNCEMENT|P\.?\s*A\.? ANNOUNCEMENT)$/u.test(normalized);
}

/** Exact display/readout speaker labels. Text punctuation alone is not display evidence. */
export function isDisplaySpeakerCue(speakerLabel: string): boolean {
  const normalized = parseSpeakerCue(speakerLabel).identityLabel.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
  return /^《[^》\r\n]+》$/u.test(normalized) || /^(?:表示|画面表示|モニター表示|DISPLAY|MONITOR|SCREEN|READOUT)$/u.test(normalized);
}

/** True only when every non-empty line is a complete `《readout》` item. */
export function isDisplayReadoutText(rawText: string): boolean {
  const lines = rawText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => /^《[^》\r\n]+》\s*[:：]?$/u.test(line));
}

export function getDialoguePresentationMeaning(input: {
  semanticKind?: string;
  balloonStyle?: string;
}): DialoguePresentationMeaning {
  if (input.semanticKind === "narration") return { delivery: "narration", visibilityEvidence: "none" };
  if (input.semanticKind === "sfx") return { delivery: "sound-effect", visibilityEvidence: "none" };

  const style = input.balloonStyle as DialogueBalloonStyle | undefined;
  if (style === "vo") return { delivery: "voice-over", visibilityEvidence: "none" };
  if (style === "telecom") return { delivery: "telecom", visibilityEvidence: "none" };
  if (style === "machine") return { delivery: "machine", visibilityEvidence: "none" };
  if (style === "caption") return { delivery: "narration", visibilityEvidence: "none" };
  if (style === "monitor") return { delivery: "display", visibilityEvidence: "none" };
  return { delivery: "direct", visibilityEvidence: "visible-speaker" };
}

/** Whether this line, without any action/synopsis evidence, is enough to add its speaker to cast. */
export function dialogueEstablishesVisibleSpeaker(input: {
  semanticKind?: string;
  balloonStyle?: string;
}): boolean {
  return getDialoguePresentationMeaning(input).visibilityEvidence === "visible-speaker";
}

const REPRESENTATION_JA = "(?:写真|画像|映像|動画|画面|モニター|ディスプレイ|スクリーン|肖像|ポスター|鏡|反射|記録|記録映像)";
const AUDIO_SOURCE_JA = "(?:無線|通信|電話|スピーカー|拡声器|インカム|イヤホン|録音|記録音声|音声)";
const REPRESENTATION_EN = "(?:photo(?:graph)?|picture|image|video|footage|monitor|screen|display|portrait|poster|mirror|reflection|recording)";
const AUDIO_SOURCE_EN = "(?:radio|phone|telephone|speaker|loudspeaker|intercom|headset|recording|voice\u0020message|voicemail)";

function isUnicodeWord(value: string | undefined): boolean {
  return Boolean(value && /[\p{L}\p{N}_]/u.test(value));
}

function isLabelBoundary(text: string, start: number, end: number, label: string): boolean {
  const asciiLabel = /^[a-z0-9 _'-]+$/iu.test(label);
  const previous = text[start - 1];
  const next = text[end];
  if (asciiLabel) return !/[a-z0-9_]/iu.test(previous ?? "") && !/[a-z0-9_]/iu.test(next ?? "");

  // Japanese names are normally adjacent to particles. Treating every Unicode letter as a
  // boundary would make ミラ match ミラージュ, while strict word boundaries miss ミラが.
  const before = text.slice(Math.max(0, start - 4), start);
  const after = text.slice(end, end + 4);
  const beforeIsBoundary = start === 0 || !isUnicodeWord(previous) || /(?:から|より|には|では|へは|とは|の|を|が|は|に|へ|と|も|で)$/u.test(before);
  const afterIsBoundary = end === text.length || !isUnicodeWord(next) || /^(?:から|より|には|では|へは|とは|は|が|を|に|へ|と|も|の|で|こそ|さえ|まで)/u.test(after);
  return beforeIsBoundary && afterIsBoundary;
}

/** Exact identity mention with Japanese-particle and ASCII word boundaries; no substring matching. */
export function textContainsCharacterLabel(text: string, labels: readonly string[]): boolean {
  const normalizedText = text.normalize("NFKC").toLocaleLowerCase();
  for (const rawLabel of labels) {
    const label = rawLabel.normalize("NFKC").trim().toLocaleLowerCase();
    if (!label) continue;
    let offset = 0;
    while (offset <= normalizedText.length - label.length) {
      const index = normalizedText.indexOf(label, offset);
      if (index < 0) break;
      const end = index + label.length;
      offset = Math.max(end, index + 1);
      if (isLabelBoundary(normalizedText, index, end, label)) return true;
    }
  }
  return false;
}

/** Remove whole visual clauses that mention an excluded identity, preserving unrelated facts. */
export function stripClausesContainingCharacterLabels(text: string, labels: readonly string[]): string {
  if (!text.trim() || labels.length === 0) return text.trim();
  const clauses = text.match(/[^.!?。！？;；\r\n]+[.!?。！？;；]?/gu) ?? [text];
  return clauses
    .filter((clause) => !textContainsCharacterLabel(clause, labels))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceBounds(text: string, index: number): { start: number; end: number } {
  const separators = /[\r\n。！？!?；;]/u;
  let start = index;
  while (start > 0 && !separators.test(text[start - 1]!)) start -= 1;
  let end = index;
  while (end < text.length && !separators.test(text[end]!)) end += 1;
  return { start, end };
}

function isNonPhysicalMention(text: string, start: number, end: number): boolean {
  const bounds = sentenceBounds(text, start);
  const before = text.slice(bounds.start, start).trimEnd();
  const after = text.slice(end, bounds.end).trimStart();

  // Possessives identify a voice, image, belonging, or other derivative noun—not the person.
  if (/^(?:の|['’]s\b)/iu.test(after)) return true;
  if (/^(?:から|より)の(?:通信|音声|声|録音|メッセージ|手紙|メール|記録|報告)/u.test(after)) return true;
  if (/^(?:所有|所持|宛て)/u.test(after)) return true;

  // Being discussed, remembered, imagined, sought, awaited, or called is not evidence that the
  // referenced person is physically present. The acting subject remains independently eligible.
  if (/^(?:について(?:$|[、,\s]|話|語|尋|聞|考|思|議論|説明|調べ|言及)|に関して)/u.test(after)) return true;
  if (/^を[、,\s]*(?:思い出|回想|想像|探|捜|待|呼び|呼ぶ|尋ね|言及)/u.test(after)) return true;

  // A named person carried by a visual/audio medium remains off-screen unless another action
  // element independently places that person in the scene.
  if (new RegExp(`${REPRESENTATION_JA}(?:の中|の画面|の表示)?(?:に|には|で|では|が|は|から|の|上に|越しに|[:：])\\s*$`, "iu").test(before)) return true;
  if (new RegExp(`${AUDIO_SOURCE_JA}(?:から|越しに|越しの|を通じて|経由で|の向こうから|[:：])\\s*$`, "iu").test(before)) return true;
  if (new RegExp(`^(?:の(?:姿|顔))?(?:は|が|も)?\\s*${REPRESENTATION_JA}(?:に|には|上に|では)?(?:映|写|表示|再生|投影|現れ)`, "iu").test(after)) return true;
  if (new RegExp(`^(?:は|が|も)?\\s*${REPRESENTATION_JA}(?:の中|の内|内|の画面|の表示|上)(?:で|では|に|には)`, "iu").test(after)) return true;

  // Reported or attributed action is story information, not direct evidence that its subject is
  // physically in the depicted moment. Keep the reporter eligible through an independent mention.
  if (/(?:によれば|曰く|の話では)(?:[、,]\s*)?$/u.test(before)) return true;
  if (/(?:と|って)[、\s]*[\p{L}\p{N}_・'’\-]{1,30}(?:は|が)\s*(?:言|語|話|報告|説明|主張|述べ|記|伝え)/u.test(after)) return true;
  if (/(?:という|との)(?:報告|説明|証言|記録|話|噂)/u.test(after)) return true;

  if (new RegExp(`(?:${REPRESENTATION_EN}|${AUDIO_SOURCE_EN}|message|email|letter)\\s+(?:of|from|showing|featuring)\\s*$`, "iu").test(before)) return true;
  if (new RegExp(`(?:${REPRESENTATION_EN}|${AUDIO_SOURCE_EN})\\s+(?:shows?|displays?|depicts?|features?|plays?|carries|reflects|identifies|lists|names)\\s*$`, "iu").test(before)) return true;
  if (new RegExp(`(?:over|through|from|on|in)\\s+(?:the\\s+)?(?:${REPRESENTATION_EN}|${AUDIO_SOURCE_EN})[, :]*\\s*$`, "iu").test(before)) return true;
  if (/\b(?:belonging\s+to|owned\s+by)\s*$/iu.test(before)) return true;
  if (/\b(?:hear|hears|heard|hearing|remember|remembers|remembered|recall|recalls|recalled|imagine|imagines|imagined|mention|mentions|mentioned|discuss|discusses|discussed|describe|describes|described)\s*$/iu.test(before)) return true;
  if (/\b(?:talk|talks|talked|talking|speak|speaks|spoke|spoken|speaking|ask|asks|asked|asking|think|thinks|thought|thinking|dream|dreams|dreamed|dreamt|dreaming|wonder|wonders|wondered|wondering)\b[^.!?;]{0,80}\b(?:about|of)\s*$/iu.test(before)) return true;
  if (/\b(?:search|searches|searched|searching|look|looks|looked|looking|hunt|hunts|hunted|hunting|wait|waits|waited|waiting|call|calls|called|calling)\b[^.!?;]{0,80}\bfor\s*$/iu.test(before)) return true;
  if (new RegExp(`^(?:is|was|appears?|appeared)?\\s*(?:shown|displayed|depicted|seen|visible|present)?\\s*(?:on|in)\\s+(?:the\\s+)?${REPRESENTATION_EN}\\b`, "iu").test(after)) return true;
  if (new RegExp(`^(?:is|was)\\s+heard\\s+(?:over|through|from|on)\\s+(?:the\\s+)?${AUDIO_SOURCE_EN}\\b`, "iu").test(after)) return true;
  if (new RegExp(`\\b(?:in|on|inside|within)\\s+(?:(?:the|a|an)\\s+)?${REPRESENTATION_EN}[.]?\\s*$`, "iu").test(after)) return true;
  if (new RegExp(`\\b(?:in|on|inside|within)\\s+(?:(?:the|a|an)\\s+)?${REPRESENTATION_EN}(?=\\s*(?:$|[,.]|[)]|(?:on|at|by|beside|above|below|under|over|from|with|next\\s+to|that|which|where|while|showing|displayed)\\b))`, "iu").test(after)) {
    return true;
  }
  if (/\b(?:according\s+to|reportedly|allegedly)\b/iu.test(`${before} ${after}`)) return true;
  if (/\b(?:says?|said|reports?|reported|claims?|claimed|states?|stated|recalls?|recalled)(?:\s+that)?\s*$/iu.test(before)) return true;

  // Explicit absence is a mention, not presence evidence.
  if (/^(?:は|が|も)?\s*(?:いない|不在|見当たらない|姿がない)/u.test(after)) return true;
  if (/\bwithout\s*$/iu.test(before) || /^(?:is|was)\s+(?:absent|missing|not\s+there)\b/iu.test(after)) return true;
  return false;
}

/**
 * Fail-closed affirmative grammar for a person physically acting in the depicted moment.
 * This deliberately accepts fewer constructions than natural language permits: ambiguous
 * objects, future/modal clauses and reported actions must use an explicit `[[cast: Name]]` tag.
 */
function isAffirmativePhysicalMention(text: string, start: number, end: number, label: string): boolean {
  const bounds = sentenceBounds(text, start);
  const before = text.slice(bounds.start, start).trimEnd();
  const after = text.slice(end, bounds.end).trimStart();
  const asciiLabel = /^[a-z0-9 _'-]+$/iu.test(label);

  if (asciiLabel) {
    if (/\b(?:to|about|of|for|from|without|regarding|toward|towards|against|at|with|by)\s*$/iu.test(before)) return false;
    let predicateClause = after;
    if (!before.trim()) {
      const coordinatedSubject = /^(?:and|&)\s+([\p{L}\p{N}_.'’\-]+(?:\s+[\p{L}\p{N}_.'’\-]+){0,4})\s+(?=(?:is|are|was|were|stands?|stood|sits?|sat|enters?|entered|arrives?|arrived|comes?|came|walks?|walked|runs?|ran|kneels?|knelt|lies?|lay|moves?|moved|leaves?|left)\b)/iu.exec(after);
      if (coordinatedSubject) predicateClause = after.slice(coordinatedSubject[0].length);
    }
    if (/^(?:never|not\b|does\s+not\b|did\s+not\b|will\s+not\b|would\s+not\b|fails?\s+to\b|plans?\s+to\b|intends?\s+to\b|hopes?\s+to\b|expects?\s+to\b|may\b|might\b|could\b|would\b|will\b)/iu.test(predicateClause)) {
      return false;
    }
    if (/^(?:is|are|was|were)\s+(?:standing|sitting|walking|running|kneeling|lying|sleeping|moving|waiting|present|here|there|inside|outside|beside|near|at|in|on)\b/iu.test(predicateClause)) {
      return true;
    }
    return /^(?:stands?|stood|sits?|sat|enters?|entered|arrives?|arrived|comes?|came|walks?|walked|runs?|ran|crosses?|crossed|opens?|opened|closes?|closed|turns?|turned|raises?|raised|lowers?|lowered|holds?|held|carries?|carried|reaches?|reached|touches?|touched|grabs?|grabbed|takes?|took|places?|placed|picks?|picked|drops?|dropped|looks?|looked|watches?|watched|glances?|glanced|smiles?|smiled|laughs?|laughed|cries?|cried|nods?|nodded|shakes?|shook|speaks?|spoke|says?|said|whispers?|whispered|shouts?|shouted|kneels?|knelt|lies?|lay|wakes?|woke|sleeps?|slept|moves?|moved|approaches?|approached|leaves?|left|jumps?|jumped|falls?|fell|fights?|fought|fires?|fired|points?|pointed|gestures?|gestured|writes?|wrote|reads?|read|eats?|ate|drinks?|drank|wears?|wore|removes?|removed|hugs?|hugged)\b/iu.test(predicateClause);
  }

  const subject = /^(?:は|が|も|こそ|さえ|、|,)\s*/u.exec(after);
  const coordinatedSubject = !before.trim() ? /^と[\p{L}\p{N}_・'’\-]{1,40}(?:は|が|も)\s*/u.exec(after) : null;
  if (!subject && !coordinatedSubject) return false;
  const clause = after.slice((subject ?? coordinatedSubject)![0].length);
  if (/(?:ない|なかった|ません|ず(?:に)?|ぬ(?:まま)?|不在|予定|つもり|はず|だろう|でしょう|かもしれ|計画|約束|夢(?:見|想)|想像|回想|思い出)/u.test(clause)) {
    return false;
  }
  return /(?:いる|居る|立|座|入|出|来|現れ|歩|走|駆|振り返|振り向|向き|見つめ|見上げ|見下ろ|見る|開け|閉め|持|握|拾|置|落と|投げ|押|引|触|つか|掴|抱|伸ば|上げ|下げ|笑|泣|叫|うなず|頷|首を振|しゃが|跪|ひざまず|横たわ|倒れ|起き|目覚め|眠|近づ|離れ|通り|渡|飛|跳|戦|撃|構え|話|答え|言う|つぶや|囁|食べ|飲|着|脱|乗|降|書|読|指さ|指差|覗|見守|待つ)/u.test(clause);
}

/**
 * Resolve physical actor evidence from one action/synopsis element. A mere name occurrence is not
 * enough: audio, photographs, screens, recordings, reflections, possessives, and absence clauses
 * are representations or references. Explicit `[[character: Name]]` / `[[cast: Name]]` tags are
 * the author-controlled escape hatch for silent actors.
 */
export function findVisibleActorEvidence(text: string, labels: readonly string[]): VisibleActorEvidence | null {
  const normalizedText = text.normalize("NFKC");
  const normalizedLabels = labels.map((label) => ({ raw: label, normalized: label.normalize("NFKC").trim() })).filter((label) => label.normalized);
  const tags = [...normalizedText.matchAll(/\[\[(?:character|cast)\s*:\s*([^\]]+)\]\]/giu)];
  for (const label of normalizedLabels) {
    const tag = tags.find((candidate) => candidate[1]?.trim().localeCompare(label.normalized, undefined, { sensitivity: "accent" }) === 0);
    if (tag?.index !== undefined) return { kind: "explicit-cast-tag", label: label.raw, index: tag.index };
  }

  const foldedText = normalizedText.toLocaleLowerCase();
  for (const label of normalizedLabels) {
    const foldedLabel = label.normalized.toLocaleLowerCase();
    let offset = 0;
    while (offset <= foldedText.length - foldedLabel.length) {
      const index = foldedText.indexOf(foldedLabel, offset);
      if (index < 0) break;
      const end = index + foldedLabel.length;
      offset = Math.max(end, index + 1);
      if (!isLabelBoundary(foldedText, index, end, foldedLabel)) continue;
      if (isNonPhysicalMention(foldedText, index, end)) continue;
      if (!isAffirmativePhysicalMention(foldedText, index, end, foldedLabel)) continue;
      return { kind: "physical-mention", label: label.raw, index };
    }
  }
  return null;
}

export function actionTextEstablishesVisibleActor(text: string, labels: readonly string[]): boolean {
  return findVisibleActorEvidence(text, labels) !== null;
}
