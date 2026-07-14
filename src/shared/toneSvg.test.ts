import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToneSvg, type ToneSvgInput } from "./toneSvg.ts";
import { TONE_COUNT_MAX, TONE_PITCH_MAX, TONE_PITCH_MIN, defaultToneParams, type ToneKind } from "./pageObjects.ts";

const ALL_TONE_KINDS: ToneKind[] = ["halftone", "gradient", "lines", "speed", "focus", "flash"];

function toneInput(toneType: ToneKind, overrides: Partial<Omit<ToneSvgInput, "toneType">> = {}): ToneSvgInput {
  return {
    id: "tone_1",
    toneType,
    size: { x: 0.3, y: 0.3 },
    color: "#000000",
    opacity: 1,
    seed: 42,
    params: defaultToneParams(toneType),
    ...overrides
  };
}

test("renderToneSvg: 同一オブジェクトは常に同一SVG文字列(決定性)", () => {
  for (const toneType of ALL_TONE_KINDS) {
    const object = toneInput(toneType);
    const a = renderToneSvg(object, { x: 0.5, y: 0.4 }, 0.2);
    const b = renderToneSvg(object, { x: 0.5, y: 0.4 }, 0.2);
    assert.equal(a, b, `${toneType}: 同じ入力からは同じ出力`);
    assert.ok(!a.includes("NaN"), `${toneType}: NaN を含まない`);
  }
});

test("renderToneSvg: speed/focus/flash は seed を変えると出力が変わる(halftone 等は変わらない)", () => {
  for (const toneType of ["speed", "focus", "flash"] as ToneKind[]) {
    const a = renderToneSvg(toneInput(toneType, { seed: 1 }), { x: 0, y: 0 }, 0);
    const b = renderToneSvg(toneInput(toneType, { seed: 2 }), { x: 0, y: 0 }, 0);
    assert.notEqual(a, b, `${toneType}: seed 1 と 2 で出力が異なるべき`);
  }
  for (const toneType of ["halftone", "gradient", "lines"] as ToneKind[]) {
    const a = renderToneSvg(toneInput(toneType, { seed: 1 }), { x: 0, y: 0 }, 0);
    const b = renderToneSvg(toneInput(toneType, { seed: 2 }), { x: 0, y: 0 }, 0);
    assert.equal(a, b, `${toneType}: 幾何のみの決定的パターンなので seed が変わっても出力は不変`);
  }
});

test("renderToneSvg: halftone/lines/gradient の pitch は下限0.004・上限0.1へ clamp される", () => {
  for (const toneType of ["halftone", "lines", "gradient"] as ToneKind[]) {
    const tooLarge = renderToneSvg(toneInput(toneType, { params: { ...defaultToneParams(toneType), pitch: 999 } }), { x: 0, y: 0 }, 0);
    const tooLargeMatch = tooLarge.match(/<pattern[^>]*width="([^"]+)"/);
    assert.ok(tooLargeMatch, `${toneType}: pattern の width 属性が見つかる`);
    assert.ok(Number(tooLargeMatch![1]) <= TONE_PITCH_MAX + 1e-9, `${toneType}: pitch は上限へ clamp`);

    const tooSmall = renderToneSvg(toneInput(toneType, { params: { ...defaultToneParams(toneType), pitch: -5 } }), { x: 0, y: 0 }, 0);
    const tooSmallMatch = tooSmall.match(/<pattern[^>]*width="([^"]+)"/);
    assert.ok(tooSmallMatch);
    assert.ok(Number(tooSmallMatch![1]) >= TONE_PITCH_MIN - 1e-9, `${toneType}: pitch は下限へ clamp`);
  }
});

test("renderToneSvg: speed/focus の count は400へ clamp される(三角形の個数=M の出現数)", () => {
  const speedSvg = renderToneSvg(toneInput("speed", { params: { ...defaultToneParams("speed"), count: 999999 } }), { x: 0, y: 0 }, 0);
  assert.equal((speedSvg.match(/M /g) ?? []).length, TONE_COUNT_MAX);

  const focusSvg = renderToneSvg(toneInput("focus", { params: { ...defaultToneParams("focus"), count: 999999 } }), { x: 0, y: 0 }, 0);
  assert.equal((focusSvg.match(/M /g) ?? []).length, TONE_COUNT_MAX);

  const smallCount = renderToneSvg(toneInput("speed", { params: { ...defaultToneParams("speed"), count: 0 } }), { x: 0, y: 0 }, 0);
  assert.equal((smallCount.match(/M /g) ?? []).length, 1, "count は 1 未満にはならない");
});

