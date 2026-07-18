/**
 * `.guruguru-layout.json5` エクスポート(ネームv4 D6 / SPEC v0.3 §27)。PageLayout →
 * 規格ルート構造(JSON5 化前のプレーンオブジェクト)の純ロジック。JSON5 文字列化は
 * サーバ側(layoutTemplates.ts)で行う(json5 依存をサーバに閉じる、取り込みと対称)。
 *
 * エクスポータ MUST(§27.1): schemaVersion / coordinateSystem / document.mode /
 * pages(aspectRatio 含む) / panels の id・order・shape(id 一意・order 昇順)。
 * SHOULD: frame(既定と異なる場合)・role・metadata・autoManga。テキストは plainText MUST。
 */
import {
  DEFAULT_PANEL_FRAME,
  PANEL_BLEED_OVERSHOOT,
  type PageLayout,
  type PageLayoutAutoManga,
  type PanelFrame,
  type PanelShape
} from "./pageLayout";
import type { BalloonObject, TextObject } from "./pageObjects";

export const GURUGURU_LAYOUT_SCHEMA_VERSION = "0.3.0";
const EXPORT_PAGE_ID = "page_1";

function shapeToSpec(shape: PanelShape): Record<string, unknown> {
  if (shape.type === "polygon") return { type: "polygon", points: shape.points.map(([x, y]) => [x, y]) };
  if (shape.type === "rect") {
    return {
      type: "rect",
      bounds: [...shape.bounds],
      ...(shape.cornerRadius !== undefined ? { cornerRadius: shape.cornerRadius } : {})
    };
  }
  if (shape.type === "ellipse") return { type: "ellipse", center: [...shape.center], radius: [...shape.radius] };
  return {
    type: "path",
    d: shape.d,
    ...(shape.bezier
      ? {
          bezier: {
            closed: true,
            nodes: shape.bezier.nodes.map((node) => ({
              point: [...node.point],
              in: [...node.in],
              out: [...node.out]
            }))
          }
        }
      : {})
  };
}

function frameDiff(frame: PanelFrame | undefined): Record<string, unknown> | null {
  if (!frame) return null;
  const diff: Record<string, unknown> = {};
  if (frame.visible !== DEFAULT_PANEL_FRAME.visible) diff.visible = frame.visible;
  if (frame.style !== DEFAULT_PANEL_FRAME.style) diff.style = frame.style;
  if (frame.strokeWidth !== DEFAULT_PANEL_FRAME.strokeWidth) diff.strokeWidth = frame.strokeWidth;
  if (frame.strokeColor !== DEFAULT_PANEL_FRAME.strokeColor) diff.strokeColor = frame.strokeColor;
  return Object.keys(diff).length > 0 ? diff : null;
}

export interface GuruguruLayoutExportOptions {
  title?: string;
  /** 自動コマ割り候補メタデータ(extensions['com.guruguru'].autoManga)。null/省略で出力しない。 */
  autoManga?: PageLayoutAutoManga | null;
}

/** PageLayout → SPEC v0.3 ルート構造(単ページ)。 */
export function guruguruLayoutFromPageLayout(
  layout: PageLayout,
  options: GuruguruLayoutExportOptions = {}
): Record<string, unknown> {
  const title = options.title?.trim() || layout.source?.title?.trim() || "GURUGURU layout";
  const root: Record<string, unknown> = {
    schemaVersion: GURUGURU_LAYOUT_SCHEMA_VERSION,
    metadata: { title, generator: "guruguru" },
    coordinateSystem: {
      preset: "width-relative-top-left",
      origin: "top-left",
      xAxis: "right",
      yAxis: "down",
      unit: "page-width",
      xRange: [0, 1],
      yRange: [0, "page.height"],
      lengthReference: "page-width"
    },
    document: {
      mode: "single-page",
      readingDirection: layout.readingDirection,
      pageProgression: layout.readingDirection
    },
    pages: [
      {
        id: EXPORT_PAGE_ID,
        role: "single",
        aspectRatio: [...layout.page.aspectRatio],
        bounds: [0, 0, 1, layout.page.height],
        height: layout.page.height
      }
    ],
    validation: { bleedOvershoot: PANEL_BLEED_OVERSHOOT },
    panels: [...layout.panels]
      .sort((a, b) => a.order - b.order)
      .map((panel) => ({
        id: panel.id,
        pageId: EXPORT_PAGE_ID,
        order: panel.order,
        shape: shapeToSpec(panel.shape),
        ...(frameDiff(panel.frame) ? { frame: frameDiff(panel.frame) } : {}),
        ...(panel.role ? { role: panel.role } : {})
      }))
  };
  if (options.autoManga) {
    root.extensions = { "com.guruguru": { autoManga: sanitizeAutoManga(options.autoManga) } };
  }
  return root;
}

