/**
 * Fountain 脚本パーサ(Docs/Feature-ScriptToManga.md S3)。外部依存なしの純ロジック。
 * サポートするサブセット: Title Page / Scene Heading(INT./EXT./EST. + 強制 `.`)/ Action /
 * Character cue(大文字行 + 強制 `@`)/ Parenthetical `()` / Dialogue / Dual dialogue `^`(単一化) /
 * Transition(`>` / `TO:`) / Section `#` / Synopsis `=` / Note `[[ ]]`(保持) / Boneyard `/* *​/`(除去)。
 *
 * 日本語対応が本命: 強制 `@キャラ名` を正とし、`@` 無しの日本語話者行は「次行が空行でない非 heading 行」
 * なら character cue とみなす寛容モード(誤検出は Action へフォールバック)。false positive を減らすため、
 * 候補行は短く(<=20文字)・文末句読点を含まない行に限定している(実装上の判断。過度な誤検出を避けるため)。
 *
 * fail-loud 寄り: 空の話者名・空の台詞本文などは黙殺せず `warnings` に積む。
 */

export interface FountainActionElement {
  type: "action";
  text: string;
}

export interface FountainDialogueElement {
  type: "dialogue";
  speaker: string;
  /** 話者直後の `(...)` 行(先頭1個のみ捕捉)。`(M)`/`(N)` 等の意味付けは import 側(scripts.ts)が行う。 */
  parenthetical?: string;
  text: string;
}

export interface FountainTransitionElement {
  type: "transition";
  text: string;
}

export interface FountainSectionElement {
  type: "section";
  depth: number;
  text: string;
}

export interface FountainSynopsisElement {
  type: "synopsis";
  text: string;
}

export type FountainElement =
  | FountainActionElement
  | FountainDialogueElement
  | FountainTransitionElement
  | FountainSectionElement
  | FountainSynopsisElement;

export interface FountainScene {
  heading: string;
  elements: FountainElement[];
}

export interface FountainDoc {
  titlePage: Record<string, string>;
  scenes: FountainScene[];
}

export interface FountainParseResult {
  doc: FountainDoc;
  warnings: string[];
}

