import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import sharp from "sharp";
import { createId, initializeDb, runSql } from "./db.ts";
import { createPagePreviewPng, withOpenRasterExport } from "./openRasterExport.ts";
import type { PageLayout } from "../shared/pageLayout.ts";
import { createImageObject } from "../shared/pageObjects.ts";
import { DEFAULT_TEXT_STYLE, defaultBalloonTail, defaultToneParams, type BalloonObject, type BoxObject, type TextObject, type ToneKind, type ToneObject } from "../shared/pageObjects.ts";

// 1x1 の最小 PNG(page_media ファイル用)。src/server/pages.test.ts と同一。
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

async function createOpenRasterExport(projectId: string, body: unknown) {
  return withOpenRasterExport(projectId, body, async (artifact) => ({
    ...artifact,
    buffer: await readFile(artifact.artifactPath)
  }));
}

test("createPagePreviewPng renders directly at the requested maximum dimension", async () => {
  initializeDb();
  const suffix = Date.now();
  const projectId = `project_preview_${suffix}`;
  const pageId = `page_preview_${suffix}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-preview-test-"));
  runSql(
    `INSERT INTO projects (id, name, description, mode, storage_dir, canvas_width, canvas_height)
     VALUES (?, ?, '', 'book', ?, 1000, 2000)`,
    [projectId, "Preview Test", storageDir]
  );
  runSql(
    "INSERT INTO pages (id, project_id, page_index, title, layout_json) VALUES (?, ?, 0, 'Page', ?)",
    [pageId, projectId, JSON.stringify({
      version: 1, page: { aspectRatio: [1, 2], height: 2 }, readingDirection: "rtl", panels: []
    })]
  );

  const preview = await createPagePreviewPng(projectId, pageId, { size: 320 });
  const metadata = await sharp(preview).metadata();
  assert.equal(metadata.width, 160);
  assert.equal(metadata.height, 320);
});

test("createOpenRasterExport: single layout page produces a baseline ORA with panel layer first", async () => {
  initializeDb();
  const projectId = `project_ora_${Date.now()}`;
  const pageId = `page_ora_${Date.now()}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-ora-test-"));
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1], height: 1 },
    readingDirection: "rtl",
    panels: [
      {
        id: "panel_1",
        order: 1,
        shape: { type: "rect", bounds: [0.1, 0.1, 0.9, 0.9] }
      }
    ]
  };

  runSql(
    `INSERT INTO projects (id, name, description, mode, storage_dir, canvas_width, canvas_height)
     VALUES (?, ?, '', 'book', ?, 256, 256)`,
    [projectId, "ORA Test", storageDir]
  );
  runSql(
    "INSERT INTO pages (id, project_id, page_index, title, layout_json) VALUES (?, ?, 0, 'Spread', ?)",
    [pageId, projectId, JSON.stringify(layout)]
  );

  const result = await createOpenRasterExport(projectId, { pageIds: [pageId] });
  assert.equal(result.contentType, "image/openraster");
  assert.equal(result.filename, "001-Spread.ora");

  const zip = await JSZip.loadAsync(result.buffer);
  assert.equal(await zip.file("mimetype")?.async("string"), "image/openraster");
  assert.ok(zip.file("stack.xml"));
  assert.ok(zip.file("data/layer-001.png"));
  assert.ok(zip.file("data/layer-002.png"));
  assert.ok(zip.file("mergedimage.png"));
  assert.ok(zip.file("Thumbnails/thumbnail.png"));

  const stackXml = await zip.file("stack.xml")!.async("string");
  assert.match(stackXml, /<image version="0\.0\.3" w="256" h="256"/);
  assert.match(stackXml, /<layer name="Panels" src="data\/layer-002\.png"/);
  assert.match(stackXml, /<layer name="Paper" src="data\/layer-001\.png"/);
});

