import type { NarrativeEntity, NormalizedBox, PanelSpec } from "../shared/mangaPlanV2";
import type { StoryGraphDialogueInput } from "./storyGraphBuilder";
import type { ReferenceSetSnapshot } from "../shared/referenceSets";
import { getDialoguePresentationMeaning, stripClausesContainingCharacterLabels } from "../shared/dialoguePresentation";

export type PromptDialect = "natural" | "tags";
export interface PanelConditioning { positive: string; negative: string }
const TEXT_NEGATIVE = "text, letters, words, typography, captions, subtitles, speech bubbles, manga sound effects, signage, labels, logos, watermarks, UI overlays";
/**
 * どのテンプレートでも外してはいけない negative。
 *
 * 解剖の破綻に加えて**被写体の複製**を抑える語を含む。1コマ漫画の生成では、モデルが
 * 「同一人物を並べたキャラクター設定表 / ターンアラウンド図」を描いて面を埋めることがあり、
 * 実測ではトヨ単独コマの 12/12 がこの壊れ方をした(参照画像が全身・正面・白背景の
 * 設定表風だと特に寄りやすい)。`multiple views` 系の語はこれを直接抑える。
 */
const QUALITY_NEGATIVE =
  "low quality, blurry, deformed, bad anatomy, extra limbs, extra fingers, " +
  "multiple views, character sheet, reference sheet, turnaround, split panel, diptych, " +
  "duplicate character, clone, twins, mirrored copy";

/**
 * モノクロ作品では**素材名も色を含意する**。
 *
 * 色名(`orange` 等)は書かないよう気をつけていても、脚本の `a brass tap` のような
 * 素材の指定が生成では金色の蛇口になる。CFG を上げて negative が効く状態でも素通りした
 * (実測: 該当コマの 4/4 が着色で不合格)。素材は色ではなく質感で書けば意図は保たれるので、
 * モノクロ指定の作品に限り、色を含意する語を中立な語へ寄せる。
 *
 * **小文字のみに一致させる。** 固有名詞(人物名の Silver、店名の Amber 等)を壊さないため。
 * プロンプトの形容句は実際には小文字で来る。
 */
const COLOR_IMPLYING_TERMS: Array<[RegExp, string]> = [
  [/\b(?:brass|copper|bronze|gold|golden|silver|chrome|steel-blue)\b/g, "metal"],
  [/\b(?:rusty|rusted)\b/g, "corroded"],
  [/\b(?:ivory|jade|emerald|crimson|scarlet|azure|turquoise|amber|sepia)\b/g, ""],
  [/\b(?:red|orange|yellow|green|blue|purple|violet|pink|brown|beige|teal|magenta|tan)\b/g, ""]
];
const MONOCHROME_NEGATIVE = "color, colored, colorful, chromatic, color illustration";

function isMonochromeStyle(...sources: Array<string | undefined>): boolean {
  return /\b(?:monochrome|greyscale|grayscale|black and white)\b/i.test(sources.filter(Boolean).join(" "));
}

function neutralizeColorLanguage(text: string): string {
  let out = text;
  for (const [pattern, replacement] of COLOR_IMPLYING_TERMS) out = out.replace(pattern, replacement);
  return out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/(?:\.\s*){2,}/g, ". ")
    .replace(/^[,.\s]+|[,\s]+$/g, "");
}

