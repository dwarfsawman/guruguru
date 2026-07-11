import { test } from "node:test";
import assert from "node:assert/strict";
import {
  balloonBodyPath,
  balloonBumpCount,
  balloonContentMaxWidth,
  balloonSpikeCount,
  balloonTailPath,
  ellipseBoundaryPoint,
  renderBalloonSvg,
  type BalloonTailCircles,
  type BalloonTailTriangle
} from "./balloonShape.ts";
import { PAGE_OBJECT_MIN_SIZE, type BalloonShape } from "./pageObjects.ts";

const SHAPES: BalloonShape[] = ["ellipse", "rounded", "cloud", "jagged", "thought"];
const SIZE = { x: 0.35, y: 0.22 };

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

test("balloonTailPath: ellipse/rounded/cloud/jagged は三角形(根本2点+tip)を返す", () => {
  const tail = { tip: { x: 0, y: 0.3 }, width: 0.05 };
  for (const shape of SHAPES.filter((s) => s !== "thought")) {
    const result = balloonTailPath(shape, SIZE, tail);
    assert.equal(result.kind, "triangle");
    const triangle = result as BalloonTailTriangle;
    assert.equal(triangle.points.length, 3);
    for (const point of triangle.points) {
      assert.ok(Number.isFinite(point.x));
      assert.ok(Number.isFinite(point.y));
    }
    assert.ok(!triangle.d.includes("NaN"));
    // tip はローカル座標そのまま(clamp/変形しない)。
    assert.equal(triangle.points[1]!.x, tail.tip.x);
    assert.equal(triangle.points[1]!.y, tail.tip.y);
  }
});

test("balloonTailPath: thought は本体から tip へ向かって小さくなる円列を返す", () => {
  const tail = { tip: { x: 0, y: 0.3 }, width: 0.05 };
  const result = balloonTailPath("thought", SIZE, tail);
  assert.equal(result.kind, "circles");
  const circles = (result as BalloonTailCircles).circles;
  assert.ok(circles.length >= 2 && circles.length <= 3);
  for (let i = 1; i < circles.length; i += 1) {
    assert.ok(circles[i]!.r < circles[i - 1]!.r, "半径は tip 側ほど小さい");
  }
  for (const circle of circles) {
    assert.ok(Number.isFinite(circle.cx) && Number.isFinite(circle.cy) && circle.r > 0);
  }
});

test("balloonTailPath: tip が原点(未設定直後)でも NaN にならず下向きにフォールバックする", () => {
  const tail = { tip: { x: 0, y: 0 }, width: 0.05 };
  const result = balloonTailPath("ellipse", SIZE, tail) as BalloonTailTriangle;
  assert.ok(!result.d.includes("NaN"));
  // 下向き既定: 根本2点の y はおおよそ +ry 付近(本体下端)。
  assert.ok(result.points[0]!.y > 0);
  assert.ok(result.points[2]!.y > 0);
});

test("balloonTailPath: 根本2点は本体(楕円近似)の内側に食い込む(継ぎ目消しが効く)", () => {
  // 旧実装は根本2点を接線上に置いており、三角形が本体と1点でしか接せず fill 再重ねで
  // 本体 stroke を覆えなかった(しっぽと本体の間に線が見える 2026-07-11 報告)。
  const tail = { tip: { x: 0, y: 0.3 }, width: 0.05 };
  const rx = SIZE.x / 2;
  const ry = SIZE.y / 2;
  for (const shape of SHAPES.filter((s) => s !== "thought")) {
    const result = balloonTailPath(shape, SIZE, tail, 0.004) as BalloonTailTriangle;
    for (const point of [result.points[0]!, result.points[2]!]) {
      const f = (point.x / rx) ** 2 + (point.y / ry) ** 2;
      assert.ok(f < 1, `${shape}: 根本点が楕円内部 (f=${f})`);
    }
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

test("renderBalloonSvg: 本体+しっぽ(triangle)を含み NaN を含まない", () => {
  const svg = renderBalloonSvg(
    {
      shape: "ellipse",
      size: SIZE,
      tail: { tip: { x: 0, y: 0.3 }, width: 0.05 },
      fill: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: 0.004
    },
    { x: 0.5, y: 0.4 },
    0.2
  );
  assert.ok(svg.includes("<path"));
  assert.ok(!svg.includes("NaN"));
  assert.ok(svg.includes("translate(0.5 0.4)"));
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

test("renderBalloonSvg: thought は circle を含む", () => {
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
  assert.ok(svg.includes("<circle"));
});