// Docs/Feature-ScriptToManga.md S2: ImageObject の back/front 帯。back はコマ画像の後・コマ枠の前、
// front(box/text/balloon と同じ帯)はコマ枠の後に来ること(ORA レイヤー順で検証)。
test("createOpenRasterExport: back-band ImageObject layers before Panels, front-band after", async () => {
  initializeDb();
  const projectId = `project_ora_img_${Date.now()}`;
  const pageId = `page_ora_img_${Date.now()}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-ora-image-test-"));
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1], height: 1 },
    readingDirection: "rtl",
    panels: [{ id: "panel_1", order: 1, shape: { type: "rect", bounds: [0.1, 0.1, 0.9, 0.9] } }]
  };

  const pageMediaDir = join(storageDir, "projects", projectId, "page_media");
  await mkdir(pageMediaDir, { recursive: true });
  const backMediaId = createId("media");
  const frontMediaId = createId("media");
  const backMediaPath = join(pageMediaDir, `${backMediaId}.png`);
  const frontMediaPath = join(pageMediaDir, `${frontMediaId}.png`);
  await writeFile(backMediaPath, Buffer.from(TINY_PNG_BASE64, "base64"));
  await writeFile(frontMediaPath, Buffer.from(TINY_PNG_BASE64, "base64"));

  runSql(
    `INSERT INTO projects (id, name, description, mode, storage_dir, canvas_width, canvas_height)
     VALUES (?, ?, '', 'book', ?, 256, 256)`,
    [projectId, "ORA Image Test", storageDir]
  );
  runSql(
    "INSERT INTO page_media (id, project_id, file_path, width, height) VALUES (?, ?, ?, 1, 1)",
    [backMediaId, projectId, backMediaPath]
  );
  runSql(
    "INSERT INTO page_media (id, project_id, file_path, width, height) VALUES (?, ?, ?, 1, 1)",
    [frontMediaId, projectId, frontMediaPath]
  );

  const backObject = { ...createImageObject("img_back", { x: 0.5, y: 0.5 }, backMediaId, { x: 0.3, y: 0.3 }), band: "back" as const };
  const frontObject = createImageObject("img_front", { x: 0.5, y: 0.5 }, frontMediaId, { x: 0.3, y: 0.3 });
  runSql(
    "INSERT INTO pages (id, project_id, page_index, title, layout_json, objects_json) VALUES (?, ?, 0, 'Spread', ?, ?)",
    [pageId, projectId, JSON.stringify(layout), JSON.stringify([backObject, frontObject])]
  );

  const result = await createOpenRasterExport(projectId, { pageIds: [pageId] });
  const zip = await JSZip.loadAsync(result.buffer);
  const stackXml = await zip.file("stack.xml")!.async("string");

  const backIndex = stackXml.indexOf('name="Objects (back)"');
  const panelsIndex = stackXml.indexOf('name="Panels"');
  const frontIndex = stackXml.lastIndexOf('name="Objects"');
  assert.ok(backIndex >= 0, "expected an 'Objects (back)' layer");
  assert.ok(panelsIndex >= 0, "expected a 'Panels' layer");
  assert.ok(frontIndex >= 0, "expected an 'Objects' (front) layer");
  // stack.xml lists layers top-first (renderStackXml reverses paint order), so the layer that
  // paints LAST (front-most) appears FIRST in the XML. Paint order is back -> Panels -> front,
  // so in the XML listing: front comes before Panels, which comes before back.
  assert.ok(frontIndex < panelsIndex, "front-band Objects layer should paint after (list before) Panels");
  assert.ok(panelsIndex < backIndex, "Panels should paint after (list before) the back-band Objects layer");
});

// Docs/Feature-ScriptToManga.md S2: file/media 行欠損は書き出しをスキップして警告ログ(黙って落とさない)。
test("createOpenRasterExport: missing page_media is skipped without throwing", async () => {
  initializeDb();
  const projectId = `project_ora_missing_${Date.now()}`;
  const pageId = `page_ora_missing_${Date.now()}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-ora-missing-test-"));
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1], height: 1 },
    readingDirection: "rtl",
    panels: [{ id: "panel_1", order: 1, shape: { type: "rect", bounds: [0.1, 0.1, 0.9, 0.9] } }]
  };

  runSql(
    `INSERT INTO projects (id, name, description, mode, storage_dir, canvas_width, canvas_height)
     VALUES (?, ?, '', 'book', ?, 256, 256)`,
    [projectId, "ORA Missing Test", storageDir]
  );
  const orphanObject = createImageObject("img_orphan", { x: 0.5, y: 0.5 }, "media_does_not_exist", { x: 0.3, y: 0.3 });
  runSql(
    "INSERT INTO pages (id, project_id, page_index, title, layout_json, objects_json) VALUES (?, ?, 0, 'Spread', ?, ?)",
    [pageId, projectId, JSON.stringify(layout), JSON.stringify([orphanObject])]
  );

  const result = await createOpenRasterExport(projectId, { pageIds: [pageId] });
  const zip = await JSZip.loadAsync(result.buffer);
  const stackXml = await zip.file("stack.xml")!.async("string");
  // 欠損オブジェクトしか無いのでレイヤー自体が追加されない(空レイヤーは作らない規約)。
  assert.ok(!stackXml.includes('name="Objects'));
});

