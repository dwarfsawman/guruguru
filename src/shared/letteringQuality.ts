import type { PageLayout } from "./pageLayout";
import type { PageObject, PageVec } from "./pageObjects";

export interface LetteringQualityReport {
  passed: boolean;
  balloonFaceOverlapRatio: number;
  overflowObjectIds: string[];
  lowContrastObjectIds: string[];
}

function luminance(hex: string): number {
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  if (!match) return 0;
  const values = [0, 2, 4].map((offset) => parseInt(match[1]!.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

function sizeOf(object: PageObject): PageVec {
  if (object.kind !== "text") return object.size;
  const count = Math.max(1, Array.from(object.content.text).length);
  return { x: object.content.style.size * Math.min(count, 8), y: object.content.style.size * Math.ceil(count / 8) };
}

/** lettering後の決定的監査。顔bboxは任意で、指定時だけ重なり率を評価する。 */
export function auditLettering(layout: PageLayout, objects: readonly PageObject[], faceBoxes: Array<{ x: number; y: number; width: number; height: number }> = []): LetteringQualityReport {
  const overflowObjectIds: string[] = [];
  const lowContrastObjectIds: string[] = [];
  let overlapArea = 0;
  let balloonArea = 0;
  for (const object of objects) {
    const size = sizeOf(object);
    const box = { x0: object.position.x - size.x / 2, y0: object.position.y - size.y / 2,
      x1: object.position.x + size.x / 2, y1: object.position.y + size.y / 2 };
    if (box.x0 < 0 || box.y0 < 0 || box.x1 > 1 || box.y1 > layout.page.height) overflowObjectIds.push(object.id);
    // tone は image と同じく本文テキストを持たないので、コントラスト監査の対象外にする。
    const text = object.kind === "text" ? object.content : object.kind === "image" || object.kind === "tone" ? null : object.content;
    const background = object.kind === "balloon" || object.kind === "box" ? object.fill : "#ffffff";
    if (text && contrast(text.style.color, background) < 4.5) lowContrastObjectIds.push(object.id);
    if (object.kind === "balloon") {
      const area = Math.max(0, size.x * size.y);
      balloonArea += area;
      for (const face of faceBoxes) {
        overlapArea += Math.max(0, Math.min(box.x1, face.x + face.width) - Math.max(box.x0, face.x)) *
          Math.max(0, Math.min(box.y1, face.y + face.height) - Math.max(box.y0, face.y));
      }
    }
  }
  const balloonFaceOverlapRatio = balloonArea > 0 ? Math.min(1, overlapArea / balloonArea) : 0;
  return { passed: overflowObjectIds.length === 0 && lowContrastObjectIds.length === 0 && balloonFaceOverlapRatio <= 0.2,
    balloonFaceOverlapRatio, overflowObjectIds, lowContrastObjectIds };
}
