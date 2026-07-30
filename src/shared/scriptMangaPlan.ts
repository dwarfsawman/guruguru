import type { FountainDoc, FountainElement } from "./fountain";
import { buildPanelDemand, feasibleLayouts } from "./layoutMatcher";
import { scriptMangaLayoutCandidates } from "./layoutPresets";
import { type MangaPageTurnHook, type MangaVisualScale, normalizeLegacyVisualScale } from "./mangaPlanV2";
import type { PageLayout } from "./pageLayout";

/**
 * 人間のページ別レイアウト選択(V5 D5)を不変の基礎プランへ適用した「実効プラン」を返す。
 * 基礎プランは書き換えない(undo/リセット・生成案と人間修正の区別のため)。
 */
export function applyLayoutOverrides(
  plan: ScriptMangaPlan,
  overrides: Record<number, string> | undefined
): ScriptMangaPlan {
  if (!overrides || Object.keys(overrides).length === 0) return plan;
  return {
    ...plan,
    pages: plan.pages.map((page) => {
      const override = overrides[page.index];
      return override && override !== page.layoutTemplateId ? { ...page, layoutTemplateId: override } : page;
    })
  };
}

/**
 * 永続 candidate plan のparse直後に呼ぶ入力adapter(V5 D1)。旧語彙(importance)しか持たない
 * コマへ visualScale を補完する(in-place)。
 */
export function normalizeScriptMangaPlanScales(plan: ScriptMangaPlan): ScriptMangaPlan {
  for (const page of plan.pages) {
    for (const panel of page.panels) {
      if (!panel.visualScale) {
        // 旧語彙の importance は型からは削除済みだが、永続JSONには残っている。
        const scale = normalizeLegacyVisualScale({ importance: (panel as { importance?: unknown }).importance });
        if (scale) panel.visualScale = scale;
      }
    }
  }
  return plan;
}

export interface ScriptMangaPanelDirection {
  shot: string;
  angle?: string;
  subject: string;
  subjects?: Array<{
    ref: string;
    position: string;
    action: string;
    expression: string;
    gaze?: string;
    /** 脚本上のキャラ名(非視覚の結線メタデータ)。プロンプトへはコンパイルしない。 */
    castRef?: string;
    /** ポーズアンカー: 頭部中心(パネルローカル 0..1)。ネームポーズレイヤ。 */
    head?: { x: number; y: number };
    /** ポーズアンカー: 腰・胴中心(パネルローカル 0..1)。 */
    torso?: { x: number; y: number };
    /** レイヤ深度 0..3(大きいほど手前)。 */
    layer?: number;
  }>;
  avoid?: string[];
  action: string;
  emotion: string;
  composition: string;
}

export interface ScriptMangaPanelPlan {
  id: string;
  sceneIndex: number;
  sceneHeading: string;
  sourceElementIds: string[];
  prompt: string;
  sourceText: string;
  dialogueOrderIndexes: number[];
  /**
   * このコマの台詞本文の合計文字数。レイアウト選択の収容見積もりに使う。
   * 旧プラン(DBに永続化済み)には無いので optional。
   */
  dialogueCharacters?: number;
  direction?: ScriptMangaPanelDirection;
  /** 解決済みコマスケール(ネームスタジオV5 D1)。旧 importance enum の後継。旧経路では未設定。 */
  visualScale?: MangaVisualScale;
  /** ビート化N1(ネームv4 D2)がこのコマへ割り当てた注釈ビート id。従来経路では未設定。 */
  sourceBeatIds?: string[];
}

export interface ScriptMangaPagePlan {
  index: number;
  title: string;
  layoutTemplateId: string;
  panels: ScriptMangaPanelPlan[];
  pageIntent?: string;
  /** N1ページネームのページめくり演出(ネームv4 D1)。決定的プランナーでは未設定。 */
  turnHook?: MangaPageTurnHook;
  /**
   * 人間ゲートのコマ割り修正(custom_layouts_json 由来)。**in-memory 注釈**であり plan_json へは
   * 保存しない。`applyCustomNameLayouts` が実効プラン生成時に付与し、`buildMangaPlanV2` が
   * layoutTemplateId の解決より優先して layoutSnapshot へ固定する。
   */
  customLayout?: PageLayout;
}

