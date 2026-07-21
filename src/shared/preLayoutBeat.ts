/**
 * コマ割り前ビート層(ネームv4 D2)の決定的な原子分割。
 *
 * Fountain 要素を「atomic unit」へ分割する:
 * - dialogue 要素 = 1 unit(分割しない。呼吸単位分割は既存 N1.5 adapt の領分)。
 * - action/synopsis 要素 = 文単位 span に分割し、複数文なら unit を分ける。
 *   これにより「箱を開ける。中には写真がある。」を別コマへ割れる(G3 の解消)。
 *
 * unit id は `scene-{s}-element-{e}`(要素全体)または `scene-{s}-element-{e}:s{k}`(span)。
 * dialogueOrderIndex の採番は `planScriptManga` と完全に同一(section/transition を飛ばし、
 * 可視テキストが空の要素を飛ばす)で、既存の「全台詞一度ずつ」契約の基盤になる。
 */
import type { FountainDoc, FountainElement } from "./fountain";
import {
  MANGA_VISUAL_SCALES,
  type MangaPageTurnHook,
  type MangaVisualScale,
  normalizeLegacyVisualScale
} from "./mangaPlanV2";
import { elementVisibleText, elementVisualText, sourceElementId } from "./scriptMangaPlan";

export interface PreLayoutUnit {
  id: string;
  sceneIndex: number;
  sceneHeading: string;
  elementIndex: number;
  /** `scene-{s}-element-{e}`(ScriptMangaPanelPlan.sourceElementIds と同じ形)。 */
  elementId: string;
  /** null = 要素全体。数値 = sentenceSpans の span index(同一要素内で昇順)。 */
  spanIndex: number | null;
  type: "dialogue" | "action" | "synopsis";
  speaker?: string;
  /** 台詞は「話者: 本文」、action/synopsis は span 本文(trim 済み)。 */
  text: string;
  /** 画像プロンプト用の視覚化テキスト(planScriptManga と同一変換)。 */
  visualText: string;
  /** 台詞本文の文字数(非台詞は 0)。コマ容量のローカル計算に使う。 */
  dialogueCharacters: number;
  /** 台詞 unit のみ。planScriptManga と同一採番のグローバル発話順。 */
  dialogueOrderIndex?: number;
}

const TERMINATORS = new Set(["。", "．", "!", "！", "?", "？", "…"]);
const CLOSERS = new Set(["」", "』", ")", ")", "]", "〕", "》", "】", '"', "'", "’", "”"]);

/**
 * 文単位 span([start, end) の列)。全文字をちょうど一度ずつカバーし、span を連結すると
 * 原文と一致する(往復不変)。終端記号(。！?等)の連なり・閉じ括弧・直後の空白は前の文へ
 * 付ける。ASCII ピリオドは省略記号・小数と紛れるため終端として扱わない(英文は !?で切る)。
 */
export function sentenceSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\n") {
      spans.push([start, index + 1]);
      start = index + 1;
      index += 1;
      continue;
    }
    if (TERMINATORS.has(char)) {
      let end = index + 1;
      while (end < text.length && (TERMINATORS.has(text[end]!) || CLOSERS.has(text[end]!))) end += 1;
      while (end < text.length && (text[end] === " " || text[end] === "\t" || text[end] === "　")) end += 1;
      spans.push([start, end]);
      start = end;
      index = end;
      continue;
    }
    index += 1;
  }
  if (start < text.length) spans.push([start, text.length]);
  return spans;
}

