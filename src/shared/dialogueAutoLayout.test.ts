import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderPanelsByReadingDirection,
  runDialogueAutoLayout,
  type DialogueAutoLayoutItem
} from "./dialogueAutoLayout.ts";
import type { LayoutPanel, PageLayout } from "./pageLayout.ts";
import type { PageObject, PageVec } from "./pageObjects.ts";

function rectPanel(id: string, order: number, bounds: [number, number, number, number]): LayoutPanel {
  return { id, order, shape: { type: "rect", bounds } };
}

/** 2x1(横並び2コマ)のレイアウト。 */
function twoPanelLayout(direction: "rtl" | "ltr" = "rtl"): PageLayout {
  return {
    version: 1,
    page: { aspectRatio: [1, 1.4142], height: 1.4142 },
    readingDirection: direction,
    panels: [rectPanel("panel_left", 1, [0, 0, 0.48, 1.4142]), rectPanel("panel_right", 2, [0.52, 0, 1, 1.4142])]
  };
}

/**
 * テスト用ビルダー。`size` を渡すと単一候補の sizeVariants として扱う(便宜上のショートハンド)。
 * `sizeVariants` を直接渡すことも可能(複数候補を試すケース用)。
 */
function item(
  overrides: Partial<Omit<DialogueAutoLayoutItem, "sizeVariants">> &
    Pick<DialogueAutoLayoutItem, "placementId" | "lineId" | "orderIndex"> & { size?: PageVec; sizeVariants?: PageVec[] }
): DialogueAutoLayoutItem {
  const { size, sizeVariants, ...rest } = overrides;
  return {
    text: "テスト",
    semanticKind: "dialogue",
    speakerLabel: "太郎",
    sizeVariants: sizeVariants ?? [size ?? { x: 0.1, y: 0.1 }],
    ...rest
  };
}

test("orderPanelsByReadingDirection: RTL は右上→左下(同じ行なら右のコマが先)", () => {
  const panels = [rectPanel("left", 1, [0, 0, 0.48, 0.5]), rectPanel("right", 2, [0.52, 0, 1, 0.5])];
  const ordered = orderPanelsByReadingDirection(panels, "rtl");
  assert.deepEqual(ordered.map((p) => p.id), ["right", "left"]);
});

test("orderPanelsByReadingDirection: LTR は左上→右下(同じ行なら左のコマが先)", () => {
  const panels = [rectPanel("left", 1, [0, 0, 0.48, 0.5]), rectPanel("right", 2, [0.52, 0, 1, 0.5])];
  const ordered = orderPanelsByReadingDirection(panels, "ltr");
  assert.deepEqual(ordered.map((p) => p.id), ["left", "right"]);
});

test("orderPanelsByReadingDirection: 行が違えば y が小さい(上の)行を先にする", () => {
  const panels = [rectPanel("bottom", 1, [0, 1, 1, 1.4]), rectPanel("top", 2, [0, 0, 1, 0.4])];
  const ordered = orderPanelsByReadingDirection(panels, "rtl");
  assert.deepEqual(ordered.map((p) => p.id), ["top", "bottom"]);
});

test("runDialogueAutoLayout: 同 seed なら同じ結果(位置・id とも再現)", () => {
  const layout = twoPanelLayout();
  const items: DialogueAutoLayoutItem[] = [
    item({ placementId: "p1", lineId: "l1", orderIndex: 0, text: "おはよう" }),
    item({ placementId: "p2", lineId: "l2", orderIndex: 1, text: "おはよう、太郎", speakerLabel: "花子" })
  ];
  const a = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 42 });
  const b = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 42 });
  assert.deepEqual(a, b);
  assert.equal(a.unplacedPlacementIds.length, 0);
  assert.equal(a.objects.length, 2);
});

test("runDialogueAutoLayout: 異なる seed では(通常)異なる配置になりうる", () => {
  const layout = twoPanelLayout();
  // 密集させて tie-break を誘発しやすいよう、同じサイズ・同じコマへ複数アイテムを置く。
  const items: DialogueAutoLayoutItem[] = Array.from({ length: 6 }, (_, i) =>
    item({ placementId: `p${i}`, lineId: `l${i}`, orderIndex: i, text: "あ", size: { x: 0.05, y: 0.05 } })
  );
  const results = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed });
    results.add(JSON.stringify(result.objects.map((o) => o.position)));
  }
  // 全 seed が同一配置になることはまず無い(tie-break が seed に依存するため)。
  assert.ok(results.size > 1, "seed によって配置が変わることを期待");
});

