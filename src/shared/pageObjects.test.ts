import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BOX_FILL,
  DEFAULT_BOX_STROKE_COLOR,
  DEFAULT_BOX_STROKE_WIDTH,
  DEFAULT_IMAGE_OBJECT_HEIGHT,
  DEFAULT_TONE_SNOW_BACK_COLOR,
  PAGE_OBJECT_MAX_SIZE,
  PAGE_OBJECT_MIN_SIZE,
  TONE_KINDS,
  TONE_NOISE_GRAIN_MAX,
  TONE_NOISE_GRAIN_MIN,
  TONE_SNOW_BLUR_MAX,
  TONE_SNOW_SIZE_MAX,
  TONE_SNOW_SIZE_MIN,
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

test("normalizePageObjects: gradient の gradStart/gradEnd は指定時のみ保持し ±2 へ clamp する(2026-07-15 追補)", () => {
  const withPoints = normalizePageObjects([
    {
      id: "t",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "gradient",
      seed: 1,
      params: { ...defaultToneParams("gradient"), gradStart: { x: -0.05, y: 0.02 }, gradEnd: { x: 999, y: -999 } }
    }
  ])[0] as ToneObject;
  assert.deepEqual(withPoints.params.gradStart, { x: -0.05, y: 0.02 }, "有効な始点はそのまま往復保持");
  assert.deepEqual(withPoints.params.gradEnd, { x: 2, y: -2 }, "範囲外は center と同じ ±2 へ clamp");

  const withoutPoints = normalizePageObjects([
    { id: "t2", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "gradient", seed: 1, params: defaultToneParams("gradient") }
  ])[0] as ToneObject;
  assert.ok(!("gradStart" in withoutPoints.params), "未指定ならキー自体を持たない(angle 由来の従来挙動)");
  assert.ok(!("gradEnd" in withoutPoints.params));

  const invalid = normalizePageObjects([
    {
      id: "t3",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "gradient",
      seed: 1,
      params: { ...defaultToneParams("gradient"), gradStart: { x: "a", y: 0 }, gradEnd: "nope" }
    }
  ])[0] as ToneObject;
  assert.ok(!("gradStart" in invalid.params), "不正な値は捨てる");
  assert.ok(!("gradEnd" in invalid.params));

  const otherType = normalizePageObjects([
    {
      id: "t4",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "halftone",
      seed: 1,
      params: { ...defaultToneParams("halftone"), gradStart: { x: 0.1, y: 0.1 }, gradEnd: { x: 0.2, y: 0.2 } }
    }
  ])[0] as ToneObject;
  assert.ok(!("gradStart" in otherType.params), "gradient/lines 以外の種別には混入しない");
  assert.ok(!("gradEnd" in otherType.params));
});

test("normalizePageObjects: lines も gradStart/gradEnd を指定時のみ保持し ±2 へ clamp する(2026-07-15 追補2)", () => {
  const withPoints = normalizePageObjects([
    {
      id: "t",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "lines",
      seed: 1,
      params: { ...defaultToneParams("lines"), startRatio: 0.9, endRatio: 0.1, gradStart: { x: -0.05, y: 0.02 }, gradEnd: { x: 999, y: -999 } }
    }
  ])[0] as ToneObject;
  assert.deepEqual(withPoints.params.gradStart, { x: -0.05, y: 0.02 }, "有効な始点はそのまま往復保持");
  assert.deepEqual(withPoints.params.gradEnd, { x: 2, y: -2 }, "範囲外は center と同じ ±2 へ clamp");
  assert.equal(withPoints.params.startRatio, 0.9, "濃度グラデ本体(optional)も同時に往復保持");

  // 濃度グラデ(startRatio/endRatio)が無くても点自体は保持する(使うかどうかは描画側の判定。
  // UI 側はグラデ無効化トグルで点も一緒に削除するので、通常この形は import 由来のデータのみ)。
  const withoutRatios = normalizePageObjects([
    {
      id: "t2",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "lines",
      seed: 1,
      params: { ...defaultToneParams("lines"), gradStart: { x: 0.01, y: 0 }, gradEnd: { x: 0.02, y: 0 } }
    }
  ])[0] as ToneObject;
  assert.deepEqual(withoutRatios.params.gradStart, { x: 0.01, y: 0 });

  const withoutPoints = normalizePageObjects([
    { id: "t3", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "lines", seed: 1, params: defaultToneParams("lines") }
  ])[0] as ToneObject;
  assert.ok(!("gradStart" in withoutPoints.params), "未指定ならキー自体を持たない(angle+90 由来の従来挙動)");
  assert.ok(!("gradEnd" in withoutPoints.params));
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
  // lines には無いはずの dotRatio が残っていても、lines の正規化は使わないフィールドを出力しない。
  // startRatio/endRatio は 2026-07-14 追補で lines にも「任意の濃度グラデ」として追加されたため、
  // 指定されていればそのまま保持されるのが正しい挙動になった(混入ではなく仕様どおり)。
  const tone = normalizePageObjects([
    {
      id: "t",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "lines",
      seed: 1,
      params: { pitch: 0.02, lineRatio: 0.5, angle: 10, dotRatio: 0.9, startRatio: 0.9, endRatio: 0.1 }
    }
  ])[0] as ToneObject;
  assert.equal(tone.params.lineRatio, 0.5);
  assert.equal(tone.params.dotRatio, undefined, "dotRatio は lines には無いフィールドなので混入しない");
  assert.equal(tone.params.startRatio, 0.9, "startRatio は lines の任意グラデとして保持される(2026-07-14 追補)");
  assert.equal(tone.params.endRatio, 0.1);
});

