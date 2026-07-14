import { describe, expect, test } from "bun:test";
import type { PageObject } from "../shared/pageObjects";
import { reorderPageObjectLayer, stepPageObjectLayer, visiblePageObjects } from "./pageLayers";

function object(id: string, kind: PageObject["kind"], band?: "front" | "back"): PageObject {
  return { id, kind, ...(band ? { band } : {}) } as PageObject;
}

describe("pageLayers", () => {
  test("一時非表示と画像以外非表示をデータ変更なしで合成する", () => {
    const objects = [object("image", "image"), object("balloon", "balloon"), object("text", "text")];
    expect(visiblePageObjects(objects, ["image"], false).map((item) => item.id)).toEqual(["balloon", "text"]);
    expect(visiblePageObjects(objects, [], true).map((item) => item.id)).toEqual(["image"]);
    expect(objects.map((item) => item.id)).toEqual(["image", "balloon", "text"]);
  });

  test("上から並ぶレイヤのドロップを背面→前面の配列へ変換する", () => {
    const objects = [object("bottom", "text"), object("middle", "balloon"), object("top", "box")];
    expect(reorderPageObjectLayer(objects, "bottom", "middle", "before").map((item) => item.id)).toEqual([
      "middle",
      "bottom",
      "top"
    ]);
    expect(reorderPageObjectLayer(objects, "top", "middle", "after").map((item) => item.id)).toEqual([
      "bottom",
      "top",
      "middle"
    ]);
  });

  test("上下移動は同じ表示帯だけで入れ替え、帯をまたぐドロップは無視する", () => {
    const objects = [object("back", "image", "back"), object("front-a", "text"), object("front-b", "balloon")];
    expect(stepPageObjectLayer(objects, "front-a", "up").map((item) => item.id)).toEqual([
      "back",
      "front-b",
      "front-a"
    ]);
    expect(reorderPageObjectLayer(objects, "front-a", "back", "before").map((item) => item.id)).toEqual(
      objects.map((item) => item.id)
    );
  });
});