function tagSafeVisual(text: string): string {
  if (!text.trim()) return "";
  // Never pseudo-translate through a title/genre-specific dictionary. Structured LLM plans
  // should supply English visual facts for tag models; heuristic fallback keeps the source facts
  // intact instead of silently deleting or inventing meaning.
  return text.normalize("NFKC")
    .replace(/[\r\n。；;]+/gu, ", ")
    .replace(/、+/gu, ", ")
    .replace(/[^\p{L}\p{N}\p{M}\s,.'’"!?%:+\-()/]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/(?:\s*,\s*)+/g, ", ")
    .trim()
    .replace(/^,\s*|,\s*$/g, "");
}

function regionName(box: NormalizedBox): string {
  const horizontal = box.x + box.width / 2 < 0.38 ? "left" : box.x + box.width / 2 > 0.62 ? "right" : "center";
  const vertical = box.y + box.height / 2 < 0.38 ? "upper" : box.y + box.height / 2 > 0.62 ? "lower" : "middle";
  return `${vertical}-${horizontal} region`;
}

function speechAct(line: StoryGraphDialogueInput): string {
  const meaning = getDialoguePresentationMeaning(line);
  // 否定句と文字を指す語を positive へ書かない(CFG 1 では否定が効かず、逆に文字を描く指示になる)。
  // 「口を閉じている」のように**肯定形の視覚的事実**で言い換える。
  if (meaning.visibilityEvidence === "none") {
    return `${meaning.delivery} delivered separately from the depicted action, closed resting mouth`;
  }
  if (line.semanticKind === "monologue") return "quiet internal reaction with closed or resting mouth";
  if (line.semanticKind === "sfx") return "reacting to a sound, plain background";
  if (/[?？]\s*$/.test(line.text)) return "asking a question while speaking";
  if (/[!！]\s*$/.test(line.text)) return "speaking emphatically";
  return "speaking naturally";
}

function stripDialogueFromVisualFact(text: string, dialogueById: Map<string, StoryGraphDialogueInput>): string {
  let result = text;
  for (const line of dialogueById.values()) {
    const wording = line.text.trim();
    if (wording) result = result.replaceAll(wording, "");
  }
  return result
    .replace(/[「『《][^」』》]*[」』》]/gu, "")
    .replace(/(?:communication|dialogue|caption|monitor|screen|text)\s*[:=]\s*[^.;]+/giu, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([,.;])\s*\1+/g, "$1")
    .trim();
}

function compileProvidedVisualFacts(input: {
  panel: PanelSpec;
  basePrompt: string;
  entities: NarrativeEntity[];
  dialogueById: Map<string, StoryGraphDialogueInput>;
}): string {
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity]));
  const parts = [input.basePrompt.trim()];
  if (!/\b(?:extreme[- ]wide|wide|long|full|medium|close[- ]?up|insert)\s+shot\b/iu.test(input.basePrompt)) {
    parts.push(`${input.panel.shot.size} shot`);
  }
  const angle = input.panel.shot.angle?.trim();
  if (angle && !/\b(?:eye[- ]level|low|high|dutch|overhead|bird(?:'s)?[- ]eye)\b/iu.test(input.basePrompt)) {
    parts.push(angle);
  }
  for (const member of input.panel.cast) {
    const entity = entityById.get(member.characterId);
    parts.push([
      entity?.name || "character",
      entity?.attributes.description?.trim() || "",
      member.action,
      member.expression ? `${member.expression} expression` : "",
      member.pose || "",
      `in the ${regionName(member.bbox)}`
    ].filter(Boolean).join(", "));
  }
  for (const item of input.panel.mustShow) {
    const fact = stripDialogueFromVisualFact(item.description, input.dialogueById);
    if (fact) parts.push(`must show: ${fact}`);
  }
  for (const item of input.panel.mustNotShow) {
    const fact = stripDialogueFromVisualFact(item.description, input.dialogueById);
    if (fact) parts.push(`must not show: ${fact}`);
  }
  parts.push("one coherent moment, single concrete scene, clearly recognizable subjects, consistent character design");
  return parts.filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
}

/**
 * ネームポーズレイヤの深度ヒント: 深度差のある2人以上のコマにだけ中立の1フレーズを足す
 * (Docs/Feature-NamePoseLayer.md。キャラ名・否定語なし = v3規約維持)。
 */
function depthStagingHint(panel: PanelSpec): string | null {
  const poses = panel.castPoses ?? [];
  if (poses.length < 2) return null;
  const depths = new Set(poses.map((pose) => pose.depth));
  if (depths.size < 2) return null;
  return "clear foreground and background separation between overlapping figures";
}

/**
 * Compiles visual facts only. Dialogue wording remains in the lettering layer and is represented
 * here as speech act / mouth state, preventing diffusion models from trying to draw the script.
 */
export function compilePanelPrompt(input: {
  panel: PanelSpec;
  basePrompt: string;
  entities: NarrativeEntity[];
  dialogueById: Map<string, StoryGraphDialogueInput>;
  /** LLM-directed fields are English, while NarrativeGraph identity labels may remain source-language. */
  narrativeMetadata?: "append" | "english-directed" | "base-only";
}): string {
  if (input.narrativeMetadata === "base-only") {
    return compileProvidedVisualFacts(input);
  }
  if (input.narrativeMetadata === "english-directed") {
    const parts = [input.basePrompt.trim()];
    parts.push(
      `${input.panel.shot.size} shot`,
      input.panel.shot.angle || "eye-level angle",
      input.panel.shot.compositionIntent || "clear single-moment composition"
    );
    const directedDepthHint = depthStagingHint(input.panel);
    if (directedDepthHint) parts.push(directedDepthHint);
    for (const member of input.panel.cast) {
      const lineStates = member.speakingLineIds
        .map((lineId) => input.dialogueById.get(lineId))
        .filter((line): line is StoryGraphDialogueInput => Boolean(line))
        .map(speechAct);
      parts.push([
        `character in the ${regionName(member.bbox)}`,
        member.action,
        member.expression ? `${member.expression} expression` : "",
        member.pose || "",
        member.gazeTarget ? `looking toward ${member.gazeTarget}` : "",
        lineStates.join(", ")
      ].filter(Boolean).join(", "));
    }
    for (const prop of input.panel.props) {
      parts.push(`prop: ${prop.state}${prop.bbox ? ` in the ${regionName(prop.bbox)}` : ""}`);
    }
    if (input.panel.textSafeZones.length > 0) {
      // 「lettering」「speech」等の文字を指す語を positive へ書いてはいけない。
      // 蒸留モデル(CFG 1)は negative が効かないので、文字を指す語がそのまま
      // 「文字を描く」指示として働き、絵の中に偽文字と偽吹き出しが描き込まれる
      // (実測: 該当コマの候補 21/44 が偽文字で失格し、発生位置がこの余白指定と一致した)。
      // 余白の要求は「detail を置かない」という視覚的な言い方だけで表す。
      parts.push(`keep ${input.panel.textSafeZones.map(regionName).join(" and ")} free of detail, plain and uncluttered`);
    }
    if (input.panel.mustShow.length > 0) parts.push(`must show: ${input.panel.mustShow.map((item) => item.description).join("; ")}`);
    if (input.panel.mustNotShow.length > 0) parts.push(`must not show: ${input.panel.mustNotShow.map((item) => item.description).join("; ")}`);
    parts.push("one coherent moment, consistent character design, readable silhouettes");
    return parts.filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
  }
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity]));
  const parts: string[] = [input.basePrompt.trim()];
  const focal = entityById.get(input.panel.shot.focalSubjectId);
  parts.push(
    `${input.panel.shot.size} shot`,
    input.panel.shot.angle || "eye-level angle",
    input.panel.shot.compositionIntent || "clear single-moment composition"
  );
  const appendDepthHint = depthStagingHint(input.panel);
  if (appendDepthHint) parts.push(appendDepthHint);
  if (focal) parts.push(`focal subject: ${focal.name}`);

  for (const member of input.panel.cast) {
    const entity = entityById.get(member.characterId);
    const description = entity?.attributes.description?.trim();
    const lineStates = member.speakingLineIds
      .map((lineId) => input.dialogueById.get(lineId))
      .filter((line): line is StoryGraphDialogueInput => Boolean(line))
      .map(speechAct);
    parts.push(
      [
        `${entity?.name || member.characterId} in the ${regionName(member.bbox)}`,
        description || "",
        member.action,
        member.expression ? `${member.expression} expression` : "",
        member.pose || "",
        member.gazeTarget ? `looking toward ${member.gazeTarget}` : "",
        lineStates.join(", ")
      ]
        .filter(Boolean)
        .join(", ")
    );
  }
  for (const prop of input.panel.props) {
    const entity = entityById.get(prop.entityId);
    parts.push(`${entity?.name || prop.entityId}: ${prop.state}${prop.bbox ? ` in the ${regionName(prop.bbox)}` : ""}`);
  }
  if (input.panel.textSafeZones.length > 0) {
    parts.push(`leave ${input.panel.textSafeZones.map(regionName).join(" and ")} visually quiet for later lettering`);
  }
  if (input.panel.mustShow.length > 0) parts.push(`must show: ${input.panel.mustShow.map((item) => item.description).join("; ")}`);
  if (input.panel.mustNotShow.length > 0) parts.push(`must not show: ${input.panel.mustNotShow.map((item) => item.description).join("; ")}`);
  parts.push("one coherent moment, consistent character design, readable silhouettes");
  return parts.filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
}

