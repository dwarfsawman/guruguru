import { panelBounds, type LayoutPanel } from "./pageLayout";
import type { PanelSpec } from "./mangaPlanV2";
import type { BoxObject, PageObject } from "./pageObjects";

export type MangaEffectKind = "focus-lines" | "speed-lines" | "none";

/** 自動付与していた集中線・スピード線オブジェクトを識別する。 */
export function isMangaEffectObject(object: Pick<PageObject, "id" | "kind">): boolean {
  return object.kind === "box" && /^(effect:[^:]+:(?:focus-lines|speed-lines)):\d+$/.test(object.id);
}

export function inferMangaEffect(panel: PanelSpec): MangaEffectKind {
  const text = `${panel.shot.compositionIntent} ${panel.cast.map((member) => member.action).join(" ")}`;
  if (/\b(?:run|dash|fly|charge|impact|strike|speed|motion)\b/iu.test(text)) return "speed-lines";
  if (panel.shot.size === "close-up" || /\b(?:focus|reveal|dramatic|tower|awe|shock)\b/iu.test(text)) return "focus-lines";
  return "none";
}

/** 効果線を明示的に有効化する場合の生成ロジック。標準のmaterialize経路では使用しない。 */
export function createMangaEffectObjects(panel: PanelSpec, layoutPanel: LayoutPanel): BoxObject[] {
  const kind = inferMangaEffect(panel);
  if (kind === "none") return [];
  const [x0, y0, x1, y1] = panelBounds(layoutPanel.shape);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const width = x1 - x0, height = y1 - y0;
  const count = kind === "focus-lines" ? 12 : 9;
  return Array.from({ length: count }, (_, index) => {
    const angle = kind === "focus-lines" ? (Math.PI * 2 * index) / count : -0.38 + index * 0.018;
    const radial = kind === "focus-lines" ? 0.36 : -0.35 + (index / Math.max(1, count - 1)) * 0.7;
    const position = kind === "focus-lines"
      ? { x: cx + Math.cos(angle) * width * radial, y: cy + Math.sin(angle) * height * radial }
      : { x: cx + width * radial, y: cy + height * radial * 0.3 };
    return {
      id: `effect:${panel.id}:${kind}:${index}`, kind: "box" as const, position, rotation: angle,
      size: { x: Math.max(0.04, width * 0.26), y: Math.max(0.0015, Math.min(width, height) * 0.006) },
      cornerRadius: 0, fill: "#111111", strokeColor: "#111111", strokeWidth: 0
    };
  });
}
