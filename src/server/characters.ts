/**
 * Character(Docs/Feature-ScriptToManga.md S3): 物語上の登場人物。Provider 中立の本体
 * (name/aliases/notes/color) と、Provider 別の AppearanceBinding(顔参照/LoRA 等)を分離する。
 * `pages.ts` が手本(ドメインロジック分離)。
 */
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Character, CharacterBindingView } from "../shared/apiTypes";
import { createId, dataRoot, getRow, getRows, runSql, toApiRow, toApiRows } from "./db";
import { streamFile } from "./files";
import { HttpError } from "./http";
import { isPathInside } from "./paths";
import { storeCharacterFaceImage } from "./storage";
import { decodeImageDataUrl } from "./uploadDataUrl";
import { objectBody, requiredString, stringOr } from "./validate";

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function requireProject(projectId: string) {
  const project = getRow("SELECT id FROM projects WHERE id = ?", [projectId]);
  if (!project) {
    throw new HttpError(404, "Project was not found");
  }
}

function requireCharacter(characterId: string): Character {
  const row = toApiRow(getRow("SELECT * FROM characters WHERE id = ?", [characterId])) as unknown as Character | null;
  if (!row) {
    throw new HttpError(404, "Character was not found");
  }
  return row;
}

function normalizeAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeColor(raw: unknown): string | null {
  return typeof raw === "string" && HEX_COLOR_RE.test(raw.trim()) ? raw.trim() : null;
}

export function listCharacters(projectId: string): Character[] {
  requireProject(projectId);
  const rows = getRows("SELECT * FROM characters WHERE project_id = ? ORDER BY created_at ASC", [projectId]);
  return toApiRows(rows) as unknown as Character[];
}

export function createCharacter(projectId: string, body: unknown): Character {
  requireProject(projectId);
  const input = objectBody(body);
  const name = requiredString(input.name, "name");
  const id = createId("char");
  runSql(
    `INSERT INTO characters (id, project_id, name, aliases_json, notes, color)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, projectId, name, JSON.stringify(normalizeAliases(input.aliases)), stringOr(input.notes, ""), normalizeColor(input.color)]
  );
  return requireCharacter(id);
}

export function updateCharacter(characterId: string, body: unknown): Character {
  const existing = requireCharacter(characterId);
  const input = objectBody(body);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : existing.name;
  const aliases = input.aliases !== undefined ? normalizeAliases(input.aliases) : existing.aliases ?? [];
  const notes = typeof input.notes === "string" ? input.notes : existing.notes;
  const color = input.color !== undefined ? normalizeColor(input.color) : existing.color ?? null;
  runSql(
    `UPDATE characters SET name = ?, aliases_json = ?, notes = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [name, JSON.stringify(aliases), notes, color, characterId]
  );
  return requireCharacter(characterId);
}

export function deleteCharacter(characterId: string) {
  requireCharacter(characterId);
  runSql("DELETE FROM characters WHERE id = ?", [characterId]);
  return { deleted: true, characterId };
}

/**
 * 既知話者名(Fountain の生表記)を characters の name/aliases と突合する。一致しなければ null
 * (呼び出し側の scripts.ts が自動作成する)。大文字小文字・前後空白の揺れを吸収する。
 */
export function findCharacterByLabel(projectId: string, speakerLabel: string): Character | null {
  const label = speakerLabel.trim();
  if (!label) {
    return null;
  }
  const characters = listCharacters(projectId);
  const normalized = label.toLowerCase();
  for (const character of characters) {
    if (character.name.trim().toLowerCase() === normalized) {
      return character;
    }
    if ((character.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized)) {
      return character;
    }
  }
  return null;
}

/** 未知話者を自動作成する(scripts.ts の取り込みから呼ぶ)。 */
export function findOrCreateCharacterByLabel(projectId: string, speakerLabel: string): Character {
  const existing = findCharacterByLabel(projectId, speakerLabel);
  if (existing) {
    return existing;
  }
  return createCharacter(projectId, { name: speakerLabel.trim() || "名無し" });
}

// --- character_bindings(Provider 別 AppearanceBinding) ---

interface BindingRow {
  id: string;
  character_id: string;
  provider_id: string;
  binding_json: string;
  updated_at: string;
}

/**
 * binding_json の中身(comfy: faceImagePath?/loraName?/loraStrength?)は Provider が検証する
 * (既知の罠12: オーケストレータは中身を読まない)。ここでは comfy のみ実装(将来 Provider 追加時に分岐を足す)。
 */
