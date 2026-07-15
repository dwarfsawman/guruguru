import assert from "node:assert/strict";
import test from "node:test";
import type { FontSummary } from "../shared/apiTypes.ts";
import { pickDefaultFont, pickMangaFont } from "./fonts.ts";

function font(id: string, familyName: string, subfamilyName: string): FontSummary {
  return { id, familyName, subfamilyName, source: "system" };
}

test("pickDefaultFont prefers the Bold face of the exact Japanese family", () => {
  const selected = pickDefaultFont([
    font("black", "Noto Sans JP Black", "Regular"),
    font("regular", "Noto Sans JP", "Regular"),
    font("bold", "Noto Sans JP", "Bold")
  ]);
  assert.equal(selected?.id, "bold");
});

test("pickMangaFont prefers GenEi Antique without changing the general default", () => {
  const fonts = [
    font("noto-bold", "Noto Sans JP", "Bold"),
    font("genei", "源暎アンチック v5", "Regular")
  ];
  assert.equal(pickMangaFont(fonts)?.id, "genei");
  assert.equal(pickDefaultFont(fonts)?.id, "noto-bold");
});

test("pickDefaultFont falls back to Regular when a bold face is unavailable", () => {
  const selected = pickDefaultFont([font("regular", "Noto Sans JP", "Regular")]);
  assert.equal(selected?.id, "regular");
});
