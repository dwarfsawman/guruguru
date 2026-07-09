import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BOX_FILL,
  DEFAULT_BOX_STROKE_COLOR,
  DEFAULT_BOX_STROKE_WIDTH,
  PAGE_OBJECT_MAX_SIZE,
  PAGE_OBJECT_MIN_SIZE,
  clonePageObjects,
  createBoxObject,
  normalizePageObjects,
  type BoxObject
} from "./pageObjects.ts";

test("normalizePageObjects: 非配列は空配列", () => {
  assert.deepEqual(normalizePageObjects(null), []);
  assert.deepEqual(normalizePageObjects("not-an-array"), []);
  assert.deepEqual(normalizePageObjects({ objects: [] }), []);
});

test("normalizePageObjects: 妥当な box をそのまま受け取る", () => {
  const raw = [
    {
      id: "box_1",
      kind: "box",
      position: { x: 0.5, y: 0.3 },
      rotation: 0.1,
      size: { x: 0.2, y: 0.1 },
      cornerRadius: 0.01,
      fill: "#112233",
      strokeColor: "#445566",
      strokeWidth: 0.005
    }
  ];
  const objects = normalizePageObjects(raw);
  assert.equal(objects.length, 1);
  const box = objects[0] as BoxObject;
  assert.equal(box.id, "box_1");
  assert.equal(box.kind, "box");
  assert.deepEqual(box.position, { x: 0.5, y: 0.3 });
  assert.deepEqual(box.size, { x: 0.2, y: 0.1 });
  assert.equal(box.fill, "#112233");
  assert.equal(box.strokeColor, "#445566");
  assert.equal(box.strokeWidth, 0.005);
  assert.equal(box.cornerRadius, 0.01);
});

test("normalizePageObjects: 未知 kind は捨てる", () => {
  const objects = normalizePageObjects([
    { id: "a", kind: "sparkle", position: { x: 0, y: 0 } },
    { id: "b", kind: "box", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 } }
  ]);
  assert.equal(objects.length, 1);
  assert.equal(objects[0]!.id, "b");
});

test("normalizePageObjects: position/size 欠損の box は捨てる", () => {
  assert.deepEqual(normalizePageObjects([{ id: "x", kind: "box" }]), []);
  assert.deepEqual(normalizePageObjects([{ id: "x", kind: "box", position: { x: 0.1, y: 0.1 } }]), []);
  assert.deepEqual(
    normalizePageObjects([{ id: "x", kind: "box", position: { x: 0.1, y: 0.1 }, size: { x: 0, y: 0.1 } }]),
    []
  );
});

test("normalizePageObjects: 数値は範囲へ clamp し、不正な色は既定値へフォールバック", () => {
  const objects = normalizePageObjects([
    {
      id: "clampme",
      kind: "box",
      position: { x: 0.5, y: 0.5 },
      size: { x: 999, y: 0.05 },
      strokeWidth: 999,
      cornerRadius: -1,
      fill: "not-a-color",
      strokeColor: 123
    }
  ]);
  assert.equal(objects.length, 1);
  const box = objects[0] as BoxObject;
  assert.equal(box.size.x, PAGE_OBJECT_MAX_SIZE);
  assert.equal(box.strokeWidth, 0.2);
  assert.equal(box.cornerRadius, 0);
  assert.equal(box.fill, DEFAULT_BOX_FILL);
  assert.equal(box.strokeColor, DEFAULT_BOX_STROKE_COLOR);
});

test("normalizePageObjects: rotation は (-π, π] へ正規化", () => {
  const objects = normalizePageObjects([
    { id: "r", kind: "box", position: { x: 0.5, y: 0.5 }, size: { x: 0.1, y: 0.1 }, rotation: Math.PI * 3 }
  ]);
  const box = objects[0] as BoxObject;
  assert.ok(box.rotation > -Math.PI && box.rotation <= Math.PI);
});

test("normalizePageObjects: id 重複は自動的に一意化する", () => {
  const objects = normalizePageObjects([
    { id: "dup", kind: "box", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 } },
    { id: "dup", kind: "box", position: { x: 0.2, y: 0.2 }, size: { x: 0.1, y: 0.1 } }
  ]);
  assert.equal(objects.length, 2);
  assert.notEqual(objects[0]!.id, objects[1]!.id);
});

test("normalizePageObjects: id 欠損は index ベースの id を振る", () => {
  const objects = normalizePageObjects([
    { kind: "box", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 } }
  ]);
  assert.equal(objects[0]!.id, "obj_1");
});

test("normalizePageObjects: 上限件数を超えた分は切り捨てる", () => {
  const raw = Array.from({ length: 320 }, (_, index) => ({
    id: `b${index}`,
    kind: "box",
    position: { x: 0.1, y: 0.1 },
    size: { x: 0.1, y: 0.1 }
  }));
  const objects = normalizePageObjects(raw);
  assert.equal(objects.length, 300);
});

test("normalizePageObjects: text オブジェクトは content/style を検証する", () => {
  const valid = normalizePageObjects([
    {
      id: "t1",
      kind: "text",
      position: { x: 0.1, y: 0.1 },
      content: { text: "こんにちは", style: { fontId: "default", size: 0.04, direction: "horizontal", color: "#000000" } }
    }
  ]);
  assert.equal(valid.length, 1);

  const invalid = normalizePageObjects([{ id: "t2", kind: "text", position: { x: 0.1, y: 0.1 }, content: { text: "x" } }]);
  assert.deepEqual(invalid, []);
});

test("normalizePageObjects: balloon の shape は既定候補外なら ellipse にフォールバック", () => {
  const objects = normalizePageObjects([
    { id: "bl", kind: "balloon", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.1 }, shape: "square-ish" }
  ]);
  assert.equal(objects[0]!.kind, "balloon");
  assert.equal((objects[0] as { shape: string }).shape, "ellipse");
});

test("createBoxObject: 既定スタイルで生成する", () => {
  const box = createBoxObject("box_new", { x: 0.5, y: 0.4 }, { x: 0.3, y: 0.15 });
  assert.equal(box.kind, "box");
  assert.equal(box.fill, DEFAULT_BOX_FILL);
  assert.equal(box.strokeColor, DEFAULT_BOX_STROKE_COLOR);
  assert.equal(box.strokeWidth, DEFAULT_BOX_STROKE_WIDTH);
  assert.equal(box.rotation, 0);
});

test("clonePageObjects: deep copy(元配列を書き換えても影響しない)", () => {
  const objects = normalizePageObjects([
    { id: "c1", kind: "box", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 } }
  ]);
  const cloned = clonePageObjects(objects);
  (cloned[0] as BoxObject).position.x = 0.9;
  assert.notEqual((objects[0] as BoxObject).position.x, 0.9);
  assert.equal(PAGE_OBJECT_MIN_SIZE < PAGE_OBJECT_MAX_SIZE, true);
});
