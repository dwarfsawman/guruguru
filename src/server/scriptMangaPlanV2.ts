import type { FountainDoc } from "../shared/fountain";
import {
  MANGA_PLAN_VERSION,
  MANGA_PLANNER_VERSION,
  PANEL_PROMPT_COMPILER_VERSION,
  type DialoguePolicy,
  type MangaBeat,
  type MangaPlanV2,
  type MangaShotSize,
  type NormalizedBox,
  type PanelCastSpec,
  type PanelSpec,
  type StateDelta,
  type WorldState
} from "../shared/mangaPlanV2";
import type { ScriptMangaPanelPlan, ScriptMangaPlan } from "../shared/scriptMangaPlan";
import type { AnnotatedBeat, PreLayoutUnit } from "../shared/preLayoutBeat";
import { orderPanelsByReadingDirection } from "../shared/dialogueAutoLayout";
import { panelBounds, type PageLayout } from "../shared/pageLayout";
import { reconstructCastPoses, type PoseAnchor } from "./panelPoseReconstructor";
import type { StyleLoraSelection } from "../shared/types";
import { extractFillUnits } from "../shared/dialogueAdaptation";
import { dialogueEstablishesVisibleSpeaker } from "../shared/dialoguePresentation";
import { compilePanelPrompt } from "./panelPromptCompiler";
import { resolvePanelReferences } from "./referenceResolver";
import {
  buildStoryGraph,
  fountainSourceElementId,
  type StoryGraphCharacterInput,
  type StoryGraphDialogueInput
} from "./storyGraphBuilder";

interface DirectedPanelFields {
  shot?: string;
  angle?: string;
  subject?: string;
  subjects?: Array<{
    ref: string;
    position: string;
    action: string;
    expression: string;
    gaze?: string;
    castRef?: string;
    head?: { x: number; y: number };
    torso?: { x: number; y: number };
    layer?: number;
  }>;
  avoid?: string[];
  action?: string;
  emotion?: string;
  composition?: string;
}

/** castRef 文字列の比較キー(前後空白と大文字小文字を無視する)。 */
function castRefKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * `direction.subjects[].castRef` を character id へ解決する。
 *
 * castRef は「このコマにこのキャラが写っている」という**明示宣言**として扱う。action 行の
 * 氏名一致(`visibleCharacterIdsForActionText`)だけに頼ると、固有名を避けて
 * 「a young woman in paint-stained overalls」のように書いた台詞なしのコマがキャスト空になり、
 * ポーズ拘束も参照条件付けも一切効かない。action へ固有名を書けばキャストは解決するが、
 * その氏名がそのままプロンプトへ漏れるので、避けて書くのが正しい。その正しい書き方を
 * 成立させるための結線が castRef である。
 *
 * 解決できない castRef は無視する(呼び出し側が warning として報告する)。
 */
function castRefCharacterIds(
  direction: DirectedPanelFields,
  story: { characterById: Map<string, { name: string; aliases: string[] }> }
): string[] {
  const refs = new Set(
    (direction.subjects ?? [])
      .map((subject) => (typeof subject.castRef === "string" ? castRefKey(subject.castRef) : ""))
      .filter(Boolean)
  );
  if (refs.size === 0) return [];
  const ids: string[] = [];
  for (const [characterId, character] of story.characterById) {
    const labels = [character.name, ...(character.aliases ?? [])].map(castRefKey);
    if (labels.some((label) => label && refs.has(label))) ids.push(characterId);
  }
  return ids;
}