test("runDialogueAutoLayout: 非重複(生成されたオブジェクト同士は重ならない)", () => {
  const layout = twoPanelLayout();
  const items: DialogueAutoLayoutItem[] = Array.from({ length: 4 }, (_, i) =>
    item({ placementId: `p${i}`, lineId: `l${i}`, orderIndex: i, size: { x: 0.1, y: 0.1 } })
  );
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 7 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  for (let i = 0; i < result.objects.length; i += 1) {
    for (let j = i + 1; j < result.objects.length; j += 1) {
      const a = result.objects[i]! as { position: { x: number; y: number }; size?: { x: number; y: number } };
      const b = result.objects[j]! as { position: { x: number; y: number }; size?: { x: number; y: number } };
      if (!a.size || !b.size) continue;
      const overlap =
        Math.abs(a.position.x - b.position.x) < (a.size.x + b.size.x) / 2 &&
        Math.abs(a.position.y - b.position.y) < (a.size.y + b.size.y) / 2;
      assert.equal(overlap, false, `objects ${i} and ${j} should not overlap`);
    }
  }
});

test("runDialogueAutoLayout: コマ・ページ外に出ない", () => {
  const layout = twoPanelLayout();
  const items: DialogueAutoLayoutItem[] = [item({ placementId: "p1", lineId: "l1", orderIndex: 0, size: { x: 0.1, y: 0.1 } })];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 3 });
  const object = result.objects[0]! as { position: { x: number; y: number }; size: { x: number; y: number } };
  assert.ok(object.position.x - object.size.x / 2 >= 0);
  assert.ok(object.position.x + object.size.x / 2 <= 1);
  assert.ok(object.position.y - object.size.y / 2 >= 0);
  assert.ok(object.position.y + object.size.y / 2 <= layout.page.height);
});

test("runDialogueAutoLayout: 既存オブジェクトを避ける", () => {
  const layout = twoPanelLayout();
  // 右コマ全域を覆う既存 box。RTL なので右コマが先に埋まる想定 -- 既存オブジェクトのせいで
  // 右コマには置けず、警告付き unplaced になるか、あるいは他の空きを探す(コマ非依存の narration なら)。
  const existingObjects: PageObject[] = [
    {
      id: "existing_box",
      kind: "box",
      position: { x: 0.76, y: 0.7 },
      rotation: 0,
      size: { x: 0.48, y: 1.4 },
      fill: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: 0.004
    }
  ];
  const items: DialogueAutoLayoutItem[] = [item({ placementId: "p1", lineId: "l1", orderIndex: 0, size: { x: 0.1, y: 0.1 } })];
  const result = runDialogueAutoLayout({ layout, existingObjects, items, seed: 1 });
  if (result.objects.length > 0) {
    const object = result.objects[0]! as { position: { x: number; y: number }; size: { x: number; y: number } };
    const overlap =
      Math.abs(object.position.x - 0.76) < (object.size.x + 0.48) / 2 && Math.abs(object.position.y - 0.7) < (object.size.y + 1.4) / 2;
    assert.equal(overlap, false);
  } else {
    assert.equal(result.unplacedPlacementIds.length, 1);
  }
});

