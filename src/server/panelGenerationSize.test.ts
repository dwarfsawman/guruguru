/**
 * 生成キャンバスの縦横比の上限。極端なキャンバスを与えると拡散モデルは被写体を複製して
 * 面を埋めようとするため、コマがどれだけ極端でも生成側は締める(コマへ収める時に切る)。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PageLayout } from "../shared/pageLayout.ts";
import { panelGenerationSize } from "./scriptMangaSubmission.ts";

function layoutWith(bounds: [number, number, number, number]): PageLayout {
  return {
    version: 1,
    page: { aspectRatio: [182, 257], height: 1.412 },
    readingDirection: "rtl",
    panels: [{ id: "p", order: 1, shape: { type: "rect", bounds } }]
  } as unknown as PageLayout;
}

const CAP = 2;

test("panelGenerationSize: 極端な横長コマでも生成アスペクトは上限までに収める", () => {
  // 0.92 x 0.22 の帯コマ = 4.2:1。従来は 2:1(1024x512)まで許していたが、
  // 実測でその比でも単独人物が2〜4体に複製された。
  const band = panelGenerationSize(layoutWith([0.04, 0.10, 0.96, 0.32]), "p", 1024, "chroma");
  const ratio = band.width / band.height;
  assert.ok(ratio <= CAP + 1e-6, `band ratio ${ratio}`);
  assert.ok(ratio > 1, "横長であることは保つ");
});

test("panelGenerationSize: 極端な縦長コマも同じ上限で締める", () => {
  const column = panelGenerationSize(layoutWith([0.04, 0.02, 0.30, 1.38]), "p", 1024, "chroma");
  const ratio = column.height / column.width;
  assert.ok(ratio <= CAP + 1e-6, `column ratio ${ratio}`);
  assert.ok(ratio > 1, "縦長であることは保つ");
});

test("panelGenerationSize: 上限内のコマはアスペクトをそのまま使う", () => {
  // 0.45 x 0.40 ≒ 1.125:1
  const size = panelGenerationSize(layoutWith([0.04, 0.10, 0.49, 0.50]), "p", 1024, "chroma");
  const ratio = size.width / size.height;
  assert.ok(Math.abs(ratio - 0.45 / 0.40) < 0.08, `ratio ${ratio}`);
});

test("panelGenerationSize: 長辺は longEdge を超えない", () => {
  const size = panelGenerationSize(layoutWith([0.04, 0.10, 0.96, 0.32]), "p", 1024, "chroma");
  assert.ok(Math.max(size.width, size.height) <= 1024);
  assert.equal(size.width % 64, 0);
  assert.equal(size.height % 64, 0);
});