/** Boneyard `/* ... *​/`(複数行可)を丸ごと除去する。Note `[[ ... ]]` はここでは剥がさず本文に残す(保持)。 */
function stripBoneyard(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

const TITLE_KEY_RE = /^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/;

/** 先頭のタイトルページ(`Key: Value` 連続行、インデント継続行あり)を読み、本文の開始行 index を返す。 */
function parseTitlePage(lines: string[], titlePage: Record<string, string>): number {
  let i = 0;
  if (i >= lines.length || !TITLE_KEY_RE.test(lines[i]!)) {
    return 0;
  }
  let lastKey: string | null = null;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      break;
    }
    const match = TITLE_KEY_RE.exec(line);
    if (match) {
      lastKey = match[1]!.trim();
      titlePage[lastKey] = match[2]!.trim();
      i += 1;
      continue;
    }
    if (/^\s+/.test(line) && lastKey) {
      titlePage[lastKey] = `${titlePage[lastKey]}\n${line.trim()}`.trim();
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function matchSceneHeading(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (trimmed.startsWith(".") && !trimmed.startsWith("..")) {
    const heading = trimmed.slice(1).trim();
    return heading || null;
  }
  if (/^(INT|EXT|EST|INT\.\/EXT|I\/E)[.\s]/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function matchTransition(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (trimmed.startsWith(">") && !trimmed.endsWith("<")) {
    const text = trimmed.slice(1).trim();
    return text || null;
  }
  if (/^[A-Z0-9 .'-]+TO:$/.test(trimmed) && /[A-Z]/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function matchSection(trimmed: string): { depth: number; text: string } | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(trimmed);
  if (!match) {
    return null;
  }
  return { depth: match[1]!.length, text: match[2]!.trim() };
}

function matchSynopsis(trimmed: string): string | null {
  const match = /^=(?!==)\s*(.*)$/.exec(trimmed);
  return match ? match[1]!.trim() : null;
}

function isHeadingLikeLine(trimmed: string): boolean {
  return (
    matchSceneHeading(trimmed) !== null ||
    matchSection(trimmed) !== null ||
    matchSynopsis(trimmed) !== null ||
    matchTransition(trimmed) !== null
  );
}

/** 英語 Fountain の自然な character cue 判定: 全て大文字(拡張の `(V.O.)` 等は無視)。 */
function isAllCapsCue(trimmed: string): boolean {
  if (!trimmed) {
    return false;
  }
  const withoutExtension = trimmed.replace(/\(.*?\)\s*$/, "").trim();
  if (!withoutExtension || !/[A-Z]/.test(withoutExtension)) {
    return false;
  }
  return withoutExtension === withoutExtension.toUpperCase() && !/[a-z]/.test(withoutExtension);
}

/** 日本語寛容モードの候補行(短く、文末句読点を含まない、他要素の見た目でない)。 */
function isLenientCueCandidate(trimmed: string): boolean {
  if (!trimmed || trimmed.length > 20) {
    return false;
  }
  if (/[。.!?、,]/.test(trimmed)) {
    return false;
  }
  if (/^[#=@>(]/.test(trimmed)) {
    return false;
  }
  if (isHeadingLikeLine(trimmed)) {
    return false;
  }
  return true;
}

export function parseFountain(source: string): FountainParseResult {
  const warnings: string[] = [];
  const stripped = stripBoneyard(source);
  const rawLines = stripped.replace(/\r\n/g, "\n").split("\n");

  const titlePage: Record<string, string> = {};
  const startIndex = parseTitlePage(rawLines, titlePage);

  const scenes: FountainScene[] = [];
  let currentScene: FountainScene = { heading: "", elements: [] };

  function pushScene() {
    if (currentScene.heading || currentScene.elements.length > 0) {
      scenes.push(currentScene);
    }
  }

  let actionBuffer: string[] = [];
  function flushAction() {
    if (actionBuffer.length > 0) {
      currentScene.elements.push({ type: "action", text: actionBuffer.join("\n") });
      actionBuffer = [];
    }
  }

  for (let i = startIndex; i < rawLines.length; i += 1) {
    const line = rawLines[i]!;
    const trimmed = line.trim();
    if (trimmed === "") {
      flushAction();
      continue;
    }

    const heading = matchSceneHeading(line);
    if (heading !== null) {
      flushAction();
      pushScene();
      currentScene = { heading, elements: [] };
      continue;
    }

    const section = matchSection(trimmed);
    if (section) {
      flushAction();
      currentScene.elements.push({ type: "section", depth: section.depth, text: section.text });
      continue;
    }

    const synopsis = matchSynopsis(trimmed);
    if (synopsis !== null) {
      flushAction();
      currentScene.elements.push({ type: "synopsis", text: synopsis });
      continue;
    }

    const transition = matchTransition(trimmed);
    if (transition !== null) {
      flushAction();
      currentScene.elements.push({ type: "transition", text: transition });
      continue;
    }

    let speaker: string | null = null;
    const forcedMatch = /^@(.*)$/.exec(trimmed);
    if (forcedMatch) {
      speaker = forcedMatch[1]!.trim();
    } else if (isAllCapsCue(trimmed)) {
      const next = rawLines[i + 1]?.trim() ?? "";
      if (next !== "" && !isHeadingLikeLine(next)) {
        speaker = trimmed;
      }
    } else if (isLenientCueCandidate(trimmed)) {
      const next = rawLines[i + 1]?.trim() ?? "";
      if (next !== "" && !isHeadingLikeLine(next)) {
        speaker = trimmed;
      }
    }

    if (speaker !== null) {
      // dual dialogue `^`: 単一化(通常の cue として扱う。並列表示は行わない)。
      if (speaker.endsWith("^")) {
        speaker = speaker.slice(0, -1).trim();
      }
      if (!speaker) {
        warnings.push(`${i + 1}行目: 話者名が空です。Action として扱いました。`);
        actionBuffer.push(line);
        continue;
      }

      flushAction();
      let parenthetical: string | undefined;
      const textLines: string[] = [];
      let j = i + 1;
      for (; j < rawLines.length; j += 1) {
        const dTrim = rawLines[j]!.trim();
        if (dTrim === "" || isHeadingLikeLine(dTrim)) {
          break;
        }
        const parenMatch = /^\((.*)\)$/.exec(dTrim);
        if (parenMatch && parenthetical === undefined && textLines.length === 0) {
          parenthetical = `(${parenMatch[1]})`;
          continue;
        }
        textLines.push(dTrim);
      }
      const text = textLines.join("\n");
      if (!text.trim()) {
        warnings.push(`${i + 1}行目: 「${speaker}」の台詞本文が空です。`);
      }
      const element: FountainDialogueElement = { type: "dialogue", speaker, text };
      if (parenthetical !== undefined) {
        element.parenthetical = parenthetical;
      }
      currentScene.elements.push(element);
      i = j - 1;
      continue;
    }

    actionBuffer.push(line);
  }
  flushAction();
  pushScene();

  if (scenes.length === 0) {
    scenes.push({ heading: "", elements: [] });
  }

  return { doc: { titlePage, scenes }, warnings };
}
