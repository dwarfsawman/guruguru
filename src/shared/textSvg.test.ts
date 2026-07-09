import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutText, type FontMetricsProvider, type GlyphMetrics } from "./textLayout.ts";
import { renderTextSvg } from "./textSvg.ts";
import type { TextContent, TextStyle } from "./pageObjects.ts";

/**
 * fmt の精度リグレッションテスト(監督レビュー指摘)。
 * emScale = style.size / unitsPerEm は unitsPerEm=2048(Yu Gothic 等の日本語 TTC に多い)かつ
 * size=0.03 のとき ≈1.46484375e-5。旧実装(小数第5位への絶対丸め)ではこれが 1e-5 に潰れて
 * グリフが約32%縮んでいた。有効数字ベース(toPrecision(8))で相対精度が保たれることを
 * SVG 出力文字列で直接 assert する。
 */

function providerWithUnitsPerEm(unitsPerEm: number): FontMetricsProvider {
  return {
    unitsPerEm,
    ascent: unitsPerEm * 0.8,
    descent: -unitsPerEm * 0.2,
    getGlyph(): GlyphMetrics {
      return { pathD: "M0,0L100,100Z", advanceWidth: unitsPerEm * 0.6 };
    }
  };
}

function style(size: number): TextStyle {
  return { fontId: "default", size, direction: "horizontal", color: "#000000" };
}

function content(text: string, size: number): TextContent {
  return { text, style: style(size) };
}

test("renderTextSvg: unitsPerEm=2048/size=0.03 の emScale が 1e-5 に潰れない(有効数字が保たれる)", () => {
  const emScale = 0.03 / 2048; // ≈1.46484375e-5
  const layout = layoutText(providerWithUnitsPerEm(2048), content("あ", 0.03));
  const svg = renderTextSvg(layout, { x: 0.5, y: 0.5 }, 0, style(0.03));
  // 旧実装の桁落ち値(scale(0.00001 -0.00001))が出力に現れないこと。
  assert.ok(!svg.includes("scale(0.00001 "), `emScale が 1e-5 に桁落ちしている: ${svg}`);
  // 期待値: toPrecision(8) → Number() 正規化後の文字列がそのまま scale(...) に入る。
  const expected = Number(emScale.toPrecision(8)).toString();
  assert.ok(
    svg.includes(`scale(${expected} -${expected})`),
    `scale に有効数字8桁の emScale(${expected})が入っていない: ${svg}`
  );
  // 相対誤差が 1e-6 未満であること(丸め方式が変わっても実効サイズがずれない保証)。
  const match = svg.match(/scale\(([^ ]+) /);
  assert.ok(match, "scale 属性が見つからない");
  const actual = Number(match![1]);
  assert.ok(Math.abs(actual - emScale) / emScale < 1e-6, `emScale の相対誤差が大きすぎる: ${actual} vs ${emScale}`);
});

test("renderTextSvg: unitsPerEm=1000 と 2048 で実効サイズ(emScale×unitsPerEm)が一致する", () => {
  const size = 0.03;
  const scaleFor = (unitsPerEm: number): number => {
    const layout = layoutText(providerWithUnitsPerEm(unitsPerEm), content("A", size));
    const svg = renderTextSvg(layout, { x: 0, y: 0 }, 0, style(size));
    const match = svg.match(/scale\(([^ ]+) /);
    assert.ok(match, `scale 属性が見つからない: ${svg}`);
    return Number(match![1]) * unitsPerEm;
  };
  const effective1000 = scaleFor(1000);
  const effective2048 = scaleFor(2048);
  // どちらも「emScale × unitsPerEm = style.size」に(丸め誤差の範囲で)一致するはず。
  assert.ok(Math.abs(effective1000 - size) / size < 1e-6, `unitsPerEm=1000 の実効サイズずれ: ${effective1000}`);
  assert.ok(Math.abs(effective2048 - size) / size < 1e-6, `unitsPerEm=2048 の実効サイズずれ: ${effective2048}`);
});
