import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { cutoutFigure } from "./figureCutout.ts";

/** 白背景+青系の人型シルエット(頭+胴)。ぶち抜き立ち絵の生成結果の代役。 */
async function whiteBackgroundFigurePng(): Promise<Buffer> {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300">`,
    `<rect width="200" height="300" fill="#ffffff"/>`,
    `<ellipse cx="100" cy="80" rx="34" ry="40" fill="#2244aa"/>`,
    `<rect x="70" y="115" width="60" height="150" fill="#334466"/>`,
    `</svg>`
  ].join("");
  return sharp(Buffer.from(svg)).png().toBuffer();
}

test("cutoutFigure: 白背景を透明化し、前景の周囲に白フチを焼き込む", async () => {
  const result = await cutoutFigure(await whiteBackgroundFigurePng());
  assert.ok(result, "無地白背景の立ち絵は切り抜きが成立すること");
  assert.ok(result!.foregroundRatio > 0.1 && result!.foregroundRatio < 0.6, `foregroundRatio=${result!.foregroundRatio}`);
  const { data, info } = await sharp(result!.png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  const pixel = (x: number, y: number) => {
    const index = (y * info.width + x) * 4;
    return { r: data[index]!, g: data[index + 1]!, b: data[index + 2]!, a: data[index + 3]! };
  };
  // 出力はトリム済み: 四隅(フチ形状の外側)は透明。
  assert.equal(pixel(0, 0).a, 0);
  assert.equal(pixel(info.width - 1, 0).a, 0);
  // 胴の中心は不透明で元色(青系)のまま。
  const torso = pixel(Math.floor(info.width / 2), Math.floor(info.height * 0.7));
  assert.equal(torso.a, 255);
  assert.ok(torso.b > torso.r, `torso=${JSON.stringify(torso)}`);
  // 胴の左外側を左端から走査すると、最初に出会う不透明ピクセルは白フチ。
  const y = Math.floor(info.height * 0.7);
  let firstOpaque: { r: number; g: number; b: number; a: number } | null = null;
  for (let x = 0; x < info.width; x += 1) {
    const candidate = pixel(x, y);
    if (candidate.a === 255) {
      firstOpaque = candidate;
      break;
    }
  }
  assert.ok(firstOpaque, "不透明ピクセルが存在すること");
  assert.ok(
    firstOpaque!.r > 245 && firstOpaque!.g > 245 && firstOpaque!.b > 245,
    `outline=${JSON.stringify(firstOpaque)}`
  );
});

test("cutoutFigure: 無地でない背景(グラデーション)は null で不成立を返す", async () => {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="#ff4400"/><stop offset="1" stop-color="#0044ff"/>`,
    `</linearGradient></defs>`,
    `<rect width="200" height="300" fill="url(#g)"/>`,
    `<ellipse cx="100" cy="150" rx="40" ry="60" fill="#ffffff"/>`,
    `</svg>`
  ].join("");
  const result = await cutoutFigure(await sharp(Buffer.from(svg)).png().toBuffer());
  assert.equal(result, null);
});

test("cutoutFigure: 同一入力なら同一出力(決定的)", async () => {
  const source = await whiteBackgroundFigurePng();
  const a = await cutoutFigure(source);
  const b = await cutoutFigure(source);
  assert.ok(a && b);
  assert.equal(Buffer.compare(a!.png, b!.png), 0);
});
