import { resolve } from "node:path";
import type { PanelCastSpec, ReferenceSpec } from "../shared/mangaPlanV2";
import type { StyleLoraSelection } from "../shared/types";
import type { ReferenceModelFamily, ReferenceSetSnapshot, ScriptMangaReferenceSnapshot } from "../shared/referenceSets";
import { referenceSnapshotKey } from "../shared/referenceSets";
import { dataRoot, getRows } from "./db";
import { isPathInside } from "./paths";
import { findApprovedReferenceSet } from "./referenceSets";

interface BindingRow {
  character_id: string;
  binding_json: string;
}

interface ParsedBinding {
  faceImagePath: string | null;
  loraName: string | null;
  loraStrength: number;
}

export interface ResolvedPanelReferences {
  manifest: ReferenceSpec[];
  loras: StyleLoraSelection[];
  /** Symbolic binding compiled into GenerationRequest; rounds.ts copies it into a round attachment. */
  primaryCharacterBinding: { characterId: string; providerId: string } | null;
  primaryReferenceSet: { setId: string; version: number } | null;
  appearances: ReferenceSetSnapshot[];
  missingReferenceIds: string[];
}

function parseBinding(raw: string): ParsedBinding {
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    value = {};
  }
  const candidate = typeof value.faceImagePath === "string" ? resolve(value.faceImagePath) : "";
  const faceImagePath = candidate && isPathInside(candidate, resolve(dataRoot)) ? candidate : null;
  const loraName = typeof value.loraName === "string" && value.loraName.trim() ? value.loraName.trim() : null;
  const loraStrength =
    typeof value.loraStrength === "number" && Number.isFinite(value.loraStrength)
      ? Math.max(0, Math.min(2, value.loraStrength))
      : 1;
  return { faceImagePath, loraName, loraStrength };
}

function mergeLoras(primary: StyleLoraSelection[], fallback: StyleLoraSelection[]): StyleLoraSelection[] {
  const byName = new Map<string, StyleLoraSelection>();
  for (const lora of [...primary, ...fallback]) {
    const name = lora.name.trim();
    if (!name) continue;
    const strength = Math.max(0, Math.min(2, lora.strength));
    const existing = byName.get(name);
    if (!existing || strength > existing.strength) byName.set(name, { name, strength });
  }
  return [...byName.values()].slice(0, 4);
}

/**
 * Resolves every cast member to a persisted ReferenceManifest. The current wire request accepts one
 * face image, so the focal subject is compiled as the primary identity while all references remain
 * in the task/plan for providers with future regional or multi-reference support.
 */
export function resolvePanelReferences(input: {
  projectId: string;
  providerId: string;
  cast: PanelCastSpec[];
  focalSubjectId: string;
  globalLoras: StyleLoraSelection[];
  modelFamily?: ReferenceModelFamily;
  frozenSnapshot?: ScriptMangaReferenceSnapshot | null;
}): ResolvedPanelReferences {
  const modelFamily = input.modelFamily ?? "chroma";
  const ids = [...new Set(input.cast.map((member) => member.characterId))];
  if (ids.length === 0) return {
    manifest: [], loras: mergeLoras([], input.globalLoras), primaryCharacterBinding: null,
    primaryReferenceSet: null, appearances: [], missingReferenceIds: []
  };
  const placeholders = ids.map(() => "?").join(", ");
  const rows = getRows<BindingRow>(
    `SELECT cb.character_id, cb.binding_json
     FROM character_bindings cb
     JOIN characters c ON c.id = cb.character_id
     WHERE c.project_id = ? AND cb.provider_id = ? AND cb.character_id IN (${placeholders})`,
    [input.projectId, input.providerId, ...ids]
  );
  const parsedByCharacter = new Map(rows.map((row) => [row.character_id, parseBinding(row.binding_json)]));
  const orderedCast = [...input.cast].sort((left, right) => {
    if (left.characterId === input.focalSubjectId) return -1;
    if (right.characterId === input.focalSubjectId) return 1;
    if (left.speakingLineIds.length !== right.speakingLineIds.length) return right.speakingLineIds.length - left.speakingLineIds.length;
    return 0;
  });
  const manifest: ReferenceSpec[] = [];
  const characterLoras: StyleLoraSelection[] = [];
  let primaryCharacterBinding: { characterId: string; providerId: string } | null = null;
  let primaryReferenceSet: { setId: string; version: number } | null = null;
  const appearances: ReferenceSetSnapshot[] = [];
  const missingReferenceIds: string[] = [];
  const frozenByKey = new Map((input.frozenSnapshot?.sets ?? []).map((set) => [referenceSnapshotKey(set.characterId, set.variantId), set]));
  for (const member of orderedCast) {
    const binding = parsedByCharacter.get(member.characterId);
    const frozen = frozenByKey.get(referenceSnapshotKey(member.characterId, member.variantId));
    const live = input.frozenSnapshot ? null : findApprovedReferenceSet({
      projectId: input.projectId,
      characterId: member.characterId,
      variantId: member.variantId,
      modelFamily
    });
    const snapshot = frozen ?? live?.snapshot ?? null;
    if (snapshot) {
      appearances.push(snapshot);
      for (const image of snapshot.images) {
        manifest.push({
          entityId: member.characterId,
          variantId: member.variantId,
          artifact: { kind: "referenceSet", setId: snapshot.setId, version: snapshot.version, role: image.role },
          targetRegion: member.bbox,
          role: image.role === "face" ? "identity" : "outfit",
          strength: 1
        });
      }
      if (member.characterId === input.focalSubjectId && !primaryReferenceSet) {
        primaryReferenceSet = { setId: snapshot.setId, version: snapshot.version };
      }
    } else if (modelFamily === "chroma" && binding?.faceImagePath) {
      manifest.push({
        entityId: member.characterId,
        variantId: member.variantId,
        artifact: { kind: "characterBinding", characterId: member.characterId, providerId: input.providerId, role: "face" },
        targetRegion: member.bbox,
        role: "identity",
        strength: 1
      });
      if (member.characterId === input.focalSubjectId && !primaryCharacterBinding) {
        primaryCharacterBinding = { characterId: member.characterId, providerId: input.providerId };
      }
    } else {
      missingReferenceIds.push(member.characterId);
    }
    if (binding?.loraName) {
      manifest.push({
        entityId: member.characterId,
        variantId: member.variantId,
        artifact: {
          kind: "providerResource",
          providerId: input.providerId,
          resourceType: "lora",
          id: binding.loraName
        },
        targetRegion: member.bbox,
        role: "style",
        strength: binding.loraStrength
      });
      characterLoras.push({ name: binding.loraName, strength: binding.loraStrength });
    }
  }
  return {
    manifest,
    loras: mergeLoras(characterLoras, input.globalLoras),
    primaryCharacterBinding,
    primaryReferenceSet,
    appearances,
    missingReferenceIds: [...new Set(missingReferenceIds)]
  };
}