/** Fountain 文書を atomic unit 列へ決定的に分割する。 */
export function buildPreLayoutUnits(doc: FountainDoc): PreLayoutUnit[] {
  const units: PreLayoutUnit[] = [];
  let dialogueOrder = 0;
  doc.scenes.forEach((scene, sceneIndex) => {
    for (const [elementIndex, element] of scene.elements.entries()) {
      if (element.type === "section" || element.type === "transition") continue;
      const visible = elementVisibleText(element);
      if (!visible) continue;
      const baseId = sourceElementId(sceneIndex, elementIndex);
      if (element.type === "dialogue") {
        units.push({
          id: baseId,
          sceneIndex,
          sceneHeading: scene.heading,
          elementIndex,
          elementId: baseId,
          spanIndex: null,
          type: "dialogue",
          speaker: element.speaker,
          text: visible,
          visualText: elementVisualText(element),
          dialogueCharacters: element.text.length,
          dialogueOrderIndex: dialogueOrder
        });
        dialogueOrder += 1;
        continue;
      }
      // action / synopsis: 文単位 span。非空 span が 1 つ以下なら要素全体を 1 unit にする。
      const spans = sentenceSpans(element.text)
        .map(([spanStart, spanEnd], spanIndex) => ({ spanIndex, text: element.text.slice(spanStart, spanEnd) }))
        .filter((span) => span.text.trim().length > 0);
      if (spans.length <= 1) {
        units.push({
          id: baseId,
          sceneIndex,
          sceneHeading: scene.heading,
          elementIndex,
          elementId: baseId,
          spanIndex: null,
          type: element.type,
          text: visible,
          visualText: elementVisualText(element),
          dialogueCharacters: 0
        });
        continue;
      }
      for (const span of spans) {
        const text = span.text.trim();
        units.push({
          id: `${baseId}:s${span.spanIndex}`,
          sceneIndex,
          sceneHeading: scene.heading,
          elementIndex,
          elementId: baseId,
          spanIndex: span.spanIndex,
          type: element.type,
          text,
          visualText: text,
          dialogueCharacters: 0
        });
      }
    }
  });
  return units;
}

// --- ビート注釈(LLM ステージの入出力契約。検証は決定的) ---

export const BEAT_KINDS = ["setup", "action", "reaction", "reveal", "decision", "transition", "pause"] as const;
export type BeatKind = (typeof BEAT_KINDS)[number];
export const BEAT_SCALES = ["small", "normal", "hero", "splash"] as const;
export type BeatScale = (typeof BEAT_SCALES)[number];

export interface AnnotatedBeat {
  id: string;
  /** 連続 unit の束(全 unit を一度ずつ・順序保存・シーン境界を跨がない)。 */
  unitIds: string[];
  kind: BeatKind;
  /**
   * 演出上の希望スケール(ネームスタジオV5 D1)。LLMが判断するのはこのカテゴリだけで、
   * コマ側の解決値は derivePanelVisualScale が決める。
   */
  preferredScale: MangaVisualScale;
  /** 0..1。物語上の重要度。V5では preferredScale からの決定的導出値(旧consumers互換)。 */
  importance: number;
  /** 0..1。めくり直前(引き)・直後(開示)に置きたい度。 */
  pageTurnAffinity: number;
  /** 単独コマ推奨。 */
  keepAlone: boolean;
  /** @deprecated 旧語彙のミラー(P1c で削除予定)。正は preferredScale。 */
  desiredScale: BeatScale;
}

/** preferredScale → 旧 importance 数値(0..1)の決定的導出(旧consumers互換用)。 */
export function importanceWeightForScale(scale: MangaVisualScale): number {
  return scale === "splash" ? 0.95 : scale === "large" ? 0.85 : scale === "small" ? 0.35 : 0.5;
}

/** preferredScale → 旧 desiredScale ミラー。 */
function legacyDesiredScale(scale: MangaVisualScale): BeatScale {
  return scale === "splash" ? "splash" : scale === "large" ? "hero" : scale === "small" ? "small" : "normal";
}

