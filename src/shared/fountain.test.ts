import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseFountain } from "./fountain.ts";

describe("parseFountain", () => {
  test("日本語 @cue の台詞を1シーンとして解析する", () => {
    const { doc, warnings } = parseFountain(
      [
        "INT. 教室 - 昼",
        "",
        "@太郎",
        "おはよう。",
        "",
        "@花子",
        "おはよう、太郎。"
      ].join("\n")
    );
    assert.equal(doc.scenes.length, 1);
    assert.equal(doc.scenes[0]!.heading, "INT. 教室 - 昼");
    const dialogues = doc.scenes[0]!.elements.filter((el) => el.type === "dialogue");
    assert.equal(dialogues.length, 2);
    assert.deepEqual(
      dialogues.map((el) => (el.type === "dialogue" ? el.speaker : "")),
      ["太郎", "花子"]
    );
    assert.equal((dialogues[0] as { text: string }).text, "おはよう。");
    assert.equal(warnings.length, 0);
  });

  test("寛容モード: `@` 無しの短い日本語話者行を cue とみなす", () => {
    const { doc } = parseFountain(["太郎", "元気か？"].join("\n"));
    const dialogue = doc.scenes[0]!.elements[0];
    assert.equal(dialogue?.type, "dialogue");
    assert.equal((dialogue as { speaker: string }).speaker, "太郎");
  });

  test("寛容モード: 誤検出しそうな文はActionへフォールバックする", () => {
    // 句読点を含む/長い文なので lenient cue 候補から外れ、Action として扱われる。
    const { doc } = parseFountain(["今日はいい天気だ。", "とても静かな朝だった。"].join("\n"));
    const elements = doc.scenes[0]!.elements;
    assert.equal(elements.length, 1);
    assert.equal(elements[0]!.type, "action");
  });

  test("空の台詞本文・空の話者名で警告を積む", () => {
    const { warnings: w1 } = parseFountain(["@太郎", ""].join("\n"));
    assert.ok(w1.some((msg) => msg.includes("台詞本文が空")));

    const { warnings: w2 } = parseFountain(["@", "こんにちは"].join("\n"));
    assert.ok(w2.some((msg) => msg.includes("話者名が空")));
  });

  test("Boneyard `/* */` を除去する", () => {
    const { doc } = parseFountain(
      ["INT. 部屋 - 夜", "", "/* これはメモで消える */", "@太郎", "こんばんは。"].join("\n")
    );
    const dialogue = doc.scenes[0]!.elements.find((el) => el.type === "dialogue");
    assert.ok(dialogue);
    assert.equal((dialogue as { text: string }).text, "こんばんは。");
  });

  test("Note `[[ ]]` は保持される", () => {
    const { doc } = parseFountain(["彼は[[ここは後で直す]]立ち止まった。"].join("\n"));
    const action = doc.scenes[0]!.elements[0];
    assert.equal(action?.type, "action");
    assert.ok((action as { text: string }).text.includes("[[ここは後で直す]]"));
  });

  test("Dual dialogue `^` は単一化(通常の cue として扱う)", () => {
    const { doc } = parseFountain(["@ALICE", "Hello!", "", "@BOB^", "Hi!"].join("\n"));
    const dialogues = doc.scenes[0]!.elements.filter((el) => el.type === "dialogue") as Array<{
      speaker: string;
      text: string;
    }>;
    assert.equal(dialogues.length, 2);
    assert.equal(dialogues[1]!.speaker, "BOB");
    assert.equal(dialogues[1]!.text, "Hi!");
  });

  test("英語 ALL CAPS cue も認識する", () => {
    const { doc } = parseFountain(["INT. HOUSE - DAY", "", "ALICE", "Hello there."].join("\n"));
    const dialogue = doc.scenes[0]!.elements.find((el) => el.type === "dialogue");
    assert.equal((dialogue as { speaker: string })?.speaker, "ALICE");
  });

  test("強制シーンヘディング(先頭 `.`)を認識する", () => {
    const { doc } = parseFountain([".宇宙船 - コックピット", "静寂。"].join("\n"));
    assert.equal(doc.scenes[0]!.heading, "宇宙船 - コックピット");
  });

  test("Transition(自然 TO: / 強制 `>`)を認識する", () => {
    const { doc } = parseFountain(
      ["INT. A - DAY", "アクション。", "CUT TO:", "", "INT. B - DAY", "", ">FADE OUT"].join("\n")
    );
    const allTransitions = doc.scenes.flatMap((scene) => scene.elements.filter((el) => el.type === "transition"));
    assert.equal(allTransitions.length, 2);
    assert.equal((allTransitions[0] as { text: string }).text, "CUT TO:");
    assert.equal((allTransitions[1] as { text: string }).text, "FADE OUT");
  });

  test("Section `#` と Synopsis `=` を認識する", () => {
    const { doc } = parseFountain(["# 第一幕", "= 主人公が目覚める", "INT. A - DAY", "朝。"].join("\n"));
    const elements = doc.scenes[0]!.elements;
    assert.equal(elements[0]!.type, "section");
    assert.equal((elements[0] as { depth: number }).depth, 1);
    assert.equal(elements[1]!.type, "synopsis");
  });

  test("Parenthetical を最初の1行だけ捕捉する", () => {
    const { doc } = parseFountain(["@太郎", "(小声で)", "静かに。"].join("\n"));
    const dialogue = doc.scenes[0]!.elements[0];
    assert.equal(dialogue?.type, "dialogue");
    assert.equal((dialogue as { parenthetical?: string }).parenthetical, "(小声で)");
    assert.equal((dialogue as { text: string }).text, "静かに。");
  });

  test("Title Page を解析する", () => {
    const { doc } = parseFountain(["Title: サンプル脚本", "Author: 山田太郎", "", "INT. A - DAY", "本文。"].join("\n"));
    assert.equal(doc.titlePage.Title, "サンプル脚本");
    assert.equal(doc.titlePage.Author, "山田太郎");
    assert.equal(doc.scenes.length, 1);
  });

  test("シーン見出しの無い脚本は暗黙の空見出しシーンへ収める", () => {
    const { doc } = parseFountain(["@太郎", "テスト。"].join("\n"));
    assert.equal(doc.scenes.length, 1);
    assert.equal(doc.scenes[0]!.heading, "");
  });
});
