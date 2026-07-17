import { buildPanelDemand, feasibleLayouts, type PanelDemand } from "../shared/layoutMatcher";
import { scriptMangaLayoutCandidates } from "../shared/layoutPresets";
import type { MangaPageTurnHook, MangaVisualScale } from "../shared/mangaPlanV2";
import { type AnnotatedBeat, derivePanelVisualScale, type PreLayoutUnit } from "../shared/preLayoutBeat";
import {
  DEFAULT_MAX_DIALOGUES_PER_PANEL,
  DEFAULT_SCRIPT_MANGA_STYLE,
  type ScriptMangaPagePlan,
  type ScriptMangaPanelPlan,
  type ScriptMangaPlan
} from "../shared/scriptMangaPlan";

export type TurnHook = MangaPageTurnHook;

/** UI/API と同じ有効範囲へ正規化した、1ページあたりのコマ数上限。 */
function normalizeMaxPanelsPerPage(value: number | undefined): number {
  return Math.max(1, Math.min(6, Math.trunc(value ?? 6)));
}

/** unit列からコマ(ScriptMangaPanelPlan)を組み立てる(ビート化N1とパッカーの共通部)。 */
function panelFromUnits(input: {
  id: string;
  unitsOfPanel: readonly PreLayoutUnit[];
  sourceBeatIds: readonly string[];
  stylePrompt: string;
  visualScale: MangaVisualScale;
}): ScriptMangaPanelPlan {
  const first = input.unitsOfPanel[0]!;
  const sceneContext = first.sceneHeading ? `Scene: ${first.sceneHeading}.` : "";
  const visualParts = input.unitsOfPanel.map((unit) => unit.visualText).filter(Boolean);
  const sourceElementIds: string[] = [];
  for (const unit of input.unitsOfPanel) {
    if (sourceElementIds[sourceElementIds.length - 1] !== unit.elementId) sourceElementIds.push(unit.elementId);
  }
  const dialogueUnits = input.unitsOfPanel.filter((unit) => unit.type === "dialogue");
  return {
    id: input.id,
    sceneIndex: first.sceneIndex,
    sceneHeading: first.sceneHeading,
    sourceElementIds,
    prompt: `${input.stylePrompt}. ${sceneContext} ${visualParts.join(" ")}`.replace(/\s+/g, " ").trim(),
    sourceText: input.unitsOfPanel.map((unit) => unit.text).join("\n"),
    dialogueOrderIndexes: dialogueUnits.map((unit) => unit.dialogueOrderIndex!),
    visualScale: input.visualScale,
    sourceBeatIds: [...input.sourceBeatIds]
  };
}

// --- ビート化 N1(ネームv4 D2): beats を入力に、コマ = ビート束としてページ設計する ---

/** V5 D1: N1はスケールを再出力しない。コマのvisualScaleは含有ビートから決定的に導出する。 */
export interface BeatPageNamingPanel { id: string; sourceBeatIds: string[] }
export interface BeatPageNamingPage { index: number; pageIntent: string; turnHook?: TurnHook; panels: BeatPageNamingPanel[] }
export interface BeatPageNamingResult { pages: BeatPageNamingPage[] }

export interface BeatPageNamingContext {
  title: string;
  units: readonly PreLayoutUnit[];
  beats: readonly AnnotatedBeat[];
  targetPageCount: number;
  stylePrompt?: string;
  /** コマあたりの台詞文字量上限(ローカル計算)。既定 260。 */
  maxDialogueCharactersPerPanel?: number;
  /** コマあたりの台詞要素数上限。既定 3、最大 8。 */
  maxDialoguesPerPanel?: number;
  /** 1ページあたりのコマ数上限。既定 6。 */
  maxPanelsPerPage?: number;
}

/**
 * ビート化 N1 の出力を検証し、beat→unit→element の決定的展開で ScriptMangaPlan を組み立てる。
 * 検証: 全ビート一度ずつ・順序保存・シーン純度・splash 単独・コマ内台詞文字量上限。
 * 展開により既存の「全台詞一度ずつ」契約と ScriptMangaPlan の形は不変に保たれる。
 * 失敗時は null(呼び出し側が再試行 → 従来 N1 → 決定的プランナーへフォールバック)。
 */
