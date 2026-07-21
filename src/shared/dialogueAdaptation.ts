import type { DialogueBalloonStyle, DialogueSemanticKind } from "./apiTypes";
import type { FountainDoc } from "./fountain";

export interface DialogueUnit {
  id: string;
  sourceLineId?: string;
  sourceElementId?: string;
  part: number;
  of: number;
  text: string;
  semanticKind: DialogueSemanticKind;
  balloonStyle: DialogueBalloonStyle;
  intensity?: "low" | "medium" | "high";
  placement?: "panel-center" | "edge" | "background";
}

function normalized(text: string): string {
  return text.replace(/\s+/gu, "");
}

/** 字句を一切変えず、句読点を含む呼吸単位へ分割する。 */
export function splitDialogueUnits(input: {
  lineId: string;
  text: string;
  semanticKind: DialogueSemanticKind;
  balloonStyle: DialogueBalloonStyle;
  maxChars?: number;
}): DialogueUnit[] {
  const maxChars = Math.max(8, input.maxChars ?? 12);
  const phrases = input.text.match(/[^、。！？!?]+[、。！？!?]?|[、。！？!?]+/gu) ?? [input.text];
  const parts: string[] = [];
  let current = "";
  for (const phrase of phrases) {
    if (current && Array.from(current + phrase).length > maxChars) {
      parts.push(current);
      current = "";
    }
    if (Array.from(phrase).length <= maxChars) {
      current += phrase;
      continue;
    }
    if (current) { parts.push(current); current = ""; }
    const chars = Array.from(phrase);
    while (chars.length > maxChars) parts.push(chars.splice(0, maxChars).join(""));
    current = chars.join("");
  }
  if (current || parts.length === 0) parts.push(current);
  if (normalized(parts.join("")) !== normalized(input.text)) throw new Error(`Dialogue adaptation changed source text: ${input.lineId}`);
  // 空文字入力は parts=[""] になり空吹き出しが1件生まれるため、空 unit は返さない。
  if (parts.length === 1 && parts[0] === "") return [];
  return parts.map((text, index) => ({
    id: `unit:${input.lineId}:${index + 1}`,
    sourceLineId: input.lineId,
    part: index + 1,
    of: parts.length,
    text,
    semanticKind: input.semanticKind,
    balloonStyle: input.balloonStyle
  }));
}

/** fillの決定的抽出: action内《…》をmonitor、scene headingをcaptionにする。 */
export function extractFillUnits(doc: FountainDoc, sourceId: (sceneIndex: number, elementIndex: number) => string): DialogueUnit[] {
  const units: DialogueUnit[] = [];
  doc.scenes.forEach((scene, sceneIndex) => {
    if (scene.heading.trim()) {
      units.push({ id: `fill:scene:${sceneIndex}`, sourceElementId: `scene-heading:${sceneIndex}`, part: 1, of: 1,
        text: scene.heading.trim(), semanticKind: "narration", balloonStyle: "caption" });
    }
    scene.elements.forEach((element, elementIndex) => {
      if (element.type !== "action") return;
      let matchIndex = 0;
      for (const match of element.text.matchAll(/《([^》]+)》/gu)) {
        const text = match[1]!.trim();
        if (!text) continue;
        const sourceElementId = sourceId(sceneIndex, elementIndex);
        units.push({ id: `fill:${sourceElementId}:${matchIndex++}`, sourceElementId, part: 1, of: 1,
          text, semanticKind: "narration", balloonStyle: "monitor" });
      }
      const effects: Array<[RegExp, string, DialogueUnit["intensity"]]> = [
        [/(?:大爆発|爆発)/u, "ドカーン", "high"], [/(?:砲撃|発砲|銃声)/u, "ズガン", "high"],
        [/(?:衝突|激突)/u, "ガン", "medium"], [/(?:警報|アラーム)/u, "ビーッ", "medium"]
      ];
      for (const [pattern, text, intensity] of effects) {
        if (!pattern.test(element.text)) continue;
        const sourceElementId = sourceId(sceneIndex, elementIndex);
        units.push({ id: `sfx:${sourceElementId}:${text}`, sourceElementId, part: 1, of: 1, text,
          semanticKind: "sfx", balloonStyle: "sfx", intensity, placement: "panel-center" });
      }
    });
  });
  return units;
}