test("runDialogueAutoLayout: ロック済み(既存)吹き出しは障害物として避ける", () => {
  const layout = twoPanelLayout();
  const lockedBalloon: PageObject = {
    id: "locked_balloon",
    kind: "balloon",
    position: { x: 0.24, y: 0.3 },
    rotation: 0,
    shape: "ellipse",
    size: { x: 0.4, y: 0.4 },
    fill: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 0.004,
    tail: null
  };
  const items: DialogueAutoLayoutItem[] = [
    item({ placementId: "p1", lineId: "l1", orderIndex: 0, size: { x: 0.15, y: 0.15 }, speakerLabel: "太郎" })
  ];
  const result = runDialogueAutoLayout({ layout, existingObjects: [lockedBalloon], items, seed: 5 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  const object = result.objects[0]! as { position: { x: number; y: number }; size: { x: number; y: number } };
  const overlap =
    Math.abs(object.position.x - lockedBalloon.position.x) < (object.size.x + lockedBalloon.size.x) / 2 &&
    Math.abs(object.position.y - lockedBalloon.position.y) < (object.size.y + lockedBalloon.size.y) / 2;
  assert.equal(overlap, false);
});

test("runDialogueAutoLayout: narration はページ全体候補(コマ外にも置ける)", () => {
  const layout = twoPanelLayout();
  const items: DialogueAutoLayoutItem[] = [
    item({ placementId: "p1", lineId: "l1", orderIndex: 0, semanticKind: "narration", text: "その日、街は静かだった。", size: { x: 0.3, y: 0.08 } })
  ];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 9 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  assert.equal(result.objects[0]!.kind, "box");
  assert.equal(result.assignments[0]!.panelId, null);
});

test("runDialogueAutoLayout: 発話順とコマ順の単調性(order_index 昇順で panelId のコマ順が逆転しない)", () => {
  const layout = twoPanelLayout("rtl");
  const orderedPanelIds = orderPanelsByReadingDirection(layout.panels, "rtl").map((p) => p.id);
  const items: DialogueAutoLayoutItem[] = Array.from({ length: 6 }, (_, i) =>
    item({ placementId: `p${i}`, lineId: `l${i}`, orderIndex: i, text: "あいうえお".repeat(i + 1), size: { x: 0.08, y: 0.08 } })
  );
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 11 });
  const byOrder = items
    .map((it) => result.assignments.find((a) => a.placementId === it.placementId))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  let lastIndex = -1;
  for (const assignment of byOrder) {
    if (assignment.panelId === null) continue;
    const idx = orderedPanelIds.indexOf(assignment.panelId);
    assert.ok(idx >= lastIndex, "panel order must be non-decreasing along order_index");
    lastIndex = idx;
  }
});

test("runDialogueAutoLayout: LTR でも発話順とコマ順の単調性が保たれる(RTL と対称の回帰)", () => {
  const layout = twoPanelLayout("ltr");
  const orderedPanelIds = orderPanelsByReadingDirection(layout.panels, "ltr").map((p) => p.id);
  assert.deepEqual(orderedPanelIds, ["panel_left", "panel_right"]);
  const items: DialogueAutoLayoutItem[] = Array.from({ length: 6 }, (_, i) =>
    item({ placementId: `p${i}`, lineId: `l${i}`, orderIndex: i, text: "あいうえお".repeat(i + 1), size: { x: 0.08, y: 0.08 } })
  );
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 11 });
  const byOrder = items
    .map((it) => result.assignments.find((a) => a.placementId === it.placementId))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  let lastIndex = -1;
  for (const assignment of byOrder) {
    if (assignment.panelId === null) continue;
    const idx = orderedPanelIds.indexOf(assignment.panelId);
    assert.ok(idx >= lastIndex, "panel order must be non-decreasing along order_index (LTR)");
    lastIndex = idx;
  }
});

test("runDialogueAutoLayout: LTR は左寄りの候補を優先する(RTL の右寄り優先と対称)", () => {
  const layout = twoPanelLayout("ltr");
  const items: DialogueAutoLayoutItem[] = [item({ placementId: "p1", lineId: "l1", orderIndex: 0, size: { x: 0.1, y: 0.1 } })];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 3 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  const assignment = result.assignments[0]!;
  assert.equal(assignment.panelId, "panel_left", "LTR の先頭発話は左のコマへ配分されるはず");
  const object = result.objects[0]! as { position: { x: number; y: number } };
  // panel_left の bounds は [0, 0, 0.48, 1.4142]。走査は左寄り(x が小さい方)から優先するので、
  // 中心付近より左寄りに来ることを期待する(完全な左端固定は既存オブジェクト有無で変わるため緩めに確認)。
  assert.ok(object.position.x < 0.3, `expected a left-biased x position, got ${object.position.x}`);
});

test("runDialogueAutoLayout: 矩形コマの bbox 内に収まる", () => {
  const layout = twoPanelLayout();
  const items: DialogueAutoLayoutItem[] = [item({ placementId: "p1", lineId: "l1", orderIndex: 0, size: { x: 0.1, y: 0.1 } })];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 2 });
  const assignment = result.assignments[0]!;
  const panel = layout.panels.find((p) => p.id === assignment.panelId)!;
  const bounds = (panel.shape as { bounds: [number, number, number, number] }).bounds;
  const object = result.objects[0]! as { position: { x: number; y: number }; size: { x: number; y: number } };
  assert.ok(object.position.x - object.size.x / 2 >= bounds[0] - 1e-6);
  assert.ok(object.position.x + object.size.x / 2 <= bounds[2] + 1e-6);
});

