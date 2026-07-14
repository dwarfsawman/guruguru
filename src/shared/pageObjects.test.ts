import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BOX_FILL,
  DEFAULT_BOX_STROKE_COLOR,
  DEFAULT_BOX_STROKE_WIDTH,
  DEFAULT_IMAGE_OBJECT_HEIGHT,
  PAGE_OBJECT_MAX_SIZE,
  PAGE_OBJECT_MIN_SIZE,
  TONE_KINDS,
  clonePageObjects,
  createBoxObject,
  createImageObject,
  createToneObject,
  defaultImageObjectSize,
  defaultToneParams,
  normalizePageObjects,
  type BoxObject,
  type ImageObject,
  type ToneObject
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

test("normalizePageObjects: image オブジェクトは mediaId 必須、band/opacity/clipPanelId を全保持する", () => {
  const raw = [
    {
      id: "img_1",
      kind: "image",
      position: { x: 0.5, y: 0.3 },
      rotation: 0.2,
      mediaId: "media_abc",
      size: { x: 0.3, y: 0.4 },
      opacity: 0.5,
      band: "back",
      clipPanelId: "panel_1"
    }
  ];
  const objects = normalizePageObjects(raw);
  assert.equal(objects.length, 1);
  const image = objects[0] as ImageObject;
  assert.equal(image.kind, "image");
  assert.equal(image.mediaId, "media_abc");
  assert.equal(image.opacity, 0.5);
  assert.equal(image.band, "back");
  assert.equal(image.clipPanelId, "panel_1");
});

test("normalizePageObjects: image は mediaId 欠損なら捨てる", () => {
  assert.deepEqual(
    normalizePageObjects([{ id: "x", kind: "image", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 } }]),
    []
  );
});

test("normalizePageObjects: image の clipPanelId=null は null のまま保持し、省略はキーを持たない", () => {
  const withNull = normalizePageObjects([
    { id: "a", kind: "image", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 }, mediaId: "m1", clipPanelId: null }
  ])[0] as ImageObject;
  assert.equal(withNull.clipPanelId, null);
  assert.ok("clipPanelId" in withNull);

  const omitted = normalizePageObjects([
    { id: "b", kind: "image", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 }, mediaId: "m1" }
  ])[0] as ImageObject;
  assert.ok(!("clipPanelId" in omitted));
});

test("normalizePageObjects: image の band は back/front 以外を捨てる(既定 front 扱いに落とす)", () => {
  const object = normalizePageObjects([
    { id: "a", kind: "image", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 }, mediaId: "m1", band: "middle" }
  ])[0] as ImageObject;
  assert.equal(object.band, undefined);
});

test("normalizePageObjects: image の opacity は 0..1 へ clamp する", () => {
  const object = normalizePageObjects([
    { id: "a", kind: "image", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 }, mediaId: "m1", opacity: 5 }
  ])[0] as ImageObject;
  assert.equal(object.opacity, 1);
});

test("defaultImageObjectSize: メディアのアスペクト比から page 単位のサイズを作る", () => {
  const size = defaultImageObjectSize(800, 400);
  assert.equal(size.y, DEFAULT_IMAGE_OBJECT_HEIGHT);
  assert.equal(size.x, DEFAULT_IMAGE_OBJECT_HEIGHT * 2);
});

test("defaultImageObjectSize: width/height が無ければ正方形にフォールバック", () => {
  const size = defaultImageObjectSize(null, null);
  assert.equal(size.x, size.y);
});

test("createImageObject: 既定 front 帯・不透明度1・クリップなしで生成する", () => {
  const image = createImageObject("img_new", { x: 0.5, y: 0.4 }, "media_1", { x: 0.3, y: 0.2 });
  assert.equal(image.kind, "image");
  assert.equal(image.mediaId, "media_1");
  assert.equal(image.opacity, 1);
  assert.equal(image.band, "front");
  assert.equal(image.clipPanelId, null);
  assert.equal(image.rotation, 0);
});

// --- トーン(Docs/Feature-ScreenTones.md) ---