function clamp01(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

/**
 * LLM のビート注釈出力を決定的に検証する。全 unit を一度ずつ・順序保存・シーン純度・enum。
 * 失敗は null(呼び出し側が再試行またはフォールバック)。
 */
export function validateBeatAnnotation(raw: unknown, units: readonly PreLayoutUnit[]): AnnotatedBeat[] | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { beats?: unknown }).beats)) return null;
  const rawBeats = (raw as { beats: unknown[] }).beats;
  if (rawBeats.length === 0 || rawBeats.length > units.length) return null;
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const expectedOrder = units.map((unit) => unit.id);
  const observed: string[] = [];
  const beats: AnnotatedBeat[] = [];
  const seenIds = new Set<string>();
  for (const rawBeat of rawBeats) {
    if (!rawBeat || typeof rawBeat !== "object") return null;
    const beat = rawBeat as Record<string, unknown>;
    const id = typeof beat.id === "string" ? beat.id.trim() : "";
    if (!id || seenIds.has(id)) return null;
    if (!Array.isArray(beat.unitIds) || beat.unitIds.length === 0) return null;
    const unitIds = beat.unitIds.map((value) => (typeof value === "string" ? value : ""));
    const members = unitIds.map((unitId) => unitById.get(unitId));
    if (members.some((member) => !member)) return null;
    if (new Set(members.map((member) => member!.sceneIndex)).size !== 1) return null;
    if (typeof beat.kind !== "string" || !(BEAT_KINDS as readonly string[]).includes(beat.kind)) return null;
    const pageTurnAffinity = clamp01(beat.pageTurnAffinity);
    if (pageTurnAffinity === null) return null;
    if (typeof beat.keepAlone !== "boolean") return null;
    // V5 D1: 正は preferredScale。旧語彙(desiredScale)だけの入力も adapter で受理し、
    // どちらも無い/不正なら reject。importance 数値は与えられなければ決定的に導出する。
    if (beat.preferredScale !== undefined
      && (typeof beat.preferredScale !== "string" || !(MANGA_VISUAL_SCALES as readonly string[]).includes(beat.preferredScale))) return null;
    if (beat.desiredScale !== undefined
      && (typeof beat.desiredScale !== "string" || !(BEAT_SCALES as readonly string[]).includes(beat.desiredScale))) return null;
    const preferredScale = normalizeLegacyVisualScale({ desiredScale: beat.desiredScale, visualScale: beat.preferredScale });
    if (!preferredScale) return null;
    const importance = clamp01(beat.importance) ?? importanceWeightForScale(preferredScale);
    seenIds.add(id);
    observed.push(...unitIds);
    beats.push({
      id,
      unitIds,
      kind: beat.kind as BeatKind,
      preferredScale,
      importance,
      pageTurnAffinity,
      keepAlone: beat.keepAlone,
      desiredScale: legacyDesiredScale(preferredScale)
    });
  }
  if (observed.length !== expectedOrder.length) return null;
  if (observed.some((unitId, index) => unitId !== expectedOrder[index])) return null;
  return beats;
}

/**
 * 決定的フォールバック注釈: 1 要素 = 1 ビート(kind=action)。span unit は元要素単位へ束ね直す
 * (シーン純度・順序保存は構成上満たされる)。
 */
export function fallbackBeatAnnotation(units: readonly PreLayoutUnit[]): AnnotatedBeat[] {
  const groups: Array<{ elementId: string; unitIds: string[] }> = [];
  for (const unit of units) {
    const last = groups[groups.length - 1];
    if (last && last.elementId === unit.elementId) last.unitIds.push(unit.id);
    else groups.push({ elementId: unit.elementId, unitIds: [unit.id] });
  }
  return groups.map((group, index) => ({
    id: `beat-${index + 1}`,
    unitIds: group.unitIds,
    kind: "action" as const,
    preferredScale: "medium" as const,
    importance: 0.5,
    pageTurnAffinity: 0,
    keepAlone: false,
    desiredScale: "normal" as const
  }));
}

// --- コマスケールの決定的解決(ネームスタジオV5 D1) ---

const VISUAL_SCALE_RANK: Record<MangaVisualScale, number> = { small: 0, medium: 1, large: 2, splash: 3 };

/**
 * コマへ束ねたビート列から、コマの解決スケール(visualScale)を決定的に導出する。
 * 基本は含有ビートの preferredScale の最大値。空ビート(想定外)は medium。
 * pageContext はソフト規則(turnHook=reveal の最終コマ引き上げ等、未決#3)用の予約で、
 * 初期実装では未使用。
 */
export function derivePanelVisualScale(
  beats: readonly AnnotatedBeat[],
  _pageContext: { turnHook?: MangaPageTurnHook; panelIndex: number; panelCount: number }
): MangaVisualScale {
  let best: MangaVisualScale = "medium";
  let bestRank = -1;
  for (const beat of beats) {
    const rank = VISUAL_SCALE_RANK[beat.preferredScale];
    if (rank > bestRank) {
      bestRank = rank;
      best = beat.preferredScale;
    }
  }
  return best;
}