interface PanelConditioningInput {
  panel: PanelSpec;
  basePrompt: string;
  entities: NarrativeEntity[];
  dialogueById: Map<string, StoryGraphDialogueInput>;
  narrativeMetadata?: "append" | "english-directed" | "base-only";
  dialect?: PromptDialect;
  qualityTags?: string;
  negativeBase?: string;
  maxTerms?: number;
  sceneBible?: { set: string; lighting: string; palette: string };
  referenceAppearances?: ReferenceSetSnapshot[];
}

/**
 * このコマのプロンプトから消すべき人物ラベル。
 *
 * 対象は2種類ある。
 *
 * 1. `mustNotShow` で明示的に不在指定された人物。
 * 2. **このコマのキャストに入っていない人物すべて。**
 *
 * 2 が要る理由: シーンバイブルの `set` や `basePrompt` には、そのシーンの他のコマの
 * action 行が入り込む。action 行は「The elderly woman in a dark apron and round glasses …」の
 * ように人物の外見を含むので、そのコマに居ない人物の描写がプロンプトへ残る。
 * 蒸留モデル(CFG 1)では negative prompt が効かないため、残った描写はそのまま絵に出る
 * ——実測では単独コマの主人公に別人物の丸眼鏡が付き、人物が2体に複製された。
 *
 * キャストが空のコマ(小道具・背景のみ)は人物描写を一切残さない。
 */
