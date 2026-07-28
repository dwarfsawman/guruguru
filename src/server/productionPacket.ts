/**
 * Production packet の取り込み(Docs/Reference-ProductionPacket.md)。
 *
 * パケットは上流の作品管理ツール(Character Garage 等)が書き出す、versionつきの
 * ディレクトリである。GURUGURU は相手の内部DB・内部保存形式を一切知らず、
 * `packet.json` の公開フォーマットだけに依存する。
 *
 * 取り込み前に必ず検証する。`kind` と `formatVersion`、同梱ファイルの実在、
 * 記録された長さと SHA-256、そしてマニフェスト内パスがパケット外を指していないこと。
 * 1つでも合わなければ何も書き込まない(fail-closed)。
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { getRow, runSql } from "./db";
import { HttpError } from "./http";
import { isPathInside } from "./paths";
import { createProject } from "./projects";
import { addScriptRevision, createScript } from "./scripts";
import { ensureProjectStorage } from "./storage";
import { objectBody, requiredString, stringOr } from "./validate";
import { createCharacter, listCharacters, updateCharacter } from "./characters";

/** このビルドが取り込めるパケット形式。 */
export const SUPPORTED_PACKET_FORMAT_VERSION = 1;
export const PACKET_KIND = "manga-production-packet";
export const PACKET_MANIFEST_FILE = "packet.json";

export interface PacketFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PacketArc {
  want: string;
  need: string;
  flaw: string;
  startState: string;
  turn: string;
  endState: string;
}

export interface PacketCastMember {
  name: string;
  displayName: string;
  aliases: string[];
  profile: string;
  arc: PacketArc;
  outfits: Array<{ scene: string; description: string; referenceImage?: PacketFile }>;
  referenceImages: PacketFile[];
}

export interface PacketManifest {
  formatVersion: number;
  kind: string;
  generator: { name: string; version: string };
  generatedAtMs: number;
  source: { workId: string; episodeId: string };
  work: { title: string; description: string };
  episode: { number: number; title: string; summary: string };
  storyBible: {
    logline: string;
    theme: string;
    premise: string;
    tone: string;
    ending: string;
    audience: string;
    notes: string;
    settings: Array<{ name: string; description: string; significance: string }>;
  };
  cast: PacketCastMember[];
  relationships: Array<{ from: string; to: string; kind: string; description: string; directed: boolean }>;
  outline: {
    beats: Array<{ name: string; summary: string; function: string; characters: string[]; setting?: string }>;
    pages: Array<{ number: number; summary: string; beats: string[]; turnNote: string }>;
  };
  script?: PacketFile;
  loras: Array<{ character: string; name: string; bytes: number; bundled: boolean }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new HttpError(400, `Production packet is invalid: ${message}`);
}

/** マニフェスト内の相対パスをパケット直下へ安全に解決する。 */
function resolvePacketPath(packetDir: string, relativePath: string): string {
  if (typeof relativePath !== "string" || !relativePath) {
    invalid("a bundled file has an empty path");
  }
  if (isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    invalid(`bundled path must be relative: ${relativePath}`);
  }
  const normalized = normalize(relativePath);
  if (normalized.split(/[\\/]/).includes("..")) {
    invalid(`bundled path escapes the packet: ${relativePath}`);
  }
  const resolved = resolve(join(packetDir, normalized));
  if (!isPathInside(resolved, resolve(packetDir))) {
    invalid(`bundled path escapes the packet: ${relativePath}`);
  }
  return resolved;
}

function parsePacketFile(value: unknown, label: string): PacketFile {
  if (!isRecord(value)) invalid(`${label} is not an object`);
  const path = value.path;
  const bytes = value.bytes;
  const sha256 = value.sha256;
  if (typeof path !== "string" || !path) invalid(`${label}.path is missing`);
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) invalid(`${label}.bytes is missing`);
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) invalid(`${label}.sha256 is not a SHA-256 digest`);
  return { path, bytes, sha256 };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * `packet.json` を読み、構造・バージョン・同梱ファイルの完全性を検証して返す。
 * 取り込み側は必ずこれを通してから書き込む。
 */