test("runDialogueAutoLayout: polygon コマは内部判定で絞る(中心が polygon の外なら不採用)", () => {
  // 三角形コマ(polygon)。外接矩形は正方形だが、実面積は半分しかない。
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1], height: 1 },
    readingDirection: "rtl",
    panels: [{ id: "tri", order: 1, shape: { type: "polygon", points: [[0, 0], [1, 0], [0, 1]] } }]
  };
  const items: DialogueAutoLayoutItem[] = [item({ placementId: "p1", lineId: "l1", orderIndex: 0, size: { x: 0.15, y: 0.15 } })];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 4 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  const object = result.objects[0]! as { position: { x: number; y: number } };
  // 三角形 (0,0)-(1,0)-(0,1) の内部条件: x>=0, y>=0, x+y<=1。
  assert.ok(object.position.x + object.position.y <= 1 + 1e-6);
});

test("runDialogueAutoLayout: 配置不能(コマに対して大きすぎる)は unplaced + warning", () => {
  const layout = twoPanelLayout();
  const items: DialogueAutoLayoutItem[] = [
    item({ placementId: "p1", lineId: "l1", orderIndex: 0, size: { x: 2, y: 2 } })
  ];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 1 });
  assert.deepEqual(result.unplacedPlacementIds, ["p1"]);
  assert.equal(result.objects.length, 0);
  assert.ok(result.warnings.length > 0);
});

test("runDialogueAutoLayout: コマの無いページで dialogue は unplaced", () => {
  const layout: PageLayout = { version: 1, page: { aspectRatio: [1, 1.4], height: 1.4 }, readingDirection: "rtl", panels: [] };
  // panels が空だと normalizeEditedPageLayout は弾くが、ソルバー自体は panels=[] を受けても
  // 動く(API 層のバリデーションとは独立に純ロジックとして防御的であることを確認する)。
  const items: DialogueAutoLayoutItem[] = [item({ placementId: "p1", lineId: "l1", orderIndex: 0 })];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 1 });
  assert.deepEqual(result.unplacedPlacementIds, ["p1"]);
});

// --- 回帰テスト: sfx のページ全体フォールバック(問題1) ---

test("runDialogueAutoLayout: sfx はコマに対して大きすぎてもページ全体候補へフォールバックして配置できる(narrationと同様)", () => {
  const layout = twoPanelLayout();
  // コマ比率(0.8)を超える大きさの sfx。dialogue なら unplaced になるサイズ。
  const items: DialogueAutoLayoutItem[] = [
    item({ placementId: "p1", lineId: "l1", orderIndex: 0, semanticKind: "sfx", text: "ドドドド", size: { x: 0.9, y: 0.2 } })
  ];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 1 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  assert.equal(result.objects.length, 1);
  assert.equal(result.objects[0]!.kind, "text");
  // ページ全体配置(コマ非依存)として扱われる。
  assert.equal(result.assignments[0]!.panelId, null);
});

test("runDialogueAutoLayout: 同じ大きさなら dialogue は unplaced のまま(sfx だけがフォールバック対象)", () => {
  const layout = twoPanelLayout();
  const items: DialogueAutoLayoutItem[] = [
    item({ placementId: "p1", lineId: "l1", orderIndex: 0, semanticKind: "dialogue", size: { x: 0.9, y: 0.2 } })
  ];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 1 });
  assert.deepEqual(result.unplacedPlacementIds, ["p1"]);
});