export interface ScriptMangaPlan {
  title: string;
  pages: ScriptMangaPagePlan[];
  panelCount: number;
  dialogueCount: number;
  /** Exact structured-director exchanges used to create this plan (absent for deterministic planning). */
  plannerProvenance?: {
    kind: "llm-director";
    model: string;
    batches: Array<{
      rawOutput: string;
      messages: Array<{ role: string; content: string }>;
    }>;
    pageNaming?: {
      rawOutput: string;
      messages: Array<{ role: string; content: string }>;
      fallback: boolean;
      /**
       * どの N1 経路が成立したか(V5 D2: beats=ビート化N1 / deterministic=決定的ビートパッカー)。
       * 保存済みprovenanceには旧値 "panels"(従来N1、V5で削除)が残り得るが、読み手は未知値として扱う。
       */
      mode?: "beats" | "deterministic";
      /** ビート注釈が決定的フォールバック(1要素=1ビート)だったか。 */
      beatAnnotatorFallback?: boolean;
    };
  };
}

/**
 * 人間ゲートのコマ割り修正(pageIndex → 編集済み PageLayout)を実効プランへ注釈する。
 * 基礎プランは書き換えず、該当ページへ `customLayout` を付与した新しいプランを返す。
 * 注釈は plan_json へ保存されない(候補の custom_layouts_json が唯一の永続層)。
 */
export function applyCustomNameLayouts(
  plan: ScriptMangaPlan,
  customLayouts: Record<number, PageLayout> | undefined
): ScriptMangaPlan {
  if (!customLayouts || Object.keys(customLayouts).length === 0) return plan;
  return {
    ...plan,
    pages: plan.pages.map((page) => {
      const layout = customLayouts[page.index];
      return layout ? { ...page, customLayout: layout } : page;
    })
  };
}

/** `customLayout` 注釈を取り除いたプランを返す(plan_json への保存前に使う)。 */
export function stripCustomNameLayouts(plan: ScriptMangaPlan): ScriptMangaPlan {
  if (!plan.pages.some((page) => page.customLayout !== undefined)) return plan;
  return {
    ...plan,
    pages: plan.pages.map((page) => {
      if (page.customLayout === undefined) return page;
      const { customLayout: _dropped, ...rest } = page;
      return rest;
    })
  };
}

/**
 * Name Studio 候補の物語構造を比較する安定署名。
 *
 * 文言・prompt・演出 direction・既定 layout の差は同じネーム構造として扱い、ページ/コマ境界、
 * source element/dialogue の割当、visualScale、めくり、人間の layout override が違う時だけ別案にする。
 * sourceBeatIds は注釈器の有無で省略される補助情報なので、署名を環境依存にしないため含めない。
 * panel id は外部 agent が案ごとに振り直せるため署名へ含めない。
 */
export function scriptMangaPlanStructureSignature(
  plan: ScriptMangaPlan,
  layoutOverrides: Readonly<Record<number, string>> = {}
): string {
  return JSON.stringify([
    plan.pages.map((page) => [
      page.index,
      page.turnHook ?? "",
      page.panels.map((panel) => [
        panel.sceneIndex,
        panel.sourceElementIds,
        panel.dialogueOrderIndexes,
        panel.visualScale ?? ""
      ])
    ]),
    Object.entries(layoutOverrides).sort(([a], [b]) => Number(a) - Number(b))
  ]);
}

/**
 * `maxDialoguesPerPanel` の既定値。4だと1コマの台詞量が多く最小可読サイズ/専有率preflightで
 * failしやすい実績があったため3にしている(2026-07-18)。
 */
export const DEFAULT_MAX_DIALOGUES_PER_PANEL = 3;

