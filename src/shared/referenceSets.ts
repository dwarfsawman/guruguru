export type ReferenceModelFamily = "chroma" | "anima";
export type ReferenceImageRole = "face" | "full_body";
export type ReferenceSetStatus = "draft" | "generating" | "review" | "approved" | "stale";
export type ReferenceSetSource = "generated" | "uploaded" | "mixed";

export interface ReferenceImageCandidate {
  assetId: string;
  roundId: string;
  imageUrl: string;
  thumbnailUrl: string;
  width: number | null;
  height: number | null;
}

export interface CharacterReferenceImageView {
  id: string;
  role: ReferenceImageRole;
  width: number | null;
  height: number | null;
  crop: unknown;
  mask: unknown;
  checksum: string;
  assetId: string | null;
  roundId: string | null;
  imageUrl: string | null;
  candidates: ReferenceImageCandidate[];
}

export interface CharacterReferenceSetView {
  id: string;
  characterId: string;
  characterName: string;
  variantId: string;
  modelFamily: ReferenceModelFamily;
  version: number;
  status: ReferenceSetStatus;
  source: ReferenceSetSource;
  appearanceJa: string;
  appearancePromptEn: string;
  mustNotChange: string[];
  appearanceHash: string;
  stale: boolean;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  images: CharacterReferenceImageView[];
}

export interface ReferenceSetSnapshotImage {
  role: ReferenceImageRole;
  checksum: string;
  width: number | null;
  height: number | null;
}

/** Immutable, path-free identity snapshot stored on a Script Manga Run at approval time. */
export interface ReferenceSetSnapshot {
  setId: string;
  characterId: string;
  variantId: string;
  modelFamily: ReferenceModelFamily;
  version: number;
  appearanceJa: string;
  appearancePromptEn: string;
  mustNotChange: string[];
  appearanceHash: string;
  images: ReferenceSetSnapshotImage[];
}

export interface ScriptMangaReferenceSnapshot {
  modelFamily: ReferenceModelFamily;
  approvedAt: string;
  allowFallback: boolean;
  sets: ReferenceSetSnapshot[];
}

export function referenceSnapshotKey(characterId: string, variantId: string): string {
  return `${characterId}::${variantId}`;
}