test("defaultToneParams: 全種別で仕様書の既定値を返す(noise/snow は2026-07-14追補)", () => {
  assert.deepEqual(defaultToneParams("halftone"), { pitch: 0.015, dotRatio: 0.45, angle: 45 });
  assert.deepEqual(defaultToneParams("gradient"), { pitch: 0.015, dotRatio: 0.45, angle: 45, startRatio: 0.7, endRatio: 0.05 });
  assert.deepEqual(defaultToneParams("lines"), { pitch: 0.012, lineRatio: 0.35, angle: 0 });
  assert.deepEqual(defaultToneParams("speed"), { angle: 45, count: 90, length: 0.7, lineWidth: 0.004, jitter: 0.5 });
  assert.deepEqual(defaultToneParams("focus"), { center: { x: 0, y: 0 }, innerRadius: 0.12, count: 72, lineWidth: 0.012, jitter: 0.5 });
  // flash の lineWidth は「棘の長さ」(2026-07-15 描画刷新)-- focus の「基部太さ」既定 0.012 とは意味も値も異なる。
  assert.deepEqual(defaultToneParams("flash"), { center: { x: 0, y: 0 }, innerRadius: 0.18, count: 72, lineWidth: 0.08, jitter: 0.5 });
  assert.deepEqual(defaultToneParams("noise"), { density: 0.35, grain: 0.003 });
  assert.deepEqual(defaultToneParams("snow"), {
    count: 120,
    frontRatio: 0.4,
    frontSize: 0.05,
    backSize: 0.03,
    frontBlur: 0.5,
    backBlur: 0.3,
    angle: 115,
    backColor: DEFAULT_TONE_SNOW_BACK_COLOR
  });
  assert.equal(TONE_KINDS.length, 8);
});

// --- noise/snow の追加パラメータ(Docs/Feature-ScreenTones.md 追補、2026-07-14) ---

test("normalizePageObjects: tone(noise)の正規化往復(density/grain/seed を保持)", () => {
  const raw = [
    {
      id: "tone_noise",
      kind: "tone",
      position: { x: 0.4, y: 0.4 },
      size: { x: 0.3, y: 0.3 },
      toneType: "noise",
      seed: 55,
      params: { density: 0.6, grain: 0.01 }
    }
  ];
  const tone = normalizePageObjects(raw)[0] as ToneObject;
  assert.equal(tone.toneType, "noise");
  assert.equal(tone.params.density, 0.6);
  assert.equal(tone.params.grain, 0.01);
  assert.equal(tone.params.startRatio, undefined, "グラデ未指定なら startRatio は無い");
  assert.equal(tone.params.endRatio, undefined, "グラデ未指定なら endRatio は無い");
  assert.ok(!("angle" in tone.params), "angle も未指定なら無い(optional)");
});

test("normalizePageObjects: tone(noise)の grain/density は範囲へ clamp する", () => {
  const tooLarge = normalizePageObjects([
    { id: "a", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "noise", seed: 1, params: { density: 5, grain: 999 } }
  ])[0] as ToneObject;
  assert.equal(tooLarge.params.density, 1);
  assert.equal(tooLarge.params.grain, TONE_NOISE_GRAIN_MAX);

  const tooSmall = normalizePageObjects([
    { id: "b", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "noise", seed: 1, params: { density: -5, grain: -5 } }
  ])[0] as ToneObject;
  assert.equal(tooSmall.params.density, 0);
  assert.equal(tooSmall.params.grain, TONE_NOISE_GRAIN_MIN);
});