export interface ScriptMangaPlanOptions {
  panelsPerPage?: number;
  maxElementsPerPanel?: number;
  /** 1コマへ割り当てるFountain dialogue要素数の上限。1〜8、既定は DEFAULT_MAX_DIALOGUES_PER_PANEL。吹き出し数そのものではない。 */
  maxDialoguesPerPanel?: number;
  maxSourceCharactersPerPanel?: number;
  stylePrompt?: string;
  /** LLMネーム監督が全バッチへ再注入する人物固定票。決定的プランナーでは未使用。 */
  characterBible?: string;
  /** 目標ページ数。決定的packerでは1ページ1コマ〜panelsPerPageの範囲でbest-effort配分する。 */
  targetPageCount?: number;
  /** ビート注釈キャッシュ(script_beat_annotations)のキー。未指定はキャッシュ不使用。 */
  scriptRevisionId?: string;
}

/**
 * 既定のスタイル。**否定句を入れてはいけない。**
 *
 * 以前は末尾に "no text, no speech bubbles" を付けていた。しかしこれは positive prompt であり、
 * 蒸留モデル(CFG 1 推奨の Anima Turbo 等)では classifier-free guidance が無効で否定が働かない。
 * 結果として "text" "speech bubbles" というトークンを positive へ置いているのと同じになり、
 * モデルが絵の中へ偽文字と偽吹き出しを描き込む(実測で候補の約半数が失格した)。
 * 文字類の抑制は negative(`TEXT_NEGATIVE`)側だけで行う。
 */
export const DEFAULT_SCRIPT_MANGA_STYLE =
  "Japanese monochrome manga, cinematic composition, expressive characters, detailed ink line art, screentone";
const DEFAULT_STYLE = DEFAULT_SCRIPT_MANGA_STYLE;

/** 要素の「読める」テキスト(sourceText 用)。ビート層(preLayoutBeat)と共有する。 */
export function elementVisibleText(element: FountainElement): string {
  return visibleText(element);
}

/** 要素の視覚化テキスト(画像プロンプト用)。ビート層(preLayoutBeat)と共有する。 */
export function elementVisualText(element: FountainElement): string {
  return visualText(element);
}

function visibleText(element: FountainElement): string {
  switch (element.type) {
    case "dialogue":
      return `${element.speaker}: ${element.text}`;
    case "action":
    case "transition":
    case "synopsis":
      return element.text;
    case "section":
      return "";
  }
}

function visualText(element: FountainElement): string {
  switch (element.type) {
    case "dialogue": {
      const speechAct = /[?？]/.test(element.text) ? "question" : /[!！]/.test(element.text) ? "exclamation" : "statement";
      const emotion = speechAct === "question" ? "inquisitive" : speechAct === "exclamation" ? "emphatic" : "focused";
      const delivery = element.parenthetical?.trim() ? `, deliveryDirection=${element.parenthetical.trim()}` : "";
      return `${element.speaker} speaking, speechAct=${speechAct}, emotion=${emotion}, mouthState=speaking, gazeTarget=conversation partner, gesture=natural conversational gesture${delivery}`;
    }
    case "action":
    case "synopsis":
      return element.text;
    case "transition":
    case "section":
      return "";
  }
}

/** scene-element の決定的 ID。`preLayoutBeat.ts` の unit ID とも共有(同一規則である必要がある)。 */
export function sourceElementId(sceneIndex: number, elementIndex: number): string {
  return `scene-${sceneIndex}-element-${elementIndex}`;
}

function layoutForPanelCount(count: number): string {
  const layout = scriptMangaLayoutCandidates(count)[0];
  if (!layout) throw new Error(`No script manga layout supports ${count} panels.`);
  return layout;
}

/**
 * ページ末尾のコマを「めくりの着地」として見せ場へ引き上げる決定的規則。
 *
 * 監督LLMが無い経路でも `visualScale` を必ず一様(=未設定)にしないための最小限の演出。
 * 台詞を多く抱えるコマを大きくしても絵は強くならないので、ページ内で相対的に台詞が
 * 軽い末尾コマだけを large にする。これが無いと rankLayouts の面積コストが均一配分を
 * 常に最小にしてしまい、均等段組しか選ばれない。
 */
