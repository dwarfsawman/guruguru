/**
 * Chronicle Page Flow(S5、Docs/Done/Feature-ChroniclePageFlow.md §3・§4 フェーズIII)。
 * 吹き出し一括配置の preview/apply。サイズ計算(`computeTextLayoutForContent` の結線)・
 * トランザクション(`pages.ts` の `reorderPages` が手本)はここが担当し、候補探索・スコアリング
 * 自体は `../shared/dialogueAutoLayout.ts`(純ロジック)に委ねる。
 */
import { randomInt } from "node:crypto";
import type { DialogueLayoutPreview, DialogueLayoutUnlockResult } from "../shared/chronicle";
import type { DialogueBalloonStyle, DialogueSemanticKind } from "../shared/apiTypes";
import { balloonInscribedFactor } from "../shared/balloonShape";
import {
  runDialogueAutoLayout,
  AUTO_LAYOUT_SFX_FONT_SCALE,
  type DialogueAutoLayoutItem,
  type DialogueAutoLayoutResult,
  type DialogueAvoidZone
} from "../shared/dialogueAutoLayout";
import { normalizeEditedPageLayout, type PageLayout } from "../shared/pageLayout";
import {
  CONTENT_PADDING_RATIO,
  DEFAULT_TEXT_STYLE,
  PAGE_OBJECTS_MAX_COUNT,
  PAGE_OBJECT_MIN_SIZE,
  normalizePageObjects,
  type PageObject,
  type PageVec,
  type TextContent
} from "../shared/pageObjects";
import { computeTextLayoutForContent } from "./textLayoutApi";
import { getRow, getRows, runSql } from "./db";
import { HttpError } from "./http";
import { objectBody } from "./validate";

