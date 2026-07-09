/**
 * `textLayout.ts` のレイアウト結果を SVG フラグメント文字列にする(Docs/Feature-CGCollectionSuite.md P2)。
 * 純ロジックのみ — クライアント(`pagePanelLightboxView.ts`)とサーバ(`openRasterExport.ts`)の両方が
 * この関数を呼ぶことで、プレビューと書き出しの見た目を一致させる(P2 の核方針: `<text>` は使わず、
 * 全てグリフアウトライン `<path>` として出力する)。
 *
 * 座標系は `textLayout.ts` と同じ「ブロック中心 = 原点」の page 単位。呼び出し側は返ってきた `<g>` を
 * 「1 page 単位 = N px(または SVG 単位)」の親コンテナに置き、必要ならその親でさらに canvas ピクセルへの
 * (非等方な場合もある)スケールを掛ける -- このモジュール自身は常に等方(1x=1y)の page 単位で完結する。
 */
import type { TextStyle } from "./pageObjects";
import type { PositionedGlyph, TextLayoutResult } from "./textLayout";

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 数値の SVG 属性向け文字列化。**有効数字8桁ベース**(絶対丸めではない)。
 * `scale(${fmt(glyph.emScale)})` の emScale は `style.size / unitsPerEm` で、unitsPerEm=2048 の
 * フォント(Yu Gothic 等の日本語 TTC に多い)だと size=0.03 のとき ≈1.4648e-5 -- これを小数第5位への
 * 絶対丸めにすると 1e-5 に潰れてグリフが約32%縮み、unitsPerEm=1000 のフォントと実効サイズがずれる。
 * translate 座標(page 単位)は絶対精度で足りるが scale 値は相対精度が要るため、全属性を
 * `toPrecision(8)` で統一する。`toPrecision` の返す指数表記("1.4648438e-5" 等)も SVG transform
 * では有効だが、表記を正規化するため `Number()` を一度通す。
 */
function fmt(value: number): string {
  return Number.isFinite(value) ? Number(value.toPrecision(8)).toString() : "0";
}

/**
 * 1グリフ分の `<path>`。フチ(outlineColor/outlineWidth)があれば同一パスを stroke で背面に重ねて
 * 白フチ等を表現する(fill パスが前面)。stroke-width はグリフのローカル座標系(フォント内部単位)で
 * 指定する必要がある -- `transform` の scale(emScale) がストロークにも掛かるため、
 * 目的のページ単位幅(outlineWidth * style.size)を emScale で逆算する
 * (`localStrokeWidth = outlineWidth * style.size / emScale`)。
 */
function renderGlyph(glyph: PositionedGlyph, style: TextStyle): string {
  const transform = `translate(${fmt(glyph.x)} ${fmt(glyph.y)}) scale(${fmt(glyph.emScale)} ${fmt(-glyph.emScale)})${
    glyph.rotationDeg ? ` rotate(${fmt(glyph.rotationDeg)} ${fmt(glyph.centerX)} ${fmt(glyph.centerY)})` : ""
  }`;
  let outline = "";
  if (style.outlineColor && style.outlineWidth) {
    const localStrokeWidth = (style.outlineWidth * style.size) / Math.max(1e-9, glyph.emScale);
    outline = `<path d="${escapeAttr(glyph.pathD)}" transform="${transform}" fill="none" stroke="${escapeAttr(
      style.outlineColor
    )}" stroke-width="${fmt(localStrokeWidth)}" stroke-linejoin="round" stroke-linecap="round" />`;
  }
  const fill = `<path d="${escapeAttr(glyph.pathD)}" transform="${transform}" fill="${escapeAttr(style.color)}" />`;
  return `${outline}${fill}`;
}

/**
 * レイアウト結果を SVG `<g>` へ変換する。`anchor` は TextObject.position(ブロック中心の配置先、page 座標)、
 * `rotation` は object 全体の回転(ラジアン)。レイアウト自体は既にブロック中心=原点で組まれている
 * (`layoutText` 参照)ので、ここでは平行移動+回転を1回かけるだけでよい。
 */
export function renderTextSvg(
  layout: TextLayoutResult,
  anchor: { x: number; y: number },
  rotation: number,
  style: TextStyle
): string {
  const deg = (rotation * 180) / Math.PI;
  const groupTransform = `translate(${fmt(anchor.x)} ${fmt(anchor.y)})${deg ? ` rotate(${fmt(deg)})` : ""}`;
  const glyphs = layout.glyphs.map((glyph) => renderGlyph(glyph, style)).join("");
  return `<g class="page-object-text-glyphs" transform="${groupTransform}">${glyphs}</g>`;
}
