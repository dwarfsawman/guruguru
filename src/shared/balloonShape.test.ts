import { test } from "node:test";
import assert from "node:assert/strict";
import {
  balloonBodyPath,
  balloonBumpCount,
  balloonContentMaxWidth,
  balloonSpikeCount,
  balloonThoughtCircles,
  balloonUnionPath,
  ellipseBoundaryPoint,
  renderBalloonSvg
} from "./balloonShape.ts";
import { PAGE_OBJECT_MIN_SIZE, type BalloonShape } from "./pageObjects.ts";

const SHAPES: BalloonShape[] = ["ellipse", "rounded", "cloud", "jagged", "thought", "compound", "spike", "roundRect", "caption"];
const UNION_SHAPES = SHAPES.filter((s) => s !== "thought" && s !== "compound");
const SIZE = { x: 0.35, y: 0.22 };
const TAIL = { tip: { x: 0, y: 0.3 }, width: 0.05 };

test("balloonBodyPath: 5形状とも閉路(M..Z)で NaN を含まない", () => {
  for (const shape of SHAPES) {
    const d = balloonBodyPath(shape, SIZE);
    assert.ok(d.startsWith("M"), `${shape}: starts with M`);
    assert.ok(d.trim().endsWith("Z"), `${shape}: ends with Z`);
    assert.ok(!d.includes("NaN"), `${shape}: no NaN`);
  }
});

test("balloonBodyPath: 極端に細長い/小さいサイズでも NaN を含まない", () => {
  const sizes = [
    { x: 5, y: 0.01 },
    { x: 0.01, y: 5 },
    { x: 0.01, y: 0.01 }
  ];
  for (const shape of SHAPES) {
    for (const size of sizes) {
      const d = balloonBodyPath(shape, size);
      assert.ok(!d.includes("NaN"), `${shape} @ ${JSON.stringify(size)}: no NaN`);
    }
  }
});

test("balloonBumpCount/balloonSpikeCount: 規定範囲(8-16 / 12-24)に収まる", () => {
  const sizes = [
    { x: 0.01, y: 0.01 },
    { x: 0.35, y: 0.22 },
    { x: 5, y: 5 }
  ];
  for (const size of sizes) {
    const bumps = balloonBumpCount(size);
    assert.ok(bumps >= 8 && bumps <= 16, `bumps ${bumps} in range`);
    const spikes = balloonSpikeCount(size);
    assert.ok(spikes >= 12 && spikes <= 24, `spikes ${spikes} in range`);
  }
});

test("ellipseBoundaryPoint: 上/右/下/左方向で楕円境界上の点を返す", () => {
  const rx = 0.2;
  const ry = 0.1;
  const up = ellipseBoundaryPoint(rx, ry, 0, -1);
  assert.ok(Math.abs(up.x) < 1e-9);
  assert.ok(Math.abs(up.y + ry) < 1e-9);
  const right = ellipseBoundaryPoint(rx, ry, 1, 0);
  assert.ok(Math.abs(right.x - rx) < 1e-9);
  assert.ok(Math.abs(right.y) < 1e-9);
});

test("balloonUnionPath: 4形状とも単一の閉パス(M..Z が1個ずつ)で tip を含み NaN を含まない", () => {
  for (const shape of UNION_SHAPES) {
    const d = balloonUnionPath(shape, SIZE, TAIL);
    assert.equal((d.match(/M /g) ?? []).length, 1, `${shape}: single subpath`);
    assert.ok(d.trim().endsWith("Z"), `${shape}: closed`);
    assert.ok(!d.includes("NaN"), `${shape}: no NaN`);
    assert.ok(d.includes(`L ${TAIL.tip.x} ${TAIL.tip.y}`), `${shape}: tip へ直線(かくっとした付け根)`);
  }
});

test("balloonUnionPath: ellipse は根本2点が楕円境界上にあり、長弧(A コマンド large-arc=1)で結ぶ", () => {
  const rx = SIZE.x / 2;
  const ry = SIZE.y / 2;
  const d = balloonUnionPath("ellipse", SIZE, TAIL);
  assert.ok(/A [\d.]+ [\d.]+ 0 1 1 /.test(d), "large-arc sweep=1 の弧");
  const m = d.match(/^M ([-\d.e]+) ([-\d.e]+) A [\d.e]+ [\d.e]+ 0 1 1 ([-\d.e]+) ([-\d.e]+)/);
  assert.ok(m, "M と A の座標が読める");
  for (const [x, y] of [
    [Number(m![1]), Number(m![2])],
    [Number(m![3]), Number(m![4])]
  ]) {
    const f = (x! / rx) ** 2 + (y! / ry) ** 2;
    // 座標は fmt で 1e-6 に丸められるため、その分の許容を持たせる。
    assert.ok(Math.abs(f - 1) < 1e-4, `根本点が楕円境界上 (f=${f})`);
    assert.ok(y! > 0, "しっぽ(下向き)側の根本は下半分にある");
  }
});

test("balloonUnionPath: しっぽ方向を変えても各形状で NaN を含まず閉じる", () => {
  const tips = [
    { x: 0.3, y: 0 },
    { x: -0.3, y: 0.1 },
    { x: 0.2, y: -0.25 },
    { x: -0.15, y: -0.2 }
  ];
  for (const shape of UNION_SHAPES) {
    for (const tip of tips) {
      const d = balloonUnionPath(shape, SIZE, { tip, width: 0.05 });
      assert.ok(!d.includes("NaN"), `${shape} tip=${JSON.stringify(tip)}: no NaN`);
      assert.ok(d.trim().endsWith("Z"), `${shape}: closed`);
    }
  }
});

