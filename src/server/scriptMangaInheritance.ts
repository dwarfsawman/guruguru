import type { MangaBeat, PanelSpec, WorldState } from "../shared/mangaPlanV2.ts";
import type { LayoutPanel } from "../shared/pageLayout.ts";
import type { ScriptMangaReferenceSnapshot } from "../shared/referenceSets.ts";
import { hashJson, stableStringify } from "./workflowGraph.ts";

export const SCRIPT_MANGA_REUSE_FINGERPRINT_VERSION = "script-manga-selected-asset-reuse/v4";

/** Runtime identities and random sampling inputs must not prevent reuse of an already-reviewed image. */
const EPHEMERAL_KEYS = new Set([
  "approvedAt",
  "approved_at",
  "runId",
  "run_id",
  "taskId",
  "task_id",
  "pageId",
  "page_id",
  "panelId",
  "panel_id",
  "roundId",
  "round_id",
  "jobId",
  "job_id",
  "seed",
  "seedMode",
  "seed_mode"
]);

export type ScriptMangaReuseLayout = Pick<LayoutPanel, "shape" | "frame" | "role">;

/**
 * `generation` must contain every material input used to render the panel (provider/template
 * identity and version/hash, prompts, dimensions, sampling, LoRAs, references, pose/control,
 * inpainting, and prompt-compiler version where applicable). It may be a request/intent-shaped
 * JSON object; runtime IDs and seed fields are removed recursively before hashing.
 */
export interface ScriptMangaReuseFingerprintInput {
  scriptRevisionId: string;
  panel: PanelSpec;
  resolvedBeats: readonly MangaBeat[];
  resolvedPreState: WorldState | null;
  resolvedContinuityPanels: readonly PanelSpec[];
  layoutPanel: ScriptMangaReuseLayout;
  generation: unknown;
  referenceSnapshot: ScriptMangaReferenceSnapshot | null;
}

export interface ScriptMangaReuseCandidate<T> {
  fingerprint: string | null | undefined;
  value: T;
}

export interface ScriptMangaReuseMatch<TPredecessor, TSuccessor> {
  fingerprint: string;
  predecessor: TPredecessor;
  successor: TSuccessor;
  predecessorIndex: number;
  successorIndex: number;
}

export interface ScriptMangaReservedReuseCandidate<T> extends ScriptMangaReuseCandidate<T> {
  /** Exact predecessor index already claimed by a non-terminal or completed successor task. */
  reservedPredecessorIndex?: number;
}

/**
 * Hashes only stable, material inputs. Plan-local beat/state/panel IDs are replaced by their
 * resolved semantic bodies so a provided successor plan may regenerate those IDs without losing
 * otherwise safe reuse.
 */
export function computeScriptMangaReuseFingerprint(input: ScriptMangaReuseFingerprintInput): string {
  return hashJson({
    version: SCRIPT_MANGA_REUSE_FINGERPRINT_VERSION,
    scriptRevisionId: input.scriptRevisionId,
    panel: panelSemantics(input.panel),
    resolvedBeats: input.resolvedBeats.map(beatSemantics),
    resolvedPreState: worldStateSemantics(input.resolvedPreState),
    resolvedContinuityPanels: input.resolvedContinuityPanels.map(continuityPanelSemantics),
    layout: {
      shape: input.layoutPanel.shape,
      frame: input.layoutPanel.frame ?? null,
      role: input.layoutPanel.role ?? null
    },
    generation: stripEphemeralFields(input.generation),
    referenceSnapshot: referenceSnapshotSemantics(input.referenceSnapshot)
  });
}

/**
 * Deterministic one-to-one matching. Duplicate fingerprints consume predecessor candidates in
 * input order, so a single selected asset/task can never be inherited by two successor panels.
 */
export function matchScriptMangaReuseCandidates<TPredecessor, TSuccessor>(
  predecessors: readonly ScriptMangaReuseCandidate<TPredecessor>[],
  successors: readonly ScriptMangaReuseCandidate<TSuccessor>[]
): ScriptMangaReuseMatch<TPredecessor, TSuccessor>[] {
  const byFingerprint = new Map<string, number[]>();
  const nextIndex = new Map<string, number>();

  for (const [index, candidate] of predecessors.entries()) {
    const fingerprint = nonEmptyFingerprint(candidate.fingerprint);
    if (!fingerprint) continue;
    const indexes = byFingerprint.get(fingerprint) ?? [];
    indexes.push(index);
    byFingerprint.set(fingerprint, indexes);
  }

  const matches: ScriptMangaReuseMatch<TPredecessor, TSuccessor>[] = [];
  for (const [successorIndex, candidate] of successors.entries()) {
    const fingerprint = nonEmptyFingerprint(candidate.fingerprint);
    if (!fingerprint) continue;
    const indexes = byFingerprint.get(fingerprint);
    if (!indexes) continue;
    const cursor = nextIndex.get(fingerprint) ?? 0;
    const predecessorIndex = indexes[cursor];
    if (predecessorIndex === undefined) continue;
    nextIndex.set(fingerprint, cursor + 1);
    matches.push({
      fingerprint,
      predecessor: predecessors[predecessorIndex]!.value,
      successor: candidate.value,
      predecessorIndex,
      successorIndex
    });
  }
  return matches;
}

/**
 * One-to-one matching with explicit reservations restored from persisted inheritance lineage.
 * Reservations are applied before fingerprint matching because a reviewed repair's material
 * fingerprint can intentionally differ from the root fingerprint used for successor matching.
 */