function excludedIdentityLabels(input: Pick<PanelConditioningInput, "panel" | "entities">): string[] {
  const excludedIds = new Set(input.panel.mustNotShow
    .filter((constraint) => constraint.kind === "entity-absent" && constraint.entityId)
    .map((constraint) => constraint.entityId!));
  const presentIds = new Set(input.panel.cast.map((member) => member.characterId));
  return input.entities
    .filter((entity) =>
      excludedIds.has(entity.id) ||
      (entity.kind === "character" && !presentIds.has(entity.id)))
    .flatMap((entity) => [entity.name, ...entity.aliases]);
}

/**
 * ぶち抜き立ち絵スロット(Docs/Reference-MangaCompositions.md)の条件付け。シーンバイブル・
 * 文字用余白などのシーン都合は使わず、単独人物の全身立ち姿を「無地の白背景」で生成させる。
 * 白背景は候補採用時の背景除去(縁フラッドフィル)の成立条件なので positive で強制し、
 * 背景描写に働く語は negative へ移す。
 */
function compileFigureConditioning(input: PanelConditioningInput): PanelConditioning {
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity]));
  const member = input.panel.cast[0];
  const entity = member ? entityById.get(member.characterId) : undefined;
  const variant = member ? entity?.variants.find((item) => item.id === member.variantId) : undefined;
  const identity = [entity?.attributes.tags || entity?.attributes.description, variant?.attributes.tags || variant?.attributes.description]
    .filter((value): value is string => Boolean(value?.trim()) && !/[぀-ヿ㐀-鿿]/u.test(value!));
  const approvedAppearances = (input.referenceAppearances ?? []).flatMap((reference) => [
    reference.appearancePromptEn,
    reference.mustNotChange.length > 0 ? `identity invariants: ${reference.mustNotChange.join(", ")}` : ""
  ]).filter(Boolean);
  const quality = input.qualityTags?.trim() || "masterpiece, best quality, high detail";
  const excludedLabels = excludedIdentityLabels(input);
  const parts = [
    quality,
    "solo",
    ...approvedAppearances,
    ...identity,
    "full body, standing figure, head to toe in frame",
    member?.action ?? "",
    member?.expression ? `${member.expression} expression` : "",
    member?.pose ?? "",
    tagSafeVisual(input.basePrompt),
    "simple background, plain white background"
  ];
  const maxTerms = Math.max(12, input.maxTerms ?? 75);
  const joined = parts
    .flatMap((part) => {
      const safe = stripClausesContainingCharacterLabels(part ?? "", excludedLabels);
      return (input.dialect === "tags" ? tagSafeVisual(safe) : safe).split(/\s*,\s*|\.\s+/);
    })
    .filter(Boolean)
    .slice(0, maxTerms)
    .join(input.dialect === "tags" ? ", " : ". ");
  const monochrome = isMonochromeStyle(input.basePrompt, input.qualityTags);
  const positive = monochrome ? neutralizeColorLanguage(joined) : joined;
  const moved = input.panel.mustNotShow.map((item) => item.description).filter(Boolean);
  return {
    positive,
    negative: [
      monochrome ? MONOCHROME_NEGATIVE : "",
      // QUALITY_NEGATIVE は常に含める。テンプレートの negativeBase は**追加**であって置換ではない。
      // 置換にすると、モデル固有の語を足したつもりで extra limbs / bad anatomy 等の
      // 基本語が落ち、人物の複製や解剖の破綻を抑えられなくなる(実測で発生した)。
      QUALITY_NEGATIVE,
      input.negativeBase?.trim() || "",
      TEXT_NEGATIVE,
      "detailed background, scenery, indoor, outdoor, cropped legs, cropped feet, out of frame",
      ...moved
    ].filter(Boolean).join(", ")
  };
}