export function readPacket(packetDir: string): PacketManifest {
  const manifestPath = join(packetDir, PACKET_MANIFEST_FILE);
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new HttpError(400, `Production packet is invalid: ${PACKET_MANIFEST_FILE} was not found in ${packetDir}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    invalid(`${PACKET_MANIFEST_FILE} is not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(parsed)) invalid(`${PACKET_MANIFEST_FILE} is not an object`);

  if (parsed.kind !== PACKET_KIND) {
    invalid(`kind is ${JSON.stringify(parsed.kind)}, expected ${JSON.stringify(PACKET_KIND)}`);
  }
  if (parsed.formatVersion !== SUPPORTED_PACKET_FORMAT_VERSION) {
    invalid(
      `formatVersion ${String(parsed.formatVersion)} is not supported (this build reads ${SUPPORTED_PACKET_FORMAT_VERSION})`
    );
  }

  const episode = isRecord(parsed.episode) ? parsed.episode : invalid("episode is missing");
  const episodeNumber = episode.number;
  if (typeof episodeNumber !== "number" || !Number.isInteger(episodeNumber) || episodeNumber < 1) {
    invalid("episode.number must be a positive integer");
  }
  const work = isRecord(parsed.work) ? parsed.work : invalid("work is missing");
  if (!stringField(work.title).trim()) invalid("work.title is empty");
  const source = isRecord(parsed.source) ? parsed.source : invalid("source is missing");
  if (!stringField(source.workId) || !stringField(source.episodeId)) {
    invalid("source.workId and source.episodeId are required");
  }

  const bible = isRecord(parsed.storyBible) ? parsed.storyBible : {};
  const outline = isRecord(parsed.outline) ? parsed.outline : {};

  const cast: PacketCastMember[] = (Array.isArray(parsed.cast) ? parsed.cast : []).map((entry, index) => {
    if (!isRecord(entry)) invalid(`cast[${index}] is not an object`);
    const name = stringField(entry.name).trim();
    if (!name) invalid(`cast[${index}].name is empty`);
    const arc = isRecord(entry.arc) ? entry.arc : {};
    return {
      name,
      displayName: stringField(entry.displayName).trim() || name,
      aliases: stringArray(entry.aliases),
      profile: stringField(entry.profile),
      arc: {
        want: stringField(arc.want),
        need: stringField(arc.need),
        flaw: stringField(arc.flaw),
        startState: stringField(arc.startState),
        turn: stringField(arc.turn),
        endState: stringField(arc.endState)
      },
      outfits: (Array.isArray(entry.outfits) ? entry.outfits : []).map((outfit, outfitIndex) => {
        if (!isRecord(outfit)) invalid(`cast[${index}].outfits[${outfitIndex}] is not an object`);
        return {
          scene: stringField(outfit.scene),
          description: stringField(outfit.description),
          referenceImage:
            outfit.referenceImage === undefined
              ? undefined
              : parsePacketFile(outfit.referenceImage, `cast[${index}].outfits[${outfitIndex}].referenceImage`)
        };
      }),
      referenceImages: (Array.isArray(entry.referenceImages) ? entry.referenceImages : []).map((file, fileIndex) =>
        parsePacketFile(file, `cast[${index}].referenceImages[${fileIndex}]`)
      )
    };
  });

  const seenNames = new Set<string>();
  for (const member of cast) {
    const key = member.name.trim().toLowerCase();
    if (seenNames.has(key)) invalid(`cast contains ${JSON.stringify(member.name)} more than once`);
    seenNames.add(key);
  }

  const script = parsed.script === undefined || parsed.script === null ? undefined : parsePacketFile(parsed.script, "script");

  const manifest: PacketManifest = {
    formatVersion: SUPPORTED_PACKET_FORMAT_VERSION,
    kind: PACKET_KIND,
    generator: {
      name: isRecord(parsed.generator) ? stringField(parsed.generator.name) : "",
      version: isRecord(parsed.generator) ? stringField(parsed.generator.version) : ""
    },
    generatedAtMs: typeof parsed.generatedAtMs === "number" ? parsed.generatedAtMs : 0,
    source: { workId: stringField(source.workId), episodeId: stringField(source.episodeId) },
    work: { title: stringField(work.title), description: stringField(work.description) },
    episode: {
      number: episodeNumber,
      title: stringField(episode.title),
      summary: stringField(episode.summary)
    },
    storyBible: {
      logline: stringField(bible.logline),
      theme: stringField(bible.theme),
      premise: stringField(bible.premise),
      tone: stringField(bible.tone),
      ending: stringField(bible.ending),
      audience: stringField(bible.audience),
      notes: stringField(bible.notes),
      settings: (Array.isArray(bible.settings) ? bible.settings : [])
        .filter(isRecord)
        .map((setting) => ({
          name: stringField(setting.name),
          description: stringField(setting.description),
          significance: stringField(setting.significance)
        }))
    },
    cast,
    relationships: (Array.isArray(parsed.relationships) ? parsed.relationships : []).filter(isRecord).map((entry) => ({
      from: stringField(entry.from),
      to: stringField(entry.to),
      kind: stringField(entry.kind),
      description: stringField(entry.description),
      directed: entry.directed !== false
    })),
    outline: {
      beats: (Array.isArray(outline.beats) ? outline.beats : []).filter(isRecord).map((beat) => ({
        name: stringField(beat.name),
        summary: stringField(beat.summary),
        function: stringField(beat.function),
        characters: stringArray(beat.characters),
        setting: typeof beat.setting === "string" ? beat.setting : undefined
      })),
      pages: (Array.isArray(outline.pages) ? outline.pages : []).filter(isRecord).map((page) => ({
        number: typeof page.number === "number" ? page.number : 0,
        summary: stringField(page.summary),
        beats: stringArray(page.beats),
        turnNote: stringField(page.turnNote)
      }))
    },
    script,
    loras: (Array.isArray(parsed.loras) ? parsed.loras : []).filter(isRecord).map((lora) => ({
      character: stringField(lora.character),
      name: stringField(lora.name),
      bytes: typeof lora.bytes === "number" ? lora.bytes : 0,
      bundled: lora.bundled === true
    }))
  };

  verifyBundledFiles(packetDir, manifest);
  return manifest;
}

