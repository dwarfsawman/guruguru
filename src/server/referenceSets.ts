import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type {
  CharacterReferenceImageView,
  CharacterReferenceSetView,
  ReferenceImageRole,
  ReferenceModelFamily,
  ReferenceSetSnapshot
} from "../shared/referenceSets";
import { createId, dataRoot, getRow, getRows, runSql } from "./db";
import { streamFile } from "./files";
import { HttpError } from "./http";
import { isPathInside } from "./paths";
import { storeCharacterReferenceImage } from "./storage";
import { decodeImageDataUrl } from "./uploadDataUrl";
import { objectBody, requiredString, stringOr } from "./validate";

interface SetRow {
  id: string;
  character_id: string;
  character_name?: string;
  project_id?: string;
  variant_id: string;
  model_family: ReferenceModelFamily;
  version: number;
  status: "draft" | "generating" | "review" | "approved" | "stale";
  source: "generated" | "uploaded" | "mixed";
  appearance_ja: string;
  appearance_prompt_en: string;
  must_not_change_json: string;
  appearance_hash: string;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ImageRow {
  id: string;
  reference_set_id: string;
  role: ReferenceImageRole;
  file_path: string | null;
  width: number | null;
  height: number | null;
  crop_json: string | null;
  mask_json: string | null;
  checksum: string;
  asset_id: string | null;
  round_id: string | null;
}

export interface ApprovedReferenceSetFiles {
  snapshot: ReferenceSetSnapshot;
  projectId: string;
  facePath: string;
  fullBodyPath: string | null;
}

const FAMILY_VALUES = new Set<ReferenceModelFamily>(["chroma", "anima"]);
const ROLE_VALUES = new Set<ReferenceImageRole>(["face", "full_body"]);

function jsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && Boolean(value.trim())) : [];
  } catch {
    return [];
  }
}

function jsonValue(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function normalizedVariantId(raw: unknown): string {
  const variantId = stringOr(raw, "default").trim() || "default";
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(variantId)) throw new HttpError(400, "variantId contains unsupported characters");
  return variantId;
}

function normalizedFamily(raw: unknown): ReferenceModelFamily {
  const family = stringOr(raw, "") as ReferenceModelFamily;
  if (!FAMILY_VALUES.has(family)) throw new HttpError(400, 'modelFamily must be "chroma" or "anima"');
  return family;
}

function normalizedMustNotChange(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))].slice(0, 24);
}

function appearanceHash(appearanceJa: string, appearancePromptEn: string, mustNotChange: string[]): string {
  return createHash("sha256").update(JSON.stringify({ appearanceJa, appearancePromptEn, mustNotChange })).digest("hex");
}

function checksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireSet(setId: string): SetRow & { project_id: string; character_name: string } {
  const row = getRow<SetRow & { project_id: string; character_name: string }>(
    `SELECT rs.*, c.project_id, c.name AS character_name
     FROM character_reference_sets rs JOIN characters c ON c.id = rs.character_id WHERE rs.id = ?`,
    [setId]
  );
  if (!row) throw new HttpError(404, "Reference Set was not found");
  return row;
}