function sanitizeAutoManga(autoManga: PageLayoutAutoManga): Record<string, unknown> {
  return {
    candidate: autoManga.candidate,
    ...(autoManga.description ? { description: autoManga.description } : {}),
    ...(autoManga.emphasisPanelIds?.length ? { emphasisPanelIds: [...autoManga.emphasisPanelIds] } : {})
  };
}

// --- ページ書き出し(現在のコマ枠+吹き出し+テキスト、SPEC §14/§17/§20) ---

/** ページ上の吹き出し1つ分のエクスポート入力(サーバが DB の placement 情報を添えて渡す)。 */
export interface ExportPageBalloon {
  object: BalloonObject;
  /** dialogue_placements 由来の所属コマ(無ければ page スコープ)。 */
  panelId?: string | null;
  /** 読み順(order_index)。省略時は配列順。 */
  orderIndex?: number;
  /** 話者(characters.id)。SPEC の characterId に写す。 */
  characterId?: string | null;
}

/** BalloonShape(アプリ内)→ SPEC balloon.kind の写像(未決#7: 初期実装は plainText 優先の最小)。 */
function balloonKind(object: BalloonObject): string {
  if (object.shape === "thought" || object.shape === "cloud") return "thought";
  if (object.shape === "jagged" || object.shape === "spike") return "shout";
  if (object.shape === "caption") return "narration";
  return "speech";
}

function textWritingMode(direction: string): string {
  return direction === "vertical" ? "vertical-rl" : "horizontal-tb";
}

/**
 * ページの現在の状態(レイアウト+吹き出し+テキスト)を SPEC v0.3 ルート構造にする。
 * 吹き出し形状は外接矩形(rect bounds)へ落とす(尻尾の path 化・compound 形状の再現は
 * 初期実装では行わない — SPEC 上 `content` は MAY、`plainText` のみ MUST)。
 */
export function guruguruLayoutFromPage(
  layout: PageLayout,
  balloons: readonly ExportPageBalloon[],
  texts: readonly TextObject[],
  options: GuruguruLayoutExportOptions = {}
): Record<string, unknown> {
  const root = guruguruLayoutFromPageLayout(layout, options);
  const orderedBalloons = [...balloons].sort(
    (a, b) => (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER)
  );
  const specBalloons: Array<Record<string, unknown>> = [];
  const specTexts: Array<Record<string, unknown>> = [];
  orderedBalloons.forEach((entry, index) => {
    const object = entry.object;
    const text = object.content?.text ?? "";
    const textId = `txt_${String(index + 1).padStart(3, "0")}`;
    specBalloons.push({
      id: object.id,
      scope: entry.panelId ? { type: "panel", id: entry.panelId } : { type: "page" },
      order: index + 1,
      globalOrder: index + 1,
      kind: balloonKind(object),
      shape: {
        type: "rect",
        bounds: [
          object.position.x - object.size.x / 2,
          object.position.y - object.size.y / 2,
          object.position.x + object.size.x / 2,
          object.position.y + object.size.y / 2
        ]
      },
      ...(entry.characterId ? { speaker: { type: "character", characterId: entry.characterId } } : {}),
      textId
    });
    specTexts.push({
      id: textId,
      role: balloonKind(object) === "narration" ? "narration" : "dialogue",
      language: "ja",
      writingMode: textWritingMode(object.content?.style.direction ?? "vertical"),
      box: [
        object.position.x - object.size.x / 2,
        object.position.y - object.size.y / 2,
        object.position.x + object.size.x / 2,
        object.position.y + object.size.y / 2
      ],
      plainText: text
    });
  });
  texts.forEach((object, index) => {
    specTexts.push({
      id: `txt_free_${String(index + 1).padStart(3, "0")}`,
      role: "note",
      language: "ja",
      writingMode: textWritingMode(object.content.style.direction),
      box: [object.position.x, object.position.y, object.position.x, object.position.y],
      plainText: object.content.text
    });
  });
  if (specBalloons.length > 0) root.balloons = specBalloons;
  if (specTexts.length > 0) root.texts = specTexts;
  if (specBalloons.length > 0 || specTexts.length > 0) {
    root.readingOrder = {
      panels: [...layout.panels].sort((a, b) => a.order - b.order).map((panel) => panel.id),
      balloons: specBalloons.map((balloon) => balloon.id),
      texts: specTexts.map((text) => text.id)
    };
  }
  return root;
}