export function applyBeatPageNaming(raw: unknown, context: BeatPageNamingContext): ScriptMangaPlan | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as BeatPageNamingResult).pages)) return null;
  const named = raw as BeatPageNamingResult;
  const beatById = new Map(context.beats.map((beat) => [beat.id, beat]));
  const unitById = new Map(context.units.map((unit) => [unit.id, unit]));
  const expectedBeatIds = context.beats.map((beat) => beat.id);
  const observedBeatIds: string[] = [];
  const maxDialogueCharacters = Math.max(40, Math.trunc(context.maxDialogueCharactersPerPanel ?? 260));
  const maxDialogues = Math.max(1, Math.min(8, Math.trunc(context.maxDialoguesPerPanel ?? DEFAULT_MAX_DIALOGUES_PER_PANEL)));
  const panelLimit = normalizeMaxPanelsPerPage(context.maxPanelsPerPage);
  const minPages = Math.max(1, Math.floor(context.targetPageCount * 0.8));
  const maxPages = Math.max(minPages, Math.ceil(context.targetPageCount * 1.2));
  if (named.pages.length < minPages || named.pages.length > maxPages) return null;
  const stylePrompt = context.stylePrompt?.trim() || DEFAULT_SCRIPT_MANGA_STYLE;
  const panelIds = new Set<string>();
  const pages: ScriptMangaPagePlan[] = [];
  let dialogueCount = 0;
  for (let pageIndex = 0; pageIndex < named.pages.length; pageIndex += 1) {
    const page = named.pages[pageIndex];
    if (!page || page.index !== pageIndex || !page.pageIntent?.trim() || !Array.isArray(page.panels) || page.panels.length < 1 || page.panels.length > panelLimit) return null;
    if (page.turnHook !== undefined && !["reveal", "cliffhanger", "none"].includes(page.turnHook)) return null;
    const panels: ScriptMangaPanelPlan[] = [];
    const demands: PanelDemand[] = [];
    for (const namedPanel of page.panels) {
      if (!namedPanel?.id || panelIds.has(namedPanel.id)) return null;
      if (!Array.isArray(namedPanel.sourceBeatIds) || namedPanel.sourceBeatIds.length === 0) return null;
      const beats = namedPanel.sourceBeatIds.map((beatId) => beatById.get(beatId));
      if (beats.some((beat) => !beat)) return null;
      const concreteBeats = beats as AnnotatedBeat[];
      const maybeUnits = concreteBeats.flatMap((beat) => beat.unitIds.map((unitId) => unitById.get(unitId)));
      if (maybeUnits.some((unit) => !unit)) return null;
      const unitsOfPanel = maybeUnits as PreLayoutUnit[];
      // コマはシーンを跨がない(ビート自体もシーン純度検証済みだが、束ねた結果も確認する)。
      if (new Set(unitsOfPanel.map((unit) => unit.sceneIndex)).size !== 1) return null;
      const dialogueUnits = unitsOfPanel.filter((unit) => unit.type === "dialogue");
      const dialogueCharacters = dialogueUnits.reduce((sum, unit) => sum + unit.dialogueCharacters, 0);
      if (dialogueUnits.length > maxDialogues) return null;
      // V5 D2 充足保証: 台詞unitは原子(分割不能)なので、単独台詞のコマは文字量capの適用除外。
      if (dialogueUnits.length > 1 && dialogueCharacters > maxDialogueCharacters) return null;
      // V5 D1 hard規則(ビート由来の決定的検査):
      // keepAlone ビートは他ビートと同居不可 / large以上の希望ビートを1コマへ複数束ねない /
      // splash希望ビートは単独コマ・単独ページ。
      if (concreteBeats.length > 1 && concreteBeats.some((beat) => beat.keepAlone)) return null;
      if (concreteBeats.filter((beat) => beat.preferredScale === "large" || beat.preferredScale === "splash").length > 1) return null;
      if (concreteBeats.some((beat) => beat.preferredScale === "splash") && (concreteBeats.length > 1 || page.panels.length !== 1)) return null;
      observedBeatIds.push(...namedPanel.sourceBeatIds);
      panelIds.add(namedPanel.id);
      dialogueCount += dialogueUnits.length;
      // V5 D1: コマの解決スケールは含有ビートから決定的に導出(N1は再出力しない)。
      const visualScale = derivePanelVisualScale(concreteBeats, {
        turnHook: page.turnHook,
        panelIndex: panels.length,
        panelCount: page.panels.length
      });
      panels.push(panelFromUnits({
        id: namedPanel.id,
        unitsOfPanel,
        sourceBeatIds: namedPanel.sourceBeatIds,
        stylePrompt,
        visualScale
      }));
      demands.push(buildPanelDemand({
        visualScale,
        totalCharacters: dialogueCharacters,
        balloonCount: dialogueUnits.length
      }));
    }
    // V5 D1 hard規則: 1ページの large コマは2つまで(プロンプトの "one or two" を決定的に固定)。
    if (panels.filter((panel) => panel.visualScale === "large").length > 2) return null;
    // V5 D3 実現可能性ゲート: hard constraint を全て満たすレイアウトが1件も無いページ構成は
    // 受理しない(rankerの「違反最小」採用で preflight 落ちする候補を作らないため)。
    const feasible = feasibleLayouts(demands, { previousLayoutId: pages[pages.length - 1]?.layoutTemplateId });
    if (feasible.length === 0) return null;
    const layoutTemplateId = feasible[0]!.layoutId;
    pages.push({
      index: pageIndex,
      title: panels[0]!.sceneHeading || `Page ${pageIndex + 1}`,
      layoutTemplateId,
      pageIntent: page.pageIntent.trim(),
      ...(page.turnHook !== undefined ? { turnHook: page.turnHook } : {}),
      panels
    });
  }
  if (observedBeatIds.length !== expectedBeatIds.length || observedBeatIds.some((beatId, index) => beatId !== expectedBeatIds[index])) return null;
  return {
    title: context.title,
    pages,
    panelCount: pages.reduce((sum, page) => sum + page.panels.length, 0),
    dialogueCount
  };
}