/** マニフェストが宣言した同梱ファイルすべて。 */
export function bundledFiles(manifest: PacketManifest): PacketFile[] {
  const files: PacketFile[] = [];
  if (manifest.script) {
    files.push(manifest.script);
  }
  for (const member of manifest.cast) {
    files.push(...member.referenceImages);
    for (const outfit of member.outfits) {
      if (outfit.referenceImage) {
        files.push(outfit.referenceImage);
      }
    }
  }
  return files;
}

function verifyBundledFiles(packetDir: string, manifest: PacketManifest) {
  for (const file of bundledFiles(manifest)) {
    const resolved = resolvePacketPath(packetDir, file.path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolved);
    } catch {
      invalid(`bundled file is missing: ${file.path}`);
    }
    if (bytes.length !== file.bytes) {
      invalid(`${file.path}: size mismatch (manifest ${file.bytes}, file ${bytes.length})`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256) {
      invalid(`${file.path}: checksum mismatch`);
    }
  }
}

/**
 * ネーム監督・prompt compiler へ渡す人物固定記述を組み立てる。
 * パケットの外見記述を正とし、アークは prompt ではなく演出判断の材料として添える。
 */
export function buildCharacterBible(manifest: PacketManifest): string {
  const lines: string[] = [];
  for (const member of manifest.cast) {
    const parts = [member.profile.trim()].filter(Boolean);
    const outfits = member.outfits
      .filter((outfit) => outfit.description.trim())
      .map((outfit) => (outfit.scene.trim() ? `${outfit.scene}: ${outfit.description}` : outfit.description));
    if (outfits.length) {
      parts.push(`衣装差分 — ${outfits.join(" / ")}`);
    }
    lines.push(`${member.name}: ${parts.join(" / ") || "(外見未記入)"}`);
  }
  return lines.join("\n");
}

/** 取り込んだパケットの物語文脈。project に保存し、後続の run 設定に使う。 */
export interface StoryContext {
  packetFormatVersion: number;
  generator: { name: string; version: string };
  source: { workId: string; episodeId: string };
  importedAt: string;
  work: PacketManifest["work"];
  episode: PacketManifest["episode"];
  storyBible: PacketManifest["storyBible"];
  relationships: PacketManifest["relationships"];
  outline: PacketManifest["outline"];
  arcs: Array<{ name: string; arc: PacketArc }>;
  loras: PacketManifest["loras"];
  characterBible: string;
  referenceImages: Array<{ character: string; storedPath: string; sourcePath: string; sha256: string }>;
}