/** v3 conditioning contract: exclusions never enter positive conditioning. */
export function compilePanelConditioning(input: PanelConditioningInput): PanelConditioning {
  // ぶち抜き立ち絵スロットはシーン描写ではなく人物切り抜き前提の専用条件付けへ分岐する。
  if (input.panel.role === "figure") {
    return compileFigureConditioning(input);
  }
  const cleanPanel = { ...input.panel, mustNotShow: [] };
  const raw = compilePanelPrompt({ ...input, panel: cleanPanel });
  const excludedLabels = excludedIdentityLabels(input);
  const naturalRaw = stripClausesContainingCharacterLabels(raw, excludedLabels);
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity]));
  const entityDescriptions = (member: PanelSpec["cast"][number]): string[] => {
    const entity = entityById.get(member.characterId);
    const variant = entity?.variants.find((item) => item.id === member.variantId);
    return [entity?.attributes.tags || entity?.attributes.description, variant?.attributes.tags || variant?.attributes.description]
      .filter((value): value is string => Boolean(value?.trim()) && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(value!));
  };
  const referenceClauses = (reference: ReferenceSetSnapshot): string[] => [
    reference.appearancePromptEn,
    reference.mustNotChange.length > 0 ? `identity invariants: ${reference.mustNotChange.join(", ")}` : ""
  ].filter(Boolean);

  // \u8907\u6570\u4eba\u304c\u5199\u308b\u30b3\u30de\u3067\u306f\u3001\u5916\u898b\u53e5\u3092**\u305d\u306e\u4eba\u7269\u306e\u9818\u57df\u306b\u7d50\u3073\u4ed8\u3051\u308b**\u3002
  //
  // \u5e73\u5766\u306b\u9023\u7d50\u3059\u308b\u3068\u3001\u30e2\u30c7\u30eb\u306f\u3069\u306e\u7279\u5fb4\u304c\u8ab0\u306e\u3082\u306e\u304b\u5224\u5225\u3067\u304d\u305a\u5c5e\u6027\u304c\u79fb\u308b
  // (\u5b9f\u6e2c: \u8001\u4eba\u3068\u82e5\u8005\u304c\u540c\u5c45\u3059\u308b\u30b3\u30de\u306e 4/4 \u3067\u3001\u8001\u4eba\u306e\u4e38\u773c\u93e1\u304c\u82e5\u8005\u306e\u9854\u306b\u4ed8\u304d\u3001
  // \u3046\u30612\u679a\u3067\u306f\u8001\u4eba\u81ea\u8eab\u304c\u6d88\u3048\u305f)\u3002\u3057\u304b\u3082 positive \u306f\u6700\u5f8c\u306b\u30ab\u30f3\u30de\u3067\u5206\u5272\u3055\u308c\u308b\u306e\u3067\u3001
  // \u300c\u9818\u57df: \u7279\u5fb4, \u7279\u5fb4\u300d\u3068\u66f8\u3044\u3066\u3082\u5206\u5272\u3067\u7d50\u3073\u4ed8\u304d\u304c\u5207\u308c\u308b\u3002**\u5206\u5272\u3055\u308c\u306a\u30441\u8a9e**\u306b
  // \u307e\u3068\u3081\u308b\u5fc5\u8981\u304c\u3042\u308b\u305f\u3081\u3001\u30ab\u30f3\u30de\u3092 with \u306b\u7f6e\u304d\u63db\u3048\u3066\u9818\u57df\u540d\u3092\u982d\u306b\u636e\u3048\u308b\u3002
  const multiCast = input.panel.cast.length >= 2;
  const bindToRegion = (region: string, clauses: string[]): string => {
    const terms = clauses.join(", ").split(/\s*,\s*/).map((term) => term.trim()).filter(Boolean);
    if (terms.length === 0) return "";
    const [head, ...rest] = terms;
    return rest.length === 0 ? `${head} in the ${region}` : `${head} in the ${region} with ${rest.join(" with ")}`;
  };
  const referencesByCharacter = new Map<string, ReferenceSetSnapshot[]>();
  for (const reference of input.referenceAppearances ?? []) {
    const list = referencesByCharacter.get(reference.characterId) ?? [];
    list.push(reference);
    referencesByCharacter.set(reference.characterId, list);
  }
  const boundAppearances = multiCast
    ? input.panel.cast.map((member) => bindToRegion(regionName(member.bbox), [
        ...(referencesByCharacter.get(member.characterId) ?? []).flatMap(referenceClauses),
        ...entityDescriptions(member)
      ])).filter(Boolean)
    : [];
  const identities = multiCast ? [] : input.panel.cast.flatMap(entityDescriptions);
  const approvedAppearances = multiCast
    ? boundAppearances
    : (input.referenceAppearances ?? []).flatMap(referenceClauses);
  const quality = input.qualityTags?.trim() || "masterpiece, best quality, high detail";
  const scene = input.sceneBible ? [input.sceneBible.set, input.sceneBible.lighting, input.sceneBible.palette] : [];
  // 背景を明示する。人物だけを指定して背景が白紙のままだと、モデルは余白を埋めるために
  // **被写体をもう1体描く**(実測: 顔・手のクローズアップが続くキャラのコマで 12/12 が
  // 「同一人物を並べた設定表」になり、背景句を1つ足しただけで単独に戻った)。
  // 舞台の記述は plan の settingId にあるのに、これまでプロンプトへ展開されていなかった。
  //
  // ただし**寄りのコマに部屋の目録を丸ごと入れてはいけない**。実測: 壁際で刷毛を止める手の
  // クローズアップに「洗い場の列・鏡・蛇口・浴槽・壁画」まで注入され、4候補とも洗い場の
  // 引きの絵になって指定の動作が消えた。クローズアップに部屋全体は物理的に入らないので、
  // 背景の粒度をショットサイズに合わせて削る。
  //
  // **切り詰めは先頭から採るので、舞台記述は「大事な句を先に」書く契約になる。**
  // これを知らずに書くと寄りのコマで肝心の要素が落ちる(実測: 壁画の状態が5番目の句に
  // あり、そこが要のコマ8つ中5つで消えていた)。物語の中で変化する要素ほど前に置くこと。
  const settingEntity = entityById.get(input.panel.settingId);
  const settingDescription = (settingEntity?.attributes.tags || settingEntity?.attributes.description || "").trim();
  const settingClauses = settingDescription.split(/\s*,\s*/).map((clause) => clause.trim()).filter(Boolean);
  const backgroundClauseLimit = ({ "insert": 1, "close-up": 1, "medium": 3 } as Record<string, number>)[input.panel.shot.size]
    ?? settingClauses.length;
  const scopedSetting = settingClauses.slice(0, backgroundClauseLimit).join(", ");
  const background = scopedSetting && !/[぀-ヿ㐀-鿿]/u.test(scopedSetting)
    ? [`${scopedSetting} filling the background`, "no empty background"]
    : ["detailed background filling the frame", "no empty background"];
  const castCount = input.panel.cast.length === 0 ? "" : input.panel.cast.length === 1 ? "1character" : `${input.panel.cast.length}characters`;
  // 小道具は tags 方言でも出す。自然文方言だけが `prop:` を書いていて、
  // **タグモデル向けにコマの props を書いても黙って捨てられていた**。
  // 位置が指定されていればその領域も添える(人物の外見と同じで、置き場所が要る)。
  const props = input.panel.props.map((prop) => {
    const state = (prop.state ?? "").trim();
    if (!state) return "";
    return prop.bbox ? `${state} in the ${regionName(prop.bbox)}` : state;
  }).filter(Boolean);
  const positiveParts = input.dialect === "tags"
    ? [quality, castCount, ...approvedAppearances, ...identities,
        `${input.panel.shot.size} shot`, input.panel.shot.angle, ...input.panel.cast.flatMap((member) => [member.action, member.expression]), ...props, ...scene, ...background, input.basePrompt]
        .map((part) => tagSafeVisual(stripClausesContainingCharacterLabels(part ?? "", excludedLabels)))
    : [naturalRaw, ...approvedAppearances, ...identities, ...background, ...scene.map((part) => stripClausesContainingCharacterLabels(part, excludedLabels))];
  const maxTerms = Math.max(12, input.maxTerms ?? 75);
  const joined = positiveParts.flatMap((part) => part?.split(/\s*,\s*|\.\s+/) ?? []).filter(Boolean).slice(0, maxTerms).join(input.dialect === "tags" ? ", " : ". ");
  const monochrome = isMonochromeStyle(input.basePrompt, input.qualityTags);
  const positive = monochrome ? neutralizeColorLanguage(joined) : joined;
  const moved = input.panel.mustNotShow.map((item) => item.description).filter(Boolean);
  return {
    positive,
    negative: [
      QUALITY_NEGATIVE,
      input.negativeBase?.trim() || "",
      TEXT_NEGATIVE,
      monochrome ? MONOCHROME_NEGATIVE : "",
      ...moved
    ].filter(Boolean).join(", ")
  };
}