/** panelsPerPage を JSON Schema にも反映し、LLM 側の構造化出力で超過を許さない。 */
export function createBeatPageNamingSchema(maxPanelsPerPage = 6) {
  return {
    type: "object", additionalProperties: false, required: ["pages"], properties: { pages: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["index", "pageIntent", "turnHook", "panels"], properties: {
        index: { type: "integer" }, pageIntent: { type: "string" }, turnHook: { type: "string", enum: ["reveal", "cliffhanger", "none"] },
        panels: { type: "array", minItems: 1, maxItems: normalizeMaxPanelsPerPage(maxPanelsPerPage), items: { type: "object", additionalProperties: false,
          required: ["id", "sourceBeatIds"], properties: { id: { type: "string" },
            sourceBeatIds: { type: "array", minItems: 1, items: { type: "string" } } } } }
      }
    } } }
  } as const;
}

/** 後方互換用の既定(最大6コマ)スキーマ。N1 呼び出しでは動的 factory を使う。 */
export const BEAT_PAGE_NAMING_SCHEMA = createBeatPageNamingSchema();

// --- 決定的ビートパッカー(ネームスタジオV5 D2) ---

export interface BeatPackerInput {
  units: readonly PreLayoutUnit[];
  beats: readonly AnnotatedBeat[];
  title: string;
  stylePrompt?: string;
  /** ページ密度の目安。バンド検証(±20%)はLLM出力への制約であり、パッカー出力には適用しない。 */
  targetPageCount?: number;
  maxPanelsPerPage?: number;
  maxDialoguesPerPanel?: number;
  maxDialogueCharactersPerPanel?: number;
}