test("normalizePageObjects: tone(noise/lines)の任意グラデ(startRatio/endRatio)は指定時のみ保持し、範囲clampする", () => {
  const withGradient = normalizePageObjects([
    {
      id: "a",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "noise",
      seed: 1,
      params: { density: 0.5, grain: 0.005, angle: 30, startRatio: 5, endRatio: -5 }
    }
  ])[0] as ToneObject;
  assert.equal(withGradient.params.angle, 30);
  assert.equal(withGradient.params.startRatio, 1, "startRatio は 0..1 へ clamp");
  assert.equal(withGradient.params.endRatio, 0, "endRatio は 0..1 へ clamp");

  const linesWithGradient = normalizePageObjects([
    {
      id: "b",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "lines",
      seed: 1,
      params: { pitch: 0.02, lineRatio: 0.5, angle: 10, startRatio: 0.6, endRatio: 0.2 }
    }
  ])[0] as ToneObject;
  assert.equal(linesWithGradient.params.startRatio, 0.6);
  assert.equal(linesWithGradient.params.endRatio, 0.2);

  const linesWithoutGradient = normalizePageObjects([
    { id: "c", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "lines", seed: 1, params: { pitch: 0.02, lineRatio: 0.5, angle: 10 } }
  ])[0] as ToneObject;
  assert.equal(linesWithoutGradient.params.startRatio, undefined);
  assert.equal(linesWithoutGradient.params.endRatio, undefined);
});

test("normalizePageObjects: tone(focus)の outerRadius は optional -- 指定時のみ保持しclamp、flash には無い", () => {
  const focusWithOuter = normalizePageObjects([
    { id: "a", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "focus", seed: 1, params: { outerRadius: 999 } }
  ])[0] as ToneObject;
  assert.equal(focusWithOuter.params.outerRadius, PAGE_OBJECT_MAX_SIZE, "上限へ clamp");

  const focusWithoutOuter = normalizePageObjects([
    { id: "b", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "focus", seed: 1, params: {} }
  ])[0] as ToneObject;
  assert.ok(!("outerRadius" in focusWithoutOuter.params), "未指定ならキー自体が無い");

  // flash は outerRadius を持たない(仕様書: focus のみ)。
  const flashWithOuter = normalizePageObjects([
    { id: "c", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "flash", seed: 1, params: { outerRadius: 0.3 } }
  ])[0] as ToneObject;
  assert.ok(!("outerRadius" in flashWithOuter.params), "flash には outerRadius が無い(focus専用)");
});

test("normalizePageObjects: tone(snow)の正規化往復(count/frontRatio/size/blur/angle/backColor を保持)", () => {
  const raw = [
    {
      id: "tone_snow",
      kind: "tone",
      position: { x: 0.4, y: 0.4 },
      size: { x: 0.3, y: 0.3 },
      toneType: "snow",
      seed: 99,
      params: { count: 200, frontRatio: 0.6, frontSize: 0.08, backSize: 0.02, frontBlur: 0.9, backBlur: 0.4, angle: 200, backColor: "#123456" }
    }
  ];
  const tone = normalizePageObjects(raw)[0] as ToneObject;
  assert.equal(tone.toneType, "snow");
  assert.equal(tone.params.count, 200);
  assert.equal(tone.params.frontRatio, 0.6);
  assert.equal(tone.params.frontSize, 0.08);
  assert.equal(tone.params.backSize, 0.02);
  assert.equal(tone.params.frontBlur, 0.9);
  assert.equal(tone.params.backBlur, 0.4);
  assert.equal(tone.params.angle, 200);
  assert.equal(tone.params.backColor, "#123456");
});

test("normalizePageObjects: tone(snow)の count/frontRatio/size/blur は範囲へ clamp する", () => {
  const tone = normalizePageObjects([
    {
      id: "a",
      kind: "tone",
      position: { x: 0.1, y: 0.1 },
      size: { x: 0.2, y: 0.2 },
      toneType: "snow",
      seed: 1,
      params: { count: 99999, frontRatio: 5, frontSize: 999, backSize: -5, frontBlur: 999, backBlur: -5 }
    }
  ])[0] as ToneObject;
  assert.equal(tone.params.count, 400, "count は仕様書の上限400へ clamp");
  assert.equal(tone.params.frontRatio, 1);
  assert.equal(tone.params.frontSize, TONE_SNOW_SIZE_MAX);
  assert.equal(tone.params.backSize, TONE_SNOW_SIZE_MIN);
  assert.equal(tone.params.frontBlur, TONE_SNOW_BLUR_MAX);
  assert.equal(tone.params.backBlur, 0);
});

test("normalizePageObjects: tone(snow)の backColor は不正な色なら既定色(#aaaaaa)へフォールバックする", () => {
  const invalid = normalizePageObjects([
    { id: "a", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "snow", seed: 1, params: { backColor: "not-a-color" } }
  ])[0] as ToneObject;
  assert.equal(invalid.params.backColor, DEFAULT_TONE_SNOW_BACK_COLOR);

  const missing = normalizePageObjects([
    { id: "b", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "snow", seed: 1, params: {} }
  ])[0] as ToneObject;
  assert.equal(missing.params.backColor, DEFAULT_TONE_SNOW_BACK_COLOR);

  const valid = normalizePageObjects([
    { id: "c", kind: "tone", position: { x: 0.1, y: 0.1 }, size: { x: 0.2, y: 0.2 }, toneType: "snow", seed: 1, params: { backColor: "#00ff00" } }
  ])[0] as ToneObject;
  assert.equal(valid.params.backColor, "#00ff00");
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