test("balloonUnionPath: tip が原点(未設定直後)・極端サイズ・極太しっぽでも NaN を含まない", () => {
  const cases: { size: { x: number; y: number }; tail: { tip: { x: number; y: number }; width: number } }[] = [
    { size: SIZE, tail: { tip: { x: 0, y: 0 }, width: 0.05 } },
    { size: { x: 0.01, y: 0.01 }, tail: { tip: { x: 0, y: 0.3 }, width: 0.5 } },
    { size: { x: 5, y: 0.01 }, tail: { tip: { x: 0.1, y: 0.3 }, width: 0.05 } },
    { size: SIZE, tail: { tip: { x: 0, y: 0.3 }, width: 0 } }
  ];
  for (const shape of UNION_SHAPES) {
    for (const { size, tail } of cases) {
      const d = balloonUnionPath(shape, size, tail);
      assert.ok(!d.includes("NaN"), `${shape} @ ${JSON.stringify({ size, tail })}: no NaN`);
    }
  }
});

test("balloonThoughtCircles: 本体から tip へ向かって小さくなる円列を返す", () => {
  const circles = balloonThoughtCircles(SIZE, TAIL);
  assert.ok(circles.length >= 2 && circles.length <= 3);
  for (let i = 1; i < circles.length; i += 1) {
    assert.ok(circles[i]!.r < circles[i - 1]!.r, "半径は tip 側ほど小さい");
  }
  for (const circle of circles) {
    assert.ok(Number.isFinite(circle.cx) && Number.isFinite(circle.cy) && circle.r > 0);
  }
});

test("balloonContentMaxWidth: 形状ごとに内接矩形係数が異なり、非 ellipse は ellipse 以下になる", () => {
  const direction = "vertical" as const;
  const ellipseWidth = balloonContentMaxWidth("ellipse", SIZE, direction);
  const roundedWidth = balloonContentMaxWidth("rounded", SIZE, direction);
  const cloudWidth = balloonContentMaxWidth("cloud", SIZE, direction);
  const jaggedWidth = balloonContentMaxWidth("jagged", SIZE, direction);
  const thoughtWidth = balloonContentMaxWidth("thought", SIZE, direction);
  assert.ok(ellipseWidth > 0);
  assert.ok(roundedWidth > ellipseWidth, "rounded は ellipse より内接係数が大きい(0.86 > 1/√2)");
  assert.ok(cloudWidth < ellipseWidth, "cloud はさらに 0.8 掛けで小さい");
  assert.equal(cloudWidth, jaggedWidth);
  assert.equal(cloudWidth, thoughtWidth);
});

test("balloonContentMaxWidth: 極小サイズでも PAGE_OBJECT_MIN_SIZE を下回らない", () => {
  const width = balloonContentMaxWidth("cloud", { x: 0.001, y: 0.001 }, "horizontal");
  assert.ok(width >= PAGE_OBJECT_MIN_SIZE);
});

test("renderBalloonSvg: しっぽ付き(thought 以外)は path 1本の union 輪郭になる", () => {
  for (const shape of UNION_SHAPES) {
    const svg = renderBalloonSvg(
      { shape, size: SIZE, tail: TAIL, fill: "#ffffff", strokeColor: "#000000", strokeWidth: 0.004 },
      { x: 0.5, y: 0.4 },
      0.2
    );
    assert.equal((svg.match(/<path/g) ?? []).length, 1, `${shape}: single path`);
    assert.ok(!svg.includes("NaN"), `${shape}: no NaN`);
    assert.ok(svg.includes("translate(0.5 0.4)"));
  }
});

test("renderBalloonSvg: tail 無しでは本体のみ描画する", () => {
  const svg = renderBalloonSvg(
    { shape: "rounded", size: SIZE, tail: null, fill: "#ffffff", strokeColor: "#000000", strokeWidth: 0.004 },
    { x: 0, y: 0 },
    0
  );
  const pathCount = (svg.match(/<path/g) ?? []).length;
  assert.equal(pathCount, 1);
});

test("renderBalloonSvg: compound はしっぽを本体の背面へ重ねる2パス", () => {
  const svg = renderBalloonSvg(
    { shape: "compound", size: SIZE, tail: TAIL, fill: "#ffffff", strokeColor: "#000000", strokeWidth: 0.004 },
    { x: 0.5, y: 0.4 },
    0
  );
  assert.equal((svg.match(/<path/g) ?? []).length, 2);
  assert.ok(svg.includes(`L ${TAIL.tip.x} ${TAIL.tip.y}`));
});

test("renderBalloonSvg: thought は本体 path + circle 列になる", () => {
  const svg = renderBalloonSvg(
    {
      shape: "thought",
      size: SIZE,
      tail: { tip: { x: 0.1, y: 0.3 }, width: 0.05 },
      fill: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: 0.004
    },
    { x: 0, y: 0 },
    0
  );
  assert.equal((svg.match(/<path/g) ?? []).length, 1);
  assert.ok(svg.includes("<circle"));
});