test("normalizePageObjects: tone の正規化往復(seed/params/clipPanelId/opacity/color を保持)", () => {
  const raw = [
    {
      id: "tone_1",
      kind: "tone",
      position: { x: 0.5, y: 0.4 },
      rotation: 0.3,
      size: { x: 0.3, y: 0.25 },
      toneType: "focus",
      color: "#112233",
      opacity: 0.7,
      clipPanelId: "panel_9",
      seed: 12345,
      params: { center: { x: 0.02, y: -0.03 }, innerRadius: 0.1, count: 50, lineWidth: 0.01, jitter: 0.4 }
    }
  ];
  const objects = normalizePageObjects(raw);
  assert.equal(objects.length, 1);
  const tone = objects[0] as ToneObject;
  assert.equal(tone.kind, "tone");
  assert.equal(tone.toneType, "focus");
  assert.equal(tone.color, "#112233");
  assert.equal(tone.opacity, 0.7);
  assert.equal(tone.clipPanelId, "panel_9");
  assert.equal(tone.seed, 12345);
  assert.deepEqual(tone.position, { x: 0.5, y: 0.4 });
  assert.deepEqual(tone.size, { x: 0.3, y: 0.25 });
  assert.deepEqual(tone.params.center, { x: 0.02, y: -0.03 });
  assert.equal(tone.params.innerRadius, 0.1);
  assert.equal(tone.params.count, 50);
  assert.equal(tone.params.lineWidth, 0.01);
  assert.equal(tone.params.jitter, 0.4);
});

test("normalizePageObjects: tone の pitch/dotRatio は範囲へ clamp する", () => {
  const objects = normalizePageObjects([
    {
      id: "t",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "halftone",
      seed: 1,
      params: { pitch: 999, dotRatio: 5, angle: 10 }
    }
  ]);
  const tone = objects[0] as ToneObject;
  assert.equal(tone.params.pitch, 0.1);
  assert.equal(tone.params.dotRatio, 1);

  const clampedLow = normalizePageObjects([
    { id: "t2", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "halftone", seed: 1, params: { pitch: -5, dotRatio: -5 } }
  ])[0] as ToneObject;
  assert.equal(clampedLow.params.pitch, 0.004);
  assert.equal(clampedLow.params.dotRatio, 0);
});

test("normalizePageObjects: tone の focus/flash center はローカル座標として ±2 へ clamp する", () => {
  const objects = normalizePageObjects([
    {
      id: "t",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "focus",
      seed: 1,
      params: { center: { x: 999, y: -999 } }
    }
  ]);
  const tone = objects[0] as ToneObject;
  assert.equal(tone.params.center!.x, 2);
  assert.equal(tone.params.center!.y, -2);
});

test("normalizePageObjects: tone の toneType は候補外なら halftone にフォールバック(balloon.shape と同じ扱い、オブジェクト自体は捨てない)", () => {
  const objects = normalizePageObjects([
    { id: "t", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "sparkle-beam", seed: 1, params: {} }
  ]);
  assert.equal(objects.length, 1);
  assert.equal((objects[0] as ToneObject).toneType, "halftone");
});

test("normalizePageObjects: tone は position/size 欠損なら捨てる", () => {
  assert.deepEqual(normalizePageObjects([{ id: "t", kind: "tone", position: { x: 0.1, y: 0.1 } }]), []);
  assert.deepEqual(normalizePageObjects([{ id: "t", kind: "tone", size: { x: 0.1, y: 0.1 } }]), []);
});

test("normalizePageObjects: tone の seed が不正なら決定的な既定値へフォールバックする(Math.random は使わない)", () => {
  const a = normalizePageObjects([
    { id: "t", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "speed", seed: "not-a-number", params: {} }
  ])[0] as ToneObject;
  const b = normalizePageObjects([
    { id: "t", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "speed", seed: "not-a-number", params: {} }
  ])[0] as ToneObject;
  assert.ok(Number.isInteger(a.seed));
  assert.equal(a.seed, b.seed, "同じ不正入力からは同じ既定 seed が出る(決定的)");
});

test("normalizePageObjects: tone の clipPanelId=null は null のまま保持し、省略はキーを持たない", () => {
  const withNull = normalizePageObjects([
    { id: "a", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 }, toneType: "lines", seed: 1, params: {}, clipPanelId: null }
  ])[0] as ToneObject;
  assert.equal(withNull.clipPanelId, null);
  assert.ok("clipPanelId" in withNull);

  const omitted = normalizePageObjects([
    { id: "b", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 }, toneType: "lines", seed: 1, params: {} }
  ])[0] as ToneObject;
  assert.ok(!("clipPanelId" in omitted));
});