function requireProject(projectId: string) {
  const project = getRow("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
}

interface PageRow {
  id: string;
  project_id: string;
  layout_json: string | null;
  objects_json: string | null;
}

function requirePageRow(projectId: string, pageId: string): PageRow {
  const page = getRow<PageRow>("SELECT id, project_id, layout_json, objects_json FROM pages WHERE id = ? AND project_id = ?", [
    pageId,
    projectId
  ]);
  if (!page) {
    throw new HttpError(404, "Page was not found in this project");
  }
  return page;
}

function parsePlacementIds(input: Record<string, unknown>): string[] {
  if (!Array.isArray(input.placementIds) || input.placementIds.length === 0 || input.placementIds.some((id) => typeof id !== "string")) {
    throw new HttpError(400, "placementIds must be a non-empty array of strings");
  }
  return Array.from(new Set(input.placementIds as string[]));
}

interface PlacementRow {
  id: string;
  line_id: string;
  page_id: string;
  panel_id: string | null;
  balloon_object_id: string | null;
  text_override: string | null;
  semantic_kind_override: DialogueSemanticKind | null;
  speaker_label_override: string | null;
  order_index_override: number | null;
}

interface LineRow {
  id: string;
  text: string;
  semantic_kind: DialogueSemanticKind;
  balloon_style: DialogueBalloonStyle;
  speaker_label: string;
  order_index: number;
}

interface LoadedContext {
  page: PageRow;
  layout: PageLayout;
  existingObjects: PageObject[];
  placements: PlacementRow[];
  items: DialogueAutoLayoutItem[];
}

/**
 * apply/reflow 共通の規約: fontScale を明示指定した呼び出し(自動漫画)は吹き出し内フォントを
 * 保持する前提でサイズ候補を逆算する。未指定(手動UI)は従来どおり既定サイズ(fontScale=1)。
 */
function parseItemFontOptions(input: Record<string, unknown>): { fontScale: number; preserveBalloonFontSize: boolean } {
  const preserveBalloonFontSize = typeof input.fontScale === "number" && Number.isFinite(input.fontScale);
  const fontScale = preserveBalloonFontSize ? Math.min(1, Math.max(0.35, input.fontScale as number)) : 1;
  return { fontScale, preserveBalloonFontSize };
}

/** placement 行のうちソルバー入力の組み立てに使う共通カラム(apply の PlacementRow / reflow 対象行で共通)。 */
interface PlacementLikeRow {
  id: string;
  line_id: string;
  text_override: string | null;
  semantic_kind_override: DialogueSemanticKind | null;
  speaker_label_override: string | null;
  order_index_override: number | null;
}

/**
 * placement/reflow 対象行から `DialogueAutoLayoutItem` 群を組む(dialogue_lines の一括取得+override 解決)。
 * `extras` は apply 側だけが持つ preferredPanelId / preferredCenter の付与に使う。
 */
function buildAutoLayoutItems<Row extends PlacementLikeRow>(
  rows: Row[],
  fontScale: number,
  preserveBalloonFontSize: boolean,
  extras?: (row: Row) => Partial<DialogueAutoLayoutItem>
): DialogueAutoLayoutItem[] {
  const lineIds = rows.map((row) => row.line_id);
  const linePlaceholders = lineIds.map(() => "?").join(",");
  const lineRows = getRows<LineRow>(
    `SELECT id, text, semantic_kind, balloon_style, speaker_label, order_index FROM dialogue_lines WHERE id IN (${linePlaceholders})`,
    lineIds
  );
  const lineById = new Map(lineRows.map((row) => [row.id, row]));

  return rows.map((row) => {
    const line = lineById.get(row.line_id);
    if (!line) {
      throw new HttpError(404, `Dialogue line was not found for placement ${row.id}`);
    }
    const text = row.text_override ?? line.text;
    const semanticKind = row.semantic_kind_override ?? line.semantic_kind;
    return {
      placementId: row.id,
      lineId: line.id,
      text,
      semanticKind,
      balloonStyle: line.balloon_style,
      speakerLabel: row.speaker_label_override ?? line.speaker_label,
      orderIndex: row.order_index_override ?? line.order_index,
      ...(extras ? extras(row) : {}),
      fontScale,
      sizeVariants: requiredSizeVariantsFor(text, semanticKind, fontScale, preserveBalloonFontSize)
    };
  });
}

/**
 * apply/reflow 共通のトランザクション確定処理: objects 上限検査 → pages.objects_json 更新 →
 * 各 placement の balloon_object_id/panel_id/auto_layout_seed/auto_layout_version 更新。
 * SAVEPOINT で全件成功か全件無効か(部分書き込みを残さない)。
 */
function commitLayoutResult(args: {
  savepoint: string;
  projectId: string;
  pageId: string;
  /** ソルバー実行時に障害物とした既存オブジェクト(この後ろへ新規分を追記する)。 */
  baseObjects: PageObject[];
  result: Pick<DialogueAutoLayoutResult, "objects" | "assignments">;
  seed: number;
  overLimitMessage: string;
}): void {
  const { savepoint, projectId, pageId, baseObjects, result, seed, overLimitMessage } = args;
  runSql(`SAVEPOINT ${savepoint}`);
  try {
    const nextObjects = normalizePageObjects([...baseObjects, ...result.objects]);
    if (nextObjects.length > PAGE_OBJECTS_MAX_COUNT || nextObjects.length !== baseObjects.length + result.objects.length) {
      throw new HttpError(422, overLimitMessage);
    }
    runSql("UPDATE pages SET objects_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?", [
      JSON.stringify(nextObjects),
      pageId,
      projectId
    ]);
    for (const assignment of result.assignments) {
      runSql(
        `UPDATE dialogue_placements
         SET balloon_object_id = ?, panel_id = ?, auto_layout_seed = ?, auto_layout_version = 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [assignment.objectId, assignment.panelId, seed, assignment.placementId]
      );
    }
    runSql(`RELEASE ${savepoint}`);
  } catch (error) {
    runSql(`ROLLBACK TO ${savepoint}`);
    runSql(`RELEASE ${savepoint}`);
    throw error;
  }
}

/**
 * placementIds の実在・当該ページ所属・未吹き出し化(balloon_object_id=NULL)を検証し、ソルバー入力を組む。
 * サイズ計算(§2.5): 各行の既定バルーンスタイルで `computeTextLayoutForContent` を呼び、
 * `CONTENT_PADDING_RATIO` の逆数でパディング込みの必要サイズへ換算する。
 */
function loadContext(projectId: string, pageId: string, body: unknown): LoadedContext {
  requireProject(projectId);
  const page = requirePageRow(projectId, pageId);
  if (!page.layout_json) {
    throw new HttpError(400, "このページにはコマ割りが無いため、吹き出し一括配置は使えません。");
  }
  const layout = normalizeEditedPageLayout(JSON.parse(page.layout_json));
  if (!layout) {
    throw new HttpError(400, "このページのレイアウトが不正です。");
  }

  const input = objectBody(body);
  const { fontScale, preserveBalloonFontSize } = parseItemFontOptions(input);
  const preferredCenters = parsePreferredCenters(input);
  const placementIds = parsePlacementIds(input);
  const placeholders = placementIds.map(() => "?").join(",");
  const placements = getRows<PlacementRow>(
    `SELECT id, line_id, page_id, panel_id, balloon_object_id, text_override, semantic_kind_override,
            speaker_label_override, order_index_override
     FROM dialogue_placements WHERE id IN (${placeholders})`,
    placementIds
  );
  const foundIds = new Set(placements.map((row) => row.id));
  const missing = placementIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new HttpError(404, `Dialogue placement(s) were not found: ${missing.join(", ")}`);
  }
  const notOnPage = placements.filter((row) => row.page_id !== pageId);
  if (notOnPage.length > 0) {
    throw new HttpError(400, `次の placement は当該ページに属していません: ${notOnPage.map((row) => row.id).join(", ")}`);
  }
  const alreadyMaterialized = placements.filter((row) => row.balloon_object_id);
  if (alreadyMaterialized.length > 0) {
    throw new HttpError(
      409,
      `次の placement は既に吹き出し化済みのため配置対象にできません: ${alreadyMaterialized.map((row) => row.id).join(", ")}`
    );
  }

  const existingObjects = normalizePageObjects(page.objects_json ? JSON.parse(page.objects_json) : []);

  const items = buildAutoLayoutItems(placements, fontScale, preserveBalloonFontSize, (placement) => ({
    preferredPanelId: placement.panel_id,
    preferredCenter: preferredCenters?.[placement.line_id] ?? null
  }));

  return { page, layout, existingObjects, placements, items };
}

/**
 * 人間ゲートの吹き出し中心ヒント(lineId → page 座標)。自動漫画の materialize が計算済みの値を
 * 渡す前提のため、フォーマット崩れは 400。未指定なら null(従来と同一挙動)。
 */
function parsePreferredCenters(input: Record<string, unknown>): Record<string, { x: number; y: number }> | null {
  if (input.preferredCentersByLineId === undefined) return null;
  const raw = input.preferredCentersByLineId;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "preferredCentersByLineId must be an object of lineId → {x, y}");
  }
  const centers: Record<string, { x: number; y: number }> = {};
  for (const [lineId, position] of Object.entries(raw as Record<string, unknown>)) {
    const { x, y } = (position ?? {}) as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
      throw new HttpError(400, `preferredCentersByLineId[${lineId}] must be a finite {x, y}`);
    }
    centers[lineId] = { x, y };
  }
  return Object.keys(centers).length > 0 ? centers : null;
}

/** dialogue の既定バルーンサイズ下限(page 単位)。短文でも読める最低限のサイズを保証する。 */
const MIN_BALLOON_WIDTH = 0.07;
const MIN_BALLOON_HEIGHT = 0.06;

/**
 * 折返し無し(`maxWidth=undefined`)で `computeTextLayoutForContent` を呼ぶと、縦書きは「1列がどこまでも
 * 伸びる」形になり吹き出しとして非現実的な bbox になる(既知の落とし穴)。文字数の平方根に比例した
 * 列高さ目安を計算し、`cap`(列高さの上限)で頭打ちにしてから折り返させる。
 */
function estimateWrapWidth(text: string, style: TextContent["style"], cap: number): number {
  const length = Math.max(1, text.length);
  const target = Math.sqrt(length) * style.size * (style.lineSpacing ?? 1.6) * 1.15;
  return Math.min(cap, Math.max(style.size * 2.4, target));
}

/**
 * サイズ候補生成に使う列高さの上限(page 単位)。大きい値ほど「1列に収めた縦長(タワー型)」の吹き出し
 * になり、小さい値ほど「列数の多い横長」になる。**縦長優先の順**(大きい cap から)で並べる -- 漫画の
 * 吹き出しは縦長が自然で、四半ページ程度のコマでも収まりやすいため。短文で全 cap が同じ bbox になる
 * 場合は重複候補を除去する(§2.5 のバリアント探索、決定的で PRNG は消費しない)。
 */
const WRAP_HEIGHT_CAPS: readonly number[] = [0.36, 0.28, 0.2];

/**
 * 行のサイズ候補(縦長優先の順)を算出する。ソルバー(`runDialogueAutoLayout`)は先頭から順に
 * 「コマに収まる/空きがある」候補を試し、最初に成功したものを採用する(全滅時のみ unplaced)。
 */
function requiredSizeVariantsFor(
  text: string,
  semanticKind: DialogueSemanticKind,
  fontScale = 1,
  preserveBalloonFontSize = false
): PageVec[] {
  const style =
    semanticKind === "sfx"
      ? { ...DEFAULT_TEXT_STYLE, size: DEFAULT_TEXT_STYLE.size * AUTO_LAYOUT_SFX_FONT_SCALE * fontScale }
      : { ...DEFAULT_TEXT_STYLE, size: DEFAULT_TEXT_STYLE.size * fontScale };
  const content: TextContent = { text: text || " ", style };

  const variants: PageVec[] = [];
  const seenKeys = new Set<string>();
  for (const cap of WRAP_HEIGHT_CAPS) {
    const layout = computeTextLayoutForContent(content, estimateWrapWidth(text, style, cap));
    const rawWidth = Math.max(PAGE_OBJECT_MIN_SIZE, layout.bbox.maxX - layout.bbox.minX);
    const rawHeight = Math.max(PAGE_OBJECT_MIN_SIZE, layout.bbox.maxY - layout.bbox.minY);
    // balloonは外接矩形全体を文字に使えない。実描画/自動フィットと同じ内接係数まで逆算しないと、
    // 配置直後のfitでフォントが約0.7倍へ縮み、設定した本文サイズが維持されない。
    const balloonShape = semanticKind === "monologue" ? "thought" : text.replace(/\s+/g, "").length >= 34 ? "compound" : "ellipse";
    const inscribedFactor = preserveBalloonFontSize && semanticKind !== "sfx" ? balloonInscribedFactor(balloonShape) : 1;
    const width = rawWidth / ((1 - CONTENT_PADDING_RATIO) * inscribedFactor);
    const height = rawHeight / ((1 - CONTENT_PADDING_RATIO) * inscribedFactor);
    const size: PageVec =
      semanticKind === "sfx"
        ? { x: Math.max(PAGE_OBJECT_MIN_SIZE, width), y: Math.max(PAGE_OBJECT_MIN_SIZE, height) }
        : { x: Math.max(MIN_BALLOON_WIDTH, width), y: Math.max(MIN_BALLOON_HEIGHT, height) };
    const key = `${size.x.toFixed(6)}x${size.y.toFixed(6)}`;
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    variants.push(size);
  }
  return variants;
}

/** FNV-1a ベースの簡易ハッシュ。preview で seed 省略時に使う(決定的である必要は無いが、結果は返却必須)。 */
function defaultSeedFor(placementIds: string[]): number {
  const key = [...placementIds].sort().join("|");
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function parseSeed(input: Record<string, unknown>): number | undefined {
  return typeof input.seed === "number" && Number.isFinite(input.seed) ? input.seed : undefined;
}

/**
 * 回避領域(顔・立ち絵)とコマ専有率上限の任意入力(Docs/Reference-MangaCompositions.md)。
 * 未指定なら空を返し、ソルバーは従来と完全に同じ挙動になる。フォーマット崩れは黙って捨てず 400
 * (自動漫画経路が計算済みの値を渡す前提で、崩れは呼び出し側のバグのため)。
 */
function parseSolverConstraints(input: Record<string, unknown>): {
  avoidZones?: DialogueAvoidZone[];
  maxPanelCoverageRatio?: number;
} {
  const result: { avoidZones?: DialogueAvoidZone[]; maxPanelCoverageRatio?: number } = {};
  if (input.avoidZones !== undefined) {
    if (!Array.isArray(input.avoidZones) || input.avoidZones.length > 64) {
      throw new HttpError(400, "avoidZones must be an array of at most 64 rectangles");
    }
    const zones: DialogueAvoidZone[] = [];
    for (const raw of input.avoidZones) {
      const zone = raw as Record<string, unknown> | null;
      const values = [zone?.x, zone?.y, zone?.width, zone?.height];
      if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new HttpError(400, "avoidZones entries must have finite x/y/width/height");
      }
      if ((zone!.width as number) <= 0 || (zone!.height as number) <= 0) continue;
      zones.push({
        x: zone!.x as number,
        y: zone!.y as number,
        width: zone!.width as number,
        height: zone!.height as number,
        label: typeof zone!.label === "string" ? zone!.label : undefined
      });
    }
    if (zones.length > 0) result.avoidZones = zones;
  }
  if (input.maxPanelCoverageRatio !== undefined) {
    if (typeof input.maxPanelCoverageRatio !== "number" || !Number.isFinite(input.maxPanelCoverageRatio)) {
      throw new HttpError(400, "maxPanelCoverageRatio must be a finite number");
    }
    result.maxPanelCoverageRatio = Math.min(1, Math.max(0.05, input.maxPanelCoverageRatio));
  }
  return result;
}

/**
 * `POST /api/projects/:projectId/pages/:pageId/dialogue-layout/preview`(§3)。DB は一切書き換えない。
 */
export function previewDialogueLayout(projectId: string, pageId: string, body: unknown): DialogueLayoutPreview {
  const context = loadContext(projectId, pageId, body);
  const input = objectBody(body);
  const seed = parseSeed(input) ?? defaultSeedFor(context.placements.map((row) => row.id));
  const result = runDialogueAutoLayout({
    layout: context.layout,
    existingObjects: context.existingObjects,
    items: context.items,
    seed,
    ...parseSolverConstraints(input)
  });
  return { seed, ...result };
}

/**
 * `POST /api/projects/:projectId/pages/:pageId/dialogue-layout/apply`(§3)。トランザクション:
 * ソルバー再実行 → 1件でも unplaced なら 422 で全件ロールバック(実際には BEGIN 前に弾くので
 * DB へは何も書かない)→ objects_json 追記 → 各 placement の balloon_object_id/panel_id/
 * auto_layout_seed/auto_layout_version を更新。
 */
export function applyDialogueLayout(projectId: string, pageId: string, body: unknown): DialogueLayoutPreview {
  const input = objectBody(body);
  const seed = parseSeed(input);
  if (seed === undefined) {
    throw new HttpError(400, "seed is required");
  }
  const context = loadContext(projectId, pageId, body);
  const result = runDialogueAutoLayout({
    layout: context.layout,
    existingObjects: context.existingObjects,
    items: context.items,
    seed,
    ...parseSolverConstraints(input)
  });
  if (result.unplacedPlacementIds.length > 0) {
    throw new HttpError(
      422,
      `一部の行を配置できなかったため確定を中止しました(${result.unplacedPlacementIds.length}件)。seed を変えて再試行するか、手動配置してください。`
    );
  }

  commitLayoutResult({
    savepoint: "dialogue_layout_apply",
    projectId,
    pageId,
    baseObjects: context.existingObjects,
    result,
    seed,
    overLimitMessage: `ページオブジェクトの上限(${PAGE_OBJECTS_MAX_COUNT})を超えるため確定できません。`
  });

  return { seed, objects: result.objects, assignments: result.assignments, warnings: result.warnings, unplacedPlacementIds: [] };
}

// --- フェーズIV(§2.6・§3・§6): 再配置(reflow)とロック解除 ---

interface ReflowTargetRow {
  id: string;
  line_id: string;
  balloon_object_id: string;
  text_override: string | null;
  semantic_kind_override: DialogueSemanticKind | null;
  speaker_label_override: string | null;
  order_index_override: number | null;
}

interface ReflowContext {
  layout: PageLayout;
  /** ロック済み balloon・その他の既存オブジェクト(再配置対象を除いた残り)。再配置ソルバーの障害物になる。 */
  remainingObjects: PageObject[];
  targets: ReflowTargetRow[];
  items: DialogueAutoLayoutItem[];
}

/**
 * 再配置(reflow)対象を読み込む: 現在ページの「materialized(balloon_object_id 有り)かつ
 * auto_layout_locked=0」の placement 群(§6 フェーズIV)。対象の PageObject を objects_json から
 * 除去した残りを障害物として返す(除去した分はソルバーが新しい位置・サイズで作り直す)。
 */
function loadReflowContext(projectId: string, pageId: string, body: unknown): ReflowContext {
  requireProject(projectId);
  const page = requirePageRow(projectId, pageId);
  if (!page.layout_json) {
    throw new HttpError(400, "このページにはコマ割りが無いため、再配置は使えません。");
  }
  const input = objectBody(body);
  const { fontScale, preserveBalloonFontSize } = parseItemFontOptions(input);
  const layout = normalizeEditedPageLayout(JSON.parse(page.layout_json));
  if (!layout) {
    throw new HttpError(400, "このページのレイアウトが不正です。");
  }

  const targets = getRows<ReflowTargetRow>(
    `SELECT id, line_id, balloon_object_id, text_override, semantic_kind_override,
            speaker_label_override, order_index_override FROM dialogue_placements
     WHERE page_id = ? AND balloon_object_id IS NOT NULL AND auto_layout_locked = 0`,
    [pageId]
  );
  const allObjects = normalizePageObjects(page.objects_json ? JSON.parse(page.objects_json) : []);
  if (targets.length === 0) {
    return { layout, remainingObjects: allObjects, targets: [], items: [] };
  }
  const targetObjectIds = new Set(targets.map((row) => row.balloon_object_id));
  const remainingObjects = allObjects.filter((object) => !targetObjectIds.has(object.id));

  const items = buildAutoLayoutItems(targets, fontScale, preserveBalloonFontSize);

  return { layout, remainingObjects, targets, items };
}

/**
 * `POST /api/projects/:projectId/pages/:pageId/dialogue-layout/reflow`(§6 フェーズIV)。
 * seed 省略時はサーバーが新規生成する(`node:crypto` の `randomInt` -- ソルバー自体の PRNG 制約
 * 「Math.random 不使用」とは別の関心事: これは「毎回違う seed を選ぶ」ためだけの1回きりの乱数)。
 * トランザクション: 対象 placement の既存 PageObject を除去 → ロック済み/その他を障害物として
 * ソルバー再実行(テキスト・placement は維持、位置とサイズのみ変更)→ 新 PageObject 書き込み →
 * balloon_object_id/panel_id/auto_layout_seed 更新。1件でも配置不能なら 422(BEGIN 前に判定するため
 * 実際には何も書き込まれず、既存配置は無傷のまま)。対象が0件(全ロック済み/未配置)なら何もせず返す。
 */
export function reflowDialogueLayout(projectId: string, pageId: string, body: unknown): DialogueLayoutPreview {
  const input = objectBody(body);
  const context = loadReflowContext(projectId, pageId, body);
  if (context.items.length === 0) {
    return {
      seed: parseSeed(input) ?? 0,
      objects: [],
      assignments: [],
      warnings: ["再配置の対象(ロックされていない吹き出し)がありません。"],
      unplacedPlacementIds: []
    };
  }

  const seed = parseSeed(input) ?? randomInt(0, 0xffffffff);
  const result = runDialogueAutoLayout({
    layout: context.layout,
    existingObjects: context.remainingObjects,
    items: context.items,
    seed,
    ...parseSolverConstraints(input)
  });
  if (result.unplacedPlacementIds.length > 0) {
    throw new HttpError(
      422,
      `一部の行を再配置できなかったため中止しました(${result.unplacedPlacementIds.length}件)。seed を変えて再試行するか、手動配置してください。`
    );
  }

  commitLayoutResult({
    savepoint: "dialogue_layout_reflow",
    projectId,
    pageId,
    baseObjects: context.remainingObjects,
    result,
    seed,
    overLimitMessage: `ページオブジェクトの上限(${PAGE_OBJECTS_MAX_COUNT})を超えるため再配置できません。`
  });

  return { seed, objects: result.objects, assignments: result.assignments, warnings: result.warnings, unplacedPlacementIds: [] };
}

/**
 * `POST /api/projects/:projectId/pages/:pageId/dialogue-layout/unlock`(§6 フェーズIV)。
 * 現在ページの `auto_layout_locked=1` の placement を一括で解除する(個別解除は既存の
 * `PATCH /api/dialogue-placements/:id { autoLayoutLocked: false }` を使う)。
 */
export function unlockAllDialoguePlacementsForPage(projectId: string, pageId: string): DialogueLayoutUnlockResult {
  requireProject(projectId);
  requirePageRow(projectId, pageId);
  const rows = getRows<{ id: string }>("SELECT id FROM dialogue_placements WHERE page_id = ? AND auto_layout_locked = 1", [
    pageId
  ]);
  if (rows.length === 0) {
    return { unlocked: 0 };
  }
  runSql("SAVEPOINT dialogue_layout_unlock");
  try {
    for (const row of rows) {
      runSql("UPDATE dialogue_placements SET auto_layout_locked = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
    }
    runSql("RELEASE dialogue_layout_unlock");
  } catch (error) {
    runSql("ROLLBACK TO dialogue_layout_unlock");
    runSql("RELEASE dialogue_layout_unlock");
    throw error;
  }
  return { unlocked: rows.length };
}