export function getStoryContext(projectId: string): StoryContext | null {
  const row = getRow<{ story_context_json: string | null }>("SELECT story_context_json FROM projects WHERE id = ?", [
    projectId
  ]);
  if (!row) {
    throw new HttpError(404, "Project was not found");
  }
  if (!row.story_context_json) {
    return null;
  }
  try {
    return JSON.parse(row.story_context_json) as StoryContext;
  } catch {
    return null;
  }
}

export interface PacketImportResult {
  projectId: string;
  projectCreated: boolean;
  scriptId: string | null;
  scriptRevision: number | null;
  charactersCreated: number;
  charactersUpdated: number;
  referenceImagesCopied: number;
  characterBible: string;
  warnings: string[];
  manifest: {
    formatVersion: number;
    generator: PacketManifest["generator"];
    source: PacketManifest["source"];
    work: PacketManifest["work"];
    episode: PacketManifest["episode"];
    castCount: number;
    beatCount: number;
    pageCount: number;
  };
}

/**
 * `POST /api/production-packets/import`
 * `{ packetPath, projectId?, projectName? }`
 *
 * projectId 未指定なら Book プロジェクトを新規作成する。既存プロジェクトへ再取り込み
 * した場合、同じ source から作られた脚本があれば新しい revision を足す(既存の
 * 割り当て・吹き出しを壊さない)。
 */
export async function importProductionPacket(body: unknown): Promise<PacketImportResult> {
  const input = objectBody(body);
  const packetPath = requiredString(input.packetPath, "packetPath");
  const manifest = readPacket(packetPath);
  const warnings: string[] = [];

  let projectId = stringOr(input.projectId, "").trim();
  let projectCreated = false;
  if (projectId) {
    if (!getRow("SELECT id FROM projects WHERE id = ?", [projectId])) {
      throw new HttpError(404, "Project was not found");
    }
  } else {
    const name =
      stringOr(input.projectName, "").trim() ||
      `${manifest.work.title} 第${manifest.episode.number}話${manifest.episode.title ? ` ${manifest.episode.title}` : ""}`;
    const project = createProject({
      name,
      description: manifest.storyBible.logline || manifest.work.description,
      mode: "book"
    });
    if (!project) {
      throw new HttpError(500, "Failed to create a project for the packet");
    }
    projectId = project.id;
    projectCreated = true;
  }

  // --- キャラクター ---
  // 脚本より先に入れる。`createScript` は Fountain の話者表記から未知キャラクターを
  // 自動作成するため、後回しにするとパケットの正式名・別名・外見が付かないまま
  // 話者名だけのキャラクターが増える。
  let charactersCreated = 0;
  let charactersUpdated = 0;
  const existing = listCharacters(projectId);
  const byName = new Map(existing.map((character) => [character.name.trim().toLowerCase(), character]));

  for (const member of manifest.cast) {
    const notes = castNotes(member);
    // パケットは話ごとの表示名を持つ。GURUGURU 側の話者照合は Fountain の表記に
    // 合わせるため、表示名と正式名の両方を別名として持たせる。
    const aliases = Array.from(
      new Set([...member.aliases, member.displayName].map((alias) => alias.trim()).filter((alias) => alias && alias !== member.name))
    );
    const found = byName.get(member.name.trim().toLowerCase());
    if (found) {
      updateCharacter(found.id, { name: member.name, aliases, notes });
      charactersUpdated += 1;
    } else {
      createCharacter(projectId, { name: member.name, aliases, notes });
      charactersCreated += 1;
    }
  }

  // --- 脚本 ---
  let scriptId: string | null = null;
  let scriptRevision: number | null = null;
  if (manifest.script) {
    const fountainSource = readFileSync(resolvePacketPath(packetPath, manifest.script.path), "utf8");
    const previous = getStoryContext(projectId);
    const sameSource =
      previous?.source.workId === manifest.source.workId && previous?.source.episodeId === manifest.source.episodeId;
    const existingScript = sameSource
      ? getRow<{ id: string }>("SELECT id FROM manga_scripts WHERE project_id = ? ORDER BY created_at ASC LIMIT 1", [
          projectId
        ])
      : null;

    const title = manifest.episode.title || `第${manifest.episode.number}話`;
    const result = existingScript
      ? addScriptRevision(existingScript.id, { fountainSource })
      : createScript(projectId, { title, fountainSource });
    scriptId = result.script.id;
    scriptRevision = result.revision.revision;
    if (result.revision.warnings?.length) {
      warnings.push(...result.revision.warnings.map((warning) => `Fountain: ${warning}`));
    }
  } else {
    warnings.push("パケットに script.fountain がありません。ネーム作成前に脚本を取り込んでください。");
  }

  // --- 参照画像 ---
  // Reference Set は model family(Chroma/Anima)と承認が絡む GURUGURU 側の判断なので
  // ここでは作らない。画像だけをプロジェクト配下へ複製し、後で候補として使えるようにする。
  const storage = ensureProjectStorage(projectId);
  const packetAssetRoot = join(storage.projectRoot, "packet_assets");
  const referenceImages: StoryContext["referenceImages"] = [];
  for (const member of manifest.cast) {
    for (const file of member.referenceImages) {
      const source = resolvePacketPath(packetPath, file.path);
      const destination = resolve(join(packetAssetRoot, file.path.split("/").map(sanitizeSegment).join(sep)));
      if (!isPathInside(destination, resolve(storage.projectRoot))) {
        warnings.push(`参照画像を保存できませんでした(パス不正): ${file.path}`);
        continue;
      }
      mkdirSync(join(destination, ".."), { recursive: true });
      copyFileSync(source, destination);
      referenceImages.push({
        character: member.name,
        storedPath: destination,
        sourcePath: file.path,
        sha256: file.sha256
      });
    }
  }

  const characterBible = buildCharacterBible(manifest);
  const context: StoryContext = {
    packetFormatVersion: manifest.formatVersion,
    generator: manifest.generator,
    source: manifest.source,
    importedAt: new Date().toISOString(),
    work: manifest.work,
    episode: manifest.episode,
    storyBible: manifest.storyBible,
    relationships: manifest.relationships,
    outline: manifest.outline,
    arcs: manifest.cast.map((member) => ({ name: member.name, arc: member.arc })),
    loras: manifest.loras,
    characterBible,
    referenceImages
  };
  runSql("UPDATE projects SET story_context_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    JSON.stringify(context),
    projectId
  ]);

  if (manifest.loras.some((lora) => !lora.bundled)) {
    warnings.push(
      "パケットは LoRA をファイル名だけで参照しています。ComfyUI 側に同名の LoRA を用意してから生成してください。"
    );
  }

  return {
    projectId,
    projectCreated,
    scriptId,
    scriptRevision,
    charactersCreated,
    charactersUpdated,
    referenceImagesCopied: referenceImages.length,
    characterBible,
    warnings,
    manifest: {
      formatVersion: manifest.formatVersion,
      generator: manifest.generator,
      source: manifest.source,
      work: manifest.work,
      episode: manifest.episode,
      castCount: manifest.cast.length,
      beatCount: manifest.outline.beats.length,
      pageCount: manifest.outline.pages.length
    }
  };
}

