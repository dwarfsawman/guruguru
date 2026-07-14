import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveGradientPoints, renderToneSvg, type ToneSvgInput } from "./toneSvg.ts";
import {
  TONE_COUNT_MAX,
  TONE_NOISE_GRAIN_MAX,
  TONE_NOISE_GRAIN_MIN,
  TONE_PITCH_MAX,
  TONE_PITCH_MIN,
  defaultToneParams,
  type ToneKind
} from "./pageObjects.ts";

// noise/snow は Docs/Feature-ScreenTones.md 追補(2026-07-14)で追加。
const ALL_TONE_KINDS: ToneKind[] = ["halftone", "gradient", "lines", "speed", "focus", "flash", "noise", "snow"];

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

test("renderToneSvg: speed/focus/flash/noise/snow は seed を変えると出力が変わる(halftone 等は変わらない)", () => {
  // noise(粒の位置)/snow(楕円の位置)も seed 付き PRNG を使うため、変化するグループに入る(2026-07-14 追補)。
  for (const toneType of ["speed", "focus", "flash", "noise", "snow"] as ToneKind[]) {
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

test("renderToneSvg: halftone/lines の pitch は下限0.004・上限0.1へ clamp される", () => {
  // gradient は 2026-07-14 追補で <pattern> を使わない行生成(circle 群)へ変わったため、
  // pitch clamp の検証は別テスト(circle 個数の増減)で行う。
  for (const toneType of ["halftone", "lines"] as ToneKind[]) {
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

test("renderToneSvg: gradient は pitch を下限0.004・上限0.1へ clamp する(circle 個数の増減で検証)", () => {
  const size = { x: 0.3, y: 0.3 };
  const tooLarge = renderToneSvg(toneInput("gradient", { size, params: { ...defaultToneParams("gradient"), pitch: 999 } }), { x: 0, y: 0 }, 0);
  const tooSmall = renderToneSvg(toneInput("gradient", { size, params: { ...defaultToneParams("gradient"), pitch: -5 } }), { x: 0, y: 0 }, 0);
  const countLarge = (tooLarge.match(/<circle/g) ?? []).length;
  const countSmall = (tooSmall.match(/<circle/g) ?? []).length;
  assert.ok(countLarge > 0, "上限 clamp 後も少なくとも1個は描かれる");
  assert.ok(countSmall > countLarge, `pitch が細かいほどドット数は増える(large=${countLarge}, small=${countSmall})`);
  assert.ok(!tooLarge.includes("NaN") && !tooSmall.includes("NaN"));
});

test("renderToneSvg: gradient は要素数バジェット(約2万ドット)を超えないよう実効 pitch を自動で粗くする", () => {
  // 領域最大サイズ(PAGE_OBJECT_MAX_SIZE相当)× pitch 下限、という最悪ケースでもバジェット内に収まること。
  const object = toneInput("gradient", {
    size: { x: 5, y: 5 },
    params: { ...defaultToneParams("gradient"), pitch: TONE_PITCH_MIN }
  });
  const svg = renderToneSvg(object, { x: 0, y: 0 }, 0);
  const circleCount = (svg.match(/<circle/g) ?? []).length;
  assert.ok(circleCount > 0, "少なくとも1個は描かれる");
  assert.ok(circleCount <= 25000, `要素数バジェット(約2万)を大きく超えないはず(実測 ${circleCount})`);
  assert.ok(!svg.includes("NaN"));
});

test("renderToneSvg: gradient はドット半径が startRatio→endRatio へ実際に遷移する(v1のマスク近似ではない)", () => {
  const object = toneInput("gradient", {
    size: { x: 0.3, y: 0.3 },
    params: { pitch: 0.03, dotRatio: 0.45, angle: 0, startRatio: 1, endRatio: 0.1 }
  });
  const svg = renderToneSvg(object, { x: 0, y: 0 }, 0);
  assert.ok(!svg.includes("<mask"), "v2 は mask を使わず、ドット半径そのものを変える");
  const radii = [...svg.matchAll(/<circle[^>]*r="([^"]+)"/g)].map((m) => Number(m[1]));
  assert.ok(radii.length > 1, "複数のドットが生成される");
  const maxRadius = Math.max(...radii);
  const minRadius = Math.min(...radii);
  assert.ok(maxRadius > minRadius * 2, `半径が角度方向に大きく遷移しているはず(max=${maxRadius}, min=${minRadius})`);
});

test("renderToneSvg: speed/focus の count は400へ clamp される(三角形の個数=M の出現数)", () => {
  const speedSvg = renderToneSvg(toneInput("speed", { params: { ...defaultToneParams("speed"), count: 999999 } }), { x: 0, y: 0 }, 0);
  assert.equal((speedSvg.match(/M /g) ?? []).length, TONE_COUNT_MAX);

  const focusSvg = renderToneSvg(toneInput("focus", { params: { ...defaultToneParams("focus"), count: 999999 } }), { x: 0, y: 0 }, 0);
  assert.equal((focusSvg.match(/M /g) ?? []).length, TONE_COUNT_MAX);

  const smallCount = renderToneSvg(toneInput("speed", { params: { ...defaultToneParams("speed"), count: 0 } }), { x: 0, y: 0 }, 0);
  assert.equal((smallCount.match(/M /g) ?? []).length, 1, "count は 1 未満にはならない");
});

test("renderToneSvg: snow の count(前面+背面の合計)は400へ clamp される(ellipse の出現数)", () => {
  const svg = renderToneSvg(toneInput("snow", { params: { ...defaultToneParams("snow"), count: 999999 } }), { x: 0, y: 0 }, 0);
  const ellipseCount = (svg.match(/<ellipse/g) ?? []).length;
  assert.equal(ellipseCount, TONE_COUNT_MAX, "frontCount+backCount の合計が上限と一致する");
});

test("renderToneSvg: id が異なれば defs の id(pattern/mask/clipPath)が衝突しない", () => {
  // gradient は 2026-07-14 追補で pattern/mask を使わなくなったため、複数 defs id を持つ
  // halftone で検証する(意図は変わらず「id 一意性」)。
  const a = renderToneSvg(toneInput("halftone", { id: "tone_a" }), { x: 0, y: 0 }, 0);
  const b = renderToneSvg(toneInput("halftone", { id: "tone_b" }), { x: 0, y: 0 }, 0);
  const ids = [...`${a}${b}`.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 4, "id を持つ defs 要素が複数存在する");
  assert.equal(new Set(ids).size, ids.length, "2オブジェクト分の id が全て一意");
});

test("renderToneSvg: noise/snow も defs の id がオブジェクトごとに一意(pattern/filter)", () => {
  const noiseA = renderToneSvg(toneInput("noise", { id: "n_a" }), { x: 0, y: 0 }, 0);
  const noiseB = renderToneSvg(toneInput("noise", { id: "n_b" }), { x: 0, y: 0 }, 0);
  const noiseIds = [...`${noiseA}${noiseB}`.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(noiseIds.length >= 4, "pattern + regionクリップ ×2オブジェクトで最低4つ");
  assert.equal(new Set(noiseIds).size, noiseIds.length, "noise の id が全て一意");

  const snowParams = { ...defaultToneParams("snow"), frontBlur: 0.5, backBlur: 0.5 };
  const snowA = renderToneSvg(toneInput("snow", { id: "s_a", params: snowParams }), { x: 0, y: 0 }, 0);
  const snowB = renderToneSvg(toneInput("snow", { id: "s_b", params: snowParams }), { x: 0, y: 0 }, 0);
  const snowIds = [...`${snowA}${snowB}`.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(snowIds.length >= 6, "front/back 2フィルタ + regionクリップ ×2オブジェクトで最低6つ");
  assert.equal(new Set(snowIds).size, snowIds.length, "snow の id が全て一意");
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

test("renderToneSvg: focus は outerRadius 指定時、外側の端が center から outerRadius 付近に収まる(未指定は領域端まで)", () => {
  const size = { x: 0.6, y: 0.6 };
  const withOuter = toneInput("focus", { size, params: { ...defaultToneParams("focus"), outerRadius: 0.15 } });
  const svgWithOuter = renderToneSvg(withOuter, { x: 0, y: 0 }, 0);
  const matchesWithOuter = [...svgWithOuter.matchAll(/M ([-\d.e]+) ([-\d.e]+) L/g)];
  assert.equal(matchesWithOuter.length, 72, "既定 count=72 本すべてで基部(外側端)を確認する");
  for (const m of matchesWithOuter) {
    const dist = Math.hypot(Number(m[1]), Number(m[2]));
    assert.ok(Math.abs(dist - 0.15) < 0.02, `outerRadius 指定時、基部は center から約0.15のはず(実測 ${dist})`);
  }

  const withoutOuter = toneInput("focus", { size, params: defaultToneParams("focus") });
  const svgWithoutOuter = renderToneSvg(withoutOuter, { x: 0, y: 0 }, 0);
  const matchesWithoutOuter = [...svgWithoutOuter.matchAll(/M ([-\d.e]+) ([-\d.e]+) L/g)];
  assert.equal(matchesWithoutOuter.length, 72);
  for (const m of matchesWithoutOuter) {
    const dist = Math.hypot(Number(m[1]), Number(m[2]));
    assert.ok(dist > 0.2, `outerRadius 未指定なら領域端(0.3超)まで届くはず(実測 ${dist})`);
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

/** flash の白抜き星形 polygon の頂点列を [x,y][] へパースする(テスト用)。 */
function flashPolygonPoints(svg: string): Array<{ x: number; y: number }> {
  const match = svg.match(/<polygon[^>]*points="([^"]+)"/);
  assert.ok(match, "flash の polygon が存在する");
  return match![1].split(" ").map((pair) => {
    const [x, y] = pair.split(",").map(Number);
    return { x: x!, y: y! };
  });
}

test("renderToneSvg: flash は山(棘)と谷(白核の縁)が交互の星形 -- 谷は innerRadius 以下・山は必ず外へ突き出す(2026-07-15 刷新)", () => {
  const innerRadius = 0.18;
  const count = 72;
  const object = toneInput("flash", { size: { x: 0.8, y: 0.8 } });
  const svg = renderToneSvg(object, { x: 0, y: 0 }, 0);
  const points = flashPolygonPoints(svg);
  assert.equal(points.length, count * 2, "頂点数 = 山と谷で count の2倍");
  for (let i = 0; i < points.length; i += 1) {
    const dist = Math.hypot(points[i]!.x, points[i]!.y);
    if (i % 2 === 0) {
      assert.ok(dist > innerRadius + 1e-9, `偶数番目=山は innerRadius より外(実測 ${dist})`);
    } else {
      assert.ok(dist <= innerRadius + 1e-6, `奇数番目=谷は innerRadius 以下(実測 ${dist})`);
    }
  }
  // 頂点列の角度が単調(自己交差しない星形)であることも確認する。
  let prev = Math.atan2(points[0]!.y, points[0]!.x);
  for (let i = 1; i < points.length; i += 1) {
    let theta = Math.atan2(points[i]!.y, points[i]!.x);
    while (theta <= prev) {
      theta += Math.PI * 2;
    }
    assert.ok(theta - prev < Math.PI, "隣接頂点の角度差は正で半周未満(単調増加)");
    prev = theta;
  }
});

test("renderToneSvg: flash の count は 400 へ clamp され、center オフセットが星形へ反映される", () => {
  const clamped = renderToneSvg(toneInput("flash", { params: { ...defaultToneParams("flash"), count: 999999 } }), { x: 0, y: 0 }, 0);
  assert.equal(flashPolygonPoints(clamped).length, TONE_COUNT_MAX * 2);

  const center = { x: 0.07, y: -0.04 };
  const innerRadius = 0.1;
  const shifted = renderToneSvg(
    toneInput("flash", { size: { x: 0.8, y: 0.8 }, params: { ...defaultToneParams("flash"), center, innerRadius } }),
    { x: 0, y: 0 },
    0
  );
  for (const [i, point] of flashPolygonPoints(shifted).entries()) {
    const dist = Math.hypot(point.x - center.x, point.y - center.y);
    if (i % 2 === 1) {
      assert.ok(dist <= innerRadius + 1e-6, `谷は center 基準で innerRadius 以下(実測 ${dist})`);
    }
  }
});

test("effectiveGradientPoints: 未指定は angle 由来の領域両端、指定時はそのまま、退化(2点一致)は angle へフォールバック", () => {
  const hx = 0.15;
  const hy = 0.1;
  // angle=0 → dir=(1,0) → 始点/終点は x 軸の投影両端。
  const fallback = effectiveGradientPoints("gradient", { angle: 0 }, hx, hy);
  assert.ok(Math.abs(fallback.start.x - -hx) < 1e-9 && Math.abs(fallback.start.y) < 1e-9);
  assert.ok(Math.abs(fallback.end.x - hx) < 1e-9 && Math.abs(fallback.end.y) < 1e-9);

  const explicit = effectiveGradientPoints("gradient", { angle: 0, gradStart: { x: -0.02, y: 0.03 }, gradEnd: { x: 0.05, y: -0.01 } }, hx, hy);
  assert.deepEqual(explicit.start, { x: -0.02, y: 0.03 });
  assert.deepEqual(explicit.end, { x: 0.05, y: -0.01 });

  const degenerate = effectiveGradientPoints("gradient", { angle: 0, gradStart: { x: 0.01, y: 0.01 }, gradEnd: { x: 0.01, y: 0.01 } }, hx, hy);
  assert.ok(Math.abs(degenerate.start.x - -hx) < 1e-9, "同一点は使わず angle 由来へフォールバック");
});

test("effectiveGradientPoints: lines のフォールバックは縞(angle)と直交=angle+90 方向の領域両端(2026-07-15 追補2)", () => {
  const hx = 0.15;
  const hy = 0.1;
  // lines の angle=0(縞は横方向)→ 遷移軸は +90°=下向き → 始点/終点は y 軸の投影両端。
  const fallback = effectiveGradientPoints("lines", { angle: 0 }, hx, hy);
  assert.ok(Math.abs(fallback.start.x) < 1e-9 && Math.abs(fallback.start.y - -hy) < 1e-9, `始点は上端 (実測 ${JSON.stringify(fallback.start)})`);
  assert.ok(Math.abs(fallback.end.x) < 1e-9 && Math.abs(fallback.end.y - hy) < 1e-9, "終点は下端");
  // angle 未指定の既定も lines は 0(gradient の 45 とは別)。
  const defaulted = effectiveGradientPoints("lines", {}, hx, hy);
  assert.ok(Math.abs(defaulted.start.x) < 1e-9 && Math.abs(defaulted.start.y - -hy) < 1e-9);
  // 指定時はフォールバックを使わず2点そのまま(gradient と同じ)。
  const explicit = effectiveGradientPoints("lines", { angle: 0, gradStart: { x: -0.02, y: 0.03 }, gradEnd: { x: 0.05, y: -0.01 } }, hx, hy);
  assert.deepEqual(explicit.start, { x: -0.02, y: 0.03 });
  assert.deepEqual(explicit.end, { x: 0.05, y: -0.01 });
});

test("renderToneSvg: gradient は gradStart/gradEnd 未指定なら「angle 由来の実効2点を明示指定」と同一出力(後方互換)", () => {
  const size = { x: 0.3, y: 0.25 };
  const baseParams = defaultToneParams("gradient");
  const implicit = renderToneSvg(toneInput("gradient", { size, params: baseParams }), { x: 0.1, y: 0.2 }, 0.3);
  const points = effectiveGradientPoints("gradient", baseParams, size.x / 2, size.y / 2);
  const explicit = renderToneSvg(
    toneInput("gradient", { size, params: { ...baseParams, gradStart: points.start, gradEnd: points.end } }),
    { x: 0.1, y: 0.2 },
    0.3
  );
  assert.equal(implicit, explicit);
});

test("renderToneSvg: gradient の gradStart/gradEnd 指定時は2点間で遷移し、外側は最寄り端の濃度で平坦(2026-07-15 追補)", () => {
  const size = { x: 0.3, y: 0.3 };
  const params = {
    pitch: 0.03,
    dotRatio: 0.45,
    angle: 0,
    startRatio: 1,
    endRatio: 0.1,
    gradStart: { x: -0.05, y: 0 },
    gradEnd: { x: 0.05, y: 0 }
  };
  const svg = renderToneSvg(toneInput("gradient", { size, params }), { x: 0, y: 0 }, 0);
  const circles = [...svg.matchAll(/<circle cx="([^"]+)" cy="[^"]+" r="([^"]+)"/g)].map((m) => ({ cx: Number(m[1]), r: Number(m[2]) }));
  assert.ok(circles.length > 0);
  const maxR = Math.max(...circles.map((c) => c.r));
  const minR = Math.min(...circles.map((c) => c.r));
  assert.ok(maxR > minR, "半径が遷移している");
  for (const circle of circles) {
    if (circle.cx <= -0.0599) {
      assert.ok(Math.abs(circle.r - maxR) < 1e-9, `始点より外は開始濃度で平坦(cx=${circle.cx}, r=${circle.r})`);
    }
    if (circle.cx >= 0.0599) {
      assert.ok(Math.abs(circle.r - minR) < 1e-9, `終点より外は終了濃度で平坦(cx=${circle.cx}, r=${circle.r})`);
    }
    if (Math.abs(circle.cx) < 0.001) {
      assert.ok(circle.r < maxR - 1e-9 && circle.r > minR + 1e-9, `2点の中間は中間濃度(r=${circle.r})`);
    }
  }
  // 同じ angle でも2点指定の有無で出力が変わる(遷移範囲が領域全体→2点間に狭まる)。
  const withoutPoints = renderToneSvg(
    toneInput("gradient", { size, params: { pitch: 0.03, dotRatio: 0.45, angle: 0, startRatio: 1, endRatio: 0.1 } }),
    { x: 0, y: 0 },
    0
  );
  assert.notEqual(svg, withoutPoints);
});

test("renderToneSvg: noise はタイル化 pattern により、領域サイズが変わっても circle 数が爆発しない", () => {
  const small = renderToneSvg(toneInput("noise", { size: { x: 0.1, y: 0.1 } }), { x: 0, y: 0 }, 0);
  const large = renderToneSvg(toneInput("noise", { size: { x: 3, y: 3 } }), { x: 0, y: 0 }, 0);
  const smallCount = (small.match(/<circle/g) ?? []).length;
  const largeCount = (large.match(/<circle/g) ?? []).length;
  assert.ok(smallCount > 0 && largeCount > 0);
  // タイル内の粒数は density だけで決まる(領域サイズに応じて増やさない) -- パターンの自然な
  // タイル繰り返しで面積をカバーするので、要素数(=SVGサイズ)は領域が大きくなっても増えない。
  assert.equal(smallCount, largeCount, "1タイル内の粒数は領域サイズに依存しない");
  assert.ok(!large.includes("NaN"));
});

test("renderToneSvg: noise の grain(粒径)は 0.001〜0.02 へ clamp される(circle の r 属性)", () => {
  const tooLarge = renderToneSvg(toneInput("noise", { params: { ...defaultToneParams("noise"), grain: 999 } }), { x: 0, y: 0 }, 0);
  const radiiLarge = [...tooLarge.matchAll(/<circle[^>]*r="([^"]+)"/g)].map((m) => Number(m[1]));
  assert.ok(radiiLarge.length > 0);
  assert.ok(radiiLarge.every((r) => r <= TONE_NOISE_GRAIN_MAX / 2 + 1e-9), "grain 上限へ clamp");

  const tooSmall = renderToneSvg(toneInput("noise", { params: { ...defaultToneParams("noise"), grain: -5 } }), { x: 0, y: 0 }, 0);
  const radiiSmall = [...tooSmall.matchAll(/<circle[^>]*r="([^"]+)"/g)].map((m) => Number(m[1]));
  assert.ok(radiiSmall.length > 0);
  assert.ok(radiiSmall.every((r) => r >= TONE_NOISE_GRAIN_MIN / 2 - 1e-9), "grain 下限へ clamp");
});

test("renderToneSvg: lines/noise は startRatio/endRatio 指定時のみ濃度グラデ mask を掛ける(未指定は従来通り無し)", () => {
  for (const toneType of ["lines", "noise"] as ToneKind[]) {
    const withoutGradient = renderToneSvg(toneInput(toneType), { x: 0, y: 0 }, 0);
    assert.ok(!withoutGradient.includes("<mask"), `${toneType}: startRatio/endRatio 未指定なら mask を出さない`);

    const withGradient = renderToneSvg(
      toneInput(toneType, { params: { ...defaultToneParams(toneType), startRatio: 0.8, endRatio: 0.1 } }),
      { x: 0, y: 0 },
      0
    );
    assert.ok(withGradient.includes("<mask"), `${toneType}: startRatio/endRatio 指定時は mask を掛ける`);
    assert.ok(!withGradient.includes("NaN"));
  }
});

test("renderToneSvg: lines のグラデ mask は実効2点へ userSpaceOnUse で張られ、未指定は「実効2点の明示指定」と同一出力(2026-07-15 追補2)", () => {
  const size = { x: 0.3, y: 0.25 };
  const baseParams = { ...defaultToneParams("lines"), startRatio: 0.9, endRatio: 0.1 };
  // 遷移方向はハンドルの軸線と厳密に一致させるため、bbox 基準の rotate ではなく userSpaceOnUse で張る。
  const implicit = renderToneSvg(toneInput("lines", { size, params: baseParams }), { x: 0.1, y: 0.2 }, 0.3);
  assert.ok(implicit.includes('gradientUnits="userSpaceOnUse"'), "mask の線形グラデは userSpaceOnUse");
  const points = effectiveGradientPoints("lines", baseParams, size.x / 2, size.y / 2);
  const explicit = renderToneSvg(
    toneInput("lines", { size, params: { ...baseParams, gradStart: points.start, gradEnd: points.end } }),
    { x: 0.1, y: 0.2 },
    0.3
  );
  assert.equal(implicit, explicit, "gradStart/gradEnd 未指定は angle+90 由来の実効2点の明示指定と同一(後方互換)");
});

test("renderToneSvg: lines の gradStart/gradEnd 指定時は mask がその2点に張られ、縞は軸と直交へ追従する(2026-07-15 追補2)", () => {
  const size = { x: 0.3, y: 0.3 };
  const params = {
    ...defaultToneParams("lines"),
    angle: 0,
    startRatio: 0.9,
    endRatio: 0.1,
    gradStart: { x: -0.05, y: 0.02 },
    gradEnd: { x: 0.05, y: 0.02 }
  };
  const svg = renderToneSvg(toneInput("lines", { size, params }), { x: 0, y: 0 }, 0);
  // mask の線形グラデ座標=指定2点そのもの(spreadMethod 既定 pad により2点の外側は最寄り端の濃度で平坦)。
  assert.ok(svg.includes('x1="-0.05" y1="0.02" x2="0.05" y2="0.02"'), `グラデ軸は指定2点 (実出力: ${svg.slice(0, 400)}...)`);
  // 軸は +x 方向(axisDeg=0)→ 縞はそれと直交の rotate(-90)。params.angle(0)は縞に直接使われない。
  assert.ok(svg.includes('patternTransform="rotate(-90)"'), "縞は遷移軸と直交へ追従");
  // 軸を変えると出力も変わる(軸がパターン・mask 両方に効いている)。
  const rotatedAxis = renderToneSvg(
    toneInput("lines", { size, params: { ...params, gradEnd: { x: -0.05, y: 0.1 } } }),
    { x: 0, y: 0 },
    0
  );
  assert.notEqual(svg, rotatedAxis);
});

test("renderToneSvg: snow は前面/背面の2層(feGaussianBlur付き)で構成され、前面色=object.color/背面色=params.backColor", () => {
  const object = toneInput("snow", {
    color: "#ff00ff",
    params: { ...defaultToneParams("snow"), backColor: "#00aaff", frontBlur: 0.5, backBlur: 0.5 }
  });
  const svg = renderToneSvg(object, { x: 0, y: 0 }, 0);
  assert.equal((svg.match(/feGaussianBlur/g) ?? []).length, 2, "前面/背面それぞれに feGaussianBlur が1つずつ");
  assert.match(svg, /<ellipse[^>]*fill="#ff00ff"/, "前面粒は object.color");
  assert.match(svg, /<ellipse[^>]*fill="#00aaff"/, "背面粒は params.backColor");
});

test("renderToneSvg: snow は frontBlur/backBlur が0ならその層の feGaussianBlur を省略する", () => {
  const svg = renderToneSvg(toneInput("snow", { params: { ...defaultToneParams("snow"), frontBlur: 0, backBlur: 0 } }), { x: 0, y: 0 }, 0);
  assert.ok(!svg.includes("feGaussianBlur"), "ぼかし0なら filter 自体を出さない");
});

test("renderToneSvg: 全種別が sharp/librsvg 互換の要素のみで構成される(<text> を使わない)", () => {
  for (const toneType of ALL_TONE_KINDS) {
    const svg = renderToneSvg(toneInput(toneType), { x: 0, y: 0 }, 0);
    assert.ok(!svg.includes("<text"), `${toneType}: <text> は使わない`);
  }
});