export function matchScriptMangaReuseCandidatesWithReservations<TPredecessor, TSuccessor>(
  predecessors: readonly ScriptMangaReuseCandidate<TPredecessor>[],
  successors: readonly ScriptMangaReservedReuseCandidate<TSuccessor>[]
): ScriptMangaReuseMatch<TPredecessor, TSuccessor>[] {
  const reservedPredecessors = new Set<number>();
  const reservedSuccessors = new Set<number>();
  const reservedMatches: ScriptMangaReuseMatch<TPredecessor, TSuccessor>[] = [];
  for (const [successorIndex, successor] of successors.entries()) {
    const predecessorIndex = successor.reservedPredecessorIndex;
    if (
      predecessorIndex === undefined ||
      predecessorIndex < 0 ||
      predecessorIndex >= predecessors.length ||
      reservedPredecessors.has(predecessorIndex)
    ) continue;
    const predecessor = predecessors[predecessorIndex]!;
    const fingerprint = nonEmptyFingerprint(predecessor.fingerprint);
    if (!fingerprint) continue;
    reservedPredecessors.add(predecessorIndex);
    reservedSuccessors.add(successorIndex);
    reservedMatches.push({
      fingerprint,
      predecessor: predecessor.value,
      successor: successor.value,
      predecessorIndex,
      successorIndex
    });
  }

  const unmatchedPredecessors = predecessors.flatMap((candidate, predecessorIndex) =>
    reservedPredecessors.has(predecessorIndex) ? [] : [{ candidate, predecessorIndex }]
  );
  const unmatchedSuccessors = successors.flatMap((candidate, successorIndex) =>
    reservedSuccessors.has(successorIndex) ? [] : [{ candidate, successorIndex }]
  );
  const fingerprintMatches = matchScriptMangaReuseCandidates(
    unmatchedPredecessors.map(({ candidate, predecessorIndex }) => ({
      fingerprint: candidate.fingerprint,
      value: { value: candidate.value, predecessorIndex }
    })),
    unmatchedSuccessors.map(({ candidate, successorIndex }) => ({
      fingerprint: candidate.fingerprint,
      value: { value: candidate.value, successorIndex }
    }))
  ).map((match) => ({
    fingerprint: match.fingerprint,
    predecessor: match.predecessor.value,
    successor: match.successor.value,
    predecessorIndex: match.predecessor.predecessorIndex,
    successorIndex: match.successor.successorIndex
  }));
  return [...reservedMatches, ...fingerprintMatches].sort((left, right) => left.successorIndex - right.successorIndex);
}

function panelSemantics(panel: PanelSpec) {
  return {
    role: panel.role ?? null,
    importance: panel.importance ?? null,
    sourceElementIds: panel.sourceElementIds,
    postStateDelta: panel.postStateDelta,
    settingId: panel.settingId,
    cast: panel.cast,
    props: panel.props,
    shot: panel.shot,
    dialogueLineIds: panel.dialogueLineIds,
    fillUnitIds: panel.fillUnitIds ?? [],
    dialogueOrderIndexes: panel.dialogueOrderIndexes,
    textSafeZones: panel.textSafeZones,
    mustShow: panel.mustShow,
    mustNotShow: panel.mustNotShow,
    referenceManifest: stripEphemeralFields(panel.referenceManifest),
    sceneIndex: panel.sceneIndex,
    sceneHeading: panel.sceneHeading,
    sourceText: panel.sourceText,
    promptBase: panel.promptBase,
    compiledPrompt: panel.compiledPrompt
  };
}

function continuityPanelSemantics(panel: PanelSpec) {
  // The dependency's own fingerprint (and the inheritance closure) verifies its compiled prompt,
  // references, and selected asset. Keeping a materialized prompt here makes the dependent panel
  // mismatch merely because predecessor/successor preparation modes compiled the same dependency
  // at different times, before the dependency closure can make the safe decision.
  const { compiledPrompt: _compiledPrompt, referenceManifest: _referenceManifest, ...semantics } = panelSemantics(panel);
  return semantics;
}

function beatSemantics(beat: MangaBeat) {
  const { id: _id, ...semantics } = beat;
  return semantics;
}

function worldStateSemantics(state: WorldState | null) {
  if (!state) return null;
  const { id: _id, ...semantics } = state;
  return semantics;
}

function referenceSnapshotSemantics(snapshot: ScriptMangaReferenceSnapshot | null) {
  if (!snapshot) return null;
  return {
    modelFamily: snapshot.modelFamily,
    allowFallback: snapshot.allowFallback,
    sets: snapshot.sets
      .map((set) => ({
        setId: set.setId,
        characterId: set.characterId,
        variantId: set.variantId,
        modelFamily: set.modelFamily,
        version: set.version,
        appearanceJa: set.appearanceJa,
        appearancePromptEn: set.appearancePromptEn,
        mustNotChange: [...set.mustNotChange].sort(),
        appearanceHash: set.appearanceHash,
        images: [...set.images].sort(compareStableValues)
      }))
      .sort(compareStableValues)
  };
}

function compareStableValues(a: unknown, b: unknown): number {
  return stableStringify(a).localeCompare(stableStringify(b));
}

function stripEphemeralFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripEphemeralFields);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!EPHEMERAL_KEYS.has(key)) {
      result[key] = stripEphemeralFields(child);
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyFingerprint(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