/**
 * 注釈済みビートを入力にする決定的なページ/コマ束ね(V5の最終フォールバック)。
 * 旧 `planScriptManga` と違い、ビート情報(preferredScale/keepAlone/シーン純度)を捨てない。
 *
 * 充足保証(この関数はどんな非空入力にも必ずプランを返す):
 * - capを超えるビートは**連続コマへ分割**する(sourceBeatIds を連続コマで重複保持。
 *   span分割elementIdの重複保持と同じ既存前例)。unit単位では全unitちょうど一度ずつ。
 * - 単独でcap超過する台詞unitは原子なので「台詞1つだけのコマ」として合法(validatorも同じ例外)。
 * - splash希望は単独コマ・単独ページ、keepAloneは単独コマ、large以上は1コマ1ビート、
 *   1ページのlargeコマは2つまで。
 * - units/beats が空の場合は明示エラー(上流が空スクリプトの縮退経路へ倒す)。
 */
export function packAnnotatedBeatsDeterministically(input: BeatPackerInput): ScriptMangaPlan {
  if (input.units.length === 0 || input.beats.length === 0) {
    throw new Error("packAnnotatedBeatsDeterministically requires non-empty units and beats");
  }
  const unitById = new Map(input.units.map((unit) => [unit.id, unit]));
  const maxDialogueCharacters = Math.max(40, Math.trunc(input.maxDialogueCharactersPerPanel ?? 260));
  const maxDialogues = Math.max(1, Math.min(8, Math.trunc(input.maxDialoguesPerPanel ?? 4)));
  const panelLimit = normalizeMaxPanelsPerPage(input.maxPanelsPerPage);
  const stylePrompt = input.stylePrompt?.trim() || DEFAULT_SCRIPT_MANGA_STYLE;
  const isLargePlus = (beat: AnnotatedBeat) => beat.preferredScale === "large" || beat.preferredScale === "splash";

  // 1) ビート → チャンク列。capを超えるビートだけを連続チャンクへ分割する。
  interface Chunk { beat: AnnotatedBeat; units: PreLayoutUnit[]; split: boolean }
  const chunks: Chunk[] = [];
  for (const beat of input.beats) {
    const beatUnits = beat.unitIds
      .map((unitId) => unitById.get(unitId))
      .filter((unit): unit is PreLayoutUnit => Boolean(unit));
    if (beatUnits.length === 0) continue;
    const parts: PreLayoutUnit[][] = [];
    let current: PreLayoutUnit[] = [];
    let dialogueCount = 0;
    let dialogueChars = 0;
    for (const unit of beatUnits) {
      if (unit.type === "dialogue") {
        const overflow = dialogueCount + 1 > maxDialogues
          || (dialogueCount >= 1 && dialogueChars + unit.dialogueCharacters > maxDialogueCharacters);
        if (overflow && current.length > 0) {
          parts.push(current);
          current = [];
          dialogueCount = 0;
          dialogueChars = 0;
        }
        dialogueCount += 1;
        dialogueChars += unit.dialogueCharacters;
      }
      current.push(unit);
    }
    if (current.length > 0) parts.push(current);
    for (const part of parts) chunks.push({ beat, units: part, split: parts.length > 1 });
  }

  // 2) チャンク → コマ。同一シーンかつcap内なら連続ビートを最大3つまで束ねる。
  interface PanelDraft { units: PreLayoutUnit[]; beats: AnnotatedBeat[]; beatIds: string[] }
  const drafts: PanelDraft[] = [];
  const dialogueStats = (units: readonly PreLayoutUnit[]) => {
    const dialogues = units.filter((unit) => unit.type === "dialogue");
    return { count: dialogues.length, chars: dialogues.reduce((sum, unit) => sum + unit.dialogueCharacters, 0) };
  };
  for (const chunk of chunks) {
    const last = drafts[drafts.length - 1];
    const merged = last ? dialogueStats([...last.units, ...chunk.units]) : null;
    const canMerge = Boolean(
      last && merged
      // 分割ビートの断片は常に単独コマ(再結合するとcap超過が復活するため)。
      && !chunk.split
      && last.units[0]!.sceneIndex === chunk.units[0]!.sceneIndex
      && !chunk.beat.keepAlone && last.beats.every((beat) => !beat.keepAlone)
      && chunk.beat.preferredScale !== "splash" && last.beats.every((beat) => beat.preferredScale !== "splash")
      && !(isLargePlus(chunk.beat) && last.beats.some(isLargePlus))
      && new Set([...last.beatIds, chunk.beat.id]).size <= 3
      && merged.count <= maxDialogues
      && merged.chars <= maxDialogueCharacters
    );
    if (canMerge && last) {
      last.units.push(...chunk.units);
      if (last.beatIds[last.beatIds.length - 1] !== chunk.beat.id) {
        last.beatIds.push(chunk.beat.id);
        last.beats.push(chunk.beat);
      }
    } else {
      drafts.push({ units: [...chunk.units], beats: [chunk.beat], beatIds: [chunk.beat.id] });
    }
  }

  // 3) コマ → ページ。targetPageCount は密度の目安として使う(hard capはpanelLimitのみ)。
  const target = input.targetPageCount && input.targetPageCount > 0 ? Math.trunc(input.targetPageCount) : undefined;
  const fillLimit = target ? Math.max(1, Math.min(panelLimit, Math.ceil(drafts.length / target))) : panelLimit;
  const pages: ScriptMangaPagePlan[] = [];
  interface PendingPanel { panel: ScriptMangaPanelPlan; demand: PanelDemand }
  let pagePanels: PendingPanel[] = [];
  let pageLargeCount = 0;
  let panelSerial = 0;
  // V5 D3: ページ確定は実現可能性ゲート込み。実現可能なレイアウトが無ければ末尾コマを
  // 次ページへ送って縮めていく(1コマページは minArea cap 0.8 < splash面積1.0 で常に実現可能
  // = パッカーの充足保証)。
  const closePage = () => {
    let pending = pagePanels;
    pagePanels = [];
    pageLargeCount = 0;
    while (pending.length > 0) {
      let take = pending.length;
      let layoutTemplateId: string | null = null;
      while (take >= 1) {
        const slice = pending.slice(0, take);
        const feasible = feasibleLayouts(
          slice.map((entry) => entry.demand),
          { previousLayoutId: pages[pages.length - 1]?.layoutTemplateId }
        );
        if (feasible.length > 0) {
          layoutTemplateId = feasible[0]!.layoutId;
          break;
        }
        take -= 1;
      }
      if (layoutTemplateId === null) {
        // 理論上到達しない安全網(1コマページは常に実現可能)。候補先頭で前進する。
        take = 1;
        layoutTemplateId = scriptMangaLayoutCandidates(1)[0]!;
      }
      const slicePanels = pending.slice(0, take).map((entry) => entry.panel);
      pages.push({
        index: pages.length,
        title: slicePanels[0]!.sceneHeading || `Page ${pages.length + 1}`,
        layoutTemplateId,
        panels: slicePanels
      });
      pending = pending.slice(take);
    }
  };
  for (const draft of drafts) {
    const visualScale = derivePanelVisualScale(draft.beats, { panelIndex: pagePanels.length, panelCount: fillLimit });
    if (visualScale === "splash") closePage();
    if (pagePanels.length >= fillLimit) closePage();
    if (visualScale === "large" && pageLargeCount >= 2) closePage();
    panelSerial += 1;
    const stats = dialogueStats(draft.units);
    pagePanels.push({
      panel: panelFromUnits({
        id: `packed-${panelSerial}`,
        unitsOfPanel: draft.units,
        sourceBeatIds: draft.beatIds,
        stylePrompt,
        visualScale
      }),
      demand: buildPanelDemand({ visualScale, totalCharacters: stats.chars, balloonCount: stats.count })
    });
    if (visualScale === "large") pageLargeCount += 1;
    if (visualScale === "splash") closePage();
  }
  closePage();

  return {
    title: input.title,
    pages,
    panelCount: pages.reduce((sum, page) => sum + page.panels.length, 0),
    dialogueCount: input.units.filter((unit) => unit.type === "dialogue").length
  };
}