const TURN_PANEL_DIALOGUE_SHARE_CAP = 0.4;

function assignDeterministicVisualScales(pagePanels: readonly ScriptMangaPanelPlan[]): MangaVisualScale[] {
  const scales: MangaVisualScale[] = pagePanels.map(() => "medium");
  if (pagePanels.length < 2) return scales;
  const total = pagePanels.reduce((sum, panel) => sum + (panel.dialogueCharacters ?? 0), 0);
  const lastIndex = pagePanels.length - 1;
  const lastShare = total > 0 ? (pagePanels[lastIndex]!.dialogueCharacters ?? 0) / total : 0;
  if (lastShare <= TURN_PANEL_DIALOGUE_SHARE_CAP) scales[lastIndex] = "large";
  return scales;
}

/**
 * ページのコマ列からレイアウトを選ぶ。
 *
 * かつては候補配列の先頭固定で、脚本全体が `two-horizontal` / `three-horizontal` だけになり、
 * ライブラリの裁ち切り・大ゴマ・斜め・ぶち抜きが一度も選ばれなかった。`feasibleLayouts` へ
 * 差し替える実験は、実際の吹き出し配置が「配置できなかった」で run 作成ごと失敗して頓挫した。
 *
 * 真因は `estimateMinimumPanelArea` が**面積だけ**を見ていたこと。縦書き日本語の吹き出しは
 * **高さ**を要求するのに、下段大ゴマのレイアウトは上段を横長の帯にする。面積は足りていても
 * 縦書きが入らない。均等段組はどの段も 1/N の高さがあるので入る ——「均等段組だけが成立する」
 * の正体はこれだった。`estimateMinimumPanelHeight` を hard constraint として足したことで
 * 実現不能なレイアウトが実現可能集合から落ちるようになったので、ランキングへ移行した。
 *
 * 実現可能な候補が1つも無い場合(見積もりが実挙動より厳しいケース)は、確実に組めることを
 * 優先して従来どおり候補先頭へフォールバックする。
 */
function selectPageLayout(pagePanels: readonly ScriptMangaPanelPlan[], recentLayoutIds: readonly string[] = []): string {
  const scales = assignDeterministicVisualScales(pagePanels);
  const demands = pagePanels.map((panel, index) => {
    const balloonCount = panel.dialogueOrderIndexes.length;
    return buildPanelDemand({
      visualScale: panel.visualScale ?? scales[index],
      totalCharacters: panel.dialogueCharacters ?? 0,
      balloonCount
    });
  });
  const feasible = feasibleLayouts(demands, { recentLayoutIds });
  return feasible[0]?.layoutId ?? layoutForPanelCount(pagePanels.length);
}

/**
 * Fountain の連続要素を、画像生成可能な視覚的コマへ決定的に束ねる。
 * シーン境界は跨がず、発話数・文字量にも上限を置くことで、長編脚本でも
 * 1 action = 1 image の過剰生成を避けつつ、全発話を必ずいずれかのコマへ割り当てる。
 */