test("normalizePageObjects: tone の未知パラメータ種別ごとの使用フィールドだけが残る(gradient→lines へ toneType が変わっても混入しない)", () => {
  // lines には無いはずの startRatio/endRatio が残っていても、lines の正規化は使わないフィールドを出力しない。
  const tone = normalizePageObjects([
    {
      id: "t",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "lines",
      seed: 1,
      params: { pitch: 0.02, lineRatio: 0.5, angle: 10, startRatio: 0.9, endRatio: 0.1 }
    }
  ])[0] as ToneObject;
  assert.equal(tone.params.lineRatio, 0.5);
  assert.equal(tone.params.startRatio, undefined);
  assert.equal(tone.params.endRatio, undefined);
});

test("defaultToneParams: 全種別で仕様書の既定値を返す", () => {
  assert.deepEqual(defaultToneParams("halftone"), { pitch: 0.015, dotRatio: 0.45, angle: 45 });
  assert.deepEqual(defaultToneParams("gradient"), { pitch: 0.015, dotRatio: 0.45, angle: 45, startRatio: 0.7, endRatio: 0.05 });
  assert.deepEqual(defaultToneParams("lines"), { pitch: 0.012, lineRatio: 0.35, angle: 0 });
  assert.deepEqual(defaultToneParams("speed"), { angle: 45, count: 90, length: 0.7, lineWidth: 0.004, jitter: 0.5 });
  assert.deepEqual(defaultToneParams("focus"), { center: { x: 0, y: 0 }, innerRadius: 0.12, count: 72, lineWidth: 0.012, jitter: 0.5 });
  assert.deepEqual(defaultToneParams("flash"), { center: { x: 0, y: 0 }, innerRadius: 0.18, count: 72, lineWidth: 0.012, jitter: 0.5 });
  assert.equal(TONE_KINDS.length, 6);
});

test("createToneObject: 既定色・不透明度1で生成し、渡した seed/toneType/size/clipPanelId をそのまま使う", () => {
  const tone = createToneObject("tone_new", { x: 0.5, y: 0.4 }, 777, { x: 0.4, y: 0.3 }, "flash", "panel_1");
  assert.equal(tone.kind, "tone");
  assert.equal(tone.toneType, "flash");
  assert.equal(tone.seed, 777);
  assert.equal(tone.opacity, 1);
  assert.equal(tone.color, "#000000");
  assert.equal(tone.clipPanelId, "panel_1");
  assert.equal(tone.rotation, 0);
  assert.deepEqual(tone.size, { x: 0.4, y: 0.3 });
  assert.deepEqual(tone.params, defaultToneParams("flash"));
});

test("createToneObject: 既定引数(size/toneType/clipPanelId 省略)は仕様書どおり 0.35×0.35・halftone・クリップなし", () => {
  const tone = createToneObject("tone_default", { x: 0.5, y: 0.7 }, 1);
  assert.equal(tone.toneType, "halftone");
  assert.deepEqual(tone.size, { x: 0.35, y: 0.35 });
  assert.equal(tone.clipPanelId, null);
});

// --- グループ化(Docs/Feature-PageEditSidebarUx.md 課題C) ---

test("normalizePageObjects: groupId は往復で保持し、空文字/非文字列/欠損はキーを持たない", () => {
  const withGroup = normalizePageObjects([
    { id: "a", kind: "box", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 }, groupId: "group_1" }
  ])[0] as BoxObject;
  assert.equal(withGroup.groupId, "group_1");

  const emptyGroup = normalizePageObjects([
    { id: "b", kind: "box", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 }, groupId: "" }
  ])[0] as BoxObject;
  assert.equal(emptyGroup.groupId, undefined);
  assert.ok(!("groupId" in emptyGroup));

  const nonStringGroup = normalizePageObjects([
    { id: "c", kind: "box", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 }, groupId: 123 }
  ])[0] as BoxObject;
  assert.ok(!("groupId" in nonStringGroup));

  const omitted = normalizePageObjects([
    { id: "d", kind: "box", position: { x: 0.1, y: 0.1 }, size: { x: 0.1, y: 0.1 } }
  ])[0] as BoxObject;
  assert.ok(!("groupId" in omitted));
});

test("normalizePageObjects: groupId は前後空白を trim し、balloon 等の他 kind でも保持する", () => {
  const balloon = normalizePageObjects([
    { id: "bl", kind: "balloon", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.1 }, groupId: "  grp-9  " }
  ])[0];
  assert.equal(balloon!.groupId, "grp-9");
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