test("runDialogueAutoLayout: sfx はコマに無関係な既存オブジェクトで担当コマが埋まっていてもページ全体から空きを見つける", () => {
  const layout = twoPanelLayout();
  // 右コマ(RTL の担当コマ)全域を覆う既存 box。sfx は右コマに入れず、ページ全体から探すはず。
  const existingObjects: PageObject[] = [
    {
      id: "existing_box",
      kind: "box",
      position: { x: 0.76, y: 0.7 },
      rotation: 0,
      size: { x: 0.48, y: 1.4 },
      fill: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: 0.004
    }
  ];
  const items: DialogueAutoLayoutItem[] = [
    item({ placementId: "p1", lineId: "l1", orderIndex: 0, semanticKind: "sfx", size: { x: 0.1, y: 0.1 } })
  ];
  const result = runDialogueAutoLayout({ layout, existingObjects, items, seed: 1 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  assert.equal(result.assignments[0]!.panelId, null);
});

test("runDialogueAutoLayout: コマの無いページでも sfx はページ全体に配置できる(dialogueとの非対称の確認)", () => {
  const layout: PageLayout = { version: 1, page: { aspectRatio: [1, 1.4], height: 1.4 }, readingDirection: "rtl", panels: [] };
  const items: DialogueAutoLayoutItem[] = [item({ placementId: "p1", lineId: "l1", orderIndex: 0, semanticKind: "sfx" })];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 1 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  assert.equal(result.assignments[0]!.panelId, null);
});

// --- 回帰テスト: サイズバリアント(問題2) ---

test("runDialogueAutoLayout: 先頭候補がコマに対して大きすぎても、より小さい候補で配置できる(従来 unplaced だったケース)", () => {
  const layout = twoPanelLayout();
  // 先頭候補はコマ比率を超える横長サイズ、2番目候補はコマに収まる縦長サイズ。
  const items: DialogueAutoLayoutItem[] = [
    item({
      placementId: "p1",
      lineId: "l1",
      orderIndex: 0,
      text: "おはようございます、今日はいい天気ですね",
      sizeVariants: [
        { x: 0.9, y: 0.2 }, // 収まらない(横長すぎる)
        { x: 0.3, y: 0.5 } // コマに収まる(縦長)
      ]
    })
  ];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 1 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  const object = result.objects[0]! as { size: { x: number; y: number } };
  assert.deepEqual(object.size, { x: 0.3, y: 0.5 });
});

test("runDialogueAutoLayout: 全バリアントが入らなければ unplaced(全滅時のみ unplaced の確認)", () => {
  const layout = twoPanelLayout();
  const items: DialogueAutoLayoutItem[] = [
    item({
      placementId: "p1",
      lineId: "l1",
      orderIndex: 0,
      sizeVariants: [
        { x: 0.9, y: 0.9 },
        { x: 0.95, y: 0.95 }
      ]
    })
  ];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 1 });
  assert.deepEqual(result.unplacedPlacementIds, ["p1"]);
});

test("runDialogueAutoLayout: 同 seed ならバリアント探索でも同じ結果(決定性維持)", () => {
  const layout = twoPanelLayout();
  const items: DialogueAutoLayoutItem[] = [
    item({
      placementId: "p1",
      lineId: "l1",
      orderIndex: 0,
      sizeVariants: [
        { x: 0.9, y: 0.2 },
        { x: 0.3, y: 0.5 },
        { x: 0.1, y: 0.1 }
      ]
    }),
    item({ placementId: "p2", lineId: "l2", orderIndex: 1, speakerLabel: "花子", sizeVariants: [{ x: 0.15, y: 0.15 }] })
  ];
  const a = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 99 });
  const b = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 99 });
  assert.deepEqual(a, b);
});

// --- 回避領域(顔・立ち絵)とコマ専有率上限(Docs/Reference-MangaCompositions.md) ---

/** 1コマ(横長)のレイアウト。回避領域・専有率テスト用。 */
function singlePanelLayout(): PageLayout {
  return {
    version: 1,
    page: { aspectRatio: [1, 1.4142], height: 1.4142 },
    readingDirection: "rtl",
    panels: [rectPanel("panel_only", 1, [0, 0, 1, 0.7])]
  };
}

function objectBox(object: PageObject): { x0: number; y0: number; x1: number; y1: number } {
  const size = (object as { size?: PageVec }).size ?? { x: 0, y: 0 };
  return {
    x0: object.position.x - size.x / 2,
    y0: object.position.y - size.y / 2,
    x1: object.position.x + size.x / 2,
    y1: object.position.y + size.y / 2
  };
}