// Chronicle Page Flow(S5、Docs/Done/Feature-ChroniclePageFlow.md §6 フェーズV): 一括配置由来の
// BalloonObject(thought含む)/BoxObject(narration)/TextObject(sfx)が実際に ORA へラスタライズ
// されること(レイヤーが存在するだけでなく、非透明ピクセルが乗ること)を確認する回帰テスト。
test("createOpenRasterExport: balloon(thought含む)/box/text の一括配置オブジェクトが Objects レイヤーへ実際に描画される", async () => {
  initializeDb();
  const projectId = `project_ora_dialogue_${Date.now()}`;
  const pageId = `page_ora_dialogue_${Date.now()}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-ora-dialogue-test-"));
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1], height: 1 },
    readingDirection: "rtl",
    panels: [{ id: "panel_1", order: 1, shape: { type: "rect", bounds: [0.1, 0.1, 0.9, 0.9] } }]
  };

  const speechBalloon: BalloonObject = {
    id: "balloon_speech",
    kind: "balloon",
    position: { x: 0.3, y: 0.3 },
    rotation: 0,
    shape: "ellipse",
    size: { x: 0.2, y: 0.15 },
    fill: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 0.006,
    tail: defaultBalloonTail({ x: 0.2, y: 0.15 }),
    content: { text: "テスト", style: { ...DEFAULT_TEXT_STYLE } }
  };
  const thoughtBalloon: BalloonObject = {
    id: "balloon_thought",
    kind: "balloon",
    position: { x: 0.7, y: 0.3 },
    rotation: 0,
    shape: "thought",
    size: { x: 0.2, y: 0.15 },
    fill: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 0.006,
    tail: null,
    content: { text: "……", style: { ...DEFAULT_TEXT_STYLE } }
  };
  const narrationBox: BoxObject = {
    id: "box_narration",
    kind: "box",
    position: { x: 0.5, y: 0.7 },
    rotation: 0,
    size: { x: 0.3, y: 0.1 },
    cornerRadius: 0,
    fill: "#ffffff",
    strokeColor: "#000000",
    strokeWidth: 0.004,
    content: { text: "ナレーション", style: { ...DEFAULT_TEXT_STYLE } }
  };
  const sfxText: TextObject = {
    id: "text_sfx",
    kind: "text",
    position: { x: 0.5, y: 0.5 },
    rotation: 0,
    content: { text: "ドドドド", style: { ...DEFAULT_TEXT_STYLE, size: DEFAULT_TEXT_STYLE.size * 2 } }
  };

  runSql(
    `INSERT INTO projects (id, name, description, mode, storage_dir, canvas_width, canvas_height)
     VALUES (?, ?, '', 'book', ?, 256, 256)`,
    [projectId, "ORA Dialogue Test", storageDir]
  );
  runSql(
    "INSERT INTO pages (id, project_id, page_index, title, layout_json, objects_json) VALUES (?, ?, 0, 'Spread', ?, ?)",
    [pageId, projectId, JSON.stringify(layout), JSON.stringify([speechBalloon, thoughtBalloon, narrationBox, sfxText])]
  );

  const result = await createOpenRasterExport(projectId, { pageIds: [pageId] });
  const zip = await JSZip.loadAsync(result.buffer);
  const stackXml = await zip.file("stack.xml")!.async("string");
  assert.match(stackXml, /<layer name="Objects" src="data\//);

  const objectsLayerMatch = stackXml.match(/<layer name="Objects" src="(data\/[^"]+)"/);
  assert.ok(objectsLayerMatch, "Objects layer entry should reference a data file");
  const objectsLayerFile = zip.file(objectsLayerMatch![1]!);
  assert.ok(objectsLayerFile, "Objects layer PNG should exist in the zip");
  const objectsPngBuffer = Buffer.from(await objectsLayerFile!.async("nodebuffer"));

  // 実際に非透明ピクセルが描かれていることを確認する(レイヤーが存在するだけの空描画を弾く)。
  const { data, info } = await sharp(objectsPngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaquePixelCount = 0;
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i]! > 0) {
      opaquePixelCount += 1;
    }
  }
  assert.ok(opaquePixelCount > 0, "expected at least one non-transparent pixel from balloon/box/text objects");

  // mergedimage.png 側にも反映される(合成結果として最終出力に含まれる)。
  const mergedBuffer = Buffer.from(await zip.file("mergedimage.png")!.async("nodebuffer"));
  const merged = await sharp(mergedBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let mergedOpaqueCount = 0;
  for (let i = 3; i < merged.data.length; i += merged.info.channels) {
    if (merged.data[i]! > 0) {
      mergedOpaqueCount += 1;
    }
  }
  assert.ok(mergedOpaqueCount > 0, "expected merged image to contain non-transparent pixels from the objects layer");
});

// Docs/Feature-ScreenTones.md: トーン(halftone/gradient/lines/speed/focus/flash/noise/snow 全種)を含む
// ページの書き出しスモーク。例外なく PNG が出ること、トーン有無でピクセルが変化する程度の緩い検証
// (仕様書指定)。librsvg(sharp)が pattern/mask/patternTransform/clipPath/filter(feGaussianBlur を含む)を
// 実際にラスタライズできることも兼ねて確認する(noise/snow は 2026-07-14 追補)。
test("createOpenRasterExport: トーン(8種)を含むページが例外なく書き出され、トーンの有無でピクセルが変化する", async () => {
  initializeDb();
  const projectId = `project_ora_tone_${Date.now()}`;
  const pageId = `page_ora_tone_${Date.now()}`;
  const baselinePageId = `page_ora_tone_base_${Date.now()}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-ora-tone-test-"));
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1], height: 1 },
    readingDirection: "rtl",
    panels: [{ id: "panel_1", order: 1, shape: { type: "rect", bounds: [0.1, 0.1, 0.9, 0.9] } }]
  };

  const positions: Record<ToneKind, { x: number; y: number }> = {
    halftone: { x: 0.2, y: 0.2 },
    gradient: { x: 0.5, y: 0.2 },
    lines: { x: 0.8, y: 0.2 },
    speed: { x: 0.2, y: 0.5 },
    focus: { x: 0.5, y: 0.5 },
    flash: { x: 0.8, y: 0.5 },
    noise: { x: 0.2, y: 0.8 },
    snow: { x: 0.5, y: 0.8 }
  };
  const toneObjects: ToneObject[] = (Object.keys(positions) as ToneKind[]).map((toneType, index) => ({
    id: `tone_${toneType}`,
    kind: "tone",
    position: positions[toneType],
    // focus だけ回転+コマクリップを付け、二重クリップ+回転の合成経路も一緒に確認する。
    rotation: toneType === "focus" ? 0.3 : 0,
    size: { x: 0.15, y: 0.15 },
    toneType,
    color: toneType === "flash" ? "#ff0000" : "#000000",
    opacity: toneType === "flash" ? 0.8 : 1,
    clipPanelId: toneType === "focus" ? "panel_1" : null,
    seed: index + 1,
    // lines は濃度グラデ+始点/終点(2026-07-15 追補2)込みにして、userSpaceOnUse の linearGradient を
    // mask に張る新経路も librsvg が実際にラスタライズできることを兼ねて確認する。
    params:
      toneType === "lines"
        ? { ...defaultToneParams("lines"), startRatio: 0.95, endRatio: 0.1, gradStart: { x: -0.04, y: -0.03 }, gradEnd: { x: 0.05, y: 0.04 } }
        : defaultToneParams(toneType)
  }));

  runSql(
    `INSERT INTO projects (id, name, description, mode, storage_dir, canvas_width, canvas_height)
     VALUES (?, ?, '', 'book', ?, 256, 256)`,
    [projectId, "ORA Tone Test", storageDir]
  );
  runSql(
    "INSERT INTO pages (id, project_id, page_index, title, layout_json, objects_json) VALUES (?, ?, 0, 'Spread', ?, ?)",
    [pageId, projectId, JSON.stringify(layout), JSON.stringify(toneObjects)]
  );
  runSql("INSERT INTO pages (id, project_id, page_index, title, layout_json) VALUES (?, ?, 1, 'Baseline', ?)", [
    baselinePageId,
    projectId,
    JSON.stringify(layout)
  ]);

  const result = await createOpenRasterExport(projectId, { pageIds: [pageId] });
  const zip = await JSZip.loadAsync(result.buffer);
  const stackXml = await zip.file("stack.xml")!.async("string");
  assert.match(stackXml, /<layer name="Objects" src="data\//);

  const objectsLayerMatch = stackXml.match(/<layer name="Objects" src="(data\/[^"]+)"/);
  assert.ok(objectsLayerMatch, "Objects layer entry should reference a data file");
  const objectsLayerFile = zip.file(objectsLayerMatch![1]!);
  assert.ok(objectsLayerFile, "Objects layer PNG should exist in the zip");
  const objectsPngBuffer = Buffer.from(await objectsLayerFile!.async("nodebuffer"));

  // 実際に非透明ピクセルが描かれていることを確認する(レイヤーが存在するだけの空描画を弾く)。
  const { data, info } = await sharp(objectsPngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaquePixelCount = 0;
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i]! > 0) {
      opaquePixelCount += 1;
    }
  }
  assert.ok(opaquePixelCount > 0, "expected at least one non-transparent pixel from tone objects");

  // トーン無しページ(baseline)と比べて mergedimage.png のピクセルが変化していること(緩い検証)。
  const baselineResult = await createOpenRasterExport(projectId, { pageIds: [baselinePageId] });
  const baselineZip = await JSZip.loadAsync(baselineResult.buffer);
  const withToneMerged = Buffer.from(await zip.file("mergedimage.png")!.async("nodebuffer"));
  const baselineMerged = Buffer.from(await baselineZip.file("mergedimage.png")!.async("nodebuffer"));
  assert.notEqual(Buffer.compare(withToneMerged, baselineMerged), 0, "tone should change the rendered pixels vs. a blank page");
});