function sanitizeBindingForStorage(
  providerId: string,
  raw: Record<string, unknown>,
  existing: Record<string, unknown>,
  existingFaceImagePath: string | null
): Record<string, unknown> {
  if (providerId !== "comfy") {
    // 未知 Provider は空 object のみ許可(検証できないものは保存しない)。
    return {};
  }
  const out: Record<string, unknown> = {};
  if (existingFaceImagePath) {
    out.faceImagePath = existingFaceImagePath;
  }
  // PUT はフィールド単位の部分更新として扱う(未指定キーは既存値を維持する -- 顔画像だけ/LoRAだけの
  // 個別編集 UI から呼ばれるため、REST の全置換セマンティクスより実用性を優先した判断)。
  const loraNameSource = raw.loraName !== undefined ? raw.loraName : existing.loraName;
  if (typeof loraNameSource === "string" && loraNameSource.trim()) {
    out.loraName = loraNameSource.trim();
  }
  const loraStrengthSource = raw.loraStrength !== undefined ? raw.loraStrength : existing.loraStrength;
  if (typeof loraStrengthSource === "number" && Number.isFinite(loraStrengthSource)) {
    out.loraStrength = Math.min(2, Math.max(0, loraStrengthSource));
  }
  return out;
}

function toBindingView(row: BindingRow | null, providerId: string): CharacterBindingView {
  if (!row) {
    return { providerId, hasFaceImage: false, faceImageUrl: null, loraName: null, loraStrength: null, updatedAt: "" };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.binding_json) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const hasFaceImage = typeof parsed.faceImagePath === "string" && parsed.faceImagePath.trim() !== "";
  return {
    providerId,
    hasFaceImage,
    faceImageUrl: hasFaceImage ? `/api/characters/${row.character_id}/bindings/${providerId}/face-image` : null,
    loraName: typeof parsed.loraName === "string" ? parsed.loraName : null,
    loraStrength: typeof parsed.loraStrength === "number" ? parsed.loraStrength : null,
    updatedAt: row.updated_at
  };
}

export function getCharacterBinding(characterId: string, providerId: string): CharacterBindingView {
  requireCharacter(characterId);
  const row = getRow<BindingRow>("SELECT * FROM character_bindings WHERE character_id = ? AND provider_id = ?", [
    characterId,
    providerId
  ]);
  return toBindingView(row, providerId);
}

/**
 * `PUT /api/characters/:id/bindings/:providerId`。`faceImageDataUrl`(新規アップロード)/
 * `clearFaceImage`(削除)/`loraName`/`loraStrength` を受け付ける。クライアントから生の
 * ファイルパスは受け取らない(dataUrl アップロード経由のみ)。
 */
export async function putCharacterBinding(characterId: string, providerId: string, body: unknown): Promise<CharacterBindingView> {
  const character = requireCharacter(characterId);
  const input = objectBody(body);
  const existing = getRow<BindingRow>("SELECT * FROM character_bindings WHERE character_id = ? AND provider_id = ?", [
    characterId,
    providerId
  ]);
  let existingParsed: Record<string, unknown> = {};
  if (existing) {
    try {
      existingParsed = JSON.parse(existing.binding_json) as Record<string, unknown>;
    } catch {
      existingParsed = {};
    }
  }
  let faceImagePath: string | null = typeof existingParsed.faceImagePath === "string" ? existingParsed.faceImagePath : null;

  if (input.clearFaceImage === true) {
    faceImagePath = null;
  } else if (typeof input.faceImageDataUrl === "string" && input.faceImageDataUrl.trim()) {
    const { mimeType, bytes } = decodeImageDataUrl(input.faceImageDataUrl);
    const ext = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
    const stored = await storeCharacterFaceImage(character.projectId, characterId, providerId, ext, bytes);
    faceImagePath = stored.filePath;
  }

  const sanitized = sanitizeBindingForStorage(providerId, input, existingParsed, faceImagePath);
  const id = existing?.id ?? createId("bind");
  if (existing) {
    runSql("UPDATE character_bindings SET binding_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
      JSON.stringify(sanitized),
      id
    ]);
  } else {
    runSql(
      `INSERT INTO character_bindings (id, character_id, provider_id, binding_json) VALUES (?, ?, ?, ?)`,
      [id, characterId, providerId, JSON.stringify(sanitized)]
    );
  }
  const row = getRow<BindingRow>("SELECT * FROM character_bindings WHERE id = ?", [id]);
  return toBindingView(row, providerId);
}

/** binding_json.faceImagePath を安全に解決する(isPathInside ガード。既知の罠11)。 */
function resolveCharacterFaceImagePath(characterId: string, providerId: string): string {
  const row = getRow<BindingRow>("SELECT * FROM character_bindings WHERE character_id = ? AND provider_id = ?", [
    characterId,
    providerId
  ]);
  if (!row) {
    throw new HttpError(404, "Character face image was not found");
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.binding_json) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const path = typeof parsed.faceImagePath === "string" ? parsed.faceImagePath : "";
  const resolved = path ? resolve(path) : "";
  if (!resolved || !isPathInside(resolved, resolve(dataRoot))) {
    throw new HttpError(404, "Character face image was not found");
  }
  return resolved;
}

export function serveCharacterFaceImage(res: ServerResponse, characterId: string, providerId: string) {
  streamFile(res, resolveCharacterFaceImagePath(characterId, providerId));
}
