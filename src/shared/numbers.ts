/**
 * 数値ユーティリティの共有モジュール(`json.ts` と同じ「最小の共有ヘルパ」方針)。
 * pageLayout/pageObjects/mosaicRegion/pasteAttachments/panelShapeEdit 等に散在していた
 * 同一実装(isFiniteNumber ×5、clampNumber ×複数、fmt ×2)をここへ統合した(挙動は不変)。
 */

/** 有限数の型ガード。 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** unknown な数値を [min, max] へクランプする。非数は fallback。 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/** 数値を [min, max] へクランプする。非有限は min(toneSvg/balloonShape の旧ローカル実装と同一)。 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * 数値の SVG 属性向け文字列化(絶対 6 桁丸め)。toneSvg/balloonShape の旧 `fmt` と同一。
 * ※ textSvg(toPrecision(8))・pageLayoutSvg(toFixed(5))・panelBezier(toFixed(6))の
 *   フォーマッタは精度要件が意図的に異なるため統合対象外(各モジュールのコメント参照)。
 */
export function formatSvgNumber(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : "0";
}