// Docs/Feature-ScreenTones.md 追補: snow は <filter><feGaussianBlur></filter> を使う唯一のトーン種別。
// 上の複合スモークだと他7種の不透明ピクセルに埋もれて「ぼかしが実際に効いているか」が検証できないため、
// snow 単体のページで librsvg(sharp)が feGaussianBlur を実際にラスタライズできることを直接確認する。
test("createOpenRasterExport: snow(feGaussianBlur)が単体でも例外なく書き出され、ぼかしピクセルが描かれる", async () => {
  initializeDb();
  const projectId = `project_ora_snow_${Date.now()}`;
  const pageId = `page_ora_snow_${Date.now()}`;
  const storageDir = await mkdtemp(join(tmpdir(), "guruguru-ora-snow-test-"));
  const layout: PageLayout = {
    version: 1,
    page: { aspectRatio: [1, 1], height: 1 },
    readingDirection: "rtl",
    panels: []
  };
  const snowObject: ToneObject = {
    id: "tone_snow_solo",
    kind: "tone",
    position: { x: 0.5, y: 0.5 },
    rotation: 0,
    size: { x: 0.6, y: 0.6 },
    toneType: "snow",
    color: "#3355ff",
    opacity: 1,
    clipPanelId: null,
    seed: 7,
    // 強めのぼかしにして、ぼかし由来のピクセルが確実に検出できるようにする。
    params: { ...defaultToneParams("snow"), count: 60, frontBlur: 1.2, backBlur: 1.5 }
  };
  runSql(
    `INSERT INTO projects (id, name, description, mode, storage_dir, canvas_width, canvas_height)
     VALUES (?, ?, '', 'book', ?, 256, 256)`,
    [projectId, "ORA Snow Test", storageDir]
  );
  runSql(
    "INSERT INTO pages (id, project_id, page_index, title, layout_json, objects_json) VALUES (?, ?, 0, 'Spread', ?, ?)",
    [pageId, projectId, JSON.stringify(layout), JSON.stringify([snowObject])]
  );

  const result = await createOpenRasterExport(projectId, { pageIds: [pageId] });
  const zip = await JSZip.loadAsync(result.buffer);
  const objectsLayerMatch = (await zip.file("stack.xml")!.async("string")).match(/<layer name="Objects" src="(data\/[^"]+)"/);
  assert.ok(objectsLayerMatch, "Objects layer entry should reference a data file");
  const objectsPngBuffer = Buffer.from(await zip.file(objectsLayerMatch![1]!)!.async("nodebuffer"));
  const { data, info } = await sharp(objectsPngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaquePixelCount = 0;
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i]! > 0) {
      opaquePixelCount += 1;
    }
  }
  assert.ok(opaquePixelCount > 0, "expected feGaussianBlur-rendered snow pixels to be non-transparent");
});
