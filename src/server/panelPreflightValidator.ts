import { PANEL_BLEED_OVERSHOOT, panelBounds, type PageLayout } from "../shared/pageLayout";
import type { NormalizedBox, PanelSpec } from "../shared/mangaPlanV2";

export interface PreflightViolation {
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface PanelPreflightReport {
  passed: boolean;
  panelSpecId: string;
  layoutPanelId: string;
  checks: {
    layoutPanelPresent: boolean;
    geometryValid: boolean;
    sourceTraceable: boolean;
    dialogueMapped: boolean;
    referencesTraceable: boolean;
    promptHasNoDialogueText: boolean;
    castNormalized: boolean;
    offscreenSpeakersExcluded: boolean;
    requiredReferencesReady: boolean;
  };
  violations: PreflightViolation[];
}

function validBox(box: NormalizedBox): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1.000001 &&
    box.y + box.height <= 1.000001
  );
}

function overlapRatio(left: NormalizedBox, right: NormalizedBox): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const smallerArea = Math.min(left.width * left.height, right.width * right.height);
  return smallerArea > 0 ? (width * height) / smallerArea : 0;
}

export function validatePanelPreflight(input: {
  panel: PanelSpec;
  layout: PageLayout;
  layoutPanelId: string;
  dialogueTexts: string[];
  castNormalized?: boolean;
  offscreenSpeakerIds?: string[];
  requireReferences?: boolean;
  missingReferenceIds?: string[];
}): PanelPreflightReport {
  const { panel, layout, layoutPanelId } = input;
  const violations: PreflightViolation[] = [];
  const layoutPanel = layout.panels.find((candidate) => candidate.id === layoutPanelId);
  const layoutPanelPresent = Boolean(layoutPanel);
  if (!layoutPanel) violations.push({ code: "layout-panel-missing", severity: "error", message: `Layout panel ${layoutPanelId} is missing` });
  let layoutGeometryValid = false;
  if (layoutPanel) {
    const [x1, y1, x2, y2] = panelBounds(layoutPanel.shape);
    // 裁ち切り(bleed)コマは PANEL_BLEED_OVERSHOOT までページ外へはみ出してよい
    // (Docs/Reference-MangaCompositions.md)。それを超えるはみ出しは座標崩れとして弾く。
    layoutGeometryValid =
      x1 >= -PANEL_BLEED_OVERSHOOT &&
      y1 >= -PANEL_BLEED_OVERSHOOT &&
      x2 <= 1 + PANEL_BLEED_OVERSHOOT + 0.000001 &&
      y2 <= layout.page.height + PANEL_BLEED_OVERSHOOT + 0.000001 &&
      x2 - x1 >= 0.04 &&
      y2 - y1 >= 0.04;
    if (!layoutGeometryValid) {
      violations.push({ code: "layout-geometry", severity: "error", message: "Panel is outside the page or too small to render safely" });
    }
  }
  const boxesValid = panel.cast.every((member) => validBox(member.bbox)) && panel.props.every((prop) => !prop.bbox || validBox(prop.bbox)) && panel.textSafeZones.every(validBox);
  if (!boxesValid) violations.push({ code: "panel-geometry", severity: "error", message: "Cast, prop or lettering geometry is invalid" });
  if (boxesValid) {
    const castConflict = panel.cast.some((member) => panel.textSafeZones.some((zone) => overlapRatio(member.bbox, zone) >= 0.2));
    const propConflict = panel.props.some((prop) => prop.bbox && panel.textSafeZones.some((zone) => overlapRatio(prop.bbox!, zone) >= 0.2));
    if (castConflict || propConflict) {
      violations.push({
        code: "lettering-visual-conflict",
        severity: "warning",
        message: "A lettering safe zone substantially overlaps a planned character or required prop region"
      });
    }
  }
  const sourceTraceable = panel.sourceElementIds.length > 0 && panel.beatIds.length > 0 && Boolean(panel.preStateId);
  if (!sourceTraceable) violations.push({ code: "source-trace", severity: "error", message: "Panel is not traceable to source/beat/world state" });
  const dialogueMapped = panel.dialogueLineIds.length === panel.dialogueOrderIndexes.length;
  if (!dialogueMapped) violations.push({ code: "dialogue-map", severity: "error", message: "Dialogue line ids and frozen order indexes differ" });
  const castAndProps = new Set([...panel.cast.map((member) => member.characterId), ...panel.props.map((prop) => prop.entityId)]);
  const referencesTraceable = panel.referenceManifest.every((reference) => castAndProps.has(reference.entityId));
  if (!referencesTraceable) violations.push({ code: "reference-target", severity: "error", message: "ReferenceManifest targets an entity outside the panel" });
  const promptHasNoDialogueText = input.dialogueTexts
    .filter((text) => text.trim().length >= 2)
    .every((text) => !panel.compiledPrompt.includes(text.trim()));
  if (!promptHasNoDialogueText) {
    violations.push({ code: "dialogue-in-image-prompt", severity: "error", message: "Dialogue wording leaked into the image prompt" });
  }
  if (panel.cast.length > 1 && panel.referenceManifest.some((reference) => reference.role === "identity")) {
    violations.push({
      code: "single-reference-downgrade",
      severity: "warning",
      message: "Provider request can condition only the focal identity; remaining cast references are preserved for review/repair"
    });
  }
  const castNormalized = input.castNormalized !== false;
  if (!castNormalized) violations.push({ code: "cast-not-normalized", severity: "error", message: "Panel cast contains duplicate character/variant entries" });
  const offscreenSpeakersExcluded = (input.offscreenSpeakerIds ?? []).every((id) => !panel.cast.some((member) => member.characterId === id));
  if (!offscreenSpeakersExcluded) violations.push({ code: "offscreen-speaker-in-cast", severity: "error", message: "An off-screen-only speaker remains in the visual cast" });
  const requiredReferencesReady = !input.requireReferences || (input.missingReferenceIds ?? []).length === 0;
  if (!requiredReferencesReady) {
    violations.push({
      code: "required-reference-missing",
      severity: "error",
      message: `Approved Reference Set is missing for: ${(input.missingReferenceIds ?? []).join(", ")}`
    });
  }
  return {
    passed: !violations.some((violation) => violation.severity === "error"),
    panelSpecId: panel.id,
    layoutPanelId,
    checks: {
      layoutPanelPresent,
      geometryValid: layoutGeometryValid && boxesValid,
      sourceTraceable,
      dialogueMapped,
      referencesTraceable,
      promptHasNoDialogueText,
      castNormalized,
      offscreenSpeakersExcluded,
      requiredReferencesReady
    },
    violations
  };
}