test("runDialogueAutoLayout: avoidZones を strict パスで避けて配置する", () => {
  const layout = singlePanelLayout();
  // RTL の優先位置(右上)を覆う回避領域。ゾーン無しなら右上に置かれるところを外させる。
  const zone = { x: 0.4, y: 0, width: 0.6, height: 0.4, label: "顔" };
  const items = [item({ placementId: "p1", lineId: "l1", orderIndex: 0, size: { x: 0.2, y: 0.15 } })];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 11, avoidZones: [zone] });
  assert.equal(result.unplacedPlacementIds.length, 0);
  assert.equal(result.warnings.length, 0);
  const box = objectBox(result.objects[0]!);
  const overlaps =
    box.x0 < zone.x + zone.width && box.x1 > zone.x && box.y0 < zone.y + zone.height && box.y1 > zone.y;
  assert.equal(overlaps, false, "回避領域と重ならないこと");
});

test("runDialogueAutoLayout: avoidZones がコマ全面でも緩和して配置し警告を残す", () => {
  const layout = singlePanelLayout();
  const zone = { x: 0, y: 0, width: 1, height: 0.7, label: "立ち絵" };
  const items = [item({ placementId: "p1", lineId: "l1", orderIndex: 0, size: { x: 0.2, y: 0.15 } })];
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 11, avoidZones: [zone] });
  assert.equal(result.unplacedPlacementIds.length, 0);
  assert.equal(result.objects.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("緩和")), "緩和の警告が残ること");
});

test("runDialogueAutoLayout: maxPanelCoverageRatio 超過は pinned なら同コマで緩和配置(警告付き)", () => {
  const layout = singlePanelLayout();
  const items = [
    item({ placementId: "p1", lineId: "l1", orderIndex: 0, preferredPanelId: "panel_only", size: { x: 0.3, y: 0.3 } }),
    item({ placementId: "p2", lineId: "l2", orderIndex: 1, preferredPanelId: "panel_only", size: { x: 0.3, y: 0.3 } })
  ];
  // コマ面積 0.7、上限 0.15 → 許容面積 0.105。1件目(0.09)は入り、2件目で超過する。
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 3, maxPanelCoverageRatio: 0.15 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  assert.equal(result.objects.length, 2);
  assert.equal(result.assignments.every((assignment) => assignment.panelId === "panel_only"), true);
  assert.equal(result.warnings.filter((warning) => warning.includes("緩和")).length, 1);
});

test("runDialogueAutoLayout: maxPanelCoverageRatio 超過の非固定アイテムは後続コマへ逃がす", () => {
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1.4142], height: 1.4142 },
    readingDirection: "rtl",
    panels: [rectPanel("panel_top", 1, [0, 0, 1, 0.65]), rectPanel("panel_bottom", 2, [0, 0.75, 1, 1.4])]
  };
  // 等重み3件 → 文字量比配分で先頭2件が panel_top、3件目が panel_bottom。
  const items = [
    item({ placementId: "p1", lineId: "l1", orderIndex: 0, text: "abcde", size: { x: 0.3, y: 0.3 } }),
    item({ placementId: "p2", lineId: "l2", orderIndex: 1, text: "abcde", size: { x: 0.3, y: 0.3 } }),
    item({ placementId: "p3", lineId: "l3", orderIndex: 2, text: "abcde", size: { x: 0.3, y: 0.3 } })
  ];
  // panel_top 面積 0.65、上限 0.2 → 許容 0.13。2件目(累計 0.18)は strict では入らず panel_bottom へ。
  const result = runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 3, maxPanelCoverageRatio: 0.2 });
  assert.equal(result.unplacedPlacementIds.length, 0);
  const panelByPlacement = new Map(result.assignments.map((assignment) => [assignment.placementId, assignment.panelId]));
  assert.equal(panelByPlacement.get("p1"), "panel_top");
  assert.equal(panelByPlacement.get("p2"), "panel_bottom", "専有率超過分は後続コマへ逃げること");
  assert.equal(panelByPlacement.get("p3"), "panel_bottom");
});

test("runDialogueAutoLayout: avoidZones/専有率付きでも同 seed なら同じ結果", () => {
  const layout = singlePanelLayout();
  const zone = { x: 0.4, y: 0, width: 0.6, height: 0.4 };
  const items = [
    item({ placementId: "p1", lineId: "l1", orderIndex: 0, size: { x: 0.2, y: 0.15 } }),
    item({ placementId: "p2", lineId: "l2", orderIndex: 1, speakerLabel: "花子", size: { x: 0.2, y: 0.15 } })
  ];
  const run = () =>
    runDialogueAutoLayout({ layout, existingObjects: [], items, seed: 21, avoidZones: [zone], maxPanelCoverageRatio: 0.5 });
  assert.deepEqual(run(), run());
});
