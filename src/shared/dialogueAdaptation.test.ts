import test from "node:test";
import assert from "node:assert/strict";
import { parseFountain } from "./fountain.ts";
import { extractFillUnits, splitDialogueUnits } from "./dialogueAdaptation.ts";

test("adapt分割は呼吸単位に分け、連結すると原文へ完全一致する", () => {
  const text = "私が止めなきゃ、みんな死ぬ。だから、ここで終わらせる！";
  const units = splitDialogueUnits({ lineId: "l1", text, semanticKind: "dialogue", balloonStyle: "normal", maxChars: 18 });
  assert.ok(units.length > 1);
  assert.equal(units.map((unit) => unit.text).join(""), text);
  assert.deepEqual(units.map((unit) => unit.part), units.map((_, index) => index + 1));
});

test("fillはscene headingとactionの《monitor》を決定的抽出する", () => {
  const doc = parseFountain("INT. COCKPIT - NIGHT\n\nモニターに《同期率 98.7%》が点滅し、大爆発が起きる。").doc;
  const units = extractFillUnits(doc, (scene, element) => `source:r:${scene}:${element}`);
  assert.equal(units[0]!.balloonStyle, "caption");
  assert.deepEqual(units.filter((unit) => unit.balloonStyle === "monitor").map((unit) => unit.text), ["同期率 98.7%"]);
  assert.deepEqual(units.filter((unit) => unit.balloonStyle === "sfx").map((unit) => unit.text), ["ドカーン"]);
});