export function planScriptManga(doc: FountainDoc, options: ScriptMangaPlanOptions = {}): ScriptMangaPlan {
  const panelsPerPage = Math.max(1, Math.min(6, Math.trunc(options.panelsPerPage ?? 4)));
  const maxElements = Math.max(1, Math.trunc(options.maxElementsPerPanel ?? 6));
  const maxDialogues = Math.max(1, Math.min(8, Math.trunc(options.maxDialoguesPerPanel ?? DEFAULT_MAX_DIALOGUES_PER_PANEL)));
  const maxCharacters = Math.max(40, Math.trunc(options.maxSourceCharactersPerPanel ?? 260));
  const stylePrompt = options.stylePrompt?.trim() || DEFAULT_STYLE;

  const panels: ScriptMangaPanelPlan[] = [];
  let dialogueOrder = 0;

  doc.scenes.forEach((scene, sceneIndex) => {
    let elements: Array<{ element: FountainElement; sourceElementId: string }> = [];
    let dialogueIndexes: number[] = [];
    let characterCount = 0;

    const flush = () => {
      const sourceParts = elements.map(({ element }) => visibleText(element)).filter(Boolean);
      const visualParts = elements.map(({ element }) => visualText(element)).filter(Boolean);
      if (sourceParts.length === 0) {
        elements = [];
        dialogueIndexes = [];
        characterCount = 0;
        return;
      }
      // レイアウト選択(収容の hard constraint)は台詞量を必要とする。ここで数えておかないと
      // 決定的パッカー経路では常に0字扱いになり、実現可能性の判定が効かない。
      const dialogueCharacters = elements.reduce(
        (sum, { element }) => sum + (element.type === "dialogue" ? visibleText(element).length : 0),
        0
      );
      const panelIndex = panels.length;
      const sceneContext = scene.heading ? `Scene: ${scene.heading}.` : "";
      panels.push({
        id: `panel-${panelIndex + 1}`,
        sceneIndex,
        sceneHeading: scene.heading,
        sourceElementIds: elements.map((entry) => entry.sourceElementId),
        prompt: `${stylePrompt}. ${sceneContext} ${visualParts.join(" ")}`.replace(/\s+/g, " ").trim(),
        sourceText: sourceParts.join("\n"),
        dialogueOrderIndexes: [...dialogueIndexes],
        dialogueCharacters
      });
      elements = [];
      dialogueIndexes = [];
      characterCount = 0;
    };

    for (const [elementIndex, element] of scene.elements.entries()) {
      if (element.type === "section" || element.type === "transition") continue;
      const text = visibleText(element);
      if (!text) continue;
      // A new action/synopsis paragraph is a conservative moment boundary. Keep the
      // preceding action plus its dialogue exchange together, but never compress a
      // later state-changing action into that same still image merely to save panels.
      if (elements.length > 0 && (element.type === "action" || element.type === "synopsis")) {
        flush();
      }
      const nextDialogueCount = dialogueIndexes.length + (element.type === "dialogue" ? 1 : 0);
      if (
        elements.length > 0 &&
        (elements.length >= maxElements || nextDialogueCount > maxDialogues || characterCount + text.length > maxCharacters)
      ) {
        flush();
      }
      elements.push({ element, sourceElementId: sourceElementId(sceneIndex, elementIndex) });
      characterCount += text.length;
      if (element.type === "dialogue") {
        dialogueIndexes.push(dialogueOrder);
        dialogueOrder += 1;
      }
    }
    flush();
  });

  const requestedPageCount = Number.isFinite(options.targetPageCount) && (options.targetPageCount ?? 0) > 0
    ? Math.max(1, Math.trunc(options.targetPageCount!))
    : null;
  const minimumPageCount = Math.ceil(panels.length / panelsPerPage);
  const pageCount = requestedPageCount === null || panels.length === 0
    ? minimumPageCount
    : Math.min(panels.length, Math.max(minimumPageCount, requestedPageCount));
  const pages: ScriptMangaPagePlan[] = [];
  let offset = 0;
  while (offset < panels.length) {
    const remainingPages = pageCount - pages.length;
    const remainingPanels = panels.length - offset;
    // target指定時は連続順を維持したまま均等配分する。下限はhardなコマ密度制約から決まる。
    const count = requestedPageCount === null
      ? Math.min(panelsPerPage, remainingPanels)
      : Math.min(panelsPerPage, Math.ceil(remainingPanels / remainingPages));
    const pagePanels = panels.slice(offset, offset + count);
    const first = pagePanels[0];
    pages.push({
      index: pages.length,
      title: first?.sceneHeading || `Page ${pages.length + 1}`,
      // 直近3ページを反復ペナルティの対象にする(同構造のページが続いても形が並ばない)。
      layoutTemplateId: selectPageLayout(
        pagePanels,
        pages.slice(-3).reverse().map((page) => page.layoutTemplateId)
      ),
      panels: pagePanels
    });
    offset += count;
  }

  return {
    title: doc.titlePage.Title || "Manga",
    pages,
    panelCount: panels.length,
    dialogueCount: dialogueOrder
  };
}