test("renderToneSvg: id が異なれば defs の id(pattern/mask/gradient/clipPath)が衝突しない", () => {
  const a = renderToneSvg(toneInput("gradient", { id: "tone_a" }), { x: 0, y: 0 }, 0);
  const b = renderToneSvg(toneInput("gradient", { id: "tone_b" }), { x: 0, y: 0 }, 0);
  const ids = [...`${a}${b}`.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 4, "id を持つ defs 要素が複数存在する");
  assert.equal(new Set(ids).size, ids.length, "2オブジェクト分の id が全て一意");
});

test("renderToneSvg: focus は innerRadius より内側に線の先端(tip)が届かない", () => {
  const innerRadius = 0.12;
  const object = toneInput("focus", { params: { ...defaultToneParams("focus"), innerRadius, jitter: 1, count: 40 } });
  const svg = renderToneSvg(object, { x: 0, y: 0 }, 0);
  const matches = [...svg.matchAll(/M ([-\d.e]+) ([-\d.e]+) L ([-\d.e]+) ([-\d.e]+) L ([-\d.e]+) ([-\d.e]+) Z/g)];
  assert.equal(matches.length, 40);
  for (const m of matches) {
    const tipX = Number(m[3]);
    const tipY = Number(m[4]);
    const dist = Math.hypot(tipX, tipY);
    assert.ok(dist >= innerRadius - 1e-6, `tip までの距離 ${dist} は innerRadius ${innerRadius} 以上であるべき`);
  }
});

test("renderToneSvg: focus は中心(params.center)がオブジェクト中心からずれていても innerRadius を守る", () => {
  const innerRadius = 0.1;
  const center = { x: 0.08, y: -0.05 };
  const object = toneInput("focus", { params: { ...defaultToneParams("focus"), center, innerRadius, jitter: 0.8, count: 24 } });
  const svg = renderToneSvg(object, { x: 0, y: 0 }, 0);
  const matches = [...svg.matchAll(/M ([-\d.e]+) ([-\d.e]+) L ([-\d.e]+) ([-\d.e]+) L ([-\d.e]+) ([-\d.e]+) Z/g)];
  assert.equal(matches.length, 24);
  for (const m of matches) {
    const tipX = Number(m[3]);
    const tipY = Number(m[4]);
    const dist = Math.hypot(tipX - center.x, tipY - center.y);
    assert.ok(dist >= innerRadius - 1e-6);
  }
});

test("renderToneSvg: opacity は外側 g へそのまま反映される", () => {
  const svg = renderToneSvg(toneInput("halftone", { opacity: 0.4 }), { x: 0, y: 0 }, 0);
  assert.match(svg, /class="page-object-tone-shape"[^>]*opacity="0.4"/);
});

test("renderToneSvg: rotation=0 なら外側 g に rotate(...) を出力しない(box/balloon と同じ規約)", () => {
  // halftone/lines/gradient は patternTransform="rotate(angle)" を内部で常に使うため、
  // ここでは内部に rotate 文字列を含まない speed で「外側 g の回転」だけを検証する。
  const svg = renderToneSvg(toneInput("speed"), { x: 0.2, y: 0.3 }, 0);
  assert.ok(svg.startsWith('<g class="page-object-tone-shape" transform="translate(0.2 0.3)"'));
  assert.ok(!svg.includes("rotate"));

  const rotated = renderToneSvg(toneInput("speed"), { x: 0.2, y: 0.3 }, Math.PI / 4);
  assert.match(rotated, /transform="translate\(0.2 0.3\) rotate\(45\)"/);
});

test("renderToneSvg: flash は領域塗り + 白抜き星形(非透過 #ffffff)の2要素になる", () => {
  const svg = renderToneSvg(toneInput("flash"), { x: 0, y: 0 }, 0);
  assert.match(svg, /<rect[^>]*fill="#000000"/);
  assert.match(svg, /<polygon[^>]*fill="#ffffff"/);
});

test("renderToneSvg: 全種別が sharp/librsvg 互換の要素のみで構成される(<text> を使わない)", () => {
  for (const toneType of ALL_TONE_KINDS) {
    const svg = renderToneSvg(toneInput(toneType), { x: 0, y: 0 }, 0);
    assert.ok(!svg.includes("<text"), `${toneType}: <text> は使わない`);
  }
});