/** 監督出力のアンカー座標を防御的に検証する(0..1クランプ、数値以外は捨てる)。 */
function anchorPoint(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const x = (value as { x?: unknown }).x;
  const y = (value as { y?: unknown }).y;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function positionBox(position: string): NormalizedBox {
  const [vertical = "middle", horizontal = "center"] = position.split("-");
  const width = 0.3;
  const height = 0.42;
  return {
    x: horizontal === "left" ? 0.04 : horizontal === "right" ? 0.66 : 0.35,
    y: vertical === "upper" ? 0.04 : vertical === "lower" ? 0.54 : 0.29,
    width,
    height
  };
}

function panelDirection(panel: ScriptMangaPanelPlan): DirectedPanelFields {
  const value = (panel as ScriptMangaPanelPlan & { direction?: DirectedPanelFields }).direction;
  return value ?? {};
}

function pageIntent(page: ScriptMangaPlan["pages"][number]): string {
  return (page as ScriptMangaPlan["pages"][number] & { pageIntent?: string }).pageIntent?.trim() || "clear right-to-left progression";
}

function legacySourceIds(panel: ScriptMangaPanelPlan, scriptRevisionId: string): string[] {
  const ids = (panel as ScriptMangaPanelPlan & { sourceElementIds?: string[] }).sourceElementIds ?? [];
  return ids.map((id) => {
    const match = /^scene-(\d+)-element-(\d+)$/.exec(id);
    return match ? fountainSourceElementId(scriptRevisionId, Number(match[1]), Number(match[2])) : id;
  });
}

function shotSize(value: string | undefined): MangaShotSize {
  const normalized = value?.toLocaleLowerCase() ?? "";
  if (normalized.includes("extreme") && normalized.includes("wide")) return "extreme-wide";
  if (normalized.includes("close") || normalized.includes("portrait")) return "close-up";
  if (normalized.includes("insert") || normalized.includes("detail")) return "insert";
  if (normalized.includes("wide") || normalized.includes("establish")) return "wide";
  return "medium";
}

/** 単独キャラのコマを寄りにしてよい台詞量の上限(文字)。これを超えると引きに戻す。 */
const REACTION_DIALOGUE_CHARS = 24;

/** 見出しの比較用正規化。大小文字・前後空白・連続空白の揺れだけを吸収する。 */
function normalizedHeading(heading: string): string {
  return heading.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

/**
 * 監督が shot を指定しなかったコマの寄り引きを、コマの構造から決める。
 *
 * 監督LLM無し(heuristic)では `direction.shot` が常に空で、全コマが `medium` になっていた。
 * 同じ画角が何十コマも続くのは漫画として読めないので、言語や作品に依存しない構造だけを
 * 手がかりにして散らす。単語マッチはしない(作品固有辞書を作らないため)。
 *
 * - 場所が変わった最初のコマ: 場所を見せる引き
 * - 人物なし: 小道具があれば insert、無ければ引き
 * - 3人以上: 全員入る引き
 * - 単独 + 短い台詞: 反応を見せる寄り
 * - それ以外: medium
 */
export function inferredShotSize(input: {
  castCount: number;
  propCount: number;
  dialogueChars: number;
  dialogueCount: number;
  /** 直前のコマから場所が変わったか。同じ見出しが続く場合は false。 */
  isNewSetting: boolean;
}): MangaShotSize {
  if (input.castCount === 0) {
    if (input.isNewSetting) return "wide";
    return input.propCount > 0 ? "insert" : "wide";
  }
  if (input.isNewSetting) return "wide";
  if (input.castCount >= 3) return "wide";
  if (input.castCount === 2) return "medium";
  if (input.dialogueCount > 0 && input.dialogueChars <= REACTION_DIALOGUE_CHARS) return "close-up";
  return "medium";
}

function castBoxes(count: number): NormalizedBox[] {
  if (count <= 1) return [{ x: 0.14, y: 0.18, width: 0.72, height: 0.78 }];
  if (count === 2) {
    return [
      { x: 0.54, y: 0.2, width: 0.42, height: 0.76 },
      { x: 0.04, y: 0.2, width: 0.42, height: 0.76 }
    ];
  }
  const gap = 0.025;
  const width = (0.94 - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, index) => ({
    x: 0.03 + (count - 1 - index) * (width + gap),
    y: 0.25,
    width,
    height: 0.7
  }));
}

function provisionalSafeZones(dialogueCount: number): NormalizedBox[] {
  if (dialogueCount <= 0) return [];
  if (dialogueCount === 1) return [{ x: 0.64, y: 0.03, width: 0.32, height: 0.3 }];
  return [
    { x: 0.66, y: 0.03, width: 0.31, height: 0.31 },
    { x: 0.03, y: 0.03, width: 0.31, height: 0.31 }
  ];
}

function defaultCharacterState(characterId: string): WorldState["characterStates"][string] {
  return {
    variantId: `${characterId}:default`,
    location: "in frame",
    outfit: "default continuity outfit",
    heldEntityIds: [],
    pose: "natural",
    emotion: "neutral"
  };
}

function cloneCharacterStates(states: WorldState["characterStates"]): WorldState["characterStates"] {
  return Object.fromEntries(
    Object.entries(states).map(([id, state]) => [id, { ...state, heldEntityIds: [...state.heldEntityIds] }])
  );
}

function findFocalSubject(subject: string | undefined, cast: PanelCastSpec[], characters: StoryGraphCharacterInput[], settingId: string): string {
  const normalized = subject?.trim().toLocaleLowerCase() ?? "";
  if (normalized) {
    const match = characters.find((character) =>
      [character.name, ...character.aliases].some((label) => normalized.includes(label.trim().toLocaleLowerCase()))
    );
    if (match && cast.some((member) => member.characterId === match.id)) return match.id;
  }
  return cast[0]?.characterId ?? settingId;
}

function inferSourceIds(
  panel: ScriptMangaPanelPlan,
  scriptRevisionId: string,
  sourceElements: ReturnType<typeof buildStoryGraph>["graph"]["sourceElements"]
): string[] {
  const explicit = legacySourceIds(panel, scriptRevisionId);
  if (explicit.length > 0) return explicit;
  const candidates = sourceElements.filter(
    (source) =>
      source.sceneIndex === panel.sceneIndex &&
      !source.omissionReason &&
      (panel.sourceText.includes(source.text) || source.text.split("\n").some((line) => line && panel.sourceText.includes(line)))
  );
  return candidates.length > 0
    ? candidates.map((source) => source.id)
    : [fountainSourceElementId(scriptRevisionId, panel.sceneIndex, 0)];
}

function stripDialogueWording(prompt: string, lines: StoryGraphDialogueInput[]): string {
  let out = prompt;
  for (const line of lines) {
    if (line.text.trim()) out = out.replaceAll(line.text.trim(), "");
  }
  return out.replace(/\s+/g, " ").trim();
}

export function buildMangaPlanV2(input: {
  id: string;
  projectId: string;
  scriptId: string;
  scriptRevisionId: string;
  doc: FountainDoc;
  legacyPlan: ScriptMangaPlan;
  characters: StoryGraphCharacterInput[];
  dialogues: StoryGraphDialogueInput[];
  providerId: string;
  globalLoras: StyleLoraSelection[];
  dialoguePolicy: DialoguePolicy;
  resolveLayoutTemplate: (layoutTemplateId: string) => PageLayout | null;
  /** ネームv4 D2: ビート注釈(ビート化N1が成立した場合)。beats を後付け生成から引き継ぎへ切り替える。 */
  beatAnnotation?: { units: PreLayoutUnit[]; beats: AnnotatedBeat[] } | null;
  /**
   * 人間ゲートの吹き出し位置ヒント(pageIndex → dialogue orderIndex → page 座標)。
   * orderIndex は story graph 経由で lineId へ解決し、V2 page の balloonCenterHints へ固定する。
   */
  balloonCenterHints?: Record<number, Record<number, { x: number; y: number }>> | null;
  /**
   * 舞台の**英語**の見た目記述(scene index → 記述)。プロンプトの背景句になる。
   * 未指定なら中立の背景句へ落ちる(白紙の余白は被写体の複製を招くので、必ず何かは入れる)。
   */
  settingDescriptions?: Record<number, string>;
}): MangaPlanV2 {
  const story = buildStoryGraph({
    doc: input.doc,
    scriptRevisionId: input.scriptRevisionId,
    characters: input.characters,
    dialogues: input.dialogues,
    ...(input.settingDescriptions ? { settingDescriptions: input.settingDescriptions } : {})
  });
  const fillUnits = input.dialoguePolicy === "fill"
    ? extractFillUnits(input.doc, (sceneIndex, elementIndex) => fountainSourceElementId(input.scriptRevisionId, sceneIndex, elementIndex))
    : [];
  const dialogueById = new Map(input.dialogues.map((line) => [line.id, line]));
  const activeCharacterStates: WorldState["characterStates"] = {};
  const beats: MangaBeat[] = [];
  const worldStates: WorldState[] = [];
  const sourceDialogueLineIds = new Set<string>();
  let previousPanelId: string | null = null;
  let previousSummary = "";
  let flatPanelIndex = 0;
  /** 場所が変わった最初のコマを引きにするための、直前コマの正規化済み見出し。 */
  let previousSceneHeading: string | null = null;
  const captionedScenes = new Set<number>();

  // ネームv4 D2: ビート注釈がある場合、beats は後付け生成ではなく注釈からの引き継ぎにする。
  // 注釈が全 panel の sourceBeatIds を賄えるときのみ有効(部分的な不整合は従来経路へ)。
  const annotationBeatIds = new Set((input.beatAnnotation?.beats ?? []).map((beat) => beat.id));
  const annotationUsable = annotationBeatIds.size > 0 && input.legacyPlan.pages.every((page) =>
    page.panels.every((panel) =>
      (panel.sourceBeatIds ?? []).length > 0 && panel.sourceBeatIds!.every((beatId) => annotationBeatIds.has(beatId))
    )
  );
  const planBeatId = (annotatedId: string) => `beat:${input.id}:${annotatedId}`;
  if (annotationUsable) {
    const unitById = new Map(input.beatAnnotation!.units.map((unit) => [unit.id, unit]));
    let previousAction = "";
    for (const annotated of input.beatAnnotation!.beats) {
      const beatUnits = annotated.unitIds.flatMap((unitId) => { const unit = unitById.get(unitId); return unit ? [unit] : []; });
      const sourceElementIds = [...new Set(beatUnits.map((unit) =>
        fountainSourceElementId(input.scriptRevisionId, unit.sceneIndex, unit.elementIndex)
      ))];
      const text = beatUnits.map((unit) => unit.text).join(" ").replace(/\s+/g, " ").trim();
      const action = text.length > 200 ? `${text.slice(0, 200)}…` : text || annotated.kind;
      beats.push({
        id: planBeatId(annotated.id),
        sourceElementIds,
        cause: previousAction || "scene setup",
        action,
        result: "",
        emotionChange: "",
        mustShow: [],
        dialogueOnly: [],
        kind: annotated.kind,
        importance: annotated.importance,
        preferredScale: annotated.preferredScale
      });
      previousAction = action;
    }
  }

  const pages = input.legacyPlan.pages.map((page) => {
    // 人間ゲートのコマ割り修正(customLayout)はテンプレ解決より優先して snapshot へ固定する。
    const resolvedLayout = page.customLayout ?? input.resolveLayoutTemplate(page.layoutTemplateId);
    if (!resolvedLayout) throw new Error(`Layout template could not be resolved: ${page.layoutTemplateId}`);
    const layoutSnapshot = JSON.parse(JSON.stringify(resolvedLayout)) as PageLayout;
    // plan panels[index] は layout の reading-order スロットへ対応する(materialize と同じ規約)。
    // figure スロットに落ちた panel には role を写し、プロンプトを立ち絵仕様へ切り替える。
    const orderedLayoutPanels = orderPanelsByReadingDirection(layoutSnapshot.panels, layoutSnapshot.readingDirection);
    const pageHints = input.balloonCenterHints?.[page.index];
    const balloonCenterHints = pageHints
      ? Object.entries(pageHints).flatMap(([orderKey, position]) => {
          const line = story.dialogueByOrder.get(Number(orderKey));
          return line && Number.isFinite(position.x) && Number.isFinite(position.y)
            ? [{ lineId: line.id, x: position.x, y: position.y }]
            : [];
        })
      : [];
    return {
      index: page.index,
      title: page.title,
      layoutTemplateId: page.layoutTemplateId,
      layoutSnapshot,
      pageIntent: pageIntent(page),
      // ネームv4 D1: N1のページめくり演出を V2 へも引き継ぐ(additive)。
      ...(page.turnHook !== undefined ? { turnHook: page.turnHook } : {}),
      ...(balloonCenterHints.length > 0 ? { balloonCenterHints } : {}),
      panels: page.panels.map((legacyPanel, panelIndexOnPage): PanelSpec => {
      const layoutRole = orderedLayoutPanels[panelIndexOnPage]?.role;
      const direction = panelDirection(legacyPanel);
      const dialogueLines = legacyPanel.dialogueOrderIndexes
        .map((order) => story.dialogueByOrder.get(order))
        .filter((line): line is StoryGraphDialogueInput => Boolean(line));
      dialogueLines.forEach((line) => sourceDialogueLineIds.add(line.id));
      const sourceElementIds = inferSourceIds(legacyPanel, input.scriptRevisionId, story.graph.sourceElements);
      const actionSources = sourceElementIds
        .flatMap((sourceId) => {
          const source = story.graph.sourceElements.find((candidate) => candidate.id === sourceId);
          return source && (source.type === "action" || source.type === "synopsis") ? [source] : [];
        });
      const actionSourceText = actionSources.map((source) => source.text).join("\n");
      const visibleDialogueLines = dialogueLines.filter(dialogueEstablishesVisibleSpeaker);
      const characterIds = [
        ...visibleDialogueLines.map((line) => line.characterId).filter((id): id is string => Boolean(id)),
        // Dialogue source text contains speaker labels. Resolve silent cast only
        // from action/synopsis elements so off-screen labels cannot become people.
        ...actionSources.flatMap((source) => story.visibleCharacterIdsForActionText(source.text)),
        // 監督の castRef による明示宣言。action 行の氏名一致だけに頼ると、
        // 「a young woman in paint-stained overalls」のように固有名を避けて書いた
        // 台詞なしのコマがキャスト空になり、ポーズ拘束も参照条件付けも一切効かなくなる
        // (action へ固有名を書くとプロンプトへ漏れるので、避けて書くのが正しい)。
        // castRef は非視覚の結線メタデータなので、これを可視宣言として扱う。
        ...castRefCharacterIds(direction, story)
      ].filter((id, index, all) => all.indexOf(id) === index);
      // 解決できない castRef は静かにキャストを空にしてしまう(ポーズ拘束と参照条件付けが
      // 両方消える)。原因が見えないと数時間の生成を無駄にするので warning へ出す。
      for (const subject of direction.subjects ?? []) {
        const ref = typeof subject.castRef === "string" ? subject.castRef.trim() : "";
        if (!ref) continue;
        const resolved = [...story.characterById.values()].some((character) =>
          [character.name, ...(character.aliases ?? [])].some((label) => castRefKey(label) === castRefKey(ref))
        );
        if (!resolved) {
          story.graph.warnings.push({
            code: "unresolved-cast-ref",
            message: `direction.subjects[].castRef "${ref}" does not match any character name or alias; the panel gets no pose control and no reference conditioning`,
            sourceElementId: sourceElementIds[0]
          });
        }
      }
      const boxes = castBoxes(Math.max(1, characterIds.length));
      // ネームポーズレイヤ: 監督の castRef(脚本上のキャラ名、非視覚メタデータ)で subject と
      // キャラを結線し、head/torso アンカーと layer 深度ヒントを集める。castRef 一致が
      // 最優先、無ければ旧来の ref 完全一致(中立ロール規約下では実質届かない)へ落ちる。
      const claimedSubjects = new Set<number>();
      const poseAnchors = new Map<string, PoseAnchor>();
      const poseLayers = new Map<string, number>();
      const cast: PanelCastSpec[] = characterIds.map((characterId, index) => {
        const character = story.characterById.get(characterId);
        const labels = [character?.name, ...(character?.aliases ?? [])]
          .filter((name): name is string => Boolean(name))
          .map((name) => name.trim().toLocaleLowerCase());
        const subjects = direction.subjects ?? [];
        let subjectIndex = subjects.findIndex((subject, position) =>
          !claimedSubjects.has(position) &&
          typeof subject.castRef === "string" &&
          labels.includes(subject.castRef.trim().toLocaleLowerCase())
        );
        if (subjectIndex < 0) {
          subjectIndex = subjects.findIndex((subject, position) =>
            !claimedSubjects.has(position) &&
            [character?.name, ...(character?.aliases ?? [])].some((name) => name === subject.ref)
          );
        }
        if (subjectIndex >= 0) claimedSubjects.add(subjectIndex);
        const directedSubject = subjectIndex >= 0 ? subjects[subjectIndex] : undefined;
        if (directedSubject?.head && directedSubject.torso) {
          const head = anchorPoint(directedSubject.head);
          const torso = anchorPoint(directedSubject.torso);
          if (head && torso) poseAnchors.set(characterId, { head, torso });
        }
        if (typeof directedSubject?.layer === "number" && Number.isFinite(directedSubject.layer)) {
          poseLayers.set(characterId, directedSubject.layer);
        }
        const speakingLineIds = dialogueLines.filter((line) => line.characterId === characterId).map((line) => line.id);
        return {
          characterId,
          variantId: `${characterId}:default`,
          bbox: directedSubject ? positionBox(directedSubject.position) : boxes[index]!,
          pose: directedSubject?.action || direction.action || "natural storytelling pose",
          gazeTarget: directedSubject?.gaze,
          expression: directedSubject?.expression || direction.emotion?.trim() || (speakingLineIds.length > 0 ? "engaged" : "observant"),
          action: directedSubject?.action || direction.action?.trim() || (speakingLineIds.length > 0 ? "speaking" : "participating in the depicted action"),
          speakingLineIds
        };
      });
      const settingId = story.settingIdByScene.get(legacyPanel.sceneIndex) ?? `setting:${input.scriptRevisionId}:scene-${legacyPanel.sceneIndex}`;
      const focalSubjectId = findFocalSubject(direction.subject, cast, [...story.characterById.values()], settingId);
      // figure スロットは単独の全身立ち絵。focal subject 1人へ絞り、bbox はスロットほぼ全面にする
      // (吹き出し回避ゾーン・切り抜き後の配置サイズの基準にもなる)。
      let effectiveCast = cast;
      if (layoutRole === "figure" && cast.length > 0) {
        const focal = cast.find((member) => member.characterId === focalSubjectId) ?? cast[0]!;
        effectiveCast = [{
          ...focal,
          bbox: { x: 0.1, y: 0.04, width: 0.8, height: 0.92 },
          pose: focal.pose || "standing full body"
        }];
      }
      const fillUnitIds = fillUnits.filter((unit) =>
        (unit.sourceElementId && sourceElementIds.includes(unit.sourceElementId)) ||
        (unit.id === `fill:scene:${legacyPanel.sceneIndex}` && !captionedScenes.has(legacyPanel.sceneIndex))
      ).map((unit) => unit.id);
      if (fillUnitIds.includes(`fill:scene:${legacyPanel.sceneIndex}`)) captionedScenes.add(legacyPanel.sceneIndex);
      const action = direction.action?.trim() || actionSourceText.split("\n").map((line) => line.trim()).find(Boolean) ||
        (dialogueLines.length > 0
          ? "hold on the grounded setting or prop while the scripted line remains off-panel"
          : "visual story beat");
      let panelBeatIds: string[];
      if (annotationUsable && legacyPanel.sourceBeatIds) {
        // 注釈済みビートからの引き継ぎ(ネームv4 D2)。ビートは既に beats へ登録済み。
        panelBeatIds = legacyPanel.sourceBeatIds.map(planBeatId);
      } else {
        const beatId = `beat:${input.id}:${flatPanelIndex}`;
        beats.push({
          id: beatId,
          sourceElementIds,
          cause: previousSummary || "scene setup",
          action,
          result: direction.composition?.trim() || "state shown in the next panel",
          emotionChange: direction.emotion?.trim() || "",
          mustShow: [...cast.map((member) => `character ${member.characterId}`), action],
          dialogueOnly: dialogueLines.map((line) => line.semanticKind)
        });
        panelBeatIds = [beatId];
      }

      for (const member of cast) {
        activeCharacterStates[member.characterId] ??= defaultCharacterState(member.characterId);
      }
      const preStateId = `state:${input.id}:panel-${flatPanelIndex}:pre`;
      worldStates.push({
        id: preStateId,
        settingId,
        characterStates: cloneCharacterStates(activeCharacterStates),
        propStates: {},
        time: "",
        weather: "",
        lighting: "",
        spatialNotes: []
      });
      const deltaCharacterStates: NonNullable<StateDelta["characterStates"]> = {};
      for (const member of cast) {
        deltaCharacterStates[member.characterId] = {
          pose: member.pose || member.action,
          emotion: member.expression,
          location: "in frame"
        };
        activeCharacterStates[member.characterId] = {
          ...activeCharacterStates[member.characterId]!,
          ...deltaCharacterStates[member.characterId]
        };
      }
      const postStateDelta: StateDelta = {
        settingId,
        characterStates: deltaCharacterStates,
        notes: [action]
      };
      const props = story.graph.entities
        .filter((entity) => (entity.kind === "prop" || entity.kind === "vehicle") && legacyPanel.sourceText.includes(entity.name))
        .map((entity) => ({ entityId: entity.id, state: "present" }));
      const promptBase = stripDialogueWording(legacyPanel.prompt, dialogueLines);
      const provisional: PanelSpec = {
        id: legacyPanel.id,
        ...(layoutRole === "figure" ? { role: "figure" as const } : {}),
        ...(legacyPanel.visualScale !== undefined ? { visualScale: legacyPanel.visualScale } : {}),
        // V5 D6: V2は未演出コマにも既定値を埋めるため、演出の出所をここで記録する。
        directionSource: legacyPanel.direction
          ? (input.legacyPlan.plannerProvenance?.kind === "llm-director" ? "llm" : "provided")
          : "fallback",
        sourceElementIds,
        beatIds: panelBeatIds,
        preStateId,
        postStateDelta,
        settingId,
        cast: effectiveCast,
        props,
        shot: {
          // 監督が指定した shot を最優先し、無い場合だけ構造から推定する。
          size: direction.shot?.trim()
            ? shotSize(direction.shot)
            : inferredShotSize({
                castCount: effectiveCast.length,
                propCount: props.length,
                dialogueChars: dialogueLines.reduce((total, line) => total + line.text.length, 0),
                dialogueCount: dialogueLines.length,
                // 手書き Fountain では同じ見出しが連続することが多く、scene index の
                // 変化だけを見ると同じ場所に何度も establishing shot が入る。見出しの
                // 文字列で比べ、場所が実際に変わったときだけ引きにする。
                isNewSetting: normalizedHeading(legacyPanel.sceneHeading) !== previousSceneHeading
              }),
          angle: direction.angle?.trim() || direction.shot?.trim() || "eye-level",
          focalSubjectId,
          compositionIntent: direction.composition?.trim() || "single clear action with readable silhouettes"
        },
        dialogueLineIds: dialogueLines.map((line) => line.id),
        fillUnitIds,
        dialogueOrderIndexes: [...legacyPanel.dialogueOrderIndexes],
        textSafeZones: provisionalSafeZones(dialogueLines.length),
        mustShow: [
          ...effectiveCast.map((member) => ({ kind: "entity-present" as const, entityId: member.characterId, description: `show ${member.characterId}` })),
          ...props.map((prop) => ({ kind: "entity-present" as const, entityId: prop.entityId, description: `show ${prop.entityId}` })),
          { kind: "action", description: action }
        ],
        mustNotShow: [
          { kind: "other", description: "generated text, letters, captions, speech bubbles, logos or watermarks" },
          ...(direction.avoid ?? []).map((description) => ({ kind: "other" as const, description }))
        ],
        continuityFromPanelIds: previousPanelId ? [previousPanelId] : [],
        referenceManifest: [],
        sceneIndex: legacyPanel.sceneIndex,
        sceneHeading: legacyPanel.sceneHeading,
        sourceText: legacyPanel.sourceText,
        promptBase,
        compiledPrompt: ""
      };
      // ネームポーズレイヤ: 骨格を plan へ焼き込む(poseControl 設定とは独立に常時生成)。
      // アスペクトはコマ枠スロットの外接箱(width-relative 単位で x/y 同一スケール)から取る。
      const slotShape = orderedLayoutPanels[panelIndexOnPage]?.shape;
      let panelAspect = 1;
      if (slotShape) {
        const bounds = panelBounds(slotShape);
        const boundsWidth = bounds[2] - bounds[0];
        const boundsHeight = bounds[3] - bounds[1];
        if (boundsWidth > 1e-6 && boundsHeight > 1e-6) panelAspect = boundsHeight / boundsWidth;
      }
      const castPoses = reconstructCastPoses(provisional, {
        anchors: poseAnchors,
        layers: poseLayers,
        aspect: panelAspect
      });
      if (castPoses) provisional.castPoses = castPoses;
      const references = resolvePanelReferences({
        projectId: input.projectId,
        providerId: input.providerId,
        cast: effectiveCast,
        focalSubjectId,
        globalLoras: input.globalLoras
      });
      provisional.referenceManifest = references.manifest;
      provisional.compiledPrompt = compilePanelPrompt({
        panel: provisional,
        basePrompt: promptBase,
        entities: story.graph.entities,
        dialogueById,
        narrativeMetadata: input.legacyPlan.plannerProvenance?.kind === "llm-director" ? "english-directed" : "append"
      });
      for (const member of effectiveCast) {
        if (!references.manifest.some((reference) => reference.entityId === member.characterId)) {
          story.graph.warnings.push({
            code: "missing-reference",
            message: `No ${input.providerId} appearance binding for character ${member.characterId}`,
            sourceElementId: sourceElementIds[0]
          });
        }
      }
      previousPanelId = provisional.id;
      previousSummary = action;
      previousSceneHeading = normalizedHeading(legacyPanel.sceneHeading);
      flatPanelIndex += 1;
        return provisional;
      })
    };
  });

  story.graph.beats = beats;
  story.graph.worldStates = worldStates;
  return {
    version: MANGA_PLAN_VERSION,
    id: input.id,
    title: input.legacyPlan.title,
    scriptId: input.scriptId,
    scriptRevisionId: input.scriptRevisionId,
    dialoguePolicy: input.dialoguePolicy,
    plannerVersion: MANGA_PLANNER_VERSION,
    promptCompilerVersion: PANEL_PROMPT_COMPILER_VERSION,
    plannerProvenance: input.legacyPlan.plannerProvenance,
    narrativeGraph: story.graph,
    sourceDialogueLineIds: [...sourceDialogueLineIds],
    dialogueSnapshots: input.dialogues
      .filter((line) => sourceDialogueLineIds.has(line.id))
      .map((line) => ({
        id: line.id,
        orderIndex: line.orderIndex,
        sceneIndex: line.sceneIndex,
        characterId: line.characterId,
        speakerLabel: line.speakerLabel,
        text: line.text,
        semanticKind: line.semanticKind,
        balloonStyle: line.balloonStyle
      })),
    fillUnits,
    pages,
    panelCount: pages.reduce((sum, page) => sum + page.panels.length, 0),
    dialogueCount: sourceDialogueLineIds.size,
    createdAt: new Date().toISOString()
  };
}