/** キャラクターの notes。外見を先頭に置き、アークは演出メモとして続ける。 */
function castNotes(member: PacketCastMember): string {
  const lines: string[] = [];
  if (member.profile.trim()) {
    lines.push(member.profile.trim());
  }
  const arcLabels: Array<[keyof PacketArc, string]> = [
    ["want", "望み"],
    ["need", "内面的課題"],
    ["flaw", "欠点"],
    ["startState", "開始時"],
    ["turn", "変化"],
    ["endState", "終了時"]
  ];
  const arcLines = arcLabels
    .filter(([key]) => member.arc[key].trim())
    .map(([key, label]) => `${label}: ${member.arc[key].trim()}`);
  if (arcLines.length) {
    lines.push("", "[アーク]", ...arcLines);
  }
  const outfits = member.outfits.filter((outfit) => outfit.description.trim());
  if (outfits.length) {
    lines.push(
      "",
      "[衣装差分]",
      ...outfits.map((outfit) => (outfit.scene.trim() ? `${outfit.scene}: ${outfit.description}` : outfit.description))
    );
  }
  return lines.join("\n");
}

/** パケット内の相対パス断片をファイル名として安全な形に落とす。 */
function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[ -<>:"\\/|?*]/g, "_").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "_";
}

/** `GET /api/projects/:id/story-context` */
export function readStoryContext(projectId: string) {
  const context = getStoryContext(projectId);
  return { projectId, storyContext: context };
}

export const __testing = { resolvePacketPath, castNotes };
