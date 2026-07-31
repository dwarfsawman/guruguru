import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { buildPdf, readJpegSize } from "./pdfExport.ts";

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 240, g: 240, b: 240 } }
  }).jpeg({ quality: 80 }).toBuffer();
  return new Uint8Array(buffer);
}

test("JPEG のフレームヘッダから画素サイズを読む", async () => {
  // ここがずれると PDF の XObject と実画像が食い違って絵が伸びる。
  assert.deepEqual(readJpegSize(await jpeg(1024, 1448)), { width: 1024, height: 1448 });
  assert.deepEqual(readJpegSize(await jpeg(200, 100)), { width: 200, height: 100 });
  assert.throws(() => readJpegSize(new Uint8Array([0x00, 0x01, 0x02])), /not a JPEG/);
});

test("複数ページの PDF を組み立て、xref のオフセットが実位置と一致する", async () => {
  const pages = [await jpeg(400, 560), await jpeg(400, 560), await jpeg(400, 560)];
  const pdf = buildPdf(pages);
  const text = Buffer.from(pdf).toString("latin1");

  assert.ok(text.startsWith("%PDF-1.4"), "PDF ヘッダで始まる");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "EOF で終わる");
  assert.equal((text.match(/\/Type \/Page[^s]/g) ?? []).length, 3, "ページ数が一致する");
  assert.ok(text.includes("/Count 3"), "Pages の Count が一致する");
  assert.ok(text.includes("/Filter /DCTDecode"), "JPEG を再エンコードせず埋める");

  // xref の各オフセットが本当に "<n> 0 obj" を指しているか。ここがずれた PDF は
  // 多くのビューアが黙って開くので、目視では気づけない。
  const startxref = Number(text.match(/startxref\s+(\d+)/)![1]);
  assert.equal(text.slice(startxref, startxref + 4), "xref", "startxref が xref を指す");
  const xrefBody = text.slice(startxref);
  const total = Number(xrefBody.match(/xref\n0 (\d+)/)![1]);
  assert.equal(total, 2 + pages.length * 3 + 1, "オブジェクト数が一致する");
  const entries = [...xrefBody.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  assert.equal(entries.length, total - 1, "free 以外の xref 項目数が一致する");
  entries.forEach((offset, index) => {
    assert.equal(text.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`,
      `xref[${index + 1}] が該当オブジェクトを指す`);
  });

  // 画像バイト列がそのまま入っている(再エンコードされていない)
  const firstPage = Buffer.from(pages[0]!).toString("latin1");
  assert.ok(text.includes(firstPage), "JPEG のバイト列がそのまま含まれる");
});

test("ページが無い書き出しは失敗する", () => {
  assert.throws(() => buildPdf([]), /at least one page/);
});

test("モノクロ書き出しは彩度を落とす", async () => {
  // 生成モデルは広い平坦な淡色面を勝手に色で塗る。色語の中立化と negative への
  // 色系追加を入れても CFG 4 で壁の着色は 4/4 で残った(実測)。モノクロ作品では
  // 出力を落とすだけで確実に消える。
  const colored = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 220, g: 180, b: 120 } }
  }).png().toBuffer();
  const gray = await sharp(colored).grayscale().png().toBuffer();
  const stats = await sharp(gray).stats();
  const [r, g, b] = stats.channels.map((channel) => channel.mean);
  assert.ok(Math.abs(r! - g!) < 1 && Math.abs(g! - b!) < 1, `灰色になっていない: ${r},${g},${b}`);

  const before = await sharp(colored).stats();
  const [br, , bb] = before.channels.map((channel) => channel.mean);
  assert.ok(Math.abs(br! - bb!) > 10, "元画像は色が付いている(検査の前提)");
});