function syncGenerationStatus(row: SetRow): SetRow {
  if (row.status !== "generating") return row;
  const requiredRoles: ReferenceImageRole[] = row.model_family === "anima" ? ["face", "full_body"] : ["face"];
  const placeholders = getRows<ImageRow>("SELECT * FROM character_reference_images WHERE reference_set_id = ?", [row.id]);
  const byRole = new Map(placeholders.map((image) => [image.role, image]));
  const rounds = requiredRoles.map((role) => byRole.get(role)?.round_id).filter((id): id is string => Boolean(id));
  if (rounds.length !== requiredRoles.length) return row;
  const statuses = getRows<{ id: string; status: string }>(
    `SELECT id, status FROM generation_rounds WHERE id IN (${rounds.map(() => "?").join(", ")})`, rounds
  );
  if (statuses.length !== rounds.length || statuses.some((item) => !["completed", "failed", "interrupted"].includes(item.status))) return row;
  const next = statuses.every((item) => item.status === "completed") ? "review" : "draft";
  runSql("UPDATE character_reference_sets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [next, row.id]);
  return { ...row, status: next };
}

function imageViews(setId: string): CharacterReferenceImageView[] {
  return getRows<ImageRow>("SELECT * FROM character_reference_images WHERE reference_set_id = ? ORDER BY role", [setId]).map((image) => {
    const candidates = image.round_id
      ? getRows<{ id: string; round_id: string; width: number | null; height: number | null }>(
          "SELECT id, round_id, width, height FROM assets WHERE round_id = ? ORDER BY batch_index ASC", [image.round_id]
        ).map((asset) => ({
          assetId: asset.id,
          roundId: asset.round_id,
          imageUrl: `/api/assets/${asset.id}/image`,
          thumbnailUrl: `/api/assets/${asset.id}/thumbnail?size=medium`,
          width: asset.width,
          height: asset.height
        }))
      : [];
    return {
      id: image.id,
      role: image.role,
      width: image.width,
      height: image.height,
      crop: jsonValue(image.crop_json),
      mask: jsonValue(image.mask_json),
      checksum: image.checksum,
      assetId: image.asset_id,
      roundId: image.round_id,
      imageUrl: image.file_path ? `/api/reference-images/${image.id}` : null,
      candidates
    };
  });
}

function toView(raw: SetRow): CharacterReferenceSetView {
  const row = syncGenerationStatus(raw);
  return {
    id: row.id,
    characterId: row.character_id,
    characterName: row.character_name ?? "",
    variantId: row.variant_id,
    modelFamily: row.model_family,
    version: row.version,
    status: row.status,
    source: row.source,
    appearanceJa: row.appearance_ja,
    appearancePromptEn: row.appearance_prompt_en,
    mustNotChange: jsonArray(row.must_not_change_json),
    appearanceHash: row.appearance_hash,
    stale: row.status === "stale",
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    images: imageViews(row.id)
  };
}

export function listProjectReferenceSets(projectId: string): CharacterReferenceSetView[] {
  if (!getRow("SELECT id FROM projects WHERE id = ?", [projectId])) throw new HttpError(404, "Project was not found");
  const rows = getRows<SetRow>(
    `SELECT rs.*, c.name AS character_name FROM character_reference_sets rs
     JOIN characters c ON c.id = rs.character_id WHERE c.project_id = ?
     ORDER BY c.created_at, rs.variant_id, rs.model_family, rs.version DESC`, [projectId]
  );
  return rows.map(toView);
}

export function createReferenceSet(characterId: string, body: unknown): CharacterReferenceSetView {
  const character = getRow<{ id: string; project_id: string; name: string }>("SELECT id, project_id, name FROM characters WHERE id = ?", [characterId]);
  if (!character) throw new HttpError(404, "Character was not found");
  const input = objectBody(body);
  const variantId = normalizedVariantId(input.variantId);
  const modelFamily = normalizedFamily(input.modelFamily);
  const appearanceJa = stringOr(input.appearanceJa, "").trim();
  const appearancePromptEn = stringOr(input.appearancePromptEn, "").trim();
  if (!appearanceJa || !appearancePromptEn) throw new HttpError(400, "appearanceJa and appearancePromptEn are required");
  const mustNotChange = normalizedMustNotChange(input.mustNotChange);
  const latest = getRow<{ version: number }>(
    "SELECT version FROM character_reference_sets WHERE character_id = ? AND variant_id = ? AND model_family = ? ORDER BY version DESC LIMIT 1",
    [characterId, variantId, modelFamily]
  );
  const version = (latest?.version ?? 0) + 1;
  const id = createId("refset");
  runSql("BEGIN");
  try {
    runSql(
      "UPDATE character_reference_sets SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE character_id = ? AND variant_id = ? AND model_family = ? AND status = 'approved'",
      [characterId, variantId, modelFamily]
    );
    runSql(
      `INSERT INTO character_reference_sets
       (id, character_id, variant_id, model_family, version, status, source, appearance_ja, appearance_prompt_en, must_not_change_json, appearance_hash)
       VALUES (?, ?, ?, ?, ?, 'draft', 'uploaded', ?, ?, ?, ?)`,
      [id, characterId, variantId, modelFamily, version, appearanceJa, appearancePromptEn, JSON.stringify(mustNotChange), appearanceHash(appearanceJa, appearancePromptEn, mustNotChange)]
    );
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    throw error;
  }
  return toView({ ...requireSet(id), character_name: character.name });
}

async function persistImageFromBytes(set: SetRow & { project_id: string }, role: ReferenceImageRole, ext: string, bytes: Buffer, provenance: { assetId?: string | null; roundId?: string | null } = {}) {
  const stored = await storeCharacterReferenceImage(set.project_id, set.character_id, set.id, role, ext, bytes);
  const existing = getRow<ImageRow>("SELECT * FROM character_reference_images WHERE reference_set_id = ? AND role = ?", [set.id, role]);
  const id = existing?.id ?? createId("refimg");
  if (existing) {
    runSql(
      `UPDATE character_reference_images SET file_path = ?, width = ?, height = ?, checksum = ?, asset_id = ?, round_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [stored.filePath, stored.width, stored.height, checksum(bytes), provenance.assetId ?? null, provenance.roundId ?? existing.round_id, id]
    );
  } else {
    runSql(
      `INSERT INTO character_reference_images (id, reference_set_id, role, file_path, width, height, checksum, asset_id, round_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, set.id, role, stored.filePath, stored.width, stored.height, checksum(bytes), provenance.assetId ?? null, provenance.roundId ?? null]
    );
  }
}

export async function uploadReferenceSetImage(setId: string, roleRaw: string, body: unknown): Promise<CharacterReferenceSetView> {
  const set = requireSet(setId);
  if (!(["draft", "review"] as const).includes(set.status as "draft" | "review")) {
    throw new HttpError(409, "Approved or generating Reference Sets are immutable; create a new version first");
  }
  const role = roleRaw as ReferenceImageRole;
  if (!ROLE_VALUES.has(role)) throw new HttpError(400, 'role must be "face" or "full_body"');
  const input = objectBody(body);
  const dataUrl = requiredString(input.imageDataUrl, "imageDataUrl");
  const { mimeType, bytes } = decodeImageDataUrl(dataUrl);
  const ext = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
  await persistImageFromBytes(set, role, ext, bytes);
  runSql(
    `UPDATE character_reference_sets SET status = 'review', source = CASE WHEN source = 'generated' THEN 'mixed' ELSE 'uploaded' END,
     approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [set.id]
  );
  return toView(requireSet(set.id));
}

export function attachReferenceGenerationRound(setId: string, role: ReferenceImageRole, roundId: string): void {
  const set = requireSet(setId);
  if (!(["draft", "review", "generating"] as const).includes(set.status as "draft" | "review" | "generating")) {
    throw new HttpError(409, "Approved Reference Sets are immutable; create a new version first");
  }
  const existing = getRow<ImageRow>("SELECT * FROM character_reference_images WHERE reference_set_id = ? AND role = ?", [set.id, role]);
  if (existing) {
    runSql("UPDATE character_reference_images SET round_id = ?, asset_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [roundId, existing.id]);
  } else {
    runSql(
      "INSERT INTO character_reference_images (id, reference_set_id, role, round_id) VALUES (?, ?, ?, ?)",
      [createId("refimg"), set.id, role, roundId]
    );
  }
  const hasUploadedImage = Boolean(getRow(
    "SELECT 1 AS found FROM character_reference_images WHERE reference_set_id = ? AND file_path IS NOT NULL LIMIT 1", [set.id]
  ));
  runSql(
    "UPDATE character_reference_sets SET status = 'generating', source = ?, approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [hasUploadedImage ? "mixed" : "generated", set.id]
  );
}

export async function approveReferenceSet(setId: string, body: unknown): Promise<CharacterReferenceSetView> {
  const set = syncGenerationStatus(requireSet(setId)) as SetRow & { project_id: string; character_name: string };
  if (set.status === "generating") throw new HttpError(409, "Reference candidates are still generating");
  if (set.status === "approved" || set.status === "stale") throw new HttpError(409, "This immutable Reference Set version is already finalized");
  const input = objectBody(body);
  for (const role of ["face", "full_body"] as const) {
    const assetId = typeof input[`${role === "face" ? "face" : "fullBody"}AssetId`] === "string"
      ? String(input[`${role === "face" ? "face" : "fullBody"}AssetId`]) : "";
    if (!assetId) continue;
    const asset = getRow<{ id: string; project_id: string; round_id: string; image_path: string }>("SELECT id, project_id, round_id, image_path FROM assets WHERE id = ?", [assetId]);
    if (!asset || asset.project_id !== set.project_id) throw new HttpError(404, `Selected ${role} candidate was not found`);
    const root = await realpath(dataRoot);
    const source = await realpath(asset.image_path);
    if (!isPathInside(source, root)) throw new HttpError(400, "Candidate image is outside the data root");
    await persistImageFromBytes(set, role, extname(source), await readFile(source), { assetId: asset.id, roundId: asset.round_id });
  }
  const images = getRows<ImageRow>("SELECT * FROM character_reference_images WHERE reference_set_id = ? AND file_path IS NOT NULL AND checksum <> ''", [set.id]);
  const roles = new Set(images.map((image) => image.role));
  if (!roles.has("face")) throw new HttpError(422, "Approval requires a face image");
  if (set.model_family === "anima" && !roles.has("full_body")) throw new HttpError(422, "Anima approval requires face and full_body images");
  runSql("BEGIN");
  try {
    runSql(
      "UPDATE character_reference_sets SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE character_id = ? AND variant_id = ? AND model_family = ? AND status = 'approved' AND id <> ?",
      [set.character_id, set.variant_id, set.model_family, set.id]
    );
    runSql("UPDATE character_reference_sets SET status = 'approved', approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [set.id]);
    runSql("COMMIT");
  } catch (error) {
    runSql("ROLLBACK");
    throw error;
  }
  return toView(requireSet(set.id));
}

export function approvedReferenceSetFiles(setId: string, version: number, projectId?: string): ApprovedReferenceSetFiles {
  const set = requireSet(setId);
  if (projectId && set.project_id !== projectId) throw new HttpError(404, "Reference Set was not found in this project");
  if (set.version !== version || !["approved", "stale"].includes(set.status)) {
    throw new HttpError(409, "Reference Set is not an approved immutable version");
  }
  const images = getRows<ImageRow>("SELECT * FROM character_reference_images WHERE reference_set_id = ? AND file_path IS NOT NULL ORDER BY role", [set.id]);
  const byRole = new Map(images.map((image) => [image.role, image]));
  const face = byRole.get("face");
  const fullBody = byRole.get("full_body");
  if (!face?.file_path || !face.checksum) throw new HttpError(409, "Approved Reference Set has no face image");
  if (set.model_family === "anima" && (!fullBody?.file_path || !fullBody.checksum)) throw new HttpError(409, "Approved Anima Reference Set is incomplete");
  for (const image of [face, fullBody].filter(Boolean) as ImageRow[]) {
    const path = resolve(image.file_path!);
    if (!isPathInside(path, resolve(dataRoot))) throw new HttpError(409, "Reference Set image path is invalid");
    if (checksum(readFileSync(path)) !== image.checksum) throw new HttpError(409, "Reference Set image checksum no longer matches its approved snapshot");
  }
  return {
    projectId: set.project_id,
    facePath: resolve(face.file_path),
    fullBodyPath: fullBody?.file_path ? resolve(fullBody.file_path) : null,
    snapshot: {
      setId: set.id,
      characterId: set.character_id,
      variantId: set.variant_id,
      modelFamily: set.model_family,
      version: set.version,
      appearanceJa: set.appearance_ja,
      appearancePromptEn: set.appearance_prompt_en,
      mustNotChange: jsonArray(set.must_not_change_json),
      appearanceHash: set.appearance_hash,
      images: images.filter((image) => image.file_path && image.checksum).map((image) => ({
        role: image.role, checksum: image.checksum, width: image.width, height: image.height
      }))
    }
  };
}

export function findApprovedReferenceSet(input: { projectId: string; characterId: string; variantId: string; modelFamily: ReferenceModelFamily }): ApprovedReferenceSetFiles | null {
  const row = getRow<{ id: string; version: number }>(
    `SELECT rs.id, rs.version FROM character_reference_sets rs JOIN characters c ON c.id = rs.character_id
     WHERE c.project_id = ? AND rs.character_id = ? AND rs.variant_id = ? AND rs.model_family = ? AND rs.status = 'approved'
     ORDER BY rs.version DESC LIMIT 1`,
    [input.projectId, input.characterId, input.variantId, input.modelFamily]
  );
  return row ? approvedReferenceSetFiles(row.id, row.version, input.projectId) : null;
}

export function serveReferenceSetImage(res: ServerResponse, imageId: string): void {
  const row = getRow<{ file_path: string | null }>("SELECT file_path FROM character_reference_images WHERE id = ?", [imageId]);
  const path = row?.file_path ? resolve(row.file_path) : "";
  if (!path || !isPathInside(path, resolve(dataRoot))) throw new HttpError(404, "Reference image was not found");
  streamFile(res, path);
}
